// Side-by-side versions. Each lives in `.runtime/versions/<id>/` and counts only once it has a
// valid `.complete` marker. `.runtime/current.json` alone says which one runs.
import fs from 'node:fs';
import path from 'node:path';
import { rmTree, sha256, writeFileDurable } from './fsutil.mjs';
import { APP_ENTRIES } from './paths.mjs';

const COMPLETE = '.complete';
const ID = /^(?:seed-)?[0-9a-f]{12}$/;
const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export const isValidId = (id) => typeof id === 'string' && ID.test(id);

// Short on purpose: Windows native modules fail to load from paths over 260 characters.
export const versionIdForSha = (sha) => sha.slice(0, 12);

export function layout(root) {
  const runtime = path.join(root, '.runtime');
  return {
    runtime,
    node: path.join(runtime, 'node'),
    versions: path.join(runtime, 'versions'),
    staging: path.join(runtime, 'staging'),
    current: path.join(runtime, 'current.json'),
    updateState: path.join(runtime, 'update-state.json'),
  };
}

export function versionDir(root, id) {
  if (!isValidId(id)) throw new Error('geçersiz sürüm adı');
  return path.join(layout(root).versions, id);
}

// `missing` and `invalid` are confirmed facts. `unreadable` is a doubt (permissions, antivirus,
// a disk error), and nothing is ever deleted or rewritten because of a doubt.
function readJsonState(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { state: err.code === 'ENOENT' ? 'missing' : 'unreadable', value: null };
  }
  try {
    return { state: 'valid', value: JSON.parse(text) };
  } catch {
    return { state: 'invalid', value: null };
  }
}

function pointerState(root) {
  const { state, value } = readJsonState(layout(root).current);
  if (state !== 'valid') return { state, pointer: null };
  if (!value || !isValidId(value.id)) return { state: 'invalid', pointer: null };
  return { state, pointer: { id: value.id, previous: isValidId(value.previous) ? value.previous : null } };
}

export const readCurrent = (root) => pointerState(root).pointer;
export const isPointerUnreadable = (root) => pointerState(root).state === 'unreadable';

// Reads the pointer exactly once and returns the id it replaced. `previous` may be a function of
// that same read, so a read error can never be mistaken for "there was no previous version".
/**
 * @param {string} root
 * @param {{ id: string, previous?: string | null | ((old: { id: string, previous: string | null } | null) => string | null) }} pointer
 * @returns {string | null}
 */
export function writeCurrent(root, { id, previous = null }) {
  if (!isValidId(id)) throw new Error('geçersiz sürüm adı');
  const { state, pointer } = pointerState(root);
  // A rename would succeed over an unreadable file and destroy the only record of what is current.
  if (state === 'unreadable') throw new Error('current.json okunamadı');
  const next = typeof previous === 'function' ? previous(pointer) : previous;
  writeFileDurable(layout(root).current, JSON.stringify({ id, previous: next }));
  return pointer?.id ?? null;
}

// With an unreadable pointer the seed still runs (it is the newest complete version found),
// and the original pointer takes over again once it can be read.
export function recordSeedVersion(root, id) {
  if (isPointerUnreadable(root)) return;
  writeCurrent(root, { id, previous: (old) => (old && old.id !== id ? old.id : null) });
}

function readMarker(root, id) {
  if (!isValidId(id)) return { state: 'invalid', meta: null };
  const { state, value } = readJsonState(path.join(versionDir(root, id), COMPLETE));
  if (state !== 'valid') return { state, meta: null };
  return value?.id === id ? { state, meta: value } : { state: 'invalid', meta: null };
}

export const markerState = (root, id) => readMarker(root, id).state;
export const readVersionMeta = (root, id) => readMarker(root, id).meta;

export const isComplete = (root, id) => readVersionMeta(root, id) !== null;

export function markComplete(root, id, meta) {
  writeFileDurable(
    path.join(versionDir(root, id), COMPLETE),
    JSON.stringify({ completedAt: Date.now(), ...meta, id }),
  );
}

