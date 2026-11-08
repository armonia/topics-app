/**
 * THE PANE WHILE ITS PAGE IS ON ITS WAY, OR WILL NOT COME (BROWSER-LOAD-01).
 *
 * Only over a BLANK page. A pane that shows a page keeps it on screen through
 * the next load, with the strip for a failure, as before. Over a blank page
 * there is nothing to keep, and what was there instead was the generic
 * "starting the shared session" spinner, for as long as the page's server kept
 * quiet: 13/10, an iPad on a dev server of the Mac that took the connection and
 * never answered. Now the pane names where it is going, counts the seconds once
 * they start to matter, and says why it did not get there, with Retry.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RotateCw } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { pageTarget, serverNavErrorText } from './navErrorMessage';

/** Past this a load that has not answered says so: most pages are there by then. */
const SILENT_AFTER_MS = 5_000;

interface BrowserPageWaitProps {
  url: string;
  /** When the load set off (this device's clock), null when none is under way. */
  loadingSince: number | null;
  /** Why the last load failed, in the server browser's words. */
  error: string | null;
  onRetry: () => void;
}

export function BrowserPageWait({ url, loadingSince, error, onRetry }: BrowserPageWaitProps) {
  const tr = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (loadingSince === null || error) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [loadingSince, error]);

  if (error) {
    const { message, hint } = serverNavErrorText(url, error, tr);
    return (
      <div role="alert" data-testid="browser-page-failed" className="absolute inset-0 z-[6] flex items-center justify-center p-6 bg-app-bg">
        <div className="max-w-md text-center">
          <AlertTriangle size={28} className="mx-auto mb-3 text-app-text-tertiary" aria-hidden />
          <div className="text-prose font-medium text-app-text">{message}</div>
          {hint && <div className="mt-1.5 text-compact text-app-text-muted leading-snug">{hint}</div>}
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 text-compact rounded-md border border-app-border-light text-app-text hover:bg-app-hover transition-colors"
          >
            <RotateCw size={12} aria-hidden />
            {tr('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  const waited = loadingSince === null ? 0 : now - loadingSince;
  return (
    <div data-testid="browser-page-opening" className="absolute inset-0 z-[6] flex items-center justify-center p-6 bg-app-bg pointer-events-none">
      <div className="min-w-0 max-w-md text-center">
        <Loader2 size={28} className="mx-auto mb-2 text-app-spinner animate-spin" aria-hidden />
        <p className="text-compact text-app-text-muted truncate">{tr('browser.load.opening', { target: pageTarget(url) })}</p>
        {waited >= SILENT_AFTER_MS && (
          <p className="mt-1 text-mini text-app-text-tertiary">{tr('browser.load.silent', { seconds: Math.floor(waited / 1_000) })}</p>
        )}
      </div>
    </div>
  );
}
