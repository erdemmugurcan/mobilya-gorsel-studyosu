import { finishConnect } from '@/lib/magnific-mcp/auth';

// OAuth redirect target (http://localhost:3000/api/magnific/callback?code=…&state=…).
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const home = (result: 'baglandi' | 'hata') => Response.redirect(new URL(`/?magnific=${result}`, req.url), 302);
  if (!code || url.searchParams.has('error')) {
    console.error('Magnific girişi tamamlanmadı:', url.searchParams.get('error') ?? 'kod yok');
    return home('hata');
  }
  try {
    await finishConnect(code, url.searchParams.get('state'));
    return home('baglandi');
  } catch (err) {
    console.error('Magnific girişi tamamlanamadı:', err instanceof Error ? err.message : err);
    return home('hata');
  }
}
