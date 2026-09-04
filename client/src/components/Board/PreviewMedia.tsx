import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useT } from '../../hooks/useT';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, FileText, Maximize2, PanelTop, X } from 'lucide-react';
import { getMediaUrl } from '../../lib/api';
import { isVideoPath, isPreviewablePath } from '../../lib/mediaKind';
import { MODAL_LAYER } from '../../lib/modalStyles';
import { useModalDialog } from '../../hooks/useModalDialog';

/** Full-window overlay (portal, over the app — NOT a separate OS window) showing
 *  the evidence at large size. Close on Esc, click-outside, or the X. A video
 *  autoplays with controls + sound; an image fills the viewport. */
function Lightbox({ url, video, onClose, su, giu, posizione }: {
  url: string;
  video: boolean;
  onClose: () => void;
  /** Slide precedente/successiva, assenti quando ce n'e' una sola. */
  su?: () => void;
  giu?: () => void;
  /** «2 / 5», per sapere dove si e' arrivati. */
  posizione?: string;
}) {
  const tr = useT();
  /* ANCHE QUI SI NAVIGA, con le frecce: chi ha ingrandito la prima evidenza
   * vuole vedere le altre senza richiudere, e a schermo intero le frecce sono
   * il gesto che ci si aspetta. */
  useEffect(() => {
    if (!su && !giu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); su?.(); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); giu?.(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [su, giu]);
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
      aria-label={tr('board.preview.label')}
      onWheel={(e) => {
        if (!su && !giu) return;
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (Math.abs(d) < 8) return;
        (d > 0 ? giu : su)?.();
      }}
    >
      {posizione && (
        <div
          data-testid="lightbox-posizione"
          className="absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-white"
        >{posizione}</div>
      )}
      <button
        onClick={onClose}
        title={tr('board.preview.close')}
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-app-text hover:bg-white/20"
      ><X className="h-5 w-5" /></button>
      {/* THE COUNTER PROMISED A NAVIGATION THAT DID NOT EXIST: «2 / 5» was on
          screen while the only ways to move were the arrow keys and the wheel,
          neither of which a phone has. The two commands are the same `su`/`giu`
          the keyboard already called -- they add a door, not a behaviour.
          `stopPropagation` because the backdrop closes on click. */}
      {su && (
        <button
          onClick={(e) => { e.stopPropagation(); su(); }}
          title={tr('board.preview.prev')}
          aria-label={tr('board.preview.prev')}
          data-testid="lightbox-prev"
          className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-app-text hover:bg-white/20"
        ><ChevronLeft className="h-6 w-6" /></button>
      )}
      {giu && (
        <button
          onClick={(e) => { e.stopPropagation(); giu(); }}
          title={tr('board.preview.next')}
          aria-label={tr('board.preview.next')}
          data-testid="lightbox-next"
          className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-app-text hover:bg-white/20"
        ><ChevronRight className="h-6 w-6" /></button>
      )}
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
          alt={tr('board.preview.evidenceAlt')}
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
 *            motion IS the evidence) MENTRE È IN VISTA, e non prima; an image is
 *            static. Click bubbles up to open the drawer (no lightbox here).
 * `drawer` — modest thumbnail + an expand affordance that opens the evidence in
 *            a full-window LIGHTBOX (image or video), reviewed big without
 *            leaving the app.
 *
 * `onOpenTab`, quando c'è, aggiunge in hover il gesto che mancava: aprire
 * l'anteprima come TAB del task, accanto a Thread. Il lightbox va bene per
 * un'occhiata; una tab resta lì mentre leggi il thread, si affianca in split e
 * la ritrovi tornando sul task — che è come si guarda un'evidenza di review.
 */
export function PreviewMedia({ path, paths, variant, onOpenTab }: {
  /** L'evidenza principale. Resta il contratto di prima. */
  path: string;
  /** LE ALTRE evidenze dello stesso task, se ce ne sono.
   *
   *  PERCHE' UNA LISTA A PARTE e non un solo array: `path` e' quello che il
   *  server ha scelto come copertina (`preview_image`), e deve restare il
   *  primo fotogramma anche quando gli altri arrivano dopo o cambiano ordine.
   *  Chi non ne ha piu' d'una non passa niente e il componente si comporta
   *  esattamente come prima. */
  paths?: readonly string[];
  variant: 'card' | 'drawer';
  onOpenTab?: () => void;
}) {
  const tr = useT();
  const [lightbox, setLightbox] = useState(false);
  /* LE SLIDE. La copertina in testa, poi le altre senza ripetizioni: un
   * allegato promosso a copertina resta anche nella lista dei commenti, e
   * senza la deduplica lo si vedrebbe due volte di fila. */
  const slides = useMemo(() => {
    const out = [path];
    for (const p of paths ?? []) if (p && p !== path && !out.includes(p)) out.push(p);
    return out;
  }, [path, paths]);
  const [i, setI] = useState(0);
  /* L'INDICE MOSTRATO E QUELLO MEMORIZZATO DEVONO COINCIDERE.
   *
   * Era `const idx = Math.min(i, slides.length - 1)`: un clamp in sola
   * lettura, che serviva a non restare oltre la fine se la lista si accorcia.
   * Ma nascondeva una divergenza — `i` poteva valere piu' di `idx`, e da li'
   * tornare indietro voleva dire prima "smaltire" la differenza a vuoto.
   *
   * Misurato sull'app viva: con tre slide, cinque rotellate avanti e cinque
   * indietro finivano su 1 invece che su 0. Le rotellate in eccesso in avanti
   * non venivano scartate: `i` cresceva oltre il limite (2, 3, 4) mentre a
   * schermo restava l'ultima, e il ritorno consumava quei passi fantasma.
   *
   * Adesso il clamp e' nello STATO — `setI` non scrive mai fuori dai limiti
   * (vedi il gestore della rotella) — e qui resta solo la difesa contro una
   * lista che si accorcia sotto: se succede, l'effetto sotto RIALLINEA anche
   * lo stato, invece di lasciare i due numeri diversi. */
  const idx = Math.min(i, slides.length - 1);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- riallineamento difensivo, non stato derivato: la guardia scatta SOLO quando la lista si accorcia sotto l'indice, converge in un giro (il nuovo `i` non puo' superare il limite) e non puo' ciclare. Il perche' e' scritto per esteso nel commento sopra.
    if (i > slides.length - 1) setI(Math.max(0, slides.length - 1));
  }, [i, slides.length]);
  const corrente = slides[idx] ?? path;
  const url = getMediaUrl(corrente);
  const video = isVideoPath(corrente);
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  /** Un video di card, cioè quello che si muove da solo: solo qui serve il gate. */
  const cardVideo = video && variant === 'card' && isPreviewablePath(corrente);

  // UN VIDEO CHE NESSUNO GUARDA NON DECODIFICA.
  //
  // La card partiva con `autoPlay loop`: N clip in loop simultanee, tutte quelle
  // della colonna, comprese quelle mai entrate nel viewport. È il ramo `<img>`
  // che diceva già la cosa giusta con `loading="lazy"` — un video non ha un
  // attributo equivalente, il gate va scritto.
  //
  // Quindi: `preload="none"` (fuori dallo schermo non si scarica nemmeno il
  // primo frame) e play/pause appesi a un IntersectionObserver sul wrapper.
  // `rootMargin` generoso: la clip si avvia poco PRIMA di entrare, così quando
  // la guardi si muove già invece di mostrare un buco nero. Uscendo si mette in
  // pausa e non si azzera: il frame su cui si è fermata resta dipinto, che è la
  // miniatura a riposo.
  useEffect(() => {
    if (!cardVideo) return;
    const el = wrapRef.current;
    if (!el) return;
    const play = () => { void videoRef.current?.play().catch(() => {}); };
    // Nessun observer (jsdom, motori vecchi): si torna al comportamento di
    // prima invece di lasciare una miniatura ferma per sempre.
    if (typeof IntersectionObserver === 'undefined') { play(); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) play();
        else videoRef.current?.pause();
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cardVideo]);
  // Il lightbox mostra `<img>` o `<video>`: offrirlo su un file che nessuno dei
  // due sa aprire riproporrebbe l'icona rotta, solo a schermo intero.
  /* IL LIGHTBOX SI APRE ANCHE DALLA CARD. Prima solo dal drawer, e non c'era
   * una ragione: chi guarda la colonna review vuole ingrandire l'evidenza
   * senza prima aprire il task. Segnalato («cliccando si apre lightbox»). */
  const expandable = isPreviewablePath(corrente);
  const openLightbox = useCallback(() => setLightbox(true), []);

  /* SI NAVIGA CON LA ROTELLA, come chiesto («piu' slide navigabili
   * semplicemente scrollando il mouse»).
   *
   * `onWheel` con `preventDefault` SOLO quando c'e' davvero piu' di una slide:
   * con una sola, mangiare la rotella impedirebbe di scorrere la colonna della
   * kanban col mouse sopra una card, che e' il gesto piu' comune di tutti.
   *
   * La soglia sul delta esiste perche' un trackpad manda decine di eventi per
   * un gesto solo: senza, un colpo di due dita salterebbe cinque slide. E il
   * blocco temporale (`ultimoScroll`) rende un gesto = una slide, che e' come
   * si comportano i caroselli che non danno fastidio. */
  const ultimoScroll = useRef(0);
  /* UN LISTENER NATIVO, e NON `onWheel` di React.
   *
   * Trovato provando: con `onWheel` la rotella non muoveva niente. React
   * registra `wheel` come listener PASSIVO (lo fa da React 17 per non
   * bloccare lo scorrimento della pagina), e in un listener passivo
   * `preventDefault()` non fa nulla — il browser scorre la colonna e l'evento
   * arriva sì, ma la pagina si è già mossa sotto il mouse, quindi il puntatore
   * lascia la miniatura prima che il cambio slide si veda.
   *
   * `{ passive: false }` si può chiedere solo registrando a mano. */
  useEffect(() => {
    const el = wrapRef.current;
    // Con UNA slide non si registra affatto: mangiare la rotella impedirebbe
    // di scorrere la colonna della kanban col mouse sopra una card, che è il
    // gesto più comune di tutti.
    if (!el || slides.length < 2) return;
    const onWheel = (e: WheelEvent) => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(d) < 8) return;
      // La colonna NON scorre mentre si naviga il carosello: senza, il gesto
      // farebbe due cose insieme.
      e.preventDefault();
      e.stopPropagation();
      // Un gesto = una slide. Un trackpad manda decine di eventi per un colpo
      // di due dita: senza questa quiete ne salterebbe cinque.
      const ora = performance.now();
      if (ora - ultimoScroll.current < 260) return;
      ultimoScroll.current = ora;
      setI((n) => {
        const next = d > 0 ? n + 1 : n - 1;
        // Si FERMA agli estremi invece di girare in tondo: un carosello che
        // riparte da capo fa perdere il conto di dove si e' arrivati.
        return Math.max(0, Math.min(next, slides.length - 1));
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [slides.length]);

  /* THE SAME GESTURE, FOR THE FINGER: the wheel above is the mouse's way
   * through the slides, and a phone has no wheel -- so the carousel was inert
   * on touch and the dots were the only way across, at 6px each.
   *
   * A horizontal swipe, and horizontal ON PURPOSE: vertical belongs to the
   * column, which scrolls under the finger, and stealing it would make the
   * board unscrollable wherever a card carries evidence. So the gesture only
   * claims the touch once it is clearly sideways (`|dx| > |dy|`), and only past
   * a threshold a tap cannot reach.
   *
   * Native and `{ passive: false }` for the reason written above about the
   * wheel: React registers `touchmove` as passive, where `preventDefault()` is
   * a no-op -- and without it the column scrolls under the slide mid-swipe. */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || slides.length < 2) return;
    let x0 = 0;
    let y0 = 0;
    let claimed = false;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { claimed = false; return; }
      x0 = e.touches[0]!.clientX;
      y0 = e.touches[0]!.clientY;
      claimed = false;
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || claimed) return;
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      if (Math.abs(dx) < 32 || Math.abs(dx) <= Math.abs(dy)) return;
      // Sideways and past the threshold: from here the touch is the
      // carousel's, and the column must not scroll with it.
      e.preventDefault();
      e.stopPropagation();
      claimed = true;
      setI((n) => Math.max(0, Math.min(dx < 0 ? n + 1 : n - 1, slides.length - 1))); // allow-italian: code, not copy: the gate reads the comparison as JSX text
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
    };
  }, [slides.length]);

  // IL TETTO È UN RAPPORTO, non un'altezza.
  //
  // Era `max-h-36`: 144px fissi. Ma la colonna è larga un INTERVALLO (Card.tsx
  // `widthCls`), quindi un'altezza fissa diventa un rapporto DIVERSO a ogni
  // larghezza — 144/250 = 0.58 nella colonna di lavoro stretta, 144/474 = 0.30
  // nella review a 1280, 144/666 = 0.22 su un board molto largo. Il protocollo
  // però promette agli agenti UN numero (`PREVIEW_CARD_MAX_RATIO`), e la
  // colonna dove si decide davvero — la review — era quella che tagliava di
  // più. È questo lo «schiacciato»: non il tetto, il tetto che si stringe da
  // solo man mano che la card si allarga.
  //
  // `cqw` = percentuale della larghezza del CONTAINER (il wrapper qui sotto ha
  // `@container`, ed è lui a portare anche il `max-w`). `70cqw` è quindi
  // letteralmente `PREVIEW_CARD_MAX_RATIO` applicato alla larghezza VERA della
  // miniatura, uguale a ogni larghezza di colonna e su mobile.
  //
  // Il secondo tetto sta sulla LARGHEZZA del wrapper (380px), non sull'altezza:
  // un `max-h` in px, misurato, rimetteva dentro il difetto appena tolto —
  // oltre una certa larghezza avrebbe ripreso il comando e il rapporto sarebbe
  // tornato a scendere colonna per colonna (in review: 320px su 474 = 0.67, e
  // 0.48 su un board largo). Fermando la LARGHEZZA, il rapporto resta 0.7
  // ovunque e il tetto in altezza esiste lo stesso, come conseguenza: 266px.
  // I due numeri stanno in `shared/board.ts` perché li cita il testo del
  // protocollo — cambiarli qui e basta fa mentire la regola che leggono gli
  // agenti, e c'è un test che confronta questa classe con le costanti.
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
  //    viene stirata (il tetto taglia, non deforma). «Lo stesso» ora lo è per
  //    davvero: prima card e drawer avevano due tetti in px diversi (144 e 220)
  //    su due larghezze diverse, quindi due ritagli diversi; con lo stesso
  //    `70cqw` il ritaglio coincide, e il `vh` resta solo come garanzia che su
  //    una finestra bassa l'anteprima sia una FETTA del drawer e non il drawer.
  // Un video tiene `object-contain` (ritagliarlo nasconderebbe l'azione) e un
  // tetto in px più alto: sotto ~150px i controlli nativi diventano inusabili,
  // e un rapporto glieli toglierebbe proprio in un drawer stretto.
  const mediaCls = variant === 'card'
    ? 'block w-full max-h-[70cqw] rounded border border-app-border object-cover object-top'
    : video
      ? 'block w-full max-h-[min(280px,32vh)] rounded border border-app-border bg-black/20 object-contain'
      // 25vh, not 32: the drawer is a full-height side panel, measured at ~85% of
      // the viewport (609px of 720 in DRAWER-01). At 32vh the preview took 37.6%
      // of the drawer, so the "a SLICE of the drawer, not the drawer" guarantee
      // above was false exactly where it was supposed to hold. 25vh keeps it
      // under 30% with margin, and the px cap still governs tall windows.
      : 'block w-full max-h-[min(70cqw,25vh)] rounded border border-app-border bg-black/20 object-cover object-top';

  // Terzo caso: un file che NESSUN elemento sa mostrare (un `.pdf`, un `.zip`
  // — roba fuori dai tre rami di `PREVIEW_RULE`). Prima finiva nel ramo `<img>`
  // e diventava un'icona rotta: la card sembrava consegnata e non mostrava
  // niente, che è peggio di un'anteprima assente. Qui si dichiara — nome del
  // file e un gesto per aprirlo — invece di fingere un'immagine.
  const media = !isPreviewablePath(corrente) ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={corrente}
      data-testid="preview-unrenderable"
      className={`flex items-center gap-2 px-2.5 py-2 text-left text-xs ${
        variant === 'card'
          ? 'block w-full rounded border border-app-border'
          : 'block w-full rounded border border-app-border bg-black/20'
      } text-app-text-muted hover:text-app-text`}
    >
      <FileText className="h-4 w-4 shrink-0" />
      <span className="truncate">{corrente.split('/').pop() || corrente}</span>
    </a>
  ) : video ? (
    <video
      ref={videoRef}
      src={url}
      muted
      playsInline
      // `none` sulla card: il download parte quando l'observer dice che si sta
      // per guardare, non perché la card esiste. Nel drawer la clip è UNA e la
      // stai già guardando.
      preload={variant === 'card' ? 'none' : 'metadata'}
      draggable={false}
      className={`${mediaCls}${variant === 'card' && expandable ? ' cursor-zoom-in' : ''}`}
      // card: loop so the behaviour shows at a glance (muted) — ma la partenza
      // la decide l'IntersectionObserver qui sopra, non `autoPlay`; drawer:
      // inline controls (scrub/fullscreen) + the expand button for the lightbox.
      /* ANCHE IL VIDEO SI APRE, e col cursore che lo dice. Sulla card non ha
       * `controls` (sarebbero inusabili a quella dimensione) quindi il click
       * era un gesto morto: adesso porta al lightbox, dove i controlli ci sono
       * e il suono pure. Nel drawer i controlli ci sono gia' e il click deve
       * restare loro — premere «play» non deve aprire un lightbox. */
      onClick={variant === 'card' && expandable ? (e) => { e.stopPropagation(); openLightbox(); } : undefined}
      {...(variant === 'card' ? { loop: true } : { controls: true })}
    />
  ) : (
    <img
      src={url}
      alt={expandable ? tr('board.preview.deliveryAlt') : ''}
      loading="lazy"
      draggable={false}
      /* `stopPropagation`: sulla card il click NUDO apre il drawer del task, e
       * senza questo si aprirebbero tutte e due le cose insieme — il lightbox
       * sopra un drawer che intanto scivola dentro. Nel drawer non c'e' niente
       * sotto, ma fermarlo comunque tiene il gesto uguale nelle due superfici. */
      onClick={expandable ? (e) => { e.stopPropagation(); openLightbox(); } : undefined}
      className={`${mediaCls}${expandable ? ' cursor-zoom-in' : ''}`}
    />
  );

  return (
    // `@container`: è QUESTO wrapper la larghezza contro cui si misura il
    // `70cqw` del tetto. Senza, `cqw` risalirebbe al primo antenato con
    // `container-type` — nessuno, quindi il viewport — e il tetto tornerebbe a
    // guardare la finestra invece del riquadro.
    // NESSUN tetto in larghezza: la miniatura riempie la card, perché una
    // fascia vuota a destra in una colonna larga si legge come un difetto
    // (segnalato da Attilio il 12/08 guardando la review). Il rapporto resta
    // 0.7 ovunque, quindi l'altezza cresce con la colonna: 0.7 x 474 = 332px
    // in review a 1280. Se un giorno la card diventasse troppo alta, il tetto
    // torna QUI sul container e non sull'`img` — dev'essere il container a
    // fermarsi, altrimenti il `cqw` misurerebbe la card mentre l'immagine e'
    // piu' stretta, e i due numeri divergerebbero.
    <div
      ref={wrapRef}
      data-testid={`preview-${variant}`}
      // THE COMPOSER'S FLOAT, minus the two thirds of it that are physically
      // unavailable here.
      //
      // A floating card is a ground, a gap and a LIT EDGE. The preview cannot
      // have the first two: the card behind it is an opaque `bg-surface`, so a
      // tint under the media paints a pixel the bitmap covers whole, and a
      // `backdrop-filter` blurs a flat fill back into the same flat fill. Two
      // different kinds of nothing, neither of which fails a test.
      //
      // The third one this app already owns as a shared class, asked for on
      // 07/08 for exactly this shape (elements with a radius that float):
      // `.edge-lit`. So the preview JOINS that family instead of copying the
      // composer's numbers, and cannot drift from it.
      //
      // WHY THE CLASS GOES HERE AND NOT ON THE MEDIA. `.edge-lit` draws with an
      // `inset` box-shadow on a `::before`, and an inset shadow paints UNDER
      // the element's content: on a replaced element (`<img>`, `<video>`) the
      // bitmap IS the content, so the ring would be invisible while
      // `getComputedStyle` still reported it word for word. On this wrapper the
      // `::before` is a positioned descendant and paints ABOVE the media. The
      // wrapper's box equals the media's box (no padding, the overlays are
      // absolute), so the hairlines land on the media's own 1px border and eat
      // no image pixels.
      //
      // NO SHADOW, deliberately. The card is the thing that floats; a child
      // with a heavier shadow than its parent inverts the elevation. It would
      // not even show: on the dark surface `shadow-md shadow-black/40` measures
      // 1.106:1, under this repo's own 1.17:1 threshold for a step to read.
      //
      // `rounded` is NOT decoration here: `.edge-lit::before` inherits the
      // radius, so it must stay EQUAL to the media's `rounded` in `mediaCls`.
      // `board-preview-edge.spec.ts` asserts the two agree. `relative` stays
      // explicit even though `.edge-lit` sets it: the absolute overlays below
      // depend on it.
      className={`group/preview edge-lit relative rounded @container ${variant === 'card' ? 'mb-1.5' : 'mt-2'}`}
    >
      {media}
      {/* I gesti stanno nello stesso angolo, in colonna: "apri come tab" per
          primo perché è quello che porta l'evidenza dentro il flusso di lavoro.
          stopPropagation: sulla card il click nudo apre il drawer, e qui NON
          vogliamo tutte e due le cose insieme. */}
      {/* I PUNTINI: quante slide ci sono e dove sei. Senza, la rotella
          sposterebbe l'immagine senza che niente dica che ce n'erano altre —
          cioe' una funzione invisibile. Cliccabili, perche' con tre slide
          arrivare alla terza con la rotella e' piu' lento che puntarla. */}
      {slides.length > 1 && (
        <div
          data-testid="preview-slides"
          className="absolute inset-x-0 bottom-1.5 flex items-center justify-center gap-1.5"
        >
          {slides.map((s, n) => (
            <button
              key={s}
              type="button"
              onClick={(e) => { e.stopPropagation(); setI(n); }}
              aria-label={tr('board.preview.slide', { n: n + 1, tot: slides.length })}
              aria-current={n === idx}
              data-testid={n === idx ? 'preview-slide-attiva' : 'preview-slide'}
              // 6px was the whole target: the bounding box IS the target here.
              // `tap-expand-y` and not the 44px square, for the reason index.css
              // spells out: these dots are 6px apart, so square areas would
              // overlap each other and the LAST one in the DOM would take every
              // tap -- one dot would answer for all of them. Vertical is the
              // axis that has room, and on a coarse pointer the dot itself
              // grows a little so it can be aimed at.
              className={`tap-expand-y h-1.5 coarse:h-2.5 rounded-full transition-all ${
                n === idx ? 'w-4 coarse:w-5 bg-white' : 'w-1.5 coarse:w-2.5 bg-white/50 hover:bg-white/80'
              }`}
            />
          ))}
        </div>
      )}
      <div className="absolute right-1.5 top-1.5 flex gap-1">
        {onOpenTab && (
          <button
            onClick={(e) => { e.stopPropagation(); onOpenTab(); }}
            title={tr('board.preview.openAsTab')}
            aria-label={tr('board.preview.openAsTab')}
            data-testid="preview-open-tab"
            className="rounded bg-black/50 p-1 text-white opacity-0 transition-opacity hover:bg-black/70 group-hover/preview:opacity-100"
          ><PanelTop className="h-3.5 w-3.5" /></button>
        )}
        {expandable && (
          <button
            onClick={(e) => { e.stopPropagation(); openLightbox(); }}
            title={tr('board.preview.openFullSize')}
            className="rounded bg-black/50 p-1 text-white opacity-0 transition-opacity hover:bg-black/70 group-hover/preview:opacity-100"
          ><Maximize2 className="h-3.5 w-3.5" /></button>
        )}
      </div>
      {lightbox && expandable && (
        <Lightbox
          url={url}
          video={video}
          onClose={() => setLightbox(false)}
          su={slides.length > 1 ? () => setI((n) => Math.max(0, n - 1)) : undefined}
          giu={slides.length > 1 ? () => setI((n) => Math.min(slides.length - 1, n + 1)) : undefined}
          posizione={slides.length > 1 ? `${idx + 1} / ${slides.length}` : undefined}
        />
      )}
    </div>
  );
}
