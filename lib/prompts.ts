import { STYLES } from '@/config/styles';
import { UserError } from '@/lib/images/process';
import type { GenerationRequest } from '@/lib/types';

/**
 * Placeholder for the i-th product (0-based) in a built prompt. The provider replaces it with
 * the product's Magnific library mention (`@<asset name>`), which only exists at generation time.
 */
export const productToken = (i: number): string => `{{P${i + 1}}}`;

/** What "exactly as it is" means for a furniture product. */
export const PRESERVE_DETAILS = 'same shape, proportions, legs, arms, color, material, texture and details';

// A name is user text: it must not add another placeholder, a mention or break the quotes.
const cleanName = (name: string): string => name.replace(/[{}@"\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

const productRef = (name: string, i: number): string => `"${cleanName(name)}" (${productToken(i)})`;

export function buildPrompt(
  req: Pick<GenerationRequest, 'envMode' | 'styleId' | 'note'> & { productNames: string[] },
): string {
  const names = req.productNames;
  const multi = names.length > 1;
  let preserve: string;
  if (multi) {
    const list = names.map(productRef).join(', ');
    preserve =
      `Keep each furniture product exactly as it is in its own product reference: ${list}. ` +
      `For each one keep the ${PRESERVE_DETAILS}; do not redesign, recolor or crop any of them. ` +
      'Keep the products visually distinct: do not merge or swap details between products. ' +
      'Arrange them together as one cohesive furniture concept with correct relative scale, perspective, contact shadows and lighting.';
  } else {
    preserve = `Keep the furniture product ${productRef(names[0] ?? '', 0)} exactly as it is in its product reference: ${PRESERVE_DETAILS}. Do not redesign, recolor or crop it.`;
  }

  const it = multi ? 'these products' : 'this product';
  let scene: string;
  switch (req.envMode) {
    case 'preset': {
      const style = STYLES.find((s) => s.id === req.styleId);
      if (!style) throw new UserError('Lütfen bir tarz seçin.');
      scene = `Place ${it} naturally in a ${style.prompt}. Correct scale, perspective, contact shadows and lighting that match the room. Professional interior photography for social media.`;
      break;
    }
    case 'place-in-space':
      scene = multi
        ? "Place these products into the room shown in the room reference image. Keep that room's architecture, walls, floor, windows, furniture and lighting as they are; only add the products in fitting spots with correct scale, perspective, contact shadows and lighting."
        : "Place this product into the room shown in the room reference image. Keep that room's architecture, walls, floor, windows, furniture and lighting as they are; only add the product in a fitting spot with correct scale, perspective, contact shadows and lighting.";
      break;
    case 'inspired-by-space':
      scene = `Create a new room inspired by the room reference image: same atmosphere, lighting, color palette and materials, but a different composition. Place ${it} naturally in it with correct scale, perspective and shadows.`;
      break;
  }
  const parts = [preserve, scene];
  // Like names: a note must not add a placeholder or a library mention.
  const note = req.note?.replace(/[{}@]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (note) parts.push(`Additional direction: ${note}`);
  return parts.join(' ');
}
