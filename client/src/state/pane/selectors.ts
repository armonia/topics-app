import { useShallow } from 'zustand/react/shallow';
import { usePaneStore } from './store';
import type { Pane, Group, PaneState, ProjectLayout, ClosedPaneRecord } from './types';

export function usePanesInGroup(groupId: string): Pane[] {
  return usePaneStore(
    useShallow((s) =>
      (s.groups[groupId]?.paneIds ?? [])
        .map((id) => s.panes[id])
        .filter((p): p is Pane => Boolean(p)),
    ),
  );
}

export function useFocusedPaneId(): string | null {
  return usePaneStore((s) => s.focusedPaneId);
}

export function useGroupOrder(): string[] {
  return usePaneStore(useShallow((s) => s.groupOrder));
}

export function useGroup(groupId: string): Group | undefined {
  return usePaneStore((s) => s.groups[groupId]);
}

export function usePane(id: string): Pane | undefined {
  return usePaneStore((s) => s.panes[id]);
}

export function useClosedStackSize(): number {
  return usePaneStore((s) => s.closedStack.length);
}

/**
 * Server-syncable snapshot.
 *
 * Excludes device-local fields that MUST NOT cross devices (per CONTEXT.md decisions):
 *  - focusedPaneId (prevents focus thrashing across devices)
 *  - Pane.scrollOffset (per-device scroll position)
 *  - ClosedPaneRecord.scrollOffset (also per-device — PANE-03 scroll restore
 *    runs post-mount via the DOM scroll tracker, not via the synced record)
 *
 * The returned shape carries only cross-device-safe data: panes (without scrollOffset),
 * groups, projects (with nested panes also stripped of scrollOffset), groupOrder,
 * closedStack (both outer and nested pane.scrollOffset stripped), lastSeq.
 */
export function selectSyncableSnapshot(s: PaneState) {
  const panesWithoutScroll: Record<string, Omit<Pane, 'scrollOffset'>> = {};
  for (const [id, p] of Object.entries(s.panes)) {
    const { scrollOffset: _scroll, ...rest } = p;
    panesWithoutScroll[id] = rest;
  }
  // Strip scrollOffset from nested project panes too — PROJECT_LAYOUT_SNAPSHOT
  // shallow-copies state.panes into projects[*].panes (reducers/projects.ts:14),
  // so every nested pane still carries its scrollOffset. PANE-02 requires
  // device-local fields never cross the network.
  const projectsWithoutScroll: Record<string, ProjectLayout> = {};
  for (const [projectKey, layout] of Object.entries(s.projects)) {
    const nestedPanes: Record<string, Pane> = {};
    for (const [paneId, p] of Object.entries(layout.panes)) {
      const { scrollOffset: _scroll, ...rest } = p;
      nestedPanes[paneId] = rest as Pane;
    }
    projectsWithoutScroll[projectKey] = { ...layout, panes: nestedPanes };
  }
  // Strip BOTH outer and nested pane.scrollOffset inside each ClosedPaneRecord.
  // CLOSE_PANE (reducers/panes.ts) no longer writes scrollOffset onto the
  // record — but a localStorage payload written by an older build could still
  // carry it, so we also strip here as defense-in-depth.
  const closedStackWithoutScroll: ClosedPaneRecord[] = s.closedStack.map((rec) => {
    const { scrollOffset: _nested, ...paneRest } = rec.pane;
    const { scrollOffset: _outer, ...recRest } = rec;
    return { ...recRest, pane: paneRest as Pane };
  });
  return {
    panes: panesWithoutScroll,
    groups: s.groups,
    projects: projectsWithoutScroll,
    groupOrder: s.groupOrder,
    closedStack: closedStackWithoutScroll,
    lastSeq: s.lastSeq,
    // NOTE: focusedPaneId intentionally excluded — device-local per CONTEXT.md
  };
}
