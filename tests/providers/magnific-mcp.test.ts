import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserError } from '@/lib/images/process';
import { NOT_CONNECTED_MSG, type McpSession } from '@/lib/magnific-mcp/client';
import { API_TIMEOUT_MS } from '@/lib/magnific/client';
import { STALE_MS } from '@/lib/storage/history';
import {
  assetName,
  buildGenerateArgs,
  createMcpProvider,
  mentionProducts,
  PENDING_DELETES_FILE,
  type McpProviderDeps,
} from '@/lib/providers/magnific-mcp';
import { dataPath } from '@/lib/storage/paths';

type Call = { name: string; args: Record<string, unknown>; timeoutMs: number };

interface FakeOpts {
  /** Each item is returned in turn (the last repeats); an Error item is thrown instead. */
  waits?: unknown[];
  generate?: unknown;
  get?: unknown;
  /** Like waits, for creations_get. Overrides `get`. */
  gets?: unknown[];
  finalize?: (n: number) => unknown;
  /** library_create result for the n-th call (default `{ id: 100 + n, name }`); an Error is thrown. */
  libraryCreate?: (n: number, args: Record<string, unknown>) => unknown;
  /** library_delete result (default `{ success: true }`); an Error is thrown. */
  libraryDelete?: (args: Record<string, unknown>) => unknown;
  /** When set, these tools never answer (until their timeout). */
  hang?: string[];
  /** Each library_delete takes this long (to measure concurrency). */
  deleteDelayMs?: number;
}

const LIBRARY_HINT = ' Görsel Magnific kütüphanenizde olabilir; tekrar üretmeden önce oraya bakın.';
const CONN_MSG = "Magnific'e bağlanılamadı, internet bağlantınızı kontrol edin.";
const TIMEOUT_MSG = 'Magnific yanıt vermedi (zaman aşımı).';
const RATE_MSG = 'Magnific istek sınırına ulaşıldı, biraz sonra tekrar deneyin.';
const FAILED_MSG = 'Magnific üretimi başarısız oldu.';
const pick = (list: unknown[], i: number) => {
  const v = list[Math.min(i, list.length - 1)];
  if (v instanceof Error) throw v;
  return v;
};

// Exact live shapes (verified on the owner's account, 2026-11-18).
const liveCreate = (id: number, name: string) => ({
  id,
  identifier: '3V2oKREYbZ',
  name,
  type: 'product',
  description: 'Test kanepe (Mobilya Görsel Stüdyosu geçici ürün)',
  preview: 'https://cdn.example/preview.png?token=x',
  owned: true,
  source: 'mine',
  isLora: false,
  manage: true,
  webUrl: 'https://www.magnific.com/app/library/' + id,
});
const liveDelete = (id: number) => ({ id, name: 'mgs-verify01-test-kanepe', deleted: true });

