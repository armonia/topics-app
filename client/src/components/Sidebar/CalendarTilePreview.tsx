import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { isTauri } from '../../lib/shell';
import { tauriInvoke } from '../../lib/shell/tauri';

/**
 * THE HOVER PREVIEW OF A PINNED CALENDAR TILE.
 *
 * A screenshot of the browser pane already open for this pin -- never a new
 * browser, and never the ICS feed configured in Settings (that feed keeps
 * powering its own subsystem; it is just not the source here). Mounted only
 * while the tile is hovered or focused, so the request it fires happens
 * exactly once per open and nothing runs while the tile is closed.
 */
export function CalendarTilePreview({ browserId, active }: { browserId: string; active: boolean }) {
  const t = useT();
  const [tauriSrc, setTauriSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // A cache-busting stamp taken once, at the moment this preview is
  // mounted (the component unmounts on close), so the remote engine's
  // snapshot route is never served a stale image.
  const [stamp] = useState(() => Date.now());

  useEffect(() => {
    if (!active || !isTauri) return;
    let alive = true;
    tauriInvoke<string>('browser_screenshot', { id: browserId })
      .then(base64 => {
        if (alive) setTauriSrc(`data:image/png;base64,${base64}`);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [active, browserId]);

  // The remote engine already serves a live snapshot at this route (see
  // useRemoteBrowser's own preview image) -- an <img> can just point at
  // it, no extra fetch/blob plumbing needed.
  const src = isTauri ? tauriSrc : `/api/browsers/${encodeURIComponent(browserId)}/snapshot?format=jpeg&t=${stamp}`;

  return (
    <div
      data-testid="calendar-tile-preview"
      className="w-[220px] overflow-hidden rounded-lg border border-app-border bg-app-panel shadow-xl"
    >
      {!active ? (
        <div className="px-2 py-1.5 text-[11px] text-app-text-muted">{t('calendar.preview.notOpen')}</div>
      ) : failed ? (
        <div className="px-2 py-1.5 text-[11px] text-app-text-muted">{t('calendar.preview.unavailable')}</div>
      ) : !src ? (
        <div className="px-2 py-1.5 text-[11px] text-app-text-muted">{t('calendar.preview.loading')}</div>
      ) : (
        <img
          src={src}
          alt={t('calendar.preview.alt')}
          data-testid="calendar-tile-preview-image"
          className="block h-[132px] w-full object-cover object-top"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
