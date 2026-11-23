import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadTo } from '@/lib/magnific/client';
import { UserError } from '@/lib/images/process';

const CONN_MSG = "Magnific'e bağlanılamadı, internet bağlantınızı kontrol edin.";

let prevDir: string | undefined;
let tmp: string;

beforeEach(async () => {
  prevDir = process.env.DATA_DIR;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mag-'));
  process.env.DATA_DIR = tmp;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (prevDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDir;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('downloadTo', () => {
  it('writes bytes under the data dir and returns rel', async () => {
    const fetchImpl = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    const rel = await downloadTo('https://x/1.jpg', 'outputs/a-0.jpg', { fetchImpl });
    expect(rel).toBe('outputs/a-0.jpg');
    const buf = await fs.readFile(path.join(tmp, 'outputs/a-0.jpg'));
    expect([...buf]).toEqual([1, 2, 3]);
  });

  it.each([401, 403, 404, 500])('HTTP %i maps to the generic "Görsel indirilemedi" message', async (status) => {
    const fetchImpl = async () => new Response('nope', { status });
    const err = await downloadTo('https://x/1.jpg', 'outputs/a.jpg', { fetchImpl, retryDelayMs: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toBe(`Görsel indirilemedi (HTTP ${status}). "Tekrar üret"e basın.`);
    expect(err.message).not.toMatch(/API anahtar/);
  });

  it('maps a rejecting fetch to the connection message', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(downloadTo('https://x/1.jpg', 'outputs/a.jpg', { fetchImpl, retryDelayMs: 0 })).rejects.toThrow(CONN_MSG);
  });

  it('aborts a hung download after requestTimeoutMs', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        signal = init.signal as AbortSignal;
        signal.addEventListener('abort', () => rej(new DOMException('aborted', 'TimeoutError')));
      })) as unknown as typeof fetch;
    await expect(
      downloadTo('https://x/1.jpg', 'outputs/a.jpg', { fetchImpl, requestTimeoutMs: 20, retryDelayMs: 0 }),
    ).rejects.toThrow(CONN_MSG);
    expect(signal?.aborted).toBe(true);
  });

  const failingBody = (err: Error) =>
    new Response(
      new ReadableStream({
        pull(c) {
          c.error(err);
        },
      }),
      { status: 200 },
    );

  it.each([
    ['a network error', new TypeError('terminated')],
    ['a timeout', new DOMException('The operation timed out.', 'TimeoutError')],
    ['an abort', new DOMException('aborted', 'AbortError')],
  ])('maps a body-read failure (%s) to the connection message', async (_n, e) => {
    const fetchImpl = vi.fn(async () => failingBody(e));
    const err = await downloadTo('https://x/1.jpg', 'outputs/a.jpg', { fetchImpl, retryDelayMs: 0 }).catch((x) => x);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toBe(CONN_MSG);
    await expect(fs.access(path.join(tmp, 'outputs/a.jpg'))).rejects.toThrow();
  });

  it('retries once after a transient failure and then succeeds', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => failingBody(new TypeError('terminated')))
      .mockImplementationOnce(async () => new Response(new Uint8Array([9, 8]), { status: 200 }));
    expect(await downloadTo('https://x/1.jpg', 'outputs/a.jpg', { fetchImpl, retryDelayMs: 0 })).toBe('outputs/a.jpg');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect([...(await fs.readFile(path.join(tmp, 'outputs/a.jpg')))]).toEqual([9, 8]);
  });

  it('retries a rejected fetch and a 5xx once (two attempts in total)', async () => {
    const rejecting = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(downloadTo('https://x/1.jpg', 'outputs/a.jpg', { fetchImpl: rejecting, retryDelayMs: 0 })).rejects.toThrow(CONN_MSG);
    expect(rejecting).toHaveBeenCalledTimes(2);
    const http503 = vi.fn(async () => new Response('busy', { status: 503 }));
    await expect(downloadTo('https://x/1.jpg', 'outputs/a.jpg', { fetchImpl: http503, retryDelayMs: 0 })).rejects.toThrow('HTTP 503');
    expect(http503).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx (the signed URL is gone)', async () => {
    const fetchImpl = vi.fn(async () => new Response('gone', { status: 403 }));
    await expect(downloadTo('https://x/1.jpg', 'outputs/a.jpg', { fetchImpl, retryDelayMs: 0 })).rejects.toThrow('HTTP 403');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
