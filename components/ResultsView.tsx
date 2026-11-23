'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Download, Maximize2, RotateCcw, X } from 'lucide-react';
import { ErrorText, NoticeText } from './ui';
import { STYLES } from '@/config/styles';
import { fileUrl } from '@/lib/client/api';
import { productTitle } from '@/lib/client/products';
import type { AspectRatio, GenerationRecord, GenerationStatus } from '@/lib/types';

interface Props {
  record: GenerationRecord | null;
  onRerun: (record: GenerationRecord) => void;
  rerunning?: boolean;
  error?: string;
  /** E.g. "Tekrar üret" stopped because a product photo no longer exists. */
  notice?: string;
}

export const STATUS_LABEL: Record<GenerationStatus, string> = {
  running: 'Üretiliyor',
  done: 'Tamamlandı',
  partial: 'Kısmen tamamlandı',
  failed: 'Başarısız',
};

export const ASPECT_CLASS: Record<AspectRatio, string> = {
  '1:1': 'aspect-square',
  '4:5': 'aspect-[4/5]',
  '9:16': 'aspect-[9/16]',
  '3:4': 'aspect-[3/4]',
  '2:3': 'aspect-[2/3]',
  '4:3': 'aspect-[4/3]',
  '3:2': 'aspect-[3/2]',
  '5:4': 'aspect-[5/4]',
  '16:9': 'aspect-[16/9]',
  '21:9': 'aspect-[21/9]',
};

/** The scene's products, then environment and output: "Koltuk + Sehpa · Hazır tarz: … · 4:5 · 2K · 2 görsel". */
export function describeRecord(r: GenerationRecord): string {
  const env =
    r.envMode === 'preset'
      ? `Hazır tarz: ${STYLES.find((s) => s.id === r.styleId)?.name ?? r.styleId}`
      : r.envMode === 'place-in-space'
        ? 'Bu mekâna yerleştir'
        : 'Bu tarzda yeni mekân';
  return `${productTitle(r.products)} · ${env} · ${r.aspect} · ${(r.resolution ?? '2k').toUpperCase()} · ${r.count} görsel`;
}

const downloadName = (r: GenerationRecord, index: number) => `mobilya-${r.id}-${index}.jpg`;

/** Tile actions: always shown on touch screens, on hover/focus with a mouse. */
const OVERLAY =
  'transition-opacity duration-200 ease-out pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100';

/** width ÷ height, used to cap tile columns so a whole tile fits on screen */
const RATIO: Record<AspectRatio, number> = {
  '1:1': 1,
  '4:5': 4 / 5,
  '9:16': 9 / 16,
  '3:4': 3 / 4,
  '2:3': 2 / 3,
  '4:3': 4 / 3,
  '3:2': 3 / 2,
  '5:4': 5 / 4,
  '16:9': 16 / 9,
  '21:9': 21 / 9,
};

