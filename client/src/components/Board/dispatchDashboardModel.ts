/**
 * I conti puri del cruscotto (coda, età, tetto dell'asse), fuori dal file dei
 * componenti perché il fast refresh vuole lì solo componenti.
 */
import type { BoardTask } from '../../lib/board';
import { WAITING_MEMORY_REASON } from '../../../../shared/board';
import { queueReasonText } from '../../../../shared/queue-reason-text';

/** Una card in coda, come la riga la disegna. */
export interface QueuedCard {
  id: string;
  title: string;
  /** Il progetto della card, per nome; `null` = non si sa. */
  project: string | null;
  /** Millisecondi da quando aspetta (dall'ultimo aggiornamento). */
  waitingMs: number;
  /** Frase neutra decisa dal server, già tradotta; `null` = il server non ne ha. */
  reason: string | null;
  /** Aspetta solo memoria libera: è la sola attesa che «Avvia comunque» può saltare. */
  memoryWaiter: boolean;
  /** Il server la dà per incagliata (tono `stalled`): non parte da sola. */
  stalled: boolean;
  projectId: string;
}

/** Le card che aspettano un posto, nell'ordine in cui il dispatcher le serve. */
export function queuedCards(
  tasks: readonly BoardTask[],
  tr: (k: string, p?: Record<string, string | number>) => string,
  now: number,
  projectName: (t: BoardTask) => string | null = () => null,
): QueuedCard[] {
  return tasks
    .filter((t) => !t.parentTaskId && (t.dispatchState === 'queued' || t.dispatchState === 'waiting'))
    // La disciplina di coda del dispatcher (task-dispatcher, il tick): prima la
    // priorità, poi la più vecchia. È l'ordine in cui partiranno, e la «1ª» è
    // quella a cui va «Avvia comunque».
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))
    .map((t) => {
      const text = t.queueReason ? queueReasonText(t.queueReason, tr) : null;
      return {
        id: t.id,
        title: t.text,
        project: projectName(t),
        waitingMs: Math.max(0, now - Date.parse(t.updatedAt)),
        reason: text ? `${text.head} · ${text.detail}` : null,
        // Lo stesso test del server (`isMemoryWaiter`): fuori da qui risponde 409.
        memoryWaiter: t.status === 'todo' && t.dispatchState === 'queued' && t.dispatchError === WAITING_MEMORY_REASON,
        stalled: t.queueReason?.tone === 'stalled',
        projectId: t.projectId,
      };
    });
}

/** «19 min» / «2 h 5 min»: quanto aspetta, mai un timestamp. */
export function waitingLabel(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Il tetto dell'asse: almeno 6 GB, poi il pari sopra il massimo, così un Mac largo non schiaccia la curva in alto. */
export function chartMax(values: readonly number[], startGB: number | null): number {
  const top = Math.max(6, startGB ?? 0, ...values);
  return top <= 6 ? 6 : Math.ceil(top / 3) * 3;
}
