/**
 * Standalone split cells, coherent with the project groups model.
 *
 * A "solo cell" is a split column in the standalone (non-project) layout. The
 * old model stored solo topics as a FLAT list (`soloTopicIds: string[]`), so
 * every split cell held exactly ONE topic — you could never drop a tab INTO a
 * populated cell, and dropping onto another cell collapsed both into the pool.
 *
 * This model stores `SoloCells = string[][]`: each inner array is ONE cell's
 * ordered topic list (primary first). A single-topic cell `[A]` renders exactly
 * like the old `solo:A`, so existing persisted layouts migrate 1:1 with no grid
 * re-keying. A multi-topic cell `[B, A]` renders as a real multi-tab group whose
 * cell key stays `solo:<primary>` (the first id) — stable while the primary is
 * open. This makes standalone behave like project groups: move a tab into a
 * populated cell → it becomes that cell's next tab; move the last tab out → the
 * column collapses; other splits are untouched.
 *
 * All functions are pure and return NEW arrays (never mutate input), and never
 * leave a topic in two cells or keep an empty cell.
 */
export type SoloCells = string[][];

/** The grid item key for a cell — its primary (first) topic. */
export function soloCellKey(cell: readonly string[]): string {
  return `solo:${cell[0]}`;
}

/** Inverse of `soloCellKey`: the cell primary encoded in a grid item key, or
 *  null when the key isn't a solo cell (the main 'standalone' pool). Used to
 *  route a pane created from a split cell's "+" into THAT cell — without this
 *  the new pane always landed in the standalone pool's tab bar. */
export function primaryFromSoloCellKey(gridItemKey: string): string | null {
  if (!gridItemKey.startsWith('solo:')) return null;
  const primary = gridItemKey.slice('solo:'.length);
  return primary.length > 0 ? primary : null;
}

/** All solo topic ids across every cell (the flat set the old code used). */
export function flattenSoloCells(cells: SoloCells): string[] {
  return cells.flat();
}

/** Remove a topic from whatever cell holds it; drop a cell that empties. */
export function removeTopicFromCells(cells: SoloCells, topicId: string): SoloCells {
  let changed = false;
  const next: SoloCells = [];
  for (const cell of cells) {
    if (!cell.includes(topicId)) { next.push(cell); continue; }
    const trimmed = cell.filter((id) => id !== topicId);
    changed = true;
    if (trimmed.length > 0) next.push(trimmed);
  }
  return changed ? next : cells;
}

/** Add a topic as its OWN new single-topic cell (the classic "split out").
 *  No-op if the topic is already solo somewhere. */
export function addSoloCell(cells: SoloCells, topicId: string): SoloCells {
  if (cells.some((c) => c.includes(topicId))) return cells;
  return [...cells, [topicId]];
}

/** Extract a topic into its OWN new single-topic cell, removing it from any
 *  cell it currently shares (so dragging a member tab out of a multi-tab cell
 *  to an edge gives it a fresh column instead of no-oping). */
export function extractToOwnCell(cells: SoloCells, topicId: string): SoloCells {
  const without = removeTopicFromCells(cells, topicId);
  return [...without, [topicId]];
}

/**
 * Move `topicId` INTO the cell whose primary is `targetPrimary`, appended as
 * that cell's next tab. Removes it from any cell it was in first (so it's never
 * in two places). If the target cell doesn't exist, the topic still becomes
 * solo as its own cell (defensive — the target should normally exist).
 * Self-merge (topic already the target's primary, alone) is a no-op.
 */
export function moveTopicToCell(cells: SoloCells, topicId: string, targetPrimary: string): SoloCells {
  if (topicId === targetPrimary) return cells; // can't merge a cell into itself
  const without = removeTopicFromCells(cells, topicId);
  let landed = false;
  const next = without.map((cell) => {
    if (cell[0] !== targetPrimary) return cell;
    landed = true;
    return cell.includes(topicId) ? cell : [...cell, topicId];
  });
  if (!landed) next.push([topicId]); // target cell gone — fall back to own cell
  return next;
}

/** Drop closed topics and any emptied cells. Returns the SAME ref when nothing
 *  changed so callers can skip a redundant state update. */
export function pruneSoloCells(cells: SoloCells, openIds: ReadonlySet<string>): SoloCells {
  let changed = false;
  const next: SoloCells = [];
  for (const cell of cells) {
    const kept = cell.filter((id) => openIds.has(id));
    if (kept.length !== cell.length) changed = true;
    if (kept.length > 0) next.push(kept);
  }
  return changed ? next : cells;
}

/** Back-compat: build SoloCells from a legacy flat `soloTopicIds`. */
export function soloCellsFromFlat(flat: readonly string[]): SoloCells {
  return flat.map((id) => [id]);
}
