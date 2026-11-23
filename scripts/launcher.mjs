// Started by the double-click launchers with the bundled Node.js:
// already running? -> pick the current version (first run: build it) -> serve it -> open the
// browser -> only then prepare any update in the background, for the next launch.
// This file stays in the downloaded folder and is never updated.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { retryOnce, runGuarded, stopAll, succeeded } from './lib/child.mjs';
import { flushTree, freeBytes, rmTree } from './lib/fsutil.mjs';
import { acquireLock, releaseLock } from './lib/lock.mjs';
import { findRuntime, nodeMajor, nodeTarget, npmCliPath } from './lib/node-dist.mjs';
import { DEFAULT_PORT, isPortFree, probeApp, resolvePort } from './lib/probe.mjs';
import { freePort, verifyNativePackages, waitForHealthy } from './lib/smoke.mjs';
import { markInterrupted, MIN_FREE_BYTES, parseConfig, prepareUpdate, updateNotice } from './lib/update.mjs';
import {
  cleanLeftovers, copySeed, fallbackFor, isPointerUnreadable, layout, markComplete, markerState, markRebuilding,
  readVersionMeta, rebuildNeed, recordSeedVersion, removeVersion, resolveVersion, seedId, sourceHash,
  versionDir, versionNames, writeCurrent,
} from './lib/versions.mjs';

// Raise this when a version needs something only a newer launcher can do; older copies then
// skip that version and ask the owner to download a new zip (`minLauncher` in app.config.json).
const LAUNCHER_VERSION = 1;

const launcherPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(launcherPath), '..');
const port = resolvePort(process.env.MGS_PORT);
const appUrl = `http://localhost:${port}/`;
const paths = layout(root);

// Tells the .bat that the error was already shown and acknowledged.
const EXIT_ERROR_SHOWN = 3;
const READY_TIMEOUT_MS = 120_000;
const HEARTBEAT_MS = 30_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const OTHER_WINDOW_TIMEOUT_MS = 30 * 60_000;
const FIRST_RUN_STEP_MS = 30 * 60_000;
const NODE_DOWNLOAD_MS = 20 * 60_000;
const STOP_GRACE_MS = 8000;

// Test-only: inert unless a local fixture archive is named explicitly.
const testZip = process.env.MGS_TEST_UPDATE_ZIP;
const testSha = process.env.MGS_TEST_UPDATE_SHA;
const testing = Boolean(testZip && testSha);
const testMs = (value, fallback) => (testing && Number(value) > 0 ? Number(value) : fallback);
const UPDATE_STEP_MS = testMs(process.env.MGS_TEST_STEP_TIMEOUT_MS, 10 * 60_000);
const SMOKE_TIMEOUT_MS = testMs(process.env.MGS_TEST_SMOKE_TIMEOUT_MS, 120_000);

const logPath = path.join(paths.runtime, 'launcher.log');
const lockPath = path.join(paths.runtime, 'launcher.lock');

let server = null;
let stopping = false;
let logFd = null;
const updateTrack = {};
let updateRun = Promise.resolve();

class StepError extends Error {}

const say = (msg) => console.log(msg);

async function waitForKey() {
  if (process.env.MGS_NO_PAUSE || !process.stdin.isTTY) return;
  say('\nKapatmak için bir tuşa basın.');
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once('data', resolve));
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
}

// npm and Next.js speak English; their output goes to a file and the window stays Turkish.
function logOutput() {
  if (logFd === null) {
    fs.mkdirSync(paths.runtime, { recursive: true });
    try {
      if (fs.statSync(logPath).size > MAX_LOG_BYTES) fs.truncateSync(logPath);
    } catch {
      // No log yet.
    }
    logFd = fs.openSync(logPath, 'a');
  }
  return logFd;
}

function logDetail(line) {
  try {
    fs.writeSync(logOutput(), `[launcher] ${line}\n`);
  } catch {
    // Logging must never stop the app.
  }
}

async function fail(message) {
  console.error(`\nSorun: ${message}`);
  if (logFd !== null) console.error(`Teknik ayrıntılar şu dosyada: ${logPath}`);
  // The update must be over before the lock is free for another window.
  updateTrack.abort = true;
  stopAll();
  await Promise.race([updateRun, new Promise((r) => setTimeout(r, STOP_GRACE_MS))]);
  releaseLock(lockPath);
  await waitForKey();
  process.exit(EXIT_ERROR_SHOWN);
}

