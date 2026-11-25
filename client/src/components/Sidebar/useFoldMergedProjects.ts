/**
 * The sidebar's accorpa: puts the topics of merged projects under their parent.
 * The rule is `foldMergedProjects` (pure, tested); this only feeds it from the
 * board index, which knows the family links and the folder of each board id.
 */
import { useMemo } from 'react';
import type { SidebarItem } from '../../lib/buildSidebarItems';
import { foldMergedProjects } from '../../lib/sidebarProjectFamilies';
import { useBoardFamilies, useBoardProjectLabels } from '../../lib/boardProjectsStore';
import { mergedParentMap } from '../../../../shared/project-family';

export function useFoldMergedProjects(items: SidebarItem[]): SidebarItem[] {
  const families = useBoardFamilies();
  const index = useBoardProjectLabels();
  return useMemo(() => {
    const parentOf = mergedParentMap(families);
    if (parentOf.size === 0) return items;
    const pathByBoard = new Map((index ?? []).map((p) => [p.projectId, p.path]));
    return foldMergedProjects(items, parentOf, { pathOfBoard: (id) => pathByBoard.get(id) || undefined });
  }, [items, families, index]);
}
