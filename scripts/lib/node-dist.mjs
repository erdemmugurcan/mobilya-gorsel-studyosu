// Names and URLs of the official Node.js builds. The first download happens in the launcher
// stubs (no Node exists yet); these helpers are the tested description of the same layout.
import fs from 'node:fs';
import path from 'node:path';

const DIST = 'https://nodejs.org/dist';

export function nodeTarget(platform, arch) {
  if (arch !== 'x64' && arch !== 'arm64') return null;
  if (platform === 'darwin') return { os: 'darwin', arch, ext: 'tar.gz' };
  if (platform === 'win32') return { os: 'win', arch, ext: 'zip' };
  return null;
}

// PROCESSOR_ARCHITEW6432 holds the real architecture when cmd.exe itself runs under emulation.
export function windowsArch(processorArchitecture, processorArchitew6432) {
  const value = (processorArchitew6432 || processorArchitecture || '').toUpperCase();
  if (value === 'AMD64') return 'x64';
  if (value === 'ARM64') return 'arm64';
  return null;
}

export const nodeDirName = (version, t) => `node-${version}-${t.os}-${t.arch}`;
export const nodeArchiveName = (version, t) => `${nodeDirName(version, t)}.${t.ext}`;
export const nodeDownloadUrl = (version, file) => `${DIST}/${version}/${file}`;
export const nodeMajor = (version) => Number.parseInt(String(version).replace(/^v/, ''), 10);

// dist/index.json lists releases newest first.
export function pickLatestPatch(index, major) {
  const hit = index.find((r) => /^v\d+\.\d+\.\d+$/.test(r.version) && nodeMajor(r.version) === major);
  return hit ? hit.version : null;
}

export function parseShasums(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

// The portable Node of `major` already in `.runtime`, or null.
export function findRuntime(runtimeDir, major, target) {
  let names;
  try {
    names = fs.readdirSync(runtimeDir);
  } catch {
    return null;
  }
  const pattern = new RegExp(`^node-v${major}\\.\\d+\\.\\d+-${target.os}-${target.arch}$`);
  for (const name of names.filter((n) => pattern.test(n))) {
    const exec = target.os === 'win'
      ? path.join(runtimeDir, name, 'node.exe')
      : path.join(runtimeDir, name, 'bin', 'node');
    if (fs.existsSync(exec)) return exec;
  }
  return null;
}

export function npmCliPath(execPath, platform) {
  const tail = ['node_modules', 'npm', 'bin', 'npm-cli.js'];
  return platform === 'win32'
    ? path.join(path.dirname(execPath), ...tail)
    : path.join(execPath, '..', '..', 'lib', ...tail);
}
