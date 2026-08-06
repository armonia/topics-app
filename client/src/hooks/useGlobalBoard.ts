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
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WSMessage } from '../types';
import { boardApi, TASK_STATUSES, type BoardTask, type TaskStatus } from '../lib/board';

export interface GlobalBoard {
  /** Task non ancora `done`, su tutti i progetti. */
  activeCount: number;
  /** Le righe per colonna kanban, ordinate come le mostra la board. */
  byStatus: Record<TaskStatus, BoardTask[]>;
}

const EMPTY_BY_STATUS = (): Record<TaskStatus, BoardTask[]> =>
  Object.fromEntries(TASK_STATUSES.map(s => [s, [] as BoardTask[]])) as Record<TaskStatus, BoardTask[]>;

export function useGlobalBoard(
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
): GlobalBoard {
  const [tasks, setTasks] = useState<BoardTask[]>([]);

  const refresh = useCallback(async () => {
    try {
      setTasks(await boardApi.listAll());
    } catch {
      /* leave the last known list on a transient failure */
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg) => {
      const t = (msg as { type?: string })?.type;
      if (t === 'task:created' || t === 'task:updated' || t === 'task:deleted') refresh();
    });
  }, [onMessage, refresh]);

  return useMemo(() => {
    const byStatus = EMPTY_BY_STATUS();
    let activeCount = 0;
    for (const task of tasks) {
      (byStatus[task.status] ??= []).push(task);
      if (task.status !== 'done') activeCount++;
    }
    // `kanbanOrder` è l'ordine che l'umano ha dato alla colonna: la fascia deve
    // leggersi come la colonna, non come l'ordine in cui il server ha risposto.
    for (const status of TASK_STATUSES) byStatus[status].sort((a, b) => a.kanbanOrder - b.kanbanOrder);
    return { activeCount, byStatus };
  }, [tasks]);
}
