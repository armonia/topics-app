/**
 * Pure reducers over `PaneGroup[]` — the group (= window) algebra of the
 * project layout, lifted out of `useProjectLayout` so it can be reasoned
 * about and tested without a browser.
 *
 * Why here: the same twelve lines of "detach a pane, pick the next active
 * one, drop the group if it emptied" lived inline in four places
 * (`handleClosePaneNow`, `handleClosePane`'s pre-shift, `handleSplitGroup`,
 * `handleMovePaneBetweenGroups`). Four copies of a rule this fiddly is three
 * chances to fix a bug in only one of them.
 *
 * grid-split.spec.ts used to "cover" this with four tests that pasted the
 * logic into `page.evaluate` and asserted the paste — tautologies that would
 * have stayed green with the real implementation deleted. `groupOps.test.ts`
 * replaces them, against THIS code.
 */
import type { PaneGroup, PaneGroupType, PaneType } from '../../../types';

/** Which kind of group a pane of `type` belongs in. */
export function paneTypeToGroupType(type: PaneType): PaneGroupType {
  if (type === 'chat') return 'chat';
  if (type === 'file' || type === 'files') return 'file';
  return 'utility';
}

/**
 * Which pane becomes active in `group` once `paneId` leaves it: the tab that
 * takes its INDEX, clamped to the last one — i.e. focus lands where the eye
 * already is. Returns the current active pane unchanged when the leaving pane
 * wasn't the active one, or when nothing is left (the caller drops the group).
 */
export function nextActivePaneId(group: PaneGroup, paneId: string): string {
  const remaining = group.paneIds.filter(id => id !== paneId);
  if (remaining.length === 0 || group.activePaneId !== paneId) return group.activePaneId;
  return remaining[Math.min(group.paneIds.indexOf(paneId), remaining.length - 1)];
}

/**
 * Remove `paneId` from the group `groupId`, re-pointing its active pane, and
 * drop any group left with no panes — an empty group would otherwise survive
 * as a cell with a tab bar and nothing in it.
 */
export function detachPaneFromGroups(
  groups: PaneGroup[],
  groupId: string,
  paneId: string,
): PaneGroup[] {
  return groups
    .map(g => {
      if (g.id !== groupId) return g;
      return {
        ...g,
        paneIds: g.paneIds.filter(id => id !== paneId),
        activePaneId: nextActivePaneId(g, paneId),
      };
    })
    .filter(g => g.paneIds.length > 0);
}

/**
 * Move `paneId` out of `sourceGroupId` and into `targetGroupId` at
 * `insertIdx` (clamped), making it the target's active pane. A source group
 * emptied by the move disappears.
 *
 * Returns `groups` untouched when either group is missing or the pane isn't
 * where the caller says it is — a drag whose model has already moved on must
 * not invent a layout.
 */
export function movePaneBetweenGroups(
  groups: PaneGroup[],
  sourceGroupId: string,
  targetGroupId: string,
  paneId: string,
  insertIdx: number,
): PaneGroup[] {
  const sourceGroup = groups.find(g => g.id === sourceGroupId);
  const targetGroup = groups.find(g => g.id === targetGroupId);
  if (!sourceGroup || !targetGroup) return groups;
  if (!sourceGroup.paneIds.includes(paneId)) return groups;

  return groups
    .map(g => {
      if (g.id === sourceGroupId) {
        return {
          ...g,
          paneIds: g.paneIds.filter(id => id !== paneId),
          activePaneId: nextActivePaneId(g, paneId),
        };
      }
      if (g.id === targetGroupId) {
        const newPaneIds = [...g.paneIds];
        newPaneIds.splice(Math.max(0, Math.min(insertIdx, newPaneIds.length)), 0, paneId);
        return { ...g, paneIds: newPaneIds, activePaneId: paneId };
      }
      return g;
    })
    .filter(g => g.paneIds.length > 0);
}
