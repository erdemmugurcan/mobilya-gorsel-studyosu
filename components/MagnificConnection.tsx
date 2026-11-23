'use client';

import { useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Link2, X } from 'lucide-react';
import { getMagnificStatus } from '@/lib/client/api';

const NOTICES: Record<string, { text: string; ok: boolean }> = {
  baglandi: { text: 'Magnific hesabınız bağlandı.', ok: true },
  hata: { text: 'Magnific bağlantısı kurulamadı. Lütfen tekrar deneyin.', ok: false },
};

interface Props {
  connected: boolean | null;
  onStatus: (connected: boolean) => void;
  /** Change to re-check the connection (e.g. after a generation settles). */
  refreshKey?: number;
}

export default function MagnificConnection({ connected, onStatus, refreshKey = 0 }: Props) {
  const [notice, setNotice] = useState<{ text: string; ok: boolean }>();
  // ?magnific=baglandi|hata comes back from the OAuth callback. Read it once (a ref survives
  // the dev-mode double effect), drop it from the address bar, show it once.
  const param = useRef<{ value: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!param.current) {
      param.current = { value: new URLSearchParams(window.location.search).get('magnific') };
      if (param.current.value) {
        const url = new URL(window.location.href);
        url.searchParams.delete('magnific');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
    }
    getMagnificStatus()
      .then(
        (s) => !cancelled && onStatus(s.connected),
        () => !cancelled && onStatus(false),
      )
      .finally(() => {
        const p = param.current?.value;
        if (cancelled || !p || !param.current) return;
        param.current.value = null;
        if (Object.hasOwn(NOTICES, p)) setNotice(NOTICES[p]);
      });
    return () => {
      cancelled = true;
    };
  }, [onStatus, refreshKey]);

  return (
    <div className="flex items-center gap-3">
      {notice && (
        <div
          role="status"
          className={`toast fixed inset-x-4 top-[4.25rem] z-40 flex items-start gap-3 rounded-card border bg-panel px-4 py-3 text-label text-ink shadow-2xl sm:left-auto sm:right-6 sm:w-96 ${
            notice.ok ? 'border-ok/30' : 'border-danger/40'
          }`}
        >
          {notice.ok ? (
            <CircleCheck aria-hidden className="mt-px size-4 shrink-0 text-ok" />
          ) : (
            <CircleAlert aria-hidden className="mt-px size-4 shrink-0 text-danger" />
          )}
          <p className="min-w-0 flex-1 break-words">{notice.text}</p>
          <button
            type="button"
            aria-label="Kapat"
            onClick={() => setNotice(undefined)}
            className="-my-1 -mr-2 grid size-7 shrink-0 place-items-center rounded-control text-muted transition-colors duration-150 hover:bg-field hover:text-ink pointer-coarse:size-11"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
      )}
      {connected === true && (
        <span className="inline-flex items-center gap-2 rounded-chip border border-ok/25 px-3 py-1.5 text-small font-medium text-ok">
          <span aria-hidden className="size-1.5 rounded-full bg-ok" />
          Magnific bağlı
        </span>
      )}
      {connected === false && (
        <a href="/api/magnific/connect" className="btn btn-primary btn-sm">
          <Link2 aria-hidden />
          Magnific ile bağlan
        </a>
      )}
    </div>
  );
}
