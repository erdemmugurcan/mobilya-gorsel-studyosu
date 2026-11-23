'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Crop, Plus, RotateCcw, Scissors, Trash2, Undo2 } from 'lucide-react';
import BoxSelector from './BoxSelector';
import Dropzone from './Dropzone';
import { ErrorText, FieldError, NoticeText, Spinner, StepHeader } from './ui';
import { createCutout, fileUrl, getUpload, uploadFile } from '@/lib/client/api';
import {
  appendPhotos,
  canUndo,
  createLimiter,
  createPhotoTasks,
  CUTOUT_CONCURRENCY,
  cutPhoto,
  emptyProduct,
  hasPhoto,
  isProcessing,
  MAX_PHOTOS,
  MAX_PRODUCTS,
  movePhoto,
  nameError,
  planPhotos,
  planUndo,
  processPhoto,
  productsState,
  readyPhotos,
  removePhoto,
  undoRemoval,
  trackPhotoTask,
  updatePhoto,
  updateProduct,
  type DraftPhoto,
  type DraftProduct,
  type PhotoDeps,
  type PhotoPatch,
  type PhotoStatus,
  type Removal,
} from '@/lib/client/products';
import type { Box } from '@/lib/types';

interface Props {
  value: DraftProduct[];
  /** Functional update: async photo results patch the latest list, never a stale copy. */
  onChange: (update: (prev: DraftProduct[]) => DraftProduct[]) => void;
  /** The user added photos (the page clears a restore notice). */
  onEdit?: () => void;
}

interface Editing {
  photoKey: string;
  box?: Box;
  loading?: boolean;
  error?: string;
}

const STATUS_TEXT: Record<PhotoStatus, string> = {
  uploading: 'Yükleniyor…',
  queued: 'Sırada',
  cutting: 'Ayıklanıyor…',
  ready: 'hazır',
  error: 'Hata',
};
const SOURCE_LOST = 'Bu fotoğrafın aslı bulunamadı. Düzeltmek için fotoğrafı yeniden yükleyin.';
/** Uploads are light next to cutouts but still run a few at a time. */
const UPLOAD_CONCURRENCY = 3;

function PhotoTile({
  photo,
  index,
  selected,
  onSelect,
}: {
  photo: DraftPhoto;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const ready = photo.status === 'ready';
  const src = photo.cutout ? fileUrl(photo.cutout.file) : photo.uploadFile ? fileUrl(photo.uploadFile) : undefined;
  const busy = isProcessing(photo);
  return (
    <li className="min-w-0">
      <button
        type="button"
        data-testid="photo-tile"
        data-photo-key={photo.key}
        data-status={photo.status}
        aria-pressed={selected}
        aria-label={`${index + 1}. fotoğraf${index === 0 ? ', kapak' : ''}: ${STATUS_TEXT[photo.status]}`}
        onClick={onSelect}
        className={`relative block aspect-square w-full overflow-hidden rounded-control ring-offset-2 ring-offset-panel transition-[box-shadow,transform] duration-150 ease-out active:scale-[0.97] ${
          selected ? 'ring-2 ring-accent' : 'ring-1 ring-line hover:ring-line-strong'
        } ${ready ? 'checkerboard' : 'bg-field'}`}
      >
        {src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt=""
            width={photo.cutout?.width ?? 96}
            height={photo.cutout?.height ?? 96}
            draggable={false}
            className={`h-full w-full object-contain p-1 transition-opacity duration-200 ${ready ? '' : 'opacity-30'}`}
          />
        )}
        {!ready && (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-1 text-center text-small">
            {photo.status === 'error' ? (
              <AlertTriangle aria-hidden strokeWidth={1.75} className="size-4 text-danger" />
            ) : busy && photo.status !== 'queued' ? (
              <Spinner />
            ) : null}
            <span className={photo.status === 'error' ? 'text-danger' : 'text-muted'}>{STATUS_TEXT[photo.status]}</span>
          </span>
        )}
        {index === 0 && (
          <span className="absolute left-1 top-1 rounded-chip bg-topbar/85 px-1.5 py-px text-[11px] font-medium text-ink backdrop-blur-sm">
            Kapak
          </span>
        )}
      </button>
    </li>
  );
}

