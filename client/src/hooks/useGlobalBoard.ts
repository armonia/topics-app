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
 * board to arrive at ONE state. Refetches now go through `createCoalescedReader`,
 * which lets the first one leave immediately, folds the rest of the burst into a
 * single follow-up, and drops the answer of a run that has been superseded
 * (client/src/lib/burstCoalescer.ts).
 *
 * The other readers do not fetch: they take the rows from `boardTasksStore` and,
 * when they need a fresh one, ask through `requestBoardTasksRefresh`, which
 * lands in the coalescer above. See `useBoardFeed` for the numbers of the day
 * three of them were reading the same feed on their own.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { WSMessage } from '../types';
import { boardApi, type BoardTask, type TaskStatus } from '../lib/board';
import { groupByStatus } from '../lib/boardOrder';
import {
  applyBoardTaskFrame, markBoardTasksSettled, setBoardTasks, setBoardTasksRefresher, useBoardTasks,
} from '../lib/boardTasksStore';
import { createCoalescedReader, type Coalescer } from '../lib/burstCoalescer';
import { BOOT_READ_TTL_MS } from '../lib/coalesceFetch';
import { subscribeLifecycle, subscribeReconnect } from '../lib/wsFrameBus';

/**
 * How long the window is in which events fold into one. 400 ms: above the read
 * itself (175 ms), so two runs do not overlap in the normal case, and below the
 * point where a remote update starts reading as "the screen fell behind". The
 * first event of a burst does not wait either way.
 */
const COALESCE_WINDOW_MS = 400;

/**
 * How long a store fed only by frames may go without a full read.
 *
 * A frame the store absorbs costs no read, and that is most of the traffic:
 * measured on the live log, 1194 reads of the feed in 95 minutes for 152 HTTP
 * writes, because the dispatcher re-emits a row every few seconds while an
 * agent works. But the feed is more than the rows it carries one by one:
 * `queueReason` - why a card is waiting - is computed over the whole batch, so
 * a SIBLING card can keep giving a reason that stopped being true, with no
 * frame of its own coming to correct it. One read a minute, and only while
 * frames are arriving, is what keeps that honest.
 */
const FULL_READ_INTERVAL_MS = 60_000;

export interface GlobalBoard {
  /** Tasks not yet `done`, across every project. */
  activeCount: number;
  /** The rows per kanban column, ordered the way the board shows them. */
  byStatus: Record<TaskStatus, BoardTask[]>;
}

/** A window nobody is looking at. `document.hidden` and not the focus test of
 *  `isWindowAwake`: an app merely BEHIND another still shows its board on
 *  screen, and a board that stopped updating while you can read it is a lie. */
function windowHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

