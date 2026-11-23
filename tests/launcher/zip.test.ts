import { describe, expect, it } from 'vitest';
import { readZip, stripTopDir } from '../../scripts/lib/zip.mjs';
import { makeZip } from './zip-fixture';

describe('readZip', () => {
  it('reads stored and deflated entries with modes and UTF-8 names', () => {
    const zip = makeZip([
      { name: 'r-abc/' },
      { name: 'r-abc/a.txt', data: 'merhaba', stored: true },
      { name: 'r-abc/Mobilya Stüdyo.command', data: 'x'.repeat(500), mode: 0o100755 },
    ]);
    const out = readZip(zip);
    expect(out.map((e: { name: string }) => e.name)).toEqual(['r-abc/', 'r-abc/a.txt', 'r-abc/Mobilya Stüdyo.command']);
    expect(out[0].isDir).toBe(true);
    expect(out[1].data.toString()).toBe('merhaba');
    expect(out[2].data.length).toBe(500);
    expect(out[2].mode & 0o111).toBe(0o111);
  });
  it('flags symlinks', () => {
    expect(readZip(makeZip([{ name: 'l', data: 'target', mode: 0o120777 }]))[0].isSymlink).toBe(true);
  });
  it('rejects garbage and corrupted data', () => {
    expect(() => readZip(Buffer.from('not a zip at all, sorry, not one'))).toThrow();
    const bad = makeZip([{ name: 'a.txt', data: 'hello', stored: true }]);
    bad[35] ^= 0xff; // inside the stored body
    expect(() => readZip(bad)).toThrow();
  });
});

describe('inflated size limits (M4)', () => {
  it('rejects an archive whose total size is over the limit', () => {
    const zip = makeZip([{ name: 'a.txt', data: 'x'.repeat(100) }, { name: 'b.txt', data: 'y'.repeat(100) }]);
    expect(() => readZip(zip, { maxTotalBytes: 150 })).toThrow();
    expect(readZip(zip, { maxTotalBytes: 200 })).toHaveLength(2);
  });
  it('never inflates past the size an entry declares', () => {
    const zip = makeZip([{ name: 'bomb.txt', data: 'z'.repeat(1_000_000) }]);
    // Central directory "uncompressed size" lies: 10 bytes.
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(10, central + 24);
    expect(() => readZip(zip)).toThrow();
  });
  it('still reads an empty file', () => {
    expect(readZip(makeZip([{ name: 'empty.txt', data: '' }]))[0].data.length).toBe(0);
  });
});

describe('stripTopDir', () => {
  it('removes the shared archive folder', () => {
    const out = stripTopDir(readZip(makeZip([{ name: 'r-abc/' }, { name: 'r-abc/x/a.txt', data: '1' }])));
    expect(out.map((e: { path: string }) => e.path)).toEqual(['', 'x/a.txt']);
  });
  it('fails when there is no single top folder', () => {
    expect(() => stripTopDir(readZip(makeZip([{ name: 'a/x', data: '1' }, { name: 'b/y', data: '2' }])))).toThrow();
  });
});
