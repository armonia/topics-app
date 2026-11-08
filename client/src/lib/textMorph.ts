/**
 * textMorph.ts — cosa e' cambiato in una frase riscritta, e quanto puo' durare
 * mostrarlo.
 *
 * IL PROBLEMA. Un titolo che cambia (un task rinominato da una persona o
 * riscritto dall'agente che lo ha preso in carico) cambiava in un fotogramma:
 * la vecchia frase non se ne andava, veniva SOSTITUITA. Chi guardava la board
 * mentre succedeva vedeva una card diversa e non sapeva se fosse la stessa;
 * chi non guardava non aveva modo di accorgersene mai.
 *
 * LA REGOLA. Non si anima "il testo": si anima CIO' CHE E' CAMBIATO. Prefisso e
 * suffisso in comune restano fermi (sono la parte che dice «e' sempre lo stesso
 * task»), e solo le lettere nuove entrano, una dietro l'altra. E' anche la
 * versione piu' economica: rinominare «Rifare il footer» in «Rifare il footer
 * del sito» anima nove caratteri, non ventiquattro.
 *
 * LE DUE VIE D'USCITA, perche' la scala non e' infinita.
 *  · Zero caratteri nuovi (una riscrittura che ha solo TOLTO) non ha lettere da
 *    far entrare: li' la frase intera fa una dissolvenza (`block`).
 *  · Oltre `MORPH_MAX_CHARS` caratteri nuovi non e' piu' una correzione, e'
 *    un'altra frase: animarne trecento a scaletta vorrebbe dire trecento nodi
 *    nel DOM di una card e una scaletta lunga un secondo e mezzo. Anche li',
 *    dissolvenza.
 *
 * IL TEMPO E' UN BUDGET, NON UN PASSO FISSO. Con un passo fisso la durata
 * cresce con la lunghezza, quindi la stessa animazione sarebbe elegante su una
 * parola e interminabile su una riga. Qui il passo si STRINGE per stare dentro
 * `MORPH_STAGGER_BUDGET_MS`: sotto le ~26 lettere vale il passo pieno, sopra si
 * accorcia da solo.
 *
 * Questo modulo non sa niente di DOM: torna un piano, e chi lo disegna e'
 * `components/Shared/MorphText.tsx`.
 */

import { MOTION } from './motion';

/** Oltre questa soglia una riscrittura non e' piu' una correzione. */
export const MORPH_MAX_CHARS = 60;

/** Quanto puo' durare in tutto la SCALETTA (l'ultima lettera parte entro qui). */
export const MORPH_STAGGER_BUDGET_MS = 420;

/** Il ritardo fra una lettera e la successiva, quando c'e' spazio per il passo pieno. */
export const MORPH_STEP_MS = 16;

export interface MorphPlan {
  /** `letters` = le lettere nuove entrano a scaletta. `block` = dissolve tutto. */
  kind: 'letters' | 'block';
  /** La parte iniziale rimasta uguale (vuota per `block`). */
  prefix: string;
  /** Le lettere nuove, in ordine (vuota per `block`). */
  changed: string;
  /** La parte finale rimasta uguale (vuota per `block`). */
  suffix: string;
  /** Ritardo fra una lettera e la successiva, in ms. */
  stepMs: number;
  /** Quanto dura in tutto, dall'inizio all'ultima lettera posata. */
  durationMs: number;
}

/** I code point, non le unita' UTF-16: un'emoji e' UNA lettera, non due mezze. */
function chars(s: string): string[] {
  return Array.from(s);
}

/**
 * Il piano per passare da `prev` a `next`, oppure `null` se non c'e' niente da
 * animare (testo identico, o un testo che compare per la prima volta: quello
 * non e' un cambio, e' una nascita, e la anima chi monta il nodo).
 */
export function morphPlan(prev: string, next: string): MorphPlan | null {
  if (prev === next) return null;
  if (prev.length === 0 || next.length === 0) return blockPlan();

  const a = chars(prev);
  const b = chars(next);
  const max = Math.min(a.length, b.length);

  let head = 0;
  while (head < max && a[head] === b[head]) head++;

  let tail = 0;
  while (tail < max - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const changed = b.slice(head, b.length - tail);
  if (changed.length === 0) return blockPlan();
  if (changed.length > MORPH_MAX_CHARS) return blockPlan();

  const stepMs = Math.min(MORPH_STEP_MS, MORPH_STAGGER_BUDGET_MS / changed.length);
  return {
    kind: 'letters',
    prefix: b.slice(0, head).join(''),
    changed: changed.join(''),
    suffix: tail > 0 ? b.slice(b.length - tail).join('') : '',
    stepMs,
    durationMs: Math.round((changed.length - 1) * stepMs + MOTION.base),
  };
}

function blockPlan(): MorphPlan {
  return { kind: 'block', prefix: '', changed: '', suffix: '', stepMs: 0, durationMs: MOTION.fast };
}

/**
 * Le lettere nuove spezzate in PAROLE, con gli spazi conservati come pezzi a
 * se'.
 *
 * Serve a chi disegna, e serve per una ragione sola: una lettera per nodo
 * significa che il browser puo' andare a capo FRA DUE LETTERE della stessa
 * parola, e su una card stretta la frase si spezzerebbe a meta' parola per il
 * tempo dell'animazione, muovendo tutto il resto. Tenendo insieme la parola
 * (chi disegna le mette un `white-space: nowrap`) i punti dove si va a capo
 * restano quelli di sempre: gli spazi.
 */
export function morphWordChunks(changed: string): string[] {
  if (changed.length === 0) return [];
  return changed.split(/(\s+)/u).filter((piece) => piece.length > 0);
}
