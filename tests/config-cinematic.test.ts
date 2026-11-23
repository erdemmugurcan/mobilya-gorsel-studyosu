import { describe, expect, it } from 'vitest';
import {
  AUTO,
  CINEMATIC_CONTROLS,
  CREDITS_PER_IMAGE,
  cleanCinematic,
  countSetControls,
  estimateCredits,
  isCinematicSettings,
} from '@/config/cinematic';

// Complete catalog from Magnific `images_models_settings` for `cinematic` (task 12 brief, verbatim).
const CATALOG: Record<string, string[]> = {
  camera: ['arri-alexa-35', 'sony-venice', 'red-v-raptor', 'imax-70mm', 'pixelvision', 'vhs-camcorder', '8mm-film', '35mm-film', 'medium-format', 'Auto', 'arri-alexa-mini-lf', 'sony-venice-2', 'blackmagic-ursa-mini-pro', 'canon-c500-mark-ii', 'sony-fx9'],
  lensBrand: ['panavision-g', 'zeiss-master', 'cooke-s4', 'cooke-panchro', 'arri-signature', 'canon-k35', 'leica-summilux', 'zeiss-distagon', 'contax-g', 'hasselblad-planar', 'pentax-67', 'mamiya-sekor', 'Auto', 'cooke-s4-35mm', 'zeiss-master-prime-50mm', 'leica-summilux-c-75mm', 'cooke-anamorphic-i-40mm', 'hawk-v-lite-65mm-anamorphic', 'angenieux-optimo-25-250mm'],
  focalLength: ['14mm', '24mm', '35mm', '50mm', '85mm', '135mm', '200mm', 'Auto'],
  aperture: ['f/1.2', 'f/1.4', 'f/2', 'f/2.8', 'f/4', 'f/5.6', 'f/8', 'f/11', 'f/16', 'Auto'],
  shotType: ['extreme-close-front', 'extreme-close-45', 'extreme-close-profile', 'close-up-front', 'close-up-45', 'close-up-profile', 'medium-front', 'medium-45', 'medium-profile', 'three-quarter-front', 'three-quarter-45-right', 'three-quarter-profile', 'long-front', 'long-profile', 'wide-front', 'wide-45-right', 'over-shoulder', 'back', 'pov', 'high-angle', 'low-angle', 'dutch-angle', 'birds-eye', 'worms-eye'],
  filmStock: ['cinestill-800t', 'kodak-portra-400', 'kodak-portra-800', 'kodak-gold-200', 'kodak-ektar-100', 'kodak-tri-x-400', 'kodak-tmax-400', 'kodak-vision3-500t', 'kodak-vision3-250d', 'fuji-pro-400h', 'fuji-superia-400', 'fuji-velvia-50', 'fuji-provia-100f', 'ilford-delta-3200', 'lomography-800', 'agfa-vista-400', 'ektachrome-e100', 'polaroid-600'],
  movieLook: ['blade-runner', 'dune', 'interstellar', 'matrix', 'her', 'ex-machina', 'tron-legacy', 'arrival', 'amelie', 'grand-budapest', 'eternal-sunshine', 'call-me-by-your-name', 'mad-max-fury-road', 'sicario', 'se7en', 'collateral', '1917', 'schindlers-list', 'the-revenant', 'gladiator', 'midsommar', 'lady-bird', 'parasite', 'pride-and-prejudice', 'the-favourite', 'phantom-thread', 'documentary-natural', 'tarantino-style', 'kubrick-style', 'spielberg-style'],
  lighting: ['golden-hour', 'rembrandt', 'butterfly', 'loop', 'split', 'broad', 'short', 'high-key', 'low-key', 'rim', 'backlight', 'three-point', 'natural-window', 'overcast', 'hard-sunlight', 'blue-hour', 'neon', 'chiaroscuro', 'candle', 'moonlight', 'stage', 'volumetric', 'dappled', 'studio-soft', 'beauty-dish', 'parabolic', 'practical', 'silhouette', 'contre-jour', 'bounce', 'overhead'],
  motionBlur: ['none', 'subtle-cinematic', 'moderate-cinematic', 'heavy-cinematic', 'subject-motion-blur-only', 'camera-motion-blur-only', 'rack-focus-pull-blur', 'zoom-blur', 'long-exposure-light-trails'],
  grain: ['35mm-silver-halide', '16mm-coarse', 'fine-organic-sensor-noise', 'barely-visible-shadow-grain'],
  halation: ['none', 'warm-orange-red-halo', 'strong-warm-bloom', 'green-yellow-fringe'],
  tonalLook: ['kodak-vision3-500t', 'fujifilm-eterna-500', 'kodak-portra-400', 'kodak-double-x', 'arri-alexa-natural', 'sony-venice-natural'],
};

