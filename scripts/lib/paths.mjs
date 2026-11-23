// Which archive entries may enter a version folder. Everything here compares case-insensitively
// because Windows and default macOS volumes treat `Data/` and `data/` as the same folder.
export const STUB_FILES = ['Mobilya Stüdyo.command', 'Mobilya Stüdyo.bat'];

// What the first version is built from. An allowlist, so a user's own files in the folder are
// never copied. A test fails if a new tracked top-level entry is in neither list.
export const APP_ENTRIES = [
  'app', 'components', 'config', 'lib', 'public',
  'app.config.json', 'next.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json',
  'scripts/verify-native.mjs',
];
// Tracked, but with no effect on the built app.
export const NON_APP_ENTRIES = [
  ...STUB_FILES, 'scripts', 'tests', 'docs', 'README.md', 'AGENTS.md', 'eslint.config.mjs',
  'vitest.config.mts', '.env.local.example', '.gitignore', '.gitattributes',
];

const PRESERVED_DIRS = new Set(['data', '.runtime', 'node_modules', '.next', '.git']);
// Characters HFS+ ignores in names, so `data<ZWJ>` can be the same folder as `data`.
const IGNORABLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
// 8.3 short names such as NODE_M~1 or ENV~1.LOC reach the long-named file on Windows.
const SHORT_NAME = /~\d+(?:\.[^.]*)?$/;
// Windows opens a device instead of a file for these names, with or without an extension.
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

// One key for every spelling a case-insensitive filesystem may treat as the same name.
export const foldKey = (rel) =>
  rel.replace(/\\/g, '/').normalize('NFKC').replace(IGNORABLE, '').toUpperCase().toLowerCase().normalize('NFKC');

// A safe app-relative POSIX path, or null. Windows ignores trailing dots/spaces in a segment
// and treats `:` as a stream separator, so those could otherwise alias a preserved path.
export function toRel(input) {
  if (typeof input !== 'string' || input === '' || input.includes('\0')) return null;
  const posix = input.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) return null;
  const parts = [];
  for (const seg of posix.split('/')) {
    if (seg === '' || seg === '.') continue;
    const plain = seg.normalize('NFKC').replace(IGNORABLE, '');
    if (plain === '..' || /[:/\\]/.test(plain) || /[. ]$/.test(plain) || SHORT_NAME.test(plain) || DEVICE_NAME.test(plain)) return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

export function isPreserved(rel) {
  const segments = foldKey(rel).split('/');
  return PRESERVED_DIRS.has(segments[0]) || segments[segments.length - 1] === '.env.local';
}