function fake(opts: FakeOpts = {}) {
  const calls: Call[] = [];
  const puts: { url: string; body: Buffer }[] = [];
  let uploads = 0;
  let finals = 0;
  let waitIdx = 0;
  let getIdx = 0;
  let creates = 0;
  let deletesInFlight = 0;
  let maxDeletesInFlight = 0;
  const closed = vi.fn(async () => {});
  const session: McpSession = {
    async callTool(name, args, timeoutMs) {
      calls.push({ name, args, timeoutMs });
      if (opts.hang?.includes(name)) {
        await new Promise((r) => setTimeout(r, timeoutMs));
        throw new UserError(TIMEOUT_MSG);
      }
      const ret = (v: unknown) => {
        if (v instanceof Error) throw v;
        return v;
      };
      switch (name) {
        case 'library_create': {
          const n = creates++;
          return ret(opts.libraryCreate ? opts.libraryCreate(n, args) : liveCreate(100 + n, args.name as string));
        }
        case 'library_delete': {
          deletesInFlight++;
          maxDeletesInFlight = Math.max(maxDeletesInFlight, deletesInFlight);
          try {
            if (opts.deleteDelayMs) await new Promise((r) => setTimeout(r, opts.deleteDelayMs));
            return ret(opts.libraryDelete ? opts.libraryDelete(args) : liveDelete(args.id as number));
          } finally {
            deletesInFlight--;
          }
        }
        case 'creations_request_upload': {
          const n = uploads++;
          return { proxyUploadUrl: `https://up/${n}`, path: `tmp/${n}.jpg`, mimeType: 'image/jpeg' };
        }
        case 'creations_finalize_upload': {
          const n = finals++;
          return ret(opts.finalize ? opts.finalize(n) : { identifier: `ref-${(args as { path: string }).path}` });
        }
        case 'images_generate':
          return opts.generate ?? { creations: [{ identifier: 'gen-1', status: 'in_progress' }] };
        case 'creations_wait': {
          const w = opts.waits ?? [{ creations: [{ identifier: 'gen-1', status: 'completed' }] }];
          return pick(w, waitIdx++);
        }
        case 'creations_get':
          if (opts.gets) return pick(opts.gets, getIdx++);
          return opts.get ?? { creations: [{ identifier: 'gen-1', url: 'https://cdn/full.jpg' }] };
        default:
          throw new Error('unexpected tool ' + name);
      }
    },
    close: closed,
  };
  const sleeps: number[] = [];
  const deps: McpProviderDeps = {
    openSession: vi.fn(async () => session),
    putUpload: vi.fn(async (url: string, body: Buffer) => {
      puts.push({ url, body });
    }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { calls, puts, deps, closed, sleeps, maxDeletes: () => maxDeletesInFlight, provider: createMcpProvider(deps) };
}

const A = Buffer.from('product-bytes').toString('base64');
const A2 = Buffer.from('product-side-bytes').toString('base64');
const C = Buffer.from('table-bytes').toString('base64');
const B = Buffer.from('space-bytes').toString('base64');
const input = (over: Record<string, unknown> = {}) => ({
  prompt: 'Keep {{P1}} as is.',
  resolution: '2k' as const,
  products: [{ name: 'Koltuk', images: [A] }],
  space: B,
  aspect: '4:5' as const,
  seed: 7,
  ...over,
});
const named = (f: ReturnType<typeof fake>, name: string) => f.calls.filter((c) => c.name === name);
type PendingRow = { id: number | null; name?: string; attempts?: number; since?: string; active?: boolean; needsLookup?: boolean };
const pending = async () => {
  try {
    return JSON.parse(await fs.readFile(dataPath(PENDING_DELETES_FILE), 'utf8')) as PendingRow[];
  } catch {
    return [];
  }
};
const writePending = (rows: PendingRow[]) => fs.writeFile(dataPath(PENDING_DELETES_FILE), JSON.stringify(rows));
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
/** Older than STALE_MS + the finish budget: an active entry this old is orphaned. */
const ORPHAN_AGE = STALE_MS + 2 * API_TIMEOUT_MS + 60_000;
const ASSET_NAME = /^mgs-[a-z0-9]{8}-[a-z0-9-]+$/;

beforeEach(async () => {
  process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'mgs-prov-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('buildGenerateArgs', () => {
  it('builds cinematic args per aspect and resolution, product references first, omitting Auto controls', () => {
    expect(
      buildGenerateArgs({
        prompt: 'p',
        aspect: '21:9',
        resolution: '4k',
        seed: 5,
        productIds: [41, 42],
        space: 'space',
        cinematic: { lighting: 'golden-hour', shotType: 'Auto', focalLength: undefined },
      }),
    ).toEqual({
      prompt: 'p',
      mode: 'cinematic',
      aspectRatio: '21:9',
      resolution: '4k',
      count: 1,
      seed: 5,
      references: [
        { type: 'product', identifier: '41' },
        { type: 'product', identifier: '42' },
        { type: 'image', identifier: 'space' },
      ],
      extraSettings: { cinematicControls: { lighting: 'golden-hour' } },
    });
  });

  it('has no image reference without a space', () => {
    expect(buildGenerateArgs({ prompt: 'p', aspect: '1:1', resolution: '2k', seed: 1, productIds: [7] }).references).toEqual([
      { type: 'product', identifier: '7' },
    ]);
  });

  it('forwards every set control of all twelve', () => {
    const all = {
      camera: 'sony-fx9',
      lensBrand: 'cooke-s4',
      focalLength: '14mm',
      aperture: 'f/2.8',
      shotType: 'worms-eye',
      filmStock: 'polaroid-600',
      movieLook: '1917',
      lighting: 'neon',
      motionBlur: 'none',
      grain: '16mm-coarse',
      halation: 'none',
      tonalLook: 'kodak-double-x',
    };
    const args = buildGenerateArgs({ prompt: 'p', aspect: '1:1', resolution: '2k', seed: 1, productIds: [1], cinematic: all });
    expect(args.resolution).toBe('2k');
    expect(args.extraSettings).toEqual({ cinematicControls: all });
  });

  it('omits extraSettings when every control is Auto or unset, and clamps the seed', () => {
    const args = buildGenerateArgs({
      prompt: 'p',
      aspect: '1:1',
      resolution: '2k',
      seed: 2 ** 32 - 2,
      productIds: [1],
      cinematic: { lighting: 'Auto', camera: 'Auto', focalLength: 'Auto' },
    });
    expect(args).not.toHaveProperty('extraSettings');
    expect(args.aspectRatio).toBe('1:1');
    expect(args.seed).toBeGreaterThanOrEqual(0);
    expect(args.seed).toBeLessThanOrEqual(2147483647);
    expect(
      buildGenerateArgs({ prompt: 'p', aspect: '4:5', resolution: '2k', seed: 1, productIds: [1] }),
    ).not.toHaveProperty('extraSettings');
  });
});

describe('mentionProducts / assetName', () => {
  it('replaces each {{Pn}} with @<asset name>', () => {
    expect(mentionProducts('a {{P1}} b {{P2}} c {{P1}}', ['mgs-1-koltuk', 'mgs-2-sehpa'])).toBe(
      'a @mgs-1-koltuk b @mgs-2-sehpa c @mgs-1-koltuk',
    );
  });

  it('names are mgs-<8 random [a-z0-9]>-<slug>, at most 50 chars of [a-zA-Z0-9_-]', () => {
    expect(assetName('Koltuk')).toMatch(/^mgs-[a-z0-9]{8}-koltuk$/);
    expect(assetName('Çay Masası (ceviz)')).toMatch(/^mgs-[a-z0-9]{8}-cay-masasi-ceviz$/);
    expect(assetName('Işıklı Şifonyer Ğ Ü Ö İ')).toMatch(/^mgs-[a-z0-9]{8}-isikli-sifonyer-g-u-o-i$/);
    expect(assetName('***')).toMatch(/^mgs-[a-z0-9]{8}-urun$/);
    const long = assetName('ü'.repeat(40));
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(long.endsWith('-')).toBe(false);
    expect(assetName('Koltuk')).not.toBe(assetName('Koltuk'));
  });
});

describe('MCP provider', () => {
  it('uploads, creates one product asset, generates with product-first references and the @name, returns full-res urls', async () => {
    const f = fake();
    const urls = await f.provider.generate(
      input({ resolution: '4k', cinematic: { focalLength: '35mm', camera: 'Auto', grain: '16mm-coarse' } }),
    );
    expect(urls).toEqual(['https://cdn/full.jpg']);
    expect(f.calls.map((c) => c.name).sort()).toEqual(
      [
        'creations_request_upload',
        'creations_finalize_upload',
        'creations_request_upload',
        'creations_finalize_upload',
        'library_create',
        'images_generate',
        'creations_wait',
        'creations_get',
      ].sort(),
    );
    const order = f.calls.map((c) => c.name);
    expect(order.indexOf('library_create')).toBeGreaterThan(order.lastIndexOf('creations_finalize_upload'));
    expect(order.indexOf('images_generate')).toBeGreaterThan(order.indexOf('library_create'));
    expect(named(f, 'creations_request_upload')[0].args).toEqual({ mimeType: 'image/jpeg' });
    expect(f.puts.map((p) => p.body.toString()).sort()).toEqual(['product-bytes', 'space-bytes']);
    for (const fin of named(f, 'creations_finalize_upload')) {
      expect(fin.args).toMatchObject({ visible: false });
      expect(typeof fin.args.fileName).toBe('string');
    }
    const productRef = `ref-tmp/${f.puts.findIndex((p) => p.body.toString() === 'product-bytes')}.jpg`;
    const spaceRef = `ref-tmp/${f.puts.findIndex((p) => p.body.toString() === 'space-bytes')}.jpg`;

    const [create] = named(f, 'library_create');
    expect(create.args).toEqual({
      type: 'product',
      name: expect.stringMatching(ASSET_NAME),
      images: [{ creationIdentifier: productRef }],
      description: 'Koltuk (Mobilya Görsel Stüdyosu geçici ürün)',
    });
    expect(String(create.args.name)).toMatch(/-koltuk$/);

    const gen = named(f, 'images_generate')[0].args;
    expect(gen).toMatchObject({
      prompt: `Keep @${create.args.name} as is.`,
      mode: 'cinematic',
      aspectRatio: '4:5',
      resolution: '4k',
      count: 1,
      seed: 7,
      references: [
        { type: 'product', identifier: '100' },
        { type: 'image', identifier: spaceRef },
      ],
      extraSettings: { cinematicControls: { focalLength: '35mm', grain: '16mm-coarse' } },
    });
    expect(named(f, 'creations_wait')[0].args).toEqual({ identifiers: ['gen-1'], timeoutSeconds: 55 });
    expect(named(f, 'creations_get')[0].args).toEqual({ identifiers: ['gen-1'] });
    // one session for the assets, one for the variation
    expect(f.closed).toHaveBeenCalledTimes(2);
    expect(named(f, 'library_delete')).toHaveLength(0);
  });

  it('without a space there is no image reference', async () => {
    const f = fake();
    await f.provider.generate(input({ space: undefined }));
    expect(named(f, 'images_generate')[0].args.references).toEqual([{ type: 'product', identifier: '100' }]);
    expect(f.puts).toHaveLength(1);
  });

  it('several products, several angles, count 3: each asset created once, shared, product-first then space', async () => {
    const f = fake();
    const products = [
      { name: 'Koltuk', images: [A, A2] },
      { name: 'Sehpa', images: [C] },
    ];
    const prompt = 'Keep {{P1}} and {{P2}}.';
    const results = await Promise.all(
      [1, 2, 3].map((seed) => f.provider.generate(input({ products, prompt, seed }))),
    );
    expect(results).toEqual([['https://cdn/full.jpg'], ['https://cdn/full.jpg'], ['https://cdn/full.jpg']]);
    expect(f.puts.map((p) => p.body.toString()).sort()).toEqual(['product-bytes', 'product-side-bytes', 'space-bytes', 'table-bytes']);
    const creates = named(f, 'library_create');
    expect(creates).toHaveLength(2);
    const ref = (body: string) => `ref-tmp/${f.puts.findIndex((p) => p.body.toString() === body)}.jpg`;
    const byName = (n: string) => creates.find((c) => String(c.args.name).endsWith('-' + n))!;
    expect(byName('koltuk').args.images).toEqual([
      { creationIdentifier: ref('product-bytes') },
      { creationIdentifier: ref('product-side-bytes') },
    ]);
    expect(byName('sehpa').args.images).toEqual([{ creationIdentifier: ref('table-bytes') }]);
    const idOf = (n: string) => String(100 + creates.indexOf(byName(n)));
    const gens = named(f, 'images_generate');
    expect(gens).toHaveLength(3);
    for (const g of gens) {
      expect(g.args.references).toEqual([
        { type: 'product', identifier: idOf('koltuk') },
        { type: 'product', identifier: idOf('sehpa') },
        { type: 'image', identifier: ref('space-bytes') },
      ]);
      expect(g.args.prompt).toBe(`Keep @${byName('koltuk').args.name} and @${byName('sehpa').args.name}.`);
    }
    expect(new Set(gens.map((g) => g.args.seed))).toEqual(new Set([1, 2, 3]));
  });

  it('a photo used by two products is uploaded once', async () => {
    const f = fake();
    await f.provider.generate(input({ products: [{ name: 'A', images: [A] }, { name: 'B', images: [A, C] }], space: undefined }));
    expect(f.puts).toHaveLength(2);
    expect(named(f, 'library_create')).toHaveLength(2);
  });

  it('parses the exact live library_create result', async () => {
    const f = fake({ libraryCreate: () => liveCreate(2501708, 'mgs-verify01-test-kanepe') });
    await f.provider.generate(input());
    const gen = named(f, 'images_generate')[0].args;
    expect((gen.references as unknown[])[0]).toEqual({ type: 'product', identifier: '2501708' });
    expect(gen.prompt).toBe('Keep @mgs-verify01-test-kanepe as is.');
  });

  it.each([
    ['id as a numeric string', { id: '55', name: 'mgs-server-name' }, '55', 'mgs-server-name'],
    ['nested under library', { library: { id: 56, name: 'mgs-nested' } }, '56', 'mgs-nested'],
    ['nested under data with libraryId', { data: { libraryId: 57 } }, '57', undefined],
    ['YAML-like text', { text: 'library:\n  id: 58\n  name: mgs-text\n  type: product' }, '58', 'mgs-text'],
  ])('library_create result: %s', async (_n, result, id, name) => {
    const f = fake({ libraryCreate: () => result });
    await f.provider.generate(input());
    const gen = named(f, 'images_generate')[0].args;
    expect((gen.references as { identifier: string }[])[0]).toEqual({ type: 'product', identifier: id });
    const sent = named(f, 'library_create')[0].args.name;
    expect(gen.prompt).toBe(`Keep @${name ?? sent} as is.`);
  });

  it('logs a credits field of library_create (live: free, so normally absent)', async () => {
    const f = fake({ libraryCreate: (n, args) => ({ id: 100 + n, name: args.name, credits: 0 }) });
    await f.provider.generate(input());
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).toContain('library_create kredi: 0');
  });

  it('an unexpected library_create shape is a redacted UserError and nothing is generated', async () => {
    const f = fake({ libraryCreate: () => ({ ok: true, link: 'https://secret.example/lib?token=abc' }) });
    const err = await f.provider.generate(input()).catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toContain('beklenmeyen yanıt');
    expect(err.message).toContain('library_create');
    expect(err.message).not.toContain('secret.example');
    expect(err.message).not.toContain('kütüphanenizde');
    expect(named(f, 'images_generate')).toHaveLength(0);
  });

  it('accepts identifiers under other plausible keys', async () => {
    const f = fake({
      finalize: () => ({ creations: [{ identifier: 'c1' }] }),
      generate: { identifiers: ['g1'] },
      waits: [[{ identifier: 'g1', status: 'COMPLETED' }]],
      get: { identifier: 'g1', url: 'https://cdn/g1.jpg' },
    });
    expect(await f.provider.generate(input({ space: undefined }))).toEqual(['https://cdn/g1.jpg']);
    expect(named(f, 'library_create')[0].args.images).toEqual([{ creationIdentifier: 'c1' }]);
  });

  it('keeps waiting while in progress, respecting poll_after_seconds', async () => {
    const f = fake({
      waits: [
        { creations: [{ identifier: 'gen-1', status: 'in_progress', poll_after_seconds: 4 }] },
        { creations: [{ identifier: 'gen-1', status: 'processing' }] },
        { creations: [{ identifier: 'gen-1', status: 'completed' }] },
      ],
    });
    expect(await f.provider.generate(input())).toEqual(['https://cdn/full.jpg']);
    expect(f.calls.filter((c) => c.name === 'creations_wait')).toHaveLength(3);
    expect(f.sleeps[0]).toBe(4000);
  });

  it('a failed creation becomes a UserError (credits spent: with the library hint)', async () => {
    const f = fake({ waits: [{ creations: [{ identifier: 'gen-1', status: 'failed' }] }] });
    await expect(f.provider.generate(input())).rejects.toMatchObject({
      name: 'UserError',
      message: FAILED_MSG + LIBRARY_HINT,
    });
    // the asset session and the variation session are both closed
    expect(f.closed).toHaveBeenCalledTimes(2);
  });

  it('an unexpected result shape becomes a UserError with a short redacted excerpt', async () => {
    const f = fake({ generate: { weird: 'https://secret.example/x', other: 1 } });
    const err = await f.provider.generate(input()).catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect(err.message).toContain('images_generate');
    expect(err.message).toContain('weird');
    expect(err.message).not.toContain('secret.example');
    expect(err.message.length).toBeLessThan(300);
  });

  it('missing url in creations_get becomes a UserError', async () => {
    const f = fake({ get: { creations: [{ identifier: 'gen-1' }] } });
    await expect(f.provider.generate(input())).rejects.toBeInstanceOf(UserError);
  });

  describe('live result shapes (creations_wait carries the url)', () => {
    const FULL = 'https://pikaso.cdnpk.net/private/production/6078691745/render.png?token=exp=1~hmac=full';
    const THUMB = 'https://pikaso.cdnpk.net/private/production/6078691745/render-preview.png?token=t';
    const PREVIEW = 'https://pikaso.cdnpk.net/private/production/6078691745/render.png?token=p&w=1024&preview=1';
    const liveWait = (id: string, url?: string) => ({
      identifier: id,
      status: 'completed',
      results: url ? { url, thumbnailUrl: THUMB, previewUrl: PREVIEW } : { thumbnailUrl: THUMB, previewUrl: PREVIEW },
    });
    const liveGenerate = (...ids: string[]) => ({
      creations: ids.map((identifier) => ({
        identifier,
        status: 'queued',
        expectTime: 42,
        tool: 'text-to-image',
        credits: 75,
        webUrl: 'https://www.magnific.com/app/creation/' + identifier,
        mode: 'cinematic',
      })),
      instruction: 'wait',
      placement: {},
    });
    const yamlItem = (id: string, url: string, indent: string) =>
      [
        `identifier: ${id}`,
        'name: Keep the furniture product image',
        'family: a3410c0e-1',
        'tool: text-to-image',
        'status: completed',
        `url: "${url}"`,
        `thumbnailUrl: "${THUMB}"`,
        `previewUrl: "${PREVIEW}"`,
        'createdAt: "2026-11-18T10:28:25+00:00"',
        'metadata:',
        '  prompt: "p"',
        '  width: 832',
        '  height: 1024',
        '  url: "https://nested.example/meta.png"',
        'webUrl: "https://www.magnific.com/app/creation/' + id + '?x=1"',
      ].map((l, i) => (i === 0 ? indent + '- ' + l : indent + '  ' + l));
    const listYaml = (items: [string, string][]) =>
      ['creations[' + items.length + ']:', ...items.flatMap(([id, url]) => yamlItem(id, url, '  '))].join('\n');
    const singleYaml = (id: string, url: string) =>
      yamlItem(id, url, '')
        .map((l, i) => (i === 0 ? l.replace(/^- /, '') : l.replace(/^ {2}/, '')))
        .join('\n');

    it('takes results.url from the completed wait and never calls creations_get', async () => {
      const f = fake({
        generate: liveGenerate('SymqW53Ub8'),
        waits: [{ results: [liveWait('SymqW53Ub8', FULL)], allTerminal: true }],
        finalize: (n) => ({ identifier: `ref${n}`, status: 'completed', placement: {} }),
      });
      expect(await f.provider.generate(input())).toEqual([FULL]);
      expect(f.calls.map((c) => c.name)).not.toContain('creations_get');
    });

    it('returns urls in requested identifier order even when wait lists them differently', async () => {
      const f = fake({
        generate: liveGenerate('A1', 'B2'),
        waits: [{ results: [liveWait('B2', 'https://cdn/b.png'), liveWait('A1', 'https://cdn/a.png')], allTerminal: true }],
      });
      expect(await f.provider.generate(input())).toEqual(['https://cdn/a.png', 'https://cdn/b.png']);
      expect(f.calls.map((c) => c.name)).not.toContain('creations_get');
    });

    it('falls back to creations_get (YAML list form) when wait has no url, using the top-level url only', async () => {
      const f = fake({
        generate: liveGenerate('SymqW53Ub8'),
        waits: [{ results: [liveWait('SymqW53Ub8')], allTerminal: true }],
        get: { text: listYaml([['SymqW53Ub8', FULL]]) },
      });
      expect(await f.provider.generate(input())).toEqual([FULL]);
      const get = f.calls.filter((c) => c.name === 'creations_get');
      expect(get).toHaveLength(1);
      expect(get[0].args).toEqual({ identifiers: ['SymqW53Ub8'] });
    });

    it('falls back to creations_get (single unwrapped YAML form)', async () => {
      const f = fake({
        generate: liveGenerate('SymqW53Ub8'),
        waits: [{ results: [liveWait('SymqW53Ub8')], allTerminal: true }],
        get: { text: singleYaml('SymqW53Ub8', FULL) },
      });
      expect(await f.provider.generate(input())).toEqual([FULL]);
    });

    it('fallback only asks for the identifiers missing a url and keeps requested order', async () => {
      const f = fake({
        generate: liveGenerate('A1', 'B2'),
        waits: [{ results: [liveWait('B2', 'https://cdn/b.png'), liveWait('A1')], allTerminal: true }],
        get: { text: listYaml([['A1', 'https://cdn/a.png']]) },
      });
      expect(await f.provider.generate(input())).toEqual(['https://cdn/a.png', 'https://cdn/b.png']);
      expect(f.calls.find((c) => c.name === 'creations_get')?.args).toEqual({ identifiers: ['A1'] });
    });

    it('fallback also accepts a JSON creations_get', async () => {
      const f = fake({
        generate: liveGenerate('A1'),
        waits: [{ results: [liveWait('A1')], allTerminal: true }],
        get: { creations: [{ identifier: 'A1', url: FULL, previewUrl: PREVIEW }] },
      });
      expect(await f.provider.generate(input())).toEqual([FULL]);
    });

    it('YAML text with no top-level url is an unexpected-response UserError', async () => {
      const f = fake({
        generate: liveGenerate('A1'),
        waits: [{ results: [liveWait('A1')], allTerminal: true }],
        get: { text: 'creations[1]:\n  - identifier: A1\n    previewUrl: "https://x/p.png"\n    metadata:\n      url: "https://x/m.png"' },
      });
      const err = await f.provider.generate(input()).catch((e) => e);
      expect(err).toBeInstanceOf(UserError);
      expect(err.message).toContain('creations_get');
    });

    it('a failed status in the live wait shape gives the Turkish failure message', async () => {
      const f = fake({
        generate: liveGenerate('A1'),
        waits: [{ results: [{ identifier: 'A1', status: 'failed' }], allTerminal: true }],
      });
      await expect(f.provider.generate(input())).rejects.toMatchObject({
        name: 'UserError',
        message: FAILED_MSG + LIBRARY_HINT,
      });
    });

    it('does not treat the inner results object as an entry list while still pending', async () => {
      const f = fake({
        generate: liveGenerate('A1'),
        waits: [
          { results: [{ identifier: 'A1', status: 'in_progress', results: {} }], allTerminal: false },
          { results: [liveWait('A1', FULL)], allTerminal: true },
        ],
      });
      expect(await f.provider.generate(input())).toEqual([FULL]);
      expect(f.calls.filter((c) => c.name === 'creations_wait')).toHaveLength(2);
    });
  });

  it('times out with the Turkish timeout message when never terminal', async () => {
    const f = fake({ waits: [{ creations: [{ identifier: 'gen-1', status: 'in_progress' }] }] });
    const p = createMcpProvider({ ...f.deps, budgetMs: 50, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) });
    await expect(p.generate(input())).rejects.toThrow('Magnific yanıt vermedi (zaman aşımı).');
  });

  it('not connected: propagates the exact Turkish message', async () => {
    const f = fake();
    const p = createMcpProvider({
      ...f.deps,
      openSession: async () => {
        throw new UserError(NOT_CONNECTED_MSG);
      },
    });
    await expect(p.generate(input())).rejects.toThrow(
      'Magnific hesabı bağlı değil. Üstteki "Magnific ile bağlan" düğmesine basın.',
    );
  });

  it('uploads each distinct ref once across concurrent variations of one provider', async () => {
    const f = fake();
    await Promise.all([f.provider.generate(input({ seed: 1 })), f.provider.generate(input({ seed: 2 }))]);
    expect(f.calls.filter((c) => c.name === 'creations_request_upload')).toHaveLength(2);
    expect(f.puts).toHaveLength(2);
    expect(f.calls.filter((c) => c.name === 'library_create')).toHaveLength(1);
    expect(f.calls.filter((c) => c.name === 'images_generate')).toHaveLength(2);
  });

  it('hanging asset creation is bounded by the generate budget', async () => {
    const f = fake({ hang: ['library_create'] });
    const p = createMcpProvider({ ...f.deps, budgetMs: 60 });
    const started = Date.now();
    await expect(p.generate(input())).rejects.toThrow(TIMEOUT_MSG);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(named(f, 'images_generate')).toHaveLength(0);
    await p.finish!();
  });

  describe('after images_generate succeeded (credits spent)', () => {
    const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));
    const done = { creations: [{ identifier: 'gen-1', status: 'completed' }] };
    const count = (f: ReturnType<typeof fake>, name: string) => f.calls.filter((c) => c.name === name).length;

    it('retries creations_wait after one transient error, then returns the url; generate ran once', async () => {
      const f = fake({ waits: [new UserError(CONN_MSG), done] });
      expect(await f.provider.generate(input())).toEqual(['https://cdn/full.jpg']);
      expect(count(f, 'images_generate')).toBe(1);
      expect(count(f, 'creations_wait')).toBe(2);
      expect(f.sleeps[0]).toBe(2000);
    });

    it.each([
      ['connection', CONN_MSG],
      ['timeout', TIMEOUT_MSG],
      ['429', RATE_MSG],
      ['5xx', 'Magnific hatası (502)'],
    ])('treats a %s error as transient', async (_n, msg) => {
      const f = fake({ waits: [new UserError(msg), done] });
      expect(await f.provider.generate(input())).toEqual(['https://cdn/full.jpg']);
      expect(count(f, 'creations_wait')).toBe(2);
    });

    it('backs off 2s, 4s, 8s, 8s between repeated transient errors', async () => {
      const e = new UserError(TIMEOUT_MSG);
      const f = fake({ waits: [e, e, e, e, done] });
      expect(await f.provider.generate(input())).toEqual(['https://cdn/full.jpg']);
      expect(f.sleeps).toEqual([2000, 4000, 8000, 8000]);
    });

    it('retries the creations_get fallback on a transient error', async () => {
      const f = fake({ gets: [new UserError(CONN_MSG), { creations: [{ identifier: 'gen-1', url: 'https://cdn/full.jpg' }] }] });
      expect(await f.provider.generate(input())).toEqual(['https://cdn/full.jpg']);
      expect(count(f, 'creations_get')).toBe(2);
      expect(count(f, 'images_generate')).toBe(1);
    });

    it('persistent transient errors fail at the deadline with the library hint', async () => {
      const f = fake({ waits: [new UserError(CONN_MSG)] });
      const p = createMcpProvider({ ...f.deps, budgetMs: 80, sleep: realSleep });
      const started = Date.now();
      const err = await p.generate(input()).catch((e) => e);
      expect(err).toBeInstanceOf(UserError);
      expect(err.message.endsWith(LIBRARY_HINT)).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(count(f, 'images_generate')).toBe(1);
      expect(count(f, 'creations_wait')).toBeGreaterThan(1);
    });

    it('allTerminal with a non-done status fails promptly instead of polling', async () => {
      const f = fake({
        generate: { creations: [{ identifier: 'A1', status: 'queued' }] },
        waits: [{ results: [{ identifier: 'A1', status: 'nsfw_blocked' }], allTerminal: true }],
      });
      // Bounded budget: without the allTerminal check this would poll until the deadline.
      const p = createMcpProvider({ ...f.deps, budgetMs: 300, sleep: realSleep });
      await expect(p.generate(input())).rejects.toMatchObject({ message: FAILED_MSG + LIBRARY_HINT });
      expect(count(f, 'creations_wait')).toBe(1);
    });

    it('allTerminal with an unknown status among done ones also fails', async () => {
      const f = fake({
        generate: { creations: [{ identifier: 'A1' }, { identifier: 'B2' }] },
        waits: [{ results: [{ identifier: 'A1', status: 'completed', results: { url: 'https://cdn/a' } }, { identifier: 'B2', status: 'weird' }], allTerminal: true }],
      });
      const p = createMcpProvider({ ...f.deps, budgetMs: 300, sleep: realSleep });
      await expect(p.generate(input())).rejects.toMatchObject({ message: FAILED_MSG + LIBRARY_HINT });
      expect(count(f, 'creations_wait')).toBe(1);
    });

    it('a FAILED status is not retried', async () => {
      const f = fake({ waits: [{ creations: [{ identifier: 'gen-1', status: 'failed' }] }, done] });
      await expect(f.provider.generate(input())).rejects.toMatchObject({ message: FAILED_MSG + LIBRARY_HINT });
      expect(count(f, 'creations_wait')).toBe(1);
      expect(f.sleeps).toEqual([]);
    });

    it.each([
      ['not-connected', NOT_CONNECTED_MSG],
      ['tool error', 'Magnific hatası: invalid identifier'],
      ['credit', 'Magnific krediniz yetersiz.'],
      ['4xx', 'Magnific hatası (400)'],
    ])('a non-transient %s error is not retried and carries the hint', async (_n, msg) => {
      const f = fake({ waits: [new UserError(msg), done] });
      await expect(f.provider.generate(input())).rejects.toMatchObject({ message: msg + LIBRARY_HINT });
      expect(count(f, 'creations_wait')).toBe(1);
    });

    it('an unexpected wait shape is not retried', async () => {
      const f = fake({ waits: [{ nothing: true }, done] });
      const err = await f.provider.generate(input()).catch((e) => e);
      expect(err.message).toContain('creations_wait');
      expect(err.message.endsWith(LIBRARY_HINT)).toBe(true);
      expect(count(f, 'creations_wait')).toBe(1);
    });

    it('a failure before images_generate succeeded has no library hint', async () => {
      const f = fake();
      const p = createMcpProvider({
        ...f.deps,
        putUpload: async () => {
          throw new UserError(CONN_MSG);
        },
      });
      await expect(p.generate(input())).rejects.toMatchObject({ message: CONN_MSG });
      expect(count(f, 'images_generate')).toBe(0);
    });
  });

  it.each([
    ['0 products', []],
    ['5 products', ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, images: [A] }))],
    ['a product without photos', [{ name: 'a', images: [] }]],
    ['7 photos', [{ name: 'a', images: [A, A, A, A, A, A, A] }]],
  ])('rejects %s before calling Magnific', async (_n, products) => {
    const f = fake();
    await expect(f.provider.generate(input({ products }))).rejects.toBeInstanceOf(UserError);
    expect(f.calls).toHaveLength(0);
  });
});

