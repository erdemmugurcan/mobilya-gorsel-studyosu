import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GET } from '@/app/api/files/[...path]/route';

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mgs-files-'));
  process.env.DATA_DIR = dir;
  for (const sub of ['uploads', 'cutouts', 'outputs', 'design']) {
    await fs.mkdir(path.join(dir, sub), { recursive: true });
  }
  await fs.writeFile(path.join(dir, 'uploads/x.jpg'), 'jpegbytes');
  await fs.writeFile(path.join(dir, 'uploads/x.json'), '{"a":1}');
  await fs.writeFile(path.join(dir, 'outputs/x.jpg'), 'outbytes');
  await fs.writeFile(path.join(dir, 'cutouts/c.png'), 'pngbytes');
  await fs.writeFile(path.join(dir, 'magnific-auth.json'), '{"tokens":"fake"}');
  await fs.writeFile(path.join(dir, 'history.json'), '[]');
  await fs.writeFile(path.join(dir, 'spaces.json'), '[]');
  await fs.writeFile(path.join(dir, 'design/yonler.html'), '<html></html>');
  await fs.writeFile(path.join(path.dirname(dir), 'secret.txt'), 'secret');
  await fs.writeFile(path.join(path.dirname(dir), 'package.json'), '{}');
});

const call = (segments: string[]) =>
  GET(new Request('http://localhost/api/files/' + segments.join('/')), {
    params: Promise.resolve({ path: segments }),
  });

describe('GET /api/files', () => {
  it.each([
    [['..', 'package.json']],
    [['%2e%2e', 'package.json']],
    [['%2E%2E', 'package.json']],
    [['..%2fpackage.json']],
    [['%2e%2e%2fpackage.json']],
    [['uploads', '..', '..', 'package.json']],
    [['uploads', '%2e%2e', '%2e%2e', 'package.json']],
    [['outputs', '..%2f..%2fpackage.json']],
    [['', 'etc', 'passwd']],
    [['/etc/passwd']],
    [['..', 'secret.txt']],
    [['uploads', 'missing.jpg']],
    [['magnific-auth.json']],
    [['history.json']],
    [['spaces.json']],
    [['design', 'yonler.html']],
    [['uploads', 'x.json']],
    [['uploads', '..', 'magnific-auth.json']],
    [['outputs', '%2e%2e', 'magnific-auth.json']],
    [['uploads']],
    [['%ZZ']],
  ])('404 for %j', async (segments) => {
    expect((await call(segments)).status).toBe(404);
  });

  it('serves a real upload with content type and nosniff', async () => {
    const res = await call(['uploads', 'x.jpg']);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('jpegbytes');
  });

  it('serves a real output jpg with nosniff', async () => {
    const res = await call(['outputs', 'x.jpg']);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('outbytes');
  });

  it('serves a cutout png', async () => {
    const res = await call(['cutouts', 'c.png']);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });
});
