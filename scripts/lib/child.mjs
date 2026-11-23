// Every npm, build and server process runs through child-guard.mjs.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const guardPath = fileURLToPath(new URL('./child-guard.mjs', import.meta.url));
const HARD_KILL_MS = 10_000;
const active = new Set();

/**
 * @param {string} exec
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, output?: any, timeoutMs?: number }} [options]
 */
export function runGuarded(exec, args, { cwd, env = process.env, output = 'ignore', timeoutMs = 0 } = {}) {
  const child = spawn(process.execPath, [guardPath, exec, ...args], {
    cwd,
    env,
    stdio: ['pipe', output, output],
    windowsHide: true,
  });
  child.stdin.on('error', () => {});

  let timedOut = false;
  // Closing stdin works on every OS; a Windows kill would not let the guard clean up.
  const stop = () => {
    child.stdin.end();
    setTimeout(() => child.kill('SIGKILL'), HARD_KILL_MS).unref();
  };
  active.add(stop);
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, timeoutMs) : null;

  const done = new Promise((resolve) => {
    const finish = (code) => {
      if (timer) clearTimeout(timer);
      active.delete(stop);
      resolve({ code: code ?? 1, timedOut });
    };
    child.once('error', () => finish(1));
    child.once('exit', finish);
  });
  return { done, stop };
}

// A step that hit its timeout failed, whatever exit code it ended with.
export const succeeded = ({ code, timedOut }) => code === 0 && !timedOut;

// One automatic retry. `stopped` is checked after the first run, so a stop never starts a new one.
export async function retryOnce(run, stopped, onRetry = () => {}) {
  const first = await run();
  if (succeeded(first) || stopped()) return first;
  onRetry();
  return run();
}

export function stopAll() {
  for (const stop of active) stop();
}
