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
  getBrowserContextFromPaneId,
  PANE_CONFIG,
  captureClosedTab,
  reopenClosedTab,
  scheduleTerminalCleanup,
  addTerminalTombstone,
  clearTerminalTombstone,
  getTerminalTombstones,
  addBrowserTombstone,
  clearBrowserTombstone,
  getBrowserTombstones,
} from '../../../state/pane/adapters';
import type { ClosedTabRecord } from '../../../state/pane/adapters/hooks/useClosedTabs';
import { findPreviewPane, replacePaneInGroup } from '../../../lib/previewTabs';
import { buildTerminalSessionBody, normalizeTerminalAgent, TERMINAL_AGENT_LABELS } from '../../../lib/terminalAgents';
import { pushUndo } from '../../../contexts/UndoContext';
import { enqueuePendingAction, tickPendingAction, cancelPendingAction } from '../../../contexts/PendingActionContext';
import { useRefMirror } from '../../../hooks/useRefMirror';
import { basename } from '../../../lib/path-utils';
import { resolveBrowserNavigateUrl } from '../../../lib/browserNavUrl';
import { splitColumnWidths, appendColumnWidths, keepColumnWidths, chooseSplitOrientation } from '../gridWidths';
import { notifyPaneReflow } from '../paneReflow';
import {
  addGroupToColumnStack,
  allGroupIdsInRows,
  isColumnStackFull,
  locateGroup,
  reconcileCellStacks,
  pickCellStacks,
  rowGroupIds,
} from '../groupLayoutStacks';
import { setBrowserSpawner, clearBrowserSpawner } from '../../../state/browserSpawner';
import { MAX_COLS_PER_ROW, MAX_ROWS } from '../constants';
import { shouldHandleOpenFile } from '../fileOpenScope';
import type { ChatReconciliation, PersistedSnapshot, PersistenceGateRefs } from './types';
import { shouldKeepRestoredTerminalPane } from './terminalReconcile';
import { stripWrapperPaneId } from './projectPersistence';
import { popOutTopic } from '../../../lib/popOutTopic';

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

// --- Args / Return types ---

