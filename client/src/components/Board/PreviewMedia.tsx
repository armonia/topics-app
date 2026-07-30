import { useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X } from 'lucide-react';
import { getMediaUrl } from '../../lib/api';
import { useModalDialog } from '../../hooks/useModalDialog';

// Extensions that render as a <video> instead of an <img>. Tolerates a trailing
// query/hash (the check runs on the raw stored path — a bare filesystem path —
// so the suffix guard is defensive).
const VIDEO_RE = /\.(webm|mp4|mov|m4v)(\?|#|$)/i;

/** True when the preview media path is a video clip (a review recording).
 *  Local to this module (the only caller is the Lightbox below) — keeping it
 *  unexported lets react-refresh treat the file as component-only. */
function isVideoMedia(path: string | null | undefined): boolean {
  return !!path && VIDEO_RE.test(path);
}

/** Full-window overlay (portal, over the app — NOT a separate OS window) showing
 *  the evidence at large size. Close on Esc, click-outside, or the X. A video
 *  autoplays with controls + sound; an image fills the viewport. */
function Lightbox({ url, video, onClose }: { url: string; video: boolean; onClose: () => void }) {
  // Escape, trappola del focus e ritorno del focus: il contratto comune dei
  // dialoghi (hooks/useModalDialog), invece di un listener scritto a mano qui.
  const panelRef = useRef<HTMLDivElement>(null);
  useModalDialog({ onClose, panelRef });
  return createPortal(
    <div
      ref={panelRef}
      onClick={onClose}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm anim-pop"
      data-testid="preview-lightbox"
      // `role="dialog"` non è solo ARIA: è il marcatore con cui il resto
      // dell'app riconosce che c'è un modale aperto (lib/modalSurface). Senza,
      // Escape con il lightbox aperto arrivava fino a interrompere il turno
      // dell'AI dietro — lo `stopPropagation()` qui sopra è troppo tardi,
      // perché il gestore globale è registrato prima, sempre in capture.
      role="dialog"
      aria-modal="true"
      aria-label="Anteprima"
    >
      <button
        onClick={onClose}
        title="Chiudi (Esc)"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-neutral-100 hover:bg-white/20"
      ><X className="h-5 w-5" /></button>
      {video ? (
        <video
          src={url}
          controls
          autoPlay
          playsInline
          onClick={(e) => e.stopPropagation()}
          className="max-h-[90vh] max-w-[92vw] rounded-lg shadow-2xl"
        />
      ) : (
        <img
          src={url}
          alt="Evidenza della consegna"
          onClick={(e) => e.stopPropagation()}
          className="max-h-[90vh] max-w-[92vw] rounded-lg object-contain shadow-2xl"
        />
      )}
    </div>,
    document.body,
  );
}

/**
 * A task's review-evidence preview — a screenshot (`<img>`) OR a video clip
 * (`<video>`), chosen by file extension. Behavioural/UI tasks (auto-scroll, a
 * box that opens/closes, a streaming answer) deliver a short Playwright /
 * spec-flow recording that a static image cannot convey; static UI delivers a
 * screenshot. Served by /api/media (Range-enabled for video seeking).
 *
 * `card`   — compact living thumbnail: a video plays muted + looped inline (the
 *            motion IS the evidence); an image is static. Click bubbles up to
 *            open the drawer (no lightbox here).
 * `drawer` — modest thumbnail + an expand affordance that opens the evidence in
 *            a full-window LIGHTBOX (image or video), reviewed big without
 *            leaving the app.
 */
export function PreviewMedia({ path, variant }: { path: string; variant: 'card' | 'drawer' }) {
  const [lightbox, setLightbox] = useState(false);
  const url = getMediaUrl(path);
  const video = isVideoMedia(path);
  const expandable = variant === 'drawer';
  const openLightbox = useCallback(() => setLightbox(true), []);

  const mediaCls = variant === 'card'
    ? 'block w-full max-h-36 rounded border border-white/10 object-cover object-top'
    : 'block w-full max-h-52 rounded border border-white/10 bg-black/20 object-contain';

  const media = video ? (
    <video
      src={url}
      muted
      playsInline
      preload="metadata"
      draggable={false}
      className={mediaCls}
      // card: autoplay + loop so the behaviour shows at a glance (muted); drawer:
      // inline controls (scrub/fullscreen) + the expand button for the lightbox.
      {...(variant === 'card' ? { autoPlay: true, loop: true } : { controls: true })}
    />
  ) : (
    <img
      src={url}
      alt={expandable ? 'Anteprima della consegna' : ''}
      loading="lazy"
      draggable={false}
      onClick={expandable ? openLightbox : undefined}
      className={`${mediaCls}${expandable ? ' cursor-zoom-in' : ''}`}
    />
  );

  return (
    <div className={`group/preview relative ${variant === 'card' ? 'mb-1.5' : 'mt-2'}`}>
      {media}
      {expandable && (
        <button
          onClick={openLightbox}
          title="Apri a grandezza piena"
          className="absolute right-1.5 top-1.5 rounded bg-black/50 p-1 text-white opacity-0 transition-opacity hover:bg-black/70 group-hover/preview:opacity-100"
        ><Maximize2 className="h-3.5 w-3.5" /></button>
      )}
      {lightbox && expandable && <Lightbox url={url} video={video} onClose={() => setLightbox(false)} />}
    </div>
  );
}
