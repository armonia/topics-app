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
 *
 * Una fetch sola per EVENTO, però, non è una fetch sola: gli eventi arrivano a
 * raffica perché sono gli agenti a muovere le card. Il feed pesa 1,44 MB e costa
 * 175 ms al server (misurato il 2026-08-14), e il minuto più affollato degli
 * ultimi tre giorni conta 24 aggiornamenti: 34,6 MB e 24 ridisegni della board
 * per arrivare a UNO stato. Le riletture passano da `createBurstCoalescer`, che
 * lascia partire subito la prima e fonde il resto della raffica in una sola
 * (client/src/lib/burstCoalescer.ts).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { WSMessage } from '../types';
import { boardApi, type BoardTask, type TaskStatus } from '../lib/board';
import { groupByStatus } from '../lib/boardOrder';
import { setBoardTasks, useBoardTasks } from '../lib/boardTasksStore';
import { createBurstCoalescer, latestWins } from '../lib/burstCoalescer';

/**
 * Quanto dura la finestra in cui gli eventi si fondono. 400 ms: sopra il tempo
 * della lettura stessa (175 ms), così due corse non si sovrappongono nel caso
 * normale, e sotto la soglia in cui un aggiornamento remoto si legge come «lo
 * schermo è rimasto indietro». Il primo evento non aspetta comunque.
 */
const FINESTRA_MS = 400;

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

  // Un solo coalescer per montaggio: `useRef` e non `useMemo`, perché React può
  // buttare via il valore di un `useMemo` quando vuole, e qui dentro c'è un
  // timer da spegnere allo smontaggio. Si ricrea su richiesta perché lo
  // smontaggio lo azzera, e in StrictMode montaggio e smontaggio si alternano.
  const coalescer = useRef<ReturnType<typeof createBurstCoalescer> | null>(null);
  const ensure = useCallback(() => {
    if (coalescer.current === null) {
      // `latestWins`: due letture sovrapposte possono tornare invertite, e chi
      // scrive per ultimo vince — lo store resterebbe indietro senza nessun
      // evento successivo che lo corregga.
      const scrivi = latestWins<readonly BoardTask[]>(setBoardTasks);
      coalescer.current = createBurstCoalescer({
        windowMs: FINESTRA_MS,
        run: () => scrivi(() => boardApi.listAll()),
      });
    }
    return coalescer.current;
  }, []);

  useEffect(() => {
    // La prima lettura del feed globale.
    ensure().trigger();
    return () => { coalescer.current?.dispose(); coalescer.current = null; };
  }, [ensure]);

  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg) => {
      const t = (msg as { type?: string })?.type;
      if (t === 'task:created' || t === 'task:updated' || t === 'task:deleted') ensure().trigger();
    });
  }, [onMessage, ensure]);

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
