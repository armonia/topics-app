/**
 * useProjectLayout — owns all layout state, refs, effects, and handlers
 * for a `ProjectWindowPane`. Extracted from `ProjectWindow.tsx` during
 * the four-hook refactor (Commit 3).
 *
 * Owns:
 *  - 6 layout state vars: panes, groups, rows, rowHeights, focusedGroupId,
 *    sidebarCollapsed.
 *  - 5 ref mirrors via `useRefMirror`: panesRef, groupsRef,
 *    focusedGroupIdRef, rowsRef, rowHeightsRef.
 *  - 9 effects: terminal-sync, orphan-sync, restore-active-chat,
 *    migration, external-focus, pending-focus, default-focused-group,
 *    pending-pane, preview-close.
 *  - 14 handlers + the file-event handlers (open-file, open-file-diff,
 *    pin-file-pane, reopen-closed-tab) and their `useEffect` listeners.
 *
 * Does NOT own:
 *  - The chat-sync effect (Commit 4 — useProjectChatSync).
 *  - The persistence-save effect (Commit 5 — useProjectPersistenceSave).
 *  - The `userEditedRef` flag-flip — that lives in the persistence-save
 *    effect and is NEVER touched by handlers in this hook.
 *
 * `applyChatReconciliation` and `reopenChatPane` are exposed for
 * `useProjectChatSync` to consume in Commit 4. They are unused this commit.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type {
  Pane,
  PaneGroup,
  PaneGroupType,
  PaneType,
  GroupLayoutRow,
  Topic,
  WSMessage,
} from '../../../types';
import {
  createGroupId,
  createPaneId,
  getAddableTypesForScope,
  getPaneConfig,
  getTerminalSessionFromPaneId,
  PANE_CONFIG,
  captureClosedTab,
  reopenClosedTab,
  scheduleTerminalCleanup,
  addTerminalTombstone,
  clearTerminalTombstone,
  getTerminalTombstones,
} from '../../../state/pane/adapters';
import type { ClosedTabRecord } from '../../../state/pane/adapters/hooks/useClosedTabs';
import { findPreviewPane, replacePaneInGroup } from '../../../lib/previewTabs';
import { pushUndo } from '../../../contexts/UndoContext';
import { enqueuePendingAction, tickPendingAction } from '../../../contexts/PendingActionContext';
import { useRefMirror } from '../../../hooks/useRefMirror';
import { basename } from '../../../lib/path-utils';
import type { ChatReconciliation, PersistedSnapshot, PersistenceGateRefs } from './types';

const isNativeApp =
  typeof window !== 'undefined' && !!(window as unknown as { webkit?: { messageHandlers?: unknown } }).webkit?.messageHandlers;

// --- Module-local helpers (mirrors of ProjectWindow.tsx helpers) ---

function paneTypeToGroupType(type: PaneType): PaneGroupType {
  if (type === 'chat') return 'chat';
  if (type === 'file' || type === 'files') return 'file';
  return 'utility';
}

function buildDefaultGroups(panes: Pane[]): { groups: PaneGroup[]; rows: GroupLayoutRow[] } {
  if (panes.length === 0) return { groups: [], rows: [] };
  const g: PaneGroup = {
    id: createGroupId(),
    paneIds: panes.map(p => p.id),
    activePaneId: panes[0].id,
    type: 'chat',
  };
  return { groups: [g], rows: [{ groupIds: [g.id], widths: [1] }] };
}

function stripWrapperPaneId<T extends { id: string }>(panes: T[], projectPath: string): T[] {
  const wrapperId = createPaneId('project', projectPath);
  return panes.filter(p => p.id !== wrapperId);
}

// --- Args / Return types ---

export interface UseProjectLayoutArgs {
  projectPath: string;
  topics: Record<string, Topic>;
  initial: PersistedSnapshot | null;
  // External signals:
  focusedPanelId: string | null;
  pendingPane?: PaneType;
  pendingTerminalSessionId?: string;
  pendingTerminalType?: 'shell' | 'claude-code';
  onPendingPaneConsumed?: () => void;
  pendingFocusTopicId?: string | null;
  onPendingFocusConsumed?: () => void;
  // External APIs:
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  claudeSkipPermissions: boolean;
  onFocusPanel: (paneId: string) => void;
  onNewChat?: () => void;
  // Closed-tab undo:
  pushClosedTab: (record: ClosedTabRecord) => void;
  popClosedTab: () => ClosedTabRecord | undefined;
  removeClosedTab: (paneId: string) => void;
  // Reporting:
  onOpenPanesChange?: (paneIds: string[]) => void;
  // Streaming:
  isSessionStreaming: (sk: string) => boolean;
  stopSession: (sk: string) => boolean;
  // For settings modal hop-out:
  onOpenPaneSettings: (topicId: string) => void;
  // Cross-hook gates (read-only here):
  gateRefs: PersistenceGateRefs;
  // Browser navigation outflow — the URL the server (or a local /browser
  // slash command) wants the embedded browser pane to navigate to. The
  // ProjectWindow holds this in component-local state and threads it into
  // `<RemoteBrowserPanel navigateUrl={…} />`. Called from the WS listener
  // installed below.
  onBrowserNavigateUrl?: (url: string) => void;
}

export interface UseProjectLayoutReturn {
  state: {
    panes: Pane[];
    groups: PaneGroup[];
    rows: GroupLayoutRow[];
    rowHeights: number[];
    focusedGroupId: string | null;
    sidebarCollapsed: boolean;
  };
  setters: {
    setRows: Dispatch<SetStateAction<GroupLayoutRow[]>>;
    setRowHeights: Dispatch<SetStateAction<number[]>>;
    setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  };
  refs: {
    panesRef: React.MutableRefObject<Pane[]>;
    groupsRef: React.MutableRefObject<PaneGroup[]>;
    focusedGroupIdRef: React.MutableRefObject<string | null>;
    rowsRef: React.MutableRefObject<GroupLayoutRow[]>;
    rowHeightsRef: React.MutableRefObject<number[]>;
  };
  handlers: {
    activate: (groupId: string, paneId: string) => void;
    /** Soft close — queues a PendingAction toast (3 s countdown). */
    close: (groupId: string, paneId: string) => void;
    /** Immediate close — bypasses the countdown (right-click "Close now"). */
    closeNow: (groupId: string, paneId: string) => void;
    reopenLastClosed: () => Promise<void>;
    addToGroup: (groupId: string, type: PaneType, subType?: string) => Promise<void>;
    addWhenEmpty: (type: PaneType, subType?: string) => Promise<void>;
    reorderGroupPanes: (groupId: string, newPaneIds: string[]) => void;
    moveBetweenGroups: (sourceGroupId: string, targetGroupId: string, paneId: string, insertIdx: number) => void;
    splitGroup: (sourceGroupId: string, paneId: string, targetGroupId: string, edge: 'left' | 'right' | 'top' | 'bottom') => void;
    reorderRows: (newRowOrder: number[]) => void;
    pinPane: (groupId: string, paneId: string) => void;
    /** Single-arg pin: marks a pane non-preview by id. Same state transition
     *  as `pinPane` but for callsites that don't have the groupId handy. */
    pinPaneById: (paneId: string) => void;
    stopStreaming: (paneId: string) => void;
    paneSettings: (paneId: string) => void;
    panePopOut: (paneId: string) => void;
    /** File-event handlers — also wired to window listeners internally. */
    openFile: (path: string) => void;
    openProcessLog: (processId: string, scriptName: string) => void;
    openDiff: (filePath: string, diffProjectPath: string) => void;
  };
  helpers: {
    availableTypesForGroup: (groupType: PaneGroupType, groupId: string) => PaneType[];
  };
  /** Atomic chat-pane diff applied via functional setState updaters.
   *  Order: remove → add → retitle → activateInGroup. */
  applyChatReconciliation: (recon: ChatReconciliation) => void;
  /** Add a chat pane (if missing) and place it into a group via the
   *  fallback chain documented in PLAN section "Hook 2 of 4 / Resolution".
   *  Used by `useProjectChatSync.reopenTopic` in Commit 4. */
  reopenChatPane: (topicId: string, title: string) => void;
}

