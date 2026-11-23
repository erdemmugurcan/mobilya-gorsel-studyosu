import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createGeneration,
  getGeneration,
  listGenerations,
  sweepStale,
  updateOutput,
} from '@/lib/storage/history';
import { dataPath } from '@/lib/storage/paths';
import type { GenerationRequest } from '@/lib/types';

const req = (count: 1 | 2 | 3 | 4): GenerationRequest => ({
  products: [{ name: 'Koltuk', cutoutIds: ['c1', 'c2'] }],
  envMode: 'preset',
  styleId: 'modern',
  aspect: '1:1',
  count,
  model: 'cinematic',
  resolution: '2k',
});

beforeEach(async () => {
  process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'mgs-hist-'));
});

describe('history', () => {
  it('persists only known request fields', async () => {
    const rec = await createGeneration(
      { ...req(1), evil: 'x', __proto_junk: 1 } as unknown as GenerationRequest,
      'p',
    );
    expect(rec).not.toHaveProperty('evil');
    const stored = await getGeneration(rec.id);
    expect(stored).not.toHaveProperty('evil');
    expect(stored).not.toHaveProperty('__proto_junk');
    expect(stored).not.toHaveProperty('cutoutId');
    expect(stored).toMatchObject({
      products: [{ name: 'Koltuk', cutoutIds: ['c1', 'c2'] }],
      envMode: 'preset',
      styleId: 'modern',
      aspect: '1:1',
      count: 1,
      model: 'cinematic',
      resolution: '2k',
    });
  });

  it('persists only name and cutoutIds of each product', async () => {
    const rec = await createGeneration(
      {
        ...req(1),
        products: [
          { name: 'Koltuk', cutoutIds: ['a'], evil: 1 },
          { name: 'Sehpa', cutoutIds: ['b', 'c'] },
        ],
      } as unknown as GenerationRequest,
      'p',
    );
    expect((await getGeneration(rec.id))?.products).toEqual([
      { name: 'Koltuk', cutoutIds: ['a'] },
      { name: 'Sehpa', cutoutIds: ['b', 'c'] },
    ]);
  });

  it('normalizes a legacy single-cutout record on read', async () => {
    const now = new Date().toISOString();
    const legacy = { id: 'legacy', cutoutId: 'old-cut', envMode: 'preset', styleId: 'modern', aspect: '4:5', count: 1, model: 'cinematic', createdAt: now, updatedAt: now, prompt: 'p', status: 'done', outputs: [{ index: 0, status: 'done', file: 'outputs/x-0.jpg' }] };
    await fs.writeFile(dataPath('history.json'), JSON.stringify([legacy]));
    const want = [{ name: 'Ürün', cutoutIds: ['old-cut'] }];
    const one = await getGeneration('legacy');
    expect(one?.products).toEqual(want);
    expect(one).not.toHaveProperty('cutoutId');
    const [listed] = await listGenerations();
    expect(listed.products).toEqual(want);
    expect(listed).not.toHaveProperty('cutoutId');
  });

  it('persists resolution and cinematic settings', async () => {
    const rec = await createGeneration({ ...req(1), resolution: '4k', cinematic: { lighting: 'overcast' } }, 'p');
    const stored = await getGeneration(rec.id);
    expect(stored?.cinematic).toEqual({ lighting: 'overcast' });
    expect(stored?.resolution).toBe('4k');
    const plain = await getGeneration((await createGeneration(req(1), 'p2')).id);
    expect(plain).not.toHaveProperty('cinematic');
  });

  it('lists only cinematic records; a record without resolution reads as 2k', async () => {
    const now = new Date().toISOString();
    const base = { cutoutId: 'c', envMode: 'preset', styleId: 'modern', aspect: '1:1', count: 1, createdAt: now, updatedAt: now, prompt: 'p', status: 'done', outputs: [{ index: 0, status: 'done', file: 'outputs/x-0.jpg' }] };
    await fs.writeFile(
      dataPath('history.json'),
      JSON.stringify([
        { ...base, id: 'old-other', model: 'some-old-model' },
        { ...base, id: 'legacy-cinematic', model: 'cinematic' },
        { ...base, id: 'no-model' },
      ]),
    );
    const list = await listGenerations();
    expect(list.map((r) => r.id)).toEqual(['legacy-cinematic']);
    expect(list[0].resolution).toBe('2k');
    expect((await getGeneration('legacy-cinematic'))?.resolution).toBe('2k');
  });

  it('creates a running record with pending outputs, newest first', async () => {
    const older = await createGeneration(req(1), 'p0');
    const rec = await createGeneration(req(3), 'a prompt');
    expect(rec.status).toBe('running');
    expect(rec.prompt).toBe('a prompt');
    expect(rec.outputs).toHaveLength(3);
    expect(rec.outputs.every((o) => o.status === 'pending')).toBe(true);
    expect(rec.outputs.map((o) => o.index)).toEqual([0, 1, 2]);
    const list = await listGenerations();
    expect(list[0].id).toBe(rec.id);
    expect(list[1].id).toBe(older.id);
    expect((await getGeneration(rec.id))?.id).toBe(rec.id);
    expect(await getGeneration('missing')).toBeNull();
  });

  it('recomputes status from outputs', async () => {
    const rec = await createGeneration(req(2), 'p');
    let r = await updateOutput(rec.id, 0, { status: 'done', file: 'outputs/a-0.jpg' });
    expect(r.status).toBe('running');
    expect(r.outputs[0].file).toBe('outputs/a-0.jpg');
    r = await updateOutput(rec.id, 1, { status: 'done', file: 'outputs/a-1.jpg' });
    expect(r.status).toBe('done');

    const p = await createGeneration(req(2), 'p');
    await updateOutput(p.id, 0, { status: 'done', file: 'outputs/b-0.jpg' });
    r = await updateOutput(p.id, 1, { status: 'failed', error: 'x' });
    expect(r.status).toBe('partial');

    const f = await createGeneration(req(2), 'p');
    await updateOutput(f.id, 0, { status: 'failed', error: 'x' });
    r = await updateOutput(f.id, 1, { status: 'failed', error: 'y' });
    expect(r.status).toBe('failed');
  });

  it('keeps both records on parallel creates', async () => {
    const [a, b] = await Promise.all([
      createGeneration(req(1), 'a'),
      createGeneration(req(2), 'b'),
    ]);
    const ids = (await listGenerations()).map((r) => r.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it('rejects updates for unknown records', async () => {
    await expect(updateOutput('nope', 0, { status: 'done' })).rejects.toThrow();
  });
});

describe('history concurrency and sweep', () => {
  it('parallel updateOutput on different outputs persists both', async () => {
    const rec = await createGeneration(req(2), 'p');
    await Promise.all([
      updateOutput(rec.id, 0, { status: 'done', file: 'outputs/a.jpg' }),
      updateOutput(rec.id, 1, { status: 'failed', error: 'x' }),
    ]);
    const got = await getGeneration(rec.id);
    expect(got!.outputs[0].status).toBe('done');
    expect(got!.outputs[1].status).toBe('failed');
  });

  async function backdate(id: string, ms: number) {
    const file = path.join(process.env.DATA_DIR!, 'history.json');
    const recs = JSON.parse(await fs.readFile(file, 'utf8'));
    recs.find((r: { id: string }) => r.id === id).updatedAt = new Date(Date.now() - ms).toISOString();
    await fs.writeFile(file, JSON.stringify(recs));
  }

  it('sweepStale fails old running records only', async () => {
    const old = await createGeneration(req(2), 'old');
    const fresh = await createGeneration(req(1), 'fresh');
    await updateOutput(old.id, 0, { status: 'done', file: 'outputs/k.jpg' });
    await backdate(old.id, 11 * 60_000);
    await backdate(fresh.id, 60_000);
    await sweepStale(10 * 60_000);
    const o = await getGeneration(old.id);
    expect(o!.status).toBe('partial');
    expect(o!.outputs[0].status).toBe('done');
    expect(o!.outputs[1]).toMatchObject({
      status: 'failed',
      error: 'Üretim yarıda kaldı (uygulama yeniden başlatıldı).',
    });
    expect((await getGeneration(fresh.id))!.status).toBe('running');
  });

  it('listGenerations sweeps stale records without deadlocking', async () => {
    const old = await createGeneration(req(1), 'old');
    await backdate(old.id, 11 * 60_000);
    const list = await listGenerations();
    expect(list[0].status).toBe('failed');
  });

  it('a late completion does not overwrite an output the sweep already failed', async () => {
    const rec = await createGeneration(req(1), 'p');
    await backdate(rec.id, 11 * 60_000);
    await sweepStale(10 * 60_000);
    await updateOutput(rec.id, 0, { status: 'done', file: 'outputs/late.jpg' });
    const got = await getGeneration(rec.id);
    expect(got!.status).toBe('failed');
    expect(got!.outputs[0]).toMatchObject({
      status: 'failed',
      error: 'Üretim yarıda kaldı (uygulama yeniden başlatıldı).',
    });
    expect(got!.outputs[0].file).toBeUndefined();
  });
});
