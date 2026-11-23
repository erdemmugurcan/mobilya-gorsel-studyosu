import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  archiveUrl, commitsUrl, isPlaceholderRepo, markInterrupted, MAX_ATTEMPTS, MAX_INTERRUPTED, MIN_FREE_BYTES,
  parseConfig, prepareUpdate, readCappedBody, readUpdateState, updateNotice,
} from '../../scripts/lib/update.mjs';
import {
  layout, markComplete, readCurrent, resolveVersion, sourceHash, versionDir, versionIdForSha, writeCurrent,
} from '../../scripts/lib/versions.mjs';
import { freeBytes } from '../../scripts/lib/fsutil.mjs';
import { makeZip, type FixtureEntry } from './zip-fixture';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);
const ID_A = versionIdForSha(SHA_A);
const ID_B = versionIdForSha(SHA_B);
const ID_C = versionIdForSha(SHA_C);
const CONFIG = { repo: 'acme/mobilya', branch: 'main', nodeMajor: 26, minLauncher: 1 };
const LAUNCHER = 1;

const appFiles = (over: Record<string, string | null> = {}) => {
  const merged: Record<string, string | null> = {
    'package.json': '{"name":"mgs"}',
    'package-lock.json': '{"lockfileVersion":3}',
    'app.config.json': JSON.stringify(CONFIG),
    'next.config.ts': 'export default {}',
    'tsconfig.json': '{}',
    'app/page.tsx': 'page v2',
    'lib/util.ts': 'util',
    ...over,
  };
  return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null)) as Record<string, string>;
};

const entriesOf = (files: Record<string, string>): FixtureEntry[] => [
  { name: 'r/' },
  ...Object.entries(files).map(([name, data]) => ({ name: `r/${name}`, data })),
];

const archive = (sha: string, entries: FixtureEntry[]) =>
  makeZip(entries.map((e) => ({ ...e, name: e.name.replace(/^r\//, `r-${sha}/`) })));

const fakeFetch = (sha: string, entries: FixtureEntry[] = entriesOf(appFiles())) => {
  const zip = archive(sha, entries);
  return vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u === commitsUrl(CONFIG.repo, CONFIG.branch)) return Response.json({ sha });
    if (u === archiveUrl(CONFIG.repo, sha)) return new Response(new Uint8Array(zip));
    throw new Error(`unexpected ${u}`);
  });
};

const downloads = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.filter(([u]) => String(u).startsWith('https://codeload.github.com/')).length;

let root: string;
let machine: { rootPath: string; platform: string; arch: string };
const put = (rel: string, content = 'x') => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};

// Every file with its content hash, so "unchanged" means byte-identical.
function treeHash(dir: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip(r)) continue;
      if (e.isDirectory()) walk(r);
      else out[r] = createHash('sha256').update(fs.readFileSync(path.join(dir, r))).digest('hex');
    }
  };
  walk('');
  return out;
}
const rootTree = () => treeHash(root, (r) => r === '.runtime');

function installVersion(id: string, sha: string | null = null, extra: Record<string, unknown> = {}) {
  put(`.runtime/versions/${id}/package.json`, `{"v":"${id}"}`);
  put(`.runtime/versions/${id}/app/page.tsx`, `page ${id}`);
  put(`.runtime/versions/${id}/node_modules/next/package.json`, '{}');
  put(`.runtime/versions/${id}/.next/BUILD_ID`, id);
  markComplete(root, id, { ...machine, sha, nodeMajor: 26, nodeVersion: 'v26.1.0', ...extra });
}