export interface UseProjectLayoutArgs {
  projectPath: string;
  topics: Record<string, Topic>;
  initial: PersistedSnapshot | null;
  // External signals:
  focusedPanelId: string | null;
  pendingPane?: PaneType;
  pendingTerminalSessionId?: string;
  pendingTerminalType?: 'shell' | 'claude-code' | 'codex';
  onPendingPaneConsumed?: () => void;
  pendingFocusTopicId?: string | null;
  // Group the chat should land in (set when the user clicks a specific tab
  // bar's "+ new chat"). Lets a chat be placed into a non-chat group.
  pendingFocusTargetGroupId?: string;
  onPendingFocusConsumed?: () => void;
  // External APIs:
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  claudeSkipPermissions: boolean;
  onFocusPanel: (paneId: string) => void;
  onNewChat?: () => void;
  // Closed-tab undo:
  pushClosedTab: (record: ClosedTabRecord) => void;
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
    panesRef: React.RefObject<Pane[]>;
    groupsRef: React.RefObject<PaneGroup[]>;
    focusedGroupIdRef: React.RefObject<string | null>;
    rowsRef: React.RefObject<GroupLayoutRow[]>;
    rowHeightsRef: React.RefObject<number[]>;
  };
  handlers: {
    activate: (groupId: string, paneId: string) => void;
    /** Soft close — queues a PendingAction toast (3 s countdown). */
    close: (groupId: string, paneId: string) => void;
    /** Immediate close — bypasses the countdown (right-click "Close now"). */
    closeNow: (groupId: string, paneId: string) => void;
    addToGroup: (groupId: string, type: PaneType, subType?: string) => Promise<string | undefined>;
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
    /** Merge a partial update into a project pane (change-gated by caller).
     *  Used to persist a browser pane's `url` so the tab restores its page. */
    updatePane: (paneId: string, updates: Partial<Pane>) => void;
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
  reopenChatPane: (topicId: string, title: string, targetGroupId?: string) => void;
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
    pendingFocusTargetGroupId,
    onPendingFocusConsumed,
    onWSMessage,
    claudeSkipPermissions,
    onFocusPanel,
    onNewChat: _onNewChat,
    pushClosedTab,
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
    // Skip browser panes the user just closed (tombstone survives reload). The
    // persisted `nonChatPanes` snapshot may still list a browser pane whose
    // close committed at unload — where the React persistence effect never
    // re-ran to drop it — so consult the browser tombstone the same way the
    // terminal-sync effect consults getTerminalTombstones() for terminals.
    const browserTombstones = getBrowserTombstones();
    const seed: Pane[] = stripWrapperPaneId(initial?.nonChatPanes || [], projectPath)
      .filter(p => {
        if (p.type !== 'browser') return true;
        const ctx = getBrowserContextFromPaneId(p.id);
        return !(ctx && browserTombstones.has(ctx));
      });
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
      // Archived ⟺ closed (2-state model): an archived topic must not be
      // re-seeded as an open chat pane on reload. Without this, archiving the
      // project's only topic left a permanent ghost pane — the chat-sync
      // transient-empty guard (useProjectChatSync) skips the removal pass
      // when topicIds is empty, so nothing ever cleaned it up.
      if (t && (t.projectPath !== projectPath || t.archived)) continue;
      const id = createPaneId('chat', topicId);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      seed.push({
        id,
        type: 'chat',
        topicId,
        title: topics[topicId]?.name || 'New Chat',
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
  // Restore the previously-focused split cell so a reload keeps the focused
  // tab instead of snapping to the first cell. Validated by the
  // default-focused-group effect, which only overrides when the id is stale.
  const [focusedGroupId, setFocusedGroupId] = useState<string | null>(
    () => (initial?.focusedGroupId ?? null),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (window.innerWidth < 768) return true;
    return initial?.sidebarCollapsed ?? false;
  });

  // --- Ref mirrors (used by stable callbacks + same-effect reads) ---
  const panesRef = useRefMirror(panes);
  const topicsRef = useRefMirror(topics);
  const groupsRef = useRefMirror(groups);
  const focusedGroupIdRef = useRefMirror(focusedGroupId);
  // Top-level focused PANEL id (which project window owns the focus), distinct
  // from focusedGroupId (the focused group INSIDE this window). Used to scope
  // global file-open events to the targeted project window — see the
  // 'open-file' listener below.
  const focusedPanelIdRef = useRefMirror(focusedPanelId);
  const rowsRef = useRefMirror(rows);
  const rowHeightsRef = useRefMirror(rowHeights);

  // Forward-declared ref so the browser-navigate useEffect (mounted near the
  // top of this hook) can call `handleAddPaneToGroup`, which is itself
  // defined ~500 lines further down. Pure plumbing — no behavior on its own.
  const handleAddPaneToGroupRef = useRef<((groupId: string, type: PaneType, subType?: string, paneKey?: string) => Promise<string | undefined>) | null>(null);
  // Pinned each render so the early-mounted browser-split effect can call the
  // latest handleSplitGroup (defined ~1200 lines below). Same pattern as
  // handleAddPaneToGroupRef.
  const handleSplitGroupRef = useRef<((sourceGroupId: string, paneId: string, targetGroupId: string, edge: 'left' | 'right' | 'top' | 'bottom', opts?: { fullRow?: boolean }) => void) | null>(null);
  // Pinned each render so the early-mounted browser-navigate effect can call the
  // latest updatePane (defined ~1800 lines below) to persist a project browser
  // pane's URL deterministically at open. Same pattern as handleAddPaneToGroupRef.
  const updatePaneRef = useRef<((paneId: string, updates: Partial<Pane>) => void) | null>(null);
  // A browser pane just added to a group, queued to be split OUT into its own
  // space-aware group beside the source (consumed by the effect below once the
  // pane is committed). Mirrors the standalone pendingSoloPanelId pattern.
  const [pendingBrowserSplit, setPendingBrowserSplit] = useState<{ paneId: string; sourceGroupId: string } | null>(null);

  // Forward-declared ref so the pendingFocusTopicId effect (mounted ~80
  // lines below) can call `reopenChatPane`, which is itself defined
  // ~900 lines further down. Same pattern as handleAddPaneToGroupRef.
  // Without this, the effect was using a thinner `reopenTopicLocal`
  // helper that added the pane to `state.panes` but never placed it in
  // a group → the pane was orphaned (invisible) and focus snapped back
  // to the previously-active pane. `reopenChatPane` has the full
  // fallback chain (focused group → first chat group → create new).
  const reopenChatPaneRef = useRef<((topicId: string, title: string, targetGroupId?: string) => void) | null>(null);
  // When the user creates a chat via a SPECIFIC group's "+ new chat" button,
  // reopenChatPane places it into that (possibly non-chat) group. The chat-sync
  // delta-add can materialize the same topic as an ORPHAN pane in the same
  // commit; without this guard the orphan-sync effect would bucket it into a
  // 'chat' group by type-affinity and race our targeted placement. We park the
  // pane id here so orphan-sync skips it for one tick, letting reopenChatPane win.
  const pendingTargetedChatRef = useRef<{ paneId: string } | null>(null);

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
  // Session ids we've POSITIVELY seen in a roster. A terminal pane is pruned
  // only once its session has been seen AND then disappeared — never on a
  // transient empty/partial roster. The server's session map is empty for a
  // moment after a hot-reload (bun --watch restart, reconcile is async) and the
  // WS reconnect after an Electron refresh can deliver a roster before
  // reconcile finishes; pruning on those used to wipe every restored
  // claude-code tab inside a project AND persist the wipe → sessions lost.
  const seenTerminalSessionIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // A roster entry is only usable if it carries a string `id` and `cwd`.
    // The roster can arrive over both the fetch and WS paths from a server
    // mid-restart (partial shapes) — without this guard `s.cwd.startsWith`
    // throws and a single bad entry wipes the whole sync.
    const isTerminalSession = (
      s: unknown,
    ): s is { id: string; cwd: string; name: string; type: string } =>
      !!s &&
      typeof (s as { id?: unknown }).id === 'string' &&
      typeof (s as { cwd?: unknown }).cwd === 'string';

    const syncTerminals = (rawSessions: { id: string; cwd: string; name: string; type: string }[]) => {
      const sessions = rawSessions.filter(isTerminalSession);
      const sessionIds = new Set(sessions.map(s => s.id));
      const seen = seenTerminalSessionIdsRef.current;
      for (const id of sessionIds) seen.add(id);
      // A NON-EMPTY roster proves the server is up and reconcile has populated
      // its session map — so a restored terminal pane whose id is absent from it
      // (and never seen) is a genuine corpse from a previous run, not a
      // still-loading tab. An EMPTY roster (server mid hot-reload / a reconnect
      // that raced reconcile) is NOT authoritative: keep never-seen panes then,
      // preserving the original refresh/reconnect protection. This is what stops
      // an app restart from resurrecting dead "sessioni morte" project tabs.
      const rosterAuthoritative = sessionIds.size > 0;
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
        let updated = prev.filter(p => {
          if (p.type !== 'terminal') return true;
          const sid = getTerminalSessionFromPaneId(p.id) || '';
          // Prune a seen-then-gone session (closed in another window) OR a
          // never-seen id that an authoritative (non-empty) roster doesn't list
          // (a dead session restored from a previous run). Keep never-seen ids
          // while the roster is empty/unproven — see terminalReconcile for why
          // this stops a refresh from losing live tabs.
          return shouldKeepRestoredTerminalPane(sid, sessionIds, seen, rosterAuthoritative);
        });
        const existingTermIds = new Set(
          updated.filter(p => p.type === 'terminal').map(p => getTerminalSessionFromPaneId(p.id)),
        );
        const toAdd: Pane[] = [];
        for (const s of projectSessions) {
          if (existingTermIds.has(s.id)) continue;
          toAdd.push({
            id: `terminal:${s.id}`,
            type: 'terminal' as PaneType,
            title: s.name || TERMINAL_AGENT_LABELS[normalizeTerminalAgent(s.type)],
            preview: false,
            // claude-code-team intentionally maps to 'shell' here (not a
            // user-creatable agent); codex keeps its own type → OpenAI glyph.
            terminalType: normalizeTerminalAgent(s.type),
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
        // Revive in parallel — N dormant sessions used to be N awaited
        // round-trips at mount, serialising the layout's terminal restore.
        await Promise.all(
          dormant
            .filter(d => !tombstones.has(d.id))
            .map(d =>
              fetch(`/api/terminal/sessions/${d.id}/revive`, { method: 'POST' }).catch(() => {}),
            ),
        );
      })
      .catch(() => {});

    return onWSMessage((msg: WSMessage) => {
      const m = msg as unknown as { type?: string; sessions?: unknown };
      if (m.type === 'terminal:sessions' && Array.isArray(m.sessions)) {
        syncTerminals(m.sessions as { id: string; cwd: string; name: string; type: string }[]);
      }
    });
  }, [onWSMessage, projectPath, topicsRef]);

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
    const ensureBrowserPaneAndNavigate = (rawUrl: string, targetGroupId?: string, spawnerKey?: string, contextId?: string) => {
      if (!rawUrl) return;
      // Rewrite localhost/127.0.0.1/*.local → the LAN https host for remote/mobile
      // clients, exactly as the standalone path does (usePaneOrdering). Without it
      // a project browser opened from another device gets a raw localhost URL it
      // can't reach (white pane) — and seedPaneUrl would persist that dead URL.
      // On Tauri/local this is a passthrough, so desktop behaviour is unchanged.
      const url = resolveBrowserNavigateUrl(rawUrl);
      // Default to the focused group (chat-driven navigation), but allow an
      // explicit target so a terminal-originated open lands beside the SAME
      // group as the terminal pane rather than wherever focus happens to be.
      const fgid = targetGroupId ?? focusedGroupIdRef.current;
      if (!fgid) return;

      // Reuse ANY existing browser in this project — refresh it in place rather
      // than spawning a second. A project shares one browser context across its
      // panes, so a duplicate would fight over the same Electron view.
      // Persist the URL onto the project pane deterministically at open — the
      // standalone path does this (usePaneOrdering persistBrowserPaneUrl) but the
      // project path relied solely on the timing-fragile onUrlChange render, so a
      // fast open could restore the tab to about:blank after a window restart.
      // updatePane (not persistBrowserPaneUrl, which no-ops for non-store project
      // panes) is the project-side persistence seam; round-trips via projectLayoutSync.
      const seedPaneUrl = (paneId: string): void => {
        if (url && url !== 'about:blank') updatePaneRef.current?.(paneId, { url });
      };

      // Per-session isolation: each contextId gets its OWN browser pane. Match
      // THIS contextId's pane (NOT "any browser in the project") so a second
      // session opening a browser in the same project gets its OWN pane instead of
      // STEALING the first's. The old code did find(type==='browser') + REBIND
      // (rename the existing pane to the incoming contextId), which collapsed EVERY
      // session in a project onto one shared browser — the "unica per tutti" bug.
      // Different contextIds are different native views (own WKWebView/WebContents-
      // View + own server Playwright context), so per-session panes coexist cleanly
      // in their own DOM slots; the new-pane path below creates one when absent.
      const existing = contextId
        ? panesRef.current.find(p => p.id === createPaneId('browser', contextId))
        : panesRef.current.find(p => p.type === 'browser');
      if (existing) {
        const grp = groupsRef.current.find(g => g.paneIds.includes(existing.id));
        if (grp) {
          setGroups(prev => prev.map(g => (g.id === grp.id ? { ...g, activePaneId: existing.id } : g)));
          setFocusedGroupId(grp.id);
        }
        const ctx = getBrowserContextFromPaneId(existing.id);
        if (ctx && spawnerKey) setBrowserSpawner(ctx, spawnerKey);
        seedPaneUrl(existing.id);
        onBrowserNavigateUrl?.(url);
        return;
      }

      // None yet → add the browser to the source group, then queue a split so
      // it lands in its own space-aware cell BESIDE the chat/terminal instead
      // of sitting hidden as a tab. The split effect below consumes this once
      // the pane is committed and picks side-by-side vs stacked by space.
      queueMicrotask(async () => {
        const newId = await handleAddPaneToGroupRef.current?.(fgid, 'browser', undefined, contextId);
        if (newId) {
          const ctx = getBrowserContextFromPaneId(newId);
          if (ctx && spawnerKey) setBrowserSpawner(ctx, spawnerKey);
          seedPaneUrl(newId);
          setPendingBrowserSplit({ paneId: newId, sourceGroupId: fgid });
        }
      });
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
      const m = msg as unknown as { type?: string; topicId?: string; url?: string; paneId?: string; contextId?: string };
      if (m.type === 'browser:navigate' && m.url && topicBelongsToThisProject(m.topicId)) {
        // Bind the pane to the server-resolved contextId (== topic.id) so the
        // native CDP target registers under the id the agent's browser_* tools
        // resolve to (no invisible Playwright phantom). Falls back to topicId
        // (the chat-topic contextId) when the broadcast predates the field.
        ensureBrowserPaneAndNavigate(m.url, undefined, m.topicId, m.contextId ?? m.topicId);
      }
      // Terminal-originated open: only the project window whose layout actually
      // contains the terminal pane reacts; it opens the browser beside that
      // exact group (next to the terminal), not the focused group. The spawner
      // key is the terminal pane id so its tab gets the "opened a browser" cue.
      if (m.type === 'browser:open-near-pane' && m.url && m.paneId) {
        const g = groupsRef.current.find(gr => gr.paneIds.includes(m.paneId!));
        if (g) ensureBrowserPaneAndNavigate(m.url, g.id, m.paneId, m.contextId);
      }
    });

    const domHandler = (e: Event) => {
      const detail = (e as CustomEvent<{ topicId?: string; url?: string }>).detail;
      if (detail?.url && topicBelongsToThisProject(detail.topicId)) {
        // chat-topic contextId === topicId (resolveContextIdForTopic).
        ensureBrowserPaneAndNavigate(detail.url, undefined, detail.topicId, detail.topicId);
      }
    };
    window.addEventListener('browser:open-and-navigate', domHandler);

    // Page-initiated close: a page (or the agent) called window.close(); App
    // bridges it to this event. Close the browser pane IF this project owns it —
    // the ownership guard means exactly one surface (app-level or the owning
    // project window) acts, never both. Mirrors a normal tab close (deferred,
    // animated, undo-able) via handleClosePane.
    const closeHandler = (e: Event) => {
      const ctx = (e as CustomEvent<{ contextId?: string }>).detail?.contextId;
      if (!ctx) return;
      const paneId = createPaneId('browser', ctx);
      const pane = panesRef.current.find(p => p.id === paneId);
      if (!pane) return; // not ours — another surface owns it
      const grp = groupsRef.current.find(g => g.paneIds.includes(paneId));
      if (grp) handleClosePaneRef.current?.(grp.id, paneId);
    };
    window.addEventListener('browser:request-close', closeHandler);

    return () => {
      unsubWS();
      window.removeEventListener('browser:open-and-navigate', domHandler);
      window.removeEventListener('browser:request-close', closeHandler);
    };
    // handleAddPaneToGroupRef is read via ref to avoid re-registering on every
    // render. Deps are the stable identity inputs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onWSMessage, onBrowserNavigateUrl, topics, projectPath]);

  // Consume a queued browser split: once the freshly added browser pane is
  // committed into its source group (beside the chat/terminal), split it OUT
  // into its own cell, oriented by the source group's available space (wide →
  // side-by-side, tall/narrow → stacked). Idempotent: a browser already alone
  // in its group is left as-is, so re-opening just navigates it.
  useEffect(() => {
    if (!pendingBrowserSplit) return;
    const { paneId } = pendingBrowserSplit;
    if (!panes.some(p => p.id === paneId)) return; // not committed yet — wait
    const hostGroup = groups.find(g => g.paneIds.includes(paneId));
    if (!hostGroup) return;
    // Already in its own cell (sibling closed / prior split) → nothing to do.
    if (hostGroup.paneIds.length <= 1) { setPendingBrowserSplit(null); return; }
    // Measure the source group's on-screen cell to pick the orientation.
    let rect: { width: number; height: number } | null = null;
    try {
      const bar = document.querySelector(`[data-testid="panel-tab-bar"][data-group-id="${hostGroup.id}"]`);
      const cell = (bar?.parentElement as HTMLElement | null) ?? null;
      const r = cell?.getBoundingClientRect();
      if (r) rect = { width: r.width, height: r.height };
    } catch { /* DOM not ready / bad selector — fall back to 'side' */ }
    const edge = chooseSplitOrientation(rect) === 'side' ? 'right' : 'bottom';
    handleSplitGroupRef.current?.(hostGroup.id, paneId, hostGroup.id, edge);
    setPendingBrowserSplit(null);
  }, [pendingBrowserSplit, panes, groups]);

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

      // Skip the pane that reopenChatPane is about to place into an explicit
      // target group — see pendingTargetedChatRef. Leaving it orphan for this
      // tick prevents type-affinity from claiming it into a 'chat' group.
      const targetedChatId = pendingTargetedChatRef.current?.paneId;
      const orphanPanes = panes.filter(
        p => !paneToGroupIdx.has(p.id) && p.id !== targetedChatId,
      );

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
  }, [panes, focusedGroupIdRef]);

  // --- Sync rows/heights with groups ---
  // Restore-active-chat is owned by `useProjectChatSync` via
  // `applyChatReconciliation.activateInGroup` (Commit 4) — the layout-side
  // effect that used to live here was redundant and has been removed.
  useEffect(() => {
    const allGroupIds = new Set(groups.map(g => g.id));
    // First reconcile per-column vertical stacks: drop dead stacked members,
    // promote a survivor when a column's primary died, prune empty stacks. This
    // runs BEFORE the column/row pruning below so a promoted primary is seen as
    // live and a fully-dead column is left for the width-preserving filter to
    // drop. `cellStacks` then rides through that filter via pickCellStacks.
    const reconciled = reconcileCellStacks(rowsRef.current, allGroupIds);
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
    // render twice). allGroupIdsInRows walks primaries + every cellStack.
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

    if (anyRowChanged) {
      setRows(newRows);
      const curHeights = rowHeightsRef.current;
      if (newRows.length !== curHeights.length) {
        // When rows were purely removed (every survivor maps back to a height
        // via keptRowIdx) preserve their manual heights in proportion; only
        // fall back to an equal split when brand-new rows were created.
        setRowHeights(
          keptRowIdx.length === newRows.length && newRows.length > 0
            ? keepColumnWidths(curHeights, keptRowIdx)
            : newRows.map(() => 1 / newRows.length),
        );
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
            title: topic?.name || 'New Chat',
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
    reopenChatPaneRef.current?.(pendingFocusTopicId, t.name || 'New Chat', pendingFocusTargetGroupId);
    onPendingFocusConsumed?.();
  }, [pendingFocusTopicId, pendingFocusTargetGroupId, topics, projectPath, onPendingFocusConsumed]);

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
      // Defuse any deferred close still counting down for this pane —
      // "Close now" during the 3s window would otherwise close immediately
      // AND re-fire at T+3s via the enqueue-time commit closure, whose stale
      // captured state re-runs the whole close against a different layout.
      cancelPendingAction(`close-tab:${paneId}`);
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
          //
          // Each browser pane now owns the contextId encoded in its pane id
          // (term-<id> / topic.id / uuid) — no longer a single projectPath shared
          // across the project (that never matched the agent's contextId and its
          // slashes broke the cdp-target route). So tear down THIS pane's own
          // context on a real close.
          const bctx = getBrowserContextFromPaneId(paneId);
          if (bctx) {
            // Tombstone the context id IMMEDIATELY (localStorage, survives
            // reload). The `panes` useState seed on the next mount skips
            // tombstoned browser panes — so a reload before the persistence
            // effect has re-run (e.g. the close committed at unload via
            // flushPendingActions, where React never re-renders) can no longer
            // resurrect this browser as a phantom tab from the stale
            // `nonChatPanes` snapshot. Mirrors addTerminalTombstone above; the
            // earlier "no tombstone needed" assumption was the resurrection bug.
            addBrowserTombstone(bctx);
            // Unregister the native CDP target (clears isNativeBound + agent caches).
            // useNativeBrowser intentionally no longer does this on React unmount
            // (that emptied the registry during remounts → phantom); a real close
            // is the right moment to drop it.
            fetch(`/api/browsers/${encodeURIComponent(bctx)}/cdp-target`, { method: 'DELETE' }).catch(() => {});
            // Tear down any server-side Playwright context that backed this pane.
            fetch(`/api/browsers/${encodeURIComponent(bctx)}`, { method: 'DELETE' }).catch(() => {});
            // Drop the spawner relationship so the "opened a browser" tab cue clears.
            clearBrowserSpawner(bctx);
          }
        }

        pushClosedTab(record);

        // 2-state model: closing a project chat sub-tab archives the topic
        // (closed ⟺ archived). Emitted as a window event because archiveTopic
        // isn't available here (TopicsContext deliberately omits actions);
        // the App-level listener in usePanelLifecycle runs it. Mirrors the
        // existing 'reopen-closed-tab' window-event pattern. Fires at commit
        // (this fn runs after the 3s countdown / on immediate close), so a
        // cancelled close never archives.
        if (pane.type === 'chat' && pane.topicId) {
          window.dispatchEvent(new CustomEvent('topic-archive-on-close', { detail: { topicId: pane.topicId } }));
        }

        const capturedRecord = record;
        // Where the closed pane's GROUP sat in the grid at close time — lets
        // undo recreate a dissolved split cell at its old location instead of
        // dumping the restored tab into the arbitrary first group.
        const capturedLoc = locateGroup(rowsRef.current, groupId);
        pushUndo({
          description: `Close ${pane.title || pane.type}`,
          undo: async () => {
            const restored = await reopenClosedTab(capturedRecord);
            // Undo of a browser close retracts its tombstone so a later reload
            // doesn't re-close it via the seed filter (mirrors reopenClosedTab's
            // clearTerminalTombstone for terminals).
            if (restored.type === 'browser') {
              const ctx = getBrowserContextFromPaneId(restored.id);
              if (ctx) clearBrowserTombstone(ctx);
            }
            // Id-dedup guard (same pattern as reopenChatPane /
            // handleAddPaneToGroup): the pane may have been reopened via the
            // sidebar between close and ⌘Z — re-adding would duplicate the
            // id in panes[] and group.paneIds (React key collision).
            setPanes(prev => (prev.some(p => p.id === restored.id) ? prev : [...prev, restored]));
            setGroups(prev => {
              if (prev.some(g => g.paneIds.includes(restored.id))) return prev;
              const target = prev.find(g => g.id === capturedRecord.groupId);
              if (target) {
                const idx = Math.min(capturedRecord.groupIndex, target.paneIds.length);
                const newIds = [...target.paneIds];
                newIds.splice(idx, 0, restored.id);
                return prev.map(g =>
                  g.id === target.id ? { ...g, paneIds: newIds, activePaneId: restored.id } : g,
                );
              }
              // The group dissolved (the restored pane was its last tab):
              // recreate it under its ORIGINAL id — the setRows below re-seats
              // it at the captured grid location, so ⌘Z restores the split
              // cell instead of splicing the tab into `prev[0]`.
              return [...prev, {
                id: capturedRecord.groupId,
                paneIds: [restored.id],
                activePaneId: restored.id,
                type: paneTypeToGroupType(restored.type),
              }];
            });
            setRows(prev => {
              const gid = capturedRecord.groupId;
              if (allGroupIdsInRows(prev).includes(gid)) return prev; // still placed
              if (!capturedLoc) return prev; // unknown location — sync effect appends
              // Stacked member whose host primary survives → back into that stack.
              if (!capturedLoc.isPrimary && capturedLoc.primaryId !== gid && locateGroup(prev, capturedLoc.primaryId)) {
                return addGroupToColumnStack(prev, capturedLoc.primaryId, gid, 'bottom');
              }
              if (prev.length === 0) return [{ groupIds: [gid], widths: [1] }];
              const rowIdx = Math.min(capturedLoc.rowIdx, prev.length - 1);
              return prev.map((row, i) => {
                if (i !== rowIdx) return row;
                const insertAt = Math.min(capturedLoc.colIdx, row.groupIds.length);
                const donorIdx = Math.max(0, Math.min(insertAt, row.widths.length - 1));
                const groupIds = [...row.groupIds];
                groupIds.splice(insertAt, 0, gid);
                return { ...row, groupIds, widths: splitColumnWidths(row.widths, donorIdx, insertAt) };
              });
            });
            removeClosedTab(capturedRecord.id);
            // Undo of a chat close also restores open == non-archived.
            if (capturedRecord.pane.type === 'chat' && capturedRecord.pane.topicId) {
              window.dispatchEvent(new CustomEvent('topic-unarchive-on-open', { detail: { topicId: capturedRecord.pane.topicId } }));
            }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleClosePane is declared AFTER this callback (forward const, TDZ); it is only invoked inside the redo handler at undo-stack-replay time, where it re-enters the full deferred-close pipeline and re-reads live state, so a stale closure is benign
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

  const restoreClosedRecord = useCallback(async (record: ClosedTabRecord) => {
    try {
      const pane = await reopenClosedTab(record);
      // Id-dedup guard (same pattern as the undo path / reopenChatPane): the
      // pane may already be open (reopened via the sidebar between close and
      // this restore) — re-adding would duplicate the id in panes[] and
      // group.paneIds (React key collision).
      setPanes(prev => (prev.some(p => p.id === pane.id) ? prev : [...prev, pane]));
      // Reopening a project chat restores open == non-archived.
      if (pane.type === 'chat' && pane.topicId) {
        window.dispatchEvent(new CustomEvent('topic-unarchive-on-open', { detail: { topicId: pane.topicId } }));
      }
      setGroups(prev => {
        if (prev.some(g => g.paneIds.includes(pane.id))) return prev;
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
  }, []);

  // Listen for the reopen-closed-tab event (fired by usePanelLifecycle's
  // handleReopenClosedTab — ⌘⇧U pops the GLOBAL stack there and routes the
  // record here). Claim protocol: the event carries the record in detail;
  // only the window whose projectPath matches restores it and
  // preventDefault()s so the dispatcher knows to consume the record off the
  // stack. Previously this handler ignored detail and popped the global top
  // itself — so ANY project window restored its own last-closed tab (often a
  // foreign record), and with N windows open N pops raced on one stack.
  useEffect(() => {
    const handler = (e: Event) => {
      const record = (e as CustomEvent<ClosedTabRecord>).detail;
      if (!record || record.projectPath !== projectPath) return; // not ours
      e.preventDefault(); // claim — dispatcher removes the record from the stack
      void restoreClosedRecord(record);
    };
    window.addEventListener('reopen-closed-tab', handler);
    return () => window.removeEventListener('reopen-closed-tab', handler);
  }, [restoreClosedRecord, projectPath]);

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
  }, [wrapperPaneId, focusedGroupIdRef, groupsRef]);

  const handleAddPaneToGroup = useCallback(
    async (groupId: string, type: PaneType, subType?: string, paneKey?: string) => {
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
        const termType = normalizeTerminalAgent(subType);
        paneTitle = TERMINAL_AGENT_LABELS[termType];
        try {
          const body = buildTerminalSessionBody(termType, { cwd: projectPath, skipPermissions: claudeSkipPermissions });
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
        // paneKey makes the id deterministic (browser panes use it so a
        // terminal-originated open registers its CDP target under the same
        // `term-<id>` the server's observe/act routes resolve to).
        paneId = createPaneId(type, paneKey);
        paneTitle = config.label;
        // Re-opening a browser retracts any close tombstone for its context, so
        // the seed filter above won't suppress it on the next reload. Symmetric
        // with clearTerminalTombstone on the terminal reopen path.
        if (type === 'browser') {
          const ctx = getBrowserContextFromPaneId(paneId);
          if (ctx) clearBrowserTombstone(ctx);
        }
      }

      // A browser pane is a DURABLE resource (a live WebContentsView the user —
      // or an agent — drives over many turns), not a throwaway single-click
      // preview like a file. Born non-preview so the persistence-save effect
      // (which drops `preview` panes from nonChatPanes) actually persists it and
      // its url — without this, an agent-opened browser tab vanished on every
      // app reload. Mirrors how `terminal` is treated, and how the standalone
      // path already pins every browser pane (usePaneOrdering effectivePinnedIds).
      const isDurableResource = type === 'terminal' || type === 'browser';
      const newPane: Pane = {
        id: paneId,
        type,
        title: paneTitle,
        preview: isDurableResource ? false : true,
        ...(type === 'terminal' && subType ? { terminalType: normalizeTerminalAgent(subType) } : {}),
      };

      const targetGroup = groups.find(g => g.id === groupId);
      const groupPanes =
        targetGroup?.paneIds.map(id => panes.find(p => p.id === id)).filter((p): p is Pane => !!p) || [];
      const existingPreview =
        !isDurableResource ? findPreviewPane(groupPanes.filter(p => p.type === type), newPane.id) : null;

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
      return paneId;
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
        const termType = normalizeTerminalAgent(subType);
        paneTitle = TERMINAL_AGENT_LABELS[termType];
        try {
          const body = buildTerminalSessionBody(termType, { cwd: projectPath, skipPermissions: claudeSkipPermissions });
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
        ...(type === 'terminal' && subType ? { terminalType: normalizeTerminalAgent(subType) } : {}),
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
      const detail = (e as CustomEvent).detail as { path?: string; topicId?: string };
      if (!detail?.path) return;
      // SCOPE to THIS project window. 'open-file' is a GLOBAL window event and
      // every mounted project window's useProjectLayout subscribes to it — so
      // with two projects in split view a single dispatch would open the file
      // in BOTH ("file opens on all splits"). Routing rule extracted to the
      // unit-tested `shouldHandleOpenFile`; mirrors the projectPath scoping the
      // global-tab:focus-inner listener already uses.
      if (!shouldHandleOpenFile(detail, wrapperPaneId, focusedPanelIdRef.current)) return;
      handleOpenFile(detail.path);
    };
    window.addEventListener('open-file', handler);
    return () => window.removeEventListener('open-file', handler);
  }, [handleOpenFile, wrapperPaneId, focusedPanelIdRef]);

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
  // Intentionally NO dependency array: this must run AFTER EVERY COMMIT to drain
  // the `pendingPreviewCloseRef` flag that the orphan-sync effect sets during a
  // preview-replace. The set-then-clear guard makes it a no-op on renders where
  // the flag is null, so there's no update loop. `[]` (the lint suggestion)
  // would run it only once at mount and miss every later replace.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate run-every-commit drain of pendingPreviewCloseRef; guarded by the null check so it doesn't loop
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
      const topicId = pane.topicId;
      // Remove the source pane only if a window actually opened — see popOutTopic.
      void popOutTopic(topicId).then((opened) => {
        if (opened) setPanes(prev => prev.filter(p => p.id !== paneId));
      });
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
      // Vertical (top/bottom) splits default to a SINGLE-COLUMN vertical stack
      // ("in basso a una singola split tab") — the soloed pane lands under just
      // the target's column. `fullRow: true` (the container's full-width drop
      // strips) inserts a new row spanning EVERY column ("in basso a tutte le
      // tab"). Horizontal (left/right) splits ignore this flag.
      opts?: { fullRow?: boolean },
    ) => {
      const pane = panes.find(p => p.id === paneId);
      if (!pane) return;
      const isVertical = edge === 'top' || edge === 'bottom';
      const fullRow = isVertical && !!opts?.fullRow;
      const columnSplit = isVertical && !fullRow;

      // Defensive only: the menu entries and the edge-drop preview are gated
      // by the shared canSplitPane rule (GroupLayout), so a split-into-self
      // on a single-pane group is normally unreachable. A fullRow move IS
      // meaningful for a solo group (its pane moves to a new spanning row),
      // so only the non-fullRow no-op is refused.
      if (sourceGroupId === targetGroupId && !fullRow) {
        const sourceGroup = groups.find(g => g.id === sourceGroupId);
        if (sourceGroup && sourceGroup.paneIds.length <= 1) return;
      }

      // Enforce the grid limits before any state mutation (setGroups below) so
      // we never strand an orphan group that no row/stack places:
      //  - left/right: cap columns per row (MAX_COLS_PER_ROW)
      //  - column vertical split: cap the target column's stack depth
      //  - full-width row: cap total rows (MAX_ROWS)
      const curRowsForLimit = rowsRef.current;
      if (edge === 'left' || edge === 'right') {
        // Resolve through locateGroup so a STACKED target counts its HOST
        // row — a plain `groupIds.includes` walk misses cellStacks members
        // and skipped the cap entirely for them.
        const targetLoc = locateGroup(curRowsForLimit, targetGroupId);
        const targetRow = targetLoc ? curRowsForLimit[targetLoc.rowIdx] : undefined;
        if (targetRow && targetRow.groupIds.length >= MAX_COLS_PER_ROW) return;
      } else if (columnSplit) {
        if (isColumnStackFull(curRowsForLimit, targetGroupId)) return;
      } else if (curRowsForLimit.length >= MAX_ROWS) {
        return;
      }

      // Split is undoable: snapshot the layout slices (plain data) — ⌘Z
      // after a split used to silently undo the previous CLOSE instead. The
      // orphan-pane / [groups] sync effects re-home anything that changed
      // between split and undo, so a wholesale restore is safe.
      {
        const prevGroupsSnap = groupsRef.current;
        const prevRowsSnap = rowsRef.current;
        const prevHeightsSnap = rowHeightsRef.current;
        const prevFocusedSnap = focusedGroupIdRef.current;
        pushUndo({
          description: 'Split pane',
          undo: () => {
            setGroups(prevGroupsSnap);
            setRows(prevRowsSnap);
            setRowHeights(prevHeightsSnap);
            setFocusedGroupId(prevFocusedSnap);
          },
          redo: () => {
            handleSplitGroupRef.current?.(sourceGroupId, paneId, targetGroupId, edge, opts);
          },
        });
      }

      // Dispatched here, past every guard above, so a no-op split never
      // flashes the native browser views. See paneReflow.ts for the full
      // rationale.
      notifyPaneReflow();

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

      if (edge === 'left' || edge === 'right') {
        setRows(prev => {
          // Locate the target through locateGroup — a group STACKED inside a
          // column's cellStacks is never in row.groupIds, so the old
          // `row.groupIds.indexOf(targetGroupId)` walk touched no row and
          // stranded the new group (the [groups] sync effect then appended
          // it to the END of row 0: "Split Right from a stacked group lands
          // in a far-away corner"). The new column is inserted beside the
          // target's HOST column, mirroring how the columnSplit branch
          // already resolves stacked targets via addGroupToColumnStack.
          const loc = locateGroup(prev, targetGroupId);
          if (!loc) return prev; // sync effect places the orphan (legacy fallback)
          return prev.map((row, i) => {
            if (i !== loc.rowIdx) return row;
            const newGroupIds = [...row.groupIds];
            const insertAt = edge === 'left' ? loc.colIdx : loc.colIdx + 1;
            newGroupIds.splice(insertAt, 0, newGroupId);
            // Split the TARGET column's width with the new group; leave every
            // other column's width untouched. (Was `1/n` — flattened a manual
            // resize on every split. See gridWidths.ts.)
            const newWidths = splitColumnWidths(row.widths, loc.colIdx, insertAt);
            return { ...row, groupIds: newGroupIds, widths: newWidths };
          });
        });
      } else if (columnSplit) {
        // SINGLE-COLUMN vertical split: stack the soloed group under (bottom)
        // or over (top) just the target's column via cellStacks. No new row,
        // no rowHeights change — the stack's own heights live in cellStacks,
        // so sibling columns stay full-height. This is the fix for "splitting a
        // tab to the bottom moved it under EVERY column".
        setRows(prev => addGroupToColumnStack(prev, targetGroupId, newGroupId, edge));
      } else {
        // FULL-WIDTH row insert ("in basso/in alto a tutte le tab"). Compute
        // the indices OUTSIDE the updaters and queue setRows + setRowHeights as
        // siblings (handleReorderRows pattern) — updaters must be pure, and
        // StrictMode's double-invocation would otherwise queue the height split
        // twice, corrupting rowHeights. `targetGroupId` may be empty (the
        // container's top/bottom strip, which means "above the first row" /
        // "below the last row"); fall back to the first/last row then.
        const rowsNow = rowsRef.current;
        let targetRowIdx = rowsNow.findIndex(row => row.groupIds.includes(targetGroupId));
        if (targetRowIdx === -1) targetRowIdx = edge === 'top' ? 0 : rowsNow.length - 1;
        const insertAt = edge === 'top' ? targetRowIdx : targetRowIdx + 1;
        setRows(prev => {
          let idx = prev.findIndex(row => row.groupIds.includes(targetGroupId));
          if (idx === -1) idx = edge === 'top' ? 0 : prev.length - 1;
          const at = edge === 'top' ? idx : idx + 1;
          const newRows = [...prev];
          newRows.splice(at, 0, { groupIds: [newGroupId], widths: [1] });
          return newRows;
        });
        setRowHeights(prevH => {
          const newHeights = [...prevH];
          const donorIdx = Math.max(0, Math.min(targetRowIdx, newHeights.length - 1));
          const halfHeight = (newHeights[donorIdx] || 1 / Math.max(1, prevH.length)) / 2;
          if (newHeights.length > 0) newHeights[donorIdx] = halfHeight;
          newHeights.splice(insertAt, 0, halfHeight);
          return newHeights;
        });
      }

      setFocusedGroupId(newGroupId);
    },
    [panes, groups, rowsRef, groupsRef, rowHeightsRef, focusedGroupIdRef],
  );

  // Pin the latest handleSplitGroup so the early-mounted browser-split effect
  // can invoke it with a fresh panes/groups closure.
  handleSplitGroupRef.current = handleSplitGroup;

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
          .map(g => {
            const paneIds = g.paneIds.filter(id => !remove.includes(id));
            if (paneIds.length === g.paneIds.length) return g;
            // Re-point activePaneId when the removed pane was the active one
            // (archive-from-sidebar lands here). Every other close path does
            // this (handleClosePaneNow, handleAddPaneToGroup, reopenChatPane);
            // skipping it leaves the group rendering "No pane selected" and
            // the dangling id persists across reload — orphan-sync can't
            // repair it because paneIds were already filtered in this commit.
            const activePaneId =
              g.activePaneId && !paneIds.includes(g.activePaneId)
                ? paneIds[Math.min(g.paneIds.indexOf(g.activePaneId), paneIds.length - 1)]
                : g.activePaneId;
            return { ...g, paneIds, activePaneId };
          })
          .filter(g => g.paneIds.length > 0),
      );
    }

    if (activateInGroup) {
      const { groupId, paneId } = activateInGroup;
      setGroups(prev => {
        const next = prev.map(g => (g.id === groupId ? { ...g, activePaneId: paneId } : g));
        return next.some((g, i) => g !== prev[i]) ? next : prev;
      });
      // Adopt the active chat's group as focus ONLY when no valid focus is set
      // yet — otherwise this would steal focus from a restored cell (e.g. the
      // user was focused on a terminal split, not the chat) on first hydration.
      const cur = focusedGroupIdRef.current;
      const curValid = !!cur && groupsRef.current.some(g => g.id === cur);
      if (!curValid) setFocusedGroupId(groupId);
    }
  }, [focusedGroupIdRef, groupsRef]);

  // --- reopenChatPane: add stub + place in group via fallback chain ---
  // Used by `useProjectChatSync.reopenTopic` in Commit 4. Unused this commit.
  const reopenChatPane = useCallback(
    (topicId: string, title: string, targetGroupId?: string) => {
      const paneId = createPaneId('chat', topicId);
      // An explicit target group (the tab bar the user clicked "+ new chat" on).
      // Treat empty/missing/closed ids as "no target" → normal fallback chain.
      const targetGroup = targetGroupId
        ? groupsRef.current.find(g => g.id === targetGroupId)
        : undefined;

      // 1) Already exists AND already in a group? Just focus its group.
      // If it exists in `panes` but not in any group (orphan — happens when
      // chat-sync added the pane just before this call, before orphan-sync
      // could place it), fall through to step 3 and place + focus.
      const existing = panesRef.current.find(p => p.id === paneId);
      if (existing) {
        const g = groupsRef.current.find(g => g.paneIds.includes(paneId));
        // With an explicit target, a pane sitting in the wrong group must be
        // RELOCATED (covers the race where orphan-sync claimed it into a 'chat'
        // group first) — fall through to the targeted-placement block below.
        if (g && !(targetGroup && g.id !== targetGroup.id)) {
          setFocusedGroupId(g.id);
          setGroups(prev =>
            prev.map(gg => (gg.id === g.id ? { ...gg, activePaneId: paneId } : gg)),
          );
          return;
        }
        // Orphan or needs relocation — fall through (skip step 2 add).
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

      // 2b) Explicit target group: place (or relocate) the chat there,
      // regardless of the group's type — this is what lets a chat live in the
      // same tab bar as terminals. Remove the pane from any other group first.
      if (targetGroup) {
        // Tell orphan-sync to leave this pane alone for the current render
        // burst so type-affinity can't claim it into a 'chat' group; relocation
        // below is the correctness guarantee, this just avoids a 1-frame flash.
        pendingTargetedChatRef.current = { paneId };
        setGroups(prev => {
          const next = prev
            .map(g => {
              if (g.id === targetGroup.id) {
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
            .filter(g => g.paneIds.length > 0);
          return next;
        });
        setFocusedGroupId(targetGroup.id);
        // Clear after the synchronous re-render burst (relocation has landed).
        setTimeout(() => {
          if (pendingTargetedChatRef.current?.paneId === paneId) {
            pendingTargetedChatRef.current = null;
          }
        }, 0);
        return;
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
        // Respect MAX_COLS_PER_ROW (handleSplitGroup enforces it; this
        // fallback must not bypass it) — overflow into a fresh row.
        if (firstRow.groupIds.length >= MAX_COLS_PER_ROW) {
          return [...prev, { groupIds: [newGroupId], widths: [1] }];
        }
        const all = [...firstRow.groupIds, newGroupId];
        return [
          // Keep the first row's existing columns in proportion; the reopened
          // chat takes a fair share (was `1/n` — reset the row on reopen).
          { groupIds: all, widths: appendColumnWidths(firstRow.widths, 1) },
          ...prev.slice(1),
        ];
      });
      setFocusedGroupId(newGroupId);
    },
    [groupsRef, focusedGroupIdRef, panesRef],
  );

  // Merge a partial update into a project pane (e.g. persist a browser pane's
  // url so it restores after restart). Change-gated by the caller; the new pane
  // object round-trips through projectLayoutSync (full-state JSON).
  const updatePane = useCallback((paneId: string, updates: Partial<Pane>) => {
    setPanes(prev => prev.map(p => (p.id === paneId ? { ...p, ...updates } : p)));
  }, []);
  updatePaneRef.current = updatePane;

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
      updatePane,
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
