import fs from 'node:fs/promises';
import path from 'node:path';

export const DATA_SUBDIRS = ['uploads', 'cutouts', 'outputs'] as const;

export function dataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

export function dataPath(rel: string): string {
  return path.join(/*turbopackIgnore: true*/ dataDir(), rel);
}

export async function ensureDataDirs(): Promise<void> {
  await Promise.all(
    DATA_SUBDIRS.map((d) => fs.mkdir(dataPath(d), { recursive: true })),
  );
}
