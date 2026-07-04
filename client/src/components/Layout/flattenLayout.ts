/**
 * "Reimposta pannelli al primo livello" — pure flatten ops for BOTH legacy
 * row models (the project window's `GroupLayoutRow[]` and the standalone
 * grid's `PanelGridRow[]`).
 *
 * Semantics: "primo livello" = level-1 columns in a single row. The op
 * gathers every group/cell key in VISUAL order (each column's primary then
 * its vertical sub-stack, left-to-right per row, top-to-bottom across rows),
 * dissolves every `cellStacks` sub-stack into a top-level column, and emits
 * ONE row of equal widths. No pane or tab is closed and no groups are merged
 * — only geometry is reset. This is deliberately NOT buildDefaultGroups
 * (which merges every pane into one tabbed group) and NOT a collapse-to-
 * focused (a destructive close with no precedent).
 *
 * Implemented on the LEGACY ROW MODELS, never on the split tree: the tree is
 * derived render state (see layoutTree.ts STATUS note) and a tree-side reset
 * would be discarded on the next rows-driven rebuild. Operating on rows also
 * makes the op work on the mobile <768px PanelGrid branch for free.
 *
 * ">32 leaves" is best-effort "one row": keys chunk into ceil(n/32) rows of
 * ≤ MAX_COLS_PER_ROW columns with equal row heights, mirroring the additive
 * overflow path in useProjectLayout's sync effect.
 *
 * Pure module (no React) so bun:test can lock the contract — see
 * flattenLayout.test.ts.
 */
import type { GroupLayoutRow, PanelGridRow } from '../../types';
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
  if (isAlreadyFlat(rows.length, hasStackMembers, walked.length)) return null;

  const keys = liveGroupIds ? dedupFirst([...walked, ...liveGroupIds]) : walked;
  if (keys.length === 0) return null;

  const chunks = chunkKeys(keys);
  return {
    rows: chunks.map((groupIds) => ({ groupIds, widths: equalizeWidths(groupIds.length) })),
    rowHeights: equalizeWidths(chunks.length),
  };
}

/**
 * Flatten the STANDALONE model (`PanelGridRow[]` + gridRowHeights) — the
 * grid twin of `flattenGroupRows`. Walk order is each row's `itemKeys` with
 * every key's `cellStacks` items right after it (visual order).
 *
 * `soloCells` is left UNTOUCHED by design: stack members are already valid
 * grid-item keys ('standalone' / 'solo:<id>'), so dissolving a stack just
 * promotes them to top-level cells — no re-keying, and the first-occurrence
 * dedup in usePanelGridPersistence.sanitizeRow stays satisfied.
 *
 * `liveItemKeys` (defensive) is the grid twin of `flattenGroupRows`'
 * `liveGroupIds`: it unions in any live grid cell the rows missed — otherwise
 * PanelGrid's additive-sync effect (the `naturalGridItems` diff) would "heal"
 * the missed key by appending it to row 0 with a default width right after the
 * reset, skewing the equal widths. The already-flat null check deliberately
 * ignores it (healing a missed key is the sync effect's job, not a reason to
 * offer the reset).
 *
 * Returns `null` when there is nothing to flatten.
 */
export function flattenGridRows(
  rows: readonly PanelGridRow[],
  liveItemKeys?: readonly string[],
): { rows: PanelGridRow[]; rowHeights: number[] } | null {
  const walked = dedupFirst(
    rows.flatMap((r) =>
      r.itemKeys.flatMap((k) => [k, ...(r.cellStacks?.[k]?.items ?? [])]),
    ),
  );
  const hasStackMembers = rows.some(
    (r) => !!r.cellStacks && Object.values(r.cellStacks).some((s) => s.items.length > 0),
  );
  if (isAlreadyFlat(rows.length, hasStackMembers, walked.length)) return null;

  const keys = liveItemKeys ? dedupFirst([...walked, ...liveItemKeys]) : walked;
  if (keys.length === 0) return null;

  const chunks = chunkKeys(keys);
  return {
    rows: chunks.map((itemKeys) => ({ itemKeys, widths: equalizeWidths(itemKeys.length) })),
    rowHeights: equalizeWidths(chunks.length),
  };
}