function Lightbox({ src, downloadAs, onClose }: { src: string; downloadAs: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = dialog.current;
    // Native modal dialog: traps focus, makes the page inert, Esc fires "cancel".
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el?.showModal();
    closeBtn.current?.focus();
    return () => {
      el?.close();
      returnTo?.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-label="Görsel büyük boyutta"
      data-testid="lightbox"
      className="lightbox fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overscroll-contain bg-transparent p-0 text-ink backdrop:bg-scrim"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex h-full flex-col items-center justify-center gap-4 p-4 sm:p-8"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt="Üretilen görsel"
          className="min-h-0 max-w-full flex-1 rounded-card object-contain shadow-2xl"
        />
        <div className="flex shrink-0 gap-2">
          <a href={src} download={downloadAs} className="btn btn-primary">
            <Download aria-hidden />
            İndir
          </a>
          <button type="button" ref={closeBtn} onClick={onClose} className="btn btn-ghost">
            <X aria-hidden />
            Kapat
          </button>
        </div>
      </div>
    </dialog>
  );
}

function EmptyState() {
  return (
    <div className="viewfinder flex min-h-[22rem] flex-col items-center justify-center gap-2 rounded-card bg-panel/60 px-6 py-16 text-center ring-1 ring-line lg:min-h-[28rem]">
      <h3 className="font-display text-display-sm text-balance text-ink">Görseller burada görünecek</h3>
      <p className="max-w-sm text-body text-pretty text-muted">Ürün fotoğraflarını yükleyip ortamı seçin, sonra ÜRET düğmesine basın.</p>
    </div>
  );
}

export default function ResultsView({ record, onRerun, rerunning, error, notice }: Props) {
  const [zoomed, setZoomed] = useState<{ src: string; downloadAs: string } | null>(null);
  const closeZoom = useCallback(() => setZoomed(null), []);

  return (
    <section aria-labelledby="results-title" className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 space-y-1">
          <h2 id="results-title" className="scroll-mt-20 font-display text-display text-balance text-ink">
            Sonuçlar
          </h2>
          {record && (
            <p className="text-label text-muted tabular-nums" data-testid="results-summary">
              {describeRecord(record)} ·{' '}
              <span className={record.status === 'failed' ? 'text-danger' : record.status === 'running' ? 'text-accent' : ''}>
                {STATUS_LABEL[record.status]}
              </span>
            </p>
          )}
        </div>
        {record && record.status !== 'running' && (
          <button type="button" className="btn btn-ghost" disabled={rerunning} onClick={() => onRerun(record)}>
            <RotateCcw aria-hidden />
            {rerunning ? 'Başlatılıyor…' : 'Tekrar üret'}
          </button>
        )}
      </header>

      {error && <ErrorText>{error}</ErrorText>}
      {notice && <NoticeText>{notice}</NoticeText>}

      {!record ? (
        <EmptyState />
      ) : (
        <ul
          className="result-grid"
          data-count={record.outputs.length}
          data-testid="result-tiles"
          style={{ '--tile-max': `calc(68dvh * ${RATIO[record.aspect]})` } as React.CSSProperties}
        >
          {record.outputs.map((o) => (
            <li key={o.index} data-status={o.status} className="min-w-0">
              <div
                className={`${ASPECT_CLASS[record.aspect]} group relative overflow-hidden rounded-card bg-panel ring-1 ring-line`}
              >
                {o.status === 'pending' && (
                  <div
                    role="status"
                    className="viewfinder shimmer absolute inset-0 flex items-center justify-center text-label text-muted"
                  >
                    Görsel üretiliyor…
                  </div>
                )}
                {o.status === 'done' && o.file && (
                  <>
                    {/* The whole tile opens the lightbox; its visible "Büyüt" chip only labels it. */}
                    <button
                      type="button"
                      className="absolute inset-0 block cursor-zoom-in focus-visible:-outline-offset-2"
                      aria-label={`Görsel ${o.index + 1}, büyüt`}
                      onClick={() => setZoomed({ src: fileUrl(o.file!), downloadAs: downloadName(record, o.index) })}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={fileUrl(o.file)}
                        alt={`Üretilen görsel ${o.index + 1}`}
                        className="h-full w-full object-cover"
                      />
                      <span
                        aria-hidden
                        className={`${OVERLAY} absolute inset-x-0 bottom-0 flex bg-linear-to-t from-dim to-transparent p-2.5 pt-12`}
                      >
                        <span className="btn btn-ghost btn-sm max-sm:w-11 max-sm:px-0">
                          <Maximize2 />
                          <span className="max-sm:hidden">Büyüt</span>
                        </span>
                      </span>
                    </button>
                    <a
                      href={fileUrl(o.file)}
                      download={downloadName(record, o.index)}
                      aria-label={`Görsel ${o.index + 1}, indir`}
                      className={`${OVERLAY} btn btn-primary btn-sm absolute bottom-2.5 right-2.5 max-sm:w-11 max-sm:px-0`}
                    >
                      <Download aria-hidden />
                      <span className="max-sm:hidden">İndir</span>
                    </a>
                  </>
                )}
                {o.status === 'failed' && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-5 text-center">
                    <AlertTriangle aria-hidden strokeWidth={1.5} className="size-5 text-danger" />
                    <p className="text-label text-danger" data-testid="tile-error">
                      {o.error || 'Görsel üretilemedi.'}
                    </p>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {zoomed && <Lightbox src={zoomed.src} downloadAs={zoomed.downloadAs} onClose={closeZoom} />}
    </section>
  );
}
