'use client';

import { useEffect, useState } from 'react';
import { Check, ImagePlus, Save } from 'lucide-react';
import Dropzone from './Dropzone';
import { ErrorText, NoticeText, Segmented, Spinner, StepHeader, useRovingRadio } from './ui';
import { STYLES } from '@/config/styles';
import { fileUrl, listSpaces, saveSpace, uploadFile } from '@/lib/client/api';
import type { GenerationRequest, SavedSpace } from '@/lib/types';

export type EnvSource = 'preset' | 'space';
export type SpaceMode = 'place-in-space' | 'inspired-by-space';
export interface SpaceRef {
  uploadId: string;
  file: string;
}
export interface EnvValue {
  source: EnvSource;
  styleId?: string;
  space: SpaceRef | null;
  spaceMode: SpaceMode;
  note: string;
}

export const DEFAULT_ENV: EnvValue = {
  source: 'preset',
  styleId: undefined,
  space: null,
  spaceMode: 'place-in-space',
  note: '',
};

export function isEnvComplete(v: EnvValue): boolean {
  return v.source === 'preset' ? STYLES.some((s) => s.id === v.styleId) : v.space !== null;
}

export function envToRequest(
  v: EnvValue,
): Pick<GenerationRequest, 'envMode' | 'styleId' | 'spaceUploadId' | 'note'> {
  const note = v.note.trim() || undefined;
  return v.source === 'preset'
    ? { envMode: 'preset', styleId: v.styleId, note }
    : { envMode: v.spaceMode, spaceUploadId: v.space?.uploadId, note };
}

interface Props {
  value: EnvValue;
  /** Receives a partial update; the owner merges it into its latest state. */
  onChange: (patch: Partial<EnvValue>) => void;
  /** Inline note, e.g. when a restored generation's space photo no longer exists. */
  spaceNotice?: string;
}

const SOURCE_OPTIONS: { id: EnvSource; label: string }[] = [
  { id: 'preset', label: 'Hazır tarz' },
  { id: 'space', label: 'Referans alan' },
];

const SPACE_MODES: { id: SpaceMode; label: string; description: string }[] = [
  {
    id: 'place-in-space',
    label: 'Bu mekâna yerleştir',
    description: 'Ürün bu odanın içine konur; oda olduğu gibi kalır.',
  },
  {
    id: 'inspired-by-space',
    label: 'Bu tarzda yeni mekân',
    description: 'Aynı hava, ışık ve renklerde yeni bir oda üretilir.',
  },
];
const STYLE_IDS = STYLES.map((s) => s.id);