function exitClosed() {
  say('\nMobilya Stüdyo kapatıldı.');
  process.exit(0);
}

// A closed window is not a failed update, but it is still limited (see MAX_INTERRUPTED).
function recordClosedWindow() {
  if (!updateTrack.sha) return;
  try {
    markInterrupted(root, updateTrack.sha);
  } catch {
    // The attempt stays counted, which is the safe direction.
  }
  updateTrack.sha = null;
}

function handleStop() {
  if (stopping) return;
  stopping = true;
  recordClosedWindow();
  updateTrack.abort = true;
  stopAll();
  if (!server) exitClosed();
  setTimeout(exitClosed, STOP_GRACE_MS).unref();
}
process.on('SIGINT', handleStop);
process.on('SIGTERM', handleStop);
process.on('SIGHUP', handleStop);
process.on('exit', () => {
  stopAll();
  releaseLock(lockPath);
});

function childEnv(dir, extra = {}) {
  const env = { ...process.env };
  delete env.NODE_ENV; // A stray "production" would make `npm ci` skip the build tools.
  for (const key of ['MGS_TEST_UPDATE_ZIP', 'MGS_TEST_UPDATE_SHA', 'MGS_TEST_STEP_TIMEOUT_MS', 'MGS_TEST_SMOKE_TIMEOUT_MS']) delete env[key];
  return {
    ...env,
    NEXT_TELEMETRY_DISABLED: '1',
    // The root also has a package-lock.json; without this Next treats it as the workspace root.
    NEXT_PRIVATE_OUTPUT_TRACE_ROOT: dir,
    npm_config_cache: path.join(paths.runtime, 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_maxsockets: '6',
    npm_config_fetch_retries: '5',
    npm_config_fetch_retry_maxtimeout: '120000',
    ...extra,
  };
}

const withNodeOnPath = (env, exec) => {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return { ...env, [key]: [path.dirname(exec), env[key]].filter(Boolean).join(path.delimiter) };
};

function openBrowser() {
  if (process.env.MGS_NO_BROWSER) return;
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${appUrl}"`], {
        stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
      })
    : spawn('open', [appUrl], { stdio: 'ignore', detached: true });
  child.on('error', () => say(`Tarayıcı açılamadı. Şu adresi kendiniz açın: ${appUrl}`));
  child.unref();
}

const machine = () => ({ rootPath: fs.realpathSync(root), platform: process.platform, arch: process.arch });

async function ensureNode(major) {
  if (major === nodeMajor(process.version)) return process.execPath;
  const target = nodeTarget(process.platform, process.arch);
  const found = findRuntime(paths.node, major, target);
  if (found) return found;

  // The same verified download the launchers use for the first Node.js.
  const env = { ...process.env, MGS_BOOTSTRAP_ONLY: '1', MGS_NO_PAUSE: '1', MGS_NODE_MAJOR: String(major) };
  let command;
  let args;
  if (process.platform === 'win32') {
    env.MGS_ARCH = process.arch === 'arm64' ? 'ARM64' : 'AMD64';
    command = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'start-windows.ps1')];
  } else {
    command = '/bin/bash';
    args = [path.join(root, 'scripts', 'start-mac.sh')];
  }
  const result = await runGuarded(command, args, { cwd: root, env, output: logOutput(), timeoutMs: NODE_DOWNLOAD_MS }).done;
  const exec = findRuntime(paths.node, major, target);
  if (!succeeded(result) || !exec) throw new StepError('Bu sürüm için gereken Node.js indirilemedi.');
  return exec;
}

async function runStep(exec, args, { dir, env, timeoutMs }) {
  const heartbeat = setInterval(() => { if (!updateTrack.sha) say('Devam ediyor, lütfen bekleyin…'); }, HEARTBEAT_MS);
  const result = await runGuarded(exec, args, {
    cwd: dir, env: withNodeOnPath(env, exec), output: logOutput(), timeoutMs,
  }).done;
  clearInterval(heartbeat);
  if (stopping) exitClosed();
  return result;
}

