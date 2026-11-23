import { findUpload, UserError } from '@/lib/images/process';
import { listSpaces, saveSpace } from '@/lib/storage/spaces';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await listSpaces());
  } catch (err) {
    console.error(err);
    return Response.json({ error: 'Mekânlar yüklenirken bir hata oluştu.' }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => null)) as { name?: unknown; uploadId?: unknown } | null;
    if (!body || typeof body.uploadId !== 'string') {
      throw new UserError('Fotoğraf bulunamadı, lütfen tekrar yükleyin.');
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw new UserError('Lütfen mekâna bir ad verin.');
    const upload = await findUpload(body.uploadId);
    if (!upload) throw new UserError('Fotoğraf bulunamadı, lütfen tekrar yükleyin.');
    return Response.json(await saveSpace(name, upload));
  } catch (err) {
    if (err instanceof UserError) return Response.json({ error: err.message }, { status: 400 });
    console.error(err);
    return Response.json({ error: 'Mekân kaydedilirken bir hata oluştu.' }, { status: 500 });
  }
}
