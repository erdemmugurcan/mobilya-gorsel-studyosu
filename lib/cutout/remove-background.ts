import fs from 'node:fs/promises';
import { imglyRemoveBackground, sharp } from '@/lib/native-modules';
import { cropToBox, findUpload, UserError } from '@/lib/images/process';
import { dataPath, ensureDataDirs } from '@/lib/storage/paths';
import { readJson, writeJson } from '@/lib/storage/json-store';
import type { Box, CutoutInfo } from '@/lib/types';

const ID_PATTERN = /^[A-Za-z0-9-]+$/;

/** Returns a PNG with an alpha channel. Runs fully locally (model weights ship with the package). */
export async function removeBackground(input: Buffer): Promise<Buffer> {
  const blob = await imglyRemoveBackground(new Blob([new Uint8Array(input)], { type: 'image/png' }), {
    output: { format: 'image/png' },
  });
  return Buffer.from(await blob.arrayBuffer());
}

export async function createCutout(uploadId: string, box?: Box): Promise<CutoutInfo> {
  const upload = await findUpload(uploadId);
  if (!upload) throw new UserError('Fotoğraf bulunamadı, lütfen tekrar yükleyin.');

  const source = box
    ? await cropToBox(dataPath(upload.file), box)
    : await sharp(dataPath(upload.file)).png().toBuffer();
  const cut = await removeBackground(source);
  const { data, info } = await sharp(cut).trim().png().toBuffer({ resolveWithObject: true });

  await ensureDataDirs();
  const id = crypto.randomUUID();
  const file = `cutouts/${id}.png`;
  await fs.writeFile(dataPath(file), data);
  await writeJson(`cutouts/${id}.json`, { sourceUploadId: uploadId });
  return { id, sourceUploadId: uploadId, file, width: info.width, height: info.height };
}

export async function findCutout(id: string): Promise<CutoutInfo | null> {
  if (!ID_PATTERN.test(id)) return null;
  const file = `cutouts/${id}.png`;
  try {
    const meta = await sharp(dataPath(file)).metadata();
    const side = await readJson<{ sourceUploadId?: string }>(`cutouts/${id}.json`, {});
    return {
      id,
      sourceUploadId: side.sourceUploadId ?? '',
      file,
      width: meta.width!,
      height: meta.height!,
    };
  } catch {
    return null;
  }
}