export function useGlobalBoard(
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
): GlobalBoard {
  const tasks = useBoardTasks();
  // A refresh that came due while the window was hidden. It is remembered, not
  // dropped: the moment somebody looks again, ONE read brings back whatever the
  // agents did in the meantime.
  const missedWhileHidden = useRef(false);
  // A CHANGE WAS ANNOUNCED since the last read (a `task:*` frame, a reconnect,
  // a reader asking): the next read has to reach the server. Only the reads of
  // the BOOT — the mount read and the first socket-open re-read, a few hundred
  // ms apart — may share the app-wide coalescer's window (BOOT_READ_TTL_MS):
  // they ask the same question. A read that answers an event does not: it
  // asks "what is the state AFTER this event", and with the TTL on every read
  // the tail read of a burst got the pre-burst snapshot handed back, with no
  // later event to correct it (BOARD-19, 2026-09-06).
  const changeNoticed = useRef(false);
  // When the last full read of the feed left. Absorbed frames do not reset it:
  // it is what makes the safety read above RARE and not per-frame.
  const lastFullRead = useRef(0);

  // One coalescer per mount: `useRef` and not `useMemo`, because React is free
  // to discard a `useMemo` value whenever it likes and this one owns a timer
  // that has to be cleared on unmount. It is recreated on demand because unmount
  // nulls it out, and under StrictMode mount and unmount alternate.
  const coalescer = useRef<Coalescer | null>(null);
  const ensure = useCallback(() => {
    if (coalescer.current === null) {
      // The reader carries the order guard with it: two overlapping reads can
      // come back in the wrong order and the last writer wins, which would
      // leave the store behind with no later event to correct it.
      coalescer.current = createCoalescedReader<readonly BoardTask[] | null>({
        windowMs: COALESCE_WINDOW_MS,
        load: async () => {
          // `null` = la lettura è tornata a mani vuote. Non è la stessa cosa di
          // una lista vuota: chi disegna una board deve poter smettere di
          // aspettare senza inventarsi che di task non ce ne sono.
          //
          // The notice is consumed HERE and not where it is raised: a trigger
          // that lands inside the coalescer's window becomes the tail read,
          // and it is that read — the last one, later than the last event —
          // that must not be served from the window.
          const noticed = changeNoticed.current;
          changeNoticed.current = false;
          lastFullRead.current = Date.now();
          try {
            return await boardApi.listAll(undefined, noticed ? undefined : { ttlMs: BOOT_READ_TTL_MS });
          } catch { return null; }
        },
        apply: (rows) => { if (rows === null) markBoardTasksSettled(); else setBoardTasks(rows); },
      });
    }
    return coalescer.current;
  }, []);

  useEffect(() => {
    // The first read of the global feed.
    ensure().trigger();
    // Readers of the store ask for a re-read through here instead of opening a
    // second fetch of the same 1.4 MB feed. A reader that asks was told
    // something changed (the board pane's own `task:*` handler runs BEFORE
    // this hook's, App's effects being the last to run): its read is fresh.
    const unregister = setBoardTasksRefresher(() => { changeNoticed.current = true; ensure().trigger(); });
    return () => {
      unregister();
      coalescer.current?.dispose();
      coalescer.current = null;
    };
  }, [ensure]);

  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg) => {
      const m = msg as { type?: string; task?: BoardTask };
      const t = m?.type;
      if (t !== 'task:created' && t !== 'task:updated' && t !== 'task:deleted') return;
      // Raised BEFORE the hidden gate: the one read a hidden window owes when
      // it is looked at again answers these events too.
      changeNoticed.current = true;
      // AN INVISIBLE WINDOW STILL PAID FOR EVERY MOVE. The board moves because
      // agents move it: a night of eight cards is hundreds of `task:*` frames,
      // and each one had every open window re-read the global feed - a
      // synchronous SQLite read plus over a megabyte of JSON - to repaint
      // pixels nobody was looking at. With bun:sqlite on Bun's single event
      // loop that read is streaming, WS, PTY and browser panes standing still.
      if (windowHidden()) { missedWhileHidden.current = true; return; }
      // ONE READ PER EVENT IS NOT ONE READ, AND MOST EVENTS CARRY THEIR ANSWER.
      // `task:updated` ships the whole row, built by the same code as the feed:
      // when it lands on a row already in the store that has not changed column
      // nor parent, writing it in IS the update, and the 73 KB re-read behind it
      // would only confirm it. What the frame cannot say is what happened to the
      // OTHER rows, so the read still leaves on everything else and, rarely, on
      // a timer (see FULL_READ_INTERVAL_MS).
      if (t === 'task:updated' && applyBoardTaskFrame(m.task)
        && Date.now() - lastFullRead.current < FULL_READ_INTERVAL_MS) return;
      ensure().trigger();
    });
  }, [onMessage, ensure]);

  // Back in view: pay the ONE read that was owed, whatever the burst was.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      if (windowHidden() || !missedWhileHidden.current) return;
      missedWhileHidden.current = false;
      ensure().trigger();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [ensure]);

  // A RECONNECT IS A HOLE, NOT A PAUSE. Every `task:*` broadcast sent while the
  // socket was down (a server reload takes seconds and the agents keep moving
  // cards) was delivered to a socket that no longer exists: nothing replays it,
  // so without this the store keeps the pre-reload state until something else
  // happens to move. Same subscription as `state/pane/middleware/syncWS.ts` and
  // `useTerminalLifecycle`. With the coalescer it costs one read per reconnect.
  //
  // The FIRST open of the page is not a reconnect: nothing was missed, and its
  // re-read is the boot's second ask of the same question, which the app-wide
  // window answers (BOOT-NET-01). A RE-open is the hole, and its read must
  // reach the server. The reconnect marker is subscribed first so that it runs
  // before the trigger below on the same `open` (the bus keeps handlers in
  // subscription order).
  useEffect(() => {
    const stopReconnectListener = subscribeReconnect(() => { changeNoticed.current = true; });
    const stopOpenListener = subscribeLifecycle((event) => {
      if (event !== 'open') return;
      // Same gate, same debt: a hidden window records the hole and fills it when
      // it is looked at again.
      if (windowHidden()) { missedWhileHidden.current = true; return; }
      ensure().trigger();
    });
    return () => { stopReconnectListener(); stopOpenListener(); };
  }, [ensure]);

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
