/**
 * "Reimposta pannelli al primo livello" — pure flatten op for the PROJECT
 * window's `GroupLayoutRow[]` model.
 *
 * (The STANDALONE grid uses a stronger reset — collapse every pane into the
 * single 'standalone' pool cell as tabs — which is stateful, folding soloCells
 * back into the pool, so it lives in PanelGrid.handleResetGridLayout, not here.
 * The grid twin of this pure flatten was removed once that collapse replaced it.)
 *
 * Semantics: "primo livello" = level-1 columns in a single row. The op
 * gathers every group key in VISUAL order (each column's primary then its
 * vertical sub-stack, left-to-right per row, top-to-bottom across rows),
 * dissolves every `cellStacks` sub-stack into a top-level column, and emits
 * ONE row of equal widths. No pane or tab is closed and no groups are merged
 * — only geometry is reset. This is deliberately NOT buildDefaultGroups
 * (which merges every pane into one tabbed group) and NOT a collapse-to-
 * focused (a destructive close with no precedent).
 *
 * Implemented on the LEGACY ROW MODEL, never on the split tree: the tree is
 * derived render state (see layoutTree.ts STATUS note) and a tree-side reset
 * would be discarded on the next rows-driven rebuild.
 *
 * ">32 leaves" is best-effort "one row": keys chunk into ceil(n/32) rows of
 * ≤ MAX_COLS_PER_ROW columns with equal row heights, mirroring the additive
 * overflow path in useProjectLayout's sync effect.
 *
 * Pure module (no React) so bun:test can lock the contract — see
 * flattenLayout.test.ts.
 */
import type { GroupLayoutRow } from '../../types';
import { allGroupIdsInRows } from './groupLayoutStacks';
import { equalizeWidths } from './gridWidths';
import { MAX_COLS_PER_ROW } from './constants';

/** First-occurrence dedup — duplicate/dead keys in persisted rows must not
 *  produce duplicate columns (the sanitizers dedup the same way on load). */
function dedupFirst(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** Chunk `keys` into rows of ≤ MAX_COLS_PER_ROW (runaway backstop). */
function chunkKeys(keys: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += MAX_COLS_PER_ROW) {
    chunks.push(keys.slice(i, i + MAX_COLS_PER_ROW));
  }
  return chunks;
}

/** Already flat = a single row (or none), no vertical sub-stack member
 *  anywhere, and no chunking needed. Hosts use the null return to HIDE the
 *  "Reimposta pannelli" menu entry / no-op the palette action. */
function isAlreadyFlat(
  rowCount: number,
  hasStackMembers: boolean,
  walkedCount: number,
): boolean {
  return rowCount <= 1 && !hasStackMembers && walkedCount <= MAX_COLS_PER_ROW;
}

/** Single-row widths are "canonical" only when already ~equal (1/n). A project
 *  row whose columns were DRAGGED to custom widths is not canonical, so "Reimposta
 *  pannelli" still has work to do: re-equalise it. Without this a horizontal split
 *  at, say, 70/30 counted as "already flat" and the reset silently did nothing.
 *  The tolerance swallows the float drift persistence/normalisation can introduce;
 *  a real drag is far larger. */
function widthsAreEqual(widths: readonly number[]): boolean {
  if (widths.length <= 1) return true;
  const target = 1 / widths.length;
  return widths.every((w) => Math.abs(w - target) <= 1e-3);
}

/**
 * Flatten the PROJECT model (`GroupLayoutRow[]` + rowHeights).
 *
 * `liveGroupIds` (defensive) unions in any live group the rows missed —
 * otherwise useProjectLayout's [groups]-dep sync effect would "heal" it via
 * appendColumnWidths right after the reset and skew the equal widths. The
 * already-flat null check deliberately ignores `liveGroupIds` (healing a
 * missed group is the sync effect's job, not a reason to offer the reset).
 *
 * Returns `null` when there is nothing to flatten.
 */
export function flattenGroupRows(
  rows: readonly GroupLayoutRow[],
  liveGroupIds?: readonly string[],
): { rows: GroupLayoutRow[]; rowHeights: number[] } | null {
  const walked = dedupFirst(allGroupIdsInRows(rows));
  const hasStackMembers = rows.some(
    (r) => !!r.cellStacks && Object.values(r.cellStacks).some((s) => s.groupIds.length > 0),
  );
  // A single row whose columns were dragged to custom widths is NOT canonical —
  // reset re-equalises it (the project window "Reimposta pannelli non fa nulla" case).
  const singleRowNeedsEqualise = rows.length === 1 && !hasStackMembers && !widthsAreEqual(rows[0].widths);
  if (isAlreadyFlat(rows.length, hasStackMembers, walked.length) && !singleRowNeedsEqualise) return null;

  const keys = liveGroupIds ? dedupFirst([...walked, ...liveGroupIds]) : walked;
  if (keys.length === 0) return null;

  const chunks = chunkKeys(keys);
  return {
    rows: chunks.map((groupIds) => ({ groupIds, widths: equalizeWidths(groupIds.length) })),
    rowHeights: equalizeWidths(chunks.length),
  };
}
