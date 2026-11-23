import { readJson, serialize, writeJson } from './json-store';
import type {
  GenerationOutput,
  GenerationRecord,
  GenerationRequest,
  GenerationStatus,
} from '@/lib/types';

const FILE = 'history.json';

const serialized = <T>(fn: () => Promise<T>): Promise<T> => serialize(FILE, fn);

function computeStatus(outputs: GenerationOutput[]): GenerationStatus {
  if (outputs.some((o) => o.status === 'pending')) return 'running';
  const done = outputs.filter((o) => o.status === 'done').length;
  if (done === outputs.length) return 'done';
  if (done === 0) return 'failed';
  return 'partial';
}

export function createGeneration(
  req: GenerationRequest,
  prompt: string,
): Promise<GenerationRecord> {
  return serialized(async () => {
    const records = await readJson<GenerationRecord[]>(FILE, []);
    const now = new Date().toISOString();
    const record: GenerationRecord = {
      products: req.products.map((p) => ({ name: p.name, cutoutIds: [...p.cutoutIds] })),
      envMode: req.envMode,
      styleId: req.styleId,
      spaceUploadId: req.spaceUploadId,
      note: req.note,
      aspect: req.aspect,
      count: req.count,
      model: req.model,
      resolution: req.resolution,
      ...(req.cinematic ? { cinematic: req.cinematic } : {}),
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      prompt,
      status: 'running',
      outputs: Array.from({ length: req.count }, (_, index) => ({
        index,
        status: 'pending' as const,
      })),
    };
    records.push(record);
    await writeJson(FILE, records);
    return record;
  });
}

export function updateOutput(
  id: string,
  index: number,
  patch: Partial<GenerationOutput>,
): Promise<GenerationRecord> {
  return serialized(async () => {
    const records = await readJson<GenerationRecord[]>(FILE, []);
    const record = records.find((r) => r.id === id);
    if (!record) throw new Error(`Generation not found: ${id}`);
    const output = record.outputs.find((o) => o.index === index);
    if (!output) throw new Error(`Output not found: ${id}#${index}`);
    // Already settled (e.g. failed by the stale sweep): a late completion must not flip it.
    if (output.status !== 'pending') return record;
    Object.assign(output, patch, { index });
    record.status = computeStatus(record.outputs);
    record.updatedAt = new Date().toISOString();
    await writeJson(FILE, records);
    return record;
  });
}

export const STALE_MS = 10 * 60_000;
const STALE_MSG = 'Üretim yarıda kaldı (uygulama yeniden başlatıldı).';

// Marks long-idle `running` records failed (server restarted mid-job). The cheap
// unqueued read avoids taking the write queue when nothing is stale; the queued
// section re-reads. Never call this from inside a serialized section.
export async function sweepStale(maxAgeMs: number): Promise<void> {
  const isStale = (r: GenerationRecord, now: number) =>
    r.status === 'running' && now - new Date(r.updatedAt).getTime() > maxAgeMs;
  const peek = await readJson<GenerationRecord[]>(FILE, []);
  if (!peek.some((r) => isStale(r, Date.now()))) return;
  await serialized(async () => {
    const records = await readJson<GenerationRecord[]>(FILE, []);
    const now = Date.now();
    let changed = false;
    for (const r of records) {
      if (!isStale(r, now)) continue;
      for (const o of r.outputs) {
        if (o.status === 'pending') {
          o.status = 'failed';
          o.error = STALE_MSG;
        }
      }
      r.status = computeStatus(r.outputs);
      r.updatedAt = new Date(now).toISOString();
      changed = true;
    }
    if (changed) await writeJson(FILE, records);
  });
}

const LEGACY_PRODUCT_NAME = 'Ürün';

// Records written before resolution was selectable were all 2K; records written before
// multi-product generation had one `cutoutId` instead of `products`.
function withDefaults(r: GenerationRecord): GenerationRecord {
  const { cutoutId, ...rest } = r as GenerationRecord & { cutoutId?: unknown };
  const products =
    Array.isArray(rest.products) && rest.products.length
      ? rest.products
      : typeof cutoutId === 'string'
        ? [{ name: LEGACY_PRODUCT_NAME, cutoutIds: [cutoutId] }]
        : [];
  return { ...rest, products, resolution: rest.resolution ?? '2k' };
}

export async function getGeneration(id: string): Promise<GenerationRecord | null> {
  await sweepStale(STALE_MS);
  const records = await readJson<GenerationRecord[]>(FILE, []);
  const r = records.find((x) => x.id === id);
  return r ? withDefaults(r) : null;
}

// Newest first (records are appended chronologically). Only Cinematic records: anything
// else (e.g. a leftover record of a removed model) is skipped.
export async function listGenerations(): Promise<GenerationRecord[]> {
  await sweepStale(STALE_MS);
  const records = await readJson<GenerationRecord[]>(FILE, []);
  return records
    .filter((r) => r.model === 'cinematic')
    .reverse()
    .map(withDefaults);
}
