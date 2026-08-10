/**
 * useGlobalBoard — la board di TUTTI i progetti, dal vivo: quanti task attivi
 * ci sono e quali, divisi per stato.
 *
 * Sorgente unica: il feed globale (`boardApi.listAll`) una volta al mount, poi
 * a ogni evento `task:*` sul WebSocket. "Attivo" = non ancora `done` (gli
 * archiviati li esclude già il server). Il conteggio fa anche da gate di
 * visibilità: la riga «Board generale» compare solo quando è > 0.
 *
 * Prima questo hook faceva `.filter(...).length` e BUTTAVA le righe appena
 * lette — poi la fascia della tessera fissata avrebbe dovuto richiedere al
 * server esattamente le stesse righe per mostrarle. Una fetch, due consumatori.
 *
 * Oggi i consumatori sono di più — le tab «Board» riassumono gli stessi stati —
 * e non stanno tutti sotto questo hook: le righe finiscono in
 * `boardTasksStore`, che è il posto da cui LEGGONO gli altri. La fetch e il
 * WebSocket restano qui, cioè uno solo (vedi la nota in `boardTasksStore.ts`).
 */
import { useCallback, useEffect, useMemo } from 'react';
import type { WSMessage } from '../types';
import { boardApi, type BoardTask, type TaskStatus } from '../lib/board';
import { groupByStatus } from '../lib/boardOrder';
import { setBoardTasks, useBoardTasks } from '../lib/boardTasksStore';

export interface GlobalBoard {
  /** Task non ancora `done`, su tutti i progetti. */
  activeCount: number;
  /** Le righe per colonna kanban, ordinate come le mostra la board. */
  byStatus: Record<TaskStatus, BoardTask[]>;
}

export function useGlobalBoard(
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
): GlobalBoard {
  const tasks = useBoardTasks();

  const refresh = useCallback(async () => {
    try {
      setBoardTasks(await boardApi.listAll());
    } catch {
      /* leave the last known list on a transient failure */
    }
  }, []);

  // La prima lettura del feed globale.
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg) => {
      const t = (msg as { type?: string })?.type;
      if (t === 'task:created' || t === 'task:updated' || t === 'task:deleted') refresh();
    });
  }, [onMessage, refresh]);

  return useMemo(() => {
    let activeCount = 0;
    for (const task of tasks) if (task.status !== 'done') activeCount++;
    // Stesso ordinamento della board vera, così la fascia non racconta un ordine
    // diverso da quello che si vede aprendola. Scope `cross-project`: qui i task
    // vengono da board diverse e `kanbanOrder` non si confronta fra sequenze
    // indipendenti (vedi `lib/boardOrder`).
    return { activeCount, byStatus: groupByStatus(tasks, 'cross-project') };
  }, [tasks]);
}
