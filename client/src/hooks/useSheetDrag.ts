import { useEffect, useRef, type RefObject } from 'react';

/**
 * IL FOGLIO STA SOTTO IL DITO, per tutta la corsa.
 *
 * Segnalato dal telefono: «per le cose che escono da sotto dovrei poter fare
 * drag naturale che segue per richiuderlo».
 *
 * I fogli dal basso (il `Menu` mobile, il menu Topics, l'ispettore del
 * contesto) si chiudevano in due modi soli: toccare il velo, o premere Escape —
 * che su un telefono non esiste. Il gesto che tutti fanno, spingerli giù, non
 * era cablato da nessuna parte: il dito scorreva sul contenuto e il foglio
 * restava fermo.
 *
 * Questo è il gemello verticale di `useSidebarSwipe`, e ne eredita le quattro
 * lezioni pagate lì:
 *
 *   1. **Listener nativi su `document`, non handler di React.** Da React 17
 *      quelli del root sono passivi: dentro un `onTouchMove` di React
 *      `preventDefault()` è un no-op, e senza quello la lista sotto scorre
 *      mentre trascini il foglio.
 *   2. **In BOLLA, non in cattura.** `useTouchDrag` (tessere fissate) prende il
 *      tocco in cattura e lo ferma lì: stando in bolla la precedenza fra i
 *      gesti è già scritta, senza un arbitro in più.
 *   3. **Lo stato React si sposta a corsa FINITA.** Chiudere al rilascio
 *      smonterebbe il foglio mentre la sua animazione è a metà.
 *   4. **La velocità si misura su una FINESTRA (120ms).** Fra `touchstart` e il
 *      primo `touchmove` possono passare 2ms: quel campione vale decine di
 *      px/ms e, in una media, domina tutto il gesto.
 *
 * L'unica regola in più, ed è quella che fa la differenza fra un foglio e una
 * tenda: **se il contenuto è già scorso, il dito lo sta scorrendo.** Il
 * trascinamento parte solo quando la colonna scorrevole sotto il dito è in
 * cima, che è esattamente il momento in cui tirare giù non ha altro significato.
 */

/** Quanto deve muoversi il dito prima che si decida l'asse. */
const ASSE_PX = 8;
/** Oltre questa velocità (px/ms) il gesto è un LANCIO e vince sulla posizione. */
const LANCIO_PX_MS = 0.35;
/** La posa, quando non c'è velocità da seguire. */
const POSA_MS = 220;
const POSA_MIN_MS = 120;
const POSA_MAX_MS = 300;
const CURVA = 'cubic-bezier(0.2, 0, 0, 1)';
/** La finestra su cui si misura la velocità di stacco. */
const FINESTRA_MS = 120;

export interface SheetSettle {
  /** true = il foglio se ne va. */
  chiudi: boolean;
  durataMs: number;
}

/**
 * Dove va il foglio quando il dito si stacca — la regola, senza DOM, così si
 * prova da sola.
 *
 * Un LANCIO verso il basso chiude anche da fermo a due centimetri: chi butta
 * via un foglio lo sta chiudendo, e pretendere metà schermo di corsa vuol dire
 * un foglio che «resiste». Senza velocità decide la posizione: oltre metà
 * altezza è chiuso. La durata è quella che serve a quella velocità per coprire
 * la distanza che resta, tenuta nella fascia in cui un'animazione si legge
 * ancora come un movimento e non come un salto.
 */
export function sheetSettle(corsa: number, altezza: number, velocita: number): SheetSettle {
  const chiudi = velocita > LANCIO_PX_MS ? true : velocita < -LANCIO_PX_MS ? false : corsa > altezza / 2;
  const distanza = Math.abs((chiudi ? altezza : 0) - corsa);
  const rapida = Math.abs(velocita) > 0.05;
  const durataMs = Math.min(
    POSA_MAX_MS,
    Math.max(POSA_MIN_MS, rapida ? distanza / Math.abs(velocita) : POSA_MS),
  );
  return { chiudi, durataMs };
}

/**
 * La colonna che scorre fra il dito e il foglio, se c'è. Serve a rispondere a
 * una domanda sola: quel contenuto è già in cima?
 */
function scorrevoleSotto(dito: Node | null, foglio: HTMLElement): HTMLElement | null {
  let n: Node | null = dito;
  while (n && n !== foglio.parentNode) {
    if (n instanceof HTMLElement && n.scrollHeight > n.clientHeight + 1) {
      const y = getComputedStyle(n).overflowY;
      if (y === 'auto' || y === 'scroll') return n;
    }
    n = n.parentNode;
  }
  return null;
}

export interface SheetDragArgs {
  /** Solo dove il foglio esiste: aperto, e nel layout mobile. */
  enabled: boolean;
  sheetRef: RefObject<HTMLElement | null>;
  /** Il velo, che deve schiarirsi INSIEME al foglio: montarlo/smontarlo a gesto
   *  finito farebbe lo scatto che stiamo togliendo. */
  scrimRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}

