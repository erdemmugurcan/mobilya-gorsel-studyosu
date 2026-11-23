import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { GET } from '@/app/api/uploads/[id]/route';
import { saveUpload } from '@/lib/images/process';

beforeEach(async () => {
  process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'mgs-upget-'));
});

const call = (id: string) =>
  GET(new Request('http://localhost/api/uploads/' + encodeURIComponent(id)), {
    params: Promise.resolve({ id }),
  });

describe('GET /api/uploads/[id]', () => {
  it('returns the upload info for a known id', async () => {
    const buf = await sharp({
      create: { width: 120, height: 80, channels: 3, background: '#a0a0a0' },
    })
      .jpeg()
      .toBuffer();
    const info = await saveUpload(buf, 'space');
    const res = await call(info.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: info.id,
      kind: 'space',
      file: `uploads/${info.id}.jpg`,
      width: 120,
      height: 80,
    });
  });

  it('404 for an unknown id', async () => {
    const res = await call(crypto.randomUUID());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Fotoğraf bulunamadı.' });
  });

  it.each(['../history', '..%2Fx', 'a b', '/etc/passwd', ''])('404 for malformed id %j', async (id) => {
    expect((await call(id)).status).toBe(404);
  });
});
