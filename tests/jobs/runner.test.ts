import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { startGeneration, type RunnerDeps } from '@/lib/jobs/runner';
import { getGeneration, STALE_MS } from '@/lib/storage/history';
import { API_TIMEOUT_MS, ASSET_PREP_MS, MAX_VARIATION_MS, WAIT_TIMEOUT_MS } from '@/lib/magnific/client';
import { ASPECTS } from '@/config/aspects';
import { saveUpload, UserError } from '@/lib/images/process';
import { dataPath } from '@/lib/storage/paths';
import type { ImageProvider } from '@/lib/providers/types';
import type { GenerationRecord, GenerationRequest } from '@/lib/types';

const CREDIT_MSG = 'Magnific krediniz yetersiz.';
const LIBRARY_HINT = ' Görsel Magnific kütüphanenizde olabilir; tekrar üretmeden önce oraya bakın.';
const CONN_MSG = "Magnific'e bağlanılamadı, internet bağlantınızı kontrol edin.";

let cutoutId: string;
let spaceId: string;
const NOT_FOUND = 'Fotoğraf bulunamadı, lütfen tekrar yükleyin.';

async function png(color: string): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: color } })
    .png()
    .toBuffer();
}

beforeEach(async () => {
  process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'mgs-run-'));
  cutoutId = crypto.randomUUID();
  await fs.mkdir(dataPath('cutouts'), { recursive: true });
  await fs.writeFile(dataPath(`cutouts/${cutoutId}.png`), await png('#336699'));
  spaceId = (await saveUpload(await png('#cccccc'), 'space')).id;
});

async function addCutout(color: string): Promise<string> {
  const id = crypto.randomUUID();
  await fs.writeFile(dataPath(`cutouts/${id}.png`), await png(color));
  return id;
}

const req = (over: Partial<GenerationRequest> = {}): GenerationRequest => ({
  products: [{ name: 'Koltuk', cutoutIds: [cutoutId] }],
  envMode: 'preset',
  styleId: 'modern',
  aspect: '1:1',
  count: 2,
  model: 'cinematic',
  resolution: '2k',
  ...over,
});

const download = async (_url: string, rel: string) => {
  await fs.mkdir(path.dirname(dataPath(rel)), { recursive: true });
  await fs.writeFile(dataPath(rel), await sharp({ create: { width: 32, height: 32, channels: 3, background: '#fff' } }).jpeg().toBuffer());
  return rel;
};

