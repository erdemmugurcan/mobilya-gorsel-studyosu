import fs from 'node:fs/promises';
import type { OutputInfo } from 'sharp';
import { sharp } from '@/lib/native-modules';
import { dataPath, ensureDataDirs } from '@/lib/storage/paths';
import { readJson, writeJson } from '@/lib/storage/json-store';
import type { Box, UploadInfo, UploadKind } from '@/lib/types';

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

const MAX_UPLOAD_SIDE = 4096;
const MAX_REFERENCE_SIDE = 2048;
const MIN_CROP_PX = 32;
const ID_PATTERN = /^[A-Za-z0-9-]+$/;

function isHeic(buf: Buffer): boolean {
  if (buf.length < 12 || buf.toString('latin1', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('latin1', 8, 12);
  return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand);
}

export async function saveUpload(buf: Buffer, kind: UploadKind): Promise<UploadInfo> {
  if (isHeic(buf)) {
    throw new UserError('HEIC desteklenmiyor, lütfen JPG veya PNG yükleyin.');
  }
  let out: { data: Buffer; info: OutputInfo };
  let ext: 'jpg' | 'png';
  try {
    const meta = await sharp(buf).metadata();
    ext = meta.hasAlpha ? 'png' : 'jpg';
    const pipeline = sharp(buf)
      .rotate()
      .resize({
        width: MAX_UPLOAD_SIDE,
        height: MAX_UPLOAD_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      });
    out = await (ext === 'png' ? pipeline.png() : pipeline.jpeg({ quality: 92 })).toBuffer({
      resolveWithObject: true,
    });
  } catch {
    throw new UserError('Görsel okunamadı, lütfen JPG veya PNG yükleyin.');
  }

  await ensureDataDirs();
  const id = crypto.randomUUID();
  const file = `uploads/${id}.${ext}`;
  await fs.writeFile(dataPath(file), out.data);
  await writeJson(`uploads/${id}.json`, { kind });
  return { id, kind, file, width: out.info.width, height: out.info.height };
}

export async function findUpload(id: string): Promise<UploadInfo | null> {
  if (!ID_PATTERN.test(id)) return null;
  for (const ext of ['jpg', 'png']) {
    const file = `uploads/${id}.${ext}`;
    try {
      const meta = await sharp(dataPath(file)).metadata();
      const side = await readJson<{ kind?: UploadKind }>(`uploads/${id}.json`, {});
      return {
        id,
        kind: side.kind ?? 'product',
        file,
        width: meta.width!,
        height: meta.height!,
      };
    } catch {
      // not this extension; try the next one
    }
  }
  return null;
}

export async function cropToBox(file: string, box: Box): Promise<Buffer> {
  // saveUpload already normalised orientation, so no rotate and no re-encode here.
  const info = await sharp(file).metadata();
  const imgW = info.width!;
  const imgH = info.height!;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const left = Math.round(clamp(box.x, 0, 1) * imgW);
  const top = Math.round(clamp(box.y, 0, 1) * imgH);
  const right = Math.round(clamp(box.x + box.w, 0, 1) * imgW);
  const bottom = Math.round(clamp(box.y + box.h, 0, 1) * imgH);
  const width = right - left;
  const height = bottom - top;
  if (width < MIN_CROP_PX || height < MIN_CROP_PX) {
    throw new UserError('Seçilen alan çok küçük.');
  }
  return sharp(file).extract({ left, top, width, height }).png().toBuffer();
}

export async function toReferenceBase64(
  file: string,
  opts?: { flattenOn?: string },
): Promise<string> {
  const buf = await sharp(file)
    .rotate()
    .resize({
      width: MAX_REFERENCE_SIDE,
      height: MAX_REFERENCE_SIDE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: opts?.flattenOn ?? '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer();
  return buf.toString('base64');
}
