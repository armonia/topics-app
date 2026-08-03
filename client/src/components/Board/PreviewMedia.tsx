import { useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, PanelTop, X } from 'lucide-react';
import { getMediaUrl } from '../../lib/api';
import { isVideoPath } from '../../lib/mediaKind';
import { useModalDialog } from '../../hooks/useModalDialog';

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
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-app-text hover:bg-white/20"
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
 *
 * `onOpenTab`, quando c'è, aggiunge in hover il gesto che mancava: aprire
 * l'anteprima come TAB del task, accanto a Thread. Il lightbox va bene per
 * un'occhiata; una tab resta lì mentre leggi il thread, si affianca in split e
 * la ritrovi tornando sul task — che è come si guarda un'evidenza di review.
 */
export function PreviewMedia({ path, variant, onOpenTab }: {
  path: string;
  variant: 'card' | 'drawer';
  onOpenTab?: () => void;
}) {
  const [lightbox, setLightbox] = useState(false);
  const url = getMediaUrl(path);
  const video = isVideoPath(path);
  const expandable = variant === 'drawer';
  const openLightbox = useCallback(() => setLightbox(true), []);

  const mediaCls = variant === 'card'
    ? 'block w-full max-h-36 rounded border border-app-border object-cover object-top'
    : 'block w-full max-h-[50vh] rounded border border-app-border bg-black/20 object-contain';

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
      {/* I gesti stanno nello stesso angolo, in colonna: "apri come tab" per
          primo perché è quello che porta l'evidenza dentro il flusso di lavoro.
          stopPropagation: sulla card il click nudo apre il drawer, e qui NON
          vogliamo tutte e due le cose insieme. */}
      <div className="absolute right-1.5 top-1.5 flex gap-1">
        {onOpenTab && (
          <button
            onClick={(e) => { e.stopPropagation(); onOpenTab(); }}
            title="Apri l'anteprima in una tab"
            aria-label="Apri l'anteprima in una tab"
            data-testid="preview-open-tab"
            className="rounded bg-black/50 p-1 text-white opacity-0 transition-opacity hover:bg-black/70 group-hover/preview:opacity-100"
          ><PanelTop className="h-3.5 w-3.5" /></button>
        )}
        {expandable && (
          <button
            onClick={(e) => { e.stopPropagation(); openLightbox(); }}
            title="Apri a grandezza piena"
            className="rounded bg-black/50 p-1 text-white opacity-0 transition-opacity hover:bg-black/70 group-hover/preview:opacity-100"
          ><Maximize2 className="h-3.5 w-3.5" /></button>
        )}
      </div>
      {lightbox && expandable && <Lightbox url={url} video={video} onClose={() => setLightbox(false)} />}
    </div>
  );
}
