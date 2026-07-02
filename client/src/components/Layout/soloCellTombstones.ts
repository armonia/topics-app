/**
 * Solo-cell close tombstones — undo/reopen fidelity for the STANDALONE grid.
 *
 * Closing a tab that lived in a split cell prunes it from `soloCells` at
 * commit; reopening it (⌘Z, closed-tab history, sidebar unarchive) re-adds the
 * topic to `openPanels` as a regular panel, which used to land it in the main
 * pool — its split cell gone. The project surface restores group membership on
 * reopen via the closedStack's tabOrderSnapshot; these tombstones are the
 * standalone twin: remember which cell a closing topic lived in, and when the
 * id reappears within the TTL window, put it back.
 *
 * Pure functions over plain data (PanelGrid holds the list in a ref) so the
 * record/restore logic is unit-testable like the rest of the cell math.
 */
import type { SoloCells } from './soloCells';
import { extractToOwnCell, moveTopicToCell } from './soloCells';

export interface SoloCellTombstone {
  topicId: string;
  /** The OTHER members of the cell at close time (empty = the cell died with it). */
  cellMates: string[];
  /** Tab slot the topic occupied in its cell. */
  index: number;
  closedAt: number;
}

/** How long a reopened topic still remembers its split cell. */
export const SOLO_TOMBSTONE_TTL_MS = 10 * 60_000;
/** Bounded like the undo stack — old entries beyond this are dropped. */
const MAX_TOMBSTONES = 20;

/**
 * Record tombstones for topics that were in `prevCells` but are in neither
 * `nextCells` nor `openIds` — i.e. they CLOSED. A topic merely un-solo'd back
 * into the pool is still open, so it records nothing. Returns the SAME ref
 * when nothing closed.
 */
export function recordSoloTombstones(
  tombstones: readonly SoloCellTombstone[],
  prevCells: SoloCells,
  nextCells: SoloCells,
  openIds: ReadonlySet<string>,
  now: number,
): readonly SoloCellTombstone[] {
  const stillCelled = new Set(nextCells.flat());
  const added: SoloCellTombstone[] = [];
  for (const cell of prevCells) {
    cell.forEach((id, idx) => {
      if (stillCelled.has(id) || openIds.has(id)) return;
      added.push({
        topicId: id,
        cellMates: cell.filter((m) => m !== id),
        index: idx,
        closedAt: now,
      });
    });
  }
  if (added.length === 0) return tombstones;
  const addedIds = new Set(added.map((t) => t.topicId));
  return [...tombstones.filter((t) => !addedIds.has(t.topicId)), ...added].slice(-MAX_TOMBSTONES);
}

export interface SoloTombstoneRestore {
  cells: SoloCells;
  tombstones: readonly SoloCellTombstone[];
  /** True when `cells` differs from the input (a topic was re-homed). */
  cellsChanged: boolean;
}

/**
 * Re-home reopened topics into their remembered cells. For each live (non-
 * expired) tombstone whose topic is open again but not in any cell:
 *
 *  - a surviving cell still holding one of its old cell-mates → the topic
 *    merges back INTO that cell at its old tab slot (moveTopicToCell clamps);
 *  - the cell dissolved entirely (it was the last tab) → the topic gets its
 *    own cell back (slot/width are re-assigned by the grid's additive sync).
 *
 * Consumed and expired tombstones are dropped from the returned list.
 */
export function restoreFromSoloTombstones(
  cells: SoloCells,
  tombstones: readonly SoloCellTombstone[],
  openIds: readonly string[],
  now: number,
): SoloTombstoneRestore {
  const live = tombstones.filter((t) => now - t.closedAt <= SOLO_TOMBSTONE_TTL_MS);
  const open = new Set(openIds);
  const celled = new Set(cells.flat());
  let nextCells = cells;
  const consumed = new Set<string>();
  for (const t of live) {
    if (!open.has(t.topicId)) continue;
    // The topic is open again — the tombstone is spent either way (a topic
    // already sitting in a cell was re-homed by other means; don't restore
    // it twice later).
    consumed.add(t.topicId);
    if (celled.has(t.topicId)) continue;
    const host = nextCells.find((c) => c.some((id) => t.cellMates.includes(id)));
    nextCells = host
      ? moveTopicToCell(nextCells, t.topicId, host[0], t.index)
      : extractToOwnCell(nextCells, t.topicId);
    celled.add(t.topicId);
  }
  const listChanged = consumed.size > 0 || live.length !== tombstones.length;
  return {
    cells: nextCells,
    tombstones: listChanged ? live.filter((t) => !consumed.has(t.topicId)) : tombstones,
    cellsChanged: nextCells !== cells,
  };
}