export function useProjectLayout(args: UseProjectLayoutArgs): UseProjectLayoutReturn {
  const {
    projectPath,
    topics,
    initial,
    focusedPanelId,
    pendingPane,
    pendingTerminalSessionId,
    pendingTerminalType,
    onPendingPaneConsumed,
    pendingFocusTopicId,
    onPendingFocusConsumed,
    onWSMessage,
    claudeSkipPermissions,
    onFocusPanel,
    onNewChat: _onNewChat,
    pushClosedTab,
    popClosedTab,
    removeClosedTab,
    isSessionStreaming: _isSessionStreaming,
    stopSession,
    onOpenPaneSettings,
    onBrowserNavigateUrl,
  } = args;

  // The pane id this ProjectWindow renders under at the parent layout level.
  // Computed once; matches the wrapper id in ProjectWindow.tsx.
  const wrapperPaneId = createPaneId('project', projectPath);

  // --- Core state ---
  const [panes, setPanes] = useState<Pane[]>(() => {
    const seed: Pane[] = stripWrapperPaneId(initial?.nonChatPanes || [], projectPath);
    const seenIds = new Set(seed.map(p => p.id));
    for (const topicId of initial?.openChatTopicIds || []) {
      // Defensive: a utility-pane id (`__agents__`, `__dashboard__`, …)
      // can never be a topic. If a previous buggy build persisted one
      // here it would resurface as a "Topic not found" pane on every
      // reload — drop it on hydrate.
      if (topicId.startsWith('__') && topicId.endsWith('__')) continue;
      // Cross-project leak guard: a previous buggy build may have persisted
      // standalone or foreign-project topics into this project's
      // openChatTopicIds. Drop them on hydrate so they don't resurface as
      // ghost tabs every time the project loads. If the topic is missing
      // from `topics` (still loading or deleted), keep it — useProjectChatSync
      // will handle reconciliation once topics are populated.
      const t = topics[topicId];
      if (t && t.projectPath !== projectPath) continue;
      const id = createPaneId('chat', topicId);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      seed.push({
        id,
        type: 'chat',
        topicId,
        title: topics[topicId]?.name || 'Chat',
        preview: false,
      });
    }
    return seed;
  });
  const [groups, setGroups] = useState<PaneGroup[]>(() => {
    return (initial?.groups || [])
      .map(g => ({ ...g, paneIds: g.paneIds.filter(id => id !== wrapperPaneId) }))
      .filter(g => g.paneIds.length > 0);
  });
  const pendingPreviewCloseRef = useRef<string | null>(null);
  const [rows, setRows] = useState<GroupLayoutRow[]>(() => initial?.rows || []);
  const [rowHeights, setRowHeights] = useState<number[]>(() => initial?.rowHeights || [1]);
  const [focusedGroupId, setFocusedGroupId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (window.innerWidth < 768) return true;
    return initial?.sidebarCollapsed ?? false;
  });

  // --- Ref mirrors (used by stable callbacks + same-effect reads) ---
  const panesRef = useRefMirror(panes);
  const topicsRef = useRefMirror(topics);
  const groupsRef = useRefMirror(groups);
  const focusedGroupIdRef = useRefMirror(focusedGroupId);
  const rowsRef = useRefMirror(rows);
  const rowHeightsRef = useRefMirror(rowHeights);

  // Forward-declared ref so the browser-navigate useEffect (mounted near the
  // top of this hook) can call `handleAddPaneToGroup`, which is itself
  // defined ~500 lines further down. Pure plumbing — no behavior on its own.
  const handleAddPaneToGroupRef = useRef<((groupId: string, type: PaneType, subType?: string) => Promise<void>) | null>(null);

  // Forward-declared ref so the pendingFocusTopicId effect (mounted ~80
  // lines below) can call `reopenChatPane`, which is itself defined
  // ~900 lines further down. Same pattern as handleAddPaneToGroupRef.
  // Without this, the effect was using a thinner `reopenTopicLocal`
  // helper that added the pane to `state.panes` but never placed it in
  // a group → the pane was orphaned (invisible) and focus snapped back
  // to the previously-active pane. `reopenChatPane` has the full
  // fallback chain (focused group → first chat group → create new).
  const reopenChatPaneRef = useRef<((topicId: string, title: string) => void) | null>(null);

  // --- Stop streaming (closes pane locally if first-message stop) ---
  const handleStopStreaming = useCallback((paneId: string) => {
    const pane = panes.find(p => p.id === paneId);
    if (pane?.topicId) {
      const topic = topics[pane.topicId];
      if (topic) {
        const isFirst = stopSession(topic.sessionKey);
        if (isFirst) {
          setPanes(prev => prev.filter(p => p.id !== paneId));
        }
      }
    }
  }, [panes, topics, stopSession]);

  // --- Sync terminal panes: remove stale, auto-add active terminals matching projectPath ---
  useEffect(() => {
    const syncTerminals = (sessions: { id: string; cwd: string; name: string; type: string }[]) => {
      const sessionIds = new Set(sessions.map(s => s.id));
      // Tombstoned session ids are sessions the user just closed in
      // this or another window (persisted in localStorage). Don't
      // auto-add panes for them — otherwise close-then-reload
      // resurrects them indefinitely until the server-side dormant
      // reaper kills the session, which can take much longer than the
      // user's patience.
      const tombstones = getTerminalTombstones();
      // Guard against a "broad" project (e.g. the home dir) whose path is an
      // ancestor of other real projects: by prefix-match it would adopt every
      // claude-code/terminal underneath it, dragging unrelated sessions into
      // this split. If a more specific project exists below us, adopt nothing
      // automatically — those terminals belong to their own project window.
      const isBroadProject = Object.values(topicsRef.current).some(
        t => t.projectPath && t.projectPath.startsWith(projectPath + '/'),
      );
      const projectSessions = isBroadProject ? [] : sessions.filter(
        s => (s.cwd === projectPath || s.cwd.startsWith(projectPath + '/'))
          && !tombstones.has(s.id),
      );
      setPanes(prev => {
        let updated = prev.filter(
          p => p.type !== 'terminal' || sessionIds.has(getTerminalSessionFromPaneId(p.id) || ''),
        );
        const existingTermIds = new Set(
          updated.filter(p => p.type === 'terminal').map(p => getTerminalSessionFromPaneId(p.id)),
        );
        const toAdd: Pane[] = [];
        for (const s of projectSessions) {
          if (existingTermIds.has(s.id)) continue;
          toAdd.push({
            id: `terminal:${s.id}`,
            type: 'terminal' as PaneType,
            title: s.name || (s.type === 'claude-code' ? 'Claude Code' : 'Shell'),
            preview: false,
            terminalType: s.type === 'claude-code' ? 'claude-code' : 'shell',
          });
        }
        if (toAdd.length > 0) updated = [...updated, ...toAdd];
        return updated.length === prev.length && updated.every((p, i) => p === prev[i]) ? prev : updated;
      });
    };

    fetch('/api/terminal/sessions').then(r => r.json()).then(syncTerminals).catch(() => {});

    fetch(`/api/terminal/sessions/dormant?cwd=${encodeURIComponent(projectPath)}`)
      .then(r => r.json())
      .then(async (dormant: { id: string; name: string; cwd: string; type: string }[]) => {
        const tombstones = getTerminalTombstones();
        for (const d of dormant) {
          if (tombstones.has(d.id)) continue;
          try {
            const res = await fetch(`/api/terminal/sessions/${d.id}/revive`, { method: 'POST' });
            if (res.ok) console.log(`[ProjectWindow] Revived dormant session ${d.id} (${d.type})`);
          } catch {}
        }
      })
      .catch(() => {});

    return onWSMessage((msg: WSMessage) => {
      const m = msg as unknown as { type?: string; sessions?: unknown };
      if (m.type === 'terminal:sessions' && Array.isArray(m.sessions)) {
        syncTerminals(m.sessions as { id: string; cwd: string; name: string; type: string }[]);
      }
    });
  }, [onWSMessage, projectPath]);

  // --- Browser-navigate listener (parity with StandaloneChatGroup) -----------
  //
  // When the server (PR #18+#19) or a local `/browser` slash command requests
  // a URL navigation, the canonical broadcast is `{type:"browser:navigate",
  // topicId, url}` over WS plus a `browser:open-and-navigate` CustomEvent on
  // window. Without this hook the bug surfaces: `usePaneOrdering` early-exits
  // when a ProjectWindowPane is open (`hasProjectPaneRef.current → return`),
  // expecting THIS hook to take over — but it never did before. Result: the
  // marker / tool call fires, the broadcast lands, no pane opens.
  //
  // What we do here:
  //   1. Match by topicId: only open a pane when the broadcast targets a
  //      topic visible in this ProjectWindow (any open chat pane bound to it,
  //      or the topic itself living under this projectPath).
  //   2. Ensure exactly one browser pane exists in the focused group
  //      (singleton). If it already exists, focus it; otherwise add it.
  //   3. Push the URL through `onBrowserNavigateUrl(url)` so the component-
  //      level `browserNavigateUrl` state can thread it into
  //      `<RemoteBrowserPanel navigateUrl={…} />`.
  //
  // No retries, no buffering — the URL flows through component state and the
  // panel consumes it via `onNavigateConsumed`. If the broadcast races the
  // pane mount, the navigateUrl prop will be honoured on first render.
  useEffect(() => {
    const ensureBrowserPaneAndNavigate = (url: string) => {
      if (!url) return;
      const fgid = focusedGroupIdRef.current;
      if (!fgid) return;
      const groupPanes = groupsRef.current.find(g => g.id === fgid)?.paneIds || [];
      const existing = panesRef.current.find(
        p => p.type === 'browser' && groupPanes.includes(p.id),
      );
      if (existing) {
        // Pane is already there — just focus + push the URL.
        setGroups(prev =>
          prev.map(g => (g.id === fgid ? { ...g, activePaneId: existing.id } : g)),
        );
      } else {
        // Singleton add — handleAddPaneToGroup handles dedup itself, but we
        // call it after the current render cycle to avoid stomping in-flight
        // state updates.
        queueMicrotask(() => {
          void handleAddPaneToGroupRef.current?.(fgid, 'browser');
        });
      }
      onBrowserNavigateUrl?.(url);
    };

    const topicBelongsToThisProject = (topicId: string | undefined): boolean => {
      if (!topicId) return false;
      // Match if the topic is currently rendered as a chat pane here OR if its
      // projectPath matches ours. The latter handles broadcasts that arrive
      // before the user has explicitly opened the chat pane in this window.
      const inOpenChats = panesRef.current.some(
        p => p.type === 'chat' && p.topicId === topicId,
      );
      if (inOpenChats) return true;
      const t = topics[topicId];
      return !!t && t.projectPath === projectPath;
    };

    const unsubWS = onWSMessage((msg: WSMessage) => {
      const m = msg as unknown as { type?: string; topicId?: string; url?: string };
      if (m.type === 'browser:navigate' && m.url && topicBelongsToThisProject(m.topicId)) {
        ensureBrowserPaneAndNavigate(m.url);
      }
    });

    const domHandler = (e: Event) => {
      const detail = (e as CustomEvent<{ topicId?: string; url?: string }>).detail;
      if (detail?.url && topicBelongsToThisProject(detail.topicId)) {
        ensureBrowserPaneAndNavigate(detail.url);
      }
    };
    window.addEventListener('browser:open-and-navigate', domHandler);

    return () => {
      unsubWS();
      window.removeEventListener('browser:open-and-navigate', domHandler);
    };
    // handleAddPaneToGroupRef is read via ref to avoid re-registering on every
    // render. Deps are the stable identity inputs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onWSMessage, onBrowserNavigateUrl, topics, projectPath]);

  // --- Sync groups with panes (orphan-sync, immutable, no mutations) ---
  useEffect(() => {
    setGroups(prev => {
      const allPaneIds = new Set(panes.map(p => p.id));
      let anyGroupChanged = false;
      let updated = prev.map(g => {
        const filtered = g.paneIds.filter(id => allPaneIds.has(id));
        if (filtered.length === g.paneIds.length) return g;
        anyGroupChanged = true;
        const activePaneId = filtered.includes(g.activePaneId)
          ? g.activePaneId
          : filtered[0] || g.activePaneId;
        return { ...g, paneIds: filtered, activePaneId };
      });
      const beforeFilterLen = updated.length;
      updated = updated.filter(g => g.paneIds.length > 0);
      if (updated.length !== beforeFilterLen) anyGroupChanged = true;

      const paneToGroupIdx = new Map<string, number>();
      for (let i = 0; i < updated.length; i++) {
        for (const pid of updated[i].paneIds) {
          paneToGroupIdx.set(pid, i);
        }
      }

      const orphanPanes = panes.filter(p => !paneToGroupIdx.has(p.id));

      if (!anyGroupChanged && orphanPanes.length === 0) return prev;

      const orphansByType = new Map<PaneGroupType, Pane[]>();
      for (const p of orphanPanes) {
        const gt = paneTypeToGroupType(p.type);
        if (!orphansByType.has(gt)) orphansByType.set(gt, []);
        orphansByType.get(gt)!.push(p);
      }

      const groupIdToIdx = new Map<string, number>();
      for (let i = 0; i < updated.length; i++) {
        groupIdToIdx.set(updated[i].id, i);
      }
      const groupTypeToFirstIdx = new Map<PaneGroupType, number>();
      for (let i = 0; i < updated.length; i++) {
        if (!groupTypeToFirstIdx.has(updated[i].type)) {
          groupTypeToFirstIdx.set(updated[i].type, i);
        }
      }

      const curFocusedGroupId = focusedGroupIdRef.current;
      const focusedIdx = curFocusedGroupId ? groupIdToIdx.get(curFocusedGroupId) : undefined;
      const focusedGroup = focusedIdx !== undefined ? updated[focusedIdx] : null;

      for (const [gt, orphans] of orphansByType) {
        let targetIdx: number | undefined;
        if (focusedGroup?.type === gt) {
          targetIdx = focusedIdx;
        }
        if (targetIdx === undefined) {
          targetIdx = groupTypeToFirstIdx.get(gt);
        }
        if (targetIdx === undefined && focusedIdx !== undefined) {
          targetIdx = focusedIdx;
        }
        if (targetIdx === undefined && updated.length > 0) {
          targetIdx = 0;
        }

        if (targetIdx !== undefined) {
          const tIdx = targetIdx;
          const previewOrphan = orphans.find(o => o.preview);
          if (previewOrphan) {
            const targetGroup = updated[tIdx];
            const existingPreview = findPreviewPane(
              targetGroup.paneIds
                .map(id => panes.find(p => p.id === id))
                .filter((p): p is Pane => !!p && paneTypeToGroupType(p.type) === gt),
              previewOrphan.id,
            );
            if (existingPreview) {
              const newPaneIds = replacePaneInGroup(targetGroup.paneIds, existingPreview.id, previewOrphan.id);
              const otherOrphans = orphans.filter(o => o !== previewOrphan);
              updated = updated.map((g, i) =>
                i === tIdx
                  ? {
                      ...g,
                      paneIds: otherOrphans.length > 0 ? [...newPaneIds, ...otherOrphans.map(p => p.id)] : newPaneIds,
                      activePaneId: previewOrphan.id,
                    }
                  : g,
              );
              if (gt === 'chat' && existingPreview.topicId) {
                pendingPreviewCloseRef.current = existingPreview.topicId;
              }
              continue;
            }
          }
          updated = updated.map((g, i) =>
            i === tIdx ? { ...g, paneIds: [...g.paneIds, ...orphans.map(p => p.id)] } : g,
          );
        } else {
          const newGroup: PaneGroup = {
            id: createGroupId(),
            paneIds: orphans.map(p => p.id),
            activePaneId: orphans[0].id,
            type: gt,
          };
          updated = [...updated, newGroup];
        }
      }

      return updated;
    });
  }, [panes]);

  // --- Sync rows/heights with groups ---
  // Restore-active-chat is owned by `useProjectChatSync` via
  // `applyChatReconciliation.activateInGroup` (Commit 4) — the layout-side
  // effect that used to live here was redundant and has been removed.
  useEffect(() => {
    const curRows = rowsRef.current;
    const allGroupIds = new Set(groups.map(g => g.id));
    let anyRowChanged = false;
    let newRows = curRows.map(r => {
      const filtered = r.groupIds.filter(id => allGroupIds.has(id));
      if (filtered.length === r.groupIds.length) return r;
      anyRowChanged = true;
      const widths = filtered.map(() => 1 / filtered.length);
      return { groupIds: filtered, widths };
    });
    const beforeLen = newRows.length;
    newRows = newRows.filter(r => r.groupIds.length > 0);
    if (newRows.length !== beforeLen) anyRowChanged = true;

    const usedAfterClean = new Set(newRows.flatMap(r => r.groupIds));
    const newGroupIds = groups.filter(g => !usedAfterClean.has(g.id)).map(g => g.id);
    if (newGroupIds.length > 0) {
      anyRowChanged = true;
      if (newRows.length === 0) {
        newRows = [{ groupIds: newGroupIds, widths: newGroupIds.map(() => 1 / newGroupIds.length) }];
      } else {
        const firstRow = newRows[0];
        const all = [...firstRow.groupIds, ...newGroupIds];
        newRows = [{ groupIds: all, widths: all.map(() => 1 / all.length) }, ...newRows.slice(1)];
      }
    }

    if (newRows.length === 0 && groups.length > 0) {
      anyRowChanged = true;
      const gids = groups.map(g => g.id);
      newRows = [{ groupIds: gids, widths: gids.map(() => 1 / gids.length) }];
    }

    if (anyRowChanged) {
      setRows(newRows);
      const curHeights = rowHeightsRef.current;
      if (newRows.length !== curHeights.length) {
        setRowHeights(newRows.map(() => 1 / newRows.length));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  // --- Migration: if no groups but we have panes, build defaults ---
  const migrated = useRef(false);
  useEffect(() => {
    if (migrated.current) return;
    if (groups.length === 0 && panes.length > 0) {
      migrated.current = true;
      const { groups: defaultGroups, rows: defaultRows } = buildDefaultGroups(panesRef.current);
      setGroups(defaultGroups);
      setRows(defaultRows);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length, panes.length]);

  // --- Reopen helper used by external-focus / pending-focus effects ---
  // Mirrors the inline `reopenTopic` in ProjectWindow.tsx (line 781-794):
  // just adds the pane stub if missing; group placement is handled by the
  // calling effect.
  //
  // Refuses to act on ids that don't resolve to a real topic. Without this
  // guard, the external-focus effect below would happily create
  // `chat:__agents__` panes (etc.) when the user clicks an App-level
  // utility tab — those pseudo-ids are NOT colons-prefixed (the only test
  // the caller used to do) so they slipped through and rendered as
  // "Topic not found" inside every open project window.
  const reopenTopicLocal = useCallback(
    (topicId: string) => {
      const topic = topics[topicId];
      if (!topic) return;
      // Cross-project leak guard: a topic that doesn't belong to THIS project
      // (standalone topic, or topic of a different project) must NEVER be
      // injected into this project's inner chat layout. Without this guard,
      // every project's external-focus effect picks up newly-focused topics
      // (e.g. after promoteDraft on a standalone draft) and adds them as
      // chat panes — duplicating the same chat across every open project.
      if (topic.projectPath !== projectPath) return;
      const paneId = createPaneId('chat', topicId);
      setPanes(prev => {
        if (prev.some(p => p.id === paneId)) return prev;
        return [
          ...prev,
          {
            id: paneId,
            type: 'chat' as PaneType,
            topicId,
            title: topic?.name || 'Chat',
            preview: false,
          },
        ];
      });
    },
    [topics, projectPath],
  );

  // --- External focus: when focusedPanelId changes, route to chat pane ---
  // Only act on ids that actually identify a topic. App-level utility
  // panes (`__agents__`, `__dashboard__`, …) and other special pane ids
  // (project / browser / terminal / session-viewer / draft) are not
  // topics and must not trigger an inner chat-pane reopen.
  const lastFocusedPanelRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      focusedPanelId &&
      topics[focusedPanelId] &&
      topics[focusedPanelId].projectPath === projectPath &&
      focusedPanelId !== lastFocusedPanelRef.current
    ) {
      lastFocusedPanelRef.current = focusedPanelId;
      reopenTopicLocal(focusedPanelId);
      const chatPaneId = createPaneId('chat', focusedPanelId);
      const chatPane = panes.find(p => p.id === chatPaneId);
      if (chatPane) {
        const g = groups.find(g => g.paneIds.includes(chatPane.id));
        if (g) {
          setFocusedGroupId(g.id);
          if (g.activePaneId !== chatPane.id) {
            setGroups(prev => {
              const next = prev.map(gg =>
                gg.id === g.id ? { ...gg, activePaneId: chatPane.id } : gg,
              );
              return next.some((gg, i) => gg !== prev[i]) ? next : prev;
            });
          }
        }
      }
    }
  }, [focusedPanelId, topics, projectPath, panes, groups, reopenTopicLocal]);

  // --- Pending focus from external navigation ---
  //
  // Triggered when the App-level layer sets `pendingProjectFocus`
  // (handleQuickCreateTopic, promoteDraft, drag-move-into-project, …). The
  // payload pinpoints which topic should become the active chat pane inside
  // this project window.
  //
  // Previous implementation used `reopenTopicLocal` + an inline group-lookup
  // pass that only worked if the chat pane was already placed in a group.
  // For a freshly-created topic the pane stub was added to `state.panes` but
  // never placed in a group → orphaned/invisible → App-level focus snapped
  // back to whichever pane had it before. Now we delegate to `reopenChatPane`
  // (forward-ref'd at the top of this hook) which already has the full
  // fallback chain: existing-in-group → existing-orphan → fresh add into
  // focused chat group / first chat group / new chat group. The `onPendingFocusConsumed`
  // call fires unconditionally on the next tick so the App-level dispatcher
  // never gets stuck in a loop.
  useEffect(() => {
    if (!pendingFocusTopicId) return;
    const t = topics[pendingFocusTopicId];
    if (!t || t.projectPath !== projectPath) {
      // Cross-project: not for us. Consume to break the App-level loop.
      onPendingFocusConsumed?.();
      return;
    }
    reopenChatPaneRef.current?.(pendingFocusTopicId, t.name || 'Chat');
    onPendingFocusConsumed?.();
  }, [pendingFocusTopicId, topics, projectPath, onPendingFocusConsumed]);

  // --- Default focused group ---
  useEffect(() => {
    const focusedExists = focusedGroupId && groups.some(g => g.id === focusedGroupId);
    if (!focusedExists && groups.length > 0) {
      const chatGroup = groups.find(g => g.type === 'chat');
      setFocusedGroupId((chatGroup || groups[0]).id);
    }
  }, [focusedGroupId, groups]);

  // --- Handlers ---

  const handleActivatePane = useCallback(
    (groupId: string, paneId: string) => {
      setFocusedGroupId(groupId);
      setGroups(prev => prev.map(g => (g.id === groupId ? { ...g, activePaneId: paneId } : g)));
      onFocusPanel(wrapperPaneId);
    },
    [onFocusPanel, wrapperPaneId],
  );

  // Inner workhorse — performs the actual close (state mutations + undo
  // record). Called either directly (from `handleClosePaneImmediate`, the
  // bypass path used by right-click "Close now") or by the deferred path
  // after the 3 s pending-action countdown elapses without cancellation.
  const handleClosePaneNow = useCallback(
    (groupId: string, paneId: string) => {
      const pane = panes.find(p => p.id === paneId);
      const group = groups.find(g => g.id === groupId);
      const groupIndex = group ? group.paneIds.indexOf(paneId) : 0;

      if (pane) {
        const record = captureClosedTab(pane, groupId, groupIndex, 'project', {
          projectPath,
          terminal:
            pane.type === 'terminal'
              ? {
                  sessionType: pane.terminalType || 'shell',
                  cwd: projectPath,
                  name: pane.title || 'Terminal',
                  skipPermissions: true,
                }
              : undefined,
        });

        if (pane.type === 'terminal') {
          const sessionId = getTerminalSessionFromPaneId(paneId);
          if (sessionId) {
            // Tombstone the session id IMMEDIATELY (persisted in
            // localStorage). The mount-time terminal-sync effect skips
            // tombstoned ids, so a reload before the cleanup timer fires
            // can no longer resurrect this terminal as a phantom pane.
            addTerminalTombstone(sessionId);
            scheduleTerminalCleanup(record.id, 60_000, () => {
              fetch(`/api/terminal/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
              clearTerminalTombstone(sessionId);
            });
          }
        } else if (pane.type === 'browser') {
          // Tear down the server-side Playwright context that backs this
          // pane. Without this, the BrowserService context survives the
          // close and `browser-state-store` keeps its on-disk partition.
          // Net effect: a subsequent mount of `<RemoteBrowserPanel
          // contextId={projectPath} />` (e.g. the user re-opens the
          // project on next load, or the WS browser:navigate listener in
          // this hook fires again) calls `useNativeBrowser.create`, finds
          // the persisted context, and the closed tab "comes back" —
          // exactly the bug the top-level path at
          // `usePaneLifecycle.handleClosePane:60-79` fixes for the
          // StandaloneChatGroup case. Mirror that fix here. The contextId
          // in a project window is always the projectPath (see
          // `RemoteBrowserPanel contextId={projectPath}` in
          // ProjectWindow.tsx). No tombstone is needed because the pane
          // is only re-created via an explicit user action or a new
          // server-driven `browser:navigate` broadcast.
          fetch(`/api/browsers/${encodeURIComponent(projectPath)}`, { method: 'DELETE' }).catch(() => {});
        }

        pushClosedTab(record);

        const capturedRecord = record;
        pushUndo({
          description: `Close ${pane.title || pane.type}`,
          undo: async () => {
            const restored = await reopenClosedTab(capturedRecord);
            setPanes(prev => [...prev, restored]);
            setGroups(prev => {
              const target = prev.find(g => g.id === capturedRecord.groupId) || prev[0];
              if (!target) return prev;
              const idx = Math.min(capturedRecord.groupIndex, target.paneIds.length);
              const newIds = [...target.paneIds];
              newIds.splice(idx, 0, restored.id);
              return prev.map(g =>
                g.id === target.id ? { ...g, paneIds: newIds, activePaneId: restored.id } : g,
              );
            });
            removeClosedTab(capturedRecord.id);
          },
          redo: () => {
            handleClosePane(capturedRecord.groupId, capturedRecord.pane.id);
          },
        });
      }

      setPanes(prev => prev.filter(p => p.id !== paneId));

      setGroups(prev => {
        return prev
          .map(g => {
            if (g.id !== groupId) return g;
            const remaining = g.paneIds.filter(id => id !== paneId);
            if (remaining.length === 0) return { ...g, paneIds: [] };
            const newActive =
              g.activePaneId === paneId
                ? remaining[Math.min(g.paneIds.indexOf(paneId), remaining.length - 1)]
                : g.activePaneId;
            return { ...g, paneIds: remaining, activePaneId: newActive };
          })
          .filter(g => g.paneIds.length > 0);
      });
    },
    [panes, groups, projectPath, pushClosedTab, removeClosedTab],
  );

  // Deferred close — the default (UI X-click) path. Queues a PendingAction
  // entry AND auto-ticks it so the 3 s countdown starts on the very first
  // click of the empty-circle "mark as done" affordance (mirrors App.tsx's
  // `enqueueAndTick` for top-level tabs). Without the tick the entry sits
  // pending forever — icon flips to the check, the L→R bar paints, but
  // the commit setTimeout is never scheduled and the pane never actually
  // closes. Right-click "Close now" calls `handleClosePaneNow` directly.
  const handleClosePane = useCallback(
    (groupId: string, paneId: string) => {
      const pane = panes.find(p => p.id === paneId);
      if (!pane) return;
      const key = `close-tab:${paneId}`;
      // Resolve the accent color the progress overlay should tint with.
      // Chat panes have a per-topic color (matches the chat list dot);
      // terminal / browser / file panes have no per-pane color, so we
      // fall through to undefined and the overlay uses `currentColor` at
      // 14% opacity (still visible because the tab text colour contrasts
      // the tab background). Mirrors what handleClosePanelDeferred at
      // App.tsx already does for top-level chat tabs — without this,
      // terminal/browser closes in the project window painted with the
      // generic colour and looked "less animated" than chat closes,
      // which the user reported as "le tab shell non si animano".
      const topic = pane.topicId ? topics[pane.topicId] : undefined;
      const color = pane.color || topic?.color;

      // Pre-shift the group's active pane to the tab that handleClosePaneNow
      // will pick on commit (line 829: same-index, clamped to last remaining).
      // Lets the user see the destination while the 3s progress runs. Skip
      // when this isn't the active pane of its group (closing a background
      // tab must not steal focus).
      const targetGroup = groups.find(g => g.id === groupId);
      let activeBeforeClose: string | null = null;
      if (targetGroup && targetGroup.activePaneId === paneId) {
        const remaining = targetGroup.paneIds.filter(id => id !== paneId);
        if (remaining.length > 0) {
          const idx = targetGroup.paneIds.indexOf(paneId);
          const nextActive = remaining[Math.min(idx, remaining.length - 1)];
          activeBeforeClose = paneId;
          setGroups(prev =>
            prev.map(g => (g.id === groupId ? { ...g, activePaneId: nextActive } : g)),
          );
        }
      }

      enqueuePendingAction({
        key,
        kind: 'close-tab',
        label: pane.title || pane.type,
        ...(color ? { color } : {}),
        commit: () => handleClosePaneNow(groupId, paneId),
        // Restore active pane if the user cancels before the countdown ends.
        // Only when we actually shifted, otherwise this becomes a spurious
        // refocus that fights other user navigation during the 3 s window.
        onCancel: activeBeforeClose
          ? () => {
              setGroups(prev =>
                prev.map(g =>
                  g.id === groupId && g.paneIds.includes(activeBeforeClose!)
                    ? { ...g, activePaneId: activeBeforeClose! }
                    : g,
                ),
              );
            }
          : undefined,
      });
      tickPendingAction(key);
    },
    [panes, topics, handleClosePaneNow, groups],
  );

  const handleReopenLastClosed = useCallback(async () => {
    const record = popClosedTab();
    if (!record) return;
    try {
      const pane = await reopenClosedTab(record);
      setPanes(prev => [...prev, pane]);
      setGroups(prev => {
        const targetGroup = prev.find(g => g.id === record.groupId) || prev[0];
        if (!targetGroup) return prev;
        const insertIdx = Math.min(record.groupIndex, targetGroup.paneIds.length);
        const newPaneIds = [...targetGroup.paneIds];
        newPaneIds.splice(insertIdx, 0, pane.id);
        return prev.map(g =>
          g.id === targetGroup.id ? { ...g, paneIds: newPaneIds, activePaneId: pane.id } : g,
        );
      });
    } catch (err) {
      console.warn('[ProjectWindow] Failed to reopen closed tab:', err);
    }
  }, [popClosedTab]);

  // Listen for Cmd+Shift+T to reopen last closed tab
  useEffect(() => {
    const handler = () => {
      handleReopenLastClosed();
    };
    window.addEventListener('reopen-closed-tab', handler);
    return () => window.removeEventListener('reopen-closed-tab', handler);
  }, [handleReopenLastClosed]);

  // Listen for Cmd+W → close-focused-pane: when this project is the App-
  // focused panel, close its inner active sub-tab instead of letting the
  // App-level handler close the whole project. preventDefault marks the
  // event handled so App falls through.
  const handleClosePaneRef = useRef<((groupId: string, paneId: string) => void) | null>(null);
  handleClosePaneRef.current = handleClosePane;
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ panelId?: string }>;
      if (ce.detail?.panelId !== wrapperPaneId) return;
      const fgid = focusedGroupIdRef.current;
      if (!fgid) return;
      const group = groupsRef.current.find(g => g.id === fgid);
      if (!group?.activePaneId) return;
      ce.preventDefault();
      handleClosePaneRef.current?.(fgid, group.activePaneId);
    };
    window.addEventListener('close-focused-pane', handler);
    return () => window.removeEventListener('close-focused-pane', handler);
  }, [wrapperPaneId]);

  const handleAddPaneToGroup = useCallback(
    async (groupId: string, type: PaneType, subType?: string) => {
      const config = getPaneConfig(type);
      if (config.singleton) {
        const targetGroup = groups.find(g => g.id === groupId);
        const groupPaneIds = new Set(targetGroup?.paneIds || []);
        const existingInGroup = panes.find(p => p.type === type && groupPaneIds.has(p.id));
        if (existingInGroup) {
          setFocusedGroupId(groupId);
          setGroups(prev =>
            prev.map(gg => (gg.id === groupId ? { ...gg, activePaneId: existingInGroup.id } : gg)),
          );
          return;
        }
      }

      let paneId: string;
      let paneTitle: string;

      if (type === 'terminal') {
        const termType = subType === 'claude-code' ? 'claude-code' : 'shell';
        paneTitle = termType === 'claude-code' ? 'Claude Code' : 'Shell';
        try {
          const body: Record<string, unknown> = { cwd: projectPath, type: termType, name: paneTitle };
          if (termType === 'claude-code') body.skipPermissions = claudeSkipPermissions;
          const res = await fetch('/api/terminal/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) return;
          const data = await res.json();
          paneId = createPaneId('terminal', data.id);
          paneTitle = data.name || paneTitle;
        } catch {
          return;
        }
      } else {
        paneId = createPaneId(type);
        paneTitle = config.label;
      }

      const newPane: Pane = {
        id: paneId,
        type,
        title: paneTitle,
        preview: type === 'terminal' ? false : true,
        ...(type === 'terminal' && subType ? { terminalType: subType as 'shell' | 'claude-code' } : {}),
      };

      const targetGroup = groups.find(g => g.id === groupId);
      const groupPanes =
        targetGroup?.paneIds.map(id => panes.find(p => p.id === id)).filter((p): p is Pane => !!p) || [];
      const existingPreview =
        type !== 'terminal' ? findPreviewPane(groupPanes.filter(p => p.type === type), newPane.id) : null;

      if (existingPreview) {
        setPanes(prev => prev.map(p => (p.id === existingPreview.id ? newPane : p)));
        setGroups(prev =>
          prev.map(g =>
            g.id === groupId
              ? {
                  ...g,
                  paneIds: replacePaneInGroup(g.paneIds, existingPreview.id, newPane.id),
                  activePaneId: newPane.id,
                }
              : g,
          ),
        );
      } else {
        setPanes(prev => (prev.some(p => p.id === newPane.id) ? prev : [...prev, newPane]));
        setGroups(prev => {
          const result = prev
            .map(g => {
              if (g.id === groupId) {
                return {
                  ...g,
                  paneIds: g.paneIds.includes(newPane.id) ? g.paneIds : [...g.paneIds, newPane.id],
                  activePaneId: newPane.id,
                };
              }
              if (g.paneIds.includes(newPane.id)) {
                const filtered = g.paneIds.filter(id => id !== newPane.id);
                return {
                  ...g,
                  paneIds: filtered,
                  activePaneId:
                    g.activePaneId === newPane.id ? filtered[0] || g.activePaneId : g.activePaneId,
                };
              }
              return g;
            })
            .filter(g => g.paneIds.length > 0);
          return result;
        });
      }
      setFocusedGroupId(groupId);
    },
    [panes, groups, projectPath, claudeSkipPermissions],
  );

  // Pin the latest handleAddPaneToGroup into the forward-declared ref so the
  // browser-navigate listener (mounted earlier in this hook) can invoke it
  // without needing to be re-registered every render.
  handleAddPaneToGroupRef.current = handleAddPaneToGroup;

  const handleAddPaneWhenEmpty = useCallback(
    async (type: PaneType, subType?: string) => {
      const config = PANE_CONFIG[type];
      if (!config || config.fixed) return;

      let paneId: string;
      let paneTitle: string;

      if (type === 'terminal') {
        const termType = subType === 'claude-code' ? 'claude-code' : 'shell';
        paneTitle = termType === 'claude-code' ? 'Claude Code' : 'Shell';
        try {
          const body: Record<string, unknown> = { cwd: projectPath, type: termType, name: paneTitle };
          if (termType === 'claude-code') body.skipPermissions = claudeSkipPermissions;
          const res = await fetch('/api/terminal/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) return;
          const data = await res.json();
          paneId = createPaneId('terminal', data.id);
          paneTitle = data.name || paneTitle;
        } catch {
          return;
        }
      } else {
        paneId = createPaneId(type);
        paneTitle = config.label;
      }

      const newGroupId = createGroupId();
      const newPane: Pane = {
        id: paneId,
        type,
        title: paneTitle,
        preview: false,
        ...(type === 'terminal' && subType ? { terminalType: subType as 'shell' | 'claude-code' } : {}),
      };
      const newGroup: PaneGroup = {
        id: newGroupId,
        type: paneTypeToGroupType(type),
        paneIds: [newPane.id],
        activePaneId: newPane.id,
      };
      setPanes(prev => (prev.some(p => p.id === newPane.id) ? prev : [...prev, newPane]));
      setGroups(prev => {
        const cleaned = prev
          .map(g => {
            if (!g.paneIds.includes(newPane.id)) return g;
            const filtered = g.paneIds.filter(id => id !== newPane.id);
            return {
              ...g,
              paneIds: filtered,
              activePaneId:
                g.activePaneId === newPane.id ? filtered[0] || g.activePaneId : g.activePaneId,
            };
          })
          .filter(g => g.paneIds.length > 0);
        return [...cleaned, newGroup];
      });
      setFocusedGroupId(newGroupId);
    },
    [projectPath, claudeSkipPermissions],
  );

  // --- Pending pane request from sidebar ---
  useEffect(() => {
    if (pendingPane) {
      if (pendingPane === 'terminal' && pendingTerminalSessionId) {
        const paneId = createPaneId('terminal', pendingTerminalSessionId);
        const existing = panes.find(p => p.id === paneId);
        if (existing) {
          const g = groups.find(g => g.paneIds.includes(paneId));
          if (g) {
            setFocusedGroupId(g.id);
            setGroups(prev => prev.map(gg => (gg.id === g.id ? { ...gg, activePaneId: paneId } : gg)));
          }
        } else {
          const newPane: Pane = { id: paneId, type: 'terminal', title: 'Terminal', preview: false };
          setPanes(prev => (prev.some(p => p.id === paneId) ? prev : [...prev, newPane]));
          const targetGroupId = focusedGroupId || groups[0]?.id;
          if (targetGroupId) {
            setFocusedGroupId(targetGroupId);
            setGroups(prev =>
              prev
                .map(g => {
                  if (g.id === targetGroupId) {
                    return {
                      ...g,
                      paneIds: g.paneIds.includes(paneId) ? g.paneIds : [...g.paneIds, paneId],
                      activePaneId: paneId,
                    };
                  }
                  if (g.paneIds.includes(paneId)) {
                    const filtered = g.paneIds.filter(id => id !== paneId);
                    return {
                      ...g,
                      paneIds: filtered,
                      activePaneId:
                        g.activePaneId === paneId ? filtered[0] || g.activePaneId : g.activePaneId,
                    };
                  }
                  return g;
                })
                .filter(g => g.paneIds.length > 0),
            );
          }
        }
        onPendingPaneConsumed?.();
        return;
      }
      const targetGroupId = focusedGroupId || groups[0]?.id;
      const subType = pendingPane === 'terminal' ? pendingTerminalType : undefined;
      if (targetGroupId) {
        handleAddPaneToGroup(targetGroupId, pendingPane, subType);
      } else {
        handleAddPaneWhenEmpty(pendingPane, subType);
      }
      onPendingPaneConsumed?.();
    }
  }, [
    pendingPane,
    pendingTerminalSessionId,
    pendingTerminalType,
    groups,
    focusedGroupId,
    panes,
    handleAddPaneToGroup,
    handleAddPaneWhenEmpty,
    onPendingPaneConsumed,
  ]);

  // --- File-event handlers (refs-only — stable) ---

  const handleOpenFile = useCallback((path: string) => {
    const curPanes = panesRef.current;
    const curGroups = groupsRef.current;
    const curFocused = focusedGroupIdRef.current;

    const existing = curPanes.find(p => p.type === 'file' && p.filePath === path);
    if (existing) {
      const g = curGroups.find(g => g.paneIds.includes(existing.id));
      if (g) {
        setFocusedGroupId(g.id);
        setGroups(prev =>
          prev.map(gg => (gg.id === g.id ? { ...gg, activePaneId: existing.id } : gg)),
        );
      }
      return;
    }

    const filename = basename(path) || path;
    const newPane: Pane = {
      id: createPaneId('file'),
      type: 'file',
      filePath: path,
      title: filename,
      preview: true,
    };

    const targetGroup = (curFocused ? curGroups.find(g => g.id === curFocused) : null) || curGroups[0];
    if (!targetGroup) {
      setPanes(prev => [...prev, newPane]);
      return;
    }

    const groupPanes = targetGroup.paneIds
      .map(id => curPanes.find(p => p.id === id))
      .filter((p): p is Pane => !!p);
    const existingPreview = findPreviewPane(groupPanes.filter(p => p.type === 'file'), newPane.id);

    if (existingPreview) {
      setPanes(prev => prev.map(p => (p.id === existingPreview.id ? newPane : p)));
      setGroups(prev =>
        prev.map(g =>
          g.id === targetGroup.id
            ? {
                ...g,
                paneIds: replacePaneInGroup(g.paneIds, existingPreview.id, newPane.id),
                activePaneId: newPane.id,
              }
            : g,
        ),
      );
    } else {
      setPanes(prev => [...prev, newPane]);
      setGroups(prev =>
        prev.map(g =>
          g.id === targetGroup.id
            ? { ...g, paneIds: [...g.paneIds, newPane.id], activePaneId: newPane.id }
            : g,
        ),
      );
    }
    setFocusedGroupId(targetGroup.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpenProcessLog = useCallback((processId: string, scriptName: string) => {
    const curPanes = panesRef.current;
    const curGroups = groupsRef.current;
    const curFocused = focusedGroupIdRef.current;

    const paneKey = `process-log:${processId}`;
    const existing = curPanes.find(p => p.id === paneKey);
    if (existing) {
      const g = curGroups.find(g => g.paneIds.includes(existing.id));
      if (g) {
        setFocusedGroupId(g.id);
        setGroups(prev =>
          prev.map(gg => (gg.id === g.id ? { ...gg, activePaneId: existing.id } : gg)),
        );
      }
      return;
    }

    const newPane: Pane = {
      id: paneKey,
      type: 'process-log',
      processId,
      title: scriptName,
    };

    const targetGroup = (curFocused ? curGroups.find(g => g.id === curFocused) : null) || curGroups[0];
    if (!targetGroup) {
      setPanes(prev => [...prev, newPane]);
      return;
    }

    setPanes(prev => [...prev, newPane]);
    setGroups(prev =>
      prev.map(g =>
        g.id === targetGroup.id
          ? { ...g, paneIds: [...g.paneIds, newPane.id], activePaneId: newPane.id }
          : g,
      ),
    );
    setFocusedGroupId(targetGroup.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rewritten to refs-only (matches handleOpenFile pattern). Per VERIFY Q4.
  const handleOpenDiff = useCallback((filePath: string, diffProjectPath: string) => {
    const curPanes = panesRef.current;
    const curGroups = groupsRef.current;
    const curFocused = focusedGroupIdRef.current;

    const diffKey = `diff:${filePath}`;
    const existing = curPanes.find(p => p.type === 'file' && p.id === diffKey);
    if (existing) {
      const g = curGroups.find(g => g.paneIds.includes(existing.id));
      if (g) {
        setFocusedGroupId(g.id);
        setGroups(prev =>
          prev.map(gg => (gg.id === g.id ? { ...gg, activePaneId: existing.id } : gg)),
        );
      }
      return;
    }

    const filename = basename(filePath) || filePath;
    const fullPath = `${diffProjectPath}/${filePath}`;
    const newPane: Pane = {
      id: diffKey,
      type: 'file',
      filePath: fullPath,
      title: `${filename} (diff)`,
      diff: true,
      diffProjectPath,
      preview: true,
    };

    const targetGroup = (curFocused ? curGroups.find(g => g.id === curFocused) : null) || curGroups[0];
    if (!targetGroup) {
      setPanes(prev => [...prev, newPane]);
      return;
    }

    const groupPanes = targetGroup.paneIds
      .map(id => curPanes.find(p => p.id === id))
      .filter((p): p is Pane => !!p);
    const existingPreview = findPreviewPane(groupPanes.filter(p => p.type === 'file'), newPane.id);

    if (existingPreview) {
      setPanes(prev => prev.map(p => (p.id === existingPreview.id ? newPane : p)));
      setGroups(prev =>
        prev.map(g =>
          g.id === targetGroup.id
            ? {
                ...g,
                paneIds: replacePaneInGroup(g.paneIds, existingPreview.id, newPane.id),
                activePaneId: newPane.id,
              }
            : g,
        ),
      );
    } else {
      setPanes(prev => [...prev, newPane]);
      setGroups(prev =>
        prev.map(g =>
          g.id === targetGroup.id
            ? { ...g, paneIds: [...g.paneIds, newPane.id], activePaneId: newPane.id }
            : g,
        ),
      );
    }
    setFocusedGroupId(targetGroup.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- File-event listeners ---

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { path?: string };
      if (detail?.path) handleOpenFile(detail.path);
    };
    window.addEventListener('open-file', handler);
    return () => window.removeEventListener('open-file', handler);
  }, [handleOpenFile]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { filePath: string; projectPath: string };
      handleOpenDiff(detail.filePath, detail.projectPath);
    };
    window.addEventListener('open-file-diff', handler);
    return () => window.removeEventListener('open-file-diff', handler);
  }, [handleOpenDiff]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { path?: string };
      const path = detail?.path;
      setPanes(prev =>
        prev.map(p => (p.type === 'file' && p.filePath === path ? { ...p, preview: false } : p)),
      );
    };
    window.addEventListener('pin-file-pane', handler);
    return () => window.removeEventListener('pin-file-pane', handler);
  }, []);

  // --- Close replaced preview pane ---
  useEffect(() => {
    if (pendingPreviewCloseRef.current) {
      const id = pendingPreviewCloseRef.current;
      pendingPreviewCloseRef.current = null;
      setPanes(prev => prev.filter(p => !(p.type === 'chat' && p.topicId === id)));
    }
  });

  // --- Pin / settings / pop-out ---

  const handlePinPane = useCallback((_groupId: string, paneId: string) => {
    setPanes(prev => prev.map(p => (p.id === paneId ? { ...p, preview: false } : p)));
  }, []);

  // Single-arg variant of `handlePinPane` for callsites that don't have a
  // groupId handy (e.g. renderPane preview-pin in ProjectWindow). Produces
  // the SAME state transition as the inline `setPanes(prev => prev.map(...))`
  // it replaces.
  const pinPaneById = useCallback((paneId: string) => {
    setPanes(prev => prev.map(p => (p.id === paneId ? { ...p, preview: false } : p)));
  }, []);

  const handlePaneSettings = useCallback(
    (paneId: string) => {
      const pane = panes.find(p => p.id === paneId);
      if (pane?.topicId) onOpenPaneSettings(pane.topicId);
    },
    [panes, onOpenPaneSettings],
  );

  const handlePanePopOut = useCallback(
    (paneId: string) => {
      const pane = panes.find(p => p.id === paneId);
      if (!pane?.topicId) return;
      const url = `${window.location.origin}?topic=${pane.topicId}`;
      isNativeApp
        ? window.open(url, `topic-${pane.topicId}`, 'width=900,height=700')
        : window.open(url, `topic-${pane.topicId}`);
      setPanes(prev => prev.filter(p => p.id !== paneId));
    },
    [panes],
  );

  // --- Reorder + move + split ---

  const handleReorderGroupPanes = useCallback((groupId: string, newPaneIds: string[]) => {
    setGroups(prev => prev.map(g => (g.id === groupId ? { ...g, paneIds: newPaneIds } : g)));
  }, []);

  const handleMovePaneBetweenGroups = useCallback(
    (sourceGroupId: string, targetGroupId: string, paneId: string, insertIdx: number) => {
      setGroups(prev => {
        const sourceGroup = prev.find(g => g.id === sourceGroupId);
        const targetGroup = prev.find(g => g.id === targetGroupId);
        if (!sourceGroup || !targetGroup) return prev;
        if (!sourceGroup.paneIds.includes(paneId)) return prev;

        return prev
          .map(g => {
            if (g.id === sourceGroupId) {
              const remaining = g.paneIds.filter(id => id !== paneId);
              const newActive =
                remaining.length > 0
                  ? g.activePaneId === paneId
                    ? remaining[Math.min(g.paneIds.indexOf(paneId), remaining.length - 1)]
                    : g.activePaneId
                  : g.activePaneId;
              return { ...g, paneIds: remaining, activePaneId: newActive };
            }
            if (g.id === targetGroupId) {
              const newPaneIds = [...g.paneIds];
              newPaneIds.splice(Math.max(0, Math.min(insertIdx, newPaneIds.length)), 0, paneId);
              return { ...g, paneIds: newPaneIds, activePaneId: paneId };
            }
            return g;
          })
          .filter(g => g.paneIds.length > 0);
      });
      setFocusedGroupId(targetGroupId);
    },
    [],
  );

  const handleSplitGroup = useCallback(
    (
      sourceGroupId: string,
      paneId: string,
      targetGroupId: string,
      edge: 'left' | 'right' | 'top' | 'bottom',
    ) => {
      const pane = panes.find(p => p.id === paneId);
      if (!pane) return;

      if (sourceGroupId === targetGroupId) {
        const sourceGroup = groups.find(g => g.id === sourceGroupId);
        if (sourceGroup && sourceGroup.paneIds.length <= 1) {
          if (typeof console !== 'undefined') {
            console.warn(
              '[ProjectWindow] split-into-self with single-pane source is a no-op; ' +
                'use the "+" menu to add a new pane, then drag-drop on edge to split.',
            );
          }
          return;
        }
      }

      const newGroupId = createGroupId();
      const newGroup: PaneGroup = {
        id: newGroupId,
        paneIds: [paneId],
        activePaneId: paneId,
        type: paneTypeToGroupType(pane.type),
      };

      setGroups(prev => {
        const updated = prev
          .map(g => {
            if (g.id === sourceGroupId) {
              const remaining = g.paneIds.filter(id => id !== paneId);
              const newActive =
                remaining.length > 0
                  ? g.activePaneId === paneId
                    ? remaining[Math.min(g.paneIds.indexOf(paneId), remaining.length - 1)]
                    : g.activePaneId
                  : g.activePaneId;
              return { ...g, paneIds: remaining, activePaneId: newActive };
            }
            return g;
          })
          .filter(g => g.paneIds.length > 0);
        return [...updated, newGroup];
      });

      setRows(prev => {
        if (edge === 'left' || edge === 'right') {
          return prev.map(row => {
            const targetIdx = row.groupIds.indexOf(targetGroupId);
            if (targetIdx === -1) return row;
            const newGroupIds = [...row.groupIds];
            const insertAt = edge === 'left' ? targetIdx : targetIdx + 1;
            newGroupIds.splice(insertAt, 0, newGroupId);
            const newWidths = newGroupIds.map(() => 1 / newGroupIds.length);
            return { groupIds: newGroupIds, widths: newWidths };
          });
        } else {
          const targetRowIdx = prev.findIndex(row => row.groupIds.includes(targetGroupId));
          if (targetRowIdx === -1) return prev;
          const newRow = { groupIds: [newGroupId], widths: [1] };
          const newRows = [...prev];
          const insertAt = edge === 'top' ? targetRowIdx : targetRowIdx + 1;
          newRows.splice(insertAt, 0, newRow);
          setRowHeights(prevH => {
            const newHeights = [...prevH];
            const halfHeight = (newHeights[targetRowIdx] || 1 / prevH.length) / 2;
            newHeights[targetRowIdx] = halfHeight;
            newHeights.splice(insertAt, 0, halfHeight);
            return newHeights;
          });
          return newRows;
        }
      });

      setFocusedGroupId(newGroupId);
    },
    [panes, groups],
  );

  const handleReorderRows = useCallback((newRowOrder: number[]) => {
    setRows(prev => {
      const newRows = newRowOrder.map(i => prev[i]).filter(Boolean);
      return newRows;
    });
    setRowHeights(prev => {
      const newHeights = newRowOrder.map(i => prev[i]).filter(h => h !== undefined);
      return newHeights;
    });
  }, []);

  const availableTypesForGroup = useCallback(
    (_groupType: PaneGroupType, groupId: string): PaneType[] => {
      // Single source of truth — `addableScopes: ['project']` in PANE_CONFIG.
      // Previously this list was hardcoded ['browser','terminal','git','board-memory']
      // (+ 'files' only inside a 'file' group), which drifted from the
      // standalone tab bar's hardcoded list and made adding a new pane type
      // require edits in 3 places. The group-level singleton filter below is
      // still required: PaneConfig.singleton is global, but a project can
      // legitimately have e.g. one Git pane per group.
      const targetGroup = groups.find(g => g.id === groupId);
      const groupPaneIds = new Set(targetGroup?.paneIds || []);
      const presentInGroup = new Set<PaneType>();
      for (const p of panes) if (groupPaneIds.has(p.id)) presentInGroup.add(p.type);
      return getAddableTypesForScope('project', presentInGroup);
    },
    [panes, groups],
  );

  // --- applyChatReconciliation (used by useProjectChatSync in Commit 4) ---
  const applyChatReconciliation = useCallback((recon: ChatReconciliation) => {
    const { add, remove, retitle, activateInGroup } = recon;

    setPanes(prev => {
      const removed = remove.length === 0 ? prev : prev.filter(p => !remove.includes(p.id));
      const retitled =
        retitle.size === 0
          ? removed
          : removed.map(p => (retitle.has(p.id) ? { ...p, title: retitle.get(p.id)! } : p));
      if (add.length === 0) return retitled;
      const seen = new Set(retitled.map(p => p.id));
      const merged = [...retitled];
      for (const p of add) if (!seen.has(p.id)) merged.push(p);
      return merged;
    });

    if (remove.length > 0) {
      setGroups(prev =>
        prev
          .map(g => ({ ...g, paneIds: g.paneIds.filter(id => !remove.includes(id)) }))
          .filter(g => g.paneIds.length > 0),
      );
    }

    if (activateInGroup) {
      const { groupId, paneId } = activateInGroup;
      setGroups(prev => {
        const next = prev.map(g => (g.id === groupId ? { ...g, activePaneId: paneId } : g));
        return next.some((g, i) => g !== prev[i]) ? next : prev;
      });
      setFocusedGroupId(groupId);
    }
  }, []);

  // --- reopenChatPane: add stub + place in group via fallback chain ---
  // Used by `useProjectChatSync.reopenTopic` in Commit 4. Unused this commit.
  const reopenChatPane = useCallback(
    (topicId: string, title: string) => {
      const paneId = createPaneId('chat', topicId);

      // 1) Already exists AND already in a group? Just focus its group.
      // If it exists in `panes` but not in any group (orphan — happens when
      // chat-sync added the pane just before this call, before orphan-sync
      // could place it), fall through to step 3 and place + focus.
      const existing = panesRef.current.find(p => p.id === paneId);
      if (existing) {
        const g = groupsRef.current.find(g => g.paneIds.includes(paneId));
        if (g) {
          setFocusedGroupId(g.id);
          setGroups(prev =>
            prev.map(gg => (gg.id === g.id ? { ...gg, activePaneId: paneId } : gg)),
          );
          return;
        }
        // Orphan pane — fall through to placement (skip step 2 add).
      }

      // 2) Add the pane stub (skip if it already exists as orphan).
      if (!existing) {
        const newPane: Pane = {
          id: paneId,
          type: 'chat',
          topicId,
          title,
          preview: false,
        };
        setPanes(prev => (prev.some(p => p.id === paneId) ? prev : [...prev, newPane]));
      }

      // 3) Place in a chat group via fallback chain.
      const curGroups = groupsRef.current;
      const curFocusedId = focusedGroupIdRef.current;
      const focusedGroup = curFocusedId ? curGroups.find(g => g.id === curFocusedId) : null;

      if (focusedGroup && focusedGroup.type === 'chat') {
        setGroups(prev =>
          prev.map(g =>
            g.id === focusedGroup.id
              ? {
                  ...g,
                  paneIds: g.paneIds.includes(paneId) ? g.paneIds : [...g.paneIds, paneId],
                  activePaneId: paneId,
                }
              : g,
          ),
        );
        setFocusedGroupId(focusedGroup.id);
        return;
      }

      const firstChatGroup = curGroups.find(g => g.type === 'chat');
      if (firstChatGroup) {
        setGroups(prev =>
          prev.map(g =>
            g.id === firstChatGroup.id
              ? {
                  ...g,
                  paneIds: g.paneIds.includes(paneId) ? g.paneIds : [...g.paneIds, paneId],
                  activePaneId: paneId,
                }
              : g,
          ),
        );
        setFocusedGroupId(firstChatGroup.id);
        return;
      }

      // No chat group exists — create one and add it to the first row
      // (or create a fresh row if rows is empty).
      const newGroupId = createGroupId();
      const newGroup: PaneGroup = {
        id: newGroupId,
        paneIds: [paneId],
        activePaneId: paneId,
        type: 'chat',
      };
      setGroups(prev => [...prev, newGroup]);
      setRows(prev => {
        if (prev.length === 0) {
          return [{ groupIds: [newGroupId], widths: [1] }];
        }
        const firstRow = prev[0];
        const all = [...firstRow.groupIds, newGroupId];
        return [
          { groupIds: all, widths: all.map(() => 1 / all.length) },
          ...prev.slice(1),
        ];
      });
      setFocusedGroupId(newGroupId);
    },
    [],
  );

  // Pin the latest reopenChatPane into the forward-declared ref so the
  // pendingFocusTopicId effect (mounted earlier in this hook) can invoke
  // it without re-registering on every render. See the docstring on the
  // ref declaration above.
  reopenChatPaneRef.current = reopenChatPane;

  return {
    state: {
      panes,
      groups,
      rows,
      rowHeights,
      focusedGroupId,
      sidebarCollapsed,
    },
    setters: {
      setRows,
      setRowHeights,
      setSidebarCollapsed,
    },
    refs: {
      panesRef,
      groupsRef,
      focusedGroupIdRef,
      rowsRef,
      rowHeightsRef,
    },
    handlers: {
      activate: handleActivatePane,
      close: handleClosePane,
      closeNow: handleClosePaneNow,
      reopenLastClosed: handleReopenLastClosed,
      addToGroup: handleAddPaneToGroup,
      addWhenEmpty: handleAddPaneWhenEmpty,
      reorderGroupPanes: handleReorderGroupPanes,
      moveBetweenGroups: handleMovePaneBetweenGroups,
      splitGroup: handleSplitGroup,
      reorderRows: handleReorderRows,
      pinPane: handlePinPane,
      pinPaneById,
      stopStreaming: handleStopStreaming,
      paneSettings: handlePaneSettings,
      panePopOut: handlePanePopOut,
      openFile: handleOpenFile,
      openProcessLog: handleOpenProcessLog,
      openDiff: handleOpenDiff,
    },
    helpers: {
      availableTypesForGroup,
    },
    applyChatReconciliation,
    reopenChatPane,
  };
}
