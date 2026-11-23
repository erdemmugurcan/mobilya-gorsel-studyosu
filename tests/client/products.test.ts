import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/client/api';
import {
  appendPhotos,
  canUndo,
  createLimiter,
  cutPhoto,
  defaultName,
  emptyProduct,
  hasPhoto,
  MAX_PHOTOS,
  missingNotice,
  movePhoto,
  nameError,
  planPhotos,
  processPhoto,
  productsState,
  productTitle,
  removePhoto,
  restoreProducts,
  toRequestProducts,
  undoRemoval,
  updatePhoto,
  type DraftPhoto,
  type DraftProduct,
  type PhotoDeps,
  type PhotoPatch,
} from '@/lib/client/products';
import type { Box, CutoutInfo, UploadInfo } from '@/lib/types';

const file = (name = 'a.jpg') => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });
const upload = (id: string): UploadInfo => ({ id, kind: 'product', file: `uploads/${id}.jpg`, width: 10, height: 10 });
const cutout = (id: string, src = 'u1'): CutoutInfo => ({ id, sourceUploadId: src, file: `cutouts/${id}.png`, width: 10, height: 10 });
const ready = (key: string, id = key): DraftPhoto => ({ key, status: 'ready', uploadId: `u-${id}`, cutout: cutout(id) });
const product = (key: string, name: string, photos: DraftPhoto[] = []): DraftProduct => ({ key, name, photos });

/** Applies patches to a local copy and records the status trail, like the panel's state does. */
function tracker(initial: DraftPhoto) {
  let photo = { ...initial };
  const statuses: string[] = [];
  const patch = (p: PhotoPatch) => {
    photo = { ...photo, ...p };
    if (p.status) statuses.push(p.status);
  };
  return { patch, statuses, get photo() { return photo; } };
}

const deps = (over: Partial<PhotoDeps> = {}): PhotoDeps => ({
  upload: vi.fn(async () => upload('u1')),
  cut: vi.fn(async () => cutout('c1')),
  limit: createLimiter(2),
  alive: () => true,
  ...over,
});

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('product names', () => {
  it('defaults to the next free "Ürün N"', () => {
    expect(defaultName([])).toBe('Ürün 1');
    expect(defaultName([product('a', 'Ürün 2')])).toBe('Ürün 3');
    expect(defaultName([product('a', 'Koltuk'), product('b', 'ürün 3')])).toBe('Ürün 4');
    expect(emptyProduct().name).toBe('Ürün 1');
  });

  it('matches the server: trimmed, 1–40 characters, unique case-insensitively (tr-TR)', () => {
    const list = [product('a', 'Koltuk'), product('b', '  koltuk '), product('c', 'x'.repeat(41)), product('d', '   ')];
    expect(nameError(list, 'a')).toBe('Bu ad zaten kullanılıyor.');
    expect(nameError(list, 'b')).toBe('Bu ad zaten kullanılıyor.');
    expect(nameError(list, 'c')).toBe('Ad en fazla 40 karakter olabilir.');
    expect(nameError(list, 'd')).toBe('Ürüne bir ad verin.');
    expect(nameError([product('a', 'x'.repeat(40))], 'a')).toBeUndefined();
    // Turkish casing: "İSKEMLE" lower-cases to "iskemle" only under tr-TR.
    expect(nameError([product('a', 'İSKEMLE'), product('b', 'iskemle')], 'b')).toBe('Bu ad zaten kullanılıyor.');
    expect(nameError([product('a', 'SEHPA'), product('b', 'Masa')], 'b')).toBeUndefined();
  });
});

describe('photo list edits', () => {
  it('accepts at most 6 photos per product and reports the rest', () => {
    const files = Array.from({ length: 8 }, (_, i) => file(`${i}.jpg`));
    const a = planPhotos(0, files);
    expect(a.added).toHaveLength(MAX_PHOTOS);
    expect(a.rejected).toBe(2);
    expect(a.added.every((p) => p.status === 'uploading' && p.file)).toBe(true);
    const b = planPhotos(4, files.slice(0, 3));
    expect(b.added).toHaveLength(2);
    expect(b.rejected).toBe(1);
    expect(planPhotos(6, [file()]).added).toHaveLength(0);
  });

  it('appends, never past the limit, and only to the named product', () => {
    const list = [product('p1', 'A', [ready('x1'), ready('x2'), ready('x3'), ready('x4'), ready('x5')]), product('p2', 'B')];
    const next = appendPhotos(list, 'p1', [ready('n1'), ready('n2')]);
    expect(next[0].photos.map((p) => p.key)).toEqual(['x1', 'x2', 'x3', 'x4', 'x5', 'n1']);
    expect(next[1]).toBe(list[1]);
  });

  it('moves a photo left/right (first = cover) and ignores moves past either end', () => {
    const list = [product('p', 'A', [ready('a'), ready('b'), ready('c')])];
    expect(movePhoto(list, 'c', -1)[0].photos.map((p) => p.key)).toEqual(['a', 'c', 'b']);
    expect(movePhoto(list, 'a', 1)[0].photos.map((p) => p.key)).toEqual(['b', 'a', 'c']);
    expect(movePhoto(list, 'a', -1)[0].photos.map((p) => p.key)).toEqual(['a', 'b', 'c']);
    expect(movePhoto(list, 'c', 1)[0].photos.map((p) => p.key)).toEqual(['a', 'b', 'c']);
  });

  it('removes a photo; late results for it are ignored', () => {
    const list = [product('p', 'A', [ready('a'), ready('b')])];
    const after = removePhoto(list, 'a');
    expect(after[0].photos.map((p) => p.key)).toEqual(['b']);
    expect(hasPhoto(after, 'a')).toBe(false);
    expect(updatePhoto(after, 'a', { status: 'error' })).toBe(after);
    expect(updatePhoto(after, 'b', { status: 'cutting' })[0].photos[0].status).toBe('cutting');
  });
});

