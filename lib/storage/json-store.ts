import fs from 'node:fs/promises';
import path from 'node:path';
import { dataPath, ensureDataDirs } from './paths';

export async function readJson<T>(rel: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(dataPath(rel), 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

// Atomic: write a temp file in the same directory, then rename over the target.
// `mode` (e.g. 0o600 for secrets) is set when the temp file is created, so the target never
// exists with a wider mode, not even briefly.
export async function writeJson(rel: string, value: unknown, opts: { mode?: number } = {}): Promise<void> {
  await ensureDataDirs();
  const target = dataPath(rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: opts.mode, flag: 'wx' });
  await fs.rename(tmp, target);
}

// Serializes read-modify-write cycles per file. The queue map lives on globalThis so
// every Next route bundle (and HMR reload) shares one queue for the same file.
const QUEUES_KEY = Symbol.for('mgs.json-store.queues');
type QueueMap = Map<string, Promise<unknown>>;

export function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as Record<symbol, QueueMap | undefined>;
  const queues = (g[QUEUES_KEY] ??= new Map());
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(key, run.catch(() => undefined));
  return run;
}
