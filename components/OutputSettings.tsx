'use client';

import { useState } from 'react';
import { ChevronDown, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { Segmented, StepHeader, useRovingRadio } from './ui';
import { ASPECTS, DEFAULT_ASPECT } from '@/config/aspects';
import {
  AUTO,
  CINEMATIC_CONTROLS,
  CREDITS_PER_IMAGE,
  countSetControls,
  DEFAULT_RESOLUTION,
  RESOLUTIONS,
  type CinematicKey,
} from '@/config/cinematic';
import type { AspectRatio, CinematicSettings, GenerationRequest, Resolution } from '@/lib/types';

export interface OutputValue {
  aspect: AspectRatio;
  count: GenerationRequest['count'];
  resolution: Resolution;
  /** Set controls only; a missing key is "Otomatik". */
  cinematic: CinematicSettings;
}

export const DEFAULT_OUTPUT: OutputValue = {
  aspect: DEFAULT_ASPECT,
  count: 2,
  resolution: DEFAULT_RESOLUTION,
  cinematic: {},
};

const COUNTS: GenerationRequest['count'][] = [1, 2, 3, 4];
const RESOLUTION_OPTIONS = RESOLUTIONS.map((r) => ({ id: r, label: r.toUpperCase() }));
const ASPECT_IDS = ASPECTS.map((a) => a.value);

/** A frame outline in the ratio's true proportions, fitted into a fixed 22 px box. */
function AspectGlyph({ ratio }: { ratio: AspectRatio }) {
  const [w, h] = ratio.split(':').map(Number);
  const BOX = 22;
  const size = w >= h ? { width: BOX, height: Math.round((BOX * h) / w) } : { width: Math.round((BOX * w) / h), height: BOX };
  return (
    <span aria-hidden className="flex size-[22px] shrink-0 items-center justify-center">
      <span style={size} className="rounded-[2px] border-[1.5px] border-current" />
    </span>
  );
}

/** All ten ratios as compact tiles (radiogroup, roving tabindex), in a grid that adds columns as it widens. */
function AspectPicker({ value, onChange }: { value: AspectRatio; onChange: (v: AspectRatio) => void }) {
  const item = useRovingRadio(ASPECT_IDS, value, onChange);
  return (
    <div
      role="radiogroup"
      aria-labelledby="output-aspect"
      data-testid="aspect-picker"
      className="grid grid-cols-[repeat(auto-fill,minmax(8.75rem,1fr))] gap-1.5"
    >
      {ASPECTS.map((a, i) => {
        const selected = a.value === value;
        return (
          <button
            key={a.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-aspect={a.value}
            aria-label={`${a.value} ${a.label}`}
            title={a.hint}
            onClick={() => onChange(a.value)}
            {...item(i)}
            className={`flex min-h-11 items-center gap-2 rounded-control border px-2 py-1.5 text-left transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.98] ${
              selected
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-line bg-field text-muted hover:border-line-strong hover:bg-field-hover hover:text-ink'
            }`}
          >
            <AspectGlyph ratio={a.value} />
            <span className="min-w-0">
              <span className={`block text-label font-medium tabular-nums ${selected ? 'text-accent' : 'text-ink'}`}>
                {a.value}
              </span>
              <span className="block text-small leading-tight text-pretty">{a.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Row({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span id={id} className="text-small font-medium text-muted">
          {label}
        </span>
        {hint && <span className="text-small text-muted tabular-nums">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

interface Props {
  value: OutputValue;
  onChange: (patch: Partial<OutputValue>) => void;
  /** Steps 1 and 2 are done; output always has valid defaults, so the step reads as complete. */
  ready?: boolean;
}

export default function OutputSettings({ value, onChange, ready = false }: Props) {
  const [cinematicOpen, setCinematicOpen] = useState(false);
  const aspectHint = ASPECTS.find((a) => a.value === value.aspect)?.hint;
  const setCount = countSetControls(value.cinematic);

  function setControl(key: CinematicKey, v: string) {
    const next = { ...value.cinematic };
    if (v === AUTO) delete next[key];
    else next[key] = v;
    onChange({ cinematic: next });
  }

  return (
    <section aria-labelledby="output-title" className="space-y-4">
      <StepHeader n={3} id="output-title" title="Çıktı" done={ready} />

      <div className="space-y-4">
        <Row id="output-aspect" label="Boyut" hint={aspectHint}>
          <AspectPicker value={value.aspect} onChange={(aspect) => onChange({ aspect })} />
        </Row>
        <Row id="output-count" label="Görsel sayısı" hint="farklı görsel">
          <Segmented
            labelledBy="output-count"
            options={COUNTS.map((c) => ({ id: c, label: String(c) }))}
            value={value.count}
            onChange={(count) => onChange({ count })}
          />
        </Row>
        <Row
          id="output-resolution"
          label="Çözünürlük"
          hint={`görsel başı ${CREDITS_PER_IMAGE[value.resolution]} kredi`}
        >
          <Segmented
            labelledBy="output-resolution"
            options={RESOLUTION_OPTIONS}
            value={value.resolution}
            onChange={(resolution) => onChange({ resolution })}
          />
        </Row>
      </div>

      <details
        className="group rounded-card border border-line bg-field/40"
        open={cinematicOpen}
        onToggle={(e) => setCinematicOpen(e.currentTarget.open)}
        data-testid="cinematic-settings"
      >
        <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2.5 rounded-card px-3 text-label font-medium text-ink transition-colors duration-150 hover:bg-field">
          <SlidersHorizontal aria-hidden className="size-4 text-muted" />
          <span>Sinematik ayarlar</span>
          <span className={`ml-auto text-small font-normal tabular-nums ${setCount > 0 ? 'text-accent' : 'text-muted'}`}>
            {setCount > 0 ? `${setCount} ayar seçili` : 'Hepsi otomatik'}
          </span>
          <ChevronDown
            aria-hidden
            className="size-4 text-muted transition-transform duration-200 ease-out group-open:rotate-180 motion-reduce:transition-none"
          />
        </summary>
        <div className="space-y-3 border-t border-line px-3 pb-3 pt-3">
          <p className="text-small text-muted">İsteğe bağlı. “Otomatik” bırakılanları model seçer; fiyatı değiştirmez.</p>
          <div className="grid grid-cols-2 gap-x-2.5 gap-y-3">
            {CINEMATIC_CONTROLS.map(({ key, label, options }) => {
              const isSet = value.cinematic[key] !== undefined;
              return (
                <div key={key} className="min-w-0 space-y-1">
                  <label
                    htmlFor={`cinematic-${key}`}
                    className={`flex min-w-0 items-center gap-1.5 text-small font-medium ${isSet ? 'text-ink' : 'text-muted'}`}
                  >
                    <span className="min-w-0 truncate">{label}</span>
                    {isSet && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent" />}
                  </label>
                  <div className="relative">
                    <select
                      id={`cinematic-${key}`}
                      name={`cinematic-${key}`}
                      value={value.cinematic[key] ?? AUTO}
                      onChange={(e) => setControl(key, e.target.value)}
                      className={`field appearance-none truncate py-1.5 pl-2.5 pr-7 text-label ${isSet ? 'border-accent/50' : ''}`}
                    >
                      {options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      aria-hidden
                      className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted"
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => onChange({ cinematic: {} })}
            disabled={setCount === 0}
            className="btn btn-quiet btn-sm -ml-2"
          >
            <RotateCcw aria-hidden />
            Tümünü sıfırla
          </button>
        </div>
      </details>
    </section>
  );
}