async function settle(id: string): Promise<GenerationRecord> {
  for (let i = 0; i < 200; i++) {
    const r = await getGeneration(id);
    if (r && r.status !== 'running') return r;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('timeout');
}

const okProvider: ImageProvider = { generate: async () => ['http://x/img'] };
const connected = async () => true;
const deps = (over: RunnerDeps = {}): RunnerDeps => ({ provider: okProvider, download, isConnected: connected, ...over });

describe('startGeneration', () => {
  it('count 2, both succeed', async () => {
    const rec = await startGeneration(req(), deps());
    expect(rec.status).toBe('running');
    const done = await settle(rec.id);
    expect(done.status).toBe('done');
    expect(done.outputs.map((o) => o.file)).toEqual([`outputs/${rec.id}-0.jpg`, `outputs/${rec.id}-1.jpg`]);
    for (const o of done.outputs) await fs.access(dataPath(o.file!));
  });

  it('partial when one variation fails', async () => {
    let n = 0;
    const provider: ImageProvider = {
      generate: async () => {
        const i = n++;
        if (i === 1) throw new Error('boom');
        return ['http://x/img'];
      },
    };
    const rec = await startGeneration(req({ count: 3 }), deps({ provider }));
    const done = await settle(rec.id);
    expect(done.status).toBe('partial');
    expect(done.outputs.filter((o) => o.status === 'done')).toHaveLength(2);
    const failed = done.outputs.filter((o) => o.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe('Beklenmeyen bir hata oluştu.');
  });

  it('records UserError message as-is when all fail', async () => {
    const provider: ImageProvider = {
      generate: async () => {
        throw new UserError(CREDIT_MSG);
      },
    };
    const rec = await startGeneration(req(), deps({ provider }));
    const done = await settle(rec.id);
    expect(done.status).toBe('failed');
    expect(done.outputs.map((o) => o.error)).toEqual([CREDIT_MSG, CREDIT_MSG]);
  });

  it('records a failure when download throws, without unhandled rejection', async () => {
    const bad = async () => {
      throw new Error('disk');
    };
    const rec = await startGeneration(req({ count: 1 }), deps({ download: bad }));
    expect((await settle(rec.id)).status).toBe('failed');
  });

  it('a download failure after a successful generate carries the library hint', async () => {
    const bad = async () => {
      throw new UserError(CONN_MSG);
    };
    const rec = await startGeneration(req({ count: 1 }), deps({ download: bad }));
    const done = await settle(rec.id);
    expect(done.outputs[0].error).toBe(CONN_MSG + LIBRARY_HINT);
  });

  it('an unexpected download error after generate is generic plus the library hint', async () => {
    const bad = async () => {
      throw new Error('disk');
    };
    const rec = await startGeneration(req({ count: 1 }), deps({ download: bad }));
    expect((await settle(rec.id)).outputs[0].error).toBe('Beklenmeyen bir hata oluştu.' + LIBRARY_HINT);
  });

  it('a provider error already carrying the hint is not hinted twice', async () => {
    const provider: ImageProvider = {
      generate: async () => {
        throw new UserError('Magnific üretimi başarısız oldu.' + LIBRARY_HINT);
      },
    };
    const rec = await startGeneration(req({ count: 1 }), deps({ provider }));
    expect((await settle(rec.id)).outputs[0].error).toBe('Magnific üretimi başarısız oldu.' + LIBRARY_HINT);
  });

  it('place-in-space without space throws and creates no record', async () => {
    await expect(
      startGeneration(req({ envMode: 'place-in-space' }), deps()),
    ).rejects.toThrow('Lütfen bir referans mekân fotoğrafı yükleyin.');
    await expect(fs.access(dataPath('history.json'))).rejects.toThrow();
  });

  it('missing cutout throws and creates no record', async () => {
    await expect(
      startGeneration(req({ products: [{ name: 'Koltuk', cutoutIds: [cutoutId, crypto.randomUUID()] }] }), deps()),
    ).rejects.toThrow(NOT_FOUND);
    await expect(fs.access(dataPath('history.json'))).rejects.toThrow();
  });

  it('passes products (product-first images) and the space separately to the provider', async () => {
    const seen: Parameters<ImageProvider['generate']>[0][] = [];
    const provider: ImageProvider = {
      generate: async (i) => {
        seen.push(i);
        return ['http://x/img'];
      },
    };
    const a = await startGeneration(req({ count: 1 }), deps({ provider }));
    await settle(a.id);
    const b = await startGeneration(
      req({ count: 1, envMode: 'place-in-space', styleId: undefined, spaceUploadId: spaceId }),
      deps({ provider }),
    );
    await settle(b.id);
    expect(seen[0].products).toHaveLength(1);
    expect(seen[0].products[0].name).toBe('Koltuk');
    expect(seen[0].products[0].images).toHaveLength(1);
    expect(seen[0].space).toBeUndefined();
    expect(typeof seen[1].space).toBe('string');
    // product: blue-ish; space: grey
    const prod = await sharp(Buffer.from(seen[1].products[0].images[0], 'base64')).stats();
    expect(prod.channels[2].mean).toBeGreaterThan(prod.channels[0].mean);
    const space = await sharp(Buffer.from(seen[1].space!, 'base64')).stats();
    expect(Math.abs(space.channels[2].mean - space.channels[0].mean)).toBeLessThan(5);
  });

  it('several products with several angles each: names trimmed, photos in order, persisted', async () => {
    const red = await addCutout('#ff0000');
    const green = await addCutout('#00ff00');
    const seen: Parameters<ImageProvider['generate']>[0][] = [];
    const provider: ImageProvider = {
      generate: async (i) => {
        seen.push(i);
        return ['http://x/img'];
      },
    };
    const rec = await startGeneration(
      req({
        count: 1,
        products: [
          { name: '  Koltuk ', cutoutIds: [cutoutId, red] },
          { name: 'Sehpa', cutoutIds: [green] },
        ],
      }),
      deps({ provider }),
    );
    const done = await settle(rec.id);
    expect(done.products).toEqual([
      { name: 'Koltuk', cutoutIds: [cutoutId, red] },
      { name: 'Sehpa', cutoutIds: [green] },
    ]);
    expect(seen[0].products.map((p) => [p.name, p.images.length])).toEqual([
      ['Koltuk', 2],
      ['Sehpa', 1],
    ]);
    const second = await sharp(Buffer.from(seen[0].products[0].images[1], 'base64')).stats();
    expect(second.channels[0].mean).toBeGreaterThan(second.channels[2].mean);
    expect(done.prompt).toContain('{{P1}}');
    expect(done.prompt).toContain('{{P2}}');
    expect(done.prompt).toContain('"Koltuk"');
  });

  it('accepts every listed aspect ratio', async () => {
    for (const a of ASPECTS) {
      const rec = await startGeneration(req({ count: 1, aspect: a.value }), deps());
      expect(rec.aspect).toBe(a.value);
      await settle(rec.id);
    }
  });

  it('an unknown cutout among several photos gives the Turkish not-found message', async () => {
    await expect(
      startGeneration(req({ products: [{ name: 'A', cutoutIds: [cutoutId] }, { name: 'B', cutoutIds: ['../etc'] }] }), deps()),
    ).rejects.toMatchObject({ name: 'UserError', message: NOT_FOUND });
    await expect(fs.access(dataPath('history.json'))).rejects.toThrow();
  });

  describe('finish()', () => {
    const tick = () => new Promise((r) => setTimeout(r, 20));

    it('is called exactly once, after every variation settled (success)', async () => {
      let settled = 0;
      const finish = vi.fn(async () => {
        expect(settled).toBe(3);
      });
      const provider: ImageProvider = {
        generate: async () => {
          await tick();
          return ['http://x/img'];
        },
        finish,
      };
      const counting = async (u: string, rel: string) => {
        const r = await download(u, rel);
        settled++;
        return r;
      };
      const rec = await startGeneration(req({ count: 3 }), deps({ provider, download: counting }));
      expect(finish).not.toHaveBeenCalled();
      await settle(rec.id);
      await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
      await tick();
      expect(finish).toHaveBeenCalledOnce();
    });

    it('is called once after a failed variation too, and only when all are settled', async () => {
      let n = 0;
      const finish = vi.fn(async () => {});
      const provider: ImageProvider = {
        generate: async () => {
          const i = n++;
          await new Promise((r) => setTimeout(r, i * 15));
          if (i === 0) throw new UserError('Magnific üretimi başarısız oldu.');
          return ['http://x/img'];
        },
        finish,
      };
      const rec = await startGeneration(req({ count: 2 }), deps({ provider }));
      await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
      const r = await getGeneration(rec.id);
      expect(r!.status).toBe('partial');
      expect(r!.outputs.every((o) => o.status !== 'pending')).toBe(true);
    });

    it('is called once when every variation fails, and a throwing finish() is swallowed', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const finish = vi.fn(async () => {
        throw new Error('delete boom');
      });
      const provider: ImageProvider = {
        generate: async () => {
          throw new UserError(CREDIT_MSG);
        },
        finish,
      };
      const rec = await startGeneration(req({ count: 2 }), deps({ provider }));
      expect((await settle(rec.id)).status).toBe('failed');
      await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      expect((await getGeneration(rec.id))!.outputs.map((o) => o.error)).toEqual([CREDIT_MSG, CREDIT_MSG]);
    });
  });

  it('re-encodes non-JPEG downloads to JPEG under the same name', async () => {
    const pngDownload = async (_u: string, rel: string) => {
      await fs.mkdir(path.dirname(dataPath(rel)), { recursive: true });
      await fs.writeFile(dataPath(rel), await png('#ff0000'));
      return rel;
    };
    const rec = await startGeneration(req({ count: 1 }), deps({ download: pngDownload }));
    const done = await settle(rec.id);
    expect(done.status).toBe('done');
    const meta = await sharp(dataPath(done.outputs[0].file!)).metadata();
    expect(meta.format).toBe('jpeg');
  });

  it.each([
    ['count 0', { count: 0 }],
    ['count 5', { count: 5 }],
    ['count 2.5', { count: 2.5 }],
    ['aspect', { aspect: '16:10' }],
    ['aspect type', { aspect: 1 }],
    ['legacy cutoutId instead of products', { products: undefined, cutoutId: 'c' }],
    ['products not an array', { products: { name: 'A', cutoutIds: ['c'] } }],
    ['0 products', { products: [] }],
    ['5 products', { products: ['A', 'B', 'C', 'D', 'E'].map((name) => ({ name, cutoutIds: ['c'] })) }],
    ['0 photos', { products: [{ name: 'A', cutoutIds: [] }] }],
    ['7 photos', { products: [{ name: 'A', cutoutIds: Array.from({ length: 7 }, (_, i) => `c${i}`) }] }],
    ['empty name', { products: [{ name: '   ', cutoutIds: ['c'] }] }],
    ['41-char name', { products: [{ name: 'x'.repeat(41), cutoutIds: ['c'] }] }],
    ['name type', { products: [{ name: 5, cutoutIds: ['c'] }] }],
    ['duplicate names (case-insensitive)', { products: [{ name: 'Sehpa', cutoutIds: ['a'] }, { name: ' SEHPA', cutoutIds: ['b'] }] }],
    ['cutoutId type', { products: [{ name: 'A', cutoutIds: [5] }] }],
    ['cutoutIds not an array', { products: [{ name: 'A', cutoutIds: 'c' }] }],
    ['product not an object', { products: ['A'] }],
    ['model', { model: 'x' }],
    ['resolution 1k', { resolution: '1k' }],
    ['resolution 8k', { resolution: '8k' }],
    ['resolution type', { resolution: 4 }],
    ['envMode', { envMode: 'x' }],
    ['note type', { note: 5 }],
    ['spaceUploadId type', { spaceUploadId: 5 }],
  ])('rejects invalid %s with no record', async (_n, over) => {
    await expect(
      startGeneration(req(over as unknown as Partial<GenerationRequest>), deps()),
    ).rejects.toMatchObject({ name: 'UserError', message: 'Geçersiz istek.' });
    await expect(fs.access(dataPath('history.json'))).rejects.toThrow();
  });

  it('preset with unknown style rejects with style message and no record', async () => {
    await expect(
      startGeneration(req({ styleId: 'nope' }), deps()),
    ).rejects.toMatchObject({ name: 'UserError', message: 'Lütfen bir tarz seçin.' });
    await expect(fs.access(dataPath('history.json'))).rejects.toThrow();
  });

  describe('cinematic', () => {
    const NOT_CONNECTED = 'Magnific hesabı bağlı değil. Üstteki "Magnific ile bağlan" düğmesine basın.';

    it('passes resolution and only set controls to the provider and persists them', async () => {
      const seen: { cinematic: unknown; resolution: unknown }[] = [];
      const seeds: number[] = [];
      const provider: ImageProvider = {
        generate: async (i) => {
          seen.push({ cinematic: i.cinematic, resolution: i.resolution });
          seeds.push(i.seed);
          return ['http://x/img'];
        },
      };
      const cinematic = { lighting: 'golden-hour', shotType: 'Auto', camera: 'sony-fx9', halation: 'none' };
      const set = { lighting: 'golden-hour', camera: 'sony-fx9', halation: 'none' };
      const rec = await startGeneration(req({ cinematic, resolution: '4k' }), deps({ provider }));
      const done = await settle(rec.id);
      expect(done.status).toBe('done');
      expect(done.cinematic).toEqual(set);
      expect(done.resolution).toBe('4k');
      expect(seen).toEqual([
        { cinematic: set, resolution: '4k' },
        { cinematic: set, resolution: '4k' },
      ]);
      expect(new Set(seeds).size).toBe(2);
    });

    it('defaults a missing resolution to 2k', async () => {
      const seen: unknown[] = [];
      const provider: ImageProvider = {
        generate: async (i) => {
          seen.push(i.resolution);
          return ['http://x/img'];
        },
      };
      const rec = await startGeneration(req({ count: 1, resolution: undefined }), deps({ provider }));
      expect((await settle(rec.id)).resolution).toBe('2k');
      expect(seen).toEqual(['2k']);
    });

    it('not connected: rejects with the Turkish message and no record', async () => {
      await expect(startGeneration(req(), deps({ isConnected: async () => false }))).rejects.toMatchObject({
        name: 'UserError',
        message: NOT_CONNECTED,
      });
      await expect(fs.access(dataPath('history.json'))).rejects.toThrow();
    });

    it.each([
      ['unknown control value', { lighting: 'disco' }],
      ['value of another control', { grain: 'kodak-portra-400' }],
      ['unknown key', { iso: '800' }],
      ['prototype key', JSON.parse('{"__proto__": "x"}')],
      ['non-object', 'golden-hour'],
      ['array', ['golden-hour']],
      ['number value', { focalLength: 35 }],
    ])('rejects invalid cinematic (%s) with no record', async (_n, cinematic) => {
      await expect(
        startGeneration(req({ cinematic } as unknown as Partial<GenerationRequest>), deps()),
      ).rejects.toMatchObject({ name: 'UserError', message: 'Geçersiz istek.' });
      await expect(fs.access(dataPath('history.json'))).rejects.toThrow();
    });
  });

  it('sweep threshold exceeds the worst-case variation duration', () => {
    expect(STALE_MS).toBeGreaterThan(MAX_VARIATION_MS);
  });

  it('asset creation sits inside the generate budget that MAX_VARIATION_MS already counts', () => {
    expect(ASSET_PREP_MS).toBeGreaterThanOrEqual(API_TIMEOUT_MS);
    expect(ASSET_PREP_MS).toBeLessThan(API_TIMEOUT_MS + WAIT_TIMEOUT_MS);
    expect(MAX_VARIATION_MS).toBeGreaterThanOrEqual(API_TIMEOUT_MS + WAIT_TIMEOUT_MS);
  });
});
