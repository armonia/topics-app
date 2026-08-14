import { useEffect, useRef, type RefObject } from 'react';

/**
 * IL CASSETTO STA SOTTO IL DITO, per tutta la corsa.
 *
 * chi usa la app, 12/08, dal telefono: «dovremo lavorare sulla fluidità della sidebar,
 * anche perché non segue bene lo scroll del dito quando faccio lo swipe per
 * aprirla o per chiuderla».
 *
 * ── Cosa c'era prima ────────────────────────────────────────────────────────
 * Un `touchstart` che salvava la x, un `touchend` che guardava se il delta
 * superava ±60px, e in quel caso cambiava uno stato. Cioè: durante il gesto NON
 * SUCCEDE NIENTE, e a dito già staccato parte un'animazione di 200ms sempre
 * uguale. Sono due cose diverse da quella che sembrano: la prima è un pulsante
 * azionato di traverso, la seconda è un pannello che si trascina. La differenza
 * si sente subito, ed è tutta la distanza fra «app web» e «app».
 *
 * ── Cosa fa adesso ──────────────────────────────────────────────────────────
 *   dito giù ──▶ candidato (bordo sinistro se chiuso, dentro la colonna se
 *                aperto)
 *       │
 *       ├── il dito va in VERTICALE ──▶ rinuncia, e la lista scorre normale
 *       │
 *       └── il dito va in ORIZZONTALE ──▶ preso: da qui la colonna è un
 *                                         `transform` legato a `clientX`,
 *                                         senza transizione, un solo write per
 *                                         frame (rAF)
 *   dito su ──▶ posa: decide la VELOCITÀ se c'è stato un lancio, altrimenti la
 *               metà corsa; l'animazione finale dura quanto serve a quella
 *               velocità, non 200ms fissi.
 *
 * ── Perché listener nativi su `document` ────────────────────────────────────
 * Da React 17 i listener del root sono PASSIVI: dentro un `onTouchMove` di
 * React `preventDefault()` è un no-op, e senza quel `preventDefault` la lista
 * sotto scorre mentre trascini di lato — il gesto diventa un misto delle due
 * cose. Servono su `document` con `{ passive: false }`.
 *
 * E in fase di BOLLA, non di cattura: il trascinamento delle tessere fissate
 * (`useTouchDrag`) si prende il tocco in CATTURA su `document` e lo ferma lì.
 * Stando in bolla, quando quel gesto è vivo questo non parte nemmeno — cioè la
 * precedenza fra i due è già scritta, e non serve un secondo arbitro.
 *
 * ── Il velo ─────────────────────────────────────────────────────────────────
 * Sta sempre montato (`.sidebar-scrim`, index.css) e la sua opacità a riposo la
 * decide il CSS via `data-open`. Serve perché durante il gesto il velo deve
 * scurirsi INSIEME alla colonna: montarlo a gesto finito lo farebbe comparire
 * di scatto, ed è esattamente lo scatto che stiamo togliendo.
 */

/** La striscia da cui si apre. 28px: iOS ne usa ~20 per il suo gesto, e questa
 *  deve essere almeno altrettanto larga o il dito «manca» il cassetto. */
const BORDO_PX = 28;
/** Quanto deve muoversi il dito prima che si decida l'asse. Sotto questa
 *  soglia il gesto è ancora di tutti: un tocco, uno scorrimento, un lancio. */
const ASSE_PX = 8;
/** Oltre questa velocità (px/ms) il gesto è un LANCIO e vince sulla posizione:
 *  chi butta via il cassetto con due centimetri di corsa lo sta chiudendo. */
const LANCIO_PX_MS = 0.35;
/** La posa, quando non c'è velocità da seguire. */
const POSA_MS = 220;
const POSA_MIN_MS = 120;
const POSA_MAX_MS = 300;
const CURVA = 'cubic-bezier(0.2, 0, 0, 1)';

/**
 * Lo stile del cassetto mobile a RIPOSO — una funzione sola, perché lo scrivono
 * in due: React a ogni render, e questo gesto quando rimette a posto dopo la
 * posa. Due copie della stessa coppia di stringhe divergono al primo ritocco, e
 * la divergenza si vede solo col dito su un telefono.
 */
export function mobileDrawerStyle(collapsed: boolean): { width: string; transform: string } {
  return {
    width: collapsed ? '0px' : '100vw',
    transform: collapsed ? 'translateX(-100%)' : 'translateX(0)',
  };
}

export interface SidebarSwipeArgs {
  /** Solo dove il cassetto esiste: il layout mobile. */
  enabled: boolean;
  sidebarRef: RefObject<HTMLElement | null>;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
}