describe('finish(): temporary assets are deleted', () => {
  it('deletes every created asset after success, once, in its own session', async () => {
    const f = fake();
    const products = [
      { name: 'Koltuk', images: [A] },
      { name: 'Sehpa', images: [C] },
    ];
    await Promise.all([1, 2, 3].map((seed) => f.provider.generate(input({ products, seed }))));
    expect(named(f, 'library_delete')).toHaveLength(0);
    await f.provider.finish!();
    expect(named(f, 'library_delete').map((c) => c.args).sort((a, b) => Number(a.id) - Number(b.id))).toEqual([{ id: 100 }, { id: 101 }]);
    expect(await pending()).toEqual([]);
    await f.provider.finish!();
    expect(named(f, 'library_delete')).toHaveLength(2);
    expect(f.closed).toHaveBeenCalledTimes(1 + 3 + 1);
  });

  it('deletes after a failed variation too', async () => {
    const f = fake({ waits: [{ creations: [{ identifier: 'gen-1', status: 'failed' }] }] });
    await expect(f.provider.generate(input())).rejects.toMatchObject({ message: FAILED_MSG + LIBRARY_HINT });
    await f.provider.finish!();
    expect(named(f, 'library_delete').map((c) => c.args)).toEqual([{ id: 100 }]);
  });

  it('deletes the assets that were created when another library_create failed', async () => {
    const f = fake({ libraryCreate: (n, args) => (n === 1 ? new UserError('Magnific hatası: name taken') : { id: 100 + n, name: args.name }) });
    const err = await f.provider
      .generate(input({ products: [{ name: 'A', images: [A] }, { name: 'B', images: [C] }] }))
      .catch((e) => e);
    expect(err.message).toBe('Magnific hatası: name taken');
    await f.provider.finish!();
    expect(named(f, 'library_delete').map((c) => c.args)).toEqual([{ id: 100 }]);
  });

  it('a failed delete never throws, is recorded and retried at the next generation', async () => {
    const warn = vi.mocked(console.warn);
    const f1 = fake({ libraryDelete: () => new UserError('Magnific hatası (502)') });
    await f1.provider.generate(input());
    await expect(f1.provider.finish!()).resolves.toBeUndefined();
    expect(await pending()).toMatchObject([{ id: 100 }]);
    expect(warn).toHaveBeenCalled();

    const f2 = fake({ libraryCreate: (n, args) => liveCreate(200 + n, args.name as string) });
    await f2.provider.generate(input());
    // the retry no longer competes with the uploads: it is left to finish()
    expect(named(f2, 'library_delete')).toHaveLength(0);
    await f2.provider.finish!();
    expect(named(f2, 'library_delete').map((c) => Number(c.args.id)).sort()).toEqual([100, 200]);
    expect(await pending()).toEqual([]);
  });

  it('finish() also retries recorded deletes, even without a generation of its own', async () => {
    await fs.writeFile(dataPath(PENDING_DELETES_FILE), JSON.stringify([{ id: 7, name: 'mgs-old', attempts: 1 }]));
    const f = fake();
    await f.provider.finish!();
    expect(named(f, 'library_delete').map((c) => c.args)).toEqual([{ id: 7 }]);
    expect(await pending()).toEqual([]);
  });

  it('keeps everything pending when the connection is gone', async () => {
    const f = fake();
    await f.provider.generate(input());
    await fs.writeFile(dataPath(PENDING_DELETES_FILE), JSON.stringify([{ id: 7, name: 'mgs-old', attempts: 1 }]));
    const offline = createMcpProvider({
      ...f.deps,
      openSession: async () => {
        throw new UserError(NOT_CONNECTED_MSG);
      },
    });
    await expect(offline.finish!()).resolves.toBeUndefined();
    vi.mocked(f.deps.openSession).mockRejectedValue(new UserError(CONN_MSG));
    await expect(f.provider.finish!()).resolves.toBeUndefined();
    expect((await pending()).map((p) => p.id).sort()).toEqual([100, 7]);
  });

  it('an asset that is already gone is dropped from the pending list', async () => {
    await fs.writeFile(dataPath(PENDING_DELETES_FILE), JSON.stringify([{ id: 7, name: 'mgs-old', attempts: 1 }]));
    const f = fake({ libraryDelete: () => new UserError('Magnific hatası: Library item not found') });
    await f.provider.finish!();
    expect(await pending()).toEqual([]);
  });

  it('gives up on an asset after many failed attempts', async () => {
    await fs.writeFile(dataPath(PENDING_DELETES_FILE), JSON.stringify([{ id: 7, name: 'mgs-old', attempts: 19 }]));
    const f = fake({ libraryDelete: () => new UserError('Magnific hatası (502)') });
    await f.provider.finish!();
    expect(await pending()).toEqual([]);
    await fs.writeFile(dataPath(PENDING_DELETES_FILE), JSON.stringify([{ id: 8, name: 'mgs-old', attempts: 2 }]));
    await fake({ libraryDelete: () => new UserError('Magnific hatası (502)') }).provider.finish!();
    expect(await pending()).toMatchObject([{ id: 8, attempts: 3 }]);
  });

  // ---- fix round 1 ----

  it('the exact live library_delete result (deleted: true) counts as deleted; deleted: false stays pending', async () => {
    const f = fake();
    await f.provider.generate(input());
    await f.provider.finish!();
    expect(await pending()).toEqual([]);
    const g = fake({ libraryDelete: (args) => ({ id: args.id, name: 'x', deleted: false }) });
    await g.provider.generate(input());
    await g.provider.finish!();
    expect(await pending()).toMatchObject([{ id: 100, attempts: 1 }]);
    expect((await pending())[0].active).toBeUndefined();
  });

  it('records each asset as active right after library_create, removes it after the delete', async () => {
    const f = fake();
    await f.provider.generate(input());
    const rows = await pending();
    expect(rows).toEqual([
      { id: 100, name: expect.stringMatching(ASSET_NAME), attempts: 0, since: expect.any(String), active: true },
    ]);
    expect(Date.now() - Date.parse(rows[0].since!)).toBeLessThan(5_000);
    await f.provider.finish!();
    expect(await pending()).toEqual([]);
  });

  it('an asset survives a server restart in the pending file and is deleted once orphaned', async () => {
    const f = fake();
    await f.provider.generate(input());
    // "restart": the provider instance is gone, its finish() never runs; the entry ages
    const [row] = await pending();
    await writePending([{ ...row, since: ago(ORPHAN_AGE) }]);
    const g = fake();
    await g.provider.finish!();
    expect(named(g, 'library_delete').map((c) => c.args)).toEqual([{ id: 100 }]);
    expect(await pending()).toEqual([]);
  });

  it("a young active entry (another generation's asset in use) is skipped by retries", async () => {
    await writePending([{ id: 9, name: 'mgs-busy', attempts: 0, since: ago(60_000), active: true }]);
    const f = fake();
    await f.provider.generate(input());
    await f.provider.finish!();
    expect(named(f, 'library_delete').map((c) => c.args)).toEqual([{ id: 100 }]);
    expect(await pending()).toEqual([{ id: 9, name: 'mgs-busy', attempts: 0, since: expect.any(String), active: true }]);
    // nothing of its own and only a young active entry: no session at all
    const g = fake();
    await g.provider.finish!();
    expect(g.deps.openSession).not.toHaveBeenCalled();
  });

  it.each([
    ['a transport 404 (also an expired MCP session)', 'Magnific hatası (404)'],
    ['tool not found', 'Magnific hatası: Tool library_delete not found'],
    ['method not found (-32601)', 'Magnific hatası: MCP error -32601: Method not found'],
    ['an unrelated not-found', 'Magnific hatası: Not Found'],
  ])('%s keeps the id pending', async (_n, msg) => {
    await writePending([{ id: 7, name: 'mgs-old', attempts: 1, since: ago(1000) }]);
    await fake({ libraryDelete: () => new UserError(msg) }).provider.finish!();
    expect(await pending()).toMatchObject([{ id: 7, attempts: 2 }]);
  });

  it.each([
    ['Magnific hatası: Library item not found'],
    ['Magnific hatası: Library element 7 does not exist'],
    ['Magnific hatası: library item 7 was already deleted'],
  ])('an item-not-found tool error (%s) counts as gone', async (msg) => {
    await writePending([{ id: 7, name: 'mgs-old', attempts: 1, since: ago(1000) }]);
    await fake({ libraryDelete: () => new UserError(msg) }).provider.finish!();
    expect(await pending()).toEqual([]);
  });

  it('retries at most 5 recorded ids per run, at most 2 at a time', async () => {
    await writePending(Array.from({ length: 8 }, (_, i) => ({ id: 1 + i, name: `mgs-${i}`, attempts: 1, since: ago(1000) })));
    const f = fake({ deleteDelayMs: 10 });
    await f.provider.finish!();
    expect(named(f, 'library_delete').map((c) => c.args.id)).toEqual([1, 2, 3, 4, 5]);
    expect(f.maxDeletes()).toBeLessThanOrEqual(2);
    expect((await pending()).map((p) => p.id)).toEqual([6, 7, 8]);
  });

  it("a refused or hanging retry of old deletes neither blocks nor fails the generation, and sessions are closed", async () => {
    await writePending([{ id: 7, name: 'mgs-old', attempts: 1, since: ago(1000) }]);
    const RATE = 'Magnific istek sınırına ulaşıldı, biraz sonra tekrar deneyin.';
    const f = fake({ libraryDelete: () => new UserError(RATE) });
    expect(await f.provider.generate(input())).toEqual(['https://cdn/full.jpg']);
    await f.provider.finish!();
    // retried (and refused) once, by finish(); still pending
    expect((await pending()).find((p) => p.id === 7)).toMatchObject({ attempts: 2 });

    await writePending([{ id: 8, name: 'mgs-old', attempts: 1, since: ago(1000) }]);
    const h = fake({ hang: ['library_delete'] });
    const p = createMcpProvider({ ...h.deps, prepBudgetMs: 400, finishBudgetMs: 100 });
    const started = Date.now();
    expect(await p.generate(input())).toEqual(['https://cdn/full.jpg']);
    expect(Date.now() - started).toBeLessThan(300);
    await p.finish!();
    // the asset session (closed after its retry), the variation session and the finish session
    expect(h.closed).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['an unexpected shape', { libraryCreate: () => ({ ok: true }) }],
    ['a timeout', { hang: ['library_create'] }],
  ])('library_create with %s: the requested name is warned about and recorded for lookup', async (_n, opts) => {
    const warn = vi.mocked(console.warn);
    const f = fake(opts as FakeOpts);
    const p = createMcpProvider({ ...f.deps, prepBudgetMs: 100 });
    await expect(p.generate(input())).rejects.toBeInstanceOf(UserError);
    const requested = String(named(f, 'library_create')[0].args.name);
    expect(warn.mock.calls.flat().join(' ')).toContain(requested);
    expect(await pending()).toEqual([
      { id: null, name: requested, attempts: 0, since: expect.any(String), needsLookup: true },
    ]);
    // never retried (no id), never dropped
    await p.finish!();
    await fake().provider.finish!();
    expect(named(f, 'library_delete')).toHaveLength(0);
    expect(await pending()).toHaveLength(1);
  });

  it('a clear library_create tool error records nothing for lookup', async () => {
    const f = fake({ libraryCreate: () => new UserError('Magnific hatası: name already exists') });
    await expect(f.provider.generate(input())).rejects.toBeInstanceOf(UserError);
    expect(await pending()).toEqual([]);
  });

  it('a broken pending file does not break generation or finish()', async () => {
    await fs.writeFile(dataPath(PENDING_DELETES_FILE), '{not json');
    const f = fake();
    expect(await f.provider.generate(input())).toEqual(['https://cdn/full.jpg']);
    await expect(f.provider.finish!()).resolves.toBeUndefined();
    expect(named(f, 'library_delete').map((c) => c.args)).toEqual([{ id: 100 }]);
  });
});