describe('undo of a removal ("Geri al")', () => {
  it('puts a removed photo back at its old place', () => {
    const list = [product('p', 'A', [ready('a'), ready('b'), ready('c')])];
    const r = { kind: 'photo' as const, photo: list[0].photos[1], productKey: 'p', index: 1 };
    const after = removePhoto(list, 'b');
    expect(canUndo(after, r)).toBe(true);
    expect(undoRemoval(after, r)[0].photos.map((p) => p.key)).toEqual(['a', 'b', 'c']);
    // twice is a no-op
    expect(undoRemoval(undoRemoval(after, r), r)[0].photos).toHaveLength(3);
  });

  it('puts a removed product back at its index, within 4 products', () => {
    const list = [product('p1', 'A'), product('p2', 'B'), product('p3', 'C')];
    const r = { kind: 'product' as const, product: list[1], index: 1, siblings: ['p1', 'p3'] };
    const after = list.filter((p) => p.key !== 'p2');
    expect(canUndo(after, r)).toBe(true);
    expect(undoRemoval(after, r).map((p) => p.name)).toEqual(['A', 'B', 'C']);
    const full = [...after, product('p4', 'D'), product('p5', 'E')];
    expect(canUndo(full, r)).toBe(false);
    expect(undoRemoval(full, r)).toBe(full);
  });

  it('expires once the form was replaced (restore) or the product is gone', () => {
    const r = { kind: 'product' as const, product: product('p2', 'B'), index: 1, siblings: ['p1'] };
    expect(canUndo([product('x', 'Restored')], r)).toBe(false);
    const rp = { kind: 'photo' as const, photo: ready('a'), productKey: 'gone', index: 0 };
    expect(canUndo([product('p', 'A')], rp)).toBe(false);
  });
});

describe('productsState (step 1 done?)', () => {
  it('asks for photos first', () => {
    expect(productsState([product('p', 'Ürün 1')])).toMatchObject({ ready: false, hint: 'Önce ürün fotoğraflarını yükleyin.' });
  });

  it('waits while anything is uploading or being cut', () => {
    const s = productsState([product('p', 'A', [ready('a'), { key: 'b', status: 'cutting', uploadId: 'u' }])]);
    expect(s).toMatchObject({ ready: false, processing: true, hint: 'Fotoğraflar ayıklanıyor, lütfen bekleyin.' });
  });

  it('needs a ready cutout in every product', () => {
    const s = productsState([product('p', 'A', [ready('a')]), product('q', 'B', [{ key: 'e', status: 'error', error: 'x' }])]);
    expect(s).toMatchObject({ ready: false, hint: 'Her ürün için en az bir hazır fotoğraf gerekli.' });
    expect(productsState([product('p', 'A', [ready('a')]), product('q', 'B')]).ready).toBe(false);
  });

  it('needs valid names', () => {
    const s = productsState([product('p', 'Masa', [ready('a')]), product('q', 'masa', [ready('b')])]);
    expect(s).toMatchObject({ ready: false, hint: 'Ürün adlarını düzeltin.' });
  });

  it('is done with a name and ≥ 1 ready cutout each; failed photos are left out of the request', () => {
    const list = [
      product('p', ' Koltuk ', [ready('a'), { key: 'e', status: 'error', uploadId: 'u', error: 'x' }, ready('b')]),
      product('q', 'Sehpa', [ready('c')]),
    ];
    expect(productsState(list)).toEqual({ ready: true, processing: false });
    expect(toRequestProducts(list)).toEqual([
      { name: 'Koltuk', cutoutIds: ['a', 'b'] },
      { name: 'Sehpa', cutoutIds: ['c'] },
    ]);
  });
});

