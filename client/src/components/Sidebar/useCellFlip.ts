import { useLayoutEffect, useRef, type RefObject } from 'react';

import { prefersReducedMotion } from '../../lib/reducedMotion';

/**
 * Le celle si SPOSTANO invece di teletrasportarsi.
 *
 * Riordinando due tessere della stessa riga, React sposta i nodi (sono keyed
 * sulla chiave) e il browser ridisegna: le tessere si scambiavano di posto in un
 * fotogramma, senza che niente attraversasse lo spazio in mezzo. Con più di due
 * tessere non si capiva nemmeno quale si fosse mossa.
 *
 * ── Perché FLIP e non una `transition` ──────────────────────────────────────
 * Le celle non hanno una posizione da animare: stanno in un flex, e il loro
 * posto lo decide l'ordine dei nodi. Non c'è nessuna proprietà CSS che cambi
 * valore, quindi non c'è niente da interpolare. FLIP misura dov'era la cella
 * (First), dove è finita (Last), la rimette dov'era con una `transform`
 * (Invert) e lascia che l'animazione la riporti a zero (Play): l'unica tecnica
 * che dà un movimento continuo a un riordino di nodi.
 *
 * ── Interrompibile ──────────────────────────────────────────────────────────
 * Durante un drag il riordino può ripetersi due volte in 100ms. Ripartire dalla
 * posizione SALVATA farebbe rimbalzare la cella all'indietro a ogni scatto,
 * quindi si riparte da dove la cella si vede ADESSO: la traslazione ancora
 * applicata dall'animazione in volo si somma al delta (`+ tx`, `+ ty`).
 *
 * ── Solo traslazioni ────────────────────────────────────────────────────────
 * Se la LARGHEZZA della cella è cambiata, il movimento non è un riordino: è una
 * cella entrata o uscita, e tutte le altre si stanno stringendo. Lì una
 * `translate` mentirebbe (mostrerebbe la cella vecchia scivolare nella misura
 * nuova), quindi si lascia stare.
 *
 * ── E SI MISURA RISPETTO ALLA GRIGLIA, NON AL VIEWPORT ──────────────────────
 * Attilio, 12/08, dal telefono: «mentre scrollo sulla sidebar si sminchiano i
 * pinnati, si muovono e fanno scatti strani». Non era il tocco: era questo.
 * `getBoundingClientRect` dice dove la cella sta rispetto alla FINESTRA, quindi
 * scorrere la colonna di 40px cambia quel numero di 40 SENZA che niente si sia
 * riordinato. Il confronto però è fra due render, non fra due istanti: finché
 * nessuno ri-renderizza, nessuno guarda. Ma questa app ri-renderizza di
 * continuo (un frame di stream, una fase che cambia, una notifica), e il primo
 * render che capita a metà scorrimento trova `p.top - fine.top = 40` su OGNI
 * tessera e le anima tutte insieme di 40px all'indietro: lo scatto.
 *
 * La posizione che conta per un riordino è quella DENTRO la griglia, ed è
 * invariante allo scorrimento perché la radice scorre con le sue celle. Quindi
 * si sottrae il riquadro della radice, e resta solo il movimento vero.
 */

const DURATA_MS = 150;
const CURVA = 'cubic-bezier(0.2, 0, 0, 1)';

interface Riquadro {
  left: number;
  top: number;
  width: number;
}

/**
 * La traslazione che un'animazione sta applicando IN QUESTO ISTANTE.
 *
 * Serve a due cose, e sono la stessa cosa: ripartire da dove la cella si vede
 * (qui) e misurare dove la cella STARÀ invece di dove si vede (chi calcola
 * l'indice d'inserimento sotto il cursore — un rettangolo in volo farebbe
 * rimbalzare l'indice mentre l'animazione scorre).
 */
export function liveTranslate(el: Element): { x: number; y: number } {
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return { x: 0, y: 0 };
  const piatta = /^matrix\(([^)]+)\)$/.exec(t);
  if (piatta) {
    const p = piatta[1].split(',');
    return { x: parseFloat(p[4]) || 0, y: parseFloat(p[5]) || 0 };
  }
  const tridi = /^matrix3d\(([^)]+)\)$/.exec(t);
  if (tridi) {
    const p = tridi[1].split(',');
    return { x: parseFloat(p[12]) || 0, y: parseFloat(p[13]) || 0 };
  }
  return { x: 0, y: 0 };
}

/**
 * Anima ogni `[data-pinned-cell]` dentro `root` che ha cambiato posto senza
 * cambiare larghezza. Da chiamare senza dipendenze: gira a ogni render, perché
 * è il render stesso l'evento da inseguire.
 */
export function useCellFlip(root: RefObject<HTMLElement | null>): void {
  const prima = useRef(new Map<string, Riquadro>());
  const inVolo = useRef(new Map<string, Animation>());

  useLayoutEffect(() => {
    const radice = root.current;
    if (!radice) return;

    // Chi ha chiesto meno movimento non lo riceve. Ma le misure si aggiornano
    // lo stesso, altrimenti al primo cambio di preferenza si animerebbe un
    // salto accumulato da tutti i riordini precedenti.
    //
    // La domanda passa da `prefersReducedMotion` e non da `matchMedia` diretto:
    // questo effetto gira a OGNI render (non ha array di dipendenze, vedi sotto)
    // e ogni `matchMedia` costruisce un `MediaQueryList` che il documento poi si
    // tiene. Erano +741 in 104 minuti a schermo fermo.
    const ridotto = prefersReducedMotion();

    // L'origine del sistema di riferimento: la griglia stessa. Vedi il blocco
    // in cima — misurare dal viewport fa passare uno scorrimento per un
    // riordino.
    const origine = radice.getBoundingClientRect();

    const dopo = new Map<string, Riquadro>();
    for (const cella of radice.querySelectorAll<HTMLElement>('[data-pinned-cell]')) {
      const chiave = cella.dataset.pinnedCell;
      if (!chiave) continue;

      const { x: tx, y: ty } = liveTranslate(cella);
      const r = cella.getBoundingClientRect();
      // Il rettangolo misurato include la traslazione in volo: toglierla dà la
      // posizione di LAYOUT, che è quella da confrontare e da ricordare.
      const fine: Riquadro = {
        left: r.left - tx - origine.left,
        top: r.top - ty - origine.top,
        width: r.width,
      };
      dopo.set(chiave, fine);

      const p = prima.current.get(chiave);
      if (!p || ridotto || typeof cella.animate !== 'function') continue;
      if (Math.abs(p.width - fine.width) > 0.5) continue;

      const dx = p.left - fine.left + tx;
      const dy = p.top - fine.top + ty;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;

      inVolo.current.get(chiave)?.cancel();
      const anim = cella.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: DURATA_MS, easing: CURVA },
      );
      inVolo.current.set(chiave, anim);
      anim.finished
        .then(() => {
          if (inVolo.current.get(chiave) === anim) inVolo.current.delete(chiave);
        })
        .catch(() => {
          /* `cancel()` rifiuta: è il caso normale quando il riordino si ripete */
        });
    }

    prima.current = dopo;
    for (const chiave of [...inVolo.current.keys()]) {
      if (!dopo.has(chiave)) inVolo.current.delete(chiave);
    }
  });
}
