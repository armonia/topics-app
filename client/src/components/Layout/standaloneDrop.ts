/**
 * Pure decision for a STANDALONE cross-group tab drop (a tab dragged from one
 * top-level cell and dropped onto another cell's tab bar).
 *
 * Standalone cells are now real multi-tab groups (see soloCells.ts), coherent
 * with the project model. A drop resolves to one of:
 *   - merge-into-cell:    target is another split (`solo:`) cell → the tab joins
 *                         it at the indicated tab index (the split is preserved).
 *   - unsolo-dragged:     target is the main `'standalone'` pool → un-split the
 *                         dragged tab back into the pool.
 *   - noop.
 *
 * (A former `accept-project-topic` decision was removed: project tabs carry a
 * project-scoped dndScope, so PaneTabBar's scope guard never lets them reach
 * this resolver — the branch was unreachable by construction.)
 *
 * The regression this guards: the old handler UNSOLOED both the dragged AND the
 * target cell, collapsing two splits into the pool ("cancelled the split").
 * Now a drop onto a split cell MERGES into it; nothing else collapses.
 */
export type StandaloneCrossGroupDecision =
  | { kind: 'noop' }
  | { kind: 'merge-into-cell'; draggedTopicId: string; targetPrimary: string; insertIdx?: number }
  | { kind: 'unsolo-dragged'; draggedTopicId: string };

export interface StandaloneCrossGroupDropInput {
  /** Source pane id, e.g. `chat:abc` or a bare topic id. */
  sourcePaneId: string;
  /** Grid key of the cell the drag started in (`'standalone'` or `solo:<id>`). */
  sourceGroupId: string;
  /** Grid key of the cell being dropped onto (`'standalone'` or `solo:<id>`). */
  targetGroupId: string;
  /** Topics currently in the target cell. */
  targetTopicIds: readonly string[];
  /** Whether an unsolo/accept-solo handler is wired. */
  canAcceptSolo: boolean;
  /** Whether a merge-into-cell handler is wired (multi-tab cell support). */
  canMergeIntoCell: boolean;
  /** Tab index the drop indicators promised (PaneTabBar's overIdx). */
  insertIdx?: number;
}

const SOLO_PREFIX = 'solo:';

export function resolveStandaloneCrossGroupDrop(input: StandaloneCrossGroupDropInput): StandaloneCrossGroupDecision {
  const { sourcePaneId, sourceGroupId, targetGroupId, targetTopicIds, canAcceptSolo, canMergeIntoCell, insertIdx } = input;

  // A tab dropped back onto its own cell's bar — the tab bar owns same-group
  // reorder, so this cross-group path is a no-op.
  if (sourceGroupId === targetGroupId) return { kind: 'noop' };

  const isChat = sourcePaneId.startsWith('chat:');
  const topicId = isChat ? sourcePaneId.slice(5) : sourcePaneId;

  // A standalone tab (from a split cell or the pool) — never a foreign project
  // chat (project tabs never pass PaneTabBar's dndScope guard).
  if (canAcceptSolo && !isChat) {
    if (canMergeIntoCell && targetGroupId.startsWith(SOLO_PREFIX)) {
      // Target is another split cell → MERGE the dragged tab into it. Already
      // a member (e.g. a stale drag) → no-op rather than a duplicate.
      if (targetTopicIds.includes(topicId)) return { kind: 'noop' };
      return {
        kind: 'merge-into-cell',
        draggedTopicId: topicId,
        targetPrimary: targetGroupId.slice(SOLO_PREFIX.length),
        insertIdx,
      };
    }
    if (sourceGroupId !== 'standalone') {
      // A split-cell tab dropped on the pool (or on a split cell when merge is
      // unavailable) → un-split it back into the pool. Non-destructive.
      return { kind: 'unsolo-dragged', draggedTopicId: topicId };
    }
  }

  return { kind: 'noop' };
}
