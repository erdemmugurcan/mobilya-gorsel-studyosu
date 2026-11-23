'use client';

import { useRef, useState } from 'react';
import type { Box } from '@/lib/types';

interface Props {
  src: string;
  alt: string;
  enabled: boolean;
  box?: Box;
  onBox: (box: Box | undefined) => void;
}

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** Shows an image; when enabled, one rectangle can be drawn on it (normalized 0..1). */
export default function BoxSelector({ src, alt, enabled, box, onBox }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Box | undefined>();

  const point = (e: React.PointerEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };
  const rect = (a: { x: number; y: number }, b: { x: number; y: number }): Box => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  });

  const shown = draft ?? box;

  return (
    <div
      ref={wrap}
      data-testid="box-surface"
      className={`relative block w-fit max-w-full select-none overflow-hidden rounded-card bg-field ring-1 ring-line ${
        enabled ? 'cursor-crosshair touch-none' : ''
      }`}
      onPointerDown={(e) => {
        if (!enabled) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = point(e);
        setDraft({ ...start.current, w: 0, h: 0 });
      }}
      onPointerMove={(e) => {
        if (start.current) setDraft(rect(start.current, point(e)));
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        const r = rect(start.current, point(e));
        start.current = null;
        setDraft(undefined);
        // ignore stray clicks; a redraw replaces the previous box
        if (r.w > 0.02 && r.h > 0.02) onBox(r);
      }}
      onPointerCancel={() => {
        start.current = null;
        setDraft(undefined);
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} draggable={false} className="block max-h-80 max-w-full" />
      {shown && (
        <div
          data-testid="box-rect"
          className="pointer-events-none absolute rounded-[2px] border-2 border-accent bg-accent/10"
          style={{
            left: `${shown.x * 100}%`,
            top: `${shown.y * 100}%`,
            width: `${shown.w * 100}%`,
            height: `${shown.h * 100}%`,
            boxShadow: '0 0 0 9999px var(--dim)',
          }}
        />
      )}
    </div>
  );
}
