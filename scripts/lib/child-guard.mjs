// Runs one command and takes its whole process tree down when the launcher goes away.
// The launcher holds this process's stdin open; the pipe closes however the launcher ends,
// including `kill -9` or a closed window, so no npm or build process can outlive it.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
const isWindows = process.platform === 'win32';
const child = spawn(command, args, {
  stdio: ['ignore', 'inherit', 'inherit'],
  detached: !isWindows, // Its own process group, so one signal reaches every descendant.
  windowsHide: true,
});

function killTree(signal) {
  if (!child.pid) return;
  if (isWindows) {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  killTree('SIGTERM');
  setTimeout(() => killTree('SIGKILL'), 2500);
}

process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.on('error', stop);
process.stdin.resume();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);

child.once('error', () => process.exit(127));
child.once('exit', (code) => {
  if (stopping) killTree('SIGKILL');
  process.exit(code ?? 1);
});
