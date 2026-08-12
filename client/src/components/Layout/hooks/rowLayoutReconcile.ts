/**
 * `reconcileRowsWithGroups` — la passata «le righe seguono i gruppi», pura.
 *
 * Possiede:
 *  - La riconciliazione delle pile verticali di colonna (`reconcileCellStacks`)
 *    prima di ogni potatura, così un primario promosso conta come vivo.
 *  - La potatura di colonne e righe morte, CONSERVANDO le larghezze manuali
 *    delle colonne superstiti e le altezze manuali delle righe superstiti.
 *  - La collocazione dei gruppi non ancora in griglia: riempie la prima riga
 *    fino a `MAX_COLS_PER_ROW`, il resto trabocca in una riga nuova.
 *  - Il ripiego «griglia vuota con gruppi vivi» → una riga sola con tutti.
 *
 * NON possiede:
 *  - I gruppi (`groupPaneReconcile`), il fuoco, le pane.
 *  - Quando applicare il risultato: restituisce `null` quando non c'è NIENTE da
 *    cambiare, e `rowHeights: null` quando le altezze vanno lasciate stare.
 *
 * Perché è una funzione e non un `useEffect`: `rows` e `rowHeights` sono
 * l'OUTPUT di questa passata, non il suo input — dentro l'effetto si leggevano
 * dalle ref con un `eslint-disable react-hooks/exhaustive-deps` a spiegare
 * perché. Qui sono due parametri: la stessa proprietà, dichiarata dalla firma
 * invece che da un commento.
 */
import type { GroupLayoutRow, PaneGroup } from '../../../types';
import { appendColumnWidths, keepColumnWidths } from '../gridWidths';
import { reconcileCellStacks, pickCellStacks, rowGroupIds } from '../groupLayoutStacks';
import { MAX_COLS_PER_ROW } from '../constants';

export interface RowLayoutReconciliation {
  rows: GroupLayoutRow[];
  /** Nuove altezze, o `null` quando il conteggio delle righe non è cambiato e
   *  quelle correnti restano valide. */
  rowHeights: number[] | null;
}

export function reconcileRowsWithGroups(
  rows: GroupLayoutRow[],
  rowHeights: number[],
  groups: PaneGroup[],
): RowLayoutReconciliation | null {
  const allGroupIds = new Set(groups.map(g => g.id));
  // First reconcile per-column vertical stacks: drop dead stacked members,
  // promote a survivor when a column's primary died, prune empty stacks. This
  // runs BEFORE the column/row pruning below so a promoted primary is seen as
  // live and a fully-dead column is left for the width-preserving filter to
  // drop. `cellStacks` then rides through that filter via pickCellStacks.
  const reconciled = reconcileCellStacks(rows, allGroupIds);
  const curRows = reconciled.rows;
  let anyRowChanged = reconciled.changed;
  let newRows = curRows.map(r => {
    // Keep the indices of groups that still exist, in order.
    const keepIdx: number[] = [];
    for (let i = 0; i < r.groupIds.length; i++) {
      if (allGroupIds.has(r.groupIds[i])) keepIdx.push(i);
    }
    if (keepIdx.length === r.groupIds.length) return r;
    anyRowChanged = true;
    const groupIds = keepIdx.map(i => r.groupIds[i]);
    // Preserve the surviving columns' manual widths (renormalised) instead of
    // flattening them to equal — dropping a group must not reset its siblings.
    const widths = keepColumnWidths(r.widths, keepIdx);
    // Keep the surviving columns' vertical stacks; drop entries keyed by a
    // pruned primary (reconcile never leaves a dead primary heading a stack).
    const cellStacks = pickCellStacks(r.cellStacks, groupIds);
    return { groupIds, widths, ...(cellStacks ? { cellStacks } : {}) };
  });
  // Track which pre-filter row indices survive (== indices into rowHeights),
  // so the surviving rows' manual heights can be preserved below instead of
  // flattening to 1/n — the vertical twin of the width preservation above.
  const keptRowIdx: number[] = [];
  const beforeLen = newRows.length;
  newRows = newRows.filter((r, i) => {
    const keep = r.groupIds.length > 0;
    if (keep) keptRowIdx.push(i);
    return keep;
  });
  if (newRows.length !== beforeLen) anyRowChanged = true;

  // Count BOTH column primaries and stacked members as "placed" — a stacked
  // group must not also be re-added as a fresh top-level column (it would
  // render twice). rowGroupIds walks primaries + every cellStack.
  const usedAfterClean = new Set(newRows.flatMap(rowGroupIds));
  const newGroupIds = groups.filter(g => !usedAfterClean.has(g.id)).map(g => g.id);
  if (newGroupIds.length > 0) {
    anyRowChanged = true;
    if (newRows.length === 0) {
      newRows = [{ groupIds: newGroupIds, widths: newGroupIds.map(() => 1 / newGroupIds.length) }];
    } else {
      // Respect MAX_COLS_PER_ROW (handleSplitGroup enforces it; this
      // additive path must not bypass it): fill the first row up to the
      // cap, overflow into a fresh row below.
      const firstRow = newRows[0];
      const slots = Math.max(0, MAX_COLS_PER_ROW - firstRow.groupIds.length);
      const toFirst = newGroupIds.slice(0, slots);
      const overflow = newGroupIds.slice(slots);
      let rebuilt = newRows;
      if (toFirst.length > 0) {
        const all = [...firstRow.groupIds, ...toFirst];
        // Give the newly-appeared groups a fair share but keep the first
        // row's existing columns in proportion (was `1/n` — reset on every
        // add).
        rebuilt = [{ ...firstRow, groupIds: all, widths: appendColumnWidths(firstRow.widths, toFirst.length) }, ...rebuilt.slice(1)];
      }
      if (overflow.length > 0) {
        rebuilt = [...rebuilt, { groupIds: overflow, widths: overflow.map(() => 1 / overflow.length) }];
      }
      newRows = rebuilt;
    }
  }

  if (newRows.length === 0 && groups.length > 0) {
    anyRowChanged = true;
    const gids = groups.map(g => g.id);
    newRows = [{ groupIds: gids, widths: gids.map(() => 1 / gids.length) }];
  }

  if (!anyRowChanged) return null;

  let newHeights: number[] | null = null;
  if (newRows.length !== rowHeights.length) {
    // When rows were purely removed (every survivor maps back to a height
    // via keptRowIdx) preserve their manual heights in proportion; only
    // fall back to an equal split when brand-new rows were created.
    newHeights =
      keptRowIdx.length === newRows.length && newRows.length > 0
        ? keepColumnWidths(rowHeights, keptRowIdx)
        : newRows.map(() => 1 / newRows.length);
  }

  return { rows: newRows, rowHeights: newHeights };
}
