import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  FileOAuthProvider,
  finishConnect,
  getMagnificConnection,
  MCP_SERVER_URL,
  REDIRECT_URL,
  startConnect,
} from '@/lib/magnific-mcp/auth';
import { dataPath } from '@/lib/storage/paths';

beforeEach(async () => {
  process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'mgs-mcpauth-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const stored = async () => JSON.parse(await fs.readFile(dataPath('magnific-auth.json'), 'utf8'));

describe('FileOAuthProvider', () => {
  it('has the fixed public-client metadata and redirect URL', () => {
    const p = new FileOAuthProvider({ interactive: true });
    expect(REDIRECT_URL).toBe('http://localhost:3000/api/magnific/callback');
    expect(MCP_SERVER_URL).toBe('https://mcp.magnific.com');
    expect(String(p.redirectUrl)).toBe(REDIRECT_URL);
    expect(p.clientMetadata).toEqual({
      client_name: 'Mobilya Görsel Stüdyosu',
      redirect_uris: ['http://localhost:3000/api/magnific/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('round-trips client info, tokens and code verifier through data/magnific-auth.json', async () => {
    const p = new FileOAuthProvider({ interactive: true });
    expect(await p.clientInformation()).toBeUndefined();
    expect(await p.tokens()).toBeUndefined();
    await p.saveClientInformation({ client_id: 'cid', issuer: 'https://auth.magnific.com/realms/mcp' } as never);
    await p.saveTokens({ access_token: 'at', token_type: 'Bearer', refresh_token: 'rt' });
    await p.saveCodeVerifier('ver');
    const fresh = new FileOAuthProvider({ interactive: false });
    expect(await fresh.clientInformation()).toMatchObject({ client_id: 'cid' });
    expect(await fresh.tokens()).toMatchObject({ access_token: 'at', refresh_token: 'rt' });
    expect(await fresh.codeVerifier()).toBe('ver');
    expect(await stored()).toMatchObject({ clientInformation: { client_id: 'cid' }, tokens: { access_token: 'at' } });
    const mode = (await fs.stat(dataPath('magnific-auth.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('interactive: captures the authorization URL and persists state', async () => {
    const p = new FileOAuthProvider({ interactive: true });
    const s = await p.state();
    expect(s.length).toBeGreaterThan(10);
    await p.redirectToAuthorization(new URL('https://auth.magnific.com/x?y=1'));
    expect(p.authorizationUrl?.toString()).toBe('https://auth.magnific.com/x?y=1');
    expect((await stored()).state).toBe(s);
  });

  it('non-interactive: never starts a login and leaves a pending login untouched', async () => {
    const i = new FileOAuthProvider({ interactive: true });
    await i.saveCodeVerifier('pending');
    const s = await i.state();
    const p = new FileOAuthProvider({ interactive: false });
    await p.state();
    await p.saveCodeVerifier('other');
    await expect(p.redirectToAuthorization(new URL('https://auth.magnific.com/x'))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(await stored()).toMatchObject({ codeVerifier: 'pending', state: s });
  });

  it('invalidateCredentials clears the requested part', async () => {
    const p = new FileOAuthProvider({ interactive: true });
    await p.saveClientInformation({ client_id: 'cid' });
    await p.saveTokens({ access_token: 'at', token_type: 'Bearer' });
    await p.invalidateCredentials('tokens');
    expect(await p.tokens()).toBeUndefined();
    expect(await p.clientInformation()).toMatchObject({ client_id: 'cid' });
    await p.invalidateCredentials('all');
    expect(await p.clientInformation()).toBeUndefined();
  });

  it('invalidateCredentials is compare-and-delete: tokens rotated by someone else survive', async () => {
    const setup = new FileOAuthProvider({ interactive: true });
    await setup.saveClientInformation({ client_id: 'cid' });
    await setup.saveTokens({ access_token: 'a1', token_type: 'Bearer', refresh_token: 'r1' });

    const loser = new FileOAuthProvider({ interactive: false });
    expect((await loser.tokens())?.refresh_token).toBe('r1');
    // Another session rotates the refresh token meanwhile.
    await new FileOAuthProvider({ interactive: false }).saveTokens({ access_token: 'a2', token_type: 'Bearer', refresh_token: 'r2' });

    await loser.invalidateCredentials('tokens');
    expect(await stored()).toMatchObject({ tokens: { refresh_token: 'r2' }, clientInformation: { client_id: 'cid' } });
    await loser.invalidateCredentials('all');
    expect(await stored()).toMatchObject({ tokens: { refresh_token: 'r2' }, clientInformation: { client_id: 'cid' } });

    // Once it has read the current tokens, it may delete them.
    await loser.tokens();
    await loser.invalidateCredentials('tokens');
    expect((await stored()).tokens).toBeUndefined();
  });

  it('invalidateCredentials deletes tokens this instance saved itself', async () => {
    const p = new FileOAuthProvider({ interactive: false });
    await p.saveTokens({ access_token: 'a', token_type: 'Bearer', refresh_token: 'mine' });
    await p.invalidateCredentials('tokens');
    expect((await stored()).tokens).toBeUndefined();
  });

  it('writes data/magnific-auth.json with mode 0600 from creation (no chmod afterwards)', async () => {
    const chmod = vi.spyOn(fs, 'chmod');
    const p = new FileOAuthProvider({ interactive: true });
    await p.saveClientInformation({ client_id: 'cid' });
    expect((await fs.stat(dataPath('magnific-auth.json'))).mode & 0o777).toBe(0o600);
    expect(chmod).not.toHaveBeenCalled();
    chmod.mockRestore();
  });
});

describe('getMagnificConnection', () => {
  it('is connected only with a stored access token', async () => {
    expect(await getMagnificConnection()).toEqual({ connected: false });
    const p = new FileOAuthProvider({ interactive: true });
    await p.saveClientInformation({ client_id: 'cid' });
    expect(await getMagnificConnection()).toEqual({ connected: false });
    await p.saveTokens({ access_token: 'at', token_type: 'Bearer' });
    expect(await getMagnificConnection()).toEqual({ connected: true });
  });
});

describe('startConnect / finishConnect', () => {
  it('startConnect returns the captured authorize URL', async () => {
    const authFn = vi.fn(async (provider: FileOAuthProvider, opts: { serverUrl: string }) => {
      expect(opts.serverUrl).toBe(MCP_SERVER_URL);
      await provider.state();
      await provider.redirectToAuthorization(new URL('https://auth.magnific.com/realms/mcp/auth?a=1'));
      return 'REDIRECT' as const;
    });
    expect(await startConnect(authFn as never)).toEqual({
      redirect: 'https://auth.magnific.com/realms/mcp/auth?a=1',
    });
  });

  it('startConnect reports already-authorized', async () => {
    expect(await startConnect((async () => 'AUTHORIZED') as never)).toEqual({ redirect: null });
  });

  it('finishConnect exchanges the code when state matches, then clears verifier and state', async () => {
    const p = new FileOAuthProvider({ interactive: true });
    await p.saveCodeVerifier('ver');
    const s = await p.state();
    const authFn = vi.fn(async (provider: FileOAuthProvider, opts: { serverUrl: string; authorizationCode: string }) => {
      expect(await provider.codeVerifier()).toBe('ver');
      await provider.saveTokens({ access_token: 'at', token_type: 'Bearer' });
      expect(opts).toMatchObject({ serverUrl: MCP_SERVER_URL, authorizationCode: 'code1' });
      return 'AUTHORIZED' as const;
    });
    await finishConnect('code1', s, authFn as never);
    expect(authFn).toHaveBeenCalledOnce();
    const st = await stored();
    expect(st.codeVerifier).toBeUndefined();
    expect(st.state).toBeUndefined();
    expect(await getMagnificConnection()).toEqual({ connected: true });
  });

  // These tests run the real SDK auth(): forbid the global fetch so nothing can ever reach
  // the real Magnific servers, even if the injected fetchFn were ignored.
  const noNetwork = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network disabled in tests');
      }),
    );

  // A fetch that never answers unless its signal aborts (a hung auth server).
  const hungFetch = () =>
    vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          const signal = init?.signal;
          signal?.addEventListener('abort', () => rej(signal.reason));
        }),
    );
  const settlesWithin = <T,>(p: Promise<T>, ms: number) =>
    Promise.race([
      p.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise((r) => setTimeout(() => r('hung'), ms)),
    ]);

  it('startConnect gives the real SDK auth() a timed fetch: a hung auth server fails instead of spinning', async () => {
    noNetwork();
    const fetchFn = hungFetch();
    const p = startConnect(auth, { fetchFn, timeoutMs: 30 });
    expect(await settlesWithin(p, 3000)).toBe('rejected');
    expect(fetchFn).toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    for (const [, init] of fetchFn.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('finishConnect gives the real SDK auth() a timed fetch and still clears verifier and state', async () => {
    const p = new FileOAuthProvider({ interactive: true });
    await p.saveCodeVerifier('ver');
    const s = await p.state();
    noNetwork();
    const fetchFn = hungFetch();
    const run = finishConnect('code1', s, auth, { fetchFn, timeoutMs: 30 });
    expect(await settlesWithin(run, 3000)).toBe('rejected');
    expect(fetchFn).toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const st = await stored();
    expect(st.codeVerifier).toBeUndefined();
    expect(st.state).toBeUndefined();
  });

  it('startConnect and finishConnect pass a fetchFn to auth() by default', async () => {
    const seen: unknown[] = [];
    const authFn = vi.fn(async (_p: FileOAuthProvider, opts: { fetchFn?: unknown }) => {
      seen.push(opts.fetchFn);
      return 'AUTHORIZED' as const;
    });
    await startConnect(authFn as never);
    const prov = new FileOAuthProvider({ interactive: true });
    await finishConnect('c', await prov.state(), authFn as never);
    expect(seen).toHaveLength(2);
    for (const f of seen) expect(typeof f).toBe('function');
  });

  it('finishConnect rejects a mismatched or missing state without exchanging', async () => {
    const p = new FileOAuthProvider({ interactive: true });
    await p.state();
    const authFn = vi.fn();
    await expect(finishConnect('code1', 'wrong', authFn as never)).rejects.toThrow();
    await expect(finishConnect('code1', null, authFn as never)).rejects.toThrow();
    expect(authFn).not.toHaveBeenCalled();
  });
});
