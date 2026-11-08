/**
 * Due tempi, non uno: quanto ha LAVORATO l'agente e quanto ha aspettato NOI.
 *
 * Il cronometro del turno misurava la distanza dall'inizio, e basta. Con una
 * domanda a schermo quel numero cresce durante il pranzo di chi doveva
 * rispondere, e poi resta lì come se l'agente ci avesse messo mezz'ora a fare
 * una cosa da otto secondi. È il numero che l'umano ha visto scorrere e ha
 * chiamato brutto: non era brutto, era falso.
 *
 * Qui si separano — e mentre la domanda è aperta il numero SI FERMA.
 *
 * Il primo tentativo lasciava girare il cronometro sull'attesa («è da sei minuti
 * che aspetta te»), che è vero ma non è quello che serve: un numero che scorre
 * dice «sta succedendo qualcosa», e mentre la domanda è a schermo non sta
 * succedendo niente — la palla è dell'umano, e vedere i secondi correre mentre
 * si legge una domanda mette fretta senza informare. Quindi durante l'attesa il
 * numero mostrato è il LAVORO, che per costruzione non cresce (ogni millisecondo
 * nuovo è attesa, e l'attesa si sottrae): resta lì fermo finché non si risponde.
 * Da quanto aspetta, e il totale grezzo, restano nel `title` per chi li cerca.
 *
 * Modulo puro: prende millisecondi, restituisce millisecondi e una frase. Chi lo
 * chiama tiene i cronometri (`MessageParts.tsx`).
 */
import { formatDurationMs } from '../components/Chat/toolGrouping';

export interface TurnClockInput {
  /** Distanza dall'inizio del turno: il totale grezzo, attese comprese. */
  elapsedMs: number;
  /** Attese già CHIUSE in questo turno, sommate. */
  waitedMs: number;
  /** L'attesa aperta adesso, o null se il turno sta lavorando. */
  waitingMs: number | null;
}

export interface TurnClockView {
  /** Il numero da mostrare nella striscia. */
  primaryMs: number;
  /** Tempo di lavoro vero: totale meno tutte le attese. */
  workedMs: number;
  /** Tutte le attese, quelle chiuse più quella aperta. */
  totalWaitedMs: number;
  /** La spiegazione del numero mostrato, o undefined se non c'è niente da spiegare. */
  title?: string;
}

/**
 * Il cronometro di un turno VIVO si scrive a secondi interi.
 *
 * `formatDurationMs` (quello dei tool) sotto i dieci secondi stampa un
 * decimale, ed è giusto lì: fra un'azione da 0,8s e una da 1,2s la differenza
 * è l'informazione. Su un turno in corso è il contrario — quel decimale si
 * aggiorna una volta al secondo come tutto il resto, quindi non misura niente
 * (il valore che mostra dipende solo da quando è partito il battito) e cambia
 * la cifra più a destra a scatti: il numero SEMBRA rotto, e chi lo guarda dice
 * che «non scorre».
 *
 * A secondi interi scorre visibilmente e non promette una precisione che non
 * ha. Il tempo FINALE del turno resta quello di `formatDurationMs`: lì il
 * decimale è una misura vera, non un residuo del battito.
 */
export function formatTurnElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalS = Math.floor(ms / 1000);
  if (totalS < 60) return `${totalS}s`;
  const totalM = Math.floor(totalS / 60);
  if (totalM < 60) return `${totalM}m ${String(totalS % 60).padStart(2, '0')}s`;
  const h = Math.floor(totalM / 60);
  return `${h}h ${String(totalM % 60).padStart(2, '0')}m`;
}

export function turnClock({ elapsedMs, waitedMs, waitingMs }: TurnClockInput): TurnClockView {
  const total = Math.max(0, elapsedMs);
  const open = waitingMs != null ? Math.max(0, waitingMs) : null;
  // Le attese non possono superare il turno che le contiene: se i due orologi
  // partono con qualche millisecondo di sfasatura (l'attesa si apre a un tick
  // diverso da quello del turno) il lavoro non deve diventare negativo.
  const totalWaitedMs = Math.min(total, Math.max(0, waitedMs) + (open ?? 0));
  const workedMs = total - totalWaitedMs;

  if (open != null) {
    // `workedMs` e non `open`: entrambi gli orologi si leggono dallo STESSO
    // istante, quindi il lavoro qui è una costante (`inizio attesa - inizio
    // turno - attese precedenti`) e il numero a schermo sta fermo. È la
    // proprietà che si sta cercando, non un effetto collaterale.
    return {
      primaryMs: workedMs,
      workedMs,
      totalWaitedMs,
      title: `Ferma da ${formatDurationMs(open)} in attesa di te. Lavorato ${formatDurationMs(workedMs)}, turno aperto da ${formatDurationMs(total)}`,
    };
  }
  if (totalWaitedMs > 0) {
    return {
      primaryMs: workedMs,
      workedMs,
      totalWaitedMs,
      // Il totale non sparisce: sparisce dal numero grande, resta a portata di
      // puntatore. Chi cerca «quando l'ho mandato» lo trova ancora.
      title: `Lavorato ${formatDurationMs(workedMs)} · turno aperto da ${formatDurationMs(total)}, di cui ${formatDurationMs(totalWaitedMs)} in attesa di te`,
    };
  }
  // Nessuna attesa: il turno è quello che è sempre stato, e non serve spiegare
  // un numero che non ha sorprese dentro.
  return { primaryMs: total, workedMs, totalWaitedMs: 0 };
}