describe('createLimiter', () => {
  it('runs at most N at once, in call order, and a failure frees its slot', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    const runs = gates.map((g, i) =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        order.push(i);
        try {
          await g.promise;
        } finally {
          active--;
        }
        return i;
      }),
    );
    const all = Promise.allSettled(runs);
    await tick();
    expect(order).toEqual([0, 1]);
    gates[0].reject(new Error('boom'));
    await tick();
    expect(order).toEqual([0, 1, 2]);
    gates.slice(1).forEach((g) => g.resolve());
    const settled = await all;
    expect(settled[0].status).toBe('rejected');
    expect(settled.slice(1).map((s) => (s as PromiseFulfilledResult<number>).value)).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(2);
  });
});

describe('processPhoto (upload → automatic cutout)', () => {
  it('uploads, then cuts the whole image with no box', async () => {
    const d = deps();
    const t = tracker({ key: 'k', status: 'uploading', file: file() });
    expect(await processPhoto(t.photo, d, t.patch)).toBe(true);
    expect(d.upload).toHaveBeenCalledTimes(1);
    expect(d.cut).toHaveBeenCalledWith('u1', undefined);
    expect(t.statuses).toEqual(['uploading', 'queued', 'cutting', 'ready']);
    expect(t.photo).toMatchObject({ status: 'ready', uploadId: 'u1', uploadFile: 'uploads/u1.jpg', cutout: cutout('c1') });
    expect(t.photo.file).toBeUndefined();
  });

  it('turns an upload failure into an error; "Tekrar dene" re-uploads the kept file', async () => {
    const up = vi.fn().mockRejectedValueOnce(new Error('HEIC desteklenmiyor, lütfen JPG veya PNG yükleyin.')).mockResolvedValue(upload('u2'));
    const d = deps({ upload: up });
    const t = tracker({ key: 'k', status: 'uploading', file: file() });
    expect(await processPhoto(t.photo, d, t.patch)).toBe(false);
    expect(t.photo).toMatchObject({ status: 'error', error: 'HEIC desteklenmiyor, lütfen JPG veya PNG yükleyin.' });
    expect(t.photo.file).toBeDefined();
    expect(d.cut).not.toHaveBeenCalled();

    expect(await processPhoto(t.photo, d, t.patch)).toBe(true);
    expect(up).toHaveBeenCalledTimes(2);
    expect(t.photo).toMatchObject({ status: 'ready', uploadId: 'u2' });
  });

  it('turns a cutout failure into an error; "Tekrar dene" re-cuts without uploading again', async () => {
    const cut = vi.fn().mockRejectedValueOnce(new Error('Ürün kesilirken bir hata oluştu.')).mockResolvedValue(cutout('c2'));
    const d = deps({ cut });
    const t = tracker({ key: 'k', status: 'uploading', file: file() });
    expect(await processPhoto(t.photo, d, t.patch)).toBe(false);
    expect(t.photo).toMatchObject({ status: 'error', error: 'Ürün kesilirken bir hata oluştu.', uploadId: 'u1' });
    expect(await processPhoto(t.photo, d, t.patch)).toBe(true);
    expect(d.upload).toHaveBeenCalledTimes(1);
    expect(t.photo).toMatchObject({ status: 'ready', cutout: cutout('c2'), error: undefined });
  });

  it('uses a plain Turkish message for non-Error failures and for a photo with nothing to send', async () => {
    const t = tracker({ key: 'k', status: 'uploading', file: file() });
    await processPhoto(t.photo, deps({ upload: () => Promise.reject('x') }), t.patch);
    expect(t.photo.error).toBe('Beklenmeyen bir hata oluştu.');
    const lost = tracker({ key: 'k', status: 'error' });
    await processPhoto(lost.photo, deps(), lost.patch);
    expect(lost.photo.error).toBe('Fotoğraf bulunamadı, lütfen tekrar yükleyin.');
  });

  it('skips the upload and the cutout of a photo removed before its turn', async () => {
    const d = deps({ alive: () => false });
    const t = tracker({ key: 'k', status: 'uploading', file: file() });
    expect(await processPhoto(t.photo, d, t.patch)).toBe(false);
    expect(d.upload).not.toHaveBeenCalled();
    expect(d.cut).not.toHaveBeenCalled();
  });

  it('never runs more than 2 cutouts at once across all products', async () => {
    let active = 0;
    let peak = 0;
    const gates: ReturnType<typeof deferred<CutoutInfo>>[] = [];
    const limit = createLimiter(2);
    const cut = vi.fn(() => {
      active++;
      peak = Math.max(peak, active);
      const g = deferred<CutoutInfo>();
      gates.push(g);
      return g.promise.finally(() => active--);
    });
    const shared = (key: string): PhotoDeps => ({ ...deps({ cut, limit }), upload: async () => upload(`u-${key}`) });
    const photos = ['p1a', 'p1b', 'p1c', 'p2a', 'p2b'].map((k) => tracker({ key: k, status: 'uploading', file: file() }));
    const runs = photos.map((t) => processPhoto(t.photo, shared(t.photo.key), t.patch));
    await tick();
    expect(cut).toHaveBeenCalledTimes(2);
    expect(photos.filter((t) => t.photo.status === 'queued')).toHaveLength(3);
    for (let n = 0; n < 5; n++) {
      gates.shift()!.resolve(cutout(`c${n}`));
      await tick();
    }
    await Promise.all(runs);
    expect(cut).toHaveBeenCalledTimes(5);
    expect(peak).toBe(2);
    expect(photos.every((t) => t.photo.status === 'ready')).toBe(true);
  });
});

