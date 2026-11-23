import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { GET } from '@/app/api/cutouts/[id]/route';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mgs-cutget-'));
  process.env.DATA_DIR = dir;
  await fs.mkdir(path.join(dir, 'cutouts'), { recursive: true });
});

const call = (id: string) =>
  GET(new Request('http://localhost/api/cutouts/' + encodeURIComponent(id)), {
    params: Promise.resolve({ id }),
  });

describe('GET /api/cutouts/[id]', () => {
  it('returns the cutout info for a known id', async () => {
    const id = crypto.randomUUID();
    const png = await sharp({
      create: { width: 64, height: 48, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } },
    })
      .png()
      .toBuffer();
    await fs.writeFile(path.join(dir, `cutouts/${id}.png`), png);
    await fs.writeFile(path.join(dir, `cutouts/${id}.json`), JSON.stringify({ sourceUploadId: 'src-1' }));
    const res = await call(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id,
      sourceUploadId: 'src-1',
      file: `cutouts/${id}.png`,
      width: 64,
      height: 48,
    });
  });

  it('404 for an unknown id', async () => {
    const res = await call(crypto.randomUUID());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Ürün fotoğrafı bulunamadı.' });
  });

  it.each(['../history', '..%2Fx', 'a b', '/etc/passwd', ''])('404 for malformed id %j', async (id) => {
    expect((await call(id)).status).toBe(404);
  });
});
