/**
 * Client-side draft of the scene's products (step "1 · Ürünler"): pure state helpers plus the
 * per-photo upload → cutout pipeline. The limits mirror the server's (lib/jobs/runner.ts).
 */
import type { Box, CutoutInfo, ProductInput, UploadInfo } from '@/lib/types';

export const MAX_PRODUCTS = 4;
export const MAX_PHOTOS = 6;
export const MAX_NAME = 40;
/** Background removal is CPU-heavy: at most this many cutouts run at once, across all products. */
export const CUTOUT_CONCURRENCY = 2;

export type PhotoStatus = 'uploading' | 'queued' | 'cutting' | 'ready' | 'error';

export interface DraftPhoto {
  key: string;
  status: PhotoStatus;
  /** The picked file, kept until it is uploaded so "Tekrar dene" can resend it. */
  file?: File;
  uploadId?: string;
  /** Source photo path (data-relative); unknown for restored photos until "Düzelt" fetches it. */
  uploadFile?: string;
  cutout?: CutoutInfo;
  /** The box the current cutout was made with (none = whole image). */
  box?: Box;
  /** Why the photo has no usable cutout (status 'error'). */
  error?: string;
  /** A re-cut with a box failed; the previous cutout is kept. */
  fixError?: string;
}

export interface DraftProduct {
  key: string;
  name: string;
  photos: DraftPhoto[];
}

export type PhotoPatch = Partial<Omit<DraftPhoto, 'key'>>;

let seq = 0;
export const newKey = (prefix: string) => `${prefix}-${++seq}`;

const nameKey = (name: string) => name.trim().toLocaleLowerCase('tr-TR');

/** Smallest free "Ürün N", starting at the next position. */
export function defaultName(products: DraftProduct[]): string {
  const taken = new Set(products.map((p) => nameKey(p.name)));
  let n = products.length + 1;
  while (taken.has(nameKey(`Ürün ${n}`))) n++;
  return `Ürün ${n}`;
}

export const emptyProduct = (products: DraftProduct[] = []): DraftProduct => ({
  key: newKey('product'),
  name: defaultName(products),
  photos: [],
});

/** Inline Turkish validation matching the server's rules (trimmed, 1–40 chars, unique case-insensitively). */
export function nameError(products: DraftProduct[], key: string): string | undefined {
  const self = products.find((p) => p.key === key);
  if (!self) return undefined;
  const trimmed = self.name.trim();
  if (trimmed.length === 0) return 'Ürüne bir ad verin.';
  if (trimmed.length > MAX_NAME) return `Ad en fazla ${MAX_NAME} karakter olabilir.`;
  const k = nameKey(trimmed);
  if (products.some((p) => p.key !== key && nameKey(p.name) === k)) return 'Bu ad zaten kullanılıyor.';
  return undefined;
}

export const isProcessing = (ph: DraftPhoto) =>
  ph.status === 'uploading' || ph.status === 'queued' || ph.status === 'cutting';

export const readyPhotos = (p: DraftProduct) => p.photos.filter((ph) => ph.status === 'ready' && ph.cutout);

export interface ProductsState {
  ready: boolean;
  processing: boolean;
  /** Why the step is not done yet (Turkish), when it is not. */
  hint?: string;
}

/** Done when every product has a valid name and ≥ 1 ready cutout and nothing is still processing. */
export function productsState(products: DraftProduct[]): ProductsState {
  const processing = products.some((p) => p.photos.some(isProcessing));
  if (products.length === 0 || products.every((p) => p.photos.length === 0))
    return { ready: false, processing, hint: 'Önce ürün fotoğraflarını yükleyin.' };
  if (processing) return { ready: false, processing, hint: 'Fotoğraflar ayıklanıyor, lütfen bekleyin.' };
  if (products.some((p) => readyPhotos(p).length === 0))
    return { ready: false, processing, hint: 'Her ürün için en az bir hazır fotoğraf gerekli.' };
  if (products.some((p) => nameError(products, p.key)))
    return { ready: false, processing, hint: 'Ürün adlarını düzeltin.' };
  return { ready: true, processing };
}