export default function ProductsPanel({ value, onChange, onEdit }: Props) {
  const uid = useId();
  const [cutLimit] = useState(() => createLimiter(CUTOUT_CONCURRENCY));
  const [uploadLimit] = useState(() => createLimiter(UPLOAD_CONCURRENCY));
  /** Generation token per photo: a superseded upload/cut can neither run on nor patch. */
  const [tasks] = useState(createPhotoTasks);
  const latest = useRef(value);
  /**
   * Photos to process once they are in the list: new uploads, and photos put back by "Geri al"
   * mid-upload/cut. Started after `latest` has caught up, so their alive() check holds.
   */
  const startQueue = useRef<DraftPhoto[]>([]);
  const startRef = useRef<(ph: DraftPhoto) => void>(() => {});
  useEffect(() => {
    latest.current = value;
    const queued = startQueue.current;
    startQueue.current = [];
    for (const ph of queued) if (hasPhoto(value, ph.key)) startRef.current(ph);
  }, [value]);

  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [focusedName, setFocusedName] = useState<string | null>(null);
  const [focusProduct, setFocusProduct] = useState<{ key: string } | null>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const fixRef = useRef<HTMLButtonElement>(null);
  const [focusFix, setFocusFix] = useState(0);
  /** A fresh object per request, so focusing the same photo twice still runs the effect. */
  const [focusPhoto, setFocusPhoto] = useState<{ key: string } | null>(null);
  useEffect(() => {
    if (focusPhoto) document.querySelector<HTMLElement>(`[data-photo-key="${focusPhoto.key}"]`)?.focus();
  }, [focusPhoto]);
  useEffect(() => {
    if (focusFix) fixRef.current?.focus();
  }, [focusFix]);
  /** The last removal; "Geri al" puts it back until the next add or removal. */
  const [removal, setRemoval] = useState<Removal | null>(null);
  const undoable = removal && canUndo(value, removal) ? removal : null;
  const [focusUndo, setFocusUndo] = useState(0);
  useEffect(() => {
    if (focusUndo) undoRef.current?.focus();
  }, [focusUndo]);

  const state = productsState(value);
  const full = value.length >= MAX_PRODUCTS;
  const anyCutting = value.some((p) => p.photos.some((ph) => ph.status === 'cutting'));
  const nameId = (i: number) => `${uid}-name-${i}`;

  // A freshly added product: focus its name with the default selected, ready to type over.
  useEffect(() => {
    if (!focusProduct) return;
    const i = latest.current.findIndex((p) => p.key === focusProduct.key);
    const el = i >= 0 ? (document.getElementById(nameId(i)) as HTMLInputElement | null) : null;
    el?.focus();
    el?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusProduct]);

  const patcher = (photoKey: string) => (p: PhotoPatch) => onChange((prev) => updatePhoto(prev, photoKey, p));

  /** Runs one upload/cut for a photo under a fresh token (superseding any earlier run for it). */
  function runTask(
    ph: DraftPhoto,
    box: Box | undefined,
    op: (deps: PhotoDeps, patch: (p: PhotoPatch) => void) => Promise<boolean>,
  ): Promise<boolean> {
    const t = trackPhotoTask(tasks, ph.key, box, () => hasPhoto(latest.current, ph.key), patcher(ph.key));
    const deps: PhotoDeps = {
      upload: (file) => uploadLimit(() => uploadFile(file, 'product')),
      cut: (uploadId, b) => createCutout(uploadId, b),
      limit: cutLimit,
      alive: t.alive,
    };
    return op(deps, t.patch).finally(t.done);
  }

  function addFiles(productKey: string, files: File[]) {
    const product = latest.current.find((p) => p.key === productKey);
    if (!product) return;
    const { added, rejected } = planPhotos(product.photos.length, files);
    setNotes((n) => ({
      ...n,
      [productKey]: rejected > 0 ? `Bir ürüne en fazla ${MAX_PHOTOS} fotoğraf eklenebilir; ${rejected} dosya eklenmedi.` : '',
    }));
    if (added.length === 0) return;
    setRemoval(null);
    onEdit?.();
    startQueue.current.push(...added);
    onChange((prev) => appendPhotos(prev, productKey, added));
  }

  function retry(ph: DraftPhoto) {
    void runTask(ph, ph.box, (d, p) => processPhoto(ph, d, p));
  }
  useEffect(() => {
    startRef.current = retry;
  });

  function remove(ph: DraftPhoto, productKey: string) {
    // Snapshot from the latest committed state, not the render that drew the toolbar.
    const photos = latest.current.find((p) => p.key === productKey)?.photos ?? [];
    const index = photos.findIndex((x) => x.key === ph.key);
    onChange((prev) => removePhoto(prev, ph.key));
    setRemoval(index >= 0 ? { kind: 'photo', photo: photos[index], productKey, index } : null);
    setNotes((n) => ({ ...n, [productKey]: '' }));
    setSelected(null);
    if (editing?.photoKey === ph.key) setEditing(null);
    // The toolbar that held the focus is gone: hand it to "Geri al".
    setFocusUndo((n) => n + 1);
  }

  function undo() {
    if (!undoable) return;
    // Results that landed while removed come back with it; a still-running task is left alone,
    // and only work skipped while removed starts again (once it is back in the list).
    const { removal: r, restart } = planUndo(undoable, tasks);
    onChange((prev) => undoRemoval(prev, r));
    setRemoval(null);
    startQueue.current.push(...restart);
    // "Geri al" disappears with the undo: focus what came back.
    if (r.kind === 'photo') {
      setSelected(r.photo.key);
      setFocusPhoto({ key: r.photo.key });
    } else setFocusProduct({ key: r.product.key });
  }

  async function openEditor(ph: DraftPhoto) {
    if (ph.uploadFile) {
      setEditing({ photoKey: ph.key, box: ph.box });
      return;
    }
    if (!ph.uploadId) {
      setEditing({ photoKey: ph.key, error: SOURCE_LOST });
      return;
    }
    setEditing({ photoKey: ph.key, box: ph.box, loading: true });
    const stillOpen = (e: Editing | null) => e?.photoKey === ph.key;
    try {
      const u = await getUpload(ph.uploadId);
      patcher(ph.key)({ uploadFile: u.file });
      setEditing((e) => (stillOpen(e) ? { ...e!, loading: false } : e));
    } catch {
      setEditing((e) => (stillOpen(e) ? { ...e!, loading: false, error: SOURCE_LOST } : e));
    }
  }

  async function applyBox(ph: DraftPhoto) {
    if (!editing?.box) return;
    const box = editing.box;
    const ok = await runTask(ph, box, (d, p) => cutPhoto(ph, box, d, p));
    if (ok) {
      setEditing((e) => (e?.photoKey === ph.key ? null : e));
      // The editor that held the focus closes: back to the photo's "Düzelt".
      setFocusFix((n) => n + 1);
    }
  }

  function closeEditor() {
    if (editing) patcher(editing.photoKey)({ fixError: undefined });
    setEditing(null);
    setFocusFix((n) => n + 1);
  }

  function addProduct() {
    if (latest.current.length >= MAX_PRODUCTS) return;
    const p = emptyProduct(latest.current);
    onChange((prev) => (prev.length >= MAX_PRODUCTS ? prev : [...prev, p]));
    setRemoval(null);
    setFocusProduct({ key: p.key });
  }

  function removeProduct(key: string) {
    const list = latest.current;
    const index = list.findIndex((p) => p.key === key);
    if (index < 0 || list.length <= 1) return;
    onChange((prev) => (prev.length > 1 ? prev.filter((p) => p.key !== key) : prev));
    setRemoval({ kind: 'product', product: list[index], index, siblings: list.filter((p) => p.key !== key).map((p) => p.key) });
    setNotes((n) => ({ ...n, [key]: '' }));
    setSelected(null);
    setEditing(null);
    setFocusUndo((n) => n + 1);
  }

  const readyCount = value.filter((p) => readyPhotos(p).length > 0).length;
  const live = state.processing
    ? 'Fotoğraflar ayıklanıyor.'
    : state.ready
      ? value.length === 1
        ? 'Ürün hazır.'
        : `${value.length} ürün hazır.`
      : '';

  return (
    <section aria-labelledby="product-title" className="space-y-4">
      <StepHeader
        n={1}
        id="product-title"
        title="Ürünler"
        done={state.ready}
        markerTestId="step-1-marker"
        status={
          state.processing ? (
            <span className="flex items-center gap-1.5">
              <Spinner />
              Ayıklanıyor…
            </span>
          ) : state.ready ? (
            <span className="text-accent">{value.length === 1 ? 'Ürün hazır' : `${readyCount} ürün hazır`}</span>
          ) : undefined
        }
      />
      <p className="text-small text-pretty text-muted">
        Aynı ürünün farklı açılarını ekleyin (önden, yandan, yakın çekim). Sahneye en fazla 4 ürün.
      </p>
      <p className="sr-only" aria-live="polite">
        {live}
      </p>

      <ol className="space-y-3" aria-label="Ürünler" data-testid="products">
        {value.map((product, pi) => {
          const err = nameError(value, product.key);
          // An empty name is only flagged once the field is left; length and duplicates show at once.
          const showErr = err && !(product.name.trim() === '' && focusedName === product.key);
          const errId = `${uid}-name-err-${pi}`;
          const sel = product.photos.find((ph) => ph.key === selected);
          const selIndex = sel ? product.photos.indexOf(sel) : -1;
          const edit = editing ? product.photos.find((ph) => ph.key === editing.photoKey) : undefined;
          const editIndex = edit ? product.photos.indexOf(edit) : -1;
          const editBusy = edit ? isProcessing(edit) : false;
          const editErr = edit ? (editing?.error ?? edit.fixError ?? (edit.status === 'error' ? edit.error : undefined)) : undefined;
          const note = notes[product.key];
          const count = product.photos.length;

          return (
            <li
              key={product.key}
              data-testid="product-card"
              className="space-y-3 rounded-card border border-line bg-field/40 p-3"
            >
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <label htmlFor={nameId(pi)} className="shrink-0 text-small font-medium text-muted">
                    Ad<span className="sr-only">, {pi + 1}. ürün</span>
                  </label>
                  <input
                    id={nameId(pi)}
                    name={`product-name-${pi}`}
                    autoComplete="off"
                    spellCheck={false}
                    value={product.name}
                    aria-invalid={showErr ? true : undefined}
                    aria-describedby={showErr ? errId : undefined}
                    onChange={(e) => {
                      const name = e.target.value;
                      onChange((prev) => updateProduct(prev, product.key, { name }));
                    }}
                    onFocus={() => setFocusedName(product.key)}
                    onBlur={() => {
                      setFocusedName(null);
                      const trimmed = product.name.trim();
                      if (trimmed !== product.name) onChange((prev) => updateProduct(prev, product.key, { name: trimmed }));
                    }}
                    className={`field py-1.5 font-medium pointer-coarse:min-h-11 ${showErr ? 'border-danger' : ''}`}
                  />
                  {value.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Ürünü kaldır: ${product.name.trim() || `${pi + 1}. ürün`}`}
                      title="Ürünü kaldır"
                      onClick={() => removeProduct(product.key)}
                      className="btn btn-quiet btn-sm w-8 shrink-0 px-0 hover:text-danger pointer-coarse:w-11"
                    >
                      <Trash2 aria-hidden />
                    </button>
                  )}
                </div>
                {/* Always mounted, so the message is announced when it appears. */}
                <div aria-live="polite">{showErr && <FieldError id={errId}>{err}</FieldError>}</div>
              </div>

              {count === 0 ? (
                <Dropzone
                  multiple
                  onFiles={(files) => addFiles(product.key, files)}
                  label="Fotoğrafları buraya bırakın ya da seçin"
                  hint={`JPG veya PNG, en fazla ${MAX_PHOTOS} fotoğraf`}
                />
              ) : (
                <>
                  <ul className="grid grid-cols-3 gap-2" aria-label={`${product.name.trim() || `${pi + 1}. ürün`} fotoğrafları`}>
                    {product.photos.map((ph, i) => (
                      <PhotoTile
                        key={ph.key}
                        photo={ph}
                        index={i}
                        selected={ph.key === selected}
                        onSelect={() => setSelected((s) => (s === ph.key ? null : ph.key))}
                      />
                    ))}
                    {count < MAX_PHOTOS && (
                      <li className="min-w-0">
                        <Dropzone
                          variant="tile"
                          multiple
                          onFiles={(files) => addFiles(product.key, files)}
                          label="Fotoğraf ekle"
                          hint={`JPG veya PNG, en fazla ${MAX_PHOTOS - count} fotoğraf daha`}
                        />
                      </li>
                    )}
                  </ul>

                  {sel ? (
                    <div
                      role="group"
                      aria-label={`${selIndex + 1}. fotoğraf`}
                      className="flex flex-wrap items-center gap-1.5"
                      data-testid="photo-toolbar"
                    >
                      <button
                        ref={fixRef}
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={!sel.uploadId || isProcessing(sel)}
                        aria-expanded={editing?.photoKey === sel.key}
                        onClick={() => (editing?.photoKey === sel.key ? closeEditor() : void openEditor(sel))}
                      >
                        <Crop aria-hidden />
                        Düzelt
                      </button>
                      <button
                        type="button"
                        aria-label="Sola taşı"
                        title="Sola taşı"
                        aria-disabled={selIndex === 0}
                        onClick={() => selIndex > 0 && onChange((prev) => movePhoto(prev, sel.key, -1))}
                        className="btn btn-quiet btn-sm w-8 px-0 pointer-coarse:w-11"
                      >
                        <ChevronLeft aria-hidden />
                      </button>
                      <button
                        type="button"
                        aria-label="Sağa taşı"
                        title="Sağa taşı"
                        aria-disabled={selIndex === count - 1}
                        onClick={() => selIndex < count - 1 && onChange((prev) => movePhoto(prev, sel.key, 1))}
                        className="btn btn-quiet btn-sm w-8 px-0 pointer-coarse:w-11"
                      >
                        <ChevronRight aria-hidden />
                      </button>
                      <span aria-hidden className="text-small text-muted tabular-nums max-sm:hidden">
                        {selIndex === 0 ? 'Kapak' : `${selIndex + 1}. fotoğraf`}
                      </span>
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm ml-auto hover:text-danger"
                        onClick={() => remove(sel, product.key)}
                      >
                        <Trash2 aria-hidden />
                        Kaldır
                      </button>
                    </div>
                  ) : (
                    <p className="flex items-baseline justify-between gap-3 text-small text-muted">
                      <span>Düzeltmek ya da sırasını değiştirmek için bir fotoğraf seçin.</span>
                      <span className="shrink-0 tabular-nums">
                        {count}/{MAX_PHOTOS}
                      </span>
                    </p>
                  )}

                  {edit && editing && (
                    <div className="space-y-3 rounded-control border border-line bg-panel p-3" data-testid="photo-editor">
                      <p className="text-label font-medium text-ink">
                        {editIndex === 0 ? 'Kapak fotoğrafını' : `${editIndex + 1}. fotoğrafı`} düzelt
                      </p>
                      {editing.loading ? (
                        <p role="status" className="flex items-center gap-2 text-label text-muted">
                          <Spinner />
                          Fotoğraf açılıyor…
                        </p>
                      ) : (
                        edit.uploadFile && (
                          <>
                            <BoxSelector
                              src={fileUrl(edit.uploadFile)}
                              alt="Ürünün kaynak fotoğrafı"
                              enabled={!editBusy}
                              box={editing.box}
                              onBox={(box) => setEditing((e) => (e ? { ...e, box } : e))}
                            />
                            <p className="text-small text-pretty text-muted">
                              Ürünün etrafına bir kutu çizin; yalnızca kutunun içi ayıklanır. Yeniden çizerseniz önceki kutu silinir.
                            </p>
                          </>
                        )
                      )}
                      {editBusy ? (
                        <p role="status" className="flex items-center gap-2 text-label text-muted">
                          <Spinner />
                          Ürün ayıklanıyor…
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {edit.uploadFile && (
                            <button
                              type="button"
                              className="btn btn-primary btn-sm"
                              disabled={!editing.box}
                              onClick={() => void applyBox(edit)}
                            >
                              <Scissors aria-hidden />
                              Yeniden ayıkla
                            </button>
                          )}
                          <button type="button" className="btn btn-quiet btn-sm" onClick={closeEditor}>
                            Vazgeç
                          </button>
                        </div>
                      )}
                      {editErr && <ErrorText>{editErr}</ErrorText>}
                    </div>
                  )}

                  {product.photos.map(
                    (ph, i) =>
                      ph.status === 'error' &&
                      ph.key !== edit?.key && (
                        <div key={ph.key} className="flex items-start justify-between gap-2">
                          <ErrorText testId="photo-error">
                            {i === 0 ? 'Kapak' : `${i + 1}. fotoğraf`}: {ph.error}
                          </ErrorText>
                          <button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={() => retry(ph)}>
                            <RotateCcw aria-hidden />
                            Tekrar dene
                          </button>
                        </div>
                      ),
                  )}
                </>
              )}

              {note && <NoticeText>{note}</NoticeText>}
            </li>
          );
        })}
      </ol>

      {/* Always mounted (empty when there is nothing to undo), so the first removal is announced. */}
      <div role="status" data-testid="undo-region" className="empty:m-0">
        {undoable && (
          <div
            data-testid="undo-bar"
            className="flex items-center justify-between gap-3 rounded-control border border-line bg-field px-3 py-1.5"
          >
            <p className="min-w-0 truncate text-label text-muted">
              {undoable.kind === 'product'
                ? `“${undoable.product.name.trim() || 'Ürün'}” kaldırıldı.`
                : `${value.find((p) => p.key === undoable.productKey)?.name.trim() || 'Ürün'}: ${
                    undoable.index === 0 ? 'kapak fotoğrafı' : `${undoable.index + 1}. fotoğraf`
                  } kaldırıldı.`}
            </p>
            <button ref={undoRef} type="button" className="btn btn-quiet btn-sm shrink-0 text-ink" onClick={undo}>
              <Undo2 aria-hidden />
              Geri al
            </button>
          </div>
        )}
      </div>

      {anyCutting && (
        <p className="text-small text-muted">Arka plan ayıklama ilk seferde yarım dakikaya kadar sürebilir.</p>
      )}

      <div className="space-y-1.5">
        <button
          type="button"
          className="btn btn-ghost w-full"
          aria-disabled={full}
          aria-describedby={full ? `${uid}-limit` : undefined}
          onClick={addProduct}
        >
          <Plus aria-hidden />
          Ürün ekle
        </button>
        {full && (
          <p id={`${uid}-limit`} className="text-small text-muted">
            Sahneye en fazla {MAX_PRODUCTS} ürün eklenebilir.
          </p>
        )}
      </div>
    </section>
  );
}
