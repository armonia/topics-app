import type { Pane, PaneGroup, PaneType } from '../../../types';
import { createProjectSingletonPaneId, isProjectSingletonPaneType } from '../../../state/pane/adapters/paneConfig';

export interface ProjectPaneIdentityState {
  panes: Pane[];
  groups: PaneGroup[];
}

/**
 * Gives legacy project singleton views (random ids) their per-project id
 * (PANE-AUTH-04). `stableKey` keeps the old id, so the React key and the
 * residency key (`stableKey ?? id`) do not change and nothing remounts. When
 * one view appears more than once, the copy that comes first in group order
 * survives: they are views, they hold no data. Pane order is left as it was.
 */
export function migrateProjectPaneIdentity(
  projectPath: string,
  panes: Pane[],
  groups: PaneGroup[] = [],
): ProjectPaneIdentityState {
  const rank = new Map<string, number>();
  groups.flatMap(group => group.paneIds).forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  const rankOf = (pane: Pane) => rank.get(pane.id) ?? Number.POSITIVE_INFINITY;
  const survivors = new Map<PaneType, Pane>();
  for (const pane of panes) {
    if (!isProjectSingletonPaneType(pane.type)) continue;
    const kept = survivors.get(pane.type);
    if (!kept || rankOf(pane) < rankOf(kept)) survivors.set(pane.type, pane);
  }

  const idsBySource = new Map<string, string>();
  const droppedIds = new Set<string>();
  const migrated = panes.flatMap(pane => {
    if (!isProjectSingletonPaneType(pane.type)) return [pane];
    if (survivors.get(pane.type) !== pane) {
      droppedIds.add(pane.id);
      return [];
    }
    const id = createProjectSingletonPaneId(projectPath, pane.type);
    if (id === pane.id) return [pane];
    idsBySource.set(pane.id, id);
    return [{ ...pane, id, stableKey: pane.stableKey ?? pane.id }];
  });

  const migratedGroups = groups
    .map(group => {
      const paneIds = [...new Set(group.paneIds
        .filter(id => !droppedIds.has(id))
        .map(id => idsBySource.get(id) ?? id))];
      if (paneIds.length === 0) return null;
      const activePaneId = droppedIds.has(group.activePaneId)
        ? paneIds[0]
        : idsBySource.get(group.activePaneId) ?? group.activePaneId;
      return { ...group, paneIds, activePaneId };
    })
    .filter((group): group is PaneGroup => group !== null);

  return { panes: migrated, groups: migratedGroups };
}
