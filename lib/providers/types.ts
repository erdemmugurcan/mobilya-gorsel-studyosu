import type { AspectRatio, CinematicSettings, Resolution } from '@/lib/types';

/** One product of the scene as the provider sees it. */
export interface ProviderProduct {
  name: string;
  /** Raw base64 JPEGs (no data: prefix), 1–6 angles, the first is the cover. */
  images: string[];
}

export interface ImageProvider {
  generate(input: {
    /** May hold one `{{Pn}}` placeholder per product (see productToken); the provider fills them in. */
    prompt: string;
    /** 1–4 products, in prompt order. */
    products: ProviderProduct[];
    /** Raw base64 JPEG of the reference room, if any. */
    space?: string;
    aspect: AspectRatio;
    resolution: Resolution;
    seed: number;
    /** Cinematic controls; 'Auto' or unset ones are not sent. */
    cinematic?: CinematicSettings;
  }): Promise<string[]>;
  /**
   * Called once by the runner after every variation of the generation settled (success or
   * failure): cleans up what generate() created. Never rejects with something for the user.
   */
  finish?(): Promise<void>;
}