export default function EnvironmentPanel({ value, onChange, spaceNotice }: Props) {
  const [spaces, setSpaces] = useState<SavedSpace[]>([]);
  const [uploading, setUploading] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    listSpaces()
      .then((s) => !cancelled && setSpaces(s))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const complete = isEnvComplete(value);
  const set = onChange;
  const savedMatch = value.space ? spaces.find((s) => s.uploadId === value.space!.uploadId) : undefined;
  const styleItem = useRovingRadio(STYLE_IDS, value.styleId, (styleId) => set({ styleId }));
  const spaceMode = SPACE_MODES.find((m) => m.id === value.spaceMode) ?? SPACE_MODES[0];

  async function handleSpaceFile(file: File) {
    setError(undefined);
    setNaming(false);
    setUploading(true);
    try {
      const info = await uploadFile(file, 'space');
      set({ space: { uploadId: info.id, file: info.file } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function handleSave() {
    if (!value.space) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Lütfen mekâna bir ad verin.');
      return;
    }
    setError(undefined);
    setSaving(true);
    try {
      const saved = await saveSpace(trimmed, value.space.uploadId);
      setSpaces((prev) => [saved, ...prev]);
      setNaming(false);
      setName('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="env-title" className="space-y-4">
      <StepHeader n={2} id="env-title" title="Ortam" done={complete} />

      <Segmented
        label="Ortam kaynağı"
        options={SOURCE_OPTIONS}
        value={value.source}
        onChange={(source) => set({ source })}
      />

      {value.source === 'preset' ? (
        <div role="radiogroup" aria-label="Oda tarzı" className="grid grid-cols-2 gap-2">
          {STYLES.map((s, i) => {
            const selected = value.styleId === s.id;
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => set({ styleId: s.id })}
                {...styleItem(i)}
                className={`relative rounded-card border px-3 py-2.5 text-left transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.98] ${
                  selected
                    ? 'border-accent bg-accent/10'
                    : 'border-line bg-field hover:border-line-strong hover:bg-field-hover'
                }`}
              >
                <span
                  className={`block pr-5 text-label font-medium ${selected ? 'text-accent' : 'text-ink'}`}
                >
                  {s.name}
                </span>
                <span className="mt-0.5 block text-small text-pretty text-muted">{s.description}</span>
                {selected && (
                  <Check
                    aria-hidden
                    strokeWidth={2.5}
                    className="absolute right-2.5 top-2.5 size-3.5 text-accent"
                  />
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="space-y-4">
          {value.space ? (
            <div className="space-y-3">
              <div className="block w-fit max-w-full overflow-hidden rounded-card ring-1 ring-line">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  data-testid="space-img"
                  src={fileUrl(value.space.file)}
                  alt="Referans mekân"
                  className="block max-h-56 max-w-full"
                />
              </div>
              {savedMatch && <p className="text-label text-muted">Kayıtlı mekân: {savedMatch.name}</p>}
              {naming ? (
                <form
                  className="flex flex-wrap gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleSave();
                  }}
                >
                  <label htmlFor="space-name" className="basis-full text-small font-medium text-muted">
                    Mekân adı
                  </label>
                  <input
                    autoFocus
                    id="space-name"
                    name="space-name"
                    autoComplete="off"
                    placeholder="ör. Showroom salon…"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="field basis-full"
                  />
                  <button type="submit" className="btn btn-primary" disabled={saving}>
                    <Save aria-hidden />
                    {saving ? 'Kaydediliyor…' : 'Kaydet'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => {
                      setNaming(false);
                      setName('');
                    }}
                  >
                    Vazgeç
                  </button>
                </form>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {!savedMatch && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNaming(true)}>
                      <Save aria-hidden />
                      Bu mekânı kaydet
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm"
                    onClick={() => {
                      setNaming(false);
                      set({ space: null });
                    }}
                  >
                    <ImagePlus aria-hidden />
                    Başka mekân
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              <Dropzone
                onFile={handleSpaceFile}
                disabled={uploading}
                label="Mekân fotoğrafını buraya bırakın ya da seçin"
              />
              {uploading && (
                <p role="status" className="flex items-center gap-2 text-label text-muted">
                  <Spinner />
                  Fotoğraf yükleniyor…
                </p>
              )}
            </>
          )}

          {spaceNotice && <NoticeText>{spaceNotice}</NoticeText>}

          {spaces.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-small font-medium text-muted">Kayıtlı mekânlar</h3>
              <ul className="grid grid-cols-3 gap-2" data-testid="saved-spaces">
                {spaces.map((s) => {
                  const selected = value.space?.uploadId === s.uploadId;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          setNaming(false);
                          set({ space: { uploadId: s.uploadId, file: s.file } });
                        }}
                        className={`block w-full overflow-hidden rounded-control border bg-field text-left transition-[border-color,transform] duration-150 ease-out active:scale-[0.98] ${
                          selected ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-line-strong'
                        }`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={fileUrl(s.file)} alt="" loading="lazy" className="block aspect-[4/3] w-full object-cover" />
                        <span className={`block truncate px-2 py-1 text-small ${selected ? 'text-accent' : 'text-ink'}`}>
                          {s.name}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="space-y-2">
            <span id="space-mode-label" className="block text-small font-medium text-muted">
              Mekânı nasıl kullanalım?
            </span>
            <Segmented
              labelledBy="space-mode-label"
              options={SPACE_MODES}
              value={spaceMode.id}
              onChange={(m) => set({ spaceMode: m })}
              describedBy="space-mode-description"
            />
            <p id="space-mode-description" className="text-small text-muted">
              {spaceMode.description}
            </p>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor="env-note" className="block text-small font-medium text-muted">
          Ek not
        </label>
        <textarea
          id="env-note"
          name="env-note"
          rows={2}
          value={value.note}
          onChange={(e) => set({ note: e.target.value })}
          placeholder="ör. akşam ışığı, şömine yanında…"
          autoComplete="off"
          className="field resize-y"
        />
      </div>

      {error && <ErrorText>{error}</ErrorText>}
    </section>
  );
}
