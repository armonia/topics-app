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
import { boardApi, type BoardTask, type TaskStatus } from '../lib/board';
import { groupByStatus } from '../lib/boardOrder';

export interface GlobalBoard {
  /** Task non ancora `done`, su tutti i progetti. */
  activeCount: number;
  /** Le righe per colonna kanban, ordinate come le mostra la board. */
  byStatus: Record<TaskStatus, BoardTask[]>;
}

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

  // La prima lettura del feed globale: `refresh` è async e scrive lo stato solo
  // DOPO l'await, quindi non c'è nessun setState sincrono da cui nasca la
  // cascata di render che la regola previene. La regola non vede oltre l'await
  // e segnala la chiamata in sé. (Prima non compariva perché il compilatore
  // React si arrendeva su questo componente e la regola non lo analizzava
  // affatto: semplificare `byStatus` l'ha reso analizzabile, non l'ha rotto.)
  // eslint-disable-next-line react-hooks/set-state-in-effect
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
