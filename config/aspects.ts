import type { AspectRatio } from '@/lib/types';

export interface AspectOption {
  value: AspectRatio;
  /** Turkish name shown in the picker. */
  label: string;
  /** Where the format is typically used. */
  hint: string;
}

/** Every ratio Magnific Cinematic supports (its `aspectRatio` uses the same strings), in picker order. */
export const ASPECTS: AspectOption[] = [
  { value: '1:1', label: 'Kare', hint: 'Instagram' },
  { value: '4:5', label: 'Instagram gönderisi', hint: 'Instagram, Facebook' },
  { value: '9:16', label: 'Story / Reels', hint: 'Instagram, TikTok' },
  { value: '3:4', label: 'Dikey', hint: 'Instagram, Facebook' },
  { value: '2:3', label: 'Pinterest', hint: 'Pinterest, baskı' },
  { value: '4:3', label: 'Yatay', hint: 'Facebook, web' },
  { value: '3:2', label: 'Fotoğraf', hint: 'Web, baskı' },
  { value: '5:4', label: 'Yatay kare', hint: 'Facebook, baskı' },
  { value: '16:9', label: 'Web / YouTube kapağı', hint: 'YouTube, web' },
  { value: '21:9', label: 'Geniş panorama', hint: 'Web bannerı' },
];

export const DEFAULT_ASPECT: AspectRatio = '4:5';

export const isAspectRatio = (v: unknown): v is AspectRatio => ASPECTS.some((a) => a.value === v);
