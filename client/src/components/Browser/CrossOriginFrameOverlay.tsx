import { useEffect, useState, type RefObject } from 'react';
import type { Replayer } from 'rrweb';
import { useT } from '../../hooks/useT';
import { crossOriginFrameHost } from '../../lib/crossOriginFrame';

interface FramePlaceholder {
  key: string;
  host: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Props {
  rootRef: RefObject<HTMLElement | null>;
  replayerRef: RefObject<Replayer | null>;
  pageUrl: string;
  active: boolean;
}

/** The src the host recorded for a frame it could not see into. rrweb keeps it
 *  as rr_src, but the full-snapshot rebuild leaves rr_* attributes out of the
 *  DOM: only a later mutation writes it there, otherwise it lives in the mirror. */
function recordedFrameSrc(frame: HTMLIFrameElement, player: Replayer | null): string | null {
  const own = frame.getAttribute('rr_src');
  if (own) return own;
  const meta = player?.getMirror().getMeta(frame);
  const value = meta && 'attributes' in meta ? meta.attributes.rr_src : null;
  return typeof value === 'string' ? value : null;
}

/** Places safe labels over rrweb frames that the host could not record. */
export function CrossOriginFrameOverlay({ rootRef, replayerRef, pageUrl, active }: Props) {
  const tr = useT();
  const [frames, setFrames] = useState<FramePlaceholder[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const player = replayerRef.current;
    if (!root || !active || !pageUrl) return;
    const replay = root.querySelector<HTMLIFrameElement>('.replayer-wrapper iframe');
    const doc = replay?.contentDocument;
    if (!replay || !doc) return;
    let pending = 0;
    const refresh = () => {
      pending = 0;
      const rootRect = root.getBoundingClientRect();
      const replayRect = replay.getBoundingClientRect();
      const sx = replayRect.width / Math.max(1, doc.documentElement.clientWidth);
      const sy = replayRect.height / Math.max(1, doc.documentElement.clientHeight);
      setFrames(Array.from(doc.querySelectorAll<HTMLIFrameElement>('iframe')).flatMap((frame, index) => {
        const host = crossOriginFrameHost(recordedFrameSrc(frame, player), pageUrl);
        if (!host) return [];
        const rect = frame.getBoundingClientRect();
        // Hidden and pixel-sized frames (analytics, invisible captchas) are not
        // content anybody looks at: a label there would only cover the page.
        if (rect.width < 16 || rect.height < 16) return [];
        return [{ key: `${index}:${host}:${rect.left}:${rect.top}`, host,
          left: replayRect.left - rootRect.left + rect.left * sx,
          top: replayRect.top - rootRect.top + rect.top * sy,
          width: rect.width * sx, height: rect.height * sy }];
      }));
    };
    const schedule = () => {
      if (!pending) pending = requestAnimationFrame(refresh);
    };
    // Every full-snapshot rebuild runs doc.open(), which drops the listeners
    // inside the mirror: the scroll one is armed again after each rebuild.
    const armScroll = () => {
      doc.addEventListener('scroll', schedule, true);
      schedule();
    };
    const mutation = new MutationObserver(schedule);
    mutation.observe(doc, { subtree: true, childList: true, attributes: true, attributeFilter: ['rr_src', 'src', 'style', 'width', 'height'] });
    player?.on('fullsnapshot-rebuilded', armScroll);
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    resize.observe(replay);
    armScroll();
    return () => {
      mutation.disconnect();
      player?.off('fullsnapshot-rebuilded', armScroll);
      doc.removeEventListener('scroll', schedule, true);
      resize.disconnect();
      if (pending) cancelAnimationFrame(pending);
    };
  }, [rootRef, replayerRef, pageUrl, active]);

  return active ? <>
    {frames.map((frame) => {
      const label = tr('cobrowse.frameUnavailable', { host: frame.host });
      return <button
        key={frame.key}
        type="button"
        data-testid="browser-cross-origin-frame"
        aria-label={label}
        className="absolute z-[3] flex flex-col items-center justify-center gap-1 overflow-hidden rounded border border-app-border bg-app-bg/95 px-2 text-center text-mini text-app-text shadow-sm"
        style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
        onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setNotice(`${label}. ${tr('cobrowse.frameUseMac')}`);
          window.setTimeout(() => setNotice(null), 3000);
        }}
      >
        <span className="font-medium">{label}</span>
        <span className="text-app-text-muted">{tr('cobrowse.frameUseMac')}</span>
      </button>;
    })}
    {notice && <div role="status" data-testid="browser-cross-origin-notice" className="absolute bottom-3 left-1/2 z-[5] -translate-x-1/2 rounded bg-app-bg px-3 py-2 text-mini text-app-text shadow-lg">{notice}</div>}
  </> : null;
}
