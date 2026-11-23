import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_ENTRIES, NON_APP_ENTRIES } from '../../scripts/lib/paths.mjs';
import {
  cleanLeftovers, copySeed, fallbackFor, isComplete, isValidId, layout, markComplete, markerState, markRebuilding,
  prune, readCurrent, readVersionMeta, rebuildNeed, recordSeedVersion, removeVersion, resolveVersion, seedId, sourceHash,
  versionDir, versionIdForSha, writeCurrent,
} from '../../scripts/lib/versions.mjs';

const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';
const C = 'cccccccccccc';
const machine = { rootPath: '/x/app', platform: 'darwin', arch: 'arm64' };

let root: string;
const put = (rel: string, content = 'x') => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};
const addVersion = (id: string, completedAt = 1) => {
  put(`.runtime/versions/${id}/package.json`, id);
  markComplete(root, id, { ...machine, nodeMajor: 26, nodeVersion: 'v26.1.0', completedAt });
};
const addIncomplete = (id: string) => put(`.runtime/versions/${id}/package.json`, id);
const versionNames = () => fs.readdirSync(layout(root).versions).sort();

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgs versions ğü-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('version ids', () => {
  it('uses a short id so Windows paths stay under the limit', () => {
    expect(versionIdForSha('a'.repeat(40))).toBe(A);
  });
  it.each(['../evil', 'a/b', '', 'seed-', 'AAAAAAAAAAAA', `${A}x`, '..', 'seed-../x'])('rejects %j', (id) => {
    expect(isValidId(id)).toBe(false);
  });
  it.each([A, `seed-${A}`])('accepts %s', (id) => expect(isValidId(id)).toBe(true));
});

describe('current pointer', () => {
  it('round-trips and leaves no temp file', () => {
    writeCurrent(root, { id: A, previous: B });
    expect(readCurrent(root)).toEqual({ id: A, previous: B });
    expect(fs.readdirSync(layout(root).runtime)).toEqual(['current.json']);
  });
  it('keeps the old pointer when the write fails', () => {
    writeCurrent(root, { id: A, previous: null });
    const blocked = path.join(layout(root).runtime, 'blocked');
    fs.mkdirSync(blocked);
    fs.chmodSync(layout(root).runtime, 0o555);
    try {
      expect(() => writeCurrent(root, { id: B, previous: A })).toThrow();
    } finally {
      fs.chmodSync(layout(root).runtime, 0o755);
    }
    expect(readCurrent(root)).toEqual({ id: A, previous: null });
  });
  it.each(['not json', '{"id":"../../evil"}', '{"id":5}', '[]', ''])('ignores a corrupt pointer: %s', (text) => {
    put('.runtime/current.json', text);
    expect(readCurrent(root)).toBeNull();
  });
  it('drops an invalid previous id', () => {
    put('.runtime/current.json', JSON.stringify({ id: A, previous: '../x' }));
    expect(readCurrent(root)).toEqual({ id: A, previous: null });
  });
});

describe('.complete marker', () => {
  it('a version without the marker does not count', () => {
    addIncomplete(A);
    expect(isComplete(root, A)).toBe(false);
    expect(readVersionMeta(root, A)).toBeNull();
  });
  it('a partial or foreign marker does not count', () => {
    addIncomplete(A);
    put(`.runtime/versions/${A}/.complete`, '{"id":');
    expect(isComplete(root, A)).toBe(false);
    put(`.runtime/versions/${A}/.complete`, JSON.stringify({ id: B }));
    expect(isComplete(root, A)).toBe(false);
  });
  it('records what the build depends on', () => {
    addVersion(A);
    expect(readVersionMeta(root, A)).toMatchObject({ id: A, rootPath: '/x/app', nodeMajor: 26 });
  });
});