describe('asset preparation retries (before any credits are spent)', () => {
  const noSpace = () => input({ space: undefined });

  it('a transient error on finalize is retried with a fresh upload URL: one asset, one PUT per URL', async () => {
    const f = fake({ finalize: (n) => (n === 0 ? new UserError(CONN_MSG) : { identifier: `ref-${n}` }) });
    expect(await f.provider.generate(noSpace())).toEqual(['https://cdn/full.jpg']);
    expect(named(f, 'creations_request_upload')).toHaveLength(2);
    expect(f.puts.map((p) => p.url)).toEqual(['https://up/0', 'https://up/1']);
    expect(named(f, 'library_create')).toHaveLength(1);
    expect(f.sleeps.length).toBeGreaterThan(0);
    await f.provider.finish!();
    expect(named(f, 'library_delete').map((c) => c.args)).toEqual([{ id: 100 }]);
  });

  it('a transient error on creations_request_upload is retried', async () => {
    const f = fake();
    const session = await f.deps.openSession(1_000);
    const orig = session.callTool;
    let failed = false;
    session.callTool = async (name: string, args: Record<string, unknown>, t: number) => {
      if (name === 'creations_request_upload' && !failed) {
        failed = true;
        throw new UserError('Magnific hatası (503)');
      }
      return orig(name, args, t);
    };
    expect(await f.provider.generate(noSpace())).toEqual(['https://cdn/full.jpg']);
    expect(failed).toBe(true);
    expect(f.puts).toHaveLength(1);
  });

  it('a non-transient error is not retried', async () => {
    const f = fake({ finalize: () => new UserError('Magnific hatası: bad image') });
    await expect(f.provider.generate(noSpace())).rejects.toMatchObject({ message: 'Magnific hatası: bad image' });
    expect(named(f, 'creations_finalize_upload')).toHaveLength(1);
    expect(named(f, 'creations_request_upload')).toHaveLength(1);
    expect(f.sleeps).toEqual([]);
  });

  it('RATE_MSG on library_create is retried: one asset in the end', async () => {
    const f = fake({ libraryCreate: (n, args) => (n === 0 ? new UserError(RATE_MSG) : liveCreate(100 + n, args.name as string)) });
    expect(await f.provider.generate(noSpace())).toEqual(['https://cdn/full.jpg']);
    expect(named(f, 'library_create')).toHaveLength(2);
    expect(await pending()).toMatchObject([{ id: 101, active: true }]);
    await f.provider.finish!();
    expect(named(f, 'library_delete').map((c) => c.args)).toEqual([{ id: 101 }]);
  });

  it('a timeout on library_create is not retried (it may exist)', async () => {
    const f = fake({ libraryCreate: () => new UserError(TIMEOUT_MSG) });
    await expect(f.provider.generate(noSpace())).rejects.toMatchObject({ message: TIMEOUT_MSG });
    expect(named(f, 'library_create')).toHaveLength(1);
  });

  it('persistent RATE_MSG on library_create gives up, creates no lookup row and no "elle silin" warning', async () => {
    const warn = vi.mocked(console.warn);
    const f = fake({ libraryCreate: () => new UserError(RATE_MSG) });
    await expect(f.provider.generate(noSpace())).rejects.toMatchObject({ message: RATE_MSG });
    expect(await pending()).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('elle silin');
  });
});

