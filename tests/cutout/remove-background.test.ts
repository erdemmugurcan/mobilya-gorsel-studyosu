import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createCutout, findCutout } from '@/lib/cutout/remove-background';
import { saveUpload, UserError } from '@/lib/images/process';
import { dataPath } from '@/lib/storage/paths';

beforeEach(async () => {
  process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'mgs-cut-'));
});

async function fixture(): Promise<Buffer> {
  const square = await sharp({
    create: { width: 200, height: 200, channels: 3, background: '#4a2e1a' },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width: 600, height: 400, channels: 3, background: '#ffffff' } })
    .composite([{ input: square, left: 200, top: 100 }])
    .png()
    .toBuffer();
}

describe('createCutout', () => {
  it(
    'removes the background, trims margins and persists a sidecar',
    async () => {
      const upload = await saveUpload(await fixture(), 'product');
      const info = await createCutout(upload.id);

      expect(info.sourceUploadId).toBe(upload.id);
      expect(info.width).toBeGreaterThanOrEqual(180);
      expect(info.width).toBeLessThanOrEqual(240);
      expect(info.height).toBeGreaterThanOrEqual(180);
      expect(info.height).toBeLessThanOrEqual(240);

      const { data, info: raw } = await sharp(dataPath(info.file))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(raw.width).toBe(info.width);
      expect(raw.height).toBe(info.height);
      const alphaAt = (x: number, y: number) => data[(y * raw.width + x) * 4 + 3];
      expect(alphaAt(0, 0)).toBeLessThan(10);
      expect(alphaAt(Math.floor(raw.width / 2), Math.floor(raw.height / 2))).toBeGreaterThan(245);

      expect(await findCutout(info.id)).toEqual(info);
    },
    120_000,
  );

  it('rejects an unknown upload id', async () => {
    await expect(createCutout('nope')).rejects.toThrow(UserError);
    await expect(createCutout('nope')).rejects.toThrow('Fotoğraf bulunamadı');
  });

  it('findCutout returns null for unknown or malformed ids', async () => {
    expect(await findCutout('missing')).toBeNull();
    expect(await findCutout('../x')).toBeNull();
  });
});
