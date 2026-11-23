import type { CinematicSettings, ModelId, Resolution } from '@/lib/types';

/** The only model: Magnific Cinematic over MCP. */
export const MODEL_ID: ModelId = 'cinematic';

export interface CinematicOption {
  value: string;
  label: string;
}

export type CinematicKey = keyof CinematicSettings;

export interface CinematicControl {
  key: CinematicKey;
  label: string;
  options: CinematicOption[];
}

/** "Let the model decide": never sent to Magnific. */
export const AUTO = 'Auto';
const AUTO_OPTION: CinematicOption = { value: AUTO, label: 'Otomatik' };

const opts = (list: [value: string, label: string][]): CinematicOption[] => [
  AUTO_OPTION,
  ...list.map(([value, label]) => ({ value, label })),
];

// Complete catalog from Magnific `images_models_settings` for `cinematic` (2026-11-18), in
// catalog order. The catalog's own "Auto" (camera, lens, focal length, aperture) is the
// "Otomatik" option above. Proper names keep their name; descriptive values are Turkish.
export const CINEMATIC_CONTROLS: CinematicControl[] = [
  {
    key: 'camera',
    label: 'Kamera',
    options: opts([
      ['arri-alexa-35', 'ARRI Alexa 35'],
      ['sony-venice', 'Sony Venice'],
      ['red-v-raptor', 'RED V-Raptor'],
      ['imax-70mm', 'IMAX 70 mm'],
      ['pixelvision', 'PixelVision'],
      ['vhs-camcorder', 'VHS kamera'],
      ['8mm-film', '8 mm film'],
      ['35mm-film', '35 mm film'],
      ['medium-format', 'Orta format'],
      ['arri-alexa-mini-lf', 'ARRI Alexa Mini LF'],
      ['sony-venice-2', 'Sony Venice 2'],
      ['blackmagic-ursa-mini-pro', 'Blackmagic URSA Mini Pro'],
      ['canon-c500-mark-ii', 'Canon C500 Mark II'],
      ['sony-fx9', 'Sony FX9'],
    ]),
  },
  {
    key: 'lensBrand',
    label: 'Lens',
    options: opts([
      ['panavision-g', 'Panavision G'],
      ['zeiss-master', 'Zeiss Master'],
      ['cooke-s4', 'Cooke S4'],
      ['cooke-panchro', 'Cooke Panchro'],
      ['arri-signature', 'ARRI Signature'],
      ['canon-k35', 'Canon K35'],
      ['leica-summilux', 'Leica Summilux'],
      ['zeiss-distagon', 'Zeiss Distagon'],
      ['contax-g', 'Contax G'],
      ['hasselblad-planar', 'Hasselblad Planar'],
      ['pentax-67', 'Pentax 67'],
      ['mamiya-sekor', 'Mamiya Sekor'],
      ['cooke-s4-35mm', 'Cooke S4 35 mm'],
      ['zeiss-master-prime-50mm', 'Zeiss Master Prime 50 mm'],
      ['leica-summilux-c-75mm', 'Leica Summilux-C 75 mm'],
      ['cooke-anamorphic-i-40mm', 'Cooke Anamorphic/i 40 mm'],
      ['hawk-v-lite-65mm-anamorphic', 'Hawk V-Lite 65 mm anamorfik'],
      ['angenieux-optimo-25-250mm', 'Angénieux Optimo 25–250 mm'],
    ]),
  },
  {
    key: 'focalLength',
    label: 'Odak uzaklığı',
    options: opts([
      ['14mm', '14 mm (ultra geniş)'],
      ['24mm', '24 mm (çok geniş)'],
      ['35mm', '35 mm (geniş)'],
      ['50mm', '50 mm (doğal)'],
      ['85mm', '85 mm (yakın, detay)'],
      ['135mm', '135 mm (tele)'],
      ['200mm', '200 mm (uzun tele)'],
    ]),
  },
  {
    key: 'aperture',
    label: 'Diyafram',
    options: opts([
      ['f/1.2', 'f/1.2 (arka plan çok bulanık)'],
      ['f/1.4', 'f/1.4'],
      ['f/2', 'f/2'],
      ['f/2.8', 'f/2.8'],
      ['f/4', 'f/4'],
      ['f/5.6', 'f/5.6'],
      ['f/8', 'f/8'],
      ['f/11', 'f/11'],
      ['f/16', 'f/16 (her yer net)'],
    ]),
  },
  {
    key: 'shotType',
    label: 'Çekim açısı',
    options: opts([
      ['extreme-close-front', 'Çok yakın, karşıdan'],
      ['extreme-close-45', 'Çok yakın, 45°'],
      ['extreme-close-profile', 'Çok yakın, yandan'],
      ['close-up-front', 'Yakın plan, karşıdan'],
      ['close-up-45', 'Yakın plan, 45°'],
      ['close-up-profile', 'Yakın plan, yandan'],
      ['medium-front', 'Orta plan, karşıdan'],
      ['medium-45', 'Orta plan, 45°'],
      ['medium-profile', 'Orta plan, yandan'],
      ['three-quarter-front', 'Dörtte üç, karşıdan'],
      ['three-quarter-45-right', 'Dörtte üç, 45° sağdan'],
      ['three-quarter-profile', 'Dörtte üç, yandan'],
      ['long-front', 'Uzak plan, karşıdan'],
      ['long-profile', 'Uzak plan, yandan'],
      ['wide-front', 'Geniş, karşıdan'],
      ['wide-45-right', 'Geniş, 45° sağdan'],
      ['over-shoulder', 'Omuz üstünden'],
      ['back', 'Arkadan'],
      ['pov', 'Öznel bakış (POV)'],
      ['high-angle', 'Yukarıdan'],
      ['low-angle', 'Aşağıdan'],
      ['dutch-angle', 'Eğik açı'],
      ['birds-eye', 'Kuş bakışı'],
      ['worms-eye', 'Yerden yukarı (solucan bakışı)'],
    ]),
  },
  {
    key: 'filmStock',
    label: 'Film tipi',
    options: opts([
      ['cinestill-800t', 'CineStill 800T'],
      ['kodak-portra-400', 'Kodak Portra 400'],
      ['kodak-portra-800', 'Kodak Portra 800'],
      ['kodak-gold-200', 'Kodak Gold 200'],
      ['kodak-ektar-100', 'Kodak Ektar 100'],
      ['kodak-tri-x-400', 'Kodak Tri-X 400'],
      ['kodak-tmax-400', 'Kodak T-Max 400'],
      ['kodak-vision3-500t', 'Kodak Vision3 500T'],
      ['kodak-vision3-250d', 'Kodak Vision3 250D'],
      ['fuji-pro-400h', 'Fuji Pro 400H'],
      ['fuji-superia-400', 'Fuji Superia 400'],
      ['fuji-velvia-50', 'Fuji Velvia 50'],
      ['fuji-provia-100f', 'Fuji Provia 100F'],
      ['ilford-delta-3200', 'Ilford Delta 3200'],
      ['lomography-800', 'Lomography 800'],
      ['agfa-vista-400', 'Agfa Vista 400'],
      ['ektachrome-e100', 'Ektachrome E100'],
      ['polaroid-600', 'Polaroid 600'],
    ]),
  },
  {
    key: 'movieLook',
    label: 'Film görünümü',
    options: opts([
      ['blade-runner', 'Blade Runner'],
      ['dune', 'Dune'],
      ['interstellar', 'Interstellar'],
      ['matrix', 'Matrix'],
      ['her', 'Her'],
      ['ex-machina', 'Ex Machina'],
      ['tron-legacy', 'Tron: Legacy'],
      ['arrival', 'Arrival'],
      ['amelie', 'Amélie'],
      ['grand-budapest', 'The Grand Budapest Hotel'],
      ['eternal-sunshine', 'Eternal Sunshine of the Spotless Mind'],
      ['call-me-by-your-name', 'Call Me by Your Name'],
      ['mad-max-fury-road', 'Mad Max: Fury Road'],
      ['sicario', 'Sicario'],
      ['se7en', 'Se7en'],
      ['collateral', 'Collateral'],
      ['1917', '1917'],
      ['schindlers-list', "Schindler's List"],
      ['the-revenant', 'The Revenant'],
      ['gladiator', 'Gladiator'],
      ['midsommar', 'Midsommar'],
      ['lady-bird', 'Lady Bird'],
      ['parasite', 'Parasite'],
      ['pride-and-prejudice', 'Pride & Prejudice'],
      ['the-favourite', 'The Favourite'],
      ['phantom-thread', 'Phantom Thread'],
      ['documentary-natural', 'Doğal belgesel'],
      ['tarantino-style', 'Tarantino tarzı'],
      ['kubrick-style', 'Kubrick tarzı'],
      ['spielberg-style', 'Spielberg tarzı'],
    ]),
  },
  {
    key: 'lighting',
    label: 'Işık',
    options: opts([
      ['golden-hour', 'Altın saat (gün batımı)'],
      ['rembrandt', 'Rembrandt ışığı'],
      ['butterfly', 'Kelebek ışığı'],
      ['loop', 'Loop ışığı'],
      ['split', 'Yarım yüz ışığı (split)'],
      ['broad', 'Geniş taraf ışığı (broad)'],
      ['short', 'Dar taraf ışığı (short)'],
      ['high-key', 'Aydınlık, gölgesiz (high-key)'],
      ['low-key', 'Karanlık, kontrastlı (low-key)'],
      ['rim', 'Kenar ışığı'],
      ['backlight', 'Arkadan ışık'],
      ['three-point', 'Üç noktalı ışık'],
      ['natural-window', 'Pencereden doğal ışık'],
      ['overcast', 'Bulutlu gün (yumuşak)'],
      ['hard-sunlight', 'Sert güneş ışığı'],
      ['blue-hour', 'Mavi saat (akşamüstü)'],
      ['neon', 'Neon'],
      ['chiaroscuro', 'Işık-gölge (chiaroscuro)'],
      ['candle', 'Mum ışığı'],
      ['moonlight', 'Ay ışığı'],
      ['stage', 'Sahne ışığı'],
      ['volumetric', 'Işık huzmeleri (volumetrik)'],
      ['dappled', 'Benekli ışık (yaprak arası)'],
      ['studio-soft', 'Yumuşak stüdyo ışığı'],
      ['beauty-dish', 'Güzellik çanağı (beauty dish)'],
      ['parabolic', 'Parabolik reflektör'],
      ['practical', 'Sahnedeki lambalar'],
      ['silhouette', 'Siluet'],
      ['contre-jour', 'Işığa karşı (kontrjur)'],
      ['bounce', 'Yansıtılmış ışık'],
      ['overhead', 'Tepeden ışık'],
    ]),
  },
  {
    key: 'motionBlur',
    label: 'Hareket bulanıklığı',
    options: opts([
      ['none', 'Yok'],
      ['subtle-cinematic', 'Hafif sinematik'],
      ['moderate-cinematic', 'Orta sinematik'],
      ['heavy-cinematic', 'Yoğun sinematik'],
      ['subject-motion-blur-only', 'Yalnızca konu hareketi'],
      ['camera-motion-blur-only', 'Yalnızca kamera hareketi'],
      ['rack-focus-pull-blur', 'Odak kaydırma bulanıklığı'],
      ['zoom-blur', 'Zoom bulanıklığı'],
      ['long-exposure-light-trails', 'Uzun pozlama, ışık izleri'],
    ]),
  },
  {
    key: 'grain',
    label: 'Gren',
    options: opts([
      ['35mm-silver-halide', '35 mm film greni'],
      ['16mm-coarse', '16 mm kaba gren'],
      ['fine-organic-sensor-noise', 'İnce, doğal sensör gürültüsü'],
      ['barely-visible-shadow-grain', 'Gölgelerde çok hafif gren'],
    ]),
  },
  {
    key: 'halation',
    label: 'Halation (ışık hâlesi)',
    options: opts([
      ['none', 'Yok'],
      ['warm-orange-red-halo', 'Sıcak turuncu-kırmızı hâle'],
      ['strong-warm-bloom', 'Güçlü sıcak parlama'],
      ['green-yellow-fringe', 'Yeşil-sarı kenar'],
    ]),
  },
  {
    key: 'tonalLook',
    label: 'Ton görünümü',
    options: opts([
      ['kodak-vision3-500t', 'Kodak Vision3 500T'],
      ['fujifilm-eterna-500', 'Fujifilm Eterna 500'],
      ['kodak-portra-400', 'Kodak Portra 400'],
      ['kodak-double-x', 'Kodak Double-X'],
      ['arri-alexa-natural', 'ARRI Alexa (doğal)'],
      ['sony-venice-natural', 'Sony Venice (doğal)'],
    ]),
  },
];

