/**
 * boardTabCounts — quanti task ci sono, per stato, dietro una tab «Board».
 *
 * L'aritmetica sta QUI, fuori dal disegno, per la stessa ragione per cui ci sta
 * quella della riga di sidebar: è la parte che si può verificare senza montare
 * niente, e le due superfici che la usano — la riga «Board» in sidebar e la tab
 * — devono contare allo STESSO modo o la stessa board dice due numeri diversi
 * in due punti dello schermo.
 */
import type { BoardTask, TaskStatus } from './board';
import { awaitsHuman } from '../../../shared/workflow';

/**
 * Gli stati che una tab riassume: chi aspetta te, e chi sta lavorando.
 *
 * DUE, non cinque, ed è la stessa scelta già fatta per la riga di sidebar
 * (`SUMMARY_STATUSES` viveva là, ora vive qui perché ora ha due lettori): «i
 * primi devono essere quelli che cambiano una decisione». `backlog` e `todo`
 * sono una coda — saperne il numero non fa fare niente di diverso — e `done` è
 * lavoro chiuso: la board si annuncia per il lavoro APERTO.
 *
 * L'ordine è anche quello in cui si rinuncia quando lo spazio finisce: si perde
 * «in corso», mai «review».
 */
export const SUMMARY_STATUSES: readonly TaskStatus[] = ['review', 'in_progress'];

export interface StatusCount {
  status: TaskStatus;
  n: number;
}

/**
 * I conteggi da mostrare, nell'ordine di `SUMMARY_STATUSES` e SENZA gli zeri.
 *
 * Uno zero non è un'informazione che vale un glifo: «review 0» accanto a «in
 * corso 3» si legge come una colonna vuota da guardare, e su una tab larga
 * 150px occupa il posto del numero che invece conta. Chi non ha lavoro aperto
 * semplicemente non compare — e una board senza niente aperto non mostra nulla,
 * cioè torna esattamente com'era prima.
 *
 * `projectId` restringe il conto alla board di UN progetto (la tab `kanban`);
 * omesso, conta tutto (la tab `board`, che è la board generale).
 */
export function boardTabCounts(
  tasks: readonly BoardTask[] | null | undefined,
  projectId?: string | null,
): StatusCount[] {
  const out: StatusCount[] = [];
  for (const status of SUMMARY_STATUSES) {
    let n = 0;
    for (const t of tasks ?? []) {
      if (projectId && t.projectId !== projectId) continue;
      if (status === 'review') n += reviewWaitingOf(t);
      else if (t.status === status) n++;
    }
    if (n > 0) out.push({ status, n });
  }
  return out;
}

/**
 * What one feed card adds to «review»: itself when it waits on a person
 * (`awaitsHuman`, AI review left out), plus its steps that do
 * (`subtaskReviewCount`, from the server). The feed holds roots only, and a
 * step in review under a parent in backlog was in the Plan's count and in no
 * column's: the Kanban said 3 where the Plan said 8.
 */
export function reviewWaitingOf(t: Pick<BoardTask, 'status' | 'stage' | 'subtaskReviewCount'>): number {
  return (awaitsHuman(t) ? 1 : 0) + (t.subtaskReviewCount ?? 0);
}

/**
 * The Board row's counts in the sidebar: the lit cards of every board (ATTN-16:
 * review, parked, a wait mid-turn, from the attention state) on the review
 * glyph, which is the slot that says «waits for you», and the cards in progress
 * as they are. Same order and same rule on the zeros as `boardTabCounts`.
 */
export function boardRowCounts(
  byStatus: Partial<Record<TaskStatus, readonly BoardTask[]>> | undefined,
  lit: number,
): StatusCount[] {
  return SUMMARY_STATUSES
    .map((status) => ({ status, n: status === 'review' ? lit : byStatus?.[status]?.length ?? 0 }))
    .filter((c) => c.n > 0);
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