const LABELS: Record<string, string> = {
  camera: 'Kamera',
  lensBrand: 'Lens',
  focalLength: 'Odak uzaklığı',
  aperture: 'Diyafram',
  shotType: 'Çekim açısı',
  filmStock: 'Film tipi',
  movieLook: 'Film görünümü',
  lighting: 'Işık',
  motionBlur: 'Hareket bulanıklığı',
  grain: 'Gren',
  halation: 'Halation (ışık hâlesi)',
  tonalLook: 'Ton görünümü',
};

const control = (key: string) => CINEMATIC_CONTROLS.find((c) => c.key === key)!;

describe('config/cinematic catalog', () => {
  it('has exactly the twelve controls, in order, with Turkish labels', () => {
    expect(CINEMATIC_CONTROLS.map((c) => c.key)).toEqual(Object.keys(CATALOG));
    expect(Object.fromEntries(CINEMATIC_CONTROLS.map((c) => [c.key, c.label]))).toEqual(LABELS);
  });

  it.each(Object.keys(CATALOG))('%s: "Otomatik" first, then every catalog value in order (no second Auto)', (key) => {
    const { options } = control(key);
    expect(options[0]).toEqual({ value: AUTO, label: 'Otomatik' });
    expect(options.slice(1).map((o) => o.value)).toEqual(CATALOG[key].filter((v) => v !== 'Auto'));
    expect(options.filter((o) => o.value === AUTO || o.label === 'Otomatik')).toHaveLength(1);
    expect(new Set(options.map((o) => o.value)).size).toBe(options.length);
    for (const o of options) expect(o.label.trim().length).toBeGreaterThan(0);
  });

  it('labels proper names readably and descriptive values in Turkish', () => {
    const label = (key: string, value: string) => control(key).options.find((o) => o.value === value)?.label;
    expect(label('camera', 'arri-alexa-35')).toBe('ARRI Alexa 35');
    expect(label('filmStock', 'kodak-portra-400')).toBe('Kodak Portra 400');
    expect(label('movieLook', 'dune')).toBe('Dune');
    expect(label('lighting', 'golden-hour')).toMatch(/Altın saat/);
    expect(label('shotType', 'birds-eye')).toMatch(/Kuş bakışı/);
    expect(label('motionBlur', 'none')).toBe('Yok');
    expect(label('halation', 'none')).toBe('Yok');
  });
});

describe('credits', () => {
  it('prices per image: 2K 75, 4K 150', () => {
    expect(CREDITS_PER_IMAGE).toEqual({ '2k': 75, '4k': 150 });
  });

  it('estimate = count × price', () => {
    expect(estimateCredits(1, '2k')).toBe(75);
    expect(estimateCredits(2, '2k')).toBe(150);
    expect(estimateCredits(3, '4k')).toBe(450);
    expect(estimateCredits(4, '4k')).toBe(600);
  });
});

describe('settings helpers', () => {
  it('validates every control key and value', () => {
    expect(isCinematicSettings(undefined)).toBe(true);
    expect(isCinematicSettings(null)).toBe(true);
    expect(isCinematicSettings({})).toBe(true);
    expect(
      isCinematicSettings({
        camera: 'sony-fx9',
        lensBrand: 'cooke-s4',
        focalLength: '14mm',
        aperture: 'f/2.8',
        shotType: 'worms-eye',
        filmStock: 'polaroid-600',
        movieLook: '1917',
        lighting: 'neon',
        motionBlur: 'zoom-blur',
        grain: '16mm-coarse',
        halation: 'strong-warm-bloom',
        tonalLook: 'kodak-double-x',
      }),
    ).toBe(true);
    expect(isCinematicSettings({ lighting: AUTO, camera: AUTO })).toBe(true);
    expect(isCinematicSettings({ lighting: 'disco' })).toBe(false);
    expect(isCinematicSettings({ grain: 'kodak-portra-400' })).toBe(false);
    expect(isCinematicSettings({ iso: '800' })).toBe(false);
    expect(isCinematicSettings({ constructor: 'x' })).toBe(false);
    expect(isCinematicSettings({ focalLength: 35 })).toBe(false);
    expect(isCinematicSettings('x')).toBe(false);
    expect(isCinematicSettings([])).toBe(false);
  });

  it('cleanCinematic keeps only set, non-Otomatik controls', () => {
    expect(cleanCinematic({ lighting: 'neon', camera: AUTO, grain: undefined })).toEqual({ lighting: 'neon' });
    expect(cleanCinematic({ camera: AUTO })).toBeUndefined();
    expect(cleanCinematic(undefined)).toBeUndefined();
  });

  it('countSetControls ignores Otomatik and unset', () => {
    expect(countSetControls({})).toBe(0);
    expect(countSetControls({ lighting: 'neon', camera: AUTO, grain: '16mm-coarse' })).toBe(2);
  });
});
