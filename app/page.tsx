'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import EnvironmentPanel, {
  DEFAULT_ENV,
  envToRequest,
  isEnvComplete,
  type EnvValue,
} from '@/components/EnvironmentPanel';
import Gallery from '@/components/Gallery';
import MagnificConnection from '@/components/MagnificConnection';
import OutputSettings, { DEFAULT_OUTPUT, type OutputValue } from '@/components/OutputSettings';
import ProductsPanel from '@/components/ProductsPanel';
import ResultsView from '@/components/ResultsView';
import { ErrorText, NoticeText } from '@/components/ui';
import {
  getCutout,
  getGeneration,
  getUpload,
  listGenerations,
  startGeneration,
} from '@/lib/client/api';
import {
  emptyProduct,
  missingNotice,
  productsState,
  restoreProducts,
  toRequestProducts,
  type DraftProduct,
} from '@/lib/client/products';
import { cleanCinematic, estimateCredits, isResolution, MODEL_ID } from '@/config/cinematic';
import type { GenerationRecord, GenerationRequest } from '@/lib/types';

const POLL_MS = 2000;
const GALLERY_POLL_MS = 5000;
const RESTORE_FAILED = 'Ürün fotoğrafları geri yüklenemedi; formdaki ürünler korunuyor.';
const rerunMissing = (n: number) =>
  `Bu üretimin ${n} ürün fotoğrafı artık yok, bu yüzden tekrar üretilmedi. Galeriden açıp eksik fotoğrafları yeniden yükleyin.`;
const SPACE_MISSING = 'Bu üretimin mekân fotoğrafı bulunamadı.';

const requestOf = (r: GenerationRecord): GenerationRequest => ({
  products: r.products,
  envMode: r.envMode,
  styleId: r.styleId,
  spaceUploadId: r.spaceUploadId,
  note: r.note,
  aspect: r.aspect,
  count: r.count,
  model: MODEL_ID,
  resolution: r.resolution,
  cinematic: r.cinematic,
});

