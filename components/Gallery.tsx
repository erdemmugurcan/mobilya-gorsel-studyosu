'use client';

import { AlertTriangle, ImageOff, LoaderCircle } from 'lucide-react';
import { fileUrl } from '@/lib/client/api';
import { productTitle } from '@/lib/client/products';
import type { GenerationRecord, GenerationStatus } from '@/lib/types';
import { describeRecord, STATUS_LABEL } from './ResultsView';
import { ErrorText } from './ui';

interface Props {
  records: GenerationRecord[];
  selectedId?: string;
  onSelect: (record: GenerationRecord) => void;
  error?: string;
}

const dateFmt = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'short', timeStyle: 'short' });

const STATUS_TONE: Record<GenerationStatus, string> = {
  running: 'text-accent',
  done: 'text-ink',
  partial: 'text-ink',
  failed: 'text-danger',
};

function StatusIcon({ status }: { status: GenerationStatus }) {
  if (status === 'running')
    return <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />;
  if (status === 'failed') return <AlertTriangle aria-hidden strokeWidth={1.75} className="size-4" />;
  return <ImageOff aria-hidden strokeWidth={1.75} className="size-4" />;
}

export default function Gallery({ records, selectedId, onSelect, error }: Props) {
  return (
    <section aria-labelledby="gallery-title" className="space-y-4">
      <header className="space-y-1">
        <h2 id="gallery-title" className="font-display text-display-sm text-ink">
          Galeri
        </h2>
        <p className="text-label text-muted">Önceki üretimler. Tıklayınca ayarlar forma geri yüklenir.</p>
      </header>

      {error && <ErrorText>{error}</ErrorText>}

      {records.length === 0 ? (
        !error && <p className="text-label text-muted">Henüz üretim yok.</p>
      ) : (
        <ul
          className="grid grid-cols-3 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))]"
          data-testid="gallery"
        >
          {records.map((r) => {
            const thumb = r.outputs.find((o) => o.status === 'done' && o.file)?.file;
            const selected = r.id === selectedId;
            const title = productTitle(r.products);
            return (
              <li key={r.id} className="min-w-0">
                <button
                  type="button"
                  data-testid="gallery-item"
                  data-id={r.id}
                  data-status={r.status}
                  aria-pressed={selected}
                  title={describeRecord(r)}
                  onClick={() => onSelect(r)}
                  className="group block w-full rounded-control text-left transition-transform duration-150 ease-out active:scale-[0.98]"
                >
                  <span
                    className={`relative block aspect-square overflow-hidden rounded-control bg-panel ring-offset-2 ring-offset-canvas transition-[box-shadow] duration-150 ${
                      selected ? 'ring-2 ring-accent' : 'ring-1 ring-line group-hover:ring-line-strong'
                    }`}
                  >
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={fileUrl(thumb)}
                        alt=""
                        width={120}
                        height={120}
                        loading="lazy"
                        className="h-full w-full object-cover transition-opacity duration-150 group-hover:opacity-90"
                      />
                    ) : (
                      <span
                        className={`flex h-full w-full flex-col items-center justify-center gap-1.5 px-2 text-center text-small ${STATUS_TONE[r.status]}`}
                      >
                        <StatusIcon status={r.status} />
                        {STATUS_LABEL[r.status]}
                      </span>
                    )}
                    {thumb && r.status !== 'done' && (
                      <span
                        className={`absolute bottom-1.5 left-1.5 max-w-[calc(100%-0.75rem)] truncate rounded-chip bg-topbar/85 px-2 py-0.5 text-[11px] font-medium backdrop-blur-sm ${STATUS_TONE[r.status]}`}
                      >
                        {STATUS_LABEL[r.status]}
                      </span>
                    )}
                  </span>
                  <span
                    data-testid="gallery-title"
                    className={`mt-1.5 block truncate text-small font-medium ${selected ? 'text-ink' : 'text-ink/85'}`}
                  >
                    {title}
                  </span>
                  <span className="block truncate text-small text-muted tabular-nums">
                    {dateFmt.format(new Date(r.createdAt))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
