import { useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Maximize2, PanelTop, X } from 'lucide-react';
import { getMediaUrl } from '../../lib/api';
import { isVideoPath, isPreviewablePath } from '../../lib/mediaKind';
import { MODAL_LAYER } from '../../lib/modalStyles';
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
      // `MODAL_LAYER` e non `z-[200]`: un lightbox a schermo intero è una
      // superficie modale, e 200 lo lasciava sotto ogni popover (9999). Il
      // piano si dichiara con la costante, non con un numero scelto a occhio.
      className={`fixed inset-0 ${MODAL_LAYER} flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm anim-pop`}
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
 * A task's review-evidence preview — an image (`<img>`: screenshot .png or
 * diagram .svg) OR a video clip (`<video>`), chosen by file extension. Served
 * by /api/media (Range-enabled for video seeking).
 *
 * QUANDO ciascuno dei tre — la regola sta in `PREVIEW_RULE`
 * (`shared/board.ts`), che è anche il testo letterale che leggono l'envelope
 * di kickoff, quello di resume e lo schema del tool MCP. Qui NON si riassume:
 * il riassunto che stava in questo commento diceva due rami mentre il
 * protocollo ne dice tre, ed è esattamente la divergenza che si è chiusa.
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
  // Il lightbox mostra `<img>` o `<video>`: offrirlo su un file che nessuno dei
  // due sa aprire riproporrebbe l'icona rotta, solo a schermo intero.
  const expandable = variant === 'drawer' && isPreviewablePath(path);
  const openLightbox = useCallback(() => setLightbox(true), []);

  // `max-h-36` = 144px in una colonna da 268: è la misura da cui esce
  // `PREVIEW_CARD_MAX_RATIO` (144/268), la soglia che il protocollo dà agli
  // agenti. `object-cover` NON rimpicciolisce l'eccedenza, la TAGLIA — cambiare
  // questo numero senza cambiare la costante fa mentire la regola.
  //
  // DRAWER — perché non più `max-h-[50vh] object-contain`:
  //  · il tetto in `vh` guarda la FINESTRA, non il riquadro: un'anteprima
  //    2200x6010 (una schermata lunga, che gli agenti consegnano spesso) si
  //    prendeva mezzo drawer e spingeva fuori tutto il resto;
  //  · `object-contain` mostrava tutta l'immagine RIMPICCIOLITA — a quella
  //    scala non è leggibile, quindi non serviva a decidere: mostrava soltanto
  //    che c'è un'anteprima. L'immagine intera è a UN click (lightbox, o la sua
  //    tab): la miniatura non deve fare quel lavoro.
  //  · `object-cover object-top` — lo STESSO ritaglio della card: quello che
  //    hai visto sulla card è quello che ritrovi qui, e una copertina bassa non
  //    viene stirata (il tetto taglia, non deforma).
  // Il `min(px, vh)`: il px è la misura di lettura, il vh è la garanzia che su
  // una finestra bassa l'anteprima resti una FETTA del drawer e non il drawer.
  // Un video tiene `object-contain` (ritagliarlo nasconderebbe l'azione) e un
  // tetto più alto: sotto ~150px i controlli nativi diventano inusabili.
  const mediaCls = variant === 'card'
    ? 'block w-full max-h-36 rounded border border-app-border object-cover object-top'
    : video
      ? 'block w-full max-h-[min(280px,32vh)] rounded border border-app-border bg-black/20 object-contain'
      : 'block w-full max-h-[min(220px,24vh)] rounded border border-app-border bg-black/20 object-cover object-top';

  // Terzo caso: un file che NESSUN elemento sa mostrare (un `.pdf`, un `.zip`
  // — roba fuori dai tre rami di `PREVIEW_RULE`). Prima finiva nel ramo `<img>`
  // e diventava un'icona rotta: la card sembrava consegnata e non mostrava
  // niente, che è peggio di un'anteprima assente. Qui si dichiara — nome del
  // file e un gesto per aprirlo — invece di fingere un'immagine.
  const media = !isPreviewablePath(path) ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={path}
      data-testid="preview-unrenderable"
      className={`flex items-center gap-2 px-2.5 py-2 text-left text-xs ${
        variant === 'card'
          ? 'block w-full rounded border border-app-border'
          : 'block w-full rounded border border-app-border bg-black/20'
      } text-app-text-muted hover:text-app-text`}
    >
      <FileText className="h-4 w-4 shrink-0" />
      <span className="truncate">{path.split('/').pop() || path}</span>
    </a>
  ) : video ? (
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
