import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { imglyRemoveBackground, sharp } from '@/lib/native-modules';

const root = path.resolve(__dirname, '../..');

function sources(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return sources(rel);
    return /\.tsx?$/.test(e.name) ? [rel] : [];
  });
}

describe('native packages', () => {
  it('are never imported as values by app code, so the build creates no symlinks', () => {
    const offenders = ['app', 'lib', 'components', 'config'].flatMap(sources).filter((f) => {
      if (f === 'lib/native-modules.ts') return false;
      const text = fs.readFileSync(path.join(root, f), 'utf8');
      return /^import\s+(?!type\b)[^;]*from\s+['"](sharp|@imgly\/background-removal-node|onnxruntime-node)['"]/m.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('still load and work through the wrapper', async () => {
    const png = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#fff' } }).png().toBuffer();
    expect((await sharp(png).metadata()).height).toBe(3);
    expect(typeof imglyRemoveBackground).toBe('function');
  });
});