export default function Home() {
  const [products, setProducts] = useState<DraftProduct[]>(() => [emptyProduct()]);
  const [env, setEnv] = useState<EnvValue>(DEFAULT_ENV);
  const [output, setOutput] = useState<OutputValue>(DEFAULT_OUTPUT);
  const [productNotice, setProductNotice] = useState<string>();
  const [spaceNotice, setSpaceNotice] = useState<string>();

  const [current, setCurrent] = useState<GenerationRecord | null>(null);
  const [records, setRecords] = useState<GenerationRecord[]>([]);
  const [galleryError, setGalleryError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string>();
  const [rerunning, setRerunning] = useState(false);
  const [resultsError, setResultsError] = useState<string>();
  const [resultsNotice, setResultsNotice] = useState<string>();
  const [pollRetry, setPollRetry] = useState(0);
  const restoreToken = useRef(0);
  const railRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [magnificConnected, setMagnificConnected] = useState<boolean | null>(null);
  const [magnificCheck, setMagnificCheck] = useState(0);
  const recheckMagnific = useCallback(() => setMagnificCheck((n) => n + 1), []);

  const refreshGallery = useCallback(async () => {
    try {
      const list = await listGenerations();
      setRecords(list);
      setGalleryError(undefined);
    } catch (e) {
      setGalleryError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    listGenerations().then(
      (list) => !cancelled && setRecords(list),
      (e: Error) => !cancelled && setGalleryError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll the shown generation while it runs. Selecting another record (or unmounting)
  // cancels the pending poll, so a stale response can never overwrite the view.
  useEffect(() => {
    if (!current || current.status !== 'running') return;
    const id = current.id;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const rec = await getGeneration(id);
        if (cancelled) return;
        setResultsError(undefined);
        setCurrent(rec); // still running → new object → this effect schedules the next poll
        if (rec.status !== 'running') {
          void refreshGallery();
          recheckMagnific(); // a lost Magnific login is cleared server-side on failure
        }
      } catch (e) {
        if (cancelled) return;
        setResultsError((e as Error).message);
        setPollRetry((n) => n + 1);
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [current, pollRetry, refreshGallery, recheckMagnific]);

  // A generation whose own poll was cancelled (selection switched) would stay "Üretiliyor"
  // in the gallery, so refresh the list while any record is still running.
  const anyRunning = records.some((r) => r.status === 'running');
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => void refreshGallery(), GALLERY_POLL_MS);
    return () => clearInterval(timer);
  }, [anyRunning, refreshGallery]);

  const envComplete = isEnvComplete(env);
  const productsInfo = productsState(products);
  const canGenerate = productsInfo.ready && envComplete && magnificConnected === true && !starting;
  const estimate = estimateCredits(output.count, output.resolution);
  const formHint = !productsInfo.ready
    ? productsInfo.hint
    : !envComplete
      ? env.source === 'preset'
        ? 'Bir oda tarzı seçin.'
        : 'Bir mekân fotoğrafı yükleyin ya da kayıtlı bir mekân seçin.'
      : undefined;
  const hint =
    magnificConnected === false
      ? 'Görsel üretmek için önce Magnific hesabınızı bağlayın (üstteki “Magnific ile bağlan”).'
      : formHint;

  function showRecord(rec: GenerationRecord) {
    setResultsError(undefined);
    setResultsNotice(undefined);
    setCurrent(rec);
  }

  async function generate() {
    if (!productsInfo.ready || !envComplete) return;
    setStarting(true);
    setStartError(undefined);
    try {
      const rec = await startGeneration({
        products: toRequestProducts(products),
        ...envToRequest(env),
        aspect: output.aspect,
        count: output.count,
        model: MODEL_ID,
        resolution: output.resolution,
        cinematic: cleanCinematic(output.cinematic),
      });
      showRecord(rec);
      void refreshGallery();
    } catch (e) {
      setStartError((e as Error).message);
      recheckMagnific();
    } finally {
      setStarting(false);
    }
  }

  // "Tekrar üret": the record's own request, independent of the current form. Every photo is
  // checked first, so a deleted one never starts a paid run with fewer angles than before.
  async function rerun(record: GenerationRecord) {
    setRerunning(true);
    setResultsError(undefined);
    setResultsNotice(undefined);
    try {
      const { missing } = await restoreProducts(record.products, getCutout);
      if (missing > 0) {
        setResultsNotice(rerunMissing(missing));
        return;
      }
      const rec = await startGeneration(requestOf(record));
      showRecord(rec);
      void refreshGallery();
    } catch (e) {
      setResultsError((e as Error).message);
      recheckMagnific();
    } finally {
      setRerunning(false);
    }
  }

  function restore(r: GenerationRecord) {
    const token = ++restoreToken.current;
    const stale = () => token !== restoreToken.current;
    showRecord(r);
    setProductNotice(undefined);
    setSpaceNotice(undefined);
    setOutput({
      aspect: r.aspect,
      count: r.count,
      resolution: isResolution(r.resolution) ? r.resolution : '2k',
      cinematic: cleanCinematic(r.cinematic) ?? {},
    });
    const isPreset = r.envMode === 'preset';
    setEnv((prev) => ({
      ...prev,
      source: isPreset ? 'preset' : 'space',
      styleId: isPreset ? r.styleId : prev.styleId,
      spaceMode: isPreset ? prev.spaceMode : r.envMode === 'inspired-by-space' ? 'inspired-by-space' : 'place-in-space',
      note: r.note ?? '',
    }));

    // Every product with every angle, in the record's order; missing photos are dropped and noted.
    restoreProducts(r.products, getCutout).then(
      (res) => {
        if (stale()) return;
        setProducts(res.products.length > 0 ? res.products : [emptyProduct()]);
        setProductNotice(missingNotice(res.missing, res.total));
      },
      () => !stale() && setProductNotice(RESTORE_FAILED),
    );

    if (!isPreset && r.spaceUploadId) {
      getUpload(r.spaceUploadId).then(
        (u) => !stale() && setEnv((prev) => ({ ...prev, space: { uploadId: u.id, file: u.file } })),
        () => {
          if (stale()) return;
          setEnv((prev) => ({ ...prev, space: null }));
          setSpaceNotice(SPACE_MISSING);
        },
      );
    }
    // Back to the top of the form (window on phones, the two scroll panes on desktop).
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    window.scrollTo({ top: 0, behavior });
    railRef.current?.scrollTo({ top: 0, behavior });
    canvasRef.current?.scrollTo({ top: 0, behavior });
  }

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <a
        href="#results-title"
        className="skip-link btn btn-primary"
      >
        Sonuçlara geç
      </a>
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-topbar px-4 sm:px-6">
        <h1 translate="no" className="font-display text-[1.625rem] leading-none text-ink">
          Mobilya Stüdyo
        </h1>
        <MagnificConnection
          connected={magnificConnected}
          onStatus={setMagnificConnected}
          refreshKey={magnificCheck}
        />
      </header>

      <main className="flex flex-1 flex-col lg:grid lg:min-h-0 lg:grid-cols-[360px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto]">
        <aside
          ref={railRef}
          aria-label="Ayarlar"
          className="scroll-quiet divide-y max-lg:order-1 divide-line border-line bg-panel lg:col-start-1 lg:row-start-1 lg:overflow-y-auto lg:overscroll-contain lg:border-r"
        >
          <div className="space-y-3 px-4 py-5 sm:px-5">
            <ProductsPanel
              value={products}
              onChange={setProducts}
              onEdit={() => setProductNotice(undefined)}
            />
            {productNotice && <NoticeText>{productNotice}</NoticeText>}
          </div>
          <div className="px-4 py-5 sm:px-5">
            <EnvironmentPanel
              value={env}
              spaceNotice={spaceNotice}
              onChange={(patch) => {
                if (patch.space) setSpaceNotice(undefined);
                setEnv((prev) => ({ ...prev, ...patch }));
              }}
            />
          </div>
          <div className="px-4 py-5 sm:px-5">
            <OutputSettings value={output} ready={productsInfo.ready && envComplete} onChange={(patch) => setOutput((prev) => ({ ...prev, ...patch }))} />
          </div>
        </aside>

        {/* Phones: last in visual order (flex order) and sticky, so it stays pinned to the viewport
            bottom across the whole page and settles below the gallery at the end, never covering
            content. DOM / tab order stays rail → ÜRET → results. */}
        <div className="sticky bottom-0 z-20 space-y-2 max-lg:order-3 border-t border-line bg-panel px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-12px_24px_-12px_var(--dim)] sm:px-5 lg:static lg:col-start-1 lg:row-start-2 lg:border-r lg:py-4 lg:shadow-none">
          <div className="flex items-center gap-4">
            <button
              type="button"
              data-testid="generate"
              disabled={!canGenerate}
              aria-describedby={hint ? 'generate-hint' : undefined}
              onClick={generate}
              className="btn btn-primary min-h-12 flex-1 text-[15px] tracking-[0.12em]"
            >
              {starting ? 'Başlatılıyor…' : 'ÜRET'}
            </button>
            <span data-testid="credit-estimate" className="shrink-0 text-label text-muted tabular-nums">
              Tahmini: <span className="font-medium text-ink">{estimate} kredi</span>
            </span>
          </div>
          {hint && (
            <p id="generate-hint" className="flex items-start gap-2 text-small text-muted">
              <Info aria-hidden className="mt-px size-3.5 shrink-0" />
              <span>{hint}</span>
            </p>
          )}
          {startError && <ErrorText>{startError}</ErrorText>}
        </div>

        <div
          ref={canvasRef}
          className="scroll-quiet min-w-0 max-lg:order-2 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:overflow-y-auto"
        >
          <div className="mx-auto max-w-[90rem] space-y-14 px-4 py-8 sm:px-6 lg:px-10 lg:py-9">
            <ResultsView
              record={current}
              onRerun={rerun}
              rerunning={rerunning}
              error={resultsError}
              notice={resultsNotice}
            />
            <Gallery records={records} selectedId={current?.id} onSelect={restore} error={galleryError} />
          </div>
        </div>
      </main>
    </div>
  );
}
