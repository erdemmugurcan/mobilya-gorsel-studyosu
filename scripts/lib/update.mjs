// Prepares a new version from the public GitHub repo while the app keeps running. Nothing the
// running app uses is written to; `current.json` moves only after the new version has really
// opened, and it takes effect at the next launch.
import fs from 'node:fs';
import path from 'node:path';
import { flushTree, freeBytes, renameWithRetry, rmTree, writeFileDurable } from './fsutil.mjs';
import { APP_ENTRIES, foldKey, isPreserved, NON_APP_ENTRIES, toRel } from './paths.mjs';
import {
  isPointerUnreadable, layout, markComplete, markerState, prune, readCurrent, readVersionMeta, removeVersion, sourceHash,
  versionDir, versionIdForSha, writeCurrent,
} from './versions.mjs';
import { readZip, stripTopDir, zipComment } from './zip.mjs';

export const MAX_ATTEMPTS = 3; // Real failures of a version; they expire after a week.
export const MAX_INTERRUPTED = 5; // Windows closed mid-update; a hard limit that never expires.
export const MIN_FREE_BYTES = 3 * 1024 ** 3;

const USER_AGENT = 'mobilya-gorsel-studyosu-launcher';
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const ATTEMPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// The network, not the version: these never count against it.
const TRANSIENT_DOWNLOAD = new Set(['offline', 'timeout', 'rate-limit', 'server']);
const MAX_REMEMBERED_SHAS = 20;
const REQUIRED_FILES = ['package.json', 'package-lock.json', 'app.config.json'];
const REPO_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const KNOWN_ENTRIES = new Set([...APP_ENTRIES, ...NON_APP_ENTRIES].map((e) => e.normalize('NFC')));

class UpdateError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export function isPlaceholderRepo(repo) {
  if (typeof repo !== 'string') return true;
  const parts = repo.split('/');
  if (parts.length !== 2) return true;
  const [owner, name] = parts;
  if (!REPO_OWNER.test(owner) || !REPO_NAME.test(name) || name === '.' || name === '..') return true;
  return repo.toUpperCase() === 'OWNER/REPO';
}

export function parseConfig(text) {
  const raw = JSON.parse(text);
  if (!Number.isInteger(raw.nodeMajor) || raw.nodeMajor <= 0) throw new Error('nodeMajor geçersiz');
  const minLauncher = raw.minLauncher ?? 1;
  if (!Number.isInteger(minLauncher) || minLauncher <= 0) throw new Error('minLauncher geçersiz');
  return { repo: raw.repo, branch: raw.branch || 'main', nodeMajor: raw.nodeMajor, minLauncher };
}

export const commitsUrl = (repo, branch) =>
  `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`;
export const archiveUrl = (repo, sha) => `https://codeload.github.com/${repo}/zip/${sha}`;

function httpError(status) {
  if (status === 403 || status === 429) return new UpdateError('rate-limit', `GitHub yanıtı ${status}`);
  if (status === 404) return new UpdateError('not-found', 'GitHub yanıtı 404');
  return new UpdateError('server', `GitHub yanıtı ${status}`);
}

