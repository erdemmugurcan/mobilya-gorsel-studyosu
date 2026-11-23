import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Gallery from '@/components/Gallery';
import OutputSettings, { DEFAULT_OUTPUT } from '@/components/OutputSettings';
import ResultsView, { describeRecord } from '@/components/ResultsView';
import { ASPECTS } from '@/config/aspects';
import type { GenerationRecord } from '@/lib/types';

const record: GenerationRecord = {
  id: 'r1',
  createdAt: '2026-11-18T10:00:00.000Z',
  updatedAt: '2026-11-18T10:01:00.000Z',
  prompt: 'p',
  status: 'done',
  outputs: [{ index: 0, status: 'done', file: 'outputs/r1-0.jpg' }],
  products: [
    { name: 'Koltuk', cutoutIds: ['a', 'b'] },
    { name: 'Sehpa', cutoutIds: ['c'] },
  ],
  envMode: 'preset',
  styleId: 'modern-minimal',
  aspect: '21:9',
  count: 1,
  model: 'cinematic',
  resolution: '2k',
};

describe('OutputSettings aspect tiles', () => {
  const html = renderToStaticMarkup(<OutputSettings value={DEFAULT_OUTPUT} onChange={() => {}} />);
  const radios = [...html.matchAll(/<button[^>]*data-aspect="([^"]+)"[^>]*>/g)];

  it('offers all 10 ratios as one radiogroup, default 4:5', () => {
    expect(DEFAULT_OUTPUT.aspect).toBe('4:5');
    expect(html).toMatch(/role="radiogroup"[^>]*aria-labelledby="output-aspect"|aria-labelledby="output-aspect"[^>]*role="radiogroup"/);
    expect(radios.map((m) => m[1])).toEqual(ASPECTS.map((a) => a.value));
    for (const a of ASPECTS) expect(html).toContain(`aria-label="${a.value} ${a.label}"`);
  });

  it('has a single tab stop, on the checked tile (roving tabindex)', () => {
    const checked = radios.filter((m) => m[0].includes('aria-checked="true"'));
    expect(checked).toHaveLength(1);
    expect(checked[0][1]).toBe('4:5');
    expect(checked[0][0]).toContain('tabindex="0"');
    expect(radios.filter((m) => m[0].includes('tabindex="0"'))).toHaveLength(1);
  });
});

describe('product names in results and gallery', () => {
  it('leads the summary with the names joined by " + "', () => {
    expect(describeRecord(record)).toMatch(/^Koltuk \+ Sehpa · Hazır tarz: .+ · 21:9 · 2K · 1 görsel$/);
    const html = renderToStaticMarkup(<ResultsView record={record} onRerun={() => {}} />);
    expect(html).toContain('Koltuk + Sehpa');
  });

  it('shows a rerun notice in the notice style', () => {
    const html = renderToStaticMarkup(<ResultsView record={record} onRerun={() => {}} notice="Bu üretimin 1 ürün fotoğrafı artık yok" />);
    expect(html).toMatch(/role="status"[^>]*>.*Bu üretimin 1 ürün fotoğrafı artık yok/);
  });

  it('titles gallery items with the names', () => {
    const html = renderToStaticMarkup(<Gallery records={[record]} onSelect={() => {}} />);
    expect(html).toMatch(/data-testid="gallery-title"[^>]*>Koltuk \+ Sehpa</);
  });
});
