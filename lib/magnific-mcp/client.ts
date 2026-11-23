import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { UserError } from '@/lib/images/process';
import { FileOAuthProvider, getMagnificConnection, MCP_SERVER_URL } from './auth';
import { AUTH_FETCH_TIMEOUT_MS, baseFetch, withTimeout } from './timed-fetch';

export const NOT_CONNECTED_MSG =
  'Magnific hesabı bağlı değil. Üstteki "Magnific ile bağlan" düğmesine basın.';
export const TIMEOUT_MSG = 'Magnific yanıt vermedi (zaman aşımı).';
const CONN_MSG = "Magnific'e bağlanılamadı, internet bağlantınızı kontrol edin.";
const CREDIT_MSG = 'Magnific krediniz yetersiz.';
export const RATE_MSG = 'Magnific istek sınırına ulaşıldı, biraz sonra tekrar deneyin.';
export { AUTH_FETCH_TIMEOUT_MS, withTimeout };

/** One MCP connection for one request flow: callTool returns the parsed JSON result. */
export interface McpSession {
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  close(): Promise<void>;
}

interface ToolResultLike {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}

/** The subset of the SDK `Client` this module uses (fakeable in tests). */
export interface RawMcpClient {
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema: undefined,
    options: { timeout: number },
  ): Promise<ToolResultLike>;
  close(): Promise<void>;
}

export interface SessionDeps {
  createClient?: (provider: FileOAuthProvider, timeoutMs: number) => Promise<RawMcpClient>;
  /** Token-refresh preflight; defaults to the process-wide single-flight `refreshLogin`. */
  refresh?: () => Promise<void>;
  /** fetch for the OAuth token endpoint (tests). */
  fetchFn?: FetchLike;
  /** Timeout for each OAuth request of the refresh; defaults to AUTH_FETCH_TIMEOUT_MS. */
  authTimeoutMs?: number;
}

// Single-flight token refresh per process. Variations open their own sessions at the same
// time; with rotating refresh tokens, two parallel refreshes would race (the loser gets
// invalid_grant and the SDK deletes the winner's tokens). Stored on globalThis so every
// route bundle and HMR reload shares the same in-flight refresh.
const REFRESH_KEY = Symbol.for('mgs.magnific-mcp.refresh');

/**
 * Refreshes the stored login once (the SDK's auth() always refreshes when a refresh token
 * is stored) so the sessions that follow start with a fresh access token and never refresh
 * in parallel. Concurrent callers share the same refresh. Never starts a login.
 */
export function refreshLogin(fetchFn: FetchLike = baseFetch, timeoutMs = AUTH_FETCH_TIMEOUT_MS): Promise<void> {
  const g = globalThis as unknown as Record<symbol, Promise<void> | undefined>;
  const inflight = g[REFRESH_KEY];
  if (inflight) return inflight;
  const run = (async () => {
    await auth(new FileOAuthProvider({ interactive: false }), {
      serverUrl: MCP_SERVER_URL,
      fetchFn: withTimeout(fetchFn, timeoutMs),
    });
  })().finally(() => {
    if (g[REFRESH_KEY] === run) g[REFRESH_KEY] = undefined;
  });
  g[REFRESH_KEY] = run;
  return run;
}

const SECRET_KEY = /token|secret|password|signature|authorization|code_verifier/i;
const URL_RE = /https?:\/\/[^\s"'<>]+/g;

/** Deep copy with URLs and token-like fields hidden, for logs and error excerpts. */
export function redact(v: unknown): unknown {
  if (typeof v === 'string') return v.replace(URL_RE, '<url>');
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v).map(([k, val]) => [k, SECRET_KEY.test(k) ? '<redacted>' : redact(val)]),
    );
  }
  return v;
}