export function useSheetDrag({ enabled, sheetRef, scrimRef, onClose }: SheetDragArgs): void {
  // Il gesto legge la chiusura mentre è in corso: da un ref, o ri-aggancerebbe
  // i listener a metà corsa. Il travaso sta in un effetto e non nel render.
  const chiudi = useRef(onClose);
  useEffect(() => { chiudi.current = onClose; });

  useEffect(() => {
    if (!enabled) return;

    let preso = false;
    let attivo = false;
    let y0 = 0;
    let x0 = 0;
    let corsa = 0;
    let altezza = 1;
    let campioni: { y: number; t: number }[] = [];
    let frame = 0;
    let daDisegnare = 0;
    let posaTimer: ReturnType<typeof setTimeout> | null = null;

    const campiona = (y: number, t: number) => {
      campioni.push({ y, t });
      while (campioni.length > 2 && t - campioni[0].t > FINESTRA_MS) campioni.shift();
    };
    const velocitaFinale = (): number => {
      if (campioni.length < 2) return 0;
      const a = campioni[0];
      const b = campioni[campioni.length - 1];
      const dt = b.t - a.t;
      return dt > 0 ? (b.y - a.y) / dt : 0;
    };

    const disegna = (px: number) => {
      const node = sheetRef.current;
      if (node) {
        node.style.transition = 'none';
        node.style.transform = `translateY(${px}px)`;
      }
      const s = scrimRef?.current;
      if (s) {
        s.style.transition = 'none';
        s.style.opacity = String(Math.max(0, 1 - px / altezza));
      }
    };

    const programma = (px: number) => {
      daDisegnare = px;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        disegna(daDisegnare);
      });
    };

    /** Toglie di mezzo ciò che il gesto ha scritto in linea, e lascia parlare il CSS. */
    const canonico = () => {
      const node = sheetRef.current;
      if (node) {
        node.style.transition = '';
        node.style.transform = '';
      }
      const s = scrimRef?.current;
      if (s) {
        s.style.transition = '';
        s.style.opacity = '';
      }
    };

    const azzera = () => {
      preso = false;
      attivo = false;
      campioni = [];
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
    };

    const posa = () => {
      const node = sheetRef.current;
      const { chiudi: vaVia, durataMs } = sheetSettle(corsa, altezza, velocitaFinale());
      if (node) {
        node.style.transition = `transform ${durataMs}ms ${CURVA}`;
        node.style.transform = vaVia ? `translateY(${altezza}px)` : 'translateY(0)';
      }
      const s = scrimRef?.current;
      if (s) {
        s.style.transition = `opacity ${durataMs}ms ${CURVA}`;
        s.style.opacity = vaVia ? '0' : '1';
      }

      if (posaTimer) clearTimeout(posaTimer);
      posaTimer = setTimeout(() => {
        posaTimer = null;
        if (vaVia) {
          chiudi.current();
          // Se il foglio è ancora lì (un chiamante che non smonta), va rimesso
          // al suo posto: altrimenti resta fuori schermo e invisibile per
          // sempre. Un frame dopo, cioè quando React ha già smontato nel caso
          // normale e `sheetRef.current` è nullo.
          requestAnimationFrame(() => { if (sheetRef.current?.isConnected) canonico(); });
        } else {
          canonico();
        }
      }, durataMs);
      azzera();
    };

    const onStart = (e: TouchEvent) => {
      if (posaTimer) return;
      const node = sheetRef.current;
      if (!node || e.touches.length !== 1) { azzera(); return; }
      const t = e.touches[0];
      if (!node.contains(t.target as Node)) return;
      preso = true;
      attivo = false;
      x0 = t.clientX;
      y0 = t.clientY;
      corsa = 0;
      altezza = Math.max(1, node.getBoundingClientRect().height);
      campioni = [];
      campiona(t.clientY, e.timeStamp || performance.now());
    };

    const onMove = (e: TouchEvent) => {
      if (!preso) return;
      const t = e.touches[0];
      if (!t) return;
      const dy = t.clientY - y0;
      const dx = t.clientX - x0;

      if (!attivo) {
        // L'asse si decide una volta sola, e verso l'ALTO il foglio non ha
        // dove andare: quel gesto è del contenuto.
        if (Math.abs(dx) >= ASSE_PX && Math.abs(dx) > Math.abs(dy)) { azzera(); return; }
        if (dy < ASSE_PX) { if (dy <= -ASSE_PX) azzera(); return; }
        // Il contenuto è già scorso: il dito lo sta scorrendo, non trascinando
        // il foglio. Riprendere da qui sarebbe rubargli il gesto a metà.
        const node = sheetRef.current;
        const col = node ? scorrevoleSotto(t.target as Node, node) : null;
        if (col && col.scrollTop > 0) { azzera(); return; }
        attivo = true;
        // Il conto NON riparte da qui, resta ancorato al `touchstart`: come nel
        // cassetto, il foglio recupera in un fotogramma i pixel della soglia
        // (~8, quanti ne serve al dito per dichiarare l'asse) e da lì in poi la
        // distanza percorsa dal foglio è ESATTAMENTE quella del dito. Riazzerare
        // qui darebbe l'effetto opposto: il foglio resterebbe indietro per
        // sempre di quanto è stato il primo spostamento.
      }

      // Da qui il tocco è del foglio: niente scorrimento sotto, niente gesto
      // di sistema.
      e.preventDefault();
      campiona(t.clientY, e.timeStamp || performance.now());
      corsa = Math.max(0, t.clientY - y0);
      programma(corsa);
    };

    const onEnd = (e: TouchEvent) => {
      if (!preso) return;
      if (!attivo) { azzera(); return; }
      // Il punto di stacco è un campione come gli altri: se il dito si è fermato
      // un istante prima di alzarsi, è quella la sua velocità — zero.
      const t = e.changedTouches[0];
      if (t) campiona(t.clientY, e.timeStamp || performance.now());
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      posa();
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
      if (frame) cancelAnimationFrame(frame);
      if (posaTimer) clearTimeout(posaTimer);
    };
  }, [enabled, sheetRef, scrimRef]);
}
