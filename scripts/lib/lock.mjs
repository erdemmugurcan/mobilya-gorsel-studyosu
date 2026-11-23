// One launcher at a time. The first start takes minutes, so a second double-click is likely,
// and two `npm ci` runs in one folder delete each other's files.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const JUST_CREATED_MS = 5_000;
// Locks this process really took. A file naming our pid that is not here is a leftover from an
// earlier run whose pid the OS has reused.
const held = new Set();
const heldKey = (file, pid) => `${pid}:${path.resolve(file)}`;

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// After a crash or reboot the recorded pid can belong to an unrelated program.
export function isLauncherCommand(text, platform = process.platform) {
  return platform === 'win32' ? /^"?node(?:\.exe)?"?,/i.test(text.trim()) : text.includes('launcher.mjs');
}

function processCommand(pid) {
  const r = process.platform === 'win32'
    ? spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe'),
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    : spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
  return r.error || r.status !== 0 ? null : r.stdout;
}

// When in doubt the holder counts as running: a lock is never taken from a live launcher,
// however long ago it started (a Mac waking from sleep may still be mid-build).
function holderIsRunning(pid) {
  if (!processExists(pid)) return false;
  const command = processCommand(pid);
  return command === null || isLauncherCommand(command);
}

function lockIsStale(file, now, isAlive, pid) {
  let text;
  let mtimeMs;
  try {
    text = fs.readFileSync(file, 'utf8');
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return true;
  }
  let holder = null;
  try {
    holder = JSON.parse(text);
  } catch {
    // Possibly being written right now.
  }
  if (!Number.isInteger(holder?.pid)) return now - mtimeMs > JUST_CREATED_MS;
  if (holder.pid === pid) return !held.has(heldKey(file, pid));
  return !isAlive(holder.pid);
}

export function acquireLock(file, { pid = process.pid, now = Date.now(), isAlive = holderIsRunning } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid }), { flag: 'wx' });
      held.add(heldKey(file, pid));
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (!lockIsStale(file, now, isAlive, pid)) return false;
    fs.rmSync(file, { force: true });
  }
  return false;
}

function holderPid(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).pid;
  } catch {
    return null;
  }
}

export function releaseLock(file, pid = process.pid) {
  held.delete(heldKey(file, pid));
  if (holderPid(file) === pid) fs.rmSync(file, { force: true });
}
