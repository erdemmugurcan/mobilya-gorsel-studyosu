import { getGeneration } from '@/lib/storage/history';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const record = await getGeneration(id);
    if (!record) return Response.json({ error: 'Kayıt bulunamadı.' }, { status: 404 });
    return Response.json(record);
  } catch (err) {
    console.error(err);
    return Response.json({ error: 'Kayıt yüklenirken bir hata oluştu.' }, { status: 500 });
  }
}
