// Small file helpers shared by the version store and the updater.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Windows antivirus and indexers briefly hold new files, which makes a rename fail.
export function renameWithRetry(from, to) {
  const attempts = process.platform === 'win32' ? 20 : 1;
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (i >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      sleepSync(500);
    }
  }
}

function syncDir(dir) {
  if (process.platform === 'win32') return; // Windows cannot open a folder for fsync.
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Some volumes refuse this; the rename itself is still atomic.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Readers see the old content or the new content, never a partial file, even after a power cut.
export function writeFileDurable(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  syncDir(dir);
}

// Bytes available on the volume, or null where that cannot be measured.
/**
 * @param {string} target
 * @param {(p: string) => { bavail?: number | bigint, bsize?: number | bigint }} [statfs]
 */
export function freeBytes(target, statfs = fs.statfsSync) {
  try {
    const { bavail, bsize } = statfs(target);
    const bytes = Number(bavail) * Number(bsize);
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

export const rmTree = (target) => fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

function listFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(abs, out);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

// Puts a finished version on disk before it is marked complete.
export async function flushTree(dir, concurrency = 16) {
  const files = listFiles(dir);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      let handle;
      try {
        handle = await fs.promises.open(file, 'r+');
        await handle.sync();
      } catch {
        // A read-only file was written earlier and cannot be flushed from here.
      } finally {
        await handle?.close().catch(() => {});
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}
