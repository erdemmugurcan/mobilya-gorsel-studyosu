import { findUpload } from '@/lib/images/process';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const upload = await findUpload(id);
    if (!upload) return Response.json({ error: 'Fotoğraf bulunamadı.' }, { status: 404 });
    return Response.json(upload);
  } catch (err) {
    console.error(err);
    return Response.json({ error: 'Fotoğraf yüklenirken bir hata oluştu.' }, { status: 500 });
  }
}
