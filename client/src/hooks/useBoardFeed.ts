/**
 * useBoardFeed — the rows a board pane shows: read once per burst, never out of
 * order, and still while a card is in the hand.
 *
 * ## Why the general board does not fetch
 *
 * `GET /api/all-boards/tasks` measured on this machine on 2026-08-15: 467 root
 * tasks, 1,435,735 bytes, 145 ms. The pane re-issued exactly that request on
 * every `task:*` event, uncoalesced and unguarded, while `useGlobalBoard` was
 * already reading the same feed into `boardTasksStore` with both protections.
 * Ten agent moves in a burst were therefore ~14 MB and ten repaints to reach
 * ONE state, plus the real hazard: two overlapping reads coming back inverted
 * left the older snapshot on screen, and no later event exists to correct it.
 *
 * So in `all` mode there is no fetch here at all — the rows come from the
 * store, and `refetch()` asks its owner for a re-read (which is coalesced, so
 * a burst of askers still costs one read).
 *
 * The project / archive query stays local: nobody else wants those rows. It
 * goes through the same `createCoalescedReader`, which is the whole reason this
 * hook exists as a hook: the guard is not something the next reader can forget.
 *
 * ## The drag freeze
 *
 * Replacing the rows mid-drag re-renders the columns under the pointer and the
 * gesture stutters or drops the card. The pane used to defer its own refetch,
 * which stopped working the moment the rows arrived from a store somebody else
 * writes. So the freeze moved to the READ side: between `beginDrag` and
 * `endDrag` the caller keeps seeing the snapshot it started the gesture on,
 * whoever writes in the meantime.
 *
 * IL RILASCIO DELLA LETTURA PARCHEGGIATA È UN TERZO GESTO, non la coda di
 * `endDrag`. Farla partire alla fine della gesture significava mandarla PRIMA
 * della PATCH del drop: la GET rispondeva con lo stato di partenza e la card
 * tornava nella colonna di prima per tutto un giro di rete — il drop sembrava
 * non aver preso. Chi scrive sa quando la scrittura è finita, quindi è lui a
 * chiamare `flushDeferredRead`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { boardApi, type BoardTask } from '../lib/board';
import { createCoalescedReader, type Coalescer } from '../lib/burstCoalescer';
import {
  hasLoadedBoardTasks, patchBoardTask, requestBoardTasksRefresh,
  useBoardTasks, useBoardTasksLoaded,
} from '../lib/boardTasksStore';
import { readBoardRowsCache, writeBoardRowsCache } from '../lib/boardRowsCache';
import { subscribeLifecycle } from '../lib/wsFrameBus';

/** Same window as the global feed's, and for the same reasons (useGlobalBoard). */
const COALESCE_WINDOW_MS = 400;

/** Quale domanda risponde una lettura: la board, e se è l'archivio o i vivi. */
const queryKey = (projectId: string, showArchived: boolean) => `${projectId}|${showArchived ? 'archived' : 'live'}`;

/** The outcome of a read, carried through the order guard so that a superseded
 *  FAILURE cannot post its error over a newer success either. It carries the
 *  query it answers, so an answer to the PREVIOUS board never counts as the
 *  answer to this one. */
type Outcome =
  | { key: string; ok: true; rows: readonly BoardTask[] }
  | { key: string; ok: false; message: string };

export interface BoardFeedOptions {
  /** 'all' = the cross-project feed (owned elsewhere) · 'project' = this board. */
  mode: 'project' | 'all';
  projectId: string;
  /** Project mode only: the archive is a different fetch, not a filter. */
  showArchived: boolean;
  /** The pane's error line: a message, or null when a read succeeds. */
  onError: (message: string | null) => void;
}

export interface BoardFeed {
  tasks: readonly BoardTask[];
  loading: boolean;
  /** Re-read now. Coalesced, latest-wins, deferred while a card is dragged. */
  refetch: () => void;
  /** Optimistic patch of one row, before the server confirms it. */
  patchTask: (id: string, patch: Partial<BoardTask>) => void;
  /** A card left the ground: the rows freeze here. */
  beginDrag: () => void;
  /** The card landed (or the drag was cancelled): unfreeze. Does NOT read: the
   *  read that waited is released by `flushDeferredRead`, and WHEN is the
   *  caller's to decide (see the note above). */
  endDrag: () => void;
  /** Release the read parked during the drag, if there was one. Call it once the
   *  write the gesture produced has settled. */
  flushDeferredRead: () => void;
}

