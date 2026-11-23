import { createHash, randomInt } from 'node:crypto';
import { cleanCinematic } from '@/config/cinematic';
import { UserError } from '@/lib/images/process';
import { API_TIMEOUT_MS, ASSET_PREP_MS, WAIT_TIMEOUT_MS, withLibraryHint } from '@/lib/magnific/client';
import { excerpt, isTransientError, openMcpSession, RATE_MSG, TIMEOUT_MSG, type McpSession } from '@/lib/magnific-mcp/client';
import { STALE_MS } from '@/lib/storage/history';
import { readJson, serialize, writeJson } from '@/lib/storage/json-store';
import type { AspectRatio, CinematicSettings, Resolution } from '@/lib/types';
import type { ImageProvider, ProviderProduct } from './types';

const FAILED_MSG = 'Magnific üretimi başarısız oldu.';
const MAX_PRODUCTS = 4;
const MAX_PRODUCT_IMAGES = 6;
/** images_generate accepts at most 12 references (products + the room). */
const MAX_REFERENCES = 12;
const UPLOAD_CONCURRENCY = 3;
const MAX_SEED = 2147483647;
const WAIT_STEP_S = 55;
/** Extra time for one creations_wait call beyond its own long-poll. */
const WAIT_CALL_MARGIN_MS = 15_000;
const MIN_WAIT_CALL_MS = 2_000;
/** Pauses between retries of a transient error after images_generate (the last one repeats). */
const RETRY_BACKOFF_MS = [2_000, 4_000, 8_000];
/** Pauses between retries of a transient error during asset preparation (no credits spent yet). */
const PREP_BACKOFF_MS = [1_000, 2_000, 4_000];
/** `needsLookup` rows older than this are dropped from the pending file. */
const LOOKUP_TTL_MS = 7 * 24 * 3600_000;
/** Deleting the temporary assets after the generation (not counted by the stale sweep: the record is settled). */
const FINISH_BUDGET_MS = 2 * API_TIMEOUT_MS;

/** Temporary product assets whose library_delete failed; retried by later generations. */
export const PENDING_DELETES_FILE = 'magnific-pending-deletes.json';
/** A pending delete is dropped (with a warning) after this many failed attempts. */
const MAX_DELETE_ATTEMPTS = 20;
/** Recorded ids retried per run (a generation's asset creation or a finish()), and how many at once. */
const MAX_RETRIES_PER_RUN = 5;
const DELETE_CONCURRENCY = 2;
/**
 * An `active` entry (an asset some generation may still be using) older than this is orphaned
 * (its process died before finish()): the longest a generation can run, plus its finish().
 */
const ORPHAN_AFTER_MS = STALE_MS + FINISH_BUDGET_MS;

export interface McpProviderDeps {
  openSession: (timeoutMs: number) => Promise<McpSession>;
  putUpload: (url: string, body: Buffer, timeoutMs: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Budget for one whole generate() (asset creation, connect, generate, wait, get). Defaults
   * to API_TIMEOUT_MS + WAIT_TIMEOUT_MS so a variation still fits MAX_VARIATION_MS.
   */
  budgetMs?: number;
  /** Cap for the shared asset creation inside that budget; defaults to ASSET_PREP_MS. */
  prepBudgetMs?: number;
  /** Budget for finish() (deleting the assets); defaults to 2 × API_TIMEOUT_MS. */
  finishBudgetMs?: number;
}

async function putUpload(url: string, body: Buffer, timeoutMs: number): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new UserError("Magnific'e bağlanılamadı, internet bağlantınızı kontrol edin.");
  }
  if (!res.ok) {
    console.error(`Magnific yükleme HTTP ${res.status}`);
    throw new UserError(`Magnific hatası (${res.status}): görsel yüklenemedi`);
  }
}

const defaultDeps: McpProviderDeps = { openSession: (ms) => openMcpSession(ms), putUpload };

// ---- result parsing ----
// Shapes verified against the live Magnific MCP server on 2026-11-18 (images_generate →
// creations[]; creations_wait → results[] with results.url and allTerminal; creations_get →
// YAML-like text). The parsing stays lenient about wrapper keys in case they shift.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const LIST_KEYS = ['creations', 'items', 'results', 'data'];
const WRAP_KEYS = ['creation', 'data', 'result'];

function unexpected(tool: string, result: unknown): UserError {
  return new UserError(`Magnific hatası: beklenmeyen yanıt (${tool}): ${excerpt(result)}`);
}