/** The request's products: trimmed names, ready cutouts in display order (first = cover). */
export const toRequestProducts = (products: DraftProduct[]): ProductInput[] =>
  products.map((p) => ({ name: p.name.trim(), cutoutIds: readyPhotos(p).map((ph) => ph.cutout!.id) }));

export function updatePhoto(products: DraftProduct[], photoKey: string, patch: PhotoPatch): DraftProduct[] {
  let hit = false;
  const next = products.map((p) => {
    const i = p.photos.findIndex((ph) => ph.key === photoKey);
    if (i < 0) return p;
    hit = true;
    const photos = p.photos.slice();
    photos[i] = { ...photos[i], ...patch };
    return { ...p, photos };
  });
  // A photo that was removed (or replaced by a restore) ignores late results.
  return hit ? next : products;
}

export const updateProduct = (products: DraftProduct[], key: string, patch: Partial<Omit<DraftProduct, 'key'>>) =>
  products.map((p) => (p.key === key ? { ...p, ...patch } : p));

/**
 * New photos for picked files, given how many the product already has: up to MAX_PHOTOS in all,
 * the rest are rejected. Keys are made here, outside any state updater (those must stay pure).
 */
export function planPhotos(existing: number, files: File[]): { added: DraftPhoto[]; rejected: number } {
  const room = Math.max(0, MAX_PHOTOS - existing);
  const added: DraftPhoto[] = files.slice(0, room).map((file) => ({ key: newKey('photo'), status: 'uploading', file }));
  return { added, rejected: files.length - added.length };
}

/** Appends planned photos to a product, never past MAX_PHOTOS. */
export const appendPhotos = (products: DraftProduct[], productKey: string, photos: DraftPhoto[]) =>
  products.map((p) => (p.key === productKey ? { ...p, photos: [...p.photos, ...photos].slice(0, MAX_PHOTOS) } : p));

export const removePhoto = (products: DraftProduct[], photoKey: string) =>
  products.map((p) => (p.photos.some((ph) => ph.key === photoKey) ? { ...p, photos: p.photos.filter((ph) => ph.key !== photoKey) } : p));

/** Moves a photo one place left (-1) or right (+1) within its product; index 0 is the cover. */
export function movePhoto(products: DraftProduct[], photoKey: string, dir: -1 | 1): DraftProduct[] {
  return products.map((p) => {
    const i = p.photos.findIndex((ph) => ph.key === photoKey);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= p.photos.length) return p;
    const photos = p.photos.slice();
    [photos[i], photos[j]] = [photos[j], photos[i]];
    return { ...p, photos };
  });
}

/** What the last removal took, so "Geri al" can put it back where it was. */
export type Removal =
  | { kind: 'product'; product: DraftProduct; index: number; siblings: string[] }
  | { kind: 'photo'; photo: DraftPhoto; productKey: string; index: number };

/** Re-inserts a removed product or photo at its old place, within the limits; a no-op if it no longer fits. */
export function undoRemoval(products: DraftProduct[], r: Removal): DraftProduct[] {
  if (r.kind === 'product') {
    if (products.length >= MAX_PRODUCTS || products.some((p) => p.key === r.product.key)) return products;
    const next = products.slice();
    next.splice(Math.min(r.index, next.length), 0, r.product);
    return next;
  }
  return products.map((p) => {
    if (p.key !== r.productKey || p.photos.length >= MAX_PHOTOS || p.photos.some((ph) => ph.key === r.photo.key)) return p;
    const photos = p.photos.slice();
    photos.splice(Math.min(r.index, photos.length), 0, r.photo);
    return { ...p, photos };
  });
}

/** A removal can still be undone while the form it came from is shown (not replaced by a restore). */
export function canUndo(products: DraftProduct[], r: Removal): boolean {
  if (r.kind === 'photo') {
    const p = products.find((x) => x.key === r.productKey);
    return !!p && p.photos.length < MAX_PHOTOS;
  }
  return products.length < MAX_PRODUCTS && products.some((p) => r.siblings.includes(p.key));
}

export const hasPhoto = (products: DraftProduct[], photoKey: string) =>
  products.some((p) => p.photos.some((ph) => ph.key === photoKey));

