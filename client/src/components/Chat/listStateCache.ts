/**
 * The measured sizes and offset of a chat list that unmounted, kept as DATA so
 * its next mount can start from them.
 *
 * WHY. A chat pane rebuilt by a group switch or after the residency cap evicted
 * it has every row in the store, and still showed the skeleton for ~14 frames:
 * Virtuoso mounted with no size known, rendered one row to guess the rest,
 * measured, scrolled to its `initialTopMostItemIndex` behind its own hidden
 * item list, and only then could the curtain count two still frames. With the
 * snapshot Virtuoso takes (`getState`: the sizes it measured and the scroll
 * offset), it renders the right rows at their real heights on the first pass:
 * 6 skeleton frames instead of 14 on the return to a 2000-row chat (TABSWITCH-02).
 *
 * WHAT IT COSTS. A snapshot holds only what Virtuoso MEASURED, as ranges of
 * equal sizes: 605-727 bytes of JSON for the 2000-row chat above, against the
 * DOM of a pane kept mounted. At most `MAX_ENTRIES` are kept.
 *
 * WHEN IT IS USED. Only when it describes the list exactly as it mounts again:
 * the same number of items (a snapshot is indexed by position), and taken while
 * the list rested at the bottom, which is where a remount opens anyway. A list
 * left scrolled up is not snapshotted: it keeps opening at the bottom, as before.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { StateSnapshot, VirtuosoHandle } from 'react-virtuoso';

export const MAX_ENTRIES = 32;

type Entry = { state: StateSnapshot; count: number };

const entries = new Map<string, Entry>();

/** Written as the list unmounts. A list not at rest at the bottom forgets any older snapshot. */
export function saveListState(topicId: string, state: StateSnapshot, count: number, atBottom: boolean): void {
  entries.delete(topicId);
  if (!atBottom || count === 0) return;
  entries.set(topicId, { state, count });
  // Map order is insertion order: the first key is the oldest write.
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
}

/** The snapshot to mount from, or undefined when it no longer describes the list. */
export function listStateFor(topicId: string, count: number): StateSnapshot | undefined {
  const entry = entries.get(topicId);
  return entry && entry.count === count ? entry.state : undefined;
}

/** Test seam: the module keeps state across tests in one process. */
export function clearListStates(): void {
  entries.clear();
}

/**
 * The list's side: the snapshot to mount from (read once, at mount, for the
 * topic it was mounted for), and the save as it unmounts. On an unmount a layout
 * effect's cleanup runs before its children's, so Virtuoso's handle is still
 * there; the closure is refreshed after every commit, so the count saved is the
 * one of the last committed list.
 */
export function useListStateCache(
  topicId: string,
  count: number,
  virtuosoRef: RefObject<VirtuosoHandle | null>,
  distanceFromBottomRef: RefObject<number>,
): StateSnapshot | undefined {
  const [mounted] = useState(() => ({ topicId, state: listStateFor(topicId, count) }));
  const saveRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    saveRef.current = () => {
      const atBottom = distanceFromBottomRef.current <= 1;
      virtuosoRef.current?.getState((state) => saveListState(topicId, state, count, atBottom));
    };
  });
  useLayoutEffect(() => () => saveRef.current(), []);
  return mounted.topicId === topicId ? mounted.state : undefined;
}
