import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

/** OAuth requests (discovery, registration, token): a hung auth server must not block forever. */
export const AUTH_FETCH_TIMEOUT_MS = 30_000;

/**
 * fetch with a per-request timeout (kept alongside the caller's own signal). Requests whose
 * URL `skip` accepts are passed through untouched (the MCP endpoint itself, whose long polls
 * have their own per-call timeouts).
 */
export function withTimeout(fetchFn: FetchLike, ms: number, skip?: (url: string) => boolean): FetchLike {
  return (url, init) => {
    if (skip?.(String(url))) return fetchFn(url, init);
    const timeout = AbortSignal.timeout(ms);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetchFn(url, { ...init, signal });
  };
}

export const baseFetch: FetchLike = (url, init) => fetch(url, init);
