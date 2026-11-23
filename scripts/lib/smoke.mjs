// Proves that a freshly built version really opens before it may become current.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { runGuarded, succeeded } from './child.mjs';
import { isThisAppStatus } from './probe.mjs';

export const NATIVE_CHECK_MS = 120_000;

async function answersCorrectly(base, fetchImpl) {
  try {
    const status = await fetchImpl(`${base}/api/magnific/status`, { signal: AbortSignal.timeout(5000) });
    if (!isThisAppStatus(status.status, await status.json())) return false;
    const home = await fetchImpl(`${base}/`, { signal: AbortSignal.timeout(15_000) });
    await home.arrayBuffer();
    return home.status === 200;
  } catch {
    return false;
  }
}

/**
 * @param {number} port
 * @param {{ fetchImpl?: any, timeoutMs?: number, pollMs?: number, isDead?: () => boolean }} [options]
 */
export async function waitForHealthy(port, {
  fetchImpl = fetch, timeoutMs = 120_000, pollMs = 500, isDead = () => false,
} = {}) {
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isDead()) return false;
    if (await answersCorrectly(base, fetchImpl)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// `/` and the status route never load sharp or background removal, so this checks them directly.
// A version without the script is skipped: this launcher is frozen and must not block it.
/**
 * @param {{ dir: string, exec: string, env?: NodeJS.ProcessEnv, output?: any, timeoutMs?: number }} options
 */
export async function verifyNativePackages({ dir, exec, env, output = 'ignore', timeoutMs = NATIVE_CHECK_MS }) {
  const script = path.join(dir, 'scripts', 'verify-native.mjs');
  if (!fs.existsSync(script)) return 'skipped';
  const result = await runGuarded(exec, [script], { cwd: dir, env, output, timeoutMs }).done;
  if (!succeeded(result)) throw new Error('Yeni sürümün görüntü paketleri çalışmadı.');
  return 'ok';
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
