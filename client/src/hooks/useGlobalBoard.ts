/**
 * useGlobalBoard: the board of EVERY project, live. How many active tasks there
 * are and which ones, split by status.
 *
 * Single source: the global feed (`boardApi.listAll`) once on mount, then on
 * every `task:*` event over the WebSocket. "Active" means not yet `done` (the
 * server already excludes the archived ones). The count doubles as a visibility
 * gate: the "general board" row only appears while it is above zero.
 *
 * This hook used to do `.filter(...).length` and THROW AWAY the rows it had just
 * read, which meant the pinned tile's strip would have had to ask the server for
 * exactly those same rows to show them. One fetch, two consumers.
 *
 * Today there are more consumers (the "Board" tabs summarise the same statuses)
 * and they do not all live under this hook: the rows land in `boardTasksStore`,
 * which is where everyone else READS them from. The fetch and the WebSocket stay
 * here, so there is exactly one of each (see the note in `boardTasksStore.ts`).
 *
 * One fetch per EVENT, though, is not one fetch: the events arrive in bursts,
 * because it is agents that move the cards. The feed weighs 1.44 MB and costs
 * the server 175 ms (measured 2026-08-14), and the busiest minute of the last
 * three days holds 24 task updates: 34.6 MB downloaded and 24 repaints of the
 * board to arrive at ONE state. Refetches now go through `createBurstCoalescer`,
 * which lets the first one leave immediately and folds the rest of the burst
 * into a single follow-up (client/src/lib/burstCoalescer.ts).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { WSMessage } from '../types';
import { boardApi, type BoardTask, type TaskStatus } from '../lib/board';
import { groupByStatus } from '../lib/boardOrder';
import { setBoardTasks, useBoardTasks } from '../lib/boardTasksStore';
import { createBurstCoalescer, latestWins } from '../lib/burstCoalescer';

/**
 * How long the window is in which events fold into one. 400 ms: above the read
 * itself (175 ms), so two runs do not overlap in the normal case, and below the
 * point where a remote update starts reading as "the screen fell behind". The
 * first event of a burst does not wait either way.
 */
const COALESCE_WINDOW_MS = 400;

export interface GlobalBoard {
  /** Tasks not yet `done`, across every project. */
  activeCount: number;
  /** The rows per kanban column, ordered the way the board shows them. */
  byStatus: Record<TaskStatus, BoardTask[]>;
}

export function useGlobalBoard(
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
): GlobalBoard {
  const tasks = useBoardTasks();

  // One coalescer per mount: `useRef` and not `useMemo`, because React is free
  // to discard a `useMemo` value whenever it likes and this one owns a timer
  // that has to be cleared on unmount. It is recreated on demand because unmount
  // nulls it out, and under StrictMode mount and unmount alternate.
  const coalescer = useRef<ReturnType<typeof createBurstCoalescer> | null>(null);
  const ensure = useCallback(() => {
    if (coalescer.current === null) {
      // `latestWins`: two overlapping reads can come back in the wrong order and
      // the last writer wins, which would leave the store behind with no later
      // event to correct it.
      const write = latestWins<readonly BoardTask[]>(setBoardTasks);
      coalescer.current = createBurstCoalescer({
        windowMs: COALESCE_WINDOW_MS,
        run: () => write(() => boardApi.listAll()),
      });
    }
    return coalescer.current;
  }, []);

  useEffect(() => {
    // The first read of the global feed.
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
