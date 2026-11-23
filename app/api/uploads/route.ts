import { saveUpload, UserError } from '@/lib/images/process';
import type { UploadKind } from '@/lib/types';

export async function POST(req: Request): Promise<Response> {
  try {
    const form = await req.formData();
    const file = form.get('file');
    const kind = form.get('kind');
    if (!(file instanceof File)) throw new UserError('Dosya seçilmedi.');
    if (kind !== 'product' && kind !== 'space') throw new UserError('Geçersiz yükleme türü.');
    const info = await saveUpload(Buffer.from(await file.arrayBuffer()), kind as UploadKind);
    return Response.json(info);
  } catch (err) {
    if (err instanceof UserError) return Response.json({ error: err.message }, { status: 400 });
    console.error(err);
    return Response.json({ error: 'Yükleme sırasında bir hata oluştu.' }, { status: 500 });
  }
}
