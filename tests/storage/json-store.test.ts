import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson } from '@/lib/storage/json-store';
import { dataPath } from '@/lib/storage/paths';

beforeEach(async () => {
  process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'mgs-json-'));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const modeOf = async (p: string) => (await fs.stat(p)).mode & 0o777;

describe('writeJson', () => {
  it('round-trips through readJson', async () => {
    await writeJson('a.json', { x: 1 });
    expect(await readJson('a.json', null)).toEqual({ x: 1 });
  });

  it('with a mode, the temp file already has that mode before it is renamed into place', async () => {
    const seen: number[] = [];
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      seen.push(await modeOf(String(from)));
      return rename(from, to);
    });
    await writeJson('secret.json', { t: 1 }, { mode: 0o600 });
    expect(seen).toEqual([0o600]);
    expect(await modeOf(dataPath('secret.json'))).toBe(0o600);
  });

  it('replacing an existing 0644 file leaves it 0600', async () => {
    await writeJson('secret.json', { t: 0 });
    await fs.chmod(dataPath('secret.json'), 0o644);
    await writeJson('secret.json', { t: 1 }, { mode: 0o600 });
    expect(await modeOf(dataPath('secret.json'))).toBe(0o600);
    expect(await readJson('secret.json', null)).toEqual({ t: 1 });
  });
});
