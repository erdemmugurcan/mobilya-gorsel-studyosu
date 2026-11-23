import { beforeEach, describe, expect, it, vi } from 'vitest';

const { startConnect, finishConnect, getMagnificConnection } = vi.hoisted(() => ({
  startConnect: vi.fn(),
  finishConnect: vi.fn(),
  getMagnificConnection: vi.fn(),
}));
vi.mock('@/lib/magnific-mcp/auth', () => ({ startConnect, finishConnect, getMagnificConnection }));

import { GET as status } from '@/app/api/magnific/status/route';
import { GET as connect } from '@/app/api/magnific/connect/route';
import { GET as callback } from '@/app/api/magnific/callback/route';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const loc = (r: Response) => r.headers.get('location');

describe('/api/magnific', () => {
  it('status returns { connected } only', async () => {
    getMagnificConnection.mockResolvedValue({ connected: true });
    const r = await status();
    expect(await r.json()).toEqual({ connected: true });
  });

  it('connect 302s to the authorize URL', async () => {
    startConnect.mockResolvedValue({ redirect: 'https://auth.magnific.com/realms/mcp/protocol/openid-connect/auth?x=1' });
    const r = await connect(new Request('http://localhost:3000/api/magnific/connect'));
    expect(r.status).toBe(302);
    expect(loc(r)).toBe('https://auth.magnific.com/realms/mcp/protocol/openid-connect/auth?x=1');
  });

  it('connect when already authorized goes home connected; on error with hata', async () => {
    startConnect.mockResolvedValue({ redirect: null });
    let r = await connect(new Request('http://localhost:3000/api/magnific/connect'));
    expect(loc(r)).toBe('http://localhost:3000/?magnific=baglandi');
    startConnect.mockRejectedValue(new Error('discovery failed'));
    r = await connect(new Request('http://localhost:3000/api/magnific/connect'));
    expect(r.status).toBe(302);
    expect(loc(r)).toBe('http://localhost:3000/?magnific=hata');
  });

  it('connect rejects a cross-site request with 403 and a Turkish message, without starting a login', async () => {
    const r = await connect(
      new Request('http://localhost:3000/api/magnific/connect', { headers: { 'sec-fetch-site': 'cross-site' } }),
    );
    expect(r.status).toBe(403);
    expect(r.headers.get('content-type')).toMatch(/text\/plain; charset=utf-8/);
    expect(await r.text()).toMatch(/uygulamanın kendi sayfasından/);
    expect(startConnect).not.toHaveBeenCalled();
  });

  it.each(['same-origin', 'none'])('connect works with Sec-Fetch-Site: %s', async (site) => {
    startConnect.mockResolvedValue({ redirect: 'https://auth.magnific.com/a' });
    const r = await connect(
      new Request('http://localhost:3000/api/magnific/connect', { headers: { 'sec-fetch-site': site } }),
    );
    expect(r.status).toBe(302);
    expect(loc(r)).toBe('https://auth.magnific.com/a');
  });

  it('callback exchanges the code and redirects', async () => {
    finishConnect.mockResolvedValue(undefined);
    const r = await callback(new Request('http://localhost:3000/api/magnific/callback?code=abc&state=s1'));
    expect(finishConnect).toHaveBeenCalledWith('abc', 's1');
    expect(r.status).toBe(302);
    expect(loc(r)).toBe('http://localhost:3000/?magnific=baglandi');
  });

  it('callback without code, with error, or failing exchange redirects with hata', async () => {
    let r = await callback(new Request('http://localhost:3000/api/magnific/callback?error=access_denied'));
    expect(loc(r)).toBe('http://localhost:3000/?magnific=hata');
    expect(finishConnect).not.toHaveBeenCalled();
    finishConnect.mockRejectedValue(new Error('bad'));
    r = await callback(new Request('http://localhost:3000/api/magnific/callback?code=abc&state=s'));
    expect(loc(r)).toBe('http://localhost:3000/?magnific=hata');
  });
});
