import { startGeneration } from '@/lib/jobs/runner';
import { UserError } from '@/lib/images/process';
import type { GenerationRequest } from '@/lib/types';

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => null)) as GenerationRequest | null;
    // The runner validates the request (products, photos, aspect, …).
    if (!body || typeof body !== 'object') throw new UserError('Geçersiz istek.');
    const record = await startGeneration(body);
    return Response.json(record, { status: 202 });
  } catch (err) {
    if (err instanceof UserError) return Response.json({ error: err.message }, { status: 400 });
    console.error(err);
    return Response.json({ error: 'Üretim başlatılırken bir hata oluştu.' }, { status: 500 });
  }
}