describe('resolveVersion', () => {
  it('returns null on a first run', () => expect(resolveVersion(root)).toBeNull());
  it('returns null when only incomplete folders exist', () => {
    addIncomplete(A);
    writeCurrent(root, { id: A, previous: null });
    expect(resolveVersion(root)).toBeNull();
  });
  it('uses a valid current version', () => {
    addVersion(A);
    writeCurrent(root, { id: A, previous: null });
    expect(resolveVersion(root)).toEqual({ id: A, fallback: false });
  });
  it('falls back to previous when current is incomplete', () => {
    addVersion(B);
    addIncomplete(A);
    writeCurrent(root, { id: A, previous: B });
    expect(resolveVersion(root)).toEqual({ id: B, fallback: true, repair: true });
  });
  it('falls back to the newest complete version when the pointer is lost', () => {
    addVersion(A, 1);
    addVersion(B, 2);
    expect(resolveVersion(root)).toEqual({ id: B, fallback: true, repair: true });
  });
  it('never resolves outside the versions folder', () => {
    put('.runtime/current.json', JSON.stringify({ id: '../../evil' }));
    put('evil/.complete', JSON.stringify({ id: '../../evil' }));
    expect(resolveVersion(root)).toBeNull();
  });
});

describe('fallbackFor', () => {
  it('prefers the recorded previous version', () => {
    addVersion(A, 3);
    addVersion(B, 1);
    addVersion(C, 2);
    writeCurrent(root, { id: A, previous: B });
    expect(fallbackFor(root, A)).toBe(B);
  });
  it('uses the newest other complete version otherwise', () => {
    addVersion(A, 3);
    addVersion(C, 2);
    writeCurrent(root, { id: A, previous: null });
    expect(fallbackFor(root, A)).toBe(C);
  });
  it('is null when nothing else is complete', () => {
    addVersion(A);
    addIncomplete(B);
    writeCurrent(root, { id: A, previous: B });
    expect(fallbackFor(root, A)).toBeNull();
  });
});

describe('prune', () => {
  it('keeps exactly the versions asked for', () => {
    addVersion(A);
    addVersion(B);
    addVersion(C);
    prune(root, [A, B]);
    expect(fs.readdirSync(layout(root).versions).sort()).toEqual([A, B]);
  });
  it('removes the marker first, so a half-deleted version is never trusted', () => {
    addVersion(A);
    const dir = versionDir(root, A);
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'f'), 'x');
    fs.chmodSync(path.join(dir, 'sub'), 0o555);
    try {
      expect(removeVersion(root, A)).toBe(false);
      expect(isComplete(root, A)).toBe(false);
    } finally {
      fs.chmodSync(path.join(dir, 'sub'), 0o755);
    }
  });
  it('refuses unsafe ids', () => {
    put('outside/keep.txt', 'keep');
    expect(removeVersion(root, '../../outside')).toBe(false);
    expect(fs.existsSync(path.join(root, 'outside/keep.txt'))).toBe(true);
  });
});

describe('cleanLeftovers', () => {
  it('removes staging and incomplete versions, keeps complete ones and unknown names', () => {
    addVersion(A);
    addIncomplete(B);
    put('.runtime/staging/x/file');
    put('.runtime/versions/not-a-version/file');
    cleanLeftovers(root);
    expect(fs.existsSync(layout(root).staging)).toBe(false);
    expect(fs.readdirSync(layout(root).versions).sort()).toEqual([A, 'not-a-version'].sort());
  });
  it('works on a first run', () => expect(() => cleanLeftovers(root)).not.toThrow());
});

