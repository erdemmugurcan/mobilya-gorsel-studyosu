import { describe, expect, it } from 'vitest';
import { foldKey, isPreserved, toRel } from '../../scripts/lib/paths.mjs';

describe('toRel', () => {
  it('normalizes safe paths', () => {
    expect(toRel('./app/page.tsx')).toBe('app/page.tsx');
    expect(toRel('app\\page.tsx')).toBe('app/page.tsx');
  });
  it.each(['', '/etc/passwd', '\\\\srv\\x', 'C:\\x', 'c:x', '../x', 'a/../../x', 'a/..', 'a\0b'])(
    'rejects %j', (p) => expect(toRel(p)).toBeNull(),
  );
});

describe('isPreserved', () => {
  it.each([
    'data/history.json', 'data/magnific-auth.json', '.runtime/node/bin/node', '.env.local',
    'node_modules/next/package.json', '.next/BUILD_ID', '.git/config',
    'DATA/x', 'Node_Modules/x', '.ENV.LOCAL', 'sub/.env.local',
  ])('keeps %s', (p) => expect(isPreserved(p)).toBe(true));
  it.each(['app/page.tsx', 'database/x.ts', 'README.md', 'scripts/launcher.mjs', 'app/data/x.ts', '.env.local.example', 'newsletter.txt'])(
    'allows %s', (p) => expect(isPreserved(p)).toBe(false),
  );
});

describe('filesystem aliases', () => {
  it.each([
    'node_module\u017F/x/keep.js', // long s
    'DATA/x',
    'd\u0041ta/x',
    'data\u200D/x', // ignorable character (HFS+)
    '.g\u200Cit/config',
    '\uFF44ata/x', // full-width d
    '.env.loca\u217C', // small roman numeral fifty, NFKC "l"
  ])('treats %j as preserved', (p) => {
    const rel = toRel(p);
    expect(rel).not.toBeNull();
    expect(isPreserved(rel!)).toBe(true);
  });

  it.each(['NODE_M~1/x', '.RUNTI~1/x', 'ENV~1.LOC', 'DATA~1/x', 'a/NEXT~12/b', 'data\uFF0E/x', 'a\uFF0Fb/../c', '\uFF0E\uFF0E/x'])(
    'rejects short-name or disguised segment %j', (p) => expect(toRel(p)).toBeNull(),
  );

  it.each([
    'CON', 'con', 'PRN', 'AUX', 'NUL', 'nul.txt', 'COM1', 'com9.log', 'LPT1', 'lpt9.tar.gz',
    'lib/aux.ts', 'a/NUL/b.txt', 'app/Con.tsx', 'COM\u00B9', 'nu\u200Dl.txt',
  ])('rejects the Windows device name %j', (p) => expect(toRel(p)).toBeNull());

  it.each(['console.ts', 'auxiliary/x.ts', 'null.ts', 'com10.txt', 'lpt.txt', 'com0.txt', 'prnt.ts', 'a/contact.tsx'])(
    'keeps the ordinary name %s', (p) => expect(toRel(p)).toBe(p),
  );

  it('keeps ordinary names with a tilde', () => {
    expect(toRel('docs/a~b.md')).toBe('docs/a~b.md');
  });

  it('gives case and Unicode variants one key', () => {
    expect(foldKey('lib/Foo.ts')).toBe(foldKey('lib/foo.ts'));
    expect(foldKey('Mobilya St\u00FCdyo.bat')).toBe(foldKey('MOBILYA STU\u0308DYO.BAT'));
    expect(foldKey('lib/foo.ts')).not.toBe(foldKey('lib/bar.ts'));
  });
});
