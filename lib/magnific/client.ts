import fs from 'node:fs/promises';
import path from 'node:path';
import { UserError } from '@/lib/images/process';
import { dataPath } from '@/lib/storage/paths';

const CONN_MSG = "Magnific'e bağlanılamadı, internet bağlantınızı kontrol edin.";
const UNKNOWN_MSG = 'Beklenmeyen bir hata oluştu.';

/**
 * Appended to a variation's error when it failed AFTER images_generate succeeded: the
 * credits are spent and the image may already be in the Magnific library.
 */
export const LIBRARY_HINT = ' Görsel Magnific kütüphanenizde olabilir; tekrar üretmeden önce oraya bakın.';

/** The error as a UserError ending with LIBRARY_HINT (once). Non-UserErrors are logged and made generic. */
export function withLibraryHint(err: unknown): UserError {
  if (err instanceof UserError && err.message.endsWith(LIBRARY_HINT)) return err;
  if (!(err instanceof UserError)) console.error(err);
  return new UserError((err instanceof UserError ? err.message : UNKNOWN_MSG) + LIBRARY_HINT);
}

/** One Magnific MCP request (connect, upload, tool call). */
export const API_TIMEOUT_MS = 30_000;
/** One download attempt (request + body). */
export const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Pause before the single download retry. */
const DOWNLOAD_RETRY_DELAY_MS = 1_000;
/** Waiting for one creation to finish. */
export const WAIT_TIMEOUT_MS = 300_000;
const RECODE_MARGIN_MS = 60_000;
/**
 * Creating a generation's temporary Magnific product assets (photo uploads + library_create),
 * shared by its variations. It runs as the first step of each variation's generate() and is
 * counted inside that budget (API_TIMEOUT_MS + WAIT_TIMEOUT_MS), so MAX_VARIATION_MS below
 * already covers it; this cap only keeps it from eating most of the wait.
 */
export const ASSET_PREP_MS = 3 * API_TIMEOUT_MS;
/**
 * Worst case for one variation: requests + wait + two download attempts + re-encode margin
 * (the stale sweep relies on it).
 */
export const MAX_VARIATION_MS =
  API_TIMEOUT_MS + WAIT_TIMEOUT_MS + 2 * DOWNLOAD_TIMEOUT_MS + DOWNLOAD_RETRY_DELAY_MS + RECODE_MARGIN_MS;

export interface DownloadOpts {
  fetchImpl?: typeof fetch;
  /** Per attempt; defaults to 60 s. */
  requestTimeoutMs?: number;
  /** Pause before the one retry; defaults to 1 s. */
  retryDelayMs?: number;
}

class DownloadHttpError extends UserError {
  constructor(readonly status: number) {
    super(`Görsel indirilemedi (HTTP ${status}). "Tekrar üret"e basın.`);
  }
}

async function fetchBytes(f: typeof fetch, url: string, timeoutMs: number): Promise<Buffer> {
  try {
    // The timeout signal also covers reading the body.
    const res = await f(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      // Status only: the URL is signed and must not be logged.
      console.error(`Görsel indirme HTTP ${res.status}`);
      throw new DownloadHttpError(res.status);
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (e instanceof DownloadHttpError) throw e;
    throw new UserError(CONN_MSG);
  }
}

const isTransient = (e: unknown) =>
  e instanceof DownloadHttpError ? e.status === 429 || e.status >= 500 : e instanceof UserError;

/** Downloads a finished image (a short-lived CDN URL) to `data/<rel>`. Retries once on a transient failure. */
export async function downloadTo(url: string, rel: string, opts: DownloadOpts = {}): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.requestTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  let buf: Buffer;
  try {
    buf = await fetchBytes(f, url, timeoutMs);
  } catch (e) {
    if (!isTransient(e)) throw e;
    const delay = opts.retryDelayMs ?? DOWNLOAD_RETRY_DELAY_MS;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    buf = await fetchBytes(f, url, timeoutMs);
  }
  const dest = dataPath(rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
  return rel;
}