describe('never deletes on doubt (C1)', () => {
  const marker = (id: string) => path.join(versionDir(root, id), '.complete');
  const withUnreadable = (file: string, fn: () => void) => {
    fs.chmodSync(file, 0o000);
    try {
      fn();
    } finally {
      fs.chmodSync(file, 0o644);
    }
  };

  it('tells a read error apart from a missing or invalid marker', () => {
    addVersion(A);
    expect(markerState(root, A)).toBe('valid');
    withUnreadable(marker(A), () => expect(markerState(root, A)).toBe('unreadable'));
    addIncomplete(B);
    expect(markerState(root, B)).toBe('missing');
    put(`.runtime/versions/${C}/.complete`, '{"id":');
    expect(markerState(root, C)).toBe('invalid');
  });

  it('cleanLeftovers keeps a good version whose marker cannot be read', () => {
    addVersion(A);
    withUnreadable(marker(A), () => cleanLeftovers(root));
    expect(isComplete(root, A)).toBe(true);
    expect(fs.existsSync(path.join(versionDir(root, A), 'package.json'))).toBe(true);
  });

  it('removeVersion refuses an unreadable marker', () => {
    addVersion(A);
    withUnreadable(marker(A), () => expect(removeVersion(root, A)).toBe(false));
    expect(isComplete(root, A)).toBe(true);
  });

  it('prune keeps a version whose marker cannot be read', () => {
    addVersion(A);
    addVersion(B);
    withUnreadable(marker(A), () => prune(root, [B]));
    expect(versionNames()).toEqual([A, B]);
  });

  it.each(['id', 'previous'] as const)('cleanup never removes the pointer %s, even when incomplete', (field) => {
    addIncomplete(A);
    addVersion(B);
    writeCurrent(root, field === 'id' ? { id: A, previous: B } : { id: B, previous: A });
    cleanLeftovers(root);
    expect(fs.existsSync(versionDir(root, A))).toBe(true);
    expect(removeVersion(root, A)).toBe(false);
  });

  it('removeVersion honors an explicit protect list', () => {
    addVersion(A);
    expect(removeVersion(root, A, { protect: [A] })).toBe(false);
    expect(isComplete(root, A)).toBe(true);
  });

  it('removes nothing while the pointer itself cannot be read', () => {
    addVersion(A);
    addIncomplete(B);
    writeCurrent(root, { id: A, previous: null });
    withUnreadable(layout(root).current, () => {
      cleanLeftovers(root);
      expect(removeVersion(root, A)).toBe(false);
    });
    expect(versionNames()).toEqual([A, B]);
  });

  it('does not repair a pointer because of a read error', () => {
    addVersion(A);
    addVersion(B);
    writeCurrent(root, { id: A, previous: B });
    withUnreadable(marker(A), () => expect(resolveVersion(root)).toEqual({ id: B, fallback: true, repair: false }));
  });

  it('never writes the pointer while it cannot be read', () => {
    writeCurrent(root, { id: A, previous: B });
    const { ino } = fs.statSync(layout(root).current);
    withUnreadable(layout(root).current, () => {
      expect(() => writeCurrent(root, { id: C, previous: null })).toThrow();
    });
    expect(fs.statSync(layout(root).current).ino).toBe(ino);
    expect(readCurrent(root)).toEqual({ id: A, previous: B });
  });

  it('opens the best complete version without repairing an unreadable pointer', () => {
    addVersion(A, 1);
    addVersion(B, 2);
    writeCurrent(root, { id: A, previous: null });
    withUnreadable(layout(root).current, () => {
      expect(resolveVersion(root)).toEqual({ id: B, fallback: true, repair: false });
    });
  });

  it('a seed built while the pointer is unreadable leaves the pointer alone', () => {
    addVersion(B);
    writeCurrent(root, { id: A, previous: null });
    const { ino } = fs.statSync(layout(root).current);
    withUnreadable(layout(root).current, () => recordSeedVersion(root, B));
    expect(fs.statSync(layout(root).current).ino).toBe(ino);
    expect(readCurrent(root)).toEqual({ id: A, previous: null });
  });

  it('a seed keeps the old pointer as its previous version', () => {
    writeCurrent(root, { id: A, previous: null });
    recordSeedVersion(root, B);
    expect(readCurrent(root)).toEqual({ id: B, previous: A });
    recordSeedVersion(root, B);
    expect(readCurrent(root)).toEqual({ id: B, previous: null });
  });

  it('writeCurrent returns the id it replaced, from its own single read (M1)', () => {
    expect(writeCurrent(root, { id: A, previous: null })).toBeNull();
    const reads = vi.spyOn(fs, 'readFileSync');
    expect(writeCurrent(root, { id: B, previous: (old) => old?.id ?? null })).toBe(A);
    expect(reads.mock.calls.filter(([f]) => f === layout(root).current)).toHaveLength(1);
    reads.mockRestore();
    expect(readCurrent(root)).toEqual({ id: B, previous: A });
  });

  it('a read error inside a seed switch cannot drop the previous version (M1)', () => {
    writeCurrent(root, { id: A, previous: B });
    const bytes = fs.readFileSync(layout(root).current);
    const realRead = fs.readFileSync;
    let pointerReads = 0;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: []) => {
      if (file === layout(root).current && ++pointerReads === 2) throw Object.assign(new Error('disk read error'), { code: 'EIO' });
      return realRead(file, ...rest);
    }) as typeof fs.readFileSync);
    try {
      expect(() => recordSeedVersion(root, C)).toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(layout(root).current).equals(bytes)).toBe(true);
  });

  it('repairs a pointer whose version is confirmed gone', () => {
    addVersion(B);
    writeCurrent(root, { id: A, previous: B });
    expect(resolveVersion(root)).toEqual({ id: B, fallback: true, repair: true });
  });
});