describe('needsLookup rows are pruned and deduplicated', () => {
  it('drops lookup rows older than 7 days and duplicates by name when the file is next written', async () => {
    const DAY = 24 * 3600_000;
    await writePending([
      { id: null, name: 'mgs-old00000-x', attempts: 0, since: ago(8 * DAY), needsLookup: true },
      { id: null, name: 'mgs-dup00000-y', attempts: 0, since: ago(2 * DAY), needsLookup: true },
      { id: null, name: 'mgs-dup00000-y', attempts: 0, since: ago(1 * DAY), needsLookup: true },
      { id: null, name: 'mgs-new00000-z', attempts: 0, since: ago(DAY / 2), needsLookup: true },
    ]);
    const f = fake();
    await f.provider.generate(input());
    const rows = await pending();
    expect(rows.filter((r) => r.needsLookup).map((r) => r.name)).toEqual(['mgs-dup00000-y', 'mgs-new00000-z']);
    expect(rows.filter((r) => r.id === 100)).toHaveLength(1);
  });

  it('recording the same lookup name twice keeps one row', async () => {
    const f = fake({ libraryCreate: () => ({ ok: true }) });
    const p = createMcpProvider({ ...f.deps, prepBudgetMs: 100 });
    await p.generate(input()).catch(() => undefined);
    const name = String(named(f, 'library_create')[0].args.name);
    await writePending([...(await pending()), { id: null, name, attempts: 0, since: ago(1000), needsLookup: true }]);
    const g = fake({ libraryCreate: () => ({ ok: true }) });
    await g.provider.generate(input()).catch(() => undefined);
    const rows = await pending();
    expect(new Set(rows.map((r) => r.name)).size).toBe(rows.length);
  });
});