export function useBoardFeed({ mode, projectId, showArchived, onError }: BoardFeedOptions): BoardFeed {
  const isAll = mode === 'all';
  const globalTasks = useBoardTasks();
  const globalLoaded = useBoardTasksLoaded();
  // The rows AND the query they answer, in one state. Keeping them together is
  // what makes "still loading" a derived value instead of a flag set from an
  // effect: switching board or opening the archive changes the key, and the
  // spinner is simply "the answer on hand is not for this question".
  //
  // THE SEED: the rows this very query answered last time, read synchronously
  // from the local copy. Without it a reload lands on empty columns until the
  // fetch comes back, and the answer to "was the board there on the first
  // frame" was no. `key` is set to the query the seed answers, so `loading`
  // stays false and the columns keep the geometry the reader left behind; the
  // fetch below leaves anyway and overwrites it.
  const [own, setOwn] = useState<{ key: string; rows: readonly BoardTask[] }>(() => {
    const k = queryKey(projectId, showArchived);
    const cached = readBoardRowsCache(k);
    return cached ? { key: k, rows: cached } : { key: '', rows: [] };
  });
  const key = queryKey(projectId, showArchived);

  // The query lives in a ref because the reader owns a timer: rebuilding it on
  // every change of board would drop the pending tail. It reads the CURRENT
  // query when it fires instead. The effect that syncs it is declared BEFORE
  // the one that triggers a read, so a query change is written before it is used.
  const queryRef = useRef({ projectId, showArchived });
  useEffect(() => { queryRef.current = { projectId, showArchived }; }, [projectId, showArchived]);
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  // One reader per mount, recreated on demand: unmount nulls it out and under
  // StrictMode mount and unmount alternate (same shape as useGlobalBoard).
  const reader = useRef<Coalescer | null>(null);
  const ensure = useCallback(() => {
    if (reader.current === null) {
      reader.current = createCoalescedReader<Outcome>({
        windowMs: COALESCE_WINDOW_MS,
        load: async () => {
          const q = queryRef.current;
          const loadedKey = queryKey(q.projectId, q.showArchived);
          try {
            const rows = await boardApi.list(q.projectId, undefined, undefined, { archived: q.showArchived });
            return { key: loadedKey, ok: true, rows };
          } catch (e) {
            return { key: loadedKey, ok: false, message: e instanceof Error ? e.message : 'failed to load board' };
          }
        },
        apply: (out) => {
          if (out.ok) {
            setOwn({ key: out.key, rows: out.rows });
            writeBoardRowsCache(out.key, out.rows);
            onErrorRef.current(null);
          } else {
            // A failed read still ANSWERS the question: the previous rows stay
            // on screen with the error above them, and the spinner goes. A
            // spinner that never ends is the one state that says nothing.
            setOwn((prev) => ({ key: out.key, rows: prev.rows }));
            onErrorRef.current(out.message);
          }
        },
      });
    }
    return reader.current;
  }, []);
  useEffect(() => () => { reader.current?.dispose(); reader.current = null; }, []);

  const draggingRef = useRef(false);
  const pendingRef = useRef(false);
  const refetch = useCallback(() => {
    if (draggingRef.current) { pendingRef.current = true; return; }
    if (isAll) requestBoardTasksRefresh();
    else ensure().trigger();
  }, [isAll, ensure]);

  // First read, and a fresh one on every change of query (board, archive view).
  // In 'all' mode the store is already live — asking again on every mount of a
  // board pane would be a second full read of the 1.4 MB feed for nothing — so
  // it only asks when nothing has ever landed in it.
  useEffect(() => {
    if (isAll) {
      if (!hasLoadedBoardTasks()) requestBoardTasksRefresh();
      return;
    }
    ensure().trigger();
  }, [isAll, projectId, showArchived, ensure]);

  // A RECONNECT IS A HOLE, NOT A PAUSE: the `task:*` broadcasts sent while the
  // socket was down are delivered to a socket that no longer exists and nothing
  // replays them. Same subscription as `syncWS` and `useTerminalLifecycle`; the
  // coalescer keeps it to one read.
  useEffect(() => subscribeLifecycle((event) => {
    if (event === 'open') refetch();
  }), [refetch]);

  const source = isAll ? globalTasks : own.rows;
  const sourceRef = useRef(source);
  useEffect(() => { sourceRef.current = source; }, [source]);
  // The frozen snapshot is STATE and not a ref: unfreezing has to re-render.
  const [frozen, setFrozen] = useState<readonly BoardTask[] | null>(null);
  const beginDrag = useCallback(() => {
    draggingRef.current = true;
    setFrozen(sourceRef.current);
  }, []);
  const endDrag = useCallback(() => {
    draggingRef.current = false;
    setFrozen(null);
  }, []);
  const flushDeferredRead = useCallback(() => {
    if (!pendingRef.current) return;
    pendingRef.current = false;
    refetch();
  }, [refetch]);

  const patchTask = useCallback((id: string, patch: Partial<BoardTask>) => {
    const applyTo = (rows: readonly BoardTask[]) => rows.map((t) => (t.id === id ? { ...t, ...patch } : t));
    if (isAll) patchBoardTask(id, patch);
    else setOwn((prev) => ({ key: prev.key, rows: applyTo(prev.rows) }));
    // A patch written during a drag (a keyboard move ends the gesture with the
    // write, not before it) must show through the freeze, or the card snaps back
    // for as long as the gesture lasts.
    setFrozen((prev) => (prev ? applyTo(prev) : prev));
  }, [isAll]);

  return {
    tasks: frozen ?? source,
    loading: isAll ? !globalLoaded : own.key !== key,
    refetch,
    patchTask,
    beginDrag,
    endDrag,
    flushDeferredRead,
  };
}
