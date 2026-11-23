import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findRuntime, nodeArchiveName, nodeDirName, nodeDownloadUrl, nodeMajor, nodeTarget, npmCliPath,
  parseShasums, pickLatestPatch, windowsArch,
} from '../../scripts/lib/node-dist.mjs';

describe('nodeTarget', () => {
  it.each([
    ['darwin', 'arm64', 'darwin', 'tar.gz'],
    ['darwin', 'x64', 'darwin', 'tar.gz'],
    ['win32', 'x64', 'win', 'zip'],
    ['win32', 'arm64', 'win', 'zip'],
  ])('%s/%s', (platform, arch, os, ext) => {
    expect(nodeTarget(platform, arch)).toEqual({ os, arch, ext });
  });
  it('rejects unsupported systems', () => {
    expect(nodeTarget('linux', 'x64')).toBeNull();
    expect(nodeTarget('win32', 'ia32')).toBeNull();
  });
});

describe('windowsArch', () => {
  it('prefers the WOW64 variable', () => {
    expect(windowsArch('x86', 'AMD64')).toBe('x64');
    expect(windowsArch('AMD64', 'ARM64')).toBe('arm64');
  });
  it('maps native values and refuses 32-bit', () => {
    expect(windowsArch('AMD64', undefined)).toBe('x64');
    expect(windowsArch('ARM64', '')).toBe('arm64');
    expect(windowsArch('x86', undefined)).toBeNull();
  });
});

describe('archive names and URLs', () => {
  it('matches the official layout', () => {
    const mac = nodeTarget('darwin', 'arm64')!;
    const win = nodeTarget('win32', 'x64')!;
    expect(nodeArchiveName('v26.13.1', mac)).toBe('node-v26.13.1-darwin-arm64.tar.gz');
    expect(nodeArchiveName('v26.13.1', win)).toBe('node-v26.13.1-win-x64.zip');
    expect(nodeDirName('v26.13.1', win)).toBe('node-v26.13.1-win-x64');
    expect(nodeDownloadUrl('v26.13.1', 'SHASUMS256.txt')).toBe('https://nodejs.org/dist/v26.13.1/SHASUMS256.txt');
  });
});

describe('pickLatestPatch', () => {
  const index = [
    { version: 'v27.0.0', lts: false },
    { version: 'v26.13.1', lts: 'Lithium' },
    { version: 'v26.13.0', lts: 'Lithium' },
    { version: 'v2.6.0', lts: false },
  ];
  it('takes the newest of the major', () => expect(pickLatestPatch(index, 26)).toBe('v26.13.1'));
  it('does not confuse 2 with 26', () => expect(pickLatestPatch(index, 2)).toBe('v2.6.0'));
  it('returns null when absent', () => expect(pickLatestPatch(index, 99)).toBeNull());
});

describe('parseShasums', () => {
  const sha = 'a'.repeat(64);
  it('reads the hash per file', () => {
    const m = parseShasums(`${sha}  node-v26.13.1-win-x64.zip\r\n${'b'.repeat(64)}  other.tar.gz\n\n`);
    expect(m.get('node-v26.13.1-win-x64.zip')).toBe(sha);
    expect(m.size).toBe(2);
  });
  it('ignores malformed lines', () => expect(parseShasums('nope\nabc  x\n').size).toBe(0));
});

describe('npmCliPath and nodeMajor', () => {
  it('finds npm in the portable layout of each OS', () => {
    expect(npmCliPath('/r/node/bin/node', 'darwin')).toBe(path.join('/r/node/bin/node', '..', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    expect(npmCliPath('/r/node/node.exe', 'win32')).toBe(path.join('/r/node', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  });
  it('reads the major', () => expect(nodeMajor('v26.13.1')).toBe(26));
});

describe('findRuntime', () => {
  it('finds the portable Node of a major for this system', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgs runtime ğü-'));
    try {
      fs.mkdirSync(path.join(dir, 'node-v24.1.0-darwin-arm64', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node-v24.1.0-darwin-arm64', 'bin', 'node'), '');
      fs.mkdirSync(path.join(dir, 'node-v26.1.0-win-x64'));
      fs.writeFileSync(path.join(dir, 'node-v26.1.0-win-x64', 'node.exe'), '');
      fs.mkdirSync(path.join(dir, 'node-v26.2.0-darwin-arm64')); // incomplete
      expect(findRuntime(dir, 24, nodeTarget('darwin', 'arm64')!)).toBe(path.join(dir, 'node-v24.1.0-darwin-arm64', 'bin', 'node'));
      expect(findRuntime(dir, 26, nodeTarget('win32', 'x64')!)).toBe(path.join(dir, 'node-v26.1.0-win-x64', 'node.exe'));
      expect(findRuntime(dir, 26, nodeTarget('darwin', 'arm64')!)).toBeNull();
      expect(findRuntime(path.join(dir, 'missing'), 26, nodeTarget('darwin', 'arm64')!)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