// ---------- concurrency ----------

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Runs at most `max` tasks at a time, in call order; a failing task frees its slot. */
export function createLimiter(max: number): Limiter {
  let active = 0;
  const queue: (() => void)[] = [];
  const pump = () => {
    while (active < max && queue.length > 0) {
      active++;
      queue.shift()!();
    }
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      });
      pump();
    });
}

// ---------- pipeline ----------

export interface PhotoDeps {
  upload: (file: File) => Promise<UploadInfo>;
  cut: (uploadId: string, box?: Box) => Promise<CutoutInfo>;
  /** Shared limiter for cutouts (CUTOUT_CONCURRENCY). */
  limit: Limiter;
  /** False once the photo is gone (removed, or the form was restored): queued work is skipped. */
  alive: () => boolean;
}

const message = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Beklenmeyen bir hata oluştu.');
const LOST = 'Fotoğraf bulunamadı, lütfen tekrar yükleyin.';

/**
 * Cuts the photo's upload (whole image, or `box`). On failure a photo that already had a cutout
 * keeps it (fixError); otherwise it turns into an error. Resolves true when a new cutout landed.
 */
export async function cutPhoto(
  photo: Pick<DraftPhoto, 'uploadId' | 'cutout'>,
  box: Box | undefined,
  deps: PhotoDeps,
  patch: (p: PhotoPatch) => void,
): Promise<boolean> {
  const uploadId = photo.uploadId;
  if (!uploadId) {
    patch({ status: 'error', error: LOST });
    return false;
  }
  patch({ status: 'queued', error: undefined, fixError: undefined });
  return deps.limit(async () => {
    if (!deps.alive()) return false;
    patch({ status: 'cutting' });
    try {
      const cutout = await deps.cut(uploadId, box);
      patch({ status: 'ready', cutout, box, error: undefined });
      return true;
    } catch (e) {
      patch(photo.cutout ? { status: 'ready', fixError: message(e) } : { status: 'error', error: message(e) });
      return false;
    }
  });
}

/** Upload (if not yet uploaded) then the automatic whole-image cutout. Also serves "Tekrar dene". */
export async function processPhoto(
  photo: DraftPhoto,
  deps: PhotoDeps,
  patch: (p: PhotoPatch) => void,
): Promise<boolean> {
  let uploadId = photo.uploadId;
  if (!uploadId) {
    if (!photo.file) {
      patch({ status: 'error', error: LOST });
      return false;
    }
    // A photo removed (or replaced by a restore) before its turn is never uploaded.
    if (!deps.alive()) return false;
    patch({ status: 'uploading', error: undefined });
    try {
      const info = await deps.upload(photo.file);
      uploadId = info.id;
      patch({ uploadId: info.id, uploadFile: info.file, file: undefined });
    } catch (e) {
      patch({ status: 'error', error: message(e) });
      return false;
    }
  }
  return cutPhoto({ uploadId, cutout: photo.cutout }, photo.box, deps, patch);
}

// ---------- task tokens ----------

interface TaskEntry {
  token: number;
  running: boolean;
  /** The box the task cuts with (none = whole image), so a restart repeats the same request. */
  box?: Box;
  /** Every patch the task made, kept so "Geri al" can replay results that landed while removed. */
  merged: PhotoPatch;
}

/**
 * One generation token per photo key. Starting a task supersedes the previous one for that key:
 * a superseded task fails alive() and its patches are dropped, so an older cut can never
 * overwrite a newer one (e.g. a "Düzelt" re-cut) and work is never applied twice.
 */
export function createPhotoTasks() {
  let seq = 0;
  const entries = new Map<string, TaskEntry>();
  return {
    begin(key: string, box?: Box): number {
      const token = ++seq;
      entries.set(key, { token, running: true, box, merged: {} });
      return token;
    },
    isCurrent: (key: string, token: number) => entries.get(key)?.token === token,
    record(key: string, token: number, patch: PhotoPatch) {
      const e = entries.get(key);
      if (e?.token === token) Object.assign(e.merged, patch);
    },
    end(key: string, token: number) {
      const e = entries.get(key);
      if (e?.token === token) e.running = false;
    },
    /** The current task for this key has not finished yet. */
    running: (key: string) => entries.get(key)?.running ?? false,
    entry: (key: string): Readonly<TaskEntry> | undefined => entries.get(key),
  };
}
export type PhotoTasks = ReturnType<typeof createPhotoTasks>;

