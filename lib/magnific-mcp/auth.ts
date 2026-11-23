import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  auth,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { readJson, serialize, writeJson } from '@/lib/storage/json-store';
import { AUTH_FETCH_TIMEOUT_MS, baseFetch, withTimeout } from './timed-fetch';

export const MCP_SERVER_URL = 'https://mcp.magnific.com';
// The dev server binds 127.0.0.1, but the registered redirect URI uses the `localhost` host.
export const REDIRECT_URL = 'http://localhost:3000/api/magnific/callback';

const FILE = 'magnific-auth.json';

const CLIENT_METADATA: OAuthClientMetadata = {
  client_name: 'Mobilya Görsel Stüdyosu',
  redirect_uris: [REDIRECT_URL],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

/** Server-side only: holds OAuth tokens. Never send any of this to the browser. */
interface StoredAuth {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
  discoveryState?: OAuthDiscoveryState;
}

const readAuth = (): Promise<StoredAuth> => readJson<StoredAuth>(FILE, {});

function updateAuth(mutate: (s: StoredAuth) => void): Promise<void> {
  return serialize(FILE, async () => {
    const s = await readAuth();
    mutate(s);
    // 0600 from creation: the token file is never readable by others, not even briefly.
    await writeJson(FILE, s, { mode: 0o600 });
  });
}

/**
 * OAuthClientProvider persisted in data/magnific-auth.json.
 * - interactive (connect/callback routes): a login may start; the authorize URL is captured
 *   in `authorizationUrl` for the route to redirect to.
 * - non-interactive (generation): a login is never started, so a pending login's code
 *   verifier/state are left alone and `redirectToAuthorization` throws UnauthorizedError.
 *
 * Token invalidation is compare-and-delete (see `invalidateCredentials`).
 */
export class FileOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  private readonly interactive: boolean;
  /**
   * The refresh token this instance last read or saved (`null` = none stored then;
   * `undefined` = never looked). Lets invalidation tell "my grant died" from "someone else
   * already rotated it".
   */
  private knownRefreshToken: string | null | undefined;

  constructor(opts: { interactive: boolean }) {
    this.interactive = opts.interactive;
  }

  get redirectUrl(): string {
    return REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return CLIENT_METADATA;
  }

  async state(): Promise<string> {
    const s = randomBytes(24).toString('base64url');
    if (this.interactive) await updateAuth((a) => void (a.state = s));
    return s;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return (await readAuth()).clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await updateAuth((a) => void (a.clientInformation = info));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const t = (await readAuth()).tokens;
    this.knownRefreshToken = t?.refresh_token ?? null;
    return t;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await updateAuth((a) => void (a.tokens = tokens));
    this.knownRefreshToken = tokens.refresh_token ?? null;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.interactive) throw new UnauthorizedError('Magnific login required');
    this.authorizationUrl = url;
  }

  async saveCodeVerifier(v: string): Promise<void> {
    if (this.interactive) await updateAuth((a) => void (a.codeVerifier = v));
  }

  async codeVerifier(): Promise<string> {
    const v = (await readAuth()).codeVerifier;
    if (!v) throw new Error('No saved OAuth code verifier');
    return v;
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await readAuth()).discoveryState;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await updateAuth((a) => void (a.discoveryState = state));
  }

  /**
   * Compare-and-delete for 'tokens' and 'all': when the stored refresh token is no longer the
   * one this instance last read or saved, another session already rotated it (a parallel
   * refresh outside the single-flight lock, e.g. the transport's own 401 handling). This
   * instance's invalid_grant then only means its copy was stale, so the fresh login is kept
   * and the SDK's retry reads it.
   */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    await updateAuth((a) => {
      if (scope === 'all' || scope === 'tokens') {
        const stored = a.tokens?.refresh_token ?? null;
        if (this.knownRefreshToken !== undefined && stored !== this.knownRefreshToken) return;
      }
      if (scope === 'all') {
        for (const k of Object.keys(a)) delete a[k as keyof StoredAuth];
        return;
      }
      if (scope === 'client') delete a.clientInformation;
      if (scope === 'tokens') delete a.tokens;
      if (scope === 'verifier') delete a.codeVerifier;
      if (scope === 'discovery') delete a.discoveryState;
    });
  }
}

/** Connected = an access token is stored (the SDK refreshes it when it expires). */
export async function getMagnificConnection(): Promise<{ connected: boolean }> {
  const a = await readAuth();
  return { connected: typeof a.tokens?.access_token === 'string' && a.tokens.access_token.length > 0 };
}

export type AuthFn = typeof auth;

export interface ConnectOpts {
  /** fetch for the OAuth requests (tests); always wrapped with a timeout. */
  fetchFn?: FetchLike;
  /** Per OAuth request; defaults to AUTH_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

const timedFetch = (opts: ConnectOpts): FetchLike =>
  withTimeout(opts.fetchFn ?? baseFetch, opts.timeoutMs ?? AUTH_FETCH_TIMEOUT_MS);

/**
 * Starts the OAuth flow (discovery, dynamic registration once, PKCE). Returns the Magnific
 * authorize URL, or `null` when already authorized (e.g. a stored refresh token still works).
 */
export async function startConnect(
  authFn: AuthFn = auth,
  opts: ConnectOpts = {},
): Promise<{ redirect: string | null }> {
  const provider = new FileOAuthProvider({ interactive: true });
  const result = await authFn(provider, { serverUrl: MCP_SERVER_URL, fetchFn: timedFetch(opts) });
  if (result === 'REDIRECT') {
    if (!provider.authorizationUrl) throw new Error('OAuth redirect without an authorization URL');
    return { redirect: provider.authorizationUrl.toString() };
  }
  return { redirect: null };
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Callback: checks `state`, exchanges the code for tokens, then forgets verifier and state. */
export async function finishConnect(
  code: string,
  state: string | null,
  authFn: AuthFn = auth,
  opts: ConnectOpts = {},
): Promise<void> {
  const saved = (await readAuth()).state;
  if (!saved || !state || !sameString(saved, state)) throw new Error('OAuth state mismatch');
  const provider = new FileOAuthProvider({ interactive: true });
  try {
    const result = await authFn(provider, {
      serverUrl: MCP_SERVER_URL,
      authorizationCode: code,
      fetchFn: timedFetch(opts),
    });
    if (result !== 'AUTHORIZED') throw new Error(`OAuth code exchange returned ${result}`);
  } finally {
    await updateAuth((a) => {
      delete a.codeVerifier;
      delete a.state;
    });
  }
}
