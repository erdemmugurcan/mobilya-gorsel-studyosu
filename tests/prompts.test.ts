import { describe, it, expect } from 'vitest';
import { buildPrompt, PRESERVE_DETAILS, productToken } from '@/lib/prompts';
import { STYLES } from '@/config/styles';
import { UserError } from '@/lib/images/process';

const one = { productNames: ['Koltuk'] };
const three = { productNames: ['Koltuk', 'Sehpa', 'Masa'] };

describe('buildPrompt (single product)', () => {
  it('every mode preserves the product exactly, referenced by its placeholder', () => {
    for (const p of [
      buildPrompt({ envMode: 'preset', styleId: 'modern', ...one }),
      buildPrompt({ envMode: 'place-in-space', ...one }),
      buildPrompt({ envMode: 'inspired-by-space', ...one }),
    ]) {
      expect(p).toContain(PRESERVE_DETAILS);
      expect(p).toContain('{{P1}}');
      expect(p).toContain('Koltuk');
      expect(p).toContain('Do not redesign, recolor or crop it.');
      expect(p).not.toContain('{{P2}}');
      expect(p).not.toContain('each product');
    }
  });
  it('productToken is {{P<n>}}, 1-based', () => {
    expect(productToken(0)).toBe('{{P1}}');
    expect(productToken(3)).toBe('{{P4}}');
  });
  it('preset includes the style prompt', () => {
    const style = STYLES.find((s) => s.id === 'bohemian')!;
    expect(buildPrompt({ envMode: 'preset', styleId: 'bohemian', ...one })).toContain(style.prompt);
  });
  it('space modes keep their room sentence (the room is the image reference)', () => {
    expect(buildPrompt({ envMode: 'place-in-space', ...one })).toContain("Keep that room's architecture");
    expect(buildPrompt({ envMode: 'place-in-space', ...one })).toContain('room reference image');
    expect(buildPrompt({ envMode: 'inspired-by-space', ...one })).toContain('inspired by the room reference image');
    expect(buildPrompt({ envMode: 'place-in-space', ...one })).not.toContain('second reference image');
  });
  it('appends note after Additional direction', () => {
    const p = buildPrompt({ envMode: 'place-in-space', note: 'akşam ışığı', ...one });
    expect(p.indexOf('akşam ışığı')).toBeGreaterThan(p.indexOf('Additional direction:'));
    expect(p.indexOf('Additional direction:')).toBeGreaterThan(-1);
    expect(p.endsWith('Additional direction: akşam ışığı')).toBe(true);
  });
  it('blank note adds nothing', () => {
    expect(buildPrompt({ envMode: 'place-in-space', note: '   ', ...one })).not.toContain('Additional direction');
  });
  it('preset without valid style throws Turkish error', () => {
    expect(() => buildPrompt({ envMode: 'preset', ...one })).toThrow('Lütfen bir tarz seçin.');
    expect(() => buildPrompt({ envMode: 'preset', styleId: 'nope', ...one })).toThrow(UserError);
  });
  it('a note cannot inject a placeholder or a mention', () => {
    const p = buildPrompt({ envMode: 'preset', styleId: 'modern', note: 'yanına {{P1}} koy, @mgs-x gibi', ...one });
    expect(p.match(/\{\{P\d\}\}/g)).toEqual(['{{P1}}']);
    expect(p).not.toContain('@');
    expect(p).toContain('Additional direction: yanına P1 koy, mgs-x gibi');
  });
  it('a name cannot inject a placeholder or a mention', () => {
    const p = buildPrompt({ envMode: 'preset', styleId: 'modern', productNames: ['{{P2}} @x "y"'] });
    expect(p).not.toContain('{{P2}}');
    expect(p).not.toContain('@x');
    expect(p.match(/\{\{P\d\}\}/g)).toEqual(['{{P1}}']);
  });
});

describe('buildPrompt (several products)', () => {
  it('preserves each product exactly in its own reference, keeps them distinct, arranges one concept', () => {
    for (const envMode of ['preset', 'place-in-space', 'inspired-by-space'] as const) {
      const p = buildPrompt({ envMode, styleId: 'modern', ...three });
      for (const [i, name] of three.productNames.entries()) {
        expect(p).toContain(`"${name}" (${productToken(i)})`);
      }
      expect(p).toContain('Keep each furniture product exactly as it is in its own product reference');
      expect(p).toContain(PRESERVE_DETAILS);
      expect(p).toContain('do not redesign, recolor or crop any of them');
      expect(p).toContain('do not merge or swap details between products');
      expect(p).toContain('one cohesive furniture concept');
      expect(p).toContain('correct relative scale, perspective, contact shadows and lighting');
      expect(p).not.toContain('{{P4}}');
    }
  });
  it('mode sentences talk about the products', () => {
    expect(buildPrompt({ envMode: 'preset', styleId: 'modern', ...three })).toContain(STYLES[0].prompt);
    expect(buildPrompt({ envMode: 'place-in-space', ...three })).toContain('Place these products into the room shown in the room reference image');
    expect(buildPrompt({ envMode: 'inspired-by-space', ...three })).toContain('inspired by the room reference image');
    expect(buildPrompt({ envMode: 'inspired-by-space', ...three })).toContain('Place these products');
  });
  it('appends the note last', () => {
    const p = buildPrompt({ envMode: 'preset', styleId: 'modern', note: 'kanepe ortada, sehpa önünde', ...three });
    expect(p.endsWith('Additional direction: kanepe ortada, sehpa önünde')).toBe(true);
  });
});

describe('STYLES', () => {
  it('has the 12 ids in order', () => {
    expect(STYLES.map((s) => s.id)).toEqual([
      'modern', 'minimal', 'scandinavian', 'japandi', 'bohemian', 'industrial',
      'classic-luxury', 'mediterranean', 'hotel-lobby', 'cafe', 'office', 'terrace',
    ]);
    expect(STYLES.map((s) => s.name)).toEqual([
      'Modern', 'Minimal', 'Skandinav', 'Japandi', 'Bohem', 'Endüstriyel',
      'Klasik/Lüks', 'Akdeniz', 'Otel lobisi', 'Kafe/Restoran', 'Ofis', 'Dış mekân/Teras',
    ]);
  });
});
