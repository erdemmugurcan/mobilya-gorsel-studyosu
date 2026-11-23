import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, isLauncherCommand, releaseLock } from '../../scripts/lib/lock.mjs';

let dir: string;
let file: string;
const alive = () => true;
const dead = () => false;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgs lock ğü-'));
  file = path.join(dir, 'sub', 'launcher.lock');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('launcher lock', () => {
  it('lets only one launcher in', () => {
    expect(acquireLock(file, { pid: 1, isAlive: alive })).toBe(true);
    expect(acquireLock(file, { pid: 2, isAlive: alive })).toBe(false);
  });
  it('takes over from a dead process', () => {
    acquireLock(file, { pid: 1, isAlive: alive });
    expect(acquireLock(file, { pid: 2, isAlive: dead })).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(2);
  });
  it('never takes over from a live launcher, however long ago it wrote the lock (M7)', () => {
    const start = Date.now();
    acquireLock(file, { pid: 1, isAlive: alive, now: start });
    const afterSleep = start + 7 * 24 * 60 * 60 * 1000;
    expect(acquireLock(file, { pid: 2, isAlive: alive, now: afterSleep })).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(1);
  });
  it('takes over a leftover lock that happens to name this process', () => {
    // After a crash or reboot the OS can hand the recorded pid to the new launcher.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid }));
    expect(acquireLock(file, { isAlive: alive })).toBe(true);
    releaseLock(file);
  });
  it('a second acquire in the same process cannot disturb a lock it holds', () => {
    expect(acquireLock(file, { isAlive: alive })).toBe(true);
    const { ino } = fs.statSync(file);
    expect(acquireLock(file, { isAlive: alive })).toBe(false);
    expect(fs.statSync(file).ino).toBe(ino);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(process.pid);
    releaseLock(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(acquireLock(file, { isAlive: alive })).toBe(true);
    releaseLock(file);
  });
  it('recognizes the launcher process, so a reused pid cannot block the app forever', () => {
    expect(isLauncherCommand('/x/bin/node /Mobilya Test/scripts/launcher.mjs', 'darwin')).toBe(true);
    expect(isLauncherCommand('/Applications/Safari.app/Contents/MacOS/Safari', 'darwin')).toBe(false);
    expect(isLauncherCommand('/x/bin/node /other/server.js', 'darwin')).toBe(false);
    expect(isLauncherCommand('"node.exe","4242","Console","1","80,000 K"', 'win32')).toBe(true);
    expect(isLauncherCommand('"chrome.exe","4242","Console","1","80,000 K"', 'win32')).toBe(false);
    expect(isLauncherCommand('INFO: No tasks are running which match the specified criteria.', 'win32')).toBe(false);
  });
  it('treats a just-created empty file as held, an old one as stale', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    expect(acquireLock(file, { pid: 2, isAlive: alive })).toBe(false);
    expect(acquireLock(file, { pid: 2, isAlive: alive, now: Date.now() + 60_000 })).toBe(true);
  });
  it('releases only its own lock', () => {
    acquireLock(file, { pid: 1, isAlive: alive });
    releaseLock(file, 2);
    expect(fs.existsSync(file)).toBe(true);
    releaseLock(file, 1);
    expect(fs.existsSync(file)).toBe(false);
  });
});