describe('a timed-out paid variation keeps its assets', () => {
  it('after images_generate succeeded and the wait timed out, finish() keeps the rows (active) and deletes nothing', async () => {
    const f = fake({ hang: ['creations_wait'] });
    const p = createMcpProvider({ ...f.deps, budgetMs: 400 });
    await expect(p.generate(input())).rejects.toBeInstanceOf(UserError);
    expect(named(f, 'images_generate')).toHaveLength(1);
    await p.finish!();
    expect(named(f, 'library_delete')).toHaveLength(0);
    expect(await pending()).toMatchObject([{ id: 100, active: true }]);
    // not deleted by another generation's finish() while Magnific may still be rendering
    const g = fake();
    await g.provider.finish!();
    expect(named(g, 'library_delete')).toHaveLength(0);
    expect(await pending()).toHaveLength(1);
  });

  it('a failed (non-timeout) variation and a success still delete', async () => {
    const f1 = fake({ waits: [{ creations: [{ identifier: 'gen-1', status: 'failed' }] }] });
    await f1.provider.generate(input()).catch(() => undefined);
    await f1.provider.finish!();
    expect(named(f1, 'library_delete').map((c) => c.args)).toEqual([{ id: 100 }]);
    const f2 = fake();
    await f2.provider.generate(input());
    await f2.provider.finish!();
    expect(named(f2, 'library_delete').map((c) => c.args)).toEqual([{ id: 100 }]);
  });

  it('a timeout before images_generate succeeded still deletes', async () => {
    const f = fake({ hang: ['images_generate'] });
    const p = createMcpProvider({ ...f.deps, budgetMs: 400 });
    await expect(p.generate(input())).rejects.toBeInstanceOf(UserError);
    await p.finish!();
    expect(named(f, 'library_delete').map((c) => c.args)).toEqual([{ id: 100 }]);
  });
});
