import { startConnect } from '@/lib/magnific-mcp/auth';

const CROSS_SITE_MSG =
  'Magnific bağlantısı yalnızca uygulamanın kendi sayfasından başlatılabilir. Uygulamayı açıp "Magnific ile bağlan" düğmesine basın.';

// Starts the Magnific OAuth login: 302 to Magnific's authorize page.
export async function GET(req: Request): Promise<Response> {
  // CSRF: another site must not start (or silently re-run) a login. Browsers send
  // Sec-Fetch-Site; same-origin (our button) and none (typed URL/bookmark) are fine.
  const site = req.headers.get('sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') {
    return new Response(CROSS_SITE_MSG, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  try {
    const { redirect } = await startConnect();
    return Response.redirect(redirect ?? new URL('/?magnific=baglandi', req.url), 302);
  } catch (err) {
    console.error('Magnific bağlantısı başlatılamadı:', err instanceof Error ? err.message : err);
    return Response.redirect(new URL('/?magnific=hata', req.url), 302);
  }
}
