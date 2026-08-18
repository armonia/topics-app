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
import type { TerminalAgentType } from '../../../../../shared/terminal-session-types';
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
  addBrowserTombstone,
  clearBrowserTombstone,
  getBrowserTombstones,
  recordBrowserOrigin,
  drainProjectBrowserReopens,
} from '../../../state/pane/adapters';
import type { ClosedTabRecord } from '../../../state/pane/adapters/hooks/useClosedTabs';
import { findPreviewPane, replacePaneInGroup } from '../../../lib/previewTabs';
import { buildTerminalSessionBody, normalizeTerminalAgent, TERMINAL_AGENT_LABELS } from '../../../lib/terminalAgents';
import { pushUndo } from '../../../contexts/UndoContext';
import { enqueuePendingAction, tickPendingAction, cancelPendingAction } from '../../../contexts/PendingActionContext';
import { useRefMirror } from '../../../hooks/useRefMirror';
import { splitColumnWidths, appendColumnWidths } from '../gridWidths';
import { notifyPaneReflow } from '../paneReflow';
import {
  addGroupToColumnStack,
  allGroupIdsInRows,
  isColumnStackFull,
  locateGroup,
} from '../groupLayoutStacks';
import { clearBrowserSpawner } from '../../../state/browserSpawner';
import { isTauri } from '../../../lib/shell';
import { tauriInvoke } from '../../../lib/shell/tauri';
import { MAX_COLS_PER_ROW, MAX_ROWS } from '../constants';
import type { ChatReconciliation, PersistedSnapshot, PersistenceGateRefs } from './types';
import { stripWrapperPaneId } from './projectPersistence';
import {
  detachPaneFromGroups,
  movePaneBetweenGroups,
  paneTypeToGroupType,
} from './groupOps';
import { reconcileGroupsWithPanes } from './groupPaneReconcile';
import { useProjectFileOpen } from './useProjectFileOpen';
import { useProjectBrowserPanes } from './useProjectBrowserPanes';
import { useProjectTerminalSync } from './useProjectTerminalSync';
import { reconcileRowsWithGroups } from './rowLayoutReconcile';
import { popOutTopic } from '../../../lib/popOutTopic';

