/**
 * useBoardMotion — il lato DOM del movimento della board.
 *
 * Il piano (chi si e' mosso, di quanto, se ha cambiato colonna) lo calcola
 * `lib/boardFlight`, che non tocca il DOM ed e' testato da solo. Qui ci sono le
 * tre cose che solo il DOM sa fare: MISURARE, ANIMARE e SAPERE QUANDO NON FARLO.
 *
 * QUANDO MISURA. Non a ogni render: la board ne fa uno ogni 4 secondi solo per
 * far girare il contatore di consumo delle card al lavoro, e leggere un
 * rettangolo costa un ricalcolo di layout forzato. Misura quando cambia la
 * FIRMA della board (quali card, in che colonna, in che ordine), che e'
 * esattamente l'insieme di eventi che possono aver mosso qualcosa.
 *
 * QUANDO NON ANIMA, e sono tre casi diversi:
 *  · chi ha chiesto meno movimento non ne vede nemmeno uno;
 *  · durante un TRASCINAMENTO comanda dnd-kit, che sta gia' muovendo le stesse
 *    card: due meccanismi sullo stesso nodo si sovrascriverebbero a vicenda;
 *  · la card appena LASCIATA dal dito non viaggia. Il dito l'ha appena portata
 *    dov'e', e rimandarla al punto di partenza per rifare il tragitto da sola
 *    sarebbe l'unica animazione che contraddice il gesto di chi la guarda.
 *    Chi trascina lo dice con `skipOnce(id)` alla fine del gesto.
 *
 * IL FANTASMA. Il viaggio fra due colonne non lo fa il nodo vero: il corpo di
 * una colonna scorre in verticale, e un contenitore che scorre taglia anche in
 * orizzontale, cioe' esattamente dove il viaggio va. Vola una COPIA `fixed` sul
 * body (nessun antenato trasformato, la stessa ragione per cui ci sta il
 * fantasma del trascinamento), e la card vera resta invisibile al suo posto
 * finche' la copia non ci atterra sopra. La copia perde ogni `data-testid` e
 * ogni `id` prima di entrare nel documento: per un test, e per una tecnologia
 * assistiva, in quei 400ms non esistono due card uguali.
 */
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

import { animateEl, EASE, MOTION } from '../../lib/motion';
import { planBoardMoves, type BoardMove, type CardSpot, type ColumnBox } from '../../lib/boardFlight';
import { prefersReducedMotion } from '../../lib/reducedMotion';

const PREFISSO_COLONNA = 'kanban-column-body-';

interface Istantanea {
  spots: Map<string, CardSpot>;
  columns: Map<string, ColumnBox>;
}

/**
 * Un solo giro di letture, tutte dopo che React ha gia' mutato il DOM: il primo
 * `getBoundingClientRect` paga il ricalcolo di layout, gli altri leggono numeri
 * gia' pronti.
 */
function misura(root: HTMLElement): Istantanea {
  const spots = new Map<string, CardSpot>();
  const columns = new Map<string, ColumnBox>();
  for (const body of root.querySelectorAll<HTMLElement>(`[data-testid^="${PREFISSO_COLONNA}"]`)) {
    const status = (body.dataset.testid ?? '').slice(PREFISSO_COLONNA.length);
    if (!status) continue;
    const box = body.getBoundingClientRect();
    columns.set(status, { left: box.left, top: box.top, scrollLeft: body.scrollLeft, scrollTop: body.scrollTop });
    for (const card of body.querySelectorAll<HTMLElement>('[data-task-card]')) {
      const id = card.dataset.taskCard;
      if (!id) continue;
      const r = card.getBoundingClientRect();
      spots.set(id, {
        status,
        x: r.left - box.left + body.scrollLeft,
        y: r.top - box.top + body.scrollTop,
        w: r.width,
      });
    }
  }
  return { spots, columns };
}

/** Lo spostamento DENTRO una colonna: lo fa il nodo vero, non serve nessuna copia. */
function scivola(el: HTMLElement, m: BoardMove): void {
  animateEl(
    el,
    [{ transform: `translate(${m.dx}px, ${m.dy}px)` }, { transform: 'none' }],
    { duration: MOTION.base, easing: EASE.standard },
  );
}

