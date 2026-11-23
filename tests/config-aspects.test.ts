import { describe, expect, it } from 'vitest';
import { ASPECTS, DEFAULT_ASPECT, isAspectRatio } from '@/config/aspects';

describe('ASPECTS', () => {
  it('lists all ten Cinematic ratios in order with their Turkish labels', () => {
    expect(ASPECTS.map((a) => [a.value, a.label])).toEqual([
      ['1:1', 'Kare'],
      ['4:5', 'Instagram gönderisi'],
      ['9:16', 'Story / Reels'],
      ['3:4', 'Dikey'],
      ['2:3', 'Pinterest'],
      ['4:3', 'Yatay'],
      ['3:2', 'Fotoğraf'],
      ['5:4', 'Yatay kare'],
      ['16:9', 'Web / YouTube kapağı'],
      ['21:9', 'Geniş panorama'],
    ]);
    expect(ASPECTS[0].hint).toBe('Instagram');
    for (const a of ASPECTS) expect(a.hint.length).toBeGreaterThan(0);
  });

  it('defaults to 4:5', () => {
    expect(DEFAULT_ASPECT).toBe('4:5');
  });

  it('isAspectRatio accepts exactly the listed values', () => {
    for (const a of ASPECTS) expect(isAspectRatio(a.value)).toBe(true);
    for (const v of ['16:10', '1:2', '', null, undefined, 1, '4/5']) expect(isAspectRatio(v)).toBe(false);
  });
});