describe('interrupted rebuild after a move (I3)', () => {
  it.each([['build', 'darwin'], ['install', null]] as const)('%s: keeps the marker and forces the rebuild again', (need, platform) => {
    addVersion(A);
    markRebuilding(root, A, need);
    const meta = readVersionMeta(root, A);
    expect(meta).toMatchObject({ id: A, rootPath: null, platform, nodeMajor: 26 });
    expect(rebuildNeed(meta, machine)).toBe(need);
    cleanLeftovers(root);
    expect(isComplete(root, A)).toBe(true);
  });
});

describe('rebuildNeed', () => {
  const meta = { ...machine, id: A, nodeMajor: 26 };
  it('nothing when the machine matches', () => expect(rebuildNeed(meta, machine)).toBe('none'));
  it('builds after the folder moved', () => {
    expect(rebuildNeed(meta, { ...machine, rootPath: '/y/app' })).toBe('build');
  });
  it('treats NFC and NFD spellings of a path as the same folder', () => {
    const m = { ...meta, rootPath: '/x/Stüdyo'.normalize('NFC') };
    expect(rebuildNeed(m, { ...machine, rootPath: '/x/Stüdyo'.normalize('NFD') })).toBe('none');
  });
  it('reinstalls on another OS or CPU', () => {
    expect(rebuildNeed(meta, { ...machine, arch: 'x64' })).toBe('install');
    expect(rebuildNeed(meta, { ...machine, platform: 'win32' })).toBe('install');
  });
});

