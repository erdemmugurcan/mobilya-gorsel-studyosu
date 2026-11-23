import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listSpaces, saveSpace } from '@/lib/storage/spaces';
import type { UploadInfo } from '@/lib/types';

beforeEach(async () => {
  process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'mgs-spaces-'));
});

describe('spaces', () => {
  it('saves a space and lists it', async () => {
    expect(await listSpaces()).toEqual([]);
    const upload: UploadInfo = {
      id: 'u1', kind: 'space', file: 'uploads/u1.jpg', width: 1000, height: 800,
    };
    const space = await saveSpace('Salon', upload);
    expect(space.name).toBe('Salon');
    expect(space.uploadId).toBe('u1');
    const list = await listSpaces();
    expect(list).toHaveLength(1);
    expect(list[0].file).toBe(upload.file);
    expect(list[0].id).toBe(space.id);
  });
});
