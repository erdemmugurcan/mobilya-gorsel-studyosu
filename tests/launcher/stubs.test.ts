import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { STUB_FILES } from '../../scripts/lib/paths.mjs';

const root = path.resolve(__dirname, '../..');
const [COMMAND, BAT] = STUB_FILES;
const bytes = (f: string) => fs.readFileSync(path.join(root, f));

describe('Windows launcher (.bat)', () => {
  const buf = bytes(BAT);
  const text = buf.toString('latin1');
  const lines = text.split('\r\n');

  it('is pure ASCII with CRLF only', () => {
    expect([...buf].every((b) => b < 128)).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });
  it('sets up a safe environment', () => {
    expect(text).toMatch(/^@echo off\r\n/);
    expect(text).toContain('setlocal');
    expect(text).toContain('chcp 65001 >nul');
    expect(text).toContain('-NoProfile -ExecutionPolicy Bypass');
    expect(text).toContain('"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile');
    expect(text).toContain('PROCESSOR_ARCHITEW6432');
    expect(text).toContain('pause >nul');
  });
  it('avoids the classic cmd pitfalls', () => {
    expect(text.toLowerCase()).not.toContain('enabledelayedexpansion');
    // No parenthesized blocks: a ")" in the folder name would end them early.
    for (const l of lines.filter((x) => !/^(rem|echo) /i.test(x))) expect(l).not.toMatch(/[()]/);
    // `"...\"` would escape the closing quote for the program receiving it.
    for (const l of lines.filter((x) => /powershell/i.test(x))) expect(l).not.toMatch(/\\"/);
  });
  it('never replaces itself', () => {
    expect(text).not.toContain('.new');
    expect(text.toLowerCase()).not.toContain('move /y');
  });
  it('refuses a git checkout before starting PowerShell', () => {
    const check = lines.indexOf('if exist "%MGS_HOME%.git" goto gitrepo');
    const ps = lines.findIndex((l) => /powershell\.exe/i.test(l));
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(ps);
    expect(lines).toContain(':gitrepo');
  });
  it('checks the folder change directly, not a possibly stale errorlevel', () => {
    expect(lines).toContain('cd /d "%MGS_HOME%" || goto nofolder');
  });
  it('explains a run from inside the ZIP before starting PowerShell (I3)', () => {
    const check = lines.indexOf('if not exist "%MGS_HOME%scripts\\start-windows.ps1" goto notextracted');
    const ps = lines.findIndex((l) => /powershell\.exe/i.test(l));
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(ps);
    const block = lines.slice(lines.indexOf(':notextracted'), lines.indexOf(':nofolder')).join('\n');
    expect(block).toContain('set "MGS_RC=3"');
    expect(block).toContain('Tumunu ayikla');
    expect(block).toContain('Extract All');
    expect(block).toContain('pause >nul');
    expect(block).toContain('goto done');
  });
  it('does not send the app into the Documents folder (I2)', () => {
    expect(text).not.toContain('Belgeler');
  });
  it('has every goto target', () => {
    const labels = new Set(lines.filter((l) => l.startsWith(':')).map((l) => l.slice(1)));
    for (const l of lines) {
      const m = /\bgoto (\w+)/i.exec(l);
      if (m) expect(labels.has(m[1])).toBe(true);
    }
  });
});

describe('PowerShell bootstrap', () => {
  const buf = bytes('scripts/start-windows.ps1');
  it('has a UTF-8 BOM and CRLF only', () => {
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(buf.toString('utf8').replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });
  it('verifies the download and enables TLS 1.2', () => {
    const t = buf.toString('utf8');
    expect(t).toContain('SHASUMS256.txt');
    expect(t).toContain('Get-FileHash');
    expect(t).toContain('Tls12');
    expect(t).toContain('-UseBasicParsing');
  });
  it('retries the folder move and explains a non-network failure', () => {
    const t = buf.toString('utf8');
    expect(t).toContain('function Move-WithRetry');
    expect(t).toMatch(/Move-WithRetry \(Join-Path/);
    expect(t).toContain('Virüs koruması');
  });
  it('can prepare Node without starting the app', () => {
    expect(buf.toString('utf8')).toContain('MGS_BOOTSTRAP_ONLY');
  });
  it('keeps raw system error text out of the window', () => {
    const t = buf.toString('utf8');
    expect(t).not.toContain('Ayrıntı: ');
    expect(t).toContain('launcher.log');
  });
  it('refuses a git checkout before creating or downloading anything', () => {
    const t = buf.toString('utf8');
    const check = t.indexOf("Join-Path $AppDir '.git'");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(t.indexOf('CreateDirectory'));
    expect(check).toBeLessThan(t.indexOf('Invoke-WebRequest -UseBasicParsing -Uri $Url') === -1 ? Infinity : t.indexOf('Get-Bytes \'https://nodejs.org'));
  });
  it('tries each download three times, with a short wait (M5)', () => {
    const t = buf.toString('utf8');
    const fn = t.slice(t.indexOf('function Get-Bytes'), t.indexOf('# Defender or an indexer'));
    expect(fn).toContain('Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 1800');
    expect(fn).toContain('if ($attempt -ge 3) { throw }');
    expect(fn).toMatch(/Start-Sleep -Seconds \d/);
    expect(fn).toContain('return ,$response.RawContentStream.ToArray()');
    // The checksum is still verified after the download.
    expect(t.indexOf('Get-FileHash')).toBeGreaterThan(t.indexOf('SHASUMS256.txt'));
  });

  describe('Visual C++ runtime notice (C1)', () => {
    const t = buf.toString('utf8');
    const start = t.indexOf('# Background removal');
    const end = t.indexOf("$ErrorActionPreference = 'Continue'");
    const block = t.slice(start, end);

    it('runs after the bootstrap-only exit and before the app starts', () => {
      expect(start).toBeGreaterThan(t.indexOf('if ($env:MGS_BOOTSTRAP_ONLY) { exit 0 }'));
      expect(end).toBeGreaterThan(start);
      expect(end).toBeLessThan(t.indexOf("& (Join-Path $NodeDir 'node.exe')"));
    });
    it('checks the DLLs each architecture imports, in the real System32', () => {
      expect(block).toContain("$VcDlls = @('MSVCP140.dll', 'VCRUNTIME140.dll')");
      expect(block).toContain("if ($Arch -eq 'x64') { $VcDlls += 'VCRUNTIME140_1.dll' }");
      expect(block).toContain('$env:SystemRoot');
      expect(block).toContain("'System32'");
      expect(block).toContain("'Sysnative'"); // A 32-bit PowerShell would otherwise look in SysWOW64.
    });
    it('links the official installer for the architecture', () => {
      expect(block).toContain("if ($Arch -eq 'arm64') { 'https://aka.ms/vs/17/release/vc_redist.arm64.exe' } else { 'https://aka.ms/vs/17/release/vc_redist.x64.exe' }");
    });
    it('only opens the link: it never downloads or installs anything', () => {
      expect(block).toContain('Start-Process $VcUrl');
      expect(block).not.toMatch(/Invoke-WebRequest|Get-Bytes|DownloadFile|msiexec|\/install|\/quiet|-Verb/i);
      expect(block.match(/Start-Process/g)).toHaveLength(1);
    });
    it('can never stop the app from opening', () => {
      expect(block).toMatch(/^# Background removal[^\r]*\r\n(?:#[^\r]*\r\n)*try \{\r\n/);
      expect(block).toMatch(/\r\n\} catch \{[^}]*\}\r\n/);
      expect(block).toContain('-not $env:MGS_NO_PAUSE');
      expect(block).toContain('AddSeconds(60)'); // Nobody at the keyboard: the app still opens.
      expect(block).not.toMatch(/\bexit\b|Stop-WithError/);
    });
    it('opens the link only on Enter, ignoring keys pressed earlier', () => {
      expect(block).toContain('while ([Console]::KeyAvailable) { [void][Console]::ReadKey($true) }');
      expect(block).toContain('[ConsoleKey]::Enter');
    });
    it('tells the owner what, why and what next in plain Turkish', () => {
      for (const w of ['ücretsiz', 'Microsoft', 'Arka plan', 'yönetici', 'yeniden açın', 'Enter', 'başka bir tuş']) expect(block).toContain(w);
    });
    it('uses only PowerShell 5.1 syntax', () => {
      const code = t.replace(/"[^"\r\n]*"/g, '""').replace(/'[^'\r\n]*'/g, "''");
      expect(code).not.toMatch(/\?\?|\?\.|\s\?\s/);
    });
  });
  it('keeps Node.js under .runtime/node and accepts a requested major', () => {
    const t = buf.toString('utf8');
    expect(t).toContain("$NodeRoot = Join-Path $Runtime 'node'");
    expect(t).toContain('$env:MGS_NODE_MAJOR');
  });
});

describe('git checkout refusal (real runs in temp copies)', () => {
  const makeCopy = (gitKind: 'dir' | 'file') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgs git ğü-'));
    fs.copyFileSync(path.join(root, COMMAND), path.join(dir, COMMAND));
    fs.chmodSync(path.join(dir, COMMAND), 0o755);
    fs.cpSync(path.join(root, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(root, 'app.config.json'), path.join(dir, 'app.config.json'));
    if (gitKind === 'dir') fs.mkdirSync(path.join(dir, '.git'));
    else fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /elsewhere\n');
    return dir;
  };
  const env = { PATH: '/usr/bin:/bin', MGS_NO_PAUSE: '1', MGS_PORT: '3199', MGS_NO_BROWSER: '1' } as unknown as NodeJS.ProcessEnv;
  const runners: [string, (d: string) => ReturnType<typeof spawnSync>][] = [
    ['.command', (d) => spawnSync('/bin/bash', [path.join(d, COMMAND)], { encoding: 'utf8', input: '', env, timeout: 15_000 })],
    ['start-mac.sh', (d) => spawnSync('/bin/bash', [path.join(d, 'scripts/start-mac.sh')], { encoding: 'utf8', input: '', env, timeout: 15_000 })],
    ['launcher.mjs', (d) => spawnSync(process.execPath, [path.join(d, 'scripts/launcher.mjs')], { cwd: d, encoding: 'utf8', input: '', env, timeout: 15_000 })],
  ];
  describe.each(['dir', 'file'] as const)('.git %s', (kind) => {
    it.each(runners)('%s stops in Turkish and creates nothing', (_name, run) => {
      const dir = makeCopy(kind);
      try {
        const before = fs.readdirSync(dir).sort();
        const r = run(dir);
        expect(r.status).toBe(3);
        expect(`${r.stdout}${r.stderr}`).toContain('geliştirici kopyası');
        expect(fs.readdirSync(dir).sort()).toEqual(before);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);
  });
});

describe('macOS launcher', () => {
  it.each([COMMAND, 'scripts/start-mac.sh'])('%s is LF, bash, executable', (f) => {
    const b = bytes(f);
    expect(b.includes(0x0d)).toBe(false);
    expect(b.toString('utf8').startsWith('#!/bin/bash\n')).toBe(true);
    expect(fs.statSync(path.join(root, f)).mode & 0o111).toBe(0o111);
  });
  it('verifies the checksum', () => {
    const t = bytes('scripts/start-mac.sh').toString('utf8');
    expect(t).toContain('SHASUMS256.txt');
    expect(t).toContain('shasum -a 256');
  });
  it('uses HTTPS-only curl with TLS 1.2 or newer everywhere', () => {
    const t = bytes('scripts/start-mac.sh').toString('utf8');
    const calls = t.match(/\bcurl\b[^\n]*/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) {
      expect(c).toContain("--proto '=https'");
      expect(c).toContain('--tlsv1.2');
    }
  });
  it('can prepare Node without starting the app', () => {
    expect(bytes('scripts/start-mac.sh').toString('utf8')).toContain('MGS_BOOTSTRAP_ONLY');
  });

  describe('when the folder cannot be read', () => {
    const runIn = (setup: (dir: string) => void) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgs stub ğü-'));
      const stub = path.join(dir, COMMAND);
      fs.copyFileSync(path.join(root, COMMAND), stub);
      fs.chmodSync(stub, 0o755);
      setup(dir);
      const r = spawnSync('/bin/bash', [stub], { encoding: 'utf8', input: '', env: { PATH: '/usr/bin:/bin', MGS_NO_PAUSE: '1' } as unknown as NodeJS.ProcessEnv });
      fs.chmodSync(dir, 0o755);
      const cfg = path.join(dir, 'app.config.json');
      if (fs.existsSync(cfg)) fs.chmodSync(cfg, 0o644);
      fs.rmSync(dir, { recursive: true, force: true });
      return r;
    };
    it('explains the macOS permission in Turkish', () => {
      const r = runIn((dir) => {
        fs.writeFileSync(path.join(dir, 'app.config.json'), '{}');
        fs.chmodSync(path.join(dir, 'app.config.json'), 0o000);
      });
      expect(r.status).toBe(3);
      expect(r.stdout).toContain('Dosyalar ve Klasörler');
    });
    it('says so when the launcher was moved out of its folder', () => {
      const r = runIn(() => {});
      expect(r.status).toBe(3);
      expect(r.stdout).toContain('uygulama klasörünün içinde');
    });
  });

  it('does not depend on PATH to detect Apple Silicon', () => {
    expect(bytes('scripts/start-mac.sh').toString('utf8')).toContain('/usr/sbin/sysctl -n hw.optional.arm64');
  });
  it('never removes the temp folder of a download still in progress', () => {
    expect(bytes('scripts/start-mac.sh').toString('utf8')).not.toMatch(/rm -rf "\$RUNTIME"\/tmp\.\*/);
  });
});

describe('launcher install steps (real runs in temp copies, no network)', () => {
  const MAJOR = 98; // Never the running Node, so only the fake runtime below can be picked.
  const SEED = 'seed-abcdefabcdef';
  const GIB = 1024 ** 3;
  const FAKE_NPM = `const fs = require('fs');
fs.appendFileSync(process.env.FAKE_NPM_COUNT, 'x');
process.exit(fs.readFileSync(process.env.FAKE_NPM_COUNT, 'utf8').length <= Number(process.env.FAKE_NPM_FAILS) ? 1 : 0);
`;
  const PRELOAD = `import fs from 'node:fs';
globalThis.fetch = async () => { throw new Error('no network in this test'); };
if (process.env.FAKE_FREE === 'unmeasurable') fs.statfsSync = () => { throw new Error('no statfs'); };
else if (process.env.FAKE_FREE) fs.statfsSync = () => ({ bavail: Number(process.env.FAKE_FREE), bsize: 1 });
`;
  const dirs: string[] = [];
  const makeApp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgs install ğü-'));
    dirs.push(dir);
    fs.cpSync(path.join(root, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'app.config.json'), JSON.stringify({ repo: 'OWNER/REPO', branch: 'main', nodeMajor: MAJOR, minLauncher: 1 }));
    fs.writeFileSync(path.join(dir, 'preload.mjs'), PRELOAD);
    const os_ = process.platform === 'win32' ? 'win' : process.platform;
    const runtime = path.join(dir, '.runtime', 'node', `node-v${MAJOR}.0.0-${os_}-${process.arch}`);
    fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true });
    fs.symlinkSync(process.execPath, path.join(runtime, 'bin', 'node'));
    const npm = path.join(runtime, 'lib', 'node_modules', 'npm', 'bin');
    fs.mkdirSync(npm, { recursive: true });
    fs.writeFileSync(path.join(npm, 'npm-cli.js'), FAKE_NPM);
    return dir;
  };
  const addCompleteVersion = (dir: string) => {
    const v = path.join(dir, '.runtime', 'versions', SEED);
    fs.mkdirSync(v, { recursive: true });
    fs.writeFileSync(path.join(v, '.complete'), JSON.stringify({
      id: SEED, rootPath: fs.realpathSync(dir), platform: process.platform, arch: process.arch, nodeMajor: MAJOR, completedAt: 1,
    }));
    return path.join(v, '.complete');
  };
  const launch = (dir: string, over: Record<string, string> = {}) => {
    const count = path.join(dir, 'npm-runs');
    fs.writeFileSync(count, '');
    const r = spawnSync(process.execPath, [path.join(dir, 'scripts/launcher.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      input: '',
      timeout: 40_000,
      env: {
        PATH: '/usr/bin:/bin', HOME: dir, MGS_PORT: '3198', MGS_NO_BROWSER: '1', MGS_NO_PAUSE: '1',
        NODE_OPTIONS: `--import=${pathToFileURL(path.join(dir, 'preload.mjs')).href}`,
        FAKE_NPM_COUNT: count, FAKE_NPM_FAILS: '0', ...over,
      } as unknown as NodeJS.ProcessEnv,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, npmRuns: fs.readFileSync(count, 'utf8').length };
  };
  const versionFolders = (dir: string) => {
    try {
      return fs.readdirSync(path.join(dir, '.runtime', 'versions'));
    } catch {
      return [];
    }
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('retries a failed npm once and carries on (I1)', () => {
    const r = launch(makeApp(), { FAKE_NPM_FAILS: '1' });
    expect(r.npmRuns).toBe(2);
    expect(r.out).toContain('yeniden deneniyor');
    expect(r.out).not.toContain('Gerekli paketler kurulamadı');
    expect(r.out).toContain('Uygulama hazırlanamadı'); // The fake app has no Next.js to build.
  }, 45_000);
  it('gives up after the second npm failure (I1)', () => {
    const r = launch(makeApp(), { FAKE_NPM_FAILS: '9' });
    expect(r.status).toBe(3);
    expect(r.npmRuns).toBe(2);
    expect(r.out).toContain('Gerekli paketler kurulamadı');
  }, 45_000);
  it('stops a first install on a full disk and says how much it needs (M4)', () => {
    const dir = makeApp();
    const r = launch(dir, { FAKE_FREE: String(1.5 * GIB) });
    expect(r.status).toBe(3);
    expect(r.out).toContain('en az 3 GB');
    expect(r.out).toContain('1,5 GB');
    expect(r.out).not.toContain('ilk kez hazırlanıyor');
    expect(r.npmRuns).toBe(0);
    expect(versionFolders(dir)).toEqual([]);
  }, 45_000);
  it('allows a first install at exactly 3 GiB (M4)', () => {
    const r = launch(makeApp(), { FAKE_FREE: String(3 * GIB) });
    expect(r.out).not.toContain('boş alan');
    expect(r.npmRuns).toBeGreaterThan(0);
  }, 45_000);
  it('continues when free space cannot be measured (M4)', () => {
    const r = launch(makeApp(), { FAKE_FREE: 'unmeasurable' });
    expect(r.out).not.toContain('boş alan');
    expect(r.npmRuns).toBeGreaterThan(0);
  }, 45_000);
  it('never blocks when a complete version exists (M4)', () => {
    const dir = makeApp();
    addCompleteVersion(dir);
    fs.writeFileSync(path.join(dir, '.runtime', 'current.json'), JSON.stringify({ id: SEED, previous: null }));
    const r = launch(dir, { FAKE_FREE: '1' });
    expect(r.out).not.toContain('boş alan');
    expect(r.out).toContain('Uygulama başlatılıyor');
    expect(r.npmRuns).toBe(0);
  }, 45_000);
  it('never blocks on a version whose marker cannot be read right now (M4)', () => {
    const dir = makeApp();
    const marker = addCompleteVersion(dir);
    fs.chmodSync(marker, 0o000);
    const r = launch(dir, { FAKE_FREE: '1' });
    fs.chmodSync(marker, 0o644);
    expect(r.out).not.toContain('boş alan');
    expect(r.npmRuns).toBeGreaterThan(0);
  }, 45_000);
});

describe('launcher.mjs', () => {
  const t = bytes('scripts/launcher.mjs').toString('utf8');
  it('keeps raw error text out of the window', () => {
    expect(t).not.toMatch(/say\(`Ayrıntı/);
  });
  it('has none of the in-place update machinery', () => {
    for (const gone of ['transaction', 'rollback', '--self-check', '.installed-files', 'setAside']) {
      expect(t).not.toContain(gone);
    }
    expect(fs.existsSync(path.join(root, 'scripts/lib/transaction.mjs'))).toBe(false);
  });
  it('opens the app before it looks for an update', () => {
    expect(t.indexOf('server = await startApp()')).toBeGreaterThan(-1);
    expect(t.indexOf('server = await startApp()')).toBeLessThan(t.indexOf('updateRun = updateInBackground('));
  });
  it('serves from the version folder with data in the root', () => {
    expect(t).toContain("DATA_DIR: path.join(root, 'data')");
    expect(t).toContain('NEXT_PRIVATE_OUTPUT_TRACE_ROOT');
  });
  it('tunes npm for slow connections (I1)', () => {
    expect(t).toContain("npm_config_maxsockets: '6'");
    expect(t).toContain("npm_config_fetch_retries: '5'");
    expect(t).toContain("npm_config_fetch_retry_maxtimeout: '120000'");
  });
  it('never retries npm after a stop or an aborted update (I1)', () => {
    expect(t).toContain('() => stopping || updateTrack.abort');
  });
  it('says something before every flush, which can be slow (M3)', () => {
    expect(t.match(/await flushTree\(dir\)/g)).toHaveLength(2);
    expect(t.match(/say\('[^']+'\);\n\s*await flushTree\(dir\)/g)).toHaveLength(2);
  });
  it('keeps the test hook inert without its explicit variables', () => {
    expect(t).toContain('const testing = Boolean(testZip && testSha)');
    expect(t).toContain('if (!testing) return fetch');
  });
});

describe('app.config.json', () => {
  it('keeps a usable shape', () => {
    const c = JSON.parse(bytes('app.config.json').toString('utf8'));
    expect(c.branch).toBe('main');
    expect(Number.isInteger(c.nodeMajor)).toBe(true);
    expect(Number.isInteger(c.minLauncher)).toBe(true);
    expect(typeof c.repo).toBe('string');
  });
  it('points updates at the published repo', () => {
    expect(JSON.parse(bytes('app.config.json').toString('utf8')).repo).toBe('erdemmugurcan/mobilya-gorsel-studyosu');
  });
});