describe('seed', () => {
  const seedTree = () => {
    put('package.json', '{}');
    put('package-lock.json', '{"lock":1}');
    put('app.config.json', '{}');
    put('next.config.ts', 'x');
    put('tsconfig.json', '{}');
    put('app/page.tsx', 'page');
    put('lib/a.ts', 'a');
    put('public/i.svg', 'i');
    put('config/c.ts', 'c');
    put('components/c.tsx', 'c');
  };

  it('copies only app files: never data, secrets, build output or stray files', () => {
    seedTree();
    for (const rel of ['data/history.json', 'data/magnific-auth.json', '.env.local', 'node_modules/x/i.js',
      '.next/BUILD_ID', '.runtime/launcher.log', 'Kataloglar/buyuk.pdf', 'notes.txt', 'app/.DS_Store']) put(rel);
    const id = seedId(root);
    copySeed(root, id);
    const dir = versionDir(root, id);
    expect(fs.readFileSync(path.join(dir, 'app/page.tsx'), 'utf8')).toBe('page');
    expect(fs.existsSync(path.join(dir, 'package-lock.json'))).toBe(true);
    for (const rel of ['data', '.env.local', 'node_modules', '.next', '.runtime', 'Kataloglar', 'notes.txt', 'app/.DS_Store']) {
      expect(fs.existsSync(path.join(dir, rel))).toBe(false);
    }
  });

  it('ships the native check inside every version', () => {
    seedTree();
    put('scripts/verify-native.mjs', '// check');
    put('scripts/launcher.mjs', '// launcher');
    const id = seedId(root);
    copySeed(root, id);
    expect(fs.existsSync(path.join(versionDir(root, id), 'scripts/verify-native.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(versionDir(root, id), 'scripts/launcher.mjs'))).toBe(false);
  });

  it('does not change the root', () => {
    seedTree();
    const before = fs.readdirSync(root).sort();
    copySeed(root, seedId(root));
    expect(fs.readdirSync(root).filter((n) => n !== '.runtime').sort()).toEqual(before);
  });

  it('never follows a symlink out of the folder', () => {
    seedTree();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mgs-outside-'));
    fs.writeFileSync(path.join(outside, 'secret'), 's');
    fs.symlinkSync(outside, path.join(root, 'lib', 'link'));
    const id = seedId(root);
    copySeed(root, id);
    expect(fs.existsSync(path.join(versionDir(root, id), 'lib/link'))).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('the id depends on app content and the lockfile only', () => {
    seedTree();
    const a = seedId(root);
    expect(a).toMatch(/^seed-[0-9a-f]{12}$/);
    expect(isValidId(a)).toBe(true);
    put('notes.txt', 'stray');
    put('data/x', 'data');
    expect(seedId(root)).toBe(a);
    put('app/page.tsx', 'changed');
    const b = seedId(root);
    expect(b).not.toBe(a);
    put('package-lock.json', '{"lock":2}');
    expect(seedId(root)).not.toBe(b);
  });

  it('sourceHash matches for the same files in another folder', () => {
    seedTree();
    const a = sourceHash(root);
    copySeed(root, seedId(root));
    expect(sourceHash(versionDir(root, seedId(root)))).toBe(a);
  });
});

describe('case-only renames across versions', () => {
  it('are harmless because every version has its own folder', () => {
    put(`.runtime/versions/${A}/lib/Foo.ts`, 'old');
    put(`.runtime/versions/${A}/Components/x.tsx`, 'old');
    markComplete(root, A, { ...machine, nodeMajor: 26, nodeVersion: 'v26.1.0' });
    put(`.runtime/versions/${B}/lib/foo.ts`, 'new');
    put(`.runtime/versions/${B}/components/x.tsx`, 'new');
    markComplete(root, B, { ...machine, nodeMajor: 26, nodeVersion: 'v26.1.0' });
    prune(root, [B]);
    const dir = versionDir(root, B);
    expect(fs.readFileSync(path.join(dir, 'lib/foo.ts'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(dir, 'components/x.tsx'), 'utf8')).toBe('new');
    expect(fs.readdirSync(path.join(dir, 'lib'))).toEqual(['foo.ts']);
  });
});

describe('app file lists', () => {
  const repo = path.resolve(__dirname, '../..');
  it.skipIf(!fs.existsSync(path.join(repo, '.git')))('account for every tracked top-level entry', () => {
    const out = spawnSync('git', ['-c', 'core.quotePath=false', 'ls-files'], { cwd: repo, encoding: 'utf8' }).stdout;
    const top = new Set(out.split('\n').filter(Boolean).map((f) => f.split('/')[0].normalize('NFC')));
    const known = new Set([...APP_ENTRIES, ...NON_APP_ENTRIES].map((f) => f.normalize('NFC')));
    expect([...top].filter((t) => !known.has(t))).toEqual([]);
  });
  it('do not overlap', () => {
    expect(APP_ENTRIES.filter((e: string) => NON_APP_ENTRIES.includes(e))).toEqual([]);
  });
});
