/**
 * justDone.ts — quali card hanno appena ATTRAVERSATO il confine verso Done.
 *
 * Chiudere un task non lasciava nessun segno: la card spariva dalla colonna in
 * cui stavi guardando e riappariva in Done, che di norma è fuori dal campo
 * visivo. Con l'approvazione dal drawer era peggio ancora — il drawer si
 * chiude e non succede niente di visibile da nessuna parte.
 *
 * La regola è la TRANSIZIONE, non la freschezza di una data. «`completedAt` è
 * di meno di tre secondi fa» sembra equivalente e non lo è: a ogni ricarica
 * della pagina, e a ogni cambio di filtro o di board, rilampeggerebbe tutto
 * quello che è stato chiuso poco prima — un lampo che non risponde a niente che
 * hai appena fatto. Qui si confronta lo stato precedente di OGNI card: lampeggia
 * solo chi era in una colonna diversa un istante fa. Una card mai vista prima
 * (primo caricamento, cambio di board, filtro che la fa rientrare) non ha uno
 * stato precedente, quindi non lampeggia.
 */

import type { TaskStatus } from './board';

/** Quanto dura il lampo. Uguale al keyframe `taskDoneFlash` in index.css. */
export const DONE_FLASH_MS = 2400;

export interface StatusSnapshot {
  id: string;
  status: TaskStatus;
}

/**
 * Gli id che sono passati a `done` fra i due giri.
 *
 * `before === null` = non c'è un giro precedente (primo caricamento): nessuna
 * transizione, la lista non è "arrivata", c'era già.
 */
export function landedInDone(
  before: ReadonlyMap<string, TaskStatus> | null,
  now: readonly StatusSnapshot[],
): string[] {
  if (!before) return [];
  const landed: string[] = [];
  for (const t of now) {
    if (t.status !== 'done') continue;
    const was = before.get(t.id);
    if (was !== undefined && was !== 'done') landed.push(t.id);
  }
  return landed;
}

/** L'istantanea da confrontare al giro dopo. */
export function statusSnapshot(tasks: readonly StatusSnapshot[]): Map<string, TaskStatus> {
  return new Map(tasks.map((t) => [t.id, t.status]));
}