export function useSidebarSwipe({ enabled, sidebarRef, collapsed, setCollapsed }: SidebarSwipeArgs): void {
  // Il gesto legge lo stato mentre è in corso, quindi lo legge da un ref: se
  // dipendesse dalle props ri-aggancerebbe i listener a metà corsa. Il travaso
  // sta in un effetto e non nel corpo del render — un ref scritto durante il
  // render è un valore che non torna indietro dal Concurrent Mode.
  const chiuso = useRef(collapsed);
  const applica = useRef(setCollapsed);
  useEffect(() => {
    chiuso.current = collapsed;
    applica.current = setCollapsed;
  }, [collapsed, setCollapsed]);

  useEffect(() => {
    if (!enabled) return;

    /** Il velo: c'è sempre, ma solo su mobile. */
    const velo = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-sidebar-scrim]');
    const larghezza = (): number => window.innerWidth || 1;

    /**
     * `null` = nessun gesto in ballo.
     *
     * `sopprimi` non muove niente: e' il BORDO DESTRO, dove non c'e' nessun
     * cassetto da tirare. Serve lo stesso, perche' li' il browser tiene il suo
     * gesto per andare AVANTI nella cronologia, e l'unico modo di dirgli che il
     * tocco e' della pagina e' prenderselo.
     */
    let modo: 'apri' | 'chiudi' | 'sopprimi' | null = null;
    let preso = false;
    /** Il dito e' partito da una delle due strisce di bordo. Cambia QUANDO si
     *  decide l'asse: da li' si decide al primo movimento, non dopo 8px. */
    let daBordo = false;
    let x0 = 0;
    let y0 = 0;
    let avanzamento = 0;

    /**
     * LA VELOCITÀ SI MISURA SU UNA FINESTRA, non su due campioni qualsiasi.
     *
     * La prima versione teneva una media mobile aggiornata a ogni `touchmove`, e
     * sbagliava sempre nello stesso verso: fra il `touchstart` e il primo
     * `touchmove` possono passare due millisecondi, quindi il primo campione vale
     * decine di px/ms e domina la media per tutto il resto del gesto. Effetto
     * misurato: una corsa di 90px in mezzo secondo — cioè un ripensamento —
     * veniva letta come un lancio e apriva il cassetto.
     *
     * Con una finestra di 120ms il campione vecchio esce da solo, e un dito che
     * si ferma prima di staccarsi ha velocità zero: allora decide la posizione,
     * che è esattamente ciò che ci si aspetta.
     */
    const FINESTRA_MS = 120;
    let campioni: { x: number; t: number }[] = [];
    const campiona = (x: number, t: number) => {
      campioni.push({ x, t });
      while (campioni.length > 2 && t - campioni[0].t > FINESTRA_MS) campioni.shift();
    };
    const velocitaFinale = (): number => {
      if (campioni.length < 2) return 0;
      const a = campioni[0];
      const b = campioni[campioni.length - 1];
      const dt = b.t - a.t;
      return dt > 0 ? (b.x - a.x) / dt : 0;
    };
    let frame = 0;
    let daDisegnare = 0;
    let posaTimer: ReturnType<typeof setTimeout> | null = null;

    /** Dove sta la colonna, da 0 (chiusa) a 1 (aperta). */
    const disegna = (p: number) => {
      const node = sidebarRef.current;
      if (node) {
        node.style.transition = 'none';
        node.style.width = '100vw';
        node.style.transform = `translateX(${(p - 1) * 100}%)`;
      }
      const s = velo();
      if (s) {
        s.style.transition = 'none';
        s.style.visibility = 'visible';
        s.style.opacity = String(p);
      }
    };

    const programma = (p: number) => {
      daDisegnare = p;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        disegna(daDisegnare);
      });
    };

    /**
     * Rimette la colonna nello stato in cui React la crede, spegnendo la
     * transizione per un frame: senza, il ritorno di `width` da 100vw a 0
     * scivolerebbe per 200ms su un pannello già fuori schermo, cioè un reflow
     * per niente.
     */
    const canonico = (aperto: boolean) => {
      const node = sidebarRef.current;
      if (node) {
        const s = mobileDrawerStyle(!aperto);
        node.style.transition = 'none';
        node.style.width = s.width;
        node.style.transform = s.transform;
        requestAnimationFrame(() => { node.style.transition = ''; });
      }
      const v = velo();
      if (v) {
        // Qui si CANCELLA invece di riscrivere: il riposo del velo lo dice il
        // CSS (`.sidebar-scrim[data-open]`), e riscriverlo in linea vorrebbe
        // dire tenerne una seconda copia qui dentro.
        v.style.transition = '';
        v.style.opacity = '';
        v.style.visibility = '';
      }
    };

    const azzera = () => {
      modo = null;
      preso = false;
      daBordo = false;
      campioni = [];
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
    };

    /** Il rilascio: si sceglie dove va, e ci si va con la sua inerzia. */
    const posa = () => {
      const velocita = velocitaFinale();
      const aperto = Math.abs(velocita) > LANCIO_PX_MS
        ? velocita > 0
        : avanzamento > 0.5;
      const distanza = Math.abs((aperto ? 1 : 0) - avanzamento) * larghezza();
      const durata = Math.min(
        POSA_MAX_MS,
        Math.max(POSA_MIN_MS, Math.abs(velocita) > 0.05 ? distanza / Math.abs(velocita) : POSA_MS),
      );

      const node = sidebarRef.current;
      if (node) {
        node.style.transition = `transform ${durata}ms ${CURVA}`;
        node.style.width = '100vw';
        node.style.transform = aperto ? 'translateX(0)' : 'translateX(-100%)';
      }
      const s = velo();
      if (s) {
        s.style.transition = `opacity ${durata}ms ${CURVA}`;
        s.style.opacity = aperto ? '1' : '0';
      }

      // LO STATO SI SPOSTA A CORSA FINITA, non adesso. React scriverebbe subito
      // `width: 0` (che non è nella transizione) e il cassetto si accartoccerebbe
      // in un fotogramma mentre il `transform` anima una scatola larga zero.
      if (posaTimer) clearTimeout(posaTimer);
      posaTimer = setTimeout(() => {
        posaTimer = null;
        canonico(aperto);
        applica.current(!aperto);
      }, durata);
      azzera();
    };

    const onStart = (e: TouchEvent) => {
      if (posaTimer) return;          // una posa in corso: il gesto nuovo aspetta il suo turno
      if (e.touches.length !== 1) { azzera(); return; }
      const t = e.touches[0];
      const dentro = sidebarRef.current?.contains(t.target as Node) ?? false;
      const aDestra = t.clientX >= larghezza() - BORDO_PX;
      const aSinistra = t.clientX <= BORDO_PX;
      if (chiuso.current) {
        if (aSinistra) modo = 'apri';
        else if (aDestra) modo = 'sopprimi';
        else return;
      } else {
        if (!dentro) return;
        modo = 'chiudi';
      }
      daBordo = aSinistra || aDestra;
      preso = false;
      x0 = t.clientX;
      y0 = t.clientY;
      campioni = [];
      campiona(t.clientX, e.timeStamp || performance.now());
      avanzamento = modo === 'apri' ? 0 : 1;
    };

    const onMove = (e: TouchEvent) => {
      if (!modo) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;

      if (!preso) {
        // L'asse si decide una volta sola. Verticale = è uno scorrimento, e la
        // lista se lo tiene: rinunciare qui è ciò che rende il gesto invisibile
        // quando non lo vuoi.
        //
        // DAL BORDO SI DECIDE SUBITO, e non è un dettaglio di reattività.
        // Aspettare 8px va bene solo dove l'unico contendente è la lista sotto,
        // che aspetta anche lei. Sul margine dello schermo il contendente è il
        // BROWSER, e lui decide sui primissimi eventi: se a 2px la pagina non ha
        // ancora rivendicato il tocco, il trascinamento diventa suo e da lì in
        // poi `preventDefault` non serve più a niente. È così che il gesto del
        // menu finiva per tornare indietro nella cronologia.
        //
        // Il prezzo è misurato e piccolo: dal bordo l'asse si decide sul primo
        // movimento invece che sull'ottavo pixel, quindi uno scorrimento
        // verticale che parte nei 28px di margine è ancora della lista (vince
        // `dy`), mentre un movimento orizzontale è del cassetto un attimo prima.
        const soglia = daBordo ? 1 : ASSE_PX;
        if (Math.abs(dy) >= soglia && Math.abs(dy) > Math.abs(dx)) { azzera(); return; }
        if (Math.abs(dx) < soglia || Math.abs(dx) <= Math.abs(dy)) return;
        if (modo === 'sopprimi' ? dx >= 0 : modo === 'apri' ? dx <= 0 : dx >= 0) { azzera(); return; }
        preso = true;
      }

      // Il bordo destro non ha niente da muovere: il tocco è preso, e basta.
      // Prenderlo È il lavoro, perché è ciò che toglie il gesto al browser.
      if (modo === 'sopprimi') {
        e.preventDefault();
        return;
      }

      // Da qui il tocco è del cassetto: niente scorrimento sotto, niente gesto
      // di sistema.
      e.preventDefault();

      campiona(t.clientX, e.timeStamp || performance.now());

      const base = modo === 'apri' ? 0 : 1;
      avanzamento = Math.min(1, Math.max(0, base + dx / larghezza()));
      programma(avanzamento);
    };

    const onEnd = (e: TouchEvent) => {
      if (!modo) return;
      if (!preso) { azzera(); return; }
      // Il bordo destro non ha una posa: non c'era niente in movimento, e
      // chiamare `posa()` qui animerebbe un cassetto che nessuno ha toccato.
      if (modo === 'sopprimi') { azzera(); return; }
      // Il punto di stacco è un campione come gli altri: se il dito si è fermato
      // un istante prima di alzarsi, è quella la sua velocità — zero.
      const t = e.changedTouches[0];
      if (t) campiona(t.clientX, e.timeStamp || performance.now());
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      posa();
    };

    const onCancel = (e: TouchEvent) => {
      if (!modo) return;
      if (!preso) { azzera(); return; }
      onEnd(e);
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onCancel);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onCancel);
      if (frame) cancelAnimationFrame(frame);
      if (posaTimer) clearTimeout(posaTimer);
    };
  }, [enabled, sidebarRef]);
}
