import { readJson, serialize, writeJson } from './json-store';
import type { SavedSpace, UploadInfo } from '@/lib/types';

const FILE = 'spaces.json';

export function saveSpace(name: string, upload: UploadInfo): Promise<SavedSpace> {
  return serialize(FILE, async () => {
    const spaces = await readJson<SavedSpace[]>(FILE, []);
    const space: SavedSpace = {
      id: crypto.randomUUID(),
      name,
      uploadId: upload.id,
      file: upload.file,
      createdAt: new Date().toISOString(),
    };
    spaces.push(space);
    await writeJson(FILE, spaces);
    return space;
  });
}

export async function listSpaces(): Promise<SavedSpace[]> {
  const spaces = await readJson<SavedSpace[]>(FILE, []);
  return spaces.slice().reverse();
}