const okOps = () => ({
  ensureNode: vi.fn(async () => '/fake/node'),
  install: vi.fn(async ({ dir }: { dir: string }) => {
    fs.mkdirSync(path.join(dir, 'node_modules/next'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/next/package.json'), '{}');
  }),
  build: vi.fn(async ({ dir }: { dir: string }) => {
    fs.mkdirSync(path.join(dir, '.next'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.next/BUILD_ID'), 'built');
  }),
  smoke: vi.fn(async () => {}),
  verifyNative: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
});

type Ops = ReturnType<typeof okOps>;
const run = (fetchImpl: unknown, ops: Partial<Ops> = {}, over: Record<string, unknown> = {}) => prepareUpdate({
  root, config: CONFIG, launcherVersion: LAUNCHER, runningId: readCurrent(root)?.id ?? ID_A, machine, fetchImpl,
  ops: { ...okOps(), ...ops }, freeSpace: () => MIN_FREE_BYTES * 2, ...over,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgs update ğü-'));
  machine = { rootPath: root, platform: 'darwin', arch: 'arm64' };
  put('package.json', '{"name":"root"}');
  put('app/page.tsx', 'root page');
  put('Mobilya Stüdyo.command', '#!/bin/bash');
  put('data/history.json', '[1,2,3]');
  put('data/magnific-auth.json', '{"tokens":"secret"}');
  put('.env.local', 'K=1');
  installVersion(ID_A, SHA_A);
  writeCurrent(root, { id: ID_A, previous: null });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('config', () => {
  it.each(['OWNER/REPO', 'owner/repo', '', undefined, 'no-slash', 'a/b/c', 'a b/c', '../..', '../x', 'x/..', 'x/.', './x', '-a/b', 'a-/b', 'a_b/c', 'a/b?x=1', 'a/b#c', 'a/b%2f', `${'a'.repeat(40)}/b`, `a/${'b'.repeat(101)}`])('placeholder or invalid: %s', (r) => {
    expect(isPlaceholderRepo(r)).toBe(true);
  });
  it('accepts a real repo', () => expect(isPlaceholderRepo('acme/mobilya.app')).toBe(false));
  it('defaults the branch and minLauncher, requires nodeMajor', () => {
    expect(parseConfig('{"repo":"a/b","nodeMajor":26}')).toMatchObject({ branch: 'main', minLauncher: 1 });
    expect(() => parseConfig('{"repo":"a/b"}')).toThrow();
  });
  it.each(['"2"', '0', '-1', '1.5'])('rejects minLauncher %s', (v) => {
    expect(() => parseConfig(`{"repo":"a/b","nodeMajor":26,"minLauncher":${v}}`)).toThrow();
  });
});

describe('gates', () => {
  it('skips the placeholder without any network call', async () => {
    const f = vi.fn();
    const r = await run(f, {}, { config: { ...CONFIG, repo: 'OWNER/REPO' } });
    expect(r.status).toBe('skipped');
    expect(f).not.toHaveBeenCalled();
  });
  it('does not download when already current', async () => {
    const f = fakeFetch(SHA_A);
    expect((await run(f)).status).toBe('up-to-date');
    expect(downloads(f)).toBe(0);
  });
  it('a failed check costs no attempt and records nothing bad', async () => {
    const before = fs.readFileSync(layout(root).current);
    const r = await run(vi.fn(async () => { throw new Error('offline'); }));
    expect(r).toMatchObject({ status: 'check-failed', kind: 'offline' });
    expect(readUpdateState(root).attempts).toEqual({});
    expect(fs.readFileSync(layout(root).current).equals(before)).toBe(true);
  });
  it.each([403, 404, 500])('HTTP %i from the check is not an attempt', async (status) => {
    const r = await run(vi.fn(async () => new Response('x', { status })));
    expect(r.status).toBe('check-failed');
    expect(readUpdateState(root).attempts).toEqual({});
  });
  it('rejects a malformed sha', async () => {
    expect((await run(vi.fn(async () => Response.json({ sha: 'zzz' })))).status).toBe('check-failed');
  });
});

describe('a good update', () => {
  it('installs side by side and moves the pointer last', async () => {
    const order: string[] = [];
    const ops = okOps();
    ops.install.mockImplementation(async () => { order.push(`install:${readCurrent(root)!.id}`); });
    ops.build.mockImplementation(async () => { order.push(`build:${readCurrent(root)!.id}`); });
    ops.smoke.mockImplementation(async () => { order.push(`smoke:${readCurrent(root)!.id}`); });
    const r = await run(fakeFetch(SHA_B), ops);
    expect(r).toMatchObject({ status: 'ready', sha: SHA_B, id: ID_B });
    expect(order).toEqual([`install:${ID_A}`, `build:${ID_A}`, `smoke:${ID_A}`]);
    expect(readCurrent(root)).toEqual({ id: ID_B, previous: ID_A });
    expect(fs.existsSync(path.join(versionDir(root, ID_B), '.complete'))).toBe(true);
    expect(fs.existsSync(layout(root).staging) && fs.readdirSync(layout(root).staging).length).toBeFalsy();
  });

  it('never modifies the root or data/', async () => {
    const before = rootTree();
    const ops = okOps();
    expect((await run(fakeFetch(SHA_B), ops)).status).toBe('ready');
    expect(rootTree()).toEqual(before);
  });

  it('does not touch the running version', async () => {
    const before = treeHash(versionDir(root, ID_A));
    await run(fakeFetch(SHA_B));
    expect(treeHash(versionDir(root, ID_A))).toEqual(before);
  });

  it('keeps exactly two versions: new and the one that was running', async () => {
    await run(fakeFetch(SHA_B));
    const changed = entriesOf(appFiles({ 'app/page.tsx': 'page v3' }));
    await run(fakeFetch(SHA_C, changed), {}, { runningId: ID_B });
    expect(fs.readdirSync(layout(root).versions).sort()).toEqual([ID_B, ID_C].sort());
    expect(readCurrent(root)).toEqual({ id: ID_C, previous: ID_B });
  });

  it('never deletes the version actually running after a fallback', async () => {
    installVersion(ID_B, SHA_B);
    writeCurrent(root, { id: ID_B, previous: ID_A });
    await run(fakeFetch(SHA_C), {}, { runningId: ID_A });
    expect(readCurrent(root)).toEqual({ id: ID_C, previous: ID_A });
    // B may only have hit a temporary read error, so it stays until the next update.
    expect(fs.readdirSync(layout(root).versions).sort()).toEqual([ID_A, ID_B, ID_C].sort());
  });

  it('switches to a complete version already on disk without rebuilding', async () => {
    installVersion(ID_B, SHA_B);
    const ops = okOps();
    const f = fakeFetch(SHA_B);
    expect((await run(f, ops)).status).toBe('ready');
    expect(ops.build).not.toHaveBeenCalled();
    expect(downloads(f)).toBe(0);
    expect(readCurrent(root)).toEqual({ id: ID_B, previous: ID_A });
  });

  it('keeps a good version on disk when switching back to it fails', async () => {
    installVersion(ID_B, SHA_B);
    const before = treeHash(versionDir(root, ID_B));
    // A folder where the temp file must go makes only the pointer write fail.
    fs.mkdirSync(`${layout(root).current}.${process.pid}.tmp`);
    const r = await run(fakeFetch(SHA_B));
    fs.rmdirSync(`${layout(root).current}.${process.pid}.tmp`);
    expect(r.status).toBe('failed');
    expect(readCurrent(root)!.id).toBe(ID_A);
    expect(treeHash(versionDir(root, ID_B))).toEqual(before);
  });

  it('replaces an incomplete leftover of the same version', async () => {
    put(`.runtime/versions/${ID_B}/stale.txt`, 'partial');
    expect((await run(fakeFetch(SHA_B))).status).toBe('ready');
    expect(fs.existsSync(path.join(versionDir(root, ID_B), 'stale.txt'))).toBe(false);
  });

  it('records the commit and source hash in the marker', async () => {
    await run(fakeFetch(SHA_B));
    const meta = JSON.parse(fs.readFileSync(path.join(versionDir(root, ID_B), '.complete'), 'utf8'));
    expect(meta).toMatchObject({ id: ID_B, sha: SHA_B, nodeMajor: 26, rootPath: root });
    expect(typeof meta.sourceHash).toBe('string');
  });

  it('prepares another Node major side by side and builds with it', async () => {
    const ops = okOps();
    ops.ensureNode.mockResolvedValue('/fake/node24');
    const files = appFiles({ 'app.config.json': JSON.stringify({ ...CONFIG, nodeMajor: 24 }) });
    expect((await run(fakeFetch(SHA_B, entriesOf(files)), ops)).status).toBe('ready');
    expect(ops.ensureNode).toHaveBeenCalledWith(24);
    expect(ops.install.mock.calls[0][0]).toMatchObject({ exec: '/fake/node24' });
    expect(ops.build.mock.calls[0][0]).toMatchObject({ exec: '/fake/node24' });
    expect(JSON.parse(fs.readFileSync(path.join(versionDir(root, ID_B), '.complete'), 'utf8')).nodeMajor).toBe(24);
  });
});

describe('a failed update changes nothing', () => {
  const failing = (step: 'ensureNode' | 'install' | 'build' | 'smoke' | 'verifyNative' | 'flush') => {
    const ops = okOps();
    ops[step].mockImplementation(async () => { throw new Error(`${step} failed`); });
    return ops;
  };

  it.each(['ensureNode', 'install', 'build', 'smoke', 'verifyNative', 'flush'] as const)('when %s fails', async (step) => {
    const files = step === 'ensureNode'
      ? appFiles({ 'app.config.json': JSON.stringify({ ...CONFIG, nodeMajor: 24 }) })
      : appFiles();
    const pointer = fs.readFileSync(layout(root).current);
    const versionA = treeHash(versionDir(root, ID_A));
    const rootBefore = rootTree();
    const r = await run(fakeFetch(SHA_B, entriesOf(files)), failing(step));
    expect(r.status).toBe('failed');
    expect(fs.readFileSync(layout(root).current).equals(pointer)).toBe(true);
    expect(treeHash(versionDir(root, ID_A))).toEqual(versionA);
    expect(rootTree()).toEqual(rootBefore);
    expect(fs.readdirSync(layout(root).versions)).toEqual([ID_A]);
    expect(fs.existsSync(path.join(layout(root).staging, ID_B))).toBe(false);
  });

  it('a truncated download changes nothing', async () => {
    const f = vi.fn(async (url: unknown) => (String(url).includes('api.github.com')
      ? Response.json({ sha: SHA_B })
      : new Response(new Uint8Array(archive(SHA_B, entriesOf(appFiles())).subarray(0, 100)))));
    expect((await run(f)).status).toBe('failed');
    expect(readCurrent(root)).toEqual({ id: ID_A, previous: null });
    expect(fs.readdirSync(layout(root).versions)).toEqual([ID_A]);
  });

  it('rejects an archive of another commit', async () => {
    const zip = archive(SHA_C, entriesOf(appFiles()));
    const f = vi.fn(async (url: unknown) => (String(url).includes('api.github.com')
      ? Response.json({ sha: SHA_B }) : new Response(new Uint8Array(zip))));
    expect((await run(f)).status).toBe('failed');
    expect(readCurrent(root)!.id).toBe(ID_A);
  });

  it('rejects an archive that is not this app', async () => {
    const r = await run(fakeFetch(SHA_B, [{ name: 'r/' }, { name: 'r/other.txt', data: 'x' }]));
    expect(r.status).toBe('failed');
  });

  it.each([
    ['traversal', 'r/../../evil.txt'],
    ['drive path', 'r/C:/evil.txt'],
    ['alternate data stream', 'r/app/page.tsx:evil'],
    ['short name', 'r/NODE_M~1/evil.js'],
    ['trailing dot', 'r/app./evil.txt'],
  ])('rejects %s entries before writing anything', async (_n, name) => {
    const r = await run(fakeFetch(SHA_B, [...entriesOf(appFiles()), { name, data: 'x' }]));
    expect(r.status).toBe('failed');
    expect(fs.readdirSync(layout(root).versions)).toEqual([ID_A]);
    expect(fs.existsSync(path.join(root, '..', 'evil.txt'))).toBe(false);
  });

  it('rejects symlink entries', async () => {
    const r = await run(fakeFetch(SHA_B, [...entriesOf(appFiles()), { name: 'r/lib/link', data: '/etc', mode: 0o120777 }]));
    expect(r.status).toBe('failed');
    expect(fs.readdirSync(layout(root).versions)).toEqual([ID_A]);
  });

  it('rejects two names for one file', async () => {
    const r = await run(fakeFetch(SHA_B, [...entriesOf(appFiles()), { name: 'r/LIB/UTIL.ts', data: 'x' }]));
    expect(r.status).toBe('failed');
  });

  it('ignores entries aimed at user data and secrets', async () => {
    const before = rootTree();
    const files = appFiles({ 'data/history.json': 'EVIL', '.env.local': 'EVIL=1', '.runtime/current.json': 'EVIL', 'node_modules/x.js': 'EVIL', '.next/BUILD_ID': 'EVIL' });
    const ops = okOps();
    expect((await run(fakeFetch(SHA_B, entriesOf(files)), ops)).status).toBe('ready');
    expect(rootTree()).toEqual(before);
    const dir = versionDir(root, ID_B);
    expect(fs.existsSync(path.join(dir, 'data'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.env.local'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.runtime'))).toBe(false);
  });
});

describe('never deletes a version in use (C1)', () => {
  const markerOf = (id: string) => path.join(versionDir(root, id), '.complete');

  it('keeps the running version when it is the latest sha and its marker cannot be read', async () => {
    const before = treeHash(versionDir(root, ID_A), (r) => r === '.complete');
    const ops = okOps();
    const f = fakeFetch(SHA_A);
    fs.chmodSync(markerOf(ID_A), 0o000);
    let r;
    try {
      r = await run(f, ops, { runningId: ID_A });
    } finally {
      fs.chmodSync(markerOf(ID_A), 0o644);
    }
    expect(r).toMatchObject({ status: 'blocked', sha: SHA_A });
    expect(treeHash(versionDir(root, ID_A), (x) => x === '.complete')).toEqual(before);
    expect(ops.install).not.toHaveBeenCalled();
    expect(downloads(f)).toBe(0);
    expect(readUpdateState(root).attempts).toEqual({});
  });

  it.each(['id', 'previous'] as const)('never rebuilds over the pointer %s', async (field) => {
    installVersion(ID_C, SHA_C);
    put(`.runtime/versions/${ID_B}/keep.txt`, 'keep');
    writeCurrent(root, field === 'id' ? { id: ID_B, previous: ID_A } : { id: ID_A, previous: ID_B });
    const ops = okOps();
    const r = await run(fakeFetch(SHA_B), ops, { runningId: ID_C });
    expect(r.status).toBe('blocked');
    expect(ops.install).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(versionDir(root, ID_B), 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('a failed update never removes the running version', async () => {
    const before = treeHash(versionDir(root, ID_A));
    const ops = okOps();
    ops.build.mockImplementation(async () => { throw new Error('build failed'); });
    await run(fakeFetch(SHA_B), ops, { runningId: ID_A });
    expect(treeHash(versionDir(root, ID_A))).toEqual(before);
  });
});

describe('unreadable current.json (C1)', () => {
  const pointerFile = () => layout(root).current;
  const lock = () => fs.chmodSync(pointerFile(), 0o000);
  const unlock = () => fs.chmodSync(pointerFile(), 0o644);
  const setup = () => {
    installVersion(ID_C, SHA_C, { completedAt: 1 }); // A is newer, so A is what would be running.
    writeCurrent(root, { id: ID_C, previous: ID_A });
  };

  it('blocks before any network, write or prune (the reviewed reproduction)', async () => {
    setup();
    const before = { a: treeHash(versionDir(root, ID_A)), c: treeHash(versionDir(root, ID_C)), ino: fs.statSync(pointerFile()).ino };
    const f = fakeFetch(SHA_B);
    const ops = okOps();
    lock();
    let r;
    try {
      r = await run(f, ops, { runningId: ID_A });
    } finally {
      unlock();
    }
    expect(r).toMatchObject({ status: 'blocked', reason: 'pointer' });
    expect(f).not.toHaveBeenCalled();
    expect(ops.install).not.toHaveBeenCalled();
    expect(fs.existsSync(layout(root).updateState)).toBe(false);
    expect(fs.statSync(pointerFile()).ino).toBe(before.ino);
    expect(readCurrent(root)).toEqual({ id: ID_C, previous: ID_A });
    expect(fs.readdirSync(layout(root).versions).sort()).toEqual([ID_A, ID_C].sort());
    expect(treeHash(versionDir(root, ID_A))).toEqual(before.a);
    expect(treeHash(versionDir(root, ID_C))).toEqual(before.c);
  });

  it('does not switch to a version already on disk either', async () => {
    setup();
    installVersion(ID_B, SHA_B);
    lock();
    let r;
    try {
      r = await run(fakeFetch(SHA_B), okOps(), { runningId: ID_A });
    } finally {
      unlock();
    }
    expect(r.status).toBe('blocked');
    expect(readCurrent(root)).toEqual({ id: ID_C, previous: ID_A });
  });

  it('resumes with the original pointer once permissions are back', async () => {
    setup();
    lock();
    await run(fakeFetch(SHA_B), okOps(), { runningId: ID_A }).finally(unlock);
    expect((await run(fakeFetch(SHA_B), okOps(), { runningId: ID_A })).status).toBe('ready');
    expect(readCurrent(root)).toEqual({ id: ID_B, previous: ID_A });
  });

  it('changes nothing when the pointer becomes unreadable during the update', async () => {
    setup();
    const ino = fs.statSync(pointerFile()).ino;
    const ops = okOps();
    ops.smoke.mockImplementation(async () => lock());
    let r;
    try {
      r = await run(fakeFetch(SHA_B), ops, { runningId: ID_A });
    } finally {
      unlock();
    }
    expect(r.status).toBe('failed');
    expect(fs.statSync(pointerFile()).ino).toBe(ino);
    expect(readCurrent(root)).toEqual({ id: ID_C, previous: ID_A });
    expect(fs.existsSync(versionDir(root, ID_C))).toBe(true);
    expect((await run(fakeFetch(SHA_B), okOps(), { runningId: ID_A })).status).toBe('ready');
  });
});

describe('a read error only at launch (C1)', () => {
  const versionNames = () => fs.readdirSync(layout(root).versions).sort();
  const launchUnder = (file: string) => {
    fs.chmodSync(file, 0o000);
    try {
      return resolveVersion(root)!.id;
    } finally {
      fs.chmodSync(file, 0o644);
    }
  };

  it('an unreadable pointer at launch cannot cost the real current version', async () => {
    installVersion(ID_C, SHA_C, { completedAt: 1 }); // A is newer, so the launcher runs A.
    writeCurrent(root, { id: ID_C, previous: ID_A });
    const before = treeHash(versionDir(root, ID_C));
    const running = launchUnder(layout(root).current);
    expect(running).toBe(ID_A);
    expect((await run(fakeFetch(SHA_B), okOps(), { runningId: running })).status).toBe('ready');
    expect(readCurrent(root)).toEqual({ id: ID_B, previous: ID_A });
    expect(treeHash(versionDir(root, ID_C))).toEqual(before);
    expect(versionNames()).toEqual([ID_A, ID_B, ID_C].sort());
  });

  it('an unreadable marker at launch cannot cost the real current version', async () => {
    installVersion(ID_C, SHA_C, { completedAt: Date.now() + 60_000 }); // C is the newest.
    writeCurrent(root, { id: ID_C, previous: ID_A });
    const before = treeHash(versionDir(root, ID_C));
    const running = launchUnder(path.join(versionDir(root, ID_C), '.complete'));
    expect(running).toBe(ID_A);
    expect((await run(fakeFetch(SHA_B), okOps(), { runningId: running })).status).toBe('ready');
    expect(readCurrent(root)).toEqual({ id: ID_B, previous: ID_A });
    expect(treeHash(versionDir(root, ID_C))).toEqual(before);
    expect(versionNames()).toEqual([ID_A, ID_B, ID_C].sort());
  });

  it('the extra version goes at the next update', async () => {
    installVersion(ID_C, SHA_C, { completedAt: 1 });
    writeCurrent(root, { id: ID_C, previous: ID_A });
    const running = launchUnder(layout(root).current);
    await run(fakeFetch(SHA_B), okOps(), { runningId: running });
    const next = entriesOf(appFiles({ 'app/page.tsx': 'page v3' }));
    expect((await run(fakeFetch(SHA_D, next), okOps(), { runningId: ID_B })).status).toBe('ready');
    expect(versionNames()).toEqual([ID_B, versionIdForSha(SHA_D)].sort());
  });

  it('a normal update still ends with exactly two versions', async () => {
    installVersion(ID_C, SHA_C);
    writeCurrent(root, { id: ID_A, previous: ID_C });
    expect((await run(fakeFetch(SHA_B), okOps(), { runningId: ID_A })).status).toBe('ready');
    expect(readCurrent(root)).toEqual({ id: ID_B, previous: ID_A });
    expect(versionNames()).toEqual([ID_A, ID_B].sort());
  });

  it('one read error while switching changes no version and not the pointer (M1)', async () => {
    installVersion(ID_C, SHA_C, { completedAt: 1 });
    writeCurrent(root, { id: ID_C, previous: ID_A });
    const before = { a: treeHash(versionDir(root, ID_A)), c: treeHash(versionDir(root, ID_C)) };
    const pointerBytes = fs.readFileSync(layout(root).current);
    const { ino } = fs.statSync(layout(root).current);
    const realRead = fs.readFileSync;
    // Armed after the last step, so the very next pointer read is the one made while switching.
    const ops = okOps();
    ops.flush.mockImplementation(async () => {
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: []) => {
        if (file !== layout(root).current) return realRead(file, ...rest);
        spy.mockRestore();
        throw Object.assign(new Error('disk read error'), { code: 'EIO' });
      }) as typeof fs.readFileSync);
    });

    const r = await run(fakeFetch(SHA_B), ops, { runningId: ID_A });

    expect(r.status).toBe('failed');
    expect(fs.readFileSync(layout(root).current).equals(pointerBytes)).toBe(true);
    expect(fs.statSync(layout(root).current).ino).toBe(ino);
    expect(versionNames()).toEqual([ID_A, ID_B, ID_C].sort());
    expect(treeHash(versionDir(root, ID_A))).toEqual(before.a);
    expect(treeHash(versionDir(root, ID_C))).toEqual(before.c);
    // The finished build is kept, so the next launch only has to switch to it.
    const retry = okOps();
    expect((await run(fakeFetch(SHA_B), retry, { runningId: ID_A })).status).toBe('ready');
    expect(retry.build).not.toHaveBeenCalled();
    expect(readCurrent(root)).toEqual({ id: ID_B, previous: ID_A });
    expect(fs.existsSync(versionDir(root, ID_C))).toBe(true);
  });
});

describe('free disk space (I5)', () => {
  it('skips before counting an attempt or downloading', async () => {
    const f = fakeFetch(SHA_B);
    const ops = okOps();
    const r = await run(f, ops, { freeSpace: () => MIN_FREE_BYTES - 1 });
    expect(r).toMatchObject({ status: 'low-disk', sha: SHA_B });
    expect(downloads(f)).toBe(0);
    expect(ops.install).not.toHaveBeenCalled();
    expect(readUpdateState(root).attempts).toEqual({});
    expect(updateNotice(r)).toContain('boş alan');
  });
  it('requires 3 GiB', () => expect(MIN_FREE_BYTES).toBe(3 * 1024 ** 3));
  it('proceeds at exactly the limit', async () => {
    expect((await run(fakeFetch(SHA_B), okOps(), { freeSpace: () => MIN_FREE_BYTES })).status).toBe('ready');
  });
  it('continues when free space cannot be measured', async () => {
    expect((await run(fakeFetch(SHA_B), okOps(), { freeSpace: () => null })).status).toBe('ready');
  });
  it('still switches to a version already on disk', async () => {
    installVersion(ID_B, SHA_B);
    expect((await run(fakeFetch(SHA_B), okOps(), { freeSpace: () => 0 })).status).toBe('ready');
  });
  it('measures the available bytes, and returns null when it cannot', () => {
    expect(freeBytes('/x', () => ({ bavail: 10, bsize: 4096 }))).toBe(40960);
    expect(freeBytes('/x', () => { throw new Error('no statfs'); })).toBeNull();
    expect(freeBytes('/x', () => ({ bavail: undefined, bsize: 4096 }))).toBeNull();
  });
});

describe('exact version identity (M5)', () => {
  const sameIdOtherSha = `${'b'.repeat(12)}${'0'.repeat(28)}`;

  it('does not reuse a complete folder of another commit with the same short id', async () => {
    installVersion(ID_B, sameIdOtherSha);
    const ops = okOps();
    expect((await run(fakeFetch(SHA_B), ops)).status).toBe('ready');
    expect(ops.build).toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(versionDir(root, ID_B), '.complete'), 'utf8')).sha).toBe(SHA_B);
  });
  it('refuses when that folder is the running version', async () => {
    installVersion(ID_B, sameIdOtherSha);
    writeCurrent(root, { id: ID_B, previous: ID_A });
    const ops = okOps();
    expect((await run(fakeFetch(SHA_B), ops, { runningId: ID_B })).status).toBe('blocked');
    expect(ops.install).not.toHaveBeenCalled();
  });
});

describe('abort when the launcher gives up its lock (M1)', () => {
  it.each(['install', 'build', 'smoke', 'verifyNative'] as const)('runs no further step after %s', async (step) => {
    const track: { abort?: boolean; sha?: string | null } = {};
    const ops = okOps();
    const order = ['install', 'build', 'smoke', 'verifyNative', 'flush'] as const;
    ops[step].mockImplementation(async () => { track.abort = true; });
    const pointer = fs.readFileSync(layout(root).current);
    const r = await run(fakeFetch(SHA_B), ops, { track });
    expect(r.status).toBe('aborted');
    for (const later of order.slice(order.indexOf(step) + 1)) expect(ops[later]).not.toHaveBeenCalled();
    expect(fs.readFileSync(layout(root).current).equals(pointer)).toBe(true);
    expect(fs.existsSync(path.join(versionDir(root, ID_B), '.complete'))).toBe(false);
  });
  it('does no cleanup once the lock may belong to another launcher', async () => {
    const track: { abort?: boolean } = {};
    const ops = okOps();
    ops.build.mockImplementation(async () => { track.abort = true; throw new Error('killed'); });
    expect((await run(fakeFetch(SHA_B), ops, { track })).status).toBe('aborted');
    expect(fs.existsSync(versionDir(root, ID_B))).toBe(true);
  });
});

describe('archive size limits (M4)', () => {
  it('stops reading as soon as the limit is passed', async () => {
    let pulls = 0;
    const res = new Response(new ReadableStream({
      pull(c) { pulls += 1; c.enqueue(new Uint8Array(64)); },
    }));
    await expect(readCappedBody(res, 200)).rejects.toThrow();
    expect(pulls).toBeLessThan(10);
  });
  it('rejects a declared size over the limit without reading', async () => {
    let pulls = 0;
    const body = new ReadableStream({ pull(c) { pulls += 1; c.enqueue(new Uint8Array(1)); } }, { highWaterMark: 0 });
    const res = new Response(body, { headers: { 'content-length': '1000' } });
    await expect(readCappedBody(res, 200)).rejects.toThrow();
    expect(pulls).toBe(0);
  });
  it('returns a body within the limit', async () => {
    expect((await readCappedBody(new Response('merhaba'), 200)).toString()).toBe('merhaba');
  });
});

describe('case-only renames upstream', () => {
  it('a renamed file and folder cannot delete anything', async () => {
    put(`.runtime/versions/${ID_A}/lib/Foo.ts`, 'old');
    put(`.runtime/versions/${ID_A}/Components/x.tsx`, 'old');
    const versionA = treeHash(versionDir(root, ID_A));
    const files = appFiles({ 'lib/foo.ts': 'new', 'components/x.tsx': 'new' });
    expect((await run(fakeFetch(SHA_B, entriesOf(files)))).status).toBe('ready');
    const dirB = versionDir(root, ID_B);
    expect(fs.readFileSync(path.join(dirB, 'lib/foo.ts'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(dirB, 'components/x.tsx'), 'utf8')).toBe('new');
    expect(treeHash(versionDir(root, ID_A))).toEqual(versionA);
  });
});

describe('attempts', () => {
  const failingBuild = () => {
    const ops = okOps();
    ops.build.mockImplementation(async () => { throw new Error('build failed'); });
    return ops;
  };

  it('persists the attempt before any work starts', async () => {
    const ops = okOps();
    let seen = 0;
    ops.install.mockImplementation(async () => { seen = readUpdateState(root).attempts[SHA_B]; });
    await run(fakeFetch(SHA_B), ops);
    expect(seen).toBe(1);
  });

  it('counts an attempt even when the process dies mid-update', async () => {
    const ops = okOps();
    ops.build.mockImplementation(() => new Promise(() => {})); // Never returns, like a kill -9.
    void run(fakeFetch(SHA_B), ops);
    await vi.waitFor(() => expect(ops.build).toHaveBeenCalled());
    expect(readUpdateState(root).attempts[SHA_B]).toBe(1);
  });

  it(`stops after ${MAX_ATTEMPTS} attempts, then waits for a newer sha`, async () => {
    expect(MAX_ATTEMPTS).toBe(3);
    for (let i = 0; i < 3; i++) expect((await run(fakeFetch(SHA_B), failingBuild())).status).toBe('failed');
    const f = fakeFetch(SHA_B);
    const ops = failingBuild();
    expect((await run(f, ops)).status).toBe('capped');
    expect(downloads(f)).toBe(0);
    expect(ops.install).not.toHaveBeenCalled();
    expect((await run(fakeFetch(SHA_C))).status).toBe('ready');
  });

  it('a good version survives transient failures', async () => {
    expect((await run(fakeFetch(SHA_B), failingBuild())).status).toBe('failed');
    expect((await run(fakeFetch(SHA_B), failingBuild())).status).toBe('failed');
    expect((await run(fakeFetch(SHA_B))).status).toBe('ready');
    expect(readCurrent(root)!.id).toBe(ID_B);
  });

  it('closing the window mid-update moves the try to a separate count', async () => {
    const track: { sha?: string | null } = {};
    const ops = okOps();
    ops.build.mockImplementation(() => new Promise(() => {}));
    void run(fakeFetch(SHA_B), ops, { track });
    await vi.waitFor(() => expect(ops.build).toHaveBeenCalled());
    expect(track.sha).toBe(SHA_B);
    markInterrupted(root, track.sha!);
    const state = readUpdateState(root);
    expect(state.attempts[SHA_B] ?? 0).toBe(0);
    expect(state.interrupted[SHA_B]).toBe(1);
  });

  it('windows closed during a hanging install cannot retry forever (I1)', async () => {
    expect(MAX_INTERRUPTED).toBe(5);
    const ops = okOps();
    ops.install.mockImplementation(() => new Promise(() => {}));
    const statuses: string[] = [];
    for (let launch = 1; launch <= 12; launch++) {
      const track: { sha?: string | null } = {};
      const before = ops.install.mock.calls.length;
      const pending = run(fakeFetch(SHA_B), ops, { track });
      const result = await Promise.race([
        pending,
        vi.waitFor(() => expect(ops.install.mock.calls.length).toBe(before + 1)).then(() => null),
      ]);
      if (result) statuses.push(result.status);
      else markInterrupted(root, track.sha!);
    }
    expect(ops.install).toHaveBeenCalledTimes(5);
    expect(statuses).toEqual(Array(7).fill('capped'));
  });

  it('bounds the total starts when failures and closed windows are mixed', async () => {
    const ops = okOps();
    let starts = 0;
    ops.install.mockImplementation(async () => { starts += 1; throw new Error('install failed'); });
    for (let i = 0; i < 2; i++) await run(fakeFetch(SHA_B), ops);
    for (let i = 0; i < 4; i++) {
      await run(fakeFetch(SHA_B), ops);
      markInterrupted(root, SHA_B);
    }
    await run(fakeFetch(SHA_B), ops);
    expect((await run(fakeFetch(SHA_B), ops)).status).toBe('capped');
    expect(starts).toBe(7);
  });

  it('a newer sha is not held back by closed windows on an older one', async () => {
    for (let i = 0; i < MAX_INTERRUPTED; i++) {
      await run(fakeFetch(SHA_B), (() => {
        const o = okOps();
        o.build.mockImplementation(async () => { throw new Error('x'); });
        return o;
      })());
      markInterrupted(root, SHA_B);
    }
    expect((await run(fakeFetch(SHA_B))).status).toBe('capped');
    expect((await run(fakeFetch(SHA_C))).status).toBe('ready');
  });

  describe('transient download failures (I2)', () => {
    const failingDownload = (respond: () => Promise<Response>) => vi.fn(async (url: unknown) => (
      String(url).includes('api.github.com') ? Response.json({ sha: SHA_B }) : respond()
    ));
    const cases: [string, () => Promise<Response>][] = [
      ['offline', async () => { throw new Error('ENOTFOUND'); }],
      ['timeout', async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }],
      ['rate-limit', async () => new Response('x', { status: 403 })],
      ['rate-limit 429', async () => new Response('x', { status: 429 })],
      ['server', async () => new Response('x', { status: 502 })],
    ];

    it.each(cases)('%s costs no attempt', async (_name, respond) => {
      expect((await run(failingDownload(respond)))).toMatchObject({ status: 'failed' });
      expect(readUpdateState(root).attempts[SHA_B] ?? 0).toBe(0);
    });

    it('a body that breaks midway costs no attempt', async () => {
      const broken = () => new Response(new ReadableStream({
        pull(c) { c.error(new Error('connection reset')); },
      }));
      expect((await run(failingDownload(async () => broken()))).status).toBe('failed');
      expect(readUpdateState(root).attempts[SHA_B] ?? 0).toBe(0);
    });

    it('three network failures do not park a good version', async () => {
      for (let i = 0; i < 3; i++) {
        expect((await run(failingDownload(async () => { throw new Error('offline'); }))).status).toBe('failed');
      }
      expect((await run(fakeFetch(SHA_B))).status).toBe('ready');
      expect(readCurrent(root)!.id).toBe(ID_B);
    });

    it('a permanent archive problem still counts', async () => {
      await run(failingDownload(async () => new Response('x', { status: 404 })));
      expect(readUpdateState(root).attempts[SHA_B]).toBe(1);
      await run(failingDownload(async () => new Response('not a zip')));
      expect(readUpdateState(root).attempts[SHA_B]).toBe(2);
    });
  });

  describe('expiry of step failures (I2)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const seedAttempts = (ageMs: number) => put('.runtime/update-state.json', JSON.stringify({
      attempts: { [SHA_B]: 3 }, attemptAt: { [SHA_B]: Date.now() - ageMs },
    }));

    it('a capped version stays capped within 7 days', async () => {
      seedAttempts(6 * DAY);
      expect((await run(fakeFetch(SHA_B))).status).toBe('capped');
    });
    it('is tried again after 7 days', async () => {
      seedAttempts(8 * DAY);
      expect((await run(fakeFetch(SHA_B))).status).toBe('ready');
    });
    it('closed-window counts do not expire', async () => {
      put('.runtime/update-state.json', JSON.stringify({ interrupted: { [SHA_B]: MAX_INTERRUPTED }, attemptAt: { [SHA_B]: Date.now() - 30 * DAY } }));
      expect((await run(fakeFetch(SHA_B))).status).toBe('capped');
    });
  });

  it('clears the tracked sha when finished', async () => {
    const track: { sha?: string | null } = {};
    await run(fakeFetch(SHA_B), okOps(), { track });
    expect(track.sha).toBeNull();
  });

  it('survives a corrupt state file', async () => {
    put('.runtime/update-state.json', '{broken');
    expect((await run(fakeFetch(SHA_B))).status).toBe('ready');
  });
});

