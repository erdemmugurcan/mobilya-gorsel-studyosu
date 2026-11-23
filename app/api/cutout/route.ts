import { createCutout } from '@/lib/cutout/remove-background';
import { UserError } from '@/lib/images/process';
import type { Box } from '@/lib/types';

function parseBox(v: unknown): Box | undefined {
  if (v == null) return undefined;
  const b = v as Record<string, unknown>;
  const ok = ['x', 'y', 'w', 'h'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k]));
  if (!ok) throw new UserError('Seçilen alan geçersiz.');
  return { x: b.x as number, y: b.y as number, w: b.w as number, h: b.h as number };
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => null)) as { uploadId?: unknown; box?: unknown } | null;
    if (!body || typeof body.uploadId !== 'string') {
      throw new UserError('Fotoğraf bulunamadı, lütfen tekrar yükleyin.');
    }
    const info = await createCutout(body.uploadId, parseBox(body.box));
    return Response.json(info);
  } catch (err) {
    if (err instanceof UserError) return Response.json({ error: err.message }, { status: 400 });
    console.error(err);
    return Response.json({ error: 'Ürün kesilirken bir hata oluştu.' }, { status: 500 });
  }
}