function findIdentifiers(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => findIdentifiers(x).slice(0, 1));
  if (!isObj(v)) return [];
  for (const k of ['identifier', 'creationIdentifier']) if (nonEmpty(v[k])) return [v[k] as string];
  if (Array.isArray(v.identifiers)) {
    const ids = v.identifiers.filter(nonEmpty);
    if (ids.length) return ids;
  }
  for (const k of LIST_KEYS) {
    if (Array.isArray(v[k])) {
      const ids = findIdentifiers(v[k]);
      if (ids.length) return ids;
    }
  }
  for (const k of WRAP_KEYS) {
    if (isObj(v[k])) {
      const ids = findIdentifiers(v[k]);
      if (ids.length) return ids;
    }
  }
  return [];
}

export function extractIdentifiers(tool: string, result: unknown): string[] {
  const ids = findIdentifiers(result);
  if (!ids.length) throw unexpected(tool, result);
  return ids;
}

/** Per-creation entries of a wait/get result. */
function entries(v: unknown): Obj[] {
  if (Array.isArray(v)) return v.filter(isObj);
  if (!isObj(v)) return [];
  for (const k of LIST_KEYS) if (Array.isArray(v[k])) return v[k].filter(isObj);
  for (const k of WRAP_KEYS) if (isObj(v[k])) return entries(v[k]);
  return [v];
}

const DONE = new Set(['completed', 'complete', 'done', 'succeeded', 'success', 'finished', 'ready', 'generated']);
const FAILED = new Set(['failed', 'failure', 'error', 'errored', 'cancelled', 'canceled', 'rejected', 'expired', 'deleted']);

function statusOf(e: Obj): string | undefined {
  const s = e.status ?? e.state;
  return typeof s === 'string' ? s.toLowerCase().replace(/[\s-]/g, '_') : undefined;
}

function pollAfterMs(result: unknown, list: Obj[]): number {
  const values = [result, ...list]
    .filter(isObj)
    .map((o) => o.poll_after_seconds ?? o.pollAfterSeconds)
    .filter((n): n is number => typeof n === 'number' && n > 0);
  return values.length ? Math.max(...values) * 1000 : 0;
}

type WaitState = { state: 'done'; urls: Map<string, string> } | { state: 'pending'; pollMs: number };

const isUrl = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//.test(u);

/** Full-res urls of a completed wait result: results[i].results.url, keyed by identifier. */
function waitUrls(list: Obj[]): Map<string, string> {
  const urls = new Map<string, string>();
  for (const e of list) {
    const id = nonEmpty(e.identifier) ? e.identifier : nonEmpty(e.creationIdentifier) ? e.creationIdentifier : undefined;
    const inner = isObj(e.results) ? e.results.url : undefined;
    if (id && isUrl(inner)) urls.set(id, inner);
  }
  return urls;
}

export function readWaitResult(tool: string, result: unknown): WaitState {
  const list = entries(result);
  const known = list.filter((e) => statusOf(e) !== undefined || 'poll_after_seconds' in e);
  if (!known.length) throw unexpected(tool, result);
  if (known.some((e) => FAILED.has(statusOf(e) ?? ''))) throw new UserError(FAILED_MSG);
  if (known.every((e) => DONE.has(statusOf(e) ?? ''))) return { state: 'done', urls: waitUrls(known) };
  // The server says nothing will change any more, yet not everything is done: treat the
  // unknown terminal state as a failure instead of polling until the deadline.
  if (isObj(result) && result.allTerminal === true) {
    const odd = known.map(statusOf).filter((s) => !DONE.has(s ?? ''));
    console.warn(`Magnific MCP: allTerminal ile bitmemiş durum(lar) ${JSON.stringify(odd)}, başarısız sayıldı.`);
    throw new UserError(FAILED_MSG);
  }
  for (const e of known) {
    const s = statusOf(e);
    if (s && !DONE.has(s) && !/progress|pending|queue|process|running|created|start|wait/.test(s)) {
      console.warn(`Magnific MCP: bilinmeyen durum "${s}", beklemeye devam ediliyor.`);
    }
  }
  return { state: 'pending', pollMs: pollAfterMs(result, list) };
}

const unquote = (v: string): string => {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      const j: unknown = JSON.parse(t);
      if (typeof j === 'string') return j;
    } catch {
      /* fall through */
    }
    return t.slice(1, -1);
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  return t;
};

/**
 * Parses the YAML-like text creations_get returns ("creations[N]:" + "- " items, or one
 * unwrapped record). Reads only the record's own top-level `identifier:` and `url:` lines
 * (never thumbnailUrl/previewUrl/webUrl or anything nested under metadata).
 */
