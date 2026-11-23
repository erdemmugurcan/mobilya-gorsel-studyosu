// Remove → "Geri al" while uploads/cutouts are in flight: generation tokens per photo make sure
// work runs once, results apply once, and a newer "Düzelt" re-cut is never overwritten.
// The harness mirrors ProductsPanel: a list in state, alive() = photo present AND token current.
import { describe, expect, it, vi } from 'vitest';
import {
  createLimiter,
  createPhotoTasks,
  cutPhoto,
  hasPhoto,
  planUndo,
  processPhoto,
  removePhoto,
  trackPhotoTask,
  undoRemoval,
  updatePhoto,
  type DraftPhoto,
  type DraftProduct,
  type PhotoDeps,
  type PhotoPatch,
  type Removal,
} from '@/lib/client/products';
import type { Box, CutoutInfo, UploadInfo } from '@/lib/types';

const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
};
const cutoutFor = (uploadId: string, box?: Box): CutoutInfo => ({
  id: box ? `cut-${uploadId}-box${box.x}` : `cut-${uploadId}-whole`,
  sourceUploadId: uploadId,
  file: 'cutouts/x.png',
  width: 10,
  height: 10,
});
const BOX_A: Box = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
const BOX_B: Box = { x: 0.3, y: 0.2, w: 0.4, h: 0.6 };

/** State + the panel's task wiring, with manually released uploads and cutouts. */
function harness(initial: DraftProduct[]) {
  let list = initial;
  const tasks = createPhotoTasks();
  const limit = createLimiter(2);
  const uploads: { file: File; d: ReturnType<typeof deferred<UploadInfo>> }[] = [];
  const cuts: { uploadId: string; box?: Box; d: ReturnType<typeof deferred<CutoutInfo>> }[] = [];
  const upload = vi.fn((file: File) => {
    const d = deferred<UploadInfo>();
    uploads.push({ file, d });
    return d.promise;
  });
  const cut = vi.fn((uploadId: string, box?: Box) => {
    const d = deferred<CutoutInfo>();
    cuts.push({ uploadId, box, d });
    return d.promise;
  });
  const applied: { key: string; patch: PhotoPatch }[] = [];

  function run(ph: DraftPhoto, box: Box | undefined, op: (d: PhotoDeps, p: (x: PhotoPatch) => void) => Promise<boolean>) {
    const t = trackPhotoTask(tasks, ph.key, box, () => hasPhoto(list, ph.key), (p) => {
      applied.push({ key: ph.key, patch: p });
      list = updatePhoto(list, ph.key, p);
    });
    return op({ upload, cut, limit, alive: t.alive }, t.patch).finally(t.done);
  }
  const photo = (key: string) => list.flatMap((p) => p.photos).find((ph) => ph.key === key);

  return {
    get list() {
      return list;
    },
    upload,
    cut,
    uploads,
    cuts,
    applied,
    photo,
    /** New photo or "Tekrar dene". */
    process: (ph: DraftPhoto) => run(ph, ph.box, (d, p) => processPhoto(ph, d, p)),
    /** "Düzelt" → "Yeniden ayıkla". */
    fix: (ph: DraftPhoto, box: Box) => run(ph, box, (d, p) => cutPhoto(ph, box, d, p)),
    removePhoto(productKey: string, key: string): Removal {
      const photos = list.find((p) => p.key === productKey)!.photos;
      const index = photos.findIndex((x) => x.key === key);
      const r: Removal = { kind: 'photo', photo: photos[index], productKey, index };
      list = removePhoto(list, key);
      return r;
    },
    removeProduct(key: string): Removal {
      const index = list.findIndex((p) => p.key === key);
      const r: Removal = { kind: 'product', product: list[index], index, siblings: list.filter((p) => p.key !== key).map((p) => p.key) };
      list = list.filter((p) => p.key !== key);
      return r;
    },
    /** What the panel's undo() does: revive, put back, then restart only skipped work. */
    undo(r: Removal) {
      const plan = planUndo(r, tasks);
      list = undoRemoval(list, plan.removal);
      const runs = plan.restart.map((ph) => run(ph, ph.box, (d, p) => processPhoto(ph, d, p)));
      return { restarted: plan.restart.length, runs };
    },
  };
}