// --- Module-local helpers (mirrors of ProjectWindow.tsx helpers) ---

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
  pendingTerminalType?: TerminalAgentType;
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
  stopSession: (sk: string) => Promise<boolean>;
  // For settings modal hop-out:
  onOpenPaneSettings: (topicId: string) => void;
  // Cross-hook gates (read-only here):
  gateRefs: PersistenceGateRefs;
  // Browser navigation outflow — the URL the server (or a local /browser
  // slash command) wants the embedded browser pane to navigate to. The
  // ProjectWindow holds this in component-local state and threads it into
  // `<RemoteBrowserPanel navigateUrl={…} />`. Called from the WS listener
  // installed below.
  /** Push a navigation into a SPECIFIC browser pane (`paneId`). Without the
   *  target, every visible browser pane consumed the same window-level URL —
   *  with splits, N panes navigated in lockstep. */
  onBrowserNavigateUrl?: (url: string, paneId?: string) => void;
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
    addWhenEmpty: (type: PaneType, subType?: string, paneKey?: string) => Promise<string | undefined>;
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
  // Stessa plumbing: la chiusura di una pane browser richiesta dalla PAGINA
  // (`window.close()` → `browser:request-close`) entra da `useProjectBrowserPanes`,
  // montato in cima, ma `handleClosePane` nasce ~700 righe più in basso.
  const handleClosePaneRef = useRef<((groupId: string, paneId: string) => void) | null>(null);
  // Stessa plumbing per il progetto SENZA gruppi. `handleAddPaneToGroup` vuole
  // un gruppo che lì non esiste, e senza questo l'unica risposta possibile era
  // «non fare niente»: un progetto con tutte le tab chiuse ingoiava in silenzio
  // l'apertura chiesta dalla board («Apri nel workspace»). Vedi la guardia
  // `if (!fgid)` in `useProjectBrowserPanes`.
  const handleAddPaneWhenEmptyRef = useRef<((type: PaneType, subType?: string, paneKey?: string) => Promise<string | undefined>) | null>(null);

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
  // Si toglie la pane solo se la chat è stata davvero buttata via, e a dirlo è
  // il server (`stopSession` risolve sul suo `cleared`).
  const handleStopStreaming = useCallback((paneId: string) => {
    const pane = panes.find(p => p.id === paneId);
    if (!pane?.topicId) return;
    const topic = topics[pane.topicId];
    if (!topic) return;
    void stopSession(topic.sessionKey).then((discarded) => {
      if (discarded) setPanes(prev => prev.filter(p => p.id !== paneId));
    });
  }, [panes, topics, stopSession]);

  // --- Sync terminal panes: remove stale, auto-add active terminals ---
  // Roster, prune e dormienti stanno in `useProjectTerminalSync`: possiede le
  // sue tre memorie e scrive SOLO `panes`.
  useProjectTerminalSync({ projectPath, topicsRef, onWSMessage, setPanes });

  // --- Browser panes (open / navigate / focus / close / split) ---
  // Tutto in `useProjectBrowserPanes`. Gli handler che gli servono nascono
  // centinaia di righe più in basso: per questo arrivano come ref.
  useProjectBrowserPanes({
    projectPath,
    topics,
    panes,
    groups,
    panesRef,
    groupsRef,
    focusedGroupIdRef,
    setGroups,
    setFocusedGroupId,
    onWSMessage,
    onBrowserNavigateUrl,
    handleAddPaneToGroupRef,
    handleAddPaneWhenEmptyRef,
    handleSplitGroupRef,
    handleClosePaneRef,
    updatePaneRef,
  });


  // --- Sync groups with panes (orphan-sync, immutable, no mutations) ---
  // La regola sta in `reconcileGroupsWithPanes` (puro, testato); qui resta solo
  // il ponte verso lo stato: leggere il fuoco dalla ref e parcheggiare la chat
  // di anteprima sostituita per l'effetto che la chiude.
  useEffect(() => {
    setGroups(prev => {
      const { groups: next, previewCloseTopicId } = reconcileGroupsWithPanes(
        prev,
        panes,
        focusedGroupIdRef.current,
        // Skip the pane that reopenChatPane is about to place into an explicit
        // target group — see pendingTargetedChatRef. Leaving it orphan for this
        // tick prevents type-affinity from claiming it into a 'chat' group.
        pendingTargetedChatRef.current?.paneId,
      );
      if (previewCloseTopicId) pendingPreviewCloseRef.current = previewCloseTopicId;
      return next;
    });
  }, [panes, focusedGroupIdRef]);

  // --- Sync rows/heights with groups ---
  // Restore-active-chat is owned by `useProjectChatSync` via
  // `applyChatReconciliation.activateInGroup` (Commit 4) — the layout-side
  // effect that used to live here was redundant and has been removed.
  //
  // La regola sta in `reconcileRowsWithGroups` (puro, testato). `rows` e
  // `rowHeights` restano fuori dalle dipendenze perché sono l'OUTPUT di questa
  // passata, non il suo input — ora la firma della funzione lo dice al posto di
  // un commento, e i due `.current` sono i suoi argomenti.
  useEffect(() => {
    const next = reconcileRowsWithGroups(rowsRef.current, rowHeightsRef.current, groups);
    if (!next) return;
    setRows(next.rows);
    if (next.rowHeights) setRowHeights(next.rowHeights);
  }, [groups, rowsRef, rowHeightsRef]);

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
    // I CONTEGGI, non gli array: la migrazione scatta al più una volta
    // (`migrated.current`) e legge le pane da `panesRef.current`. Dipendere
    // dall'identità degli array rifarebbe partire l'effetto a ogni modifica di
    // una pane, per un lavoro che può accadere una volta sola.
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
            fetch(`/api/browsers/${encodeURIComponent(bctx)}/cdp-target`, { method: 'DELETE', keepalive: true }).catch(() => {});
            // Tear down any server-side Playwright context that backed this pane.
            fetch(`/api/browsers/${encodeURIComponent(bctx)}`, { method: 'DELETE', keepalive: true }).catch(() => {});
            // Drop the spawner relationship so the "opened a browser" tab cue clears.
            clearBrowserSpawner(bctx);
            // E la webview NATIVA: si chiude qui, non aspettando che React
            // smonti la pane. Il commento qui sopra descrive già il caso —
            // «the close committed at unload via flushPendingActions, where
            // React never re-renders» — ma la conseguenza era stata vista solo
            // per il tombstone: in quello stesso scenario non gira nemmeno la
            // cleanup di useTauriBrowser, che è l'UNICO posto che chiama
            // `browser_close`. La pane non si rimonta più (è chiusa, col suo
            // tombstone) e le webview native sopravvivono al reload per
            // progetto, quindi quella pagina resta dipinta sopra
            // l'interfaccia finché non si riavvia l'app.
            if (isTauri) void tauriInvoke('browser_close', { id: bctx }).catch(() => {});
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

      setGroups(prev => detachPaneFromGroups(prev, groupId, paneId));
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

  // Focus a pane that ALREADY lives inside this project (sidebar click on a
  // project-owned browser/terminal). usePanelLifecycle can only focus the
  // project PANE — which tab is active inside a group is project-layout state,
  // so the request arrives here via the same claim protocol as
  // reopen-closed-tab: only the window whose projectPath matches AND actually
  // hosts the pane activates it (and preventDefault()s).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ projectPath?: string; paneId?: string }>).detail;
      if (!detail?.paneId || detail.projectPath !== projectPath) return;
      const owner = groups.find(g => g.paneIds.includes(detail.paneId!));
      if (!owner) return; // not mounted in this window — leave unclaimed
      e.preventDefault();
      setGroups(prev => prev.map(g =>
        g.id === owner.id && g.activePaneId !== detail.paneId ? { ...g, activePaneId: detail.paneId! } : g,
      ));
      setFocusedGroupId(owner.id);
    };
    window.addEventListener('topics:focus-project-pane', handler);
    return () => window.removeEventListener('topics:focus-project-pane', handler);
  }, [groups, projectPath]);

  // Drain any reopen parked for THIS project by openBrowserPane's not-open path:
  // when a pinned browser is reopened while its ProjectWindow is closed, that
  // handler opens the project (handleProjectClick) AND enqueues the synthetic
  // record here. This runs on mount — once the freshly-opened window exists — and
  // restores the browser with its url, closing the async open→mount gap that the
  // one-shot 'reopen-closed-tab' event (dispatched before mount) would have missed.
  useEffect(() => {
    const parked = drainProjectBrowserReopens(projectPath);
    for (const rec of parked) void restoreClosedRecord(rec);
  }, [projectPath, restoreClosedRecord]);

  // Listen for Cmd+W → close-focused-pane: when this project is the App-
  // focused panel, close its inner active sub-tab instead of letting the
  // App-level handler close the whole project. preventDefault marks the
  // event handled so App falls through.
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
    // `paneKey` come in `handleAddPaneToGroup`: una pane browser deve poter
    // nascere legata al SUO contextId (`browser:<ctx>`), altrimenti chi la
    // apre non la ritrova e l'agente non la sa pilotare. Il menu «+» non lo
    // passa e ottiene l'id casuale di prima.
    async (type: PaneType, subType?: string, paneKey?: string) => {
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
        paneId = createPaneId(type, paneKey);
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
      return paneId;
    },
    [projectPath, claudeSkipPermissions],
  );

  // Pinned each render, come `handleAddPaneToGroupRef`: l'effetto browser è
  // montato in cima a questo hook e questo handler nasce qui, ~700 righe sotto.
  handleAddPaneWhenEmptyRef.current = handleAddPaneWhenEmpty;

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

  // --- File / diff / process-log opening ---
  // Tre handler quasi identici + i loro listener globali stanno in
  // `useProjectFileOpen`; la regola di collocazione è `planOpenPane` (puro).
  const { openFile: handleOpenFile, openDiff: handleOpenDiff, openProcessLog: handleOpenProcessLog } =
    useProjectFileOpen({
      wrapperPaneId,
      panesRef,
      groupsRef,
      focusedGroupIdRef,
      focusedPanelIdRef,
      setPanes,
      setGroups,
      setFocusedGroupId,
    });


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
      setGroups(prev =>
        movePaneBetweenGroups(prev, sourceGroupId, targetGroupId, paneId, insertIdx),
      );
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

      setGroups(prev => [...detachPaneFromGroups(prev, sourceGroupId, paneId), newGroup]);

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
    // Durable origin: a project browser's url lives ONLY in this snapshot (and is
    // stripped on close), so mirror every url write into the closedStack-
    // independent origin store. That lets a pinned browser reopen back into THIS
    // project — with its last url — even after its close record is evicted from
    // the bounded stack. `getBrowserContextFromPaneId` returns non-null only for
    // `browser:<ctx>` ids, so this is a no-op for chat/terminal panes.
    if (updates.url) {
      const bctx = getBrowserContextFromPaneId(paneId);
      if (bctx) recordBrowserOrigin(bctx, projectPath, updates.url, updates.title);
    }
  }, [projectPath]);
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