/** Il viaggio fra due colonne: vola una copia, la card vera aspetta al suo posto. */
function vola(el: HTMLElement, m: BoardMove): void {
  const rect = el.getBoundingClientRect();
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.removeAttribute('data-task-card');
  ghost.removeAttribute('data-testid');
  ghost.removeAttribute('id');
  for (const n of ghost.querySelectorAll('[data-testid]')) n.removeAttribute('data-testid');
  for (const n of ghost.querySelectorAll('[id]')) n.removeAttribute('id');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('data-card-ghost', '');
  ghost.classList.add('card-ghost');
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  // L'origine e' l'angolo in alto a sinistra e non il centro: la traslazione
  // allinea GLI ANGOLI dei due rettangoli, quindi una scala presa dal centro
  // sposterebbe la copia di meta' della differenza di larghezza.
  ghost.style.transformOrigin = 'top left';
  ghost.style.transform = 'none';
  ghost.style.transition = 'none';
  document.body.appendChild(ghost);
  el.classList.add('card-flying');

  let chiuso = false;
  const atterra = () => {
    if (chiuso) return;
    chiuso = true;
    window.removeEventListener('scroll', interrompi, true);
    window.removeEventListener('resize', interrompi);
    ghost.remove();
    el.classList.remove('card-flying');
  };
  // Se qualcosa SCORRE mentre la copia e' in volo (la board porta a schermo la
  // colonna Done, o chi guarda scorre una colonna), il bersaglio si sposta e la
  // copia atterrerebbe accanto alla card vera. Meglio finire subito: il volo si
  // interrompe, la card appare dov'e'. Non e' un ripiego elegante, e' l'unico
  // onesto: una copia `fixed` non puo' seguire un contenitore che scorre.
  const interrompi = () => {
    if (anim) anim.finish();
    else atterra();
  };

  const anim = animateEl(
    ghost,
    [
      { transform: `translate(${m.dx}px, ${m.dy}px) scale(${m.scale})` },
      { transform: 'none' },
    ],
    { duration: MOTION.slow, easing: EASE.standard, fill: 'both' },
  );
  if (!anim) {
    atterra();
    return;
  }
  anim.onfinish = atterra;
  anim.oncancel = atterra;
  window.addEventListener('scroll', interrompi, { capture: true, passive: true });
  window.addEventListener('resize', interrompi);
}

function gioca(root: HTMLElement, moves: BoardMove[]): void {
  for (const m of moves) {
    const el = root.querySelector<HTMLElement>(`[data-task-card="${CSS.escape(m.id)}"]`);
    if (!el) continue;
    if (m.kind === 'flight') vola(el, m);
    else scivola(el, m);
  }
}

/**
 * Aggancia il movimento alla board.
 *
 * `signature` e' la firma delle colonne (id in ordine, colonna per colonna): la
 * calcola chi rende la board, ed e' il segnale che qualcosa PUO' essersi mosso.
 * `enabled` e' falso mentre un trascinamento e' in corso: si misura lo stesso
 * (le posizioni nuove servono al giro dopo), non si anima.
 *
 * Torna `skipOnce`: la card da lasciare stare al prossimo giro.
 */
export function useBoardMotion(
  rootRef: RefObject<HTMLElement | null>,
  signature: string,
  enabled: boolean,
): (id: string) => void {
  const prima = useRef<Map<string, CardSpot> | null>(null);
  const daSaltare = useRef<Set<string>>(new Set());

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const { spots, columns } = misura(root);
    const before = prima.current;
    prima.current = spots;
    const skip = daSaltare.current;
    daSaltare.current = new Set();
    // Il primo giro non ha un "prima": la board non e' arrivata da nessuna
    // parte, c'era gia'.
    if (!before || !enabled || prefersReducedMotion()) return;
    gioca(root, planBoardMoves({ before, after: spots, columns, skip }));
  }, [rootRef, signature, enabled]);

  return useCallback((id: string) => {
    daSaltare.current.add(id);
  }, []);
}