/** Short, redacted excerpt of a result for a UserError message. */
export function excerpt(v: unknown, max = 160): string {
  let s: string;
  try {
    s = JSON.stringify(redact(v)) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Log each tool's first result (redacted), to spot result-shape changes on the server.
const LOGGED_KEY = Symbol.for('mgs.magnific-mcp.logged-tools');
function logOnce(tool: string, data: unknown): void {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  const logged = (g[LOGGED_KEY] ??= new Set());
  if (logged.has(tool)) return;
  logged.add(tool);
  console.log(`Magnific MCP ${tool} sonucu (ilk kez, gizlenmiş): ${excerpt(data, 2000)}`);
}

function textOf(res: ToolResultLike): string {
  if (!Array.isArray(res.content)) return '';
  return res.content
    .filter((c): c is { type: 'text'; text: string } => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

// Only clear credit-shortage texts; "credit card", "balance must be…" etc. stay generic.
const CREDIT_SHORTAGE =
  /insufficient (?:credits?|balance|funds)|not enough (?:credits?|balance)|out of credits?|no (?:credits?|balance) (?:left|remaining)|credits? (?:exhausted|depleted)|kredi(?:niz)? yetersiz|yetersiz kredi|payment required|\b402\b/i;

function toolErrorMessage(text: string): string {
  if (CREDIT_SHORTAGE.test(text)) return CREDIT_MSG;
  if (/unauthori[sz]ed|unauthenticated|not authenticated|invalid[_ ]token|\b401\b/i.test(text)) {
    return NOT_CONNECTED_MSG;
  }
  const short = (redact(text) as string).replace(/\s+/g, ' ').trim().slice(0, 200);
  return `Magnific hatası: ${short || 'bilinmeyen hata'}`;
}

/** Parses an MCP tool result: structuredContent, else JSON text, else `{ text }`. */
export function parseToolResult(tool: string, res: ToolResultLike): unknown {
  const text = textOf(res);
  if (res.isError) {
    console.error(`Magnific MCP ${tool} hata: ${excerpt(text, 2000)}`);
    throw new UserError(toolErrorMessage(text));
  }
  let data: unknown;
  if (res.structuredContent && typeof res.structuredContent === 'object') {
    data = res.structuredContent;
  } else {
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
  }
  logOnce(tool, data);
  return data;
}

// 403 is deliberately not here: a plan/permission 403 must not log the user out.
function isAuthFailure(e: unknown): boolean {
  if (e instanceof UnauthorizedError || e instanceof OAuthError) return true;
  return e instanceof StreamableHTTPError && e.code === 401;
}

async function mapError(e: unknown): Promise<UserError> {
  if (e instanceof UserError) return e;
  if (isAuthFailure(e)) {
    const provider = new FileOAuthProvider({ interactive: false });
    const tokens = await provider.tokens().catch(() => undefined);
    // A refresh token is still stored: the SDK did not get invalid_grant (it deletes the
    // tokens then), so this was a transient failure (network/server during refresh). Keep it.
    if (tokens?.refresh_token) {
      console.error('Magnific MCP oturumu yenilenemedi (geçici):', e instanceof Error ? e.message : e);
      return new UserError(CONN_MSG);
    }
    // The grant is dead: forget it so the UI offers "Magnific ile bağlan" again.
    await provider.invalidateCredentials('tokens').catch((err) => console.error(err));
    return new UserError(NOT_CONNECTED_MSG);
  }
  if (e instanceof McpError) {
    if (e.code === ErrorCode.RequestTimeout) return new UserError(TIMEOUT_MSG);
    console.error(`Magnific MCP hata ${e.code}: ${excerpt(e.message, 2000)}`);
    return new UserError(toolErrorMessage(e.message));
  }
  if (e instanceof StreamableHTTPError) {
    console.error(`Magnific MCP HTTP ${e.code}: ${excerpt(e.message, 2000)}`);
    if (e.code === 429) return new UserError(RATE_MSG);
    return new UserError(`Magnific hatası (${e.code ?? '?'})`);
  }
  const netFail = e instanceof TypeError && /fetch|network|socket|ECONN|ENOTFOUND|EAI_AGAIN/i.test(`${e.message} ${String((e as { cause?: unknown }).cause ?? '')}`);
  const aborted = e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
  if (netFail || aborted) {
    return new UserError(CONN_MSG);
  }
  console.error(e);
  return new UserError(`Magnific hatası: ${excerpt(e instanceof Error ? e.message : String(e), 200)}`);
}

/**
 * True for a session error worth retrying on the same session: no connection, a timeout
 * (request or McpError), 429, or an HTTP 5xx. Never for a failed creation, an unexpected
 * shape, a tool error, credits or not-connected.
 */
export function isTransientError(e: unknown): boolean {
  if (!(e instanceof UserError)) return false;
  const m = e.message;
  return m === CONN_MSG || m === TIMEOUT_MSG || m === RATE_MSG || /^Magnific hatası \(5\d\d\)$/.test(m);
}

function sameOrigin(url: string, base: URL): boolean {
  try {
    return new URL(url).origin === base.origin;
  } catch {
    return false;
  }
}

async function connectClient(provider: FileOAuthProvider, timeoutMs: number): Promise<RawMcpClient> {
  const client = new Client({ name: 'mobilya-gorsel-studyosu', version: '0.1.0' });
  const endpoint = new URL(MCP_SERVER_URL);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider: provider,
    // A mid-session 401 makes the transport refresh by itself: time out those OAuth requests
    // (auth server), but leave the MCP server's own requests (long polls) to the per-call timeouts.
    fetch: withTimeout(baseFetch, AUTH_FETCH_TIMEOUT_MS, (url) => sameOrigin(url, endpoint)),
  });
  try {
    await client.connect(transport, { timeout: timeoutMs });
  } catch (e) {
    await transport.close().catch(() => undefined);
    throw e;
  }
  return client as unknown as RawMcpClient;
}

/**
 * Opens one MCP connection using the stored Magnific login. Never starts a login: without
 * tokens, or when they no longer work, throws the Turkish not-connected UserError.
 */
export async function openMcpSession(timeoutMs: number, deps: SessionDeps = {}): Promise<McpSession> {
  if (!(await getMagnificConnection()).connected) throw new UserError(NOT_CONNECTED_MSG);
  const provider = new FileOAuthProvider({ interactive: false });
  let client: RawMcpClient;
  try {
    if ((await provider.tokens())?.refresh_token) {
      await (deps.refresh ?? (() => refreshLogin(deps.fetchFn, deps.authTimeoutMs)))();
    }
    client = await (deps.createClient ?? connectClient)(provider, timeoutMs);
  } catch (e) {
    throw await mapError(e);
  }
  return {
    async callTool(name, args, ms) {
      let res: ToolResultLike;
      try {
        res = await client.callTool({ name, arguments: args }, undefined, { timeout: ms });
      } catch (e) {
        throw await mapError(e);
      }
      return parseToolResult(name, res);
    },
    close: () => client.close(),
  };
}
