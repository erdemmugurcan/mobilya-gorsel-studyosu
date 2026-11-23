import { findCutout } from '@/lib/cutout/remove-background';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const cutout = await findCutout(id);
    if (!cutout) return Response.json({ error: 'Ürün fotoğrafı bulunamadı.' }, { status: 404 });
    return Response.json(cutout);
  } catch (err) {
    console.error(err);
    return Response.json({ error: 'Ürün fotoğrafı yüklenirken bir hata oluştu.' }, { status: 500 });
  }
}