describe('minLauncher', () => {
  const needsNewLauncher = () => entriesOf(appFiles({
    'app.config.json': JSON.stringify({ ...CONFIG, minLauncher: LAUNCHER + 1 }),
  }));

  it('skips the version and asks for a new zip', async () => {
    const ops = okOps();
    const r = await run(fakeFetch(SHA_B, needsNewLauncher()), ops);
    expect(r).toMatchObject({ status: 'needs-new-zip', sha: SHA_B });
    expect(ops.install).not.toHaveBeenCalled();
    expect(readCurrent(root)!.id).toBe(ID_A);
    expect(fs.readdirSync(layout(root).versions)).toEqual([ID_A]);
    expect(updateNotice(r)).toContain('zip');
  });

  it('does not download the same version again, but keeps telling the owner', async () => {
    await run(fakeFetch(SHA_B, needsNewLauncher()));
    const f = fakeFetch(SHA_B, needsNewLauncher());
    const r = await run(f);
    expect(r.status).toBe('needs-new-zip');
    expect(downloads(f)).toBe(0);
  });

  it('a newer sha that this launcher can run is installed', async () => {
    await run(fakeFetch(SHA_B, needsNewLauncher()));
    expect((await run(fakeFetch(SHA_C))).status).toBe('ready');
  });
});

