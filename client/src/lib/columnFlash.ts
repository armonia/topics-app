/**
 * columnFlash.ts — quali card hanno appena CAMBIATO colonna, e in quale sono
 * arrivate.
 *
 * Muovere un task non lasciava nessun segno: la card spariva dalla colonna in
 * cui stavi guardando e riappariva altrove, spesso fuori dal campo visivo. Con
 * l'approvazione dal drawer era peggio ancora — il drawer si chiude e non
 * succede niente di visibile da nessuna parte.
 *
 * Prima questo modulo guardava solo l'ultimo confine, quello verso Done
 * (`landedInDone`), e ogni altro passaggio era muto: una card mandata in
 * review, una ripresa dal backlog, una fermata e riparcheggiata si spostavano
 * in silenzio. La regola non cambia, cambia il confine: OGNI colonna. Il
 * chiamante ha bisogno anche di SAPERE dove è arrivata, perché il lampo prende
 * il colore di quella colonna, quindi qui torna una mappa e non una lista.
 *
 * La regola è la TRANSIZIONE, non la freschezza di una data. «`completedAt` è
 * di meno di tre secondi fa» sembra equivalente e non lo è: a ogni ricarica
 * della pagina, e a ogni cambio di filtro o di board, rilampeggerebbe tutto
 * quello che è stato mosso poco prima — un lampo che non risponde a niente che
 * hai appena fatto. Qui si confronta lo stato precedente di OGNI card: lampeggia
 * solo chi era in una colonna diversa un istante fa. Una card mai vista prima
 * (primo caricamento, cambio di board, filtro che la fa rientrare) non ha uno
 * stato precedente, quindi non lampeggia.
 */

import type { TaskStatus } from './board';

/** Quanto dura il lampo. Uguale al keyframe `taskFlash` in index.css. */
export const COLUMN_FLASH_MS = 2400;

export interface StatusSnapshot {
  id: string;
  status: TaskStatus;
}

/**
 * Chi ha cambiato colonna fra i due giri, e dove è arrivato.
 *
 * `before === null` = non c'è un giro precedente (primo caricamento): nessuna
 * transizione, la lista non è "arrivata", c'era già.
 */
export function landedInColumn(
  before: ReadonlyMap<string, TaskStatus> | null,
  now: readonly StatusSnapshot[],
): Map<string, TaskStatus> {
  const landed = new Map<string, TaskStatus>();
  if (!before) return landed;
  for (const t of now) {
    const was = before.get(t.id);
    if (was !== undefined && was !== t.status) landed.set(t.id, t.status);
  }
  return landed;
}

/** L'istantanea da confrontare al giro dopo. */
export function statusSnapshot(tasks: readonly StatusSnapshot[]): Map<string, TaskStatus> {
  return new Map(tasks.map((t) => [t.id, t.status]));
}
