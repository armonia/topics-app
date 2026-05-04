import { useShallow } from 'zustand/react/shallow';
import { usePaneStore } from './store';
import type { Pane, Group, PaneState, ClosedPaneRecord } from './types';

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

function isDraftId(id: string): boolean {
  return id.startsWith('draft:');
}

interface SnapshotOptions {
  /** Strip pre-promotion draft panes from the output. True for server PUTs and
   *  cross-tab broadcasts; false for same-device persistence. */
  excludeDrafts: boolean;
}

function buildSnapshot(s: PaneState, opts: SnapshotOptions) {
  const panesWithoutScroll: Record<string, Omit<Pane, 'scrollOffset'>> = {};
  for (const [id, p] of Object.entries(s.panes)) {
    if (opts.excludeDrafts && isDraftId(id)) continue;
    const { scrollOffset: _scroll, ...rest } = p;
    panesWithoutScroll[id] = rest;
  }
  const groupsOut: Record<string, Group> = {};
  for (const [gid, g] of Object.entries(s.groups)) {
    if (!opts.excludeDrafts) {
      groupsOut[gid] = g;
      continue;
    }
    const filteredIds = g.paneIds.filter((id) => !isDraftId(id));
    groupsOut[gid] =
      filteredIds.length === g.paneIds.length ? g : { ...g, paneIds: filteredIds };
  }
  // `projects` is intentionally omitted from the snapshot: the reducer's
  // `state.projects[path]` field used to capture App-level pane state under
  // a project key (wrong scope — see projectLayoutSync.ts header) and the
  // result was never consumed authoritatively (consumers silently filtered
  // it out). Stripping it here reduces every server PUT and cross-tab
  // broadcast by ~all of the open-project layout data we don't actually
  // sync. localStorage `topics-project-panes-<hash>` remains the source of
  // truth for inner-project layouts (same-device only).
  const closedStackOut: ClosedPaneRecord[] = s.closedStack
    .filter((rec) => !(opts.excludeDrafts && isDraftId(rec.pane.id)))
    .map((rec) => {
      const { scrollOffset: _nested, ...paneRest } = rec.pane;
      const { scrollOffset: _outer, ...recRest } = rec;
      return { ...recRest, pane: paneRest as Pane };
    });
  return {
    panes: panesWithoutScroll,
    groups: groupsOut,
    groupOrder: s.groupOrder,
    closedStack: closedStackOut,
    lastSeq: s.lastSeq,
  };
}

/**
 * Server-syncable snapshot.
 *
 * Excludes device-local fields that MUST NOT cross devices (per CONTEXT.md decisions):
 *  - focusedPaneId (prevents focus thrashing across devices)
 *  - Pane.scrollOffset (per-device scroll position)
 *  - ClosedPaneRecord.scrollOffset (also per-device — PANE-03 scroll restore
 *    runs post-mount via the DOM scroll tracker, not via the synced record)
 *  - Draft panes (id starts with `draft:`). Drafts are pre-promotion scratch
 *    panes — leaking them cross-device causes the bug where a concurrent
 *    Electron client's PUT broadcasts back without the draft, the receiving
 *    browser dispatches HYDRATE_FROM_SNAPSHOT, and `state.panes = clean.panes`
 *    wipes the local draft within ~300ms of creation.
 */
export function selectSyncableSnapshot(s: PaneState) {
  return buildSnapshot(s, { excludeDrafts: true });
}

/**
 * Same-device localStorage snapshot. Like selectSyncableSnapshot but keeps
 * draft panes so a same-device reload restores in-flight scratch panes. Drafts
 * are still device-local; cross-tab consumers must run sanitizeSnapshot on the
 * incoming payload to filter them out.
 */
export function selectLocalSnapshot(s: PaneState) {
  return buildSnapshot(s, { excludeDrafts: false });
}