export function parseCreationsText(text: string): { identifier?: string; url?: string }[] {
  const records: { identifier?: string; url?: string }[] = [];
  let cur: { identifier?: string; url?: string } | undefined;
  let listIndent: number | undefined;
  let fieldIndent = 0;
  const field = (indent: number, body: string) => {
    if (!cur || indent !== fieldIndent) return;
    const m = /^([A-Za-z_][\w]*):(?:\s+(.*))?$/.exec(body.trimEnd());
    if (!m) return;
    if (m[1] === 'identifier' && m[2]) cur.identifier = unquote(m[2]);
    else if (m[1] === 'url' && m[2]) cur.url = unquote(m[2]);
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*\w+\[\d+\]:\s*$/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    const item = /^(\s*)-\s+(.*)$/.exec(line);
    if (item) {
      if (listIndent === undefined) listIndent = indent;
      if (indent === listIndent) {
        cur = {};
        records.push(cur);
        fieldIndent = line.length - item[2].length;
        field(fieldIndent, item[2]);
      }
      continue;
    }
    if (!cur && listIndent === undefined) {
      cur = {};
      records.push(cur);
      fieldIndent = indent;
    }
    field(indent, line.trimStart());
  }
  return records;
}

/** identifier -> full-res url from a creations_get result (JSON, or the YAML-like text). */
export function extractUrlMap(tool: string, result: unknown, requested: string[]): Map<string, string> {
  let list: { identifier?: string; url?: string }[];
  const text = typeof result === 'string' ? result : isObj(result) && nonEmpty(result.text) ? result.text : undefined;
  if (text !== undefined) list = parseCreationsText(text);
  else {
    list = entries(result).map((e) => ({
      identifier: nonEmpty(e.identifier) ? e.identifier : nonEmpty(e.creationIdentifier) ? e.creationIdentifier : undefined,
      url: isUrl(e.url) ? e.url : undefined,
    }));
  }
  const map = new Map<string, string>();
  for (const r of list) {
    if (!isUrl(r.url)) continue;
    const id = r.identifier ?? (list.length === 1 && requested.length === 1 ? requested[0] : undefined);
    if (id && !map.has(id)) map.set(id, r.url);
  }
  if (!map.size) throw unexpected(tool, result);
  return map;
}

// ---- request building ----

type Within = (capMs: number) => number;

/** `within(cap)`: the time a step may take, capped by what is left of `ms`; throws once it is used up. */
function deadlineIn(ms: number): Within {
  const deadline = Date.now() + ms;
  return (capMs) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new UserError(TIMEOUT_MSG);
    return Math.min(capMs, left);
  };
}