describe('first update after a fresh install', () => {
  const adoptSeed = () => {
    const id = 'seed-111111111111';
    const dir = path.join(layout(root).versions, id);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, data] of Object.entries(appFiles())) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), data);
    }
    markComplete(root, id, { ...machine, sha: null, nodeMajor: 26, nodeVersion: 'v26.1.0', sourceHash: sourceHash(dir) });
    writeCurrent(root, { id, previous: null });
    return id;
  };

  it('does not rebuild when GitHub has the same source as the seed', async () => {
    const id = adoptSeed();
    const ops = okOps();
    expect((await run(fakeFetch(SHA_D, entriesOf({ ...appFiles(), 'README.md': 'docs only' })), ops, { runningId: id })).status).toBe('up-to-date');
    expect(ops.build).not.toHaveBeenCalled();
    expect(readCurrent(root)!.id).toBe(id);
    const f = fakeFetch(SHA_D);
    expect((await run(f, ops, { runningId: id })).status).toBe('up-to-date');
    expect(downloads(f)).toBe(0);
  });

  it('builds when the source differs', async () => {
    const id = adoptSeed();
    const files = appFiles({ 'app/page.tsx': 'changed' });
    expect((await run(fakeFetch(SHA_D, entriesOf(files)), okOps(), { runningId: id })).status).toBe('ready');
  });

  it('builds when a new top-level folder appears', async () => {
    const id = adoptSeed();
    const files = { ...appFiles(), 'hooks/use-x.ts': 'x' };
    expect((await run(fakeFetch(SHA_D, entriesOf(files)), okOps(), { runningId: id })).status).toBe('ready');
  });
});

describe('notices', () => {
  it('are Turkish and tell the owner what happens next', () => {
    expect(updateNotice({ status: 'ready' })).toBe('Yeni sürüm hazır; bir sonraki açılışta kullanılacak.');
    expect(updateNotice({ status: 'failed' })).toContain('mevcut sürüm');
    expect(updateNotice({ status: 'up-to-date' })).toBeNull();
    expect(updateNotice({ status: 'check-failed' })).toBeNull();
    expect(updateNotice({ status: 'capped' })).toBeNull();
    expect(updateNotice({ status: 'skipped' })).toBeNull();
  });
});
