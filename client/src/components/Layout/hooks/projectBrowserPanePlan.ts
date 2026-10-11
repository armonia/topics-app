import type { PaneGroup } from '../../../types';
import { movePaneBetweenGroups } from './groupOps';

export function resolveProjectBrowserTargetGroup(
  groups: PaneGroup[],
  targetGroupId: string | undefined,
  focusedGroupId: string | null,
  spawnerKey?: string,
): string | undefined {
  const explicitTarget = groups.find(group => group.id === targetGroupId)?.id;
  const spawnerTarget = spawnerKey
    ? groups.find(group =>
      group.paneIds.includes(spawnerKey) || group.paneIds.includes(`chat:${spawnerKey}`),
    )?.id
    : undefined;
  return explicitTarget
    ?? spawnerTarget
    ?? groups.find(group => group.id === focusedGroupId)?.id
    ?? groups[0]?.id;
}

export function activateBrowserPaneInGroup(
  groups: PaneGroup[],
  paneId: string,
  targetGroupId: string,
): PaneGroup[] {
  const source = groups.find(group => group.paneIds.includes(paneId));
  const target = groups.find(group => group.id === targetGroupId);
  if (!source || !target) return groups;
  if (source.id === target.id) {
    return groups.map(group => group.id === target.id ? { ...group, activePaneId: paneId } : group);
  }
  return movePaneBetweenGroups(groups, source.id, target.id, paneId, target.paneIds.length);
}