/**
 * Wraps one run of `processPhoto`/`cutPhoto` for a photo in a fresh token: alive() needs the
 * photo in the list (`present`) AND the token to still be current; patches of a superseded run
 * are dropped. Call `done` when the run settles.
 */
export function trackPhotoTask(
  tasks: PhotoTasks,
  key: string,
  box: Box | undefined,
  present: () => boolean,
  apply: (p: PhotoPatch) => void,
) {
  const token = tasks.begin(key, box);
  return {
    alive: () => present() && tasks.isCurrent(key, token),
    patch: (p: PhotoPatch) => {
      if (!tasks.isCurrent(key, token)) return;
      tasks.record(key, token, p);
      apply(p);
    },
    done: () => tasks.end(key, token),
  };
}

/**
 * "Geri al" for a removal made while photos were mid-upload/cut. Each photo comes back with
 * whatever its current task did meanwhile (patches made while it was out of the list were
 * dropped from the state). A photo whose task is still in flight is left to that task; only a
 * photo whose task stopped early (it was skipped while removed) is restarted, with the same box.
 */
export function planUndo(r: Removal, tasks: PhotoTasks): { removal: Removal; restart: DraftPhoto[] } {
  const restart: DraftPhoto[] = [];
  const revive = (ph: DraftPhoto): DraftPhoto => {
    const e = tasks.entry(ph.key);
    const back: DraftPhoto = e ? { ...ph, ...e.merged } : ph;
    if (isProcessing(back) && !tasks.running(ph.key)) restart.push(e ? { ...back, box: e.box } : back);
    return back;
  };
  const removal: Removal =
    r.kind === 'photo'
      ? { ...r, photo: revive(r.photo) }
      : { ...r, product: { ...r.product, photos: r.product.photos.map(revive) } };
  return { removal, restart };
}

// ---------- restore ----------

export interface RestoredProducts {
  products: DraftProduct[];
  /** Photos of the record that no longer exist (HTTP 404). */
  missing: number;
  total: number;
}

const isNotFound = (e: unknown) => typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 404;

/**
 * Rebuilds the form's products from a record (`getCutout` per id, record order kept). Photos that
 * no longer exist are dropped and counted; any other failure (server unreachable, 500) rejects, so
 * a transient error is never reported as deleted photos.
 */
export async function restoreProducts(
  inputs: ProductInput[],
  getCutout: (id: string) => Promise<CutoutInfo>,
): Promise<RestoredProducts> {
  let missing = 0;
  let total = 0;
  const products = await Promise.all(
    inputs.map(async (p) => {
      total += p.cutoutIds.length;
      const found = await Promise.all(
        p.cutoutIds.map((id) =>
          getCutout(id).catch((e: unknown) => {
            if (isNotFound(e)) return null;
            throw e;
          }),
        ),
      );
      const photos: DraftPhoto[] = [];
      for (const c of found) {
        if (!c) missing++;
        else photos.push({ key: newKey('photo'), status: 'ready', cutout: c, uploadId: c.sourceUploadId });
      }
      return { key: newKey('product'), name: p.name, photos };
    }),
  );
  return { products, missing, total };
}

/** Turkish notice for photos a restore or "Tekrar üret" could not find (undefined when none). */
export function missingNotice(missing: number, total: number): string | undefined {
  if (missing === 0) return undefined;
  if (missing >= total) return 'Bu üretimin ürün fotoğrafları bulunamadı. Fotoğrafları yeniden yükleyin.';
  return `Bu üretimin ${missing} ürün fotoğrafı bulunamadı; kalan fotoğraflar kullanılıyor.`;
}

/** "Koltuk + Sehpa": a record's product names for the results subtitle and the gallery. */
export const productTitle = (products: Pick<ProductInput, 'name'>[]) => products.map((p) => p.name).join(' + ');
