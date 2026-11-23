import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { FileOAuthProvider, getMagnificConnection, MCP_SERVER_URL } from '@/lib/magnific-mcp/auth';
import {
  AUTH_FETCH_TIMEOUT_MS,
  isTransientError,
  NOT_CONNECTED_MSG,
  openMcpSession,
  parseToolResult,
  redact,
  withTimeout,
  type RawMcpClient,
} from '@/lib/magnific-mcp/client';

beforeEach(async () => {
  process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'mgs-mcpcli-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const CONN_MSG = "Magnific'e bağlanılamadı, internet bağlantınızı kontrol edin.";
const noRefresh = async () => {};

async function connect() {
  const p = new FileOAuthProvider({ interactive: true });
  await p.saveClientInformation({ client_id: 'cid' });
  await p.saveTokens({ access_token: 'at', token_type: 'Bearer', refresh_token: 'rt' });
}

function fakeClient(impl: RawMcpClient['callTool']): RawMcpClient {
  return { callTool: vi.fn(impl), close: vi.fn(async () => {}) };
}

describe('parseToolResult', () => {
  it('prefers structuredContent', () => {
    expect(parseToolResult('t', { structuredContent: { a: 1 }, content: [{ type: 'text', text: '{"a":2}' }] })).toEqual({ a: 1 });
  });
  it('parses JSON text content', () => {
    expect(parseToolResult('t2', { content: [{ type: 'text', text: '{"identifier":"x"}' }] })).toEqual({ identifier: 'x' });
  });
  it('wraps non-JSON text', () => {
    expect(parseToolResult('t3', { content: [{ type: 'text', text: 'hello' }] })).toEqual({ text: 'hello' });
  });
  it('maps an isError credit result to the credit message', () => {
    expect(() =>
      parseToolResult('t4', { isError: true, content: [{ type: 'text', text: 'Insufficient credits for this generation' }] }),
    ).toThrow('Magnific krediniz yetersiz.');
  });
  it.each([
    'Insufficient credits for this generation',
    'Not enough credits',
    'You are out of credits',
    'Insufficient balance',
    'Krediniz yetersiz',
    'Payment Required',
    'HTTP 402',
  ])('maps a clear credit shortage (%s) to the credit message', (text) => {
    expect(() => parseToolResult('tc', { isError: true, content: [{ type: 'text', text }] })).toThrow(
      'Magnific krediniz yetersiz.',
    );
  });
  it.each([
    'Invalid credit card token',
    'balance must be between 0 and 1',
    'Insufficient permissions for this model',
    'Credits page could not be loaded',
  ])('does not map unrelated text (%s) to the credit message', (text) => {
    expect(() => parseToolResult('tn', { isError: true, content: [{ type: 'text', text }] })).toThrow(
      /^Magnific hatası: /,
    );
  });
  it('maps an isError auth result to not-connected', () => {
    expect(() => parseToolResult('t5', { isError: true, content: [{ type: 'text', text: 'Unauthorized' }] })).toThrow(
      NOT_CONNECTED_MSG,
    );
  });
  it('maps other isError results to a short Magnific error without URLs', () => {
    expect(() =>
      parseToolResult('t6', { isError: true, content: [{ type: 'text', text: 'Model busy, see https://x.test/secret?sig=1' }] }),
    ).toThrow(/^Magnific hatası: Model busy, see <url>$/);
  });
  it('logs the redacted raw result once per tool', () => {
    const log = vi.mocked(console.log);
    log.mockClear();
    parseToolResult('once', { structuredContent: { url: 'https://cdn/x.jpg', access_token: 'zzz' } });
    parseToolResult('once', { structuredContent: { url: 'https://cdn/y.jpg' } });
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0].join(' ');
    expect(line).toContain('once');
    expect(line).not.toContain('https://cdn');
    expect(line).not.toContain('zzz');
  });
});

describe('redact', () => {
  it('replaces URLs and token-like keys deeply', () => {
    expect(
      redact({ a: 'https://x/y', b: [{ refresh_token: 'r', ok: 'plain' }], proxyUploadUrl: 'https://u', n: 1 }),
    ).toEqual({ a: '<url>', b: [{ refresh_token: '<redacted>', ok: 'plain' }], proxyUploadUrl: '<url>', n: 1 });
  });
});

describe('openMcpSession', () => {
  it('throws not-connected without tokens and never creates a client', async () => {
    const createClient = vi.fn();
    await expect(openMcpSession(1000, { createClient })).rejects.toMatchObject({
      name: 'UserError',
      message: NOT_CONNECTED_MSG,
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it('calls tools with arguments and a timeout, returns parsed data, closes', async () => {
    await connect();
    const client = fakeClient(async () => ({ structuredContent: { ok: true } }));
    const s = await openMcpSession(1000, { createClient: async () => client, refresh: noRefresh });
    expect(await s.callTool('creations_get', { identifiers: ['a'] }, 5000)).toEqual({ ok: true });
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'creations_get', arguments: { identifiers: ['a'] } },
      undefined,
      { timeout: 5000 },
    );
    await s.close();
    expect(client.close).toHaveBeenCalled();
  });

  it('an auth failure while the grant is still stored keeps tokens and reports a connection problem', async () => {
    await connect();
    await expect(
      openMcpSession(1000, {
        refresh: noRefresh,
        createClient: async () => {
          throw new UnauthorizedError();
        },
      }),
    ).rejects.toThrow(CONN_MSG);
    expect(await getMagnificConnection()).toEqual({ connected: true });
  });

  it('an auth failure without a refresh token means not connected and clears tokens', async () => {
    const p = new FileOAuthProvider({ interactive: true });
    await p.saveClientInformation({ client_id: 'cid' });
    await p.saveTokens({ access_token: 'at', token_type: 'Bearer' });
    const s = await openMcpSession(1000, {
      refresh: noRefresh,
      createClient: async () =>
        fakeClient(async () => {
          throw new UnauthorizedError();
        }),
    });
    await expect(s.callTool('images_generate', {}, 1000)).rejects.toThrow(NOT_CONNECTED_MSG);
    expect(await getMagnificConnection()).toEqual({ connected: false });
  });

  it('a 403 keeps the tokens and shows a generic Magnific error', async () => {
    await connect();
    const s = await openMcpSession(1000, {
      refresh: noRefresh,
      createClient: async () =>
        fakeClient(async () => {
          throw new StreamableHTTPError(403, 'Forbidden');
        }),
    });
    await expect(s.callTool('images_generate', {}, 1000)).rejects.toThrow(/^Magnific hatası/);
    expect(await getMagnificConnection()).toEqual({ connected: true });
  });

  it('maps timeouts and network failures to Turkish messages', async () => {
    await connect();
    const s = await openMcpSession(1000, {
      refresh: noRefresh,
      createClient: async () =>
        fakeClient(async (p) => {
          if (p.name === 'slow') throw new McpError(ErrorCode.RequestTimeout, 'Request timed out');
          throw new TypeError('fetch failed');
        }),
    });
    await expect(s.callTool('slow', {}, 1000)).rejects.toThrow('Magnific yanıt vermedi (zaman aşımı).');
    await expect(s.callTool('net', {}, 1000)).rejects.toThrow(CONN_MSG);
    expect(await getMagnificConnection()).toEqual({ connected: true });
  });
});

describe('isTransientError (on the errors a session really throws)', () => {
  const thrown = async (err: unknown) => {
    await connect();
    const s = await openMcpSession(1000, {
      refresh: noRefresh,
      createClient: async () =>
        fakeClient(async () => {
          throw err;
        }),
    });
    return s.callTool('creations_wait', {}, 1000).catch((e) => e);
  };

  it.each([
    ['McpError timeout', new McpError(ErrorCode.RequestTimeout, 'Request timed out')],
    ['network failure', new TypeError('fetch failed')],
    ['abort', new DOMException('aborted', 'AbortError')],
    ['HTTP 429', new StreamableHTTPError(429, 'Too Many Requests')],
    ['HTTP 500', new StreamableHTTPError(500, 'Internal Server Error')],
    ['HTTP 503', new StreamableHTTPError(503, 'Service Unavailable')],
  ])('%s is transient', async (_n, err) => {
    expect(isTransientError(await thrown(err))).toBe(true);
  });

  it.each([
    ['HTTP 403', new StreamableHTTPError(403, 'Forbidden')],
    ['HTTP 404', new StreamableHTTPError(404, 'Not Found')],
    ['McpError invalid params', new McpError(ErrorCode.InvalidParams, 'bad identifier')],
    ['plain Error', new Error('boom')],
  ])('%s is not transient', async (_n, err) => {
    expect(isTransientError(await thrown(err))).toBe(false);
  });

  it('a tool error result and non-UserErrors are not transient', () => {
    let e: unknown;
    try {
      parseToolResult('creations_wait', { isError: true, content: [{ type: 'text', text: 'Creation failed' }] });
    } catch (x) {
      e = x;
    }
    expect(isTransientError(e)).toBe(false);
    expect(isTransientError(new TypeError('fetch failed'))).toBe(false);
  });
});

// Real SDK auth() + FileOAuthProvider against a mocked Keycloak token endpoint.
describe('token refresh preflight', () => {
  const ISSUER = 'https://auth.magnific.com/realms/mcp';
  const TOKEN_URL = `${ISSUER}/protocol/openid-connect/token`;

  async function storedLogin() {
    const p = new FileOAuthProvider({ interactive: true });
    await p.saveDiscoveryState({
      authorizationServerUrl: ISSUER,
      resourceMetadata: { resource: 'https://mcp.magnific.com', authorization_servers: [ISSUER] },
      authorizationServerMetadata: {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: TOKEN_URL,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      },
    });
    await p.saveClientInformation({ client_id: 'cid', issuer: ISSUER } as never);
    await p.saveTokens({ access_token: 'old', refresh_token: 'r1', token_type: 'Bearer', issuer: ISSUER } as never);
    return p;
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  /** Rotating refresh tokens: r1 works once (→ r2); reusing r1 is invalid_grant. */
  function tokenEndpoint(mode: 'rotate' | 'network' | 'invalid_grant' | 'hang') {
    const used: (string | null)[] = [];
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url) !== TOKEN_URL) throw new Error('unexpected fetch ' + String(url));
      const body = new URLSearchParams(String(init?.body));
      used.push(body.get('refresh_token'));
      if (mode === 'network') throw new TypeError('fetch failed');
      if (mode === 'hang') {
        // A hung token endpoint: only the caller's abort signal ends it.
        return new Promise<Response>((_res, rej) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => rej(signal.reason));
        });
      }
      await new Promise((r) => setTimeout(r, 20));
      if (mode === 'invalid_grant' || used.filter((t) => t === 'r1').length > 1) {
        return json({ error: 'invalid_grant', error_description: 'Token is not active' }, 400);
      }
      return json({ access_token: 'new', refresh_token: 'r2', token_type: 'Bearer', expires_in: 3600 });
    });
    return { fetchFn, used };
  }

  it('two concurrent sessions refresh once and both proceed', async () => {
    const p = await storedLogin();
    const { fetchFn, used } = tokenEndpoint('rotate');
    const open = () =>
      openMcpSession(1000, { fetchFn, createClient: async () => fakeClient(async () => ({ structuredContent: {} })) });
    const [a, b] = await Promise.all([open(), open()]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(used).toEqual(['r1']);
    expect(await p.tokens()).toMatchObject({ access_token: 'new', refresh_token: 'r2' });
  });

  it('a network error during refresh keeps the tokens and shows the connection message', async () => {
    const p = await storedLogin();
    const { fetchFn } = tokenEndpoint('network');
    const createClient = vi.fn();
    await expect(openMcpSession(1000, { fetchFn, createClient })).rejects.toThrow(CONN_MSG);
    expect(createClient).not.toHaveBeenCalled();
    expect(await p.tokens()).toMatchObject({ access_token: 'old', refresh_token: 'r1' });
    expect(await getMagnificConnection()).toEqual({ connected: true });
  });

  it('invalid_grant clears the tokens and shows the not-connected message', async () => {
    const p = await storedLogin();
    const { fetchFn } = tokenEndpoint('invalid_grant');
    await expect(openMcpSession(1000, { fetchFn, createClient: vi.fn() })).rejects.toThrow(NOT_CONNECTED_MSG);
    expect(await p.tokens()).toBeUndefined();
    expect(await getMagnificConnection()).toEqual({ connected: false });
    expect(await p.clientInformation()).toMatchObject({ client_id: 'cid' });
  });

  it('a hung token endpoint times out, keeps the tokens and shows the connection message', async () => {
    expect(AUTH_FETCH_TIMEOUT_MS).toBe(30_000);
    const p = await storedLogin();
    const { fetchFn } = tokenEndpoint('hang');
    const createClient = vi.fn();
    const t0 = Date.now();
    await expect(openMcpSession(1000, { fetchFn, createClient, authTimeoutMs: 50 })).rejects.toThrow(CONN_MSG);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(createClient).not.toHaveBeenCalled();
    expect(await p.tokens()).toMatchObject({ access_token: 'old', refresh_token: 'r1' });
  });

  // Mid-session 401: each transport runs the SDK's auth() itself, outside refreshLogin's lock.
  it('parallel refreshes outside the lock: the loser does not delete the winner\'s fresh tokens', async () => {
    await storedLogin();
    const used: string[] = [];
    let r1Uses = 0;
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url) !== TOKEN_URL) throw new Error('unexpected fetch ' + String(url));
      const rt = new URLSearchParams(String(init?.body)).get('refresh_token') ?? '';
      used.push(rt);
      if (rt === 'r1') {
        const first = ++r1Uses === 1;
        // The winner answers first; the loser's reuse of r1 fails later, after r2 is stored.
        await new Promise((r) => setTimeout(r, first ? 10 : 60));
        if (first) return json({ access_token: 'a2', refresh_token: 'r2', token_type: 'Bearer', expires_in: 3600 });
        return json({ error: 'invalid_grant', error_description: 'Token is not active' }, 400);
      }
      if (rt === 'r2') return json({ access_token: 'a3', refresh_token: 'r3', token_type: 'Bearer', expires_in: 3600 });
      return json({ error: 'invalid_grant' }, 400);
    });
    const run = () => auth(new FileOAuthProvider({ interactive: false }), { serverUrl: MCP_SERVER_URL, fetchFn });
    const [a, b] = await Promise.all([run(), run()]);
    expect([a, b]).toEqual(['AUTHORIZED', 'AUTHORIZED']);
    expect(used).toEqual(['r1', 'r1', 'r2']);
    expect(await new FileOAuthProvider({ interactive: false }).tokens()).toMatchObject({ refresh_token: 'r3' });
    expect(await getMagnificConnection()).toEqual({ connected: true });
  });
});

describe('withTimeout', () => {
  it('aborts a hung request after the timeout, except for skipped URLs', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const hang = vi.fn((_url: string | URL, init?: RequestInit) => {
      seen.push(init?.signal ?? undefined);
      return new Promise<Response>((res, rej) => {
        const signal = init?.signal;
        if (!signal) return res(new Response('ok'));
        signal.addEventListener('abort', () => rej(signal.reason));
      });
    });
    const f = withTimeout(hang, 30, (u) => u === MCP_SERVER_URL);
    await expect(f('https://auth.magnific.com/token')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(await (await f(MCP_SERVER_URL)).text()).toBe('ok');
    expect(seen[1]).toBeUndefined();
  });

  it('keeps the caller\'s own abort signal', async () => {
    const ctrl = new AbortController();
    const f = withTimeout(
      (_u, init) =>
        new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason))),
      10_000,
    );
    const p = f('https://auth.magnific.com/token', { signal: ctrl.signal });
    ctrl.abort(new Error('caller'));
    await expect(p).rejects.toThrow('caller');
  });
});
