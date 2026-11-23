import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retryOnce, runGuarded, succeeded } from '../../scripts/lib/child.mjs';
import { verifyNativePackages, waitForHealthy } from '../../scripts/lib/smoke.mjs';

const guardPath = path.resolve(__dirname, '../../scripts/lib/child-guard.mjs');
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};

// Writes its pid, starts a grandchild that writes its pid too, then hangs.
const HANG = `
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const dir = process.argv[1];
  fs.writeFileSync(dir + '/child.pid', String(process.pid));
  const g = spawn(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1] + '/grand.pid', String(process.pid)); setInterval(()=>{}, 1000)", dir], { stdio: 'ignore' });
  setInterval(()=>{}, 1000);
`;

let dir: string;
const pidOf = (name: string) => Number(fs.readFileSync(path.join(dir, name), 'utf8'));
const hasPids = () => fs.existsSync(path.join(dir, 'child.pid')) && fs.existsSync(path.join(dir, 'grand.pid'));

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgs child ğü-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('retryOnce', () => {
  const ok = { code: 0, timedOut: false };
  const bad = { code: 1, timedOut: false };
  const never = () => false;

  it('does not retry a success', async () => {
    const run = vi.fn(async () => ok);
    expect(await retryOnce(run, never)).toBe(ok);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('retries a failure once and returns the second result', async () => {
    const run = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(ok);
    const onRetry = vi.fn();
    expect(await retryOnce(run, never, onRetry)).toBe(ok);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
  it('stops after two failures', async () => {
    const run = vi.fn(async () => bad);
    expect(await retryOnce(run, never)).toBe(bad);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('retries a timeout only once, so the wait stays bounded', async () => {
    const timedOut = { code: 0, timedOut: true };
    const run = vi.fn(async () => timedOut);
    expect(await retryOnce(run, never)).toBe(timedOut);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('never starts a second run once stopped, even if the stop came during the first', async () => {
    let stopped = false;
    const run = vi.fn(async () => { stopped = true; return bad; });
    const onRetry = vi.fn();
    expect(await retryOnce(run, () => stopped, onRetry)).toBe(bad);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe('runGuarded', () => {
  it('reports the exit code', async () => {
    const ok = await runGuarded(process.execPath, ['-e', 'process.exit(0)'], { cwd: dir }).done;
    expect(ok).toEqual({ code: 0, timedOut: false });
    const bad = await runGuarded(process.execPath, ['-e', 'process.exit(7)'], { cwd: dir }).done;
    expect(bad).toEqual({ code: 7, timedOut: false });
  });

  it('reports a command that cannot start', async () => {
    const r = await runGuarded(path.join(dir, 'missing'), [], { cwd: dir }).done;
    expect(r.code).not.toBe(0);
  });

  it('a hanging step is killed with its whole process tree at the timeout', async () => {
    const run = runGuarded(process.execPath, ['-e', HANG, dir], { cwd: dir, timeoutMs: 1500 });
    expect(await waitFor(hasPids)).toBe(true);
    const r = await run.done;
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(await waitFor(() => !isAlive(pidOf('child.pid')) && !isAlive(pidOf('grand.pid')))).toBe(true);
  }, 20_000);

  it('stop() ends the whole tree', async () => {
    const run = runGuarded(process.execPath, ['-e', HANG, dir], { cwd: dir });
    expect(await waitFor(hasPids)).toBe(true);
    run.stop();
    await run.done;
    expect(await waitFor(() => !isAlive(pidOf('child.pid')) && !isAlive(pidOf('grand.pid')))).toBe(true);
  }, 20_000);

  it('the tree dies even when the launcher itself is killed with SIGKILL', async () => {
    // The guard notices its stdin pipe closing, which no kill can prevent.
    const guard = spawn(process.execPath, [guardPath, process.execPath, '-e', HANG, dir], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    expect(await waitFor(hasPids)).toBe(true);
    guard.stdin.destroy();
    expect(await waitFor(() => !isAlive(pidOf('child.pid')) && !isAlive(pidOf('grand.pid')))).toBe(true);
  }, 20_000);
});

describe('succeeded (M2)', () => {
  it('needs exit code 0 and no timeout', () => {
    expect(succeeded({ code: 0, timedOut: false })).toBe(true);
    expect(succeeded({ code: 1, timedOut: false })).toBe(false);
    expect(succeeded({ code: 0, timedOut: true })).toBe(false);
  });
});

describe('verify-native.mjs (I4)', () => {
  const realScript = path.resolve(__dirname, '../../scripts/verify-native.mjs');
  const fakeSharp = (size = 64) => `
    const chain = () => ({
      composite: () => chain(), png: () => chain(), ensureAlpha: () => chain(), raw: () => chain(),
      toBuffer: async (o) => o ? { data: Buffer.alloc(${size} * ${size} * 4), info: { width: ${size}, height: ${size}, channels: 4 } } : Buffer.from('png'),
    });
    module.exports = () => chain();`;
  const fakeImgly = (body = "return new Blob([Buffer.from('out')], { type: 'image/png' });") =>
    `exports.removeBackground = async () => { ${body} };`;
  const install = (sharpCode: string | null, imglyCode: string | null, withScript = true) => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"v"}');
    if (withScript) {
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.copyFileSync(realScript, path.join(dir, 'scripts/verify-native.mjs'));
    }
    const pkg = (name: string, code: string) => {
      const p = path.join(dir, 'node_modules', name);
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(path.join(p, 'index.js'), code);
    };
    if (sharpCode) pkg('sharp', sharpCode);
    if (imglyCode) pkg('@imgly/background-removal-node', imglyCode);
  };
  const check = (timeoutMs = 15_000) => verifyNativePackages({ dir, exec: process.execPath, env: process.env, timeoutMs });

  it('passes when both native packages work', async () => {
    install(fakeSharp(), fakeImgly());
    await expect(check()).resolves.toBe('ok');
  }, 20_000);
  it('fails when sharp cannot load', async () => {
    install("throw new Error('dlopen failed');", fakeImgly());
    await expect(check()).rejects.toThrow();
  }, 20_000);
  it('fails when a package is missing', async () => {
    install(fakeSharp(), null);
    await expect(check()).rejects.toThrow();
  }, 20_000);
  it('fails when background removal throws', async () => {
    install(fakeSharp(), fakeImgly("throw new Error('onnxruntime failed');"));
    await expect(check()).rejects.toThrow();
  }, 20_000);
  it('fails when the result cannot be decoded to the right size', async () => {
    install(fakeSharp(32), fakeImgly());
    await expect(check()).rejects.toThrow();
  }, 20_000);
  it('fails on a timeout', async () => {
    install(fakeSharp(), fakeImgly('await new Promise(() => setInterval(() => {}, 1000));'));
    await expect(check(1500)).rejects.toThrow();
  }, 20_000);
  it('skips a version that does not ship the script', async () => {
    install(null, null, false);
    await expect(check()).resolves.toBe('skipped');
  });
  it('reads no user data and never touches the Magnific code', () => {
    const code = fs.readFileSync(realScript, 'utf8');
    expect(code).not.toMatch(/magnific|DATA_DIR|readFile|lib\/|data\//i);
  });
});

describe('waitForHealthy', () => {
  const respond = (home: number, status: unknown) => vi.fn(async (url: unknown) => (
    String(url).endsWith('/api/magnific/status')
      ? new Response(typeof status === 'string' ? status : JSON.stringify(status))
      : new Response('html', { status: home })
  ));

  it('passes when / is 200 and the status answer is this app', async () => {
    await expect(waitForHealthy(4000, { fetchImpl: respond(200, { connected: false }), timeoutMs: 500, pollMs: 5 })).resolves.toBe(true);
  });
  it.each([
    ['home page error', 500, { connected: false }],
    ['status is not JSON', 200, '<html>'],
    ['status is another app', 200, { ok: true }],
  ])('fails when %s', async (_n, home, status) => {
    await expect(waitForHealthy(4000, { fetchImpl: respond(home as number, status), timeoutMs: 60, pollMs: 5 })).resolves.toBe(false);
  });
  it('waits for a server that is still starting', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 4) throw new Error('refused');
      return new Response(JSON.stringify({ connected: false }));
    });
    await expect(waitForHealthy(4000, { fetchImpl, timeoutMs: 1000, pollMs: 5 })).resolves.toBe(true);
  });
  it('stops waiting as soon as the server has died', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('refused'); });
    const started = Date.now();
    await expect(waitForHealthy(4000, { fetchImpl, timeoutMs: 5000, pollMs: 5, isDead: () => true })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
