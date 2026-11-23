// Static renders (no DOM in this suite): the markup each state produces. Interaction logic is
// covered in tests/client/products.test.ts, which the panel delegates to.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ProductsPanel from '@/components/ProductsPanel';
import type { DraftPhoto, DraftProduct } from '@/lib/client/products';
import type { CutoutInfo } from '@/lib/types';

const cutout = (id: string): CutoutInfo => ({ id, sourceUploadId: `u-${id}`, file: `cutouts/${id}.png`, width: 10, height: 10 });
const ready = (id: string): DraftPhoto => ({ key: id, status: 'ready', uploadId: `u-${id}`, cutout: cutout(id) });
const render = (value: DraftProduct[]) => renderToStaticMarkup(<ProductsPanel value={value} onChange={() => {}} />);
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('ProductsPanel', () => {
  it('starts with one product, the hint and a multi-file dropzone', () => {
    const html = render([{ key: 'p1', name: 'Ürün 1', photos: [] }]);
    expect(html).toContain('Ürünler');
    expect(html).toContain('Aynı ürünün farklı açılarını ekleyin (önden, yandan, yakın çekim). Sahneye en fazla 4 ürün.');
    expect(html).toContain('value="Ürün 1"');
    expect(html).toContain('Fotoğrafları buraya bırakın ya da seçin');
    expect(html).toMatch(/<input[^>]*multiple=""[^>]*type="file"|<input[^>]*type="file"[^>]*multiple=""/);
    // a single product cannot be removed
    expect(html).not.toContain('Ürünü kaldır');
    expect(html).toMatch(/<button[^>]*aria-disabled="false"[^>]*>.*Ürün ekle/);
  });

  it('shows photos in order with the first as cover, per-photo state and "Tekrar dene"', () => {
    const html = render([
      {
        key: 'p1',
        name: 'Koltuk',
        photos: [
          ready('a'),
          { key: 'b', status: 'cutting', uploadId: 'u-b', uploadFile: 'uploads/b.jpg' },
          { key: 'c', status: 'error', uploadId: 'u-c', error: 'Ürün kesilirken bir hata oluştu.' },
        ],
      },
    ]);
    expect(count(html, 'data-testid="photo-tile"')).toBe(3);
    expect(html).toContain('aria-label="1. fotoğraf, kapak: hazır"');
    expect(html).toContain('>Kapak<');
    expect(html).toContain('Ayıklanıyor…');
    expect(html).toContain('3. fotoğraf: Ürün kesilirken bir hata oluştu.');
    expect(html).toContain('Tekrar dene');
    expect(html).toMatch(/<img[^>]*width="10"[^>]*height="10"/);
    expect(html).toContain('3/6');
    expect(html).toContain('Fotoğraf ekle. JPG veya PNG, en fazla 3 fotoğraf daha');
  });

  it('hides the add tile at 6 photos', () => {
    const html = render([{ key: 'p1', name: 'Koltuk', photos: ['a', 'b', 'c', 'd', 'e', 'f'].map(ready) }]);
    expect(count(html, 'data-testid="photo-tile"')).toBe(6);
    expect(html).not.toContain('Fotoğraf ekle');
  });

  it('flags duplicate and over-long names inline, in Turkish', () => {
    const html = render([
      { key: 'p1', name: 'Sehpa', photos: [ready('a')] },
      { key: 'p2', name: 'SEHPA', photos: [ready('b')] },
      { key: 'p3', name: 'x'.repeat(41), photos: [ready('c')] },
    ]);
    expect(count(html, 'Bu ad zaten kullanılıyor.')).toBe(2);
    expect(html).toContain('Ad en fazla 40 karakter olabilir.');
    expect(count(html, 'aria-invalid="true"')).toBe(3);
    expect(count(html, 'Ürünü kaldır')).toBeGreaterThanOrEqual(3);
  });

  it('disables "Ürün ekle" at 4 products with the reason', () => {
    const html = render(['A', 'B', 'C', 'D'].map((n, i) => ({ key: `p${i}`, name: n, photos: [ready(`c${i}`)] })));
    expect(count(html, 'data-testid="product-card"')).toBe(4);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*aria-describedby="[^"]+"[^>]*>.*Ürün ekle/);
    expect(html).toContain('Sahneye en fazla 4 ürün eklenebilir.');
  });

  it('marks the step done only when every product is ready', () => {
    const done = render([{ key: 'p1', name: 'Koltuk', photos: [ready('a')] }, { key: 'p2', name: 'Sehpa', photos: [ready('b')] }]);
    expect(done).toContain('2 ürün hazır');
    const waiting = render([{ key: 'p1', name: 'Koltuk', photos: [ready('a')] }, { key: 'p2', name: 'Sehpa', photos: [] }]);
    expect(waiting).not.toContain('ürün hazır');
  });
});
