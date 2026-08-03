/**
 * Due tempi, non uno: quanto ha LAVORATO l'agente e quanto ha aspettato NOI.
 *
 * Il cronometro del turno misurava la distanza dall'inizio, e basta. Con una
 * domanda a schermo quel numero cresce durante il pranzo di chi doveva
 * rispondere, e poi resta lì come se l'agente ci avesse messo mezz'ora a fare
 * una cosa da otto secondi. È il numero che l'umano ha visto scorrere e ha
 * chiamato brutto: non era brutto, era falso.
 *
 * Qui si separano. Mentre la domanda è aperta il cronometro conta L'ATTESA — è
 * quello il dato utile in quel momento, «è da sei minuti che aspetta te». Quando
 * il turno riparte torna a contare il lavoro, con le attese sottratte, e il
 * totale grezzo resta nel `title` per chi lo cerca.
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

export function turnClock({ elapsedMs, waitedMs, waitingMs }: TurnClockInput): TurnClockView {
  const total = Math.max(0, elapsedMs);
  const open = waitingMs != null ? Math.max(0, waitingMs) : null;
  // Le attese non possono superare il turno che le contiene: se i due orologi
  // partono con qualche millisecondo di sfasatura (l'attesa si apre a un tick
  // diverso da quello del turno) il lavoro non deve diventare negativo.
  const totalWaitedMs = Math.min(total, Math.max(0, waitedMs) + (open ?? 0));
  const workedMs = total - totalWaitedMs;

  if (open != null) {
    return {
      primaryMs: open,
      workedMs,
      totalWaitedMs,
      title: `Ferma da ${formatDurationMs(open)} in attesa di te — turno aperto da ${formatDurationMs(total)}, lavorato ${formatDurationMs(workedMs)}`,
    };
  }
  if (totalWaitedMs > 0) {
    return {
      primaryMs: workedMs,
      workedMs,
      totalWaitedMs,
      // Il totale non sparisce: sparisce dal numero grande, resta a portata di
      // puntatore. Chi cerca «quando l'ho mandato» lo trova ancora.
      title: `Lavorato ${formatDurationMs(workedMs)} — turno aperto da ${formatDurationMs(total)}, di cui ${formatDurationMs(totalWaitedMs)} in attesa di te`,
    };
  }
  // Nessuna attesa: il turno è quello che è sempre stato, e non serve spiegare
  // un numero che non ha sorprese dentro.
  return { primaryMs: total, workedMs, totalWaitedMs: 0 };
}