const BY_KEY: Record<string, CinematicControl> = Object.fromEntries(CINEMATIC_CONTROLS.map((c) => [c.key, c]));

/** Accepts undefined/null, or an object with only known keys whose values are in that control's list. */
export function isCinematicSettings(v: unknown): v is CinematicSettings | undefined {
  if (v == null) return true;
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v).every(
    ([k, val]) => Object.hasOwn(BY_KEY, k) && (val == null || BY_KEY[k].options.some((o) => o.value === val)),
  );
}

/** Set (non-Otomatik) controls only, in catalog order; undefined when none is set. */
export function cleanCinematic(v: CinematicSettings | undefined | null): CinematicSettings | undefined {
  if (!v) return undefined;
  const out: CinematicSettings = {};
  for (const { key } of CINEMATIC_CONTROLS) {
    const val = v[key];
    if (typeof val === 'string' && val && val !== AUTO) out[key] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

export const countSetControls = (v: CinematicSettings | undefined | null): number =>
  Object.keys(cleanCinematic(v) ?? {}).length;

// ---- resolution and price ----

export const RESOLUTIONS: Resolution[] = ['2k', '4k'];
export const DEFAULT_RESOLUTION: Resolution = '2k';
export const isResolution = (v: unknown): v is Resolution => v === '2k' || v === '4k';

/** Magnific `simulate_cost` for cinematic (2026-11-18); controls do not change the price. */
export const CREDITS_PER_IMAGE: Record<Resolution, number> = { '2k': 75, '4k': 150 };

export const estimateCredits = (count: number, resolution: Resolution): number =>
  count * CREDITS_PER_IMAGE[resolution];
