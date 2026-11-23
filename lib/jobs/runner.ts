import { randomInt } from 'node:crypto';
import fs from 'node:fs/promises';
import { sharp } from '@/lib/native-modules';
import { findCutout } from '@/lib/cutout/remove-background';
import { findUpload, toReferenceBase64, UserError } from '@/lib/images/process';
import { downloadTo, withLibraryHint } from '@/lib/magnific/client';
import { isAspectRatio } from '@/config/aspects';
import { cleanCinematic, DEFAULT_RESOLUTION, isCinematicSettings, isResolution, MODEL_ID } from '@/config/cinematic';
import { getMagnificConnection } from '@/lib/magnific-mcp/auth';
import { NOT_CONNECTED_MSG } from '@/lib/magnific-mcp/client';
import { buildPrompt } from '@/lib/prompts';
import { getProvider, type ImageProvider } from '@/lib/providers';
import type { ProviderProduct } from '@/lib/providers/types';
import { createGeneration, updateOutput } from '@/lib/storage/history';
import { dataPath } from '@/lib/storage/paths';
import type { GenerationRecord, GenerationRequest, ProductInput } from '@/lib/types';

export interface RunnerDeps {
  provider?: ImageProvider;
  download?: typeof downloadTo;
  /** Magnific MCP login check; defaults to the stored OAuth tokens. */
  isConnected?: () => Promise<boolean>;
}

const NOT_FOUND = 'Fotoğraf bulunamadı, lütfen tekrar yükleyin.';
const UNKNOWN = 'Beklenmeyen bir hata oluştu.';
const MAX_PRODUCTS = 4;
const MAX_PRODUCT_PHOTOS = 6;
const MAX_NAME = 40;

/** Trimmed products, or undefined when the list breaks a limit (1–4 products, unique 1–40 char names, 1–6 photos). */
function cleanProducts(v: unknown): ProductInput[] | undefined {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_PRODUCTS) return undefined;
  const out: ProductInput[] = [];
  const seen = new Set<string>();
  for (const p of v) {
    if (!p || typeof p !== 'object') return undefined;
    const { name, cutoutIds } = p as { name?: unknown; cutoutIds?: unknown };
    if (typeof name !== 'string') return undefined;
    const trimmed = name.trim();
    const key = trimmed.toLocaleLowerCase('tr-TR');
    if (trimmed.length < 1 || trimmed.length > MAX_NAME || seen.has(key)) return undefined;
    seen.add(key);
    if (!Array.isArray(cutoutIds) || cutoutIds.length < 1 || cutoutIds.length > MAX_PRODUCT_PHOTOS) return undefined;
    if (!cutoutIds.every((id) => typeof id === 'string')) return undefined;
    out.push({ name: trimmed, cutoutIds: [...cutoutIds] });
  }
  return out;
}

// Output filenames are fixed to .jpg, but Cinematic delivers PNG from the Magnific CDN, so re-encode.
async function ensureJpeg(rel: string): Promise<void> {
  const abs = dataPath(rel);
  const buf = await fs.readFile(abs);
  const meta = await sharp(buf).metadata();
  if (meta.format === 'jpeg') return;
  await fs.writeFile(abs, await sharp(buf).jpeg({ quality: 95 }).toBuffer());
}

async function runVariation(
  record: GenerationRecord,
  index: number,
  refs: { products: ProviderProduct[]; space?: string },
  provider: ImageProvider,
  download: typeof downloadTo,
): Promise<void> {
  // Once generate() returned, the credits are spent: later failures get the library hint.
  let paid = false;
  try {
    const urls = await provider.generate({
      prompt: record.prompt,
      products: refs.products,
      space: refs.space,
      aspect: record.aspect,
      resolution: record.resolution,
      seed: randomInt(0, 2 ** 32 - 1),
      cinematic: record.cinematic,
    });
    paid = true;
    if (!urls[0]) throw new UserError('Magnific üretimi başarısız oldu.');
    const rel = `outputs/${record.id}-${index}.jpg`;
    await download(urls[0], rel);
    await ensureJpeg(rel);
    await updateOutput(record.id, index, { status: 'done', file: rel });
  } catch (err) {
    let error = UNKNOWN;
    if (paid) error = withLibraryHint(err).message;
    else if (err instanceof UserError) error = err.message;
    else console.error(err);
    await updateOutput(record.id, index, { status: 'failed', error }).catch((e) =>
      console.error(e),
    );
  }
}

export async function startGeneration(
  req: GenerationRequest,
  deps: RunnerDeps = {},
): Promise<GenerationRecord> {
  const products = req && typeof req === 'object' ? cleanProducts(req.products) : undefined;
  const invalid =
    !req ||
    !products ||
    !isAspectRatio(req.aspect) ||
    !Number.isInteger(req.count) ||
    req.count < 1 ||
    req.count > 4 ||
    req.model !== MODEL_ID ||
    (req.resolution != null && !isResolution(req.resolution)) ||
    !['preset', 'place-in-space', 'inspired-by-space'].includes(req.envMode) ||
    (req.note != null && typeof req.note !== 'string') ||
    (req.spaceUploadId != null && typeof req.spaceUploadId !== 'string') ||
    (req.styleId != null && typeof req.styleId !== 'string') ||
    !isCinematicSettings(req.cinematic);
  if (invalid) throw new UserError('Geçersiz istek.');
  req = { ...req, products, resolution: req.resolution ?? DEFAULT_RESOLUTION, cinematic: cleanCinematic(req.cinematic) };
  const connected = await (deps.isConnected ?? (async () => (await getMagnificConnection()).connected))();
  if (!connected) throw new UserError(NOT_CONNECTED_MSG);
  const needsSpace = req.envMode === 'place-in-space' || req.envMode === 'inspired-by-space';
  if (needsSpace && !req.spaceUploadId) {
    throw new UserError('Lütfen bir referans mekân fotoğrafı yükleyin.');
  }
  const prompt = buildPrompt({ ...req, productNames: products.map((p) => p.name) });
  const providerProducts: ProviderProduct[] = [];
  for (const p of products) {
    const images: string[] = [];
    for (const id of p.cutoutIds) {
      const cutout = await findCutout(id);
      if (!cutout) throw new UserError(NOT_FOUND);
      images.push(await toReferenceBase64(dataPath(cutout.file)));
    }
    providerProducts.push({ name: p.name, images });
  }
  let space: string | undefined;
  if (needsSpace) {
    const upload = await findUpload(req.spaceUploadId!);
    if (!upload) throw new UserError(NOT_FOUND);
    space = await toReferenceBase64(dataPath(upload.file));
  }

  const provider = deps.provider ?? getProvider();
  const download = deps.download ?? downloadTo;
  const record = await createGeneration(req, prompt);

  // Fire and forget; runVariation never rejects. Once every variation settled, the provider
  // cleans up (e.g. deletes temporary Magnific assets); that never reaches the user.
  const refs = { products: providerProducts, space };
  const variations = Array.from({ length: req.count }, (_, i) => runVariation(record, i, refs, provider, download));
  void Promise.allSettled(variations)
    .then(() => provider.finish?.())
    .catch((e) => console.warn(`Üretim sonrası temizlik başarısız: ${e instanceof Error ? e.message : String(e)}`));
  return record;
}
