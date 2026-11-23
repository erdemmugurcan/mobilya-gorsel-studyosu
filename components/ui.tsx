'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { AlertCircle, Check, Info } from 'lucide-react';

/**
 * Keyboard behaviour for a custom radiogroup (WAI-ARIA radio pattern): one tab stop on the
 * selected item (roving tabindex), arrow keys / Home / End move and select.
 */
export function useRovingRadio<T>(ids: readonly T[], value: T | undefined, onChange: (v: T) => void) {
  const refs = useRef<(HTMLElement | null)[]>([]);
  const selected = value === undefined ? -1 : ids.indexOf(value);
  const tabStop = selected >= 0 ? selected : 0;

  function move(e: KeyboardEvent, i: number) {
    const n = ids.length;
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (i + 1) % n;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (i - 1 + n) % n;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = n - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    onChange(ids[next]);
    refs.current[next]?.focus();
  }

  return (i: number) => ({
    ref: (el: HTMLElement | null) => {
      refs.current[i] = el;
    },
    tabIndex: i === tabStop ? 0 : -1,
    onKeyDown: (e: KeyboardEvent) => move(e, i),
  });
}

export interface SegmentOption<T> {
  id: T;
  label: ReactNode;
  /** Tooltip text. */
  hint?: string;
}

/** Segmented control with radiogroup semantics and keyboard support. */
export function Segmented<T extends string | number>({
  label,
  labelledBy,
  options,
  value,
  onChange,
  describedBy,
}: {
  /** Accessible name; or pass the id of a visible label as labelledBy. */
  label?: string;
  labelledBy?: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  describedBy?: string;
}) {
  const item = useRovingRadio(
    options.map((o) => o.id),
    value,
    onChange,
  );
  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-control border border-line bg-field p-0.5"
    >
      {options.map((o, i) => {
        const selected = o.id === value;
        return (
          <button
            key={String(o.id)}
            type="button"
            role="radio"
            aria-checked={selected}
            title={o.hint}
            onClick={() => onChange(o.id)}
            {...item(i)}
            className={`flex min-h-8 items-center justify-center gap-1.5 rounded-[6px] px-2 text-label font-medium tabular-nums transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.98] pointer-coarse:min-h-11 ${
              selected ? 'bg-accent text-on-accent' : 'text-muted hover:bg-field-hover hover:text-ink'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Numbered rail step: accent ring while open, filled with a check once complete. */
export function StepHeader({
  n,
  id,
  title,
  done = false,
  status,
  markerTestId,
}: {
  n: number;
  id: string;
  title: string;
  done?: boolean;
  status?: ReactNode;
  markerTestId?: string;
}) {
  return (
    <header className="flex items-center gap-3">
      <span
        aria-hidden
        data-testid={markerTestId}
        className={`flex size-6 shrink-0 items-center justify-center rounded-full text-small font-semibold tabular-nums transition-colors duration-200 ${
          done ? 'bg-accent text-on-accent' : 'border border-accent/70 text-accent'
        }`}
      >
        {done ? <Check className="size-3.5" strokeWidth={2.75} /> : n}
      </span>
      <h2 id={id} className="text-label font-semibold uppercase tracking-[0.08em] text-ink">
        {title}
      </h2>
      {status && <span className="ml-auto text-small text-muted">{status}</span>}
    </header>
  );
}

export function ErrorText({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p role="alert" data-testid={testId} className="flex items-start gap-2 text-label text-danger">
      <AlertCircle aria-hidden className="mt-px size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * Inline validation under a field, linked with aria-describedby. Not an alert (typing would
 * re-announce it); put it inside an always-mounted aria-live="polite" region.
 */
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-small text-danger">
      <AlertCircle aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function NoticeText({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-start gap-2 text-label text-accent">
      <Info aria-hidden className="mt-px size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Small spinner for short waits next to a status line. */
export function Spinner() {
  return (
    <span
      aria-hidden
      className="size-4 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-accent motion-reduce:animate-none"
    />
  );
}