async function registryReachable() {
  try {
    const res = await fetch('https://registry.npmjs.org/-/ping', { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function npmCi({ dir, exec, timeoutMs }) {
  const npm = npmCliPath(exec, process.platform);
  if (!fs.existsSync(npm)) throw new StepError('Node.js eksik görünüyor. Pencereyi kapatıp uygulamayı yeniden açın.');
  // Each try has its own timeout, so the longest possible wait is twice `timeoutMs`.
  const r = await retryOnce(
    () => runStep(exec, [npm, 'ci', '--no-audit', '--no-fund', '--prefer-offline'], { dir, env: childEnv(dir), timeoutMs }),
    () => stopping || updateTrack.abort,
    () => {
      logDetail('npm ci başarısız oldu, bir kez daha deneniyor');
      if (!updateTrack.sha) say('Paketler kurulamadı, yeniden deneniyor…');
    },
  );
  if (succeeded(r)) return;
  const online = await registryReachable();
  throw new StepError(online
    ? 'Gerekli paketler kurulamadı. Uygulamayı yeniden açmayı deneyin.'
    : 'Gerekli paketler kurulamadı. İnternet bağlantınızı kontrol edip uygulamayı yeniden açın.');
}

// The build gets its own empty data folder, so it can never read or change real photos.
async function nextBuild({ dir, exec, id, timeoutMs }) {
  const dataDir = path.join(paths.staging, `build-data-${id}`);
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const nextBin = path.join(dir, 'node_modules', 'next', 'dist', 'bin', 'next');
    const r = await runStep(exec, [nextBin, 'build'], { dir, env: childEnv(dir, { DATA_DIR: dataDir }), timeoutMs });
    if (!succeeded(r)) throw new StepError('Uygulama hazırlanamadı. Pencereyi kapatıp yeniden açmayı deneyin.');
  } finally {
    rmTree(dataDir);
  }
}

// Starts the new version on a free port with an empty data folder, then stops it.
async function smokeTest({ dir, exec, id }) {
  const dataDir = path.join(paths.staging, `smoke-data-${id}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const smokePort = await freePort();
  const nextBin = path.join(dir, 'node_modules', 'next', 'dist', 'bin', 'next');
  const env = withNodeOnPath(childEnv(dir, { NODE_ENV: 'production', DATA_DIR: dataDir }), exec);
  const run = runGuarded(exec, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(smokePort)], {
    cwd: dir, env, output: logOutput(),
  });
  let dead = false;
  run.done.then(() => { dead = true; });
  try {
    const healthy = await waitForHealthy(smokePort, { timeoutMs: SMOKE_TIMEOUT_MS, isDead: () => dead || stopping });
    if (!healthy) throw new StepError('Yeni sürüm deneme açılışında yanıt vermedi.');
  } finally {
    run.stop();
    await run.done;
    rmTree(dataDir);
  }
}

// Loads sharp and runs one real background removal, with an empty data folder.
async function verifyNative({ dir, exec, id }) {
  const dataDir = path.join(paths.staging, `native-data-${id}`);
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const env = withNodeOnPath(childEnv(dir, { NODE_ENV: 'production', DATA_DIR: dataDir }), exec);
    await verifyNativePackages({ dir, exec, env, output: logOutput() });
  } finally {
    rmTree(dataDir);
  }
}

function loadConfig() {
  return parseConfig(fs.readFileSync(path.join(root, 'app.config.json'), 'utf8'));
}

// First run: the downloaded source becomes the first version.
async function installSeed() {
  const config = loadConfig();
  const id = seedId(root);
  const dir = versionDir(root, id);
  // With an unreadable pointer an existing folder may be the real current version: leave it alone.
  if (markerState(root, id) === 'unreadable' || (isPointerUnreadable(root) && fs.existsSync(dir))) {
    throw new StepError('Uygulama dosyaları okunamadı. Bilgisayarı yeniden başlatıp uygulamayı yeniden açın.');
  }
  // A folder still here may be a complete version that cannot be read right now: never stop for it.
  const free = versionNames(root).length ? null : freeBytes(root);
  if (free !== null && free < MIN_FREE_BYTES) {
    const gb = (free / 1024 ** 3).toFixed(1).replace('.', ',');
    throw new StepError(`Diskte yeterli boş alan yok. İlk kurulum için en az 3 GB boş alan gerekir, şu an yaklaşık ${gb} GB boş. Yer açıp uygulamayı yeniden açın.`);
  }
  say('Uygulama ilk kez hazırlanıyor. Bu işlem birkaç dakika sürebilir…');
  try {
    const hash = sourceHash(root);
    copySeed(root, id);
    const exec = await ensureNode(config.nodeMajor);
    say('Gerekli paketler kuruluyor…');
    await npmCi({ dir, exec, timeoutMs: FIRST_RUN_STEP_MS });
    say('Uygulama derleniyor…');
    await nextBuild({ dir, exec, id, timeoutMs: FIRST_RUN_STEP_MS });
    say('Dosyalar diske kaydediliyor, bu birkaç dakika sürebilir…');
    await flushTree(dir);
    markComplete(root, id, { ...machine(), sha: null, sourceHash: hash, nodeMajor: config.nodeMajor });
    recordSeedVersion(root, id);
  } catch (err) {
    removeVersion(root, id);
    throw err;
  }
  return id;
}

// A build records its folder and native packages its system, so a moved folder rebuilds here.
// The marker first records that a rebuild is due, so an interrupted one is simply retried.
async function ensureBuilt(id) {
  const meta = readVersionMeta(root, id);
  if (!meta) throw new StepError('Sürüm eksik.');
  const need = rebuildNeed(meta, machine());
  const exec = await ensureNode(meta.nodeMajor);
  if (need === 'none') return exec;
  say('Uygulama klasörü taşınmış. Bu bilgisayar için yeniden hazırlanıyor…');
  const dir = versionDir(root, id);
  markRebuilding(root, id, need);
  if (need === 'install') await npmCi({ dir, exec, timeoutMs: FIRST_RUN_STEP_MS });
  await nextBuild({ dir, exec, id, timeoutMs: FIRST_RUN_STEP_MS });
  say('Dosyalar diske kaydediliyor, bu birkaç dakika sürebilir…');
  await flushTree(dir);
  markComplete(root, id, { ...meta, ...machine(), completedAt: Date.now() });
  return exec;
}

async function startVersion(id) {
  const exec = await ensureBuilt(id);
  const dir = versionDir(root, id);
  say('Uygulama başlatılıyor…');
  const nextBin = path.join(dir, 'node_modules', 'next', 'dist', 'bin', 'next');
  const env = withNodeOnPath(childEnv(dir, { NODE_ENV: 'production', DATA_DIR: path.join(root, 'data') }), exec);
  const run = runGuarded(exec, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: dir, env, output: logOutput(),
  });
  let finished = false;
  const done = run.done.then(({ code }) => { finished = true; return code; });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false;
  while (!finished && !ready && !stopping && Date.now() < deadline) {
    ready = await probeApp(port);
    if (!ready) await new Promise((r) => setTimeout(r, 400));
  }
  if (stopping) {
    run.stop();
    await done;
    exitClosed();
  }
  if (!ready) {
    run.stop();
    await done;
    throw new StepError(`Uygulama açılamadı. ${port} portunu başka bir program kullanıyor olabilir.`);
  }
  return { id, done };
}

async function startApp() {
  let resolved = resolveVersion(root);
  if (!resolved) resolved = { id: await installSeed(), fallback: false };
  if (resolved.fallback) {
    say('Son sürüm eksik bulundu, önceki sürümle açılıyor.');
    if (resolved.repair) {
      const keep = (old) => (old?.previous && old.previous !== resolved.id ? old.previous : null);
      try {
        writeCurrent(root, { id: resolved.id, previous: keep });
      } catch (err) {
        // The app still opens; the pointer is repaired at a later launch.
        logDetail(`current.json onarılamadı: ${err?.message ?? err}`);
      }
    }
  }
  try {
    return await startVersion(resolved.id);
  } catch (err) {
    if (stopping) throw err;
    const other = fallbackFor(root, resolved.id);
    if (!other) throw err;
    logDetail(`sürüm ${resolved.id} açılamadı: ${err?.message ?? err}`);
    say('Bu sürüm açılamadı, önceki sürümle açılıyor.');
    return startVersion(other);
  }
}

function updateFetch() {
  if (!testing) return fetch;
  return async (url) => {
    const u = String(url);
    if (u.startsWith('https://api.github.com/')) return Response.json({ sha: testSha });
    if (u.startsWith('https://codeload.github.com/')) return new Response(fs.readFileSync(testZip));
    throw new Error('beklenmeyen adres');
  };
}

// Runs after the app is up. Failures end here and never reach the running app.
async function updateInBackground(runningId) {
  try {
    const result = await prepareUpdate({
      root,
      config: loadConfig(),
      launcherVersion: LAUNCHER_VERSION,
      runningId,
      machine: machine(),
      fetchImpl: updateFetch(),
      track: updateTrack,
      onStart: () => say('Yeni sürüm arka planda hazırlanıyor. Uygulamayı kullanmaya devam edebilirsiniz.'),
      ops: {
        ensureNode,
        install: ({ dir, exec }) => npmCi({ dir, exec, timeoutMs: UPDATE_STEP_MS }),
        build: ({ dir, exec, id }) => nextBuild({ dir, exec, id, timeoutMs: UPDATE_STEP_MS }),
        smoke: smokeTest,
        verifyNative,
      },
    });
    if (result.error) logDetail(`güncelleme ${result.status} ${result.kind ?? ''}: ${result.error}`);
    if (stopping) return;
    const notice = updateNotice(result);
    if (notice) say(notice);
  } catch (err) {
    logDetail(`güncelleme hatası: ${err?.message ?? err}`);
  }
}

// Returns once this launcher owns the folder; exits if another window brought the app up.
async function takeLockOrWait() {
  if (!acquireLock(lockPath)) {
    say('Mobilya Stüdyo başka bir pencerede hazırlanıyor. Hazır olunca tarayıcı açılacak…');
    const deadline = Date.now() + OTHER_WINDOW_TIMEOUT_MS;
    for (;;) {
      if (await probeApp(port)) {
        say('Uygulama hazır, tarayıcı açılıyor.');
        openBrowser();
        process.exit(0);
      }
      if (acquireLock(lockPath)) break;
      if (Date.now() > deadline) await fail('Diğer pencere bitmedi. Tüm Mobilya Stüdyo pencerelerini kapatıp yeniden açın.');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function main() {
  // A developer checkout is never run from: nothing may be created or removed inside it.
  if (fs.existsSync(path.join(root, '.git'))) {
    console.error('\nSorun: Bu klasör bir geliştirici kopyası (git deposu). Mobilya Stüdyo buradan açılmaz.');
    console.error('GitHub sayfasından ZIP olarak indirip ayrı bir klasöre açın.');
    await waitForKey();
    process.exit(EXIT_ERROR_SHOWN);
  }

  process.chdir(root);
  say('Mobilya Görsel Stüdyosu açılıyor…');
  if (port !== DEFAULT_PORT) say(`Test portu kullanılıyor: ${port}. Magnific girişi yalnızca 3000 portunda çalışır.`);

  if (await probeApp(port)) {
    say('Uygulama zaten açık, tarayıcı açılıyor.');
    openBrowser();
    return;
  }
  await takeLockOrWait();
  cleanLeftovers(root);
  if (!(await isPortFree(port))) {
    throw new StepError(`${port} portunu başka bir program kullanıyor. O programı kapatıp Mobilya Stüdyo'yu yeniden açın.`);
  }

  server = await startApp();

  say(`\nMobilya Stüdyo hazır: ${appUrl}`);
  say('Kapatmak için bu pencerede Ctrl+C tuşlarına basın ya da pencereyi kapatın.\n');
  openBrowser();

  updateRun = updateInBackground(server.id);

  const code = await server.done;
  if (stopping || code === 0) exitClosed();
  await fail(`Uygulama beklenmedik biçimde kapandı. ${port} portunu başka bir program kullanıyor olabilir.`);
}

main().catch((err) => {
  if (err instanceof StepError) return fail(err.message);
  logDetail(err?.stack ?? String(err));
  return fail('Beklenmeyen bir hata oluştu. Pencereyi kapatıp yeniden deneyin.');
});