// Before a rebuild: the version stays known, but cannot run until the rebuild has finished.
export function markRebuilding(root, id, need) {
  const meta = readVersionMeta(root, id);
  if (!meta) throw new Error('sürüm işareti okunamadı');
  markComplete(root, id, { ...meta, rootPath: null, ...(need === 'install' ? { platform: null } : {}) });
}

export function versionNames(root) {
  try {
    return fs.readdirSync(layout(root).versions).filter(isValidId);
  } catch {
    return [];
  }
}

const newestComplete = (root, except) =>
  versionNames(root)
    .filter((id) => id !== except)
    .map((id) => ({ id, meta: readVersionMeta(root, id) }))
    .filter((v) => v.meta)
    .sort((a, b) => (b.meta.completedAt ?? 0) - (a.meta.completedAt ?? 0))[0]?.id ?? null;

// The version to start, or null on a first run.
export function resolveVersion(root) {
  const { state, pointer: current } = pointerState(root);
  if (current && isComplete(root, current.id)) return { id: current.id, fallback: false };
  // The pointer is only rewritten when its version is confirmed gone, not on a read error.
  const repair = state !== 'unreadable' && (!current || markerState(root, current.id) !== 'unreadable');
  if (current?.previous && isComplete(root, current.previous)) return { id: current.previous, fallback: true, repair };
  const id = newestComplete(root, null);
  return id ? { id, fallback: true, repair } : null;
}

// What to try when `id` will not start.
export function fallbackFor(root, id) {
  const previous = readCurrent(root)?.previous;
  if (previous && previous !== id && isComplete(root, previous)) return previous;
  return newestComplete(root, id);
}

// The only way a version folder is ever deleted. It refuses the current and previous versions,
// anything in `protect`, and every case where it cannot be sure what it would delete.
// The marker goes first, so a deletion that stops midway leaves a folder nobody trusts.
/**
 * @param {string} root
 * @param {string} id
 * @param {{ protect?: (string | null)[] }} [options]
 */
export function removeVersion(root, id, { protect = [] } = {}) {
  if (!isValidId(id) || protect.includes(id)) return false;
  const { state, pointer } = pointerState(root);
  if (state === 'unreadable' || id === pointer?.id || id === pointer?.previous) return false;
  if (markerState(root, id) === 'unreadable') return false;
  try {
    fs.rmSync(path.join(versionDir(root, id), COMPLETE), { force: true });
    rmTree(versionDir(root, id));
    return true;
  } catch {
    return false;
  }
}

export function prune(root, keep) {
  const kept = new Set(keep);
  for (const id of versionNames(root)) if (!kept.has(id)) removeVersion(root, id);
}

// Called while holding the launcher lock, so nothing else is using these folders.
export function cleanLeftovers(root) {
  try {
    rmTree(layout(root).staging);
  } catch {
    // Retried on the next start.
  }
  for (const id of versionNames(root)) {
    const state = markerState(root, id);
    if (state === 'missing' || state === 'invalid') removeVersion(root, id);
  }
}

const samePath = (a, b) => String(a).normalize('NFC') === String(b).normalize('NFC');

// A build records its folder; native packages are specific to the OS and CPU.
export function rebuildNeed(meta, machine) {
  if (meta.platform !== machine.platform || meta.arch !== machine.arch) return 'install';
  return samePath(meta.rootPath, machine.rootPath) ? 'none' : 'build';
}

function appFiles(dir) {
  const out = [];
  const walk = (rel) => {
    let st;
    try {
      st = fs.lstatSync(path.join(dir, rel));
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(path.join(dir, rel))) {
        if (!JUNK.has(name)) walk(`${rel}/${name}`);
      }
    } else if (st.isFile()) {
      out.push(rel);
    }
  };
  for (const entry of APP_ENTRIES) walk(entry);
  return out.sort();
}

export function sourceHash(dir) {
  const lines = appFiles(dir).map((rel) => `${rel.normalize('NFC')}\0${sha256(fs.readFileSync(path.join(dir, rel)))}`);
  return sha256(lines.join('\n'));
}

export const seedId = (root) => `seed-${sourceHash(root).slice(0, 12)}`;

export function copySeed(root, id) {
  const dest = versionDir(root, id);
  for (const rel of appFiles(root)) {
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, rel), target);
  }
}