async function request(url, options) {
  try {
    return await options.fetchImpl(url, { headers: options.headers, signal: AbortSignal.timeout(options.timeoutMs) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new UpdateError('timeout', 'zaman aşımı');
    throw new UpdateError('offline', err instanceof Error ? err.message : String(err));
  }
}

async function fetchLatestSha({ repo, branch, fetchImpl }) {
  const res = await request(commitsUrl(repo, branch), {
    fetchImpl,
    timeoutMs: 5000,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw httpError(res.status);
  const body = await res.json().catch(() => null);
  if (typeof body?.sha !== 'string' || !/^[0-9a-f]{40}$/.test(body.sha)) {
    throw new UpdateError('server', 'GitHub yanıtı anlaşılamadı');
  }
  return body.sha;
}

// Stops at the limit instead of buffering a huge response first.
export async function readCappedBody(res, maxBytes) {
  const tooBig = () => new UpdateError('bad-archive', 'arşiv çok büyük');
  if (Number(res.headers?.get('content-length')) > maxBytes) throw tooBig();
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, total);
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
}

async function downloadArchive({ repo, sha, fetchImpl }) {
  const res = await request(archiveUrl(repo, sha), {
    fetchImpl,
    timeoutMs: 180_000,
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw httpError(res.status);
  try {
    return await readCappedBody(res, MAX_ARCHIVE_BYTES);
  } catch (err) {
    if (err instanceof UpdateError) throw err;
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new UpdateError('timeout', 'zaman aşımı');
    throw new UpdateError('offline', 'indirme yarıda kesildi');
  }
}

// GitHub puts the commit in the ZIP comment and in the `<repo>-<sha>/` top folder.
function readVerifiedEntries(buf, sha) {
  try {
    const entries = readZip(buf);
    const comment = zipComment(buf).trim();
    const top = entries[0]?.name.split('/')[0] ?? '';
    const matches = /^[0-9a-f]{40}$/.test(comment) ? comment === sha : top.endsWith(`-${sha}`);
    if (!matches) throw new Error('arşiv istenen sürüme ait değil');
    return stripTopDir(entries);
  } catch (err) {
    throw new UpdateError('bad-archive', err.message);
  }
}

// Validates every entry first, so a bad archive writes nothing at all.
function planFiles(entries) {
  const files = [];
  const names = new Map();
  const folders = new Set();
  for (const e of entries) {
    if (e.isDir || e.path === '') continue;
    if (e.isSymlink) throw new UpdateError('rejected', 'arşivde sembolik bağ var');
    const rel = toRel(e.path);
    if (!rel) throw new UpdateError('rejected', 'arşivde güvensiz dosya yolu');
    if (isPreserved(rel)) continue;
    const key = foldKey(rel);
    if (names.has(key)) throw new UpdateError('rejected', `aynı dosya iki adla: ${rel}`);
    names.set(key, rel);
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    files.push({ rel, data: e.data, mode: e.mode & 0o111 ? 0o755 : 0o644 });
  }
  for (const folder of folders) {
    if (names.has(folder)) throw new UpdateError('rejected', `aynı adda dosya ve klasör: ${names.get(folder)}`);
  }
  for (const required of REQUIRED_FILES) {
    if (names.get(foldKey(required)) !== required) throw new UpdateError('rejected', 'arşiv bu uygulamaya ait görünmüyor');
  }
  return files;
}

function writeFiles(dest, files) {
  for (const { rel, data, mode } of files) {
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx', mode });
  }
}

const onlyKnownEntries = (files) =>
  files.every(({ rel }) => KNOWN_ENTRIES.has(rel.split('/')[0].normalize('NFC')));

const SHA = /^[0-9a-f]{40}$/;
const shaCounts = (value) => Object.fromEntries(
  Object.entries(value && typeof value === 'object' ? value : {})
    .filter(([sha, n]) => SHA.test(sha) && Number.isInteger(n) && n > 0),
);

export function readUpdateState(root, now = Date.now()) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(layout(root).updateState, 'utf8'));
  } catch {
    // Missing or damaged: start counting again.
  }
  /** @type {Record<string, number>} */
  const attempts = {};
  /** @type {Record<string, number>} */
  const attemptAt = {};
  for (const [sha, n] of Object.entries(shaCounts(raw?.attempts))) {
    const at = Number.isFinite(raw?.attemptAt?.[sha]) ? raw.attemptAt[sha] : now;
    if (now - at > ATTEMPT_TTL_MS) continue;
    attempts[sha] = n;
    attemptAt[sha] = at;
  }
  /** @type {Record<string, number>} */
  const interrupted = shaCounts(raw?.interrupted);
  return {
    attempts,
    attemptAt,
    interrupted,
    lastCheck: typeof raw?.lastCheck === 'string' ? raw.lastCheck : null,
    needsNewZip: typeof raw?.needsNewZip === 'string' ? raw.needsNewZip : null,
    sameSource: typeof raw?.sameSource?.sha === 'string' && typeof raw?.sameSource?.id === 'string' ? raw.sameSource : null,
  };
}

function changeState(root, change) {
  const state = readUpdateState(root);
  change(state);
  for (const counts of [state.attempts, state.interrupted]) {
    const shas = Object.keys(counts);
    for (const sha of shas.slice(0, Math.max(0, shas.length - MAX_REMEMBERED_SHAS))) delete counts[sha];
  }
  for (const sha of Object.keys(state.attemptAt)) if (!state.attempts[sha]) delete state.attemptAt[sha];
  writeFileDurable(layout(root).updateState, JSON.stringify(state));
  return state;
}

function countAttempt(root, sha) {
  changeState(root, (state) => {
    state.attempts[sha] = (state.attempts[sha] ?? 0) + 1;
    state.attemptAt[sha] = Date.now();
  });
}

// A closed window says nothing about the version, so it moves to its own, separately capped count.
export function markInterrupted(root, sha) {
  changeState(root, (state) => {
    const left = (state.attempts[sha] ?? 0) - 1;
    if (left > 0) state.attempts[sha] = left;
    else delete state.attempts[sha];
    state.interrupted[sha] = (state.interrupted[sha] ?? 0) + 1;
  });
}

function activate(root, id, previous) {
  // After a read error at launch the running version may not be the real current one: keep both.
  const old = writeCurrent(root, { id, previous });
  prune(root, [id, previous, old]);
}

// Never throws: whatever goes wrong here, the running app must not notice.
export async function prepareUpdate({
  root, config, launcherVersion, runningId, machine, fetchImpl, ops, track = {}, onStart = () => {},
  freeSpace = () => freeBytes(root),
}) {
  if (isPlaceholderRepo(config.repo)) return { status: 'skipped', reason: 'placeholder' };
  // Without the pointer it is unknown which versions must be kept, so nothing may change.
  if (isPointerUnreadable(root)) return { status: 'blocked', reason: 'pointer', error: 'current.json okunamadı' };

  let sha;
  try {
    sha = await fetchLatestSha({ repo: config.repo, branch: config.branch, fetchImpl });
    changeState(root, (state) => { state.lastCheck = new Date().toISOString(); });
  } catch (err) {
    return { status: 'check-failed', kind: err?.kind ?? 'server', error: String(err?.message ?? err) };
  }

  const id = versionIdForSha(sha);
  const stagingDir = path.join(layout(root).staging, id);
  let ownsVersionFolder = false; // Only a folder this run created may be removed on failure.
  // Set when the launcher gives up its lock: from then on this run must not touch anything.
  const checkpoint = () => {
    if (track.abort) throw new UpdateError('aborted', 'durduruldu');
  };
  try {
    const pointer = readCurrent(root) ?? { id: runningId, previous: null };
    const currentMeta = readVersionMeta(root, pointer.id);
    const known = readUpdateState(root);
    if (currentMeta?.sha === sha) return { status: 'up-to-date', sha };
    if (known.sameSource?.sha === sha && known.sameSource.id === pointer.id) return { status: 'up-to-date', sha };
    if (known.needsNewZip === sha) return { status: 'needs-new-zip', sha };

    // Whatever else happens, the version in use right now stays on disk.
    const previous = runningId !== id ? runningId : pointer.id;
    // The 12-character id alone is not proof: the marker must name this exact commit.
    if (readVersionMeta(root, id)?.sha === sha) {
      activate(root, id, previous);
      return { status: 'ready', sha, id };
    }
    // A folder in use, or one whose state cannot be read, is never rebuilt over.
    if ([runningId, pointer.id, pointer.previous].includes(id) || markerState(root, id) === 'unreadable') {
      return { status: 'blocked', sha };
    }
    if ((known.attempts[sha] ?? 0) >= MAX_ATTEMPTS || (known.interrupted[sha] ?? 0) >= MAX_INTERRUPTED) {
      return { status: 'capped', sha };
    }
    // The app may be saving a paid image to this disk; an update must not fill it.
    const free = freeSpace();
    if (free !== null && free < MIN_FREE_BYTES) return { status: 'low-disk', sha };

    onStart(sha);
    let archive;
    try {
      archive = await downloadArchive({ repo: config.repo, sha, fetchImpl });
    } catch (err) {
      if (!TRANSIENT_DOWNLOAD.has(err?.kind)) countAttempt(root, sha);
      throw err;
    }
    checkpoint();

    // Counted before any real work: a crash or hang must still use up this try.
    countAttempt(root, sha);
    track.sha = sha;

    rmTree(stagingDir);
    const files = planFiles(readVerifiedEntries(archive, sha));
    writeFiles(stagingDir, files);
    checkpoint();

    const next = parseConfig(fs.readFileSync(path.join(stagingDir, 'app.config.json'), 'utf8'));
    if (next.minLauncher > launcherVersion) {
      changeState(root, (state) => { state.needsNewZip = sha; });
      rmTree(stagingDir);
      return { status: 'needs-new-zip', sha };
    }

    const hash = sourceHash(stagingDir);
    if (currentMeta?.sourceHash === hash && currentMeta.nodeMajor === next.nodeMajor && onlyKnownEntries(files)) {
      changeState(root, (state) => {
        state.sameSource = { sha, id: pointer.id };
        delete state.attempts[sha];
      });
      rmTree(stagingDir);
      return { status: 'up-to-date', sha };
    }

    const exec = await ops.ensureNode(next.nodeMajor);
    checkpoint();

    // Builds are not relocatable, so this one happens in its final folder; until `.complete`
    // exists nothing will ever start it.
    const finalDir = versionDir(root, id);
    ownsVersionFolder = true;
    if (fs.existsSync(finalDir) && !removeVersion(root, id, { protect: [runningId] })) {
      throw new UpdateError('rejected', 'eski sürüm klasörü kaldırılamadı');
    }
    fs.mkdirSync(layout(root).versions, { recursive: true });
    renameWithRetry(stagingDir, finalDir);

    await ops.install({ dir: finalDir, exec, id });
    checkpoint();
    await ops.build({ dir: finalDir, exec, id });
    checkpoint();
    await ops.smoke({ dir: finalDir, exec, id });
    checkpoint();
    await ops.verifyNative?.({ dir: finalDir, exec, id });
    checkpoint();
    await (ops.flush ?? flushTree)(finalDir);
    checkpoint();

    markComplete(root, id, { ...machine, sha, sourceHash: hash, nodeMajor: next.nodeMajor });
    ownsVersionFolder = false; // Finished: if the switch fails, the next launch only has to switch.
    activate(root, id, previous);
    return { status: 'ready', sha, id };
  } catch (err) {
    // The lock may already belong to another launcher; the next start cleans up.
    if (track.abort) return { status: 'aborted', sha };
    try {
      rmTree(stagingDir);
    } catch {
      // Removed at the next start.
    }
    if (ownsVersionFolder) removeVersion(root, id, { protect: [runningId] });
    return { status: 'failed', sha, kind: err?.kind ?? 'step', error: String(err?.message ?? err) };
  } finally {
    track.sha = null;
  }
}

// The plain Turkish line for the launcher window, or null when there is nothing to say.
export function updateNotice(result) {
  switch (result.status) {
    case 'ready': return 'Yeni sürüm hazır; bir sonraki açılışta kullanılacak.';
    case 'failed': return 'Yeni sürüm hazırlanamadı; mevcut sürümle devam ediliyor. Sonraki açılışta yeniden denenir.';
    case 'needs-new-zip':
      return 'Yeni sürüm bu başlatıcıyla kurulamıyor. GitHub sayfasından yeni zip indirin, yeni klasöre açın ve data klasörünüzü oraya kopyalayın.';
    case 'low-disk':
      return 'Diskte yeterli boş alan olmadığı için güncelleme atlandı (en az 3 GB gerekir). Uygulama mevcut sürümle çalışıyor.';
    default: return null;
  }
}