describe('cutPhoto with a box ("Düzelt")', () => {
  const box: Box = { x: 0.1, y: 0.2, w: 0.5, h: 0.6 };

  it('re-cuts the photo’s own upload with the box and replaces its cutout', async () => {
    const d = deps({ cut: vi.fn(async () => cutout('c-new')) });
    const t = tracker(ready('k', 'c-old'));
    expect(await cutPhoto(t.photo, box, d, t.patch)).toBe(true);
    expect(d.cut).toHaveBeenCalledWith('u-c-old', box);
    expect(t.photo).toMatchObject({ status: 'ready', cutout: cutout('c-new'), box });
  });

  it('keeps the previous cutout when the re-cut fails', async () => {
    const d = deps({ cut: vi.fn().mockRejectedValue(new Error('Seçilen alan geçersiz.')) });
    const t = tracker(ready('k', 'c-old'));
    expect(await cutPhoto(t.photo, box, d, t.patch)).toBe(false);
    expect(t.photo).toMatchObject({ status: 'ready', cutout: cutout('c-old'), fixError: 'Seçilen alan geçersiz.' });
    expect(t.photo.box).toBeUndefined();
  });

  it('fails plainly when the photo has no upload to cut', async () => {
    const t = tracker({ key: 'k', status: 'error' });
    expect(await cutPhoto(t.photo, box, deps(), t.patch)).toBe(false);
    expect(t.photo.error).toBe('Fotoğraf bulunamadı, lütfen tekrar yükleyin.');
  });
});

describe('restoreProducts', () => {
  it('rebuilds every product and angle in order, tying each photo to its source upload', async () => {
    const get = vi.fn(async (id: string) => cutout(id, `src-${id}`));
    const res = await restoreProducts(
      [
        { name: 'Koltuk', cutoutIds: ['a', 'b'] },
        { name: 'Sehpa', cutoutIds: ['c'] },
      ],
      get,
    );
    expect(res.missing).toBe(0);
    expect(res.total).toBe(3);
    expect(res.products.map((p) => p.name)).toEqual(['Koltuk', 'Sehpa']);
    expect(res.products[0].photos.map((p) => [p.cutout?.id, p.uploadId, p.status])).toEqual([
      ['a', 'src-a', 'ready'],
      ['b', 'src-b', 'ready'],
    ]);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('drops and counts photos that no longer exist (404)', async () => {
    const get = vi.fn(async (id: string) => {
      if (id === 'b') throw new ApiError('Ürün fotoğrafı bulunamadı.', 404);
      return cutout(id);
    });
    const res = await restoreProducts([{ name: 'Koltuk', cutoutIds: ['a', 'b'] }, { name: 'Ürün', cutoutIds: ['b'] }], get);
    expect(res.missing).toBe(2);
    expect(res.products[0].photos.map((p) => p.cutout?.id)).toEqual(['a']);
    expect(res.products[1].photos).toEqual([]);
  });

  it('rejects on other failures instead of calling the photos deleted', async () => {
    const get = vi.fn(async () => {
      throw new ApiError('Sunucuya ulaşılamadı. Uygulamanın çalıştığından emin olun.');
    });
    await expect(restoreProducts([{ name: 'A', cutoutIds: ['a'] }], get)).rejects.toThrow('Sunucuya ulaşılamadı');
  });

  it('words the missing-photo notice and the product title', () => {
    expect(missingNotice(0, 3)).toBeUndefined();
    expect(missingNotice(1, 3)).toBe('Bu üretimin 1 ürün fotoğrafı bulunamadı; kalan fotoğraflar kullanılıyor.');
    expect(missingNotice(3, 3)).toBe('Bu üretimin ürün fotoğrafları bulunamadı. Fotoğrafları yeniden yükleyin.');
    expect(productTitle([{ name: 'Koltuk' }, { name: 'Sehpa' }, { name: 'Masa' }])).toBe('Koltuk + Sehpa + Masa');
  });
});