/** Waits for `p`, but rejects with the timeout message when `within`'s deadline passes first. */
async function untilDeadline<T>(p: Promise<T>, within: Within): Promise<T> {
  const ms = within(Number.POSITIVE_INFINITY);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UserError(TIMEOUT_MSG)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const TR_ASCII: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', Ö: 'o', Ş: 's', Ü: 'u' };
const NAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const MAX_ASSET_NAME = 50;

function slug(name: string): string {
  return name
    .replace(/[çğıİöşüÇĞÖŞÜ]/g, (c) => TR_ASCII[c])
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Unique library name `mgs-<8 random [a-z0-9]>-<slug>` (≤ 50 chars of [a-zA-Z0-9_-]). */
export function assetName(productName: string): string {
  const rand = Array.from({ length: 8 }, () => NAME_ALPHABET[randomInt(NAME_ALPHABET.length)]).join('');
  const prefix = `mgs-${rand}-`;
  const rest = slug(productName).slice(0, MAX_ASSET_NAME - prefix.length).replace(/-+$/, '');
  return prefix + (rest || 'urun');
}

/** Fills the prompt's `{{Pn}}` placeholders with `@<asset name>` (Magnific's library mention). */
export function mentionProducts(prompt: string, names: string[]): string {
  return prompt.replace(/\{\{P(\d+)\}\}/g, (m, n: string) => {
    const name = names[Number(n) - 1];
    return name ? `@${name}` : m;
  });
}

export function buildGenerateArgs(input: {
  prompt: string;
  aspect: AspectRatio;
  resolution: Resolution;
  seed: number;
  /** Library ids of the product assets, in prompt order. */
  productIds: number[];
  /** Creation identifier of the uploaded room image. */
  space?: string;
  cinematic?: CinematicSettings;
}): Record<string, unknown> {
  // Known controls only, never 'Auto' (Otomatik = let the model decide).
  const controls = cleanCinematic(input.cinematic) ?? {};
  const seed = Math.abs(Math.trunc(input.seed)) % (MAX_SEED + 1);
  return {
    prompt: input.prompt,
    mode: 'cinematic',
    aspectRatio: input.aspect,
    resolution: input.resolution,
    count: 1,
    seed: Number.isFinite(seed) ? seed : 0,
    references: [
      ...input.productIds.map((id) => ({ type: 'product', identifier: String(id) })),
      ...(input.space ? [{ type: 'image', identifier: input.space }] : []),
    ],
    ...(Object.keys(controls).length ? { extraSettings: { cinematicControls: controls } } : {}),
  };
}

// ---- temporary product assets (library_create / library_delete) ----

export interface ProductAsset {
  id: number;
  name: string;
}

const ASSET_NAME_RE = /^[A-Za-z0-9_-]{1,50}$/;
const LIB_ID_KEYS = ['id', 'libraryId', 'library_id'];
const LIB_WRAP_KEYS = ['library', 'item', 'element', 'asset', 'product', 'data', 'result'];

function toLibraryId(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : undefined;
  if (typeof v === 'string' && /^\d{1,15}$/.test(v.trim())) {
    const n = Number(v.trim());
    return n > 0 ? n : undefined;
  }
  return undefined;
}

function findLibrary(v: unknown, depth = 0): { id: number; name?: string } | undefined {
  if (Array.isArray(v)) return v.length === 1 ? findLibrary(v[0], depth + 1) : undefined;
  if (!isObj(v) || depth > 3) return undefined;
  for (const k of LIB_ID_KEYS) {
    const id = toLibraryId(v[k]);
    if (id) return { id, name: nonEmpty(v.name) ? v.name : undefined };
  }
  for (const k of LIB_WRAP_KEYS) {
    const r = findLibrary(v[k], depth + 1);
    if (r) return r;
  }
  return undefined;
}

/**
 * The asset of a library_create result. Live shape (verified 2026-11-18):
 * `{id:number, identifier, name, ...}`. Parsing stays lenient in case it shifts: the id may be
 * a number or a numeric string, possibly nested, or a line of YAML-like text. A server-assigned
 * name wins over the requested one (the mention needs it).
 */
export function readLibraryCreate(result: unknown, requestedName: string): ProductAsset {
  let found = findLibrary(result);
  const text = typeof result === 'string' ? result : isObj(result) && nonEmpty(result.text) ? result.text : undefined;
  if (!found && text !== undefined) {
    const id = toLibraryId(/^\s*(?:id|libraryId|library_id):\s*["']?(\d+)["']?\s*$/m.exec(text)?.[1]);
    if (id) found = { id, name: /^\s*name:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/m.exec(text)?.[1] };
  }
  if (!found) throw unexpected('library_create', result);
  // Free (verified live 2026-11-18, not in simulate_cost); still log a credits field if one ever appears.
  const credits = isObj(result) ? (result.credits ?? (isObj(result.data) ? result.data.credits : undefined)) : undefined;
  if (typeof credits === 'number') console.log(`Magnific MCP library_create kredi: ${credits}`);
  const name = found.name && ASSET_NAME_RE.test(found.name) ? found.name : requestedName;
  return { id: found.id, name };
}

/**
 * One row of PENDING_DELETES_FILE. Every created asset is recorded here (`active`) right after
 * library_create, so a server restart cannot leak it; the row goes once the asset is deleted.
 * `needsLookup` rows (id null) are creations whose outcome is unknown (timeout, unreadable
 * result): only recorded for the owner, never retried.
 */
interface PendingDelete {
  id: number | null;
  name?: string;
  attempts: number;
  since: string;
  active?: boolean;
  needsLookup?: boolean;
}

function toPending(v: unknown): PendingDelete | undefined {
  if (!isObj(v)) return undefined;
  const lookup = v.id === null && v.needsLookup === true && nonEmpty(v.name);
  if (!lookup && toLibraryId(v.id) !== v.id) return undefined;
  return {
    ...(v as unknown as PendingDelete),
    attempts: typeof v.attempts === 'number' && v.attempts >= 0 ? v.attempts : 0,
    since: nonEmpty(v.since) ? v.since : '',
  };
}

async function loadPending(): Promise<PendingDelete[]> {
  try {
    const list = await readJson<unknown>(PENDING_DELETES_FILE, []);
    return Array.isArray(list) ? list.map(toPending).filter((p): p is PendingDelete => !!p) : [];
  } catch {
    return []; // unreadable: start over rather than block generation
  }
}

function updatePending(fn: (list: PendingDelete[]) => PendingDelete[]): Promise<void> {
  return serialize(PENDING_DELETES_FILE, async () => {
    await writeJson(PENDING_DELETES_FILE, tidyLookups(fn(await loadPending()), Date.now()));
  });
}

/** Drops `needsLookup` rows older than LOOKUP_TTL_MS and keeps one row per name. */
function tidyLookups(list: PendingDelete[], now: number): PendingDelete[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    if (!p.needsLookup) return true;
    const t = Date.parse(p.since);
    if (Number.isFinite(t) && now - t > LOOKUP_TTL_MS) return false;
    const key = p.name ?? '';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Rows a retry may delete now: with an id, not `own`, and not a young `active` (in use) asset. */
function retryable(list: PendingDelete[], ownIds: Set<number>, now: number): (PendingDelete & { id: number })[] {
  return list
    .filter((p): p is PendingDelete & { id: number } => p.id !== null && !p.needsLookup && !ownIds.has(p.id))
    .filter((p) => {
      if (!p.active) return true;
      const t = Date.parse(p.since);
      return !Number.isFinite(t) || now - t > ORPHAN_AFTER_MS;
    })
    .slice(0, MAX_RETRIES_PER_RUN);
}

function withoutActive(p: PendingDelete): PendingDelete {
  const rest = { ...p };
  delete rest.active;
  return rest;
}

const isUnexpectedCreate = (e: unknown) =>
  e instanceof UserError && e.message.startsWith('Magnific hatası: beklenmeyen yanıt (library_create)');
const errMsg = (e: unknown) => excerpt(e instanceof Error ? e.message : e, 300);
const warnDelete = (e: unknown) => console.warn(`Magnific geçici ürün silme hatası: ${errMsg(e)}`);

/**
 * The library item itself no longer exists: only a tool-error text about the item. Not a
 * transport 404 ("Magnific hatası (404)", e.g. an expired MCP session) and not an unknown
 * tool/method (-32601). When in doubt the id stays pending (MAX_DELETE_ATTEMPTS drops it).
 */
function isGone(e: unknown): boolean {
  if (!(e instanceof UserError) || !e.message.startsWith('Magnific hatası: ')) return false;
  const m = e.message;
  if (/-32601|method not found|\btool\b[^.]*\b(?:not found|unknown|does not exist)|unknown tool/i.test(m)) return false;
  const item = /\b(?:library|item|element|asset|product)\b/i.test(m);
  return item && /\bnot found\b|does not exist|no longer exists|already deleted|bulunamad/i.test(m);
}

/** Records a just-created asset as in use. */
function recordActive(a: ProductAsset): Promise<void> {
  const since = new Date().toISOString();
  return updatePending((list) => [
    ...list.filter((p) => p.id !== a.id),
    { id: a.id, name: a.name, attempts: 0, since, active: true },
  ]);
}

/** Records a creation of unknown outcome, so the owner can find it by name. */
function recordLookup(name: string): Promise<void> {
  const since = new Date().toISOString();
  return updatePending((list) => [...list, { id: null, name, attempts: 0, since, needsLookup: true }]);
}

/**
 * The assets stay recorded for a later delete. By default they are no longer active (no
 * connection for finish(): any later run may retry them). With `stillInUse` they stay active,
 * with a fresh clock: Magnific may still be rendering a job that references them, so only the
 * orphan sweep (ORPHAN_AFTER_MS from now) may delete them.
 */
async function keepPending(assets: ProductAsset[], stillInUse = false): Promise<void> {
  if (!assets.length) return;
  const since = new Date().toISOString();
  const ids = new Set(assets.map((a) => a.id));
  await updatePending((list) => [
    ...list.map((p) => {
      if (p.id === null || !ids.has(p.id)) return p;
      return stillInUse ? { ...p, active: true, since } : withoutActive(p);
    }),
    ...assets
      .filter((a) => !list.some((p) => p.id === a.id))
      .map((a) => ({ id: a.id, name: a.name, attempts: 0, since, ...(stillInUse ? { active: true } : {}) })),
  ]);
}

/**
 * Deletes `own` plus up to MAX_RETRIES_PER_RUN retryable recorded assets on `session`, at most
 * DELETE_CONCURRENCY at a time. A deleted (or gone) asset leaves the file; a failure stays
 * (attempts + 1, no longer active). Never throws for a delete; only console.warn (redacted).
 */
async function deleteAssets(session: McpSession, own: ProductAsset[], within: Within): Promise<void> {
  const ownIds = new Set(own.map((a) => a.id));
  const others = retryable(await loadPending(), ownIds, Date.now());
  const targets: ProductAsset[] = [...own, ...others.map((p) => ({ id: p.id, name: p.name ?? '' }))];
  if (!targets.length) return;

  const failed = new Set<number>();
  await mapLimit(targets, DELETE_CONCURRENCY, async (a) => {
    try {
      const res = await session.callTool('library_delete', { id: a.id }, within(API_TIMEOUT_MS));
      // Live result: { id, name, deleted: true }.
      if (isObj(res) && res.deleted === false) throw new UserError('Magnific: silinmedi (deleted: false)');
    } catch (e) {
      if (isGone(e)) return;
      failed.add(a.id);
      console.warn(`Magnific geçici ürün ${a.id} (${a.name}) silinemedi, sonra tekrar denenecek: ${errMsg(e)}`);
    }
  });

  const attempted = new Set(targets.map((a) => a.id));
  const since = new Date().toISOString();
  await updatePending((list) => {
    const next: PendingDelete[] = [];
    for (const p of list) {
      if (p.id === null || !attempted.has(p.id)) next.push(p); // not ours to touch
      else if (failed.has(p.id)) {
        const attempts = p.attempts + 1;
        if (attempts >= MAX_DELETE_ATTEMPTS) {
          console.warn(`Magnific geçici ürün ${p.id} ${attempts} denemede silinemedi; elle silinmeli (${p.name ?? ''}).`);
        } else next.push({ ...withoutActive(p), attempts });
      }
    }
    for (const a of own) {
      if (failed.has(a.id) && !next.some((p) => p.id === a.id)) next.push({ id: a.id, name: a.name, attempts: 1, since });
    }
    return next;
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface Prepared {
  assets: ProductAsset[];
  /** Creation identifier of the uploaded room image. */
  space?: string;
}

function validateInput(products: ProviderProduct[], space: string | undefined): void {
  if (!Array.isArray(products) || products.length < 1 || products.length > MAX_PRODUCTS) {
    throw new UserError(`Bir sahnede 1–${MAX_PRODUCTS} ürün olabilir.`);
  }
  for (const p of products) {
    if (!Array.isArray(p.images) || p.images.length < 1 || p.images.length > MAX_PRODUCT_IMAGES) {
      throw new UserError(`Her ürün için 1–${MAX_PRODUCT_IMAGES} fotoğraf gerekli.`);
    }
  }
  if (products.length + (space ? 1 : 0) > MAX_REFERENCES) {
    throw new UserError(`En fazla ${MAX_REFERENCES} referans kullanılabilir.`);
  }
}

/**
 * Magnific Cinematic over MCP. One instance per startGeneration: the photos are uploaded and
 * each product becomes a temporary Magnific library "product" asset once, shared by all
 * variations (each variation still has its own session for generate/wait). finish() deletes
 * the assets (unless a paid variation timed out: then the orphan sweep does it later); failed
 * deletes are recorded and retried by later generations.
 */
export function createMcpProvider(deps: McpProviderDeps = defaultDeps): ImageProvider {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budgetMs = deps.budgetMs ?? API_TIMEOUT_MS + WAIT_TIMEOUT_MS;
  const prepBudgetMs = Math.min(deps.prepBudgetMs ?? ASSET_PREP_MS, budgetMs);
  const finishBudgetMs = deps.finishBudgetMs ?? FINISH_BUDGET_MS;
  const preps = new Map<string, Promise<Prepared>>();
  /** Every asset this instance created and has not deleted yet. */
  const created: ProductAsset[] = [];
  /** Set when a variation timed out after images_generate: Magnific may still be rendering it. */
  let paidTimeout = false;

  /**
   * Retries `fn` on `retryOn` errors with a small backoff, within `within`'s deadline. Only for
   * asset preparation (no credits spent yet). Gives up with the last error.
   */
  async function prepRetry<T>(within: Within, retryOn: (e: unknown) => boolean, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= PREP_BACKOFF_MS.length || !retryOn(e)) throw e;
        let left: number;
        try {
          left = within(Number.POSITIVE_INFINITY);
        } catch {
          throw e; // deadline reached: fail with the error itself
        }
        await sleep(Math.min(PREP_BACKOFF_MS[attempt], left));
      }
    }
  }

  async function runPrepare(products: ProviderProduct[], space: string | undefined): Promise<Prepared> {
    const within = deadlineIn(prepBudgetMs);
    const session = await deps.openSession(within(API_TIMEOUT_MS));
    // Earlier failed deletes are not retried here (finish() does it): they would compete with
    // the uploads for the rate limit.
    try {
      const call = (name: string, args: Record<string, unknown>) => session.callTool(name, args, within(API_TIMEOUT_MS));

      const uploadRef = (ref: string, fileName: string): Promise<string> => {
        let putFailed = false;
        // A transient error on request or finalize restarts the whole sequence: a presigned URL
        // takes one PUT and is never reused, a retry requests a fresh one. A failed PUT is not retried.
        return prepRetry(
          within,
          (e) => !putFailed && isTransientError(e),
          async () => {
            const req = await call('creations_request_upload', { mimeType: 'image/jpeg' });
            const url = isObj(req) ? req.proxyUploadUrl : undefined;
            const path = isObj(req) ? req.path : undefined;
            if (!nonEmpty(url) || !nonEmpty(path)) throw unexpected('creations_request_upload', req);
            try {
              await deps.putUpload(url, Buffer.from(ref, 'base64'), within(API_TIMEOUT_MS));
            } catch (e) {
              putFailed = true;
              throw e;
            }
            const fin = await call('creations_finalize_upload', { path, fileName, visible: false });
            return extractIdentifiers('creations_finalize_upload', fin)[0];
          },
        );
      };
      // Same photo content (e.g. in two products) is uploaded once.
      const uploads = new Map<string, Promise<string>>();
      const uploadOnce = ({ ref, fileName }: { ref: string; fileName: string }) => {
        const key = sha(ref);
        let p = uploads.get(key);
        if (!p) {
          p = uploadRef(ref, fileName);
          uploads.set(key, p);
        }
        return p;
      };

      const jobs = products.flatMap((p, pi) => p.images.map((ref, ii) => ({ ref, fileName: `urun-${pi + 1}-${ii + 1}.jpg` })));
      if (space) jobs.push({ ref: space, fileName: 'mekan.jpg' });
      const ids = await mapLimit(jobs, UPLOAD_CONCURRENCY, uploadOnce);

      let k = 0;
      const perProduct = products.map((p) => [...new Set(p.images.map(() => ids[k++]))]);
      const settled = await Promise.allSettled(
        products.map(async (p, i) => {
          const requested = assetName(p.name);
          let asset: ProductAsset;
          try {
            // Only a 429 is retried: it means nothing was created. Any other transient error
            // (timeout, 5xx, connection) may have created the asset, so it is never repeated.
            const res = await prepRetry(
              within,
              (e) => e instanceof UserError && e.message === RATE_MSG,
              () =>
                session.callTool(
                  'library_create',
                  {
                    type: 'product',
                    name: requested,
                    images: perProduct[i].map((creationIdentifier) => ({ creationIdentifier })),
                    description: `${p.name} (Mobilya Görsel Stüdyosu geçici ürün)`,
                  },
                  within(API_TIMEOUT_MS),
                ),
            );
            asset = readLibraryCreate(res, requested);
          } catch (e) {
            // It may exist without us knowing its id: leave a trace the owner can search for.
            // Not for a 429: nothing was created then.
            const rate = e instanceof UserError && e.message === RATE_MSG;
            if (!rate && (isTransientError(e) || isUnexpectedCreate(e))) {
              console.warn(`Magnific geçici ürün "${requested}" oluşmuş olabilir ama kimliği alınamadı; kütüphanede bu adla arayıp elle silin: ${errMsg(e)}`);
              await recordLookup(requested).catch(warnDelete);
            }
            throw e;
          }
          created.push(asset); // before anything else can fail: finish() must delete it
          // Survives a restart: a later generation deletes it once it is orphaned.
          await recordActive(asset).catch(warnDelete);
          return asset;
        }),
      );
      const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failure) throw failure.reason;
      return {
        assets: settled.map((r) => (r as PromiseFulfilledResult<ProductAsset>).value),
        space: space ? ids[ids.length - 1] : undefined,
      };
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  function prepare(products: ProviderProduct[], space: string | undefined): Promise<Prepared> {
    const key = sha(JSON.stringify([products.map((p) => [p.name, p.images.map(sha)]), space ? sha(space) : null]));
    let p = preps.get(key);
    if (!p) {
      p = runPrepare(products, space);
      p.catch(() => undefined); // every variation awaits it; avoid an unhandled rejection
      preps.set(key, p);
    }
    return p;
  }

  return {
    async generate({ prompt, products, space, aspect, resolution, seed, cinematic }) {
      validateInput(products, space);

      const within = deadlineIn(budgetMs);
      // Asset creation is the first step of this variation's budget (shared by all variations).
      const prepared = await untilDeadline(prepare(products, space), within);

      const session = await deps.openSession(within(API_TIMEOUT_MS));
      try {
        const call = (name: string, args: Record<string, unknown>, capMs = API_TIMEOUT_MS) =>
          session.callTool(name, args, within(capMs));

        const gen = await call(
          'images_generate',
          buildGenerateArgs({
            prompt: mentionProducts(prompt, prepared.assets.map((a) => a.name)),
            aspect,
            resolution,
            seed,
            productIds: prepared.assets.map((a) => a.id),
            space: prepared.space,
            cinematic,
          }),
        );

        // From here on the credits are spent: retry transient errors until the deadline, and
        // tell the user the image may already be in their Magnific library if it still fails.
        const retrying = async <T>(fn: () => Promise<T>): Promise<T> => {
          for (let attempt = 0; ; attempt++) {
            try {
              return await fn();
            } catch (e) {
              if (!isTransientError(e)) throw e;
              let left: number;
              try {
                left = within(Number.POSITIVE_INFINITY);
              } catch {
                throw e; // deadline reached: fail with the transient error itself
              }
              const pause = Math.min(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)], left);
              console.warn(`Magnific MCP geçici hata, ${pause} ms sonra tekrar denenecek: ${(e as Error).message}`);
              await sleep(pause);
            }
          }
        };

        try {
          const created = extractIdentifiers('images_generate', gen);

          let waitUrlMap = new Map<string, string>();
          for (;;) {
            let started = 0;
            const res = await retrying(() => {
              const left = within(Number.POSITIVE_INFINITY);
              const timeoutSeconds = Math.max(0, Math.min(WAIT_STEP_S, Math.floor(left / 1000)));
              started = Date.now();
              return call('creations_wait', { identifiers: created, timeoutSeconds }, timeoutSeconds * 1000 + WAIT_CALL_MARGIN_MS);
            });
            const w = readWaitResult('creations_wait', res);
            if (w.state === 'done') {
              waitUrlMap = w.urls;
              break;
            }
            // Respect poll_after_seconds; never spin if the long-poll returned at once.
            const pause = w.pollMs || (Date.now() - started < MIN_WAIT_CALL_MS ? MIN_WAIT_CALL_MS : 0);
            if (pause > 0) await sleep(within(pause));
          }

          // Primary: creations_wait already carries the full-res url. Fallback: creations_get.
          const missing = created.filter((id) => !waitUrlMap.has(id));
          if (missing.length) {
            const got = await retrying(() => call('creations_get', { identifiers: missing }));
            for (const [id, url] of extractUrlMap('creations_get', got, missing)) waitUrlMap.set(id, url);
          }
          const out = created.map((id) => waitUrlMap.get(id));
          if (out.some((u) => !u)) throw unexpected('creations_get', { missing: created.filter((id) => !waitUrlMap.has(id)).length });
          return out as string[];
        } catch (e) {
          if (e instanceof UserError && e.message === TIMEOUT_MSG) paidTimeout = true;
          throw withLibraryHint(e);
        }
      } finally {
        await session.close().catch(() => undefined);
      }
    },

    async finish() {
      try {
        // Assets of a still-running creation (e.g. its variation hit the deadline first) are
        // only known once it settles; every step of it is time-bounded.
        await Promise.allSettled([...preps.values()]);
        let own = created.splice(0);
        if (paidTimeout && own.length) {
          // A paid variation timed out: Magnific may still be rendering a job that references
          // these assets. Keep them recorded (and in use); the orphan sweep deletes them later.
          await keepPending(own, true);
          own = [];
        }
        if (!own.length && !retryable(await loadPending(), new Set(), Date.now()).length) return;
        const within = deadlineIn(finishBudgetMs);
        let session: McpSession;
        try {
          session = await deps.openSession(within(API_TIMEOUT_MS));
        } catch (e) {
          console.warn(`Magnific geçici ürünler silinemedi (bağlantı yok), sonra tekrar denenecek: ${errMsg(e)}`);
          await keepPending(own);
          return;
        }
        try {
          await deleteAssets(session, own, within);
        } finally {
          await session.close().catch(() => undefined);
        }
      } catch (e) {
        warnDelete(e);
      }
    },
  };
}
