import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  cropToBox,
  findUpload,
  saveUpload,
  toReferenceBase64,
  UserError,
} from '@/lib/images/process';
import { dataPath } from '@/lib/storage/paths';

beforeEach(async () => {
  process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'mgs-img-'));
});

const jpeg = (w: number, h: number, orientation?: number) => {
  let s = sharp({
    create: { width: w, height: h, channels: 3, background: '#808080' },
  }).jpeg();
  if (orientation) s = s.withMetadata({ orientation });
  return s.toBuffer();
};

describe('saveUpload', () => {
  it('applies EXIF rotation and findUpload returns the same info', async () => {
    const info = await saveUpload(await jpeg(3000, 4000, 6), 'product');
    expect(info.width).toBe(4000);
    expect(info.height).toBe(3000);
    expect(info.kind).toBe('product');
    expect(await findUpload(info.id)).toEqual(info);
    const meta = await sharp(dataPath(info.file)).metadata();
    expect([meta.width, meta.height]).toEqual([4000, 3000]);
  });

  it('downsizes so the long side is 4096', async () => {
    const info = await saveUpload(await jpeg(6000, 4000), 'space');
    expect(info.width).toBe(4096);
    expect(info.file.endsWith('.jpg')).toBe(true);
  });

  it('keeps alpha as png', async () => {
    const png = await sharp({
      create: { width: 50, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();
    const info = await saveUpload(png, 'product');
    expect(info.file.endsWith('.png')).toBe(true);
  });

  it('rejects HEIC with the exact message', async () => {
    const buf = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(32)]);
    await expect(saveUpload(buf, 'product')).rejects.toThrow(
      'HEIC desteklenmiyor, lütfen JPG veya PNG yükleyin.',
    );
    await expect(saveUpload(buf, 'product')).rejects.toBeInstanceOf(UserError);
  });

  it('rejects non-image data with a UserError', async () => {
    await expect(saveUpload(Buffer.from('hello'), 'product')).rejects.toBeInstanceOf(UserError);
  });
});

describe('cropToBox', () => {
  it('crops a normalized box', async () => {
    const info = await saveUpload(await jpeg(1000, 800), 'product');
    const out = await cropToBox(dataPath(info.file), { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([500, 400]);
  });

  it('does not re-encode the JPEG: cropped pixels equal the source region', async () => {
    const w = 400, h = 300;
    const raw = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      const v = (i * 7919) % 2 ? 255 : 0; // noisy high-frequency pattern
      raw[i * 3] = v;
      raw[i * 3 + 1] = 255 - v;
      raw[i * 3 + 2] = (i * 31) % 256;
    }
    const src = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
      .toBuffer();
    const file = dataPath('uploads/hf.jpg');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, src);
    const out = await cropToBox(file, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    const got = await sharp(out).removeAlpha().raw().toBuffer();
    const want = await sharp(file)
      .extract({ left: 100, top: 75, width: 200, height: 150 })
      .removeAlpha()
      .raw()
      .toBuffer();
    expect(got.equals(want)).toBe(true);
  });

  it('throws when the clamped crop is too small', async () => {
    const info = await saveUpload(await jpeg(1000, 800), 'product');
    await expect(
      cropToBox(dataPath(info.file), { x: 0.99, y: 0.99, w: 0.5, h: 0.5 }),
    ).rejects.toThrow('Seçilen alan çok küçük.');
  });
});

describe('toReferenceBase64', () => {
  it('flattens transparent PNG to JPEG with long side <= 2048', async () => {
    const png = await sharp({
      create: { width: 3000, height: 1000, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();
    const file = dataPath('uploads/t.png');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, png);
    const b64 = await toReferenceBase64(file);
    const meta = await sharp(Buffer.from(b64, 'base64')).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.hasAlpha).toBe(false);
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(2048);
    const { data } = await sharp(Buffer.from(b64, 'base64')).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240); // flattened on white
  });
});
