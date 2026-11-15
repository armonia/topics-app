import { useCallback, useEffect, useRef, useState } from 'react';
import { CREATED_FLASH_MS } from './constants';

/**
 * The "a task was just born" signals of the board: the flash on the new card
 * and the scroll target for a creation that started in this window.
 */
export function useCreatedFlash(holdCreated: (taskId: string) => void, refetch: () => void) {
  // -- A task just BORN --------------------------------------------------------
  // You wrote in the composer, it emptied, and the card landed at the bottom of
  // a column you were often not looking at: no way to know WHICH card it was, or
  // whether there was one. Two distinct signals, deliberately with two
  // different rules:
  //
  //  - the FLASH answers "a task was born": it holds for whoever created it, so
  //    the source is the WS event `task:created` - even when it comes from an
  //    agent or the MCP, on another machine.
  //  - the SCROLL answers "I just wrote it myself": it moves the board under
  //    the viewer's eyes, and doing it for someone else's creation would mean
  //    tearing away the column they were reading. So ONLY the return of the
  //    POST made by this client arms it, never the broadcast.
  //
  // The broadcast comes back to the creator too: `flashCreated` is idempotent
  // while the flash is on, so the echo does not rearm the timer or lengthen the
  // duration.
  const [justCreated, setJustCreated] = useState<Set<string>>(() => new Set());
  const createdFlashTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const flashCreated = useCallback((id: string) => {
    if (createdFlashTimers.current.has(id)) return; // already on: do not rearm
    setJustCreated((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    createdFlashTimers.current.set(id, setTimeout(() => {
      createdFlashTimers.current.delete(id);
      setJustCreated((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, CREATED_FLASH_MS));
  }, []);
  // Unmounting the pane with the flash on would leave the timers hanging, calling
  // a setState on a component that is gone.
  useEffect(() => {
    const timers = createdFlashTimers.current;
    return () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); };
  }, []);
  /** The card this client wants to see: created HERE, not yet framed. */
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  /** Switches off the "the card stays out of the composer" watch (see the pane). */
  const keepClearRef = useRef<(() => void) | null>(null);
  useEffect(() => () => keepClearRef.current?.(), []);
  /** Creation started from this window: flash + the board scrolls to it. */
  const onCreatedHere = useCallback((taskId?: string) => {
    if (taskId) { flashCreated(taskId); setScrollTarget(taskId); holdCreated(taskId); }
    refetch();
  }, [flashCreated, holdCreated, refetch]);
  return { justCreated, flashCreated, scrollTarget, setScrollTarget, keepClearRef, onCreatedHere };
}