const fresh = (key: string): DraftPhoto => ({ key, status: 'uploading', file: new File([new Uint8Array([1])], `${key}.jpg`) });
const readyPhoto = (key: string, uploadId: string, box?: Box): DraftPhoto => ({
  key,
  status: 'ready',
  uploadId,
  uploadFile: `uploads/${uploadId}.jpg`,
  cutout: cutoutFor(uploadId, box),
  box,
});
const upInfo = (id: string): UploadInfo => ({ id, kind: 'product', file: `uploads/${id}.jpg`, width: 10, height: 10 });

describe('remove during a cutout, then "Geri al"', () => {
  it('before the cutout resolves: exactly one upload and one cutout run, and the result applies once', async () => {
    const h = harness([{ key: 'p', name: 'Koltuk', photos: [fresh('a')] }]);
    const job = h.process(h.photo('a')!);
    await tick();
    h.uploads[0].d.resolve(upInfo('u-a'));
    await tick();
    expect(h.photo('a')?.status).toBe('cutting');

    const r = h.removePhoto('p', 'a');
    const { restarted } = h.undo(r);
    expect(restarted).toBe(0); // the in-flight task carries on
    expect(h.photo('a')).toMatchObject({ status: 'cutting', uploadId: 'u-a' });

    h.cuts[0].d.resolve(cutoutFor('u-a'));
    await job;
    await tick();
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.cut).toHaveBeenCalledTimes(1);
    expect(h.photo('a')).toMatchObject({ status: 'ready', cutout: { id: 'cut-u-a-whole' } });
    expect(h.applied.filter((x) => x.patch.status === 'ready')).toHaveLength(1);
  });

  it('after the cutout resolved while removed: comes back ready with that result, nothing reruns', async () => {
    const h = harness([{ key: 'p', name: 'Koltuk', photos: [fresh('a')] }]);
    const job = h.process(h.photo('a')!);
    await tick();
    h.uploads[0].d.resolve(upInfo('u-a'));
    await tick();
    const r = h.removePhoto('p', 'a');
    h.cuts[0].d.resolve(cutoutFor('u-a'));
    await job;

    const { restarted } = h.undo(r);
    expect(restarted).toBe(0);
    expect(h.photo('a')).toMatchObject({ status: 'ready', uploadId: 'u-a', cutout: { id: 'cut-u-a-whole' } });
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.cut).toHaveBeenCalledTimes(1);
  });

  it('while still queued (skipped as removed): restarts once from its upload, without uploading again', async () => {
    const h = harness([{ key: 'p', name: 'Koltuk', photos: [readyPhoto('x', 'u-x'), readyPhoto('y', 'u-y'), fresh('a')] }]);
    // Two re-cuts occupy both cutout slots, so "a" waits in the queue after its upload.
    const busy = [h.fix(h.photo('x')!, BOX_A), h.fix(h.photo('y')!, BOX_A)];
    const job = h.process(h.photo('a')!);
    await tick();
    h.uploads[0].d.resolve(upInfo('u-a'));
    await tick();
    expect(h.photo('a')?.status).toBe('queued');

    const r = h.removePhoto('p', 'a');
    h.cuts[0].d.resolve(cutoutFor('u-x', BOX_A)); // frees a slot: "a" is skipped as removed
    await job;
    expect(h.cut).toHaveBeenCalledTimes(2);

    const { restarted, runs } = h.undo(r);
    expect(restarted).toBe(1);
    await tick();
    expect(h.cut).toHaveBeenCalledTimes(3);
    expect(h.cuts[2].uploadId).toBe('u-a');
    h.cuts[1].d.resolve(cutoutFor('u-y', BOX_A));
    h.cuts[2].d.resolve(cutoutFor('u-a'));
    await Promise.all([...busy, ...runs]);
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.photo('a')).toMatchObject({ status: 'ready', cutout: { id: 'cut-u-a-whole' } });
  });
});

describe('remove during a "Düzelt" re-cut with a new box, then "Geri al"', () => {
  it('undo before the re-cut resolves: the final cutout comes from the new box', async () => {
    const h = harness([{ key: 'p', name: 'Koltuk', photos: [readyPhoto('a', 'u-a', BOX_A)] }]);
    const job = h.fix(h.photo('a')!, BOX_B);
    await tick();
    const r = h.removePhoto('p', 'a');
    const { restarted } = h.undo(r);
    expect(restarted).toBe(0);
    h.cuts[0].d.resolve(cutoutFor('u-a', BOX_B));
    await job;
    await tick();
    expect(h.cut).toHaveBeenCalledTimes(1);
    expect(h.photo('a')).toMatchObject({ status: 'ready', box: BOX_B, cutout: { id: 'cut-u-a-box0.3' } });
  });

  it('re-cut skipped while removed: the restart repeats the new box, not the old one', async () => {
    const h = harness([
      { key: 'p', name: 'Koltuk', photos: [readyPhoto('x', 'u-x'), readyPhoto('y', 'u-y'), readyPhoto('a', 'u-a', BOX_A)] },
    ]);
    const busy = [h.fix(h.photo('x')!, BOX_A), h.fix(h.photo('y')!, BOX_A)];
    const job = h.fix(h.photo('a')!, BOX_B);
    await tick();
    expect(h.photo('a')?.status).toBe('queued');
    const r = h.removePhoto('p', 'a');
    h.cuts[0].d.resolve(cutoutFor('u-x', BOX_A));
    await job; // skipped: removed

    const { restarted, runs } = h.undo(r);
    expect(restarted).toBe(1);
    await tick();
    h.cuts[1].d.resolve(cutoutFor('u-y', BOX_A));
    const last = h.cuts.at(-1)!;
    expect(last).toMatchObject({ uploadId: 'u-a', box: BOX_B });
    last.d.resolve(cutoutFor('u-a', BOX_B));
    await Promise.all([...busy, ...runs]);
    expect(h.photo('a')).toMatchObject({ status: 'ready', box: BOX_B, cutout: { id: 'cut-u-a-box0.3' } });
  });

  it('an older cut that resolves after a newer re-cut never overwrites it', async () => {
    const h = harness([{ key: 'p', name: 'Koltuk', photos: [readyPhoto('a', 'u-a')] }]);
    const older = h.fix(h.photo('a')!, BOX_A);
    await tick();
    const newer = h.fix(h.photo('a')!, BOX_B); // bumps the token
    await tick();
    h.cuts[1].d.resolve(cutoutFor('u-a', BOX_B));
    await newer;
    h.cuts[0].d.resolve(cutoutFor('u-a', BOX_A));
    await older;
    expect(h.photo('a')).toMatchObject({ box: BOX_B, cutout: { id: 'cut-u-a-box0.3' } });
  });
});

describe('a product removed mid-flight', () => {
  it('drops its results and skips its queued work; the other product is unaffected', async () => {
    const h = harness([
      { key: 'p1', name: 'Koltuk', photos: [fresh('a'), fresh('b'), fresh('c')] },
      { key: 'p2', name: 'Sehpa', photos: [readyPhoto('t', 'u-t')] },
    ]);
    const jobs = ['a', 'b', 'c'].map((k) => h.process(h.photo(k)!));
    await tick();
    h.uploads.forEach((u, i) => u.d.resolve(upInfo(`u-${'abc'[i]}`)));
    await tick();
    expect(h.cut).toHaveBeenCalledTimes(2); // a, b cutting; c queued

    h.removeProduct('p1');
    h.cuts[0].d.resolve(cutoutFor('u-a'));
    h.cuts[1].d.resolve(cutoutFor('u-b'));
    await Promise.all(jobs);
    expect(h.cut).toHaveBeenCalledTimes(2); // c never cut
    expect(h.list.map((p) => p.key)).toEqual(['p2']);
    expect(h.photo('a')).toBeUndefined();
    expect(h.list[0].photos[0]).toMatchObject({ key: 't', status: 'ready' });
  });
});
