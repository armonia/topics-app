/**
 * usePanelLifecycle — owns the full panel-state cluster.
 *
 * Extracted from App.tsx during Phase 3 (hook 3 of 4). Largest hook.
 * Per CRITIQUE C3/C4/C13/C14: panel state, store-sync, validation, AND
 * `ownTopicSwitchesRef` all live here in ONE hook with documented effect
 * declaration order.
 *
 * Effect declaration order (load-bearing — React preserves it):
 *   1. State (openPanels, focusedPanelId, ...)
 *   2. focusedPanelIdRef sync (ISSUE 3)
 *   3. openPanelsRef + topicsRef sync (ref-mirror for WS handlers — C2/C6)
 *   4. Effect A: store -> React (sets storeSyncInternalRef + microtask)
 *   5. Effect B: React -> store openPanels (guarded by storeSyncInternalRef)
 *   6. Effect C: React -> store focusedPanelId (guarded)
 *   7. Validation effect (array-reference-equality preserved per C4)
 *   8. Terminal cleanup (calls pure pruneStaleTerminalPanes per C5)
 *   9. DraftMeta persistence + 24h cleanup
 *   10. Board task counts: initial fetch
 *   11-16. Per-cluster WS subscriptions (6 clusters per C6):
 *          1=topic sync, 2=message sync, 3=topic switch (owns
 *          ownTopicSwitchesRef per C13), 4=open-project, 5=cross-window
 *          drag, 6=board task counts
 *   17. Drain queue + reload histories on WS reconnect
 *   18. Auto-expand projects on openPanels change
 *   19. Electron navigate-to-topic + report focused
 *   20. Detached auto-close
 *
 * NO setOpenPanels argument crosses any seam (C5). Cross-hook reads
 * happen via stable callbacks or pure helpers.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { CreateTopicRequest, PaneType, PanelTab, TerminalSessionInfo, Topic, WSMessage } from '../types';
import type { ChatStreamHandlers, TerminalOps } from './appHookTypes';
import {
  createDraftPaneId,
  createPaneId,
  isBrowserPaneId,
  isDraftPaneId,
  isKnownPanePrefix,
  isProjectPaneId,
  isUUIDLike,
  reopenClosedTab,
  type ClosedTabRecord,
  getProjectPathFromPaneId,
  projectPanesLocalKey,
  projectLayoutLocalKey,
} from '../state/pane/adapters';
import { findPaneLocation, usePaneStore } from '../state/pane/store';
import { seedBrowserPaneInitialUrl } from '../state/pane/browserPaneUrl';
import {
  buildTerminalSessionBody,
  normalizeTerminalAgent,
  TERMINAL_AGENT_LABELS,
  type TerminalAgentType,
} from '../lib/terminalAgents';

import { utilityPanelId } from '../components/Layout/UtilityPanel';
import { DEFAULT_TOPIC_ICON } from '../lib/topicIcons';
import { notifyNative } from '../lib/shell/app';
import { markTabRestored } from '../lib/previewTabs';
import { pushUndo } from '../contexts/UndoContext';
import { useRefMirror } from './useRefMirror';

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

const loadSavedPanels = (): string[] => {
  try {
    const s = usePaneStore.getState();
    const defaultGroup = s.groups['group:default'];
    const order = defaultGroup?.paneIds ?? [];
    const draftMetaRaw = localStorage.getItem('draft-meta');
    const savedDraftMeta = draftMetaRaw ? JSON.parse(draftMetaRaw) : {};
    const now = Date.now();
    return order.filter(id => {
      if (!id.startsWith('draft:')) return true;
      const meta = savedDraftMeta[id];
      if (!meta?.createdAt) return false;
      return (now - new Date(meta.createdAt).getTime()) < TWENTY_FOUR_HOURS;
    });
  } catch {
    return [];
  }
};

// `bootstrapPaneStore()` warm-hydrates the store from localStorage before
// React mounts, so the in-memory store is always the single source of truth
// for focus by the time this initializer runs.
const loadSavedFocused = (): string | null => usePaneStore.getState().focusedPaneId;

/**
 * Register a pane entity in the pane-store BEFORE pushing its id into
 * `openPanels`. The store→React bridge dispatches `REORDER_PANES` from
 * Effect B, which is a *permutation primitive* — its reducer filters out
 * any id whose pane entity does not exist in `state.panes`. Without this
 * dispatch the new id is silently dropped, then Effect A (subscribed to
 * `lastSeq`) reads the unchanged `groups['group:default']` and reverts
 * `setOpenPanels`. Net effect: the click does nothing.
 *
 * The pre-refactor App.tsx had this dispatch only in the terminal
 * handler; project / topic panes opened from the sidebar happened to
 * already exist in the store from prior sessions, masking the bug. Cmd+K
 * → "open project" surfaces it on a fresh session.
 */
function ensurePaneRegistered(
  pane: { id: string; type: PaneType; title?: string; topicId?: string; projectPath?: string; terminalSessionId?: string },
  options?: { groupId?: string },
): void {
  const s = usePaneStore.getState();
  if (s.panes[pane.id]) return;
  // App-level panes ALWAYS belong in the standalone group ('group:default').
  // The previous fallback ("focused pane's group") was a footgun: when the
  // user had a split layout at the App level (or any non-default group held
  // focus), a fresh project / topic / utility pane landed in that other
  // group. Effect A in usePanelLifecycle only observes
  // `groups['group:default'].paneIds`, so the new id was invisible to the
  // store→React bridge — Effect A then reverted `focusedPanelId` back to
  // whatever was previously focused (the "open project, focus snaps back
  // to the previous tab after a delay" bug, surfaced by Cmd+K).
  // Callers that genuinely need to land in a specific group can still pass
  // `options.groupId` explicitly; this is just a safer default.
  const groupId = options?.groupId ?? 'group:default';
  s.dispatch({
    type: 'OPEN_PANE',
    payload: { ...pane, preview: false, groupId },
  });
}

interface PendingProjectFocus { projectPath: string; topicId: string; targetGroupId?: string }
interface PendingProjectPane { projectPath: string; type: PaneType; terminalSessionId?: string; terminalType?: TerminalAgentType }
interface ContextMenuState { x: number; y: number; topic: Topic }

export interface UsePanelLifecycleArgs {
  isDetached: boolean;
  detachedTopicId: string | null;
  isMobile: boolean;
  // Topics
  topics: Record<string, Topic>;
  topicsLoading: boolean;
  loadTopics: () => Promise<unknown> | unknown;
  createTopic: (req: CreateTopicRequest) => Promise<Topic | null>;
  applyTopicFromWS: (topic: Topic) => void;
  archiveProject: (projectPath: string, archive: boolean) => Promise<boolean>;
  // 2-state model (open ⟺ non-archived): opening a chat unarchives it, the
  // explicit user-close of a chat tab archives it. Threaded in so both the
  // open and close funnels can keep tab-state and archived in lockstep.
  archiveTopic: (topicId: string, archive: boolean) => Promise<boolean>;
  workspaceProjects: string[];
  // Terminal lifecycle (no setters cross seam)
  terminalSessions: TerminalSessionInfo[];
  pruneStaleTerminalPanes: (currentPaneIds: string[]) => string[];
  terminalOps: TerminalOps;
  // WS
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  sendWS: (msg: WSMessage) => void;
  wsStatus: 'connecting' | 'connected' | 'reconnecting' | 'offline';
  windowId: string;
  // Chat
  chatStreamHandlers: ChatStreamHandlers;
  // Sidebar coordination (mobile-only)
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  // Closed-tabs undo
  removeClosedTab: (id: string) => void;
}

export interface UsePanelLifecycleReturn {
  state: {
    openPanels: string[];
    focusedPanelId: string | null;
    previewPanelId: string | null;
    nextPanelMode: 'side' | 'below';
    draftMeta: Record<string, { projectPath?: string; createdAt?: string }>;
    pendingProjectFocus: PendingProjectFocus | null;
    projectActiveTopics: Record<string, string | null>;
    projectOpenPanes: Record<string, string[]>;
    pendingProjectPane: PendingProjectPane | null;
    panelInitialTab: Record<string, PanelTab>;
    contextMenu: ContextMenuState | null;
    expandedProjects: string[];
    externalDragTopicId: string | null;
    externalDragSourceWindow: string | null;
    pendingBrowserPane: string | null;
    pendingSoloPanelId: string | null;
  };
  refs: {
    focusedPanelIdRef: React.MutableRefObject<string | null>;
    openPanelsRef: React.MutableRefObject<string[]>;
  };
  derived: {
    focusedProjectPath: string | undefined;
  };
  handlers: {
    openPanel: (topicId: string, mode: 'preview' | 'permanent' | 'below', autoFocus?: boolean) => void;
    handleTopicClick: (topicId: string, e?: React.MouseEvent) => void;
    handleTopicDoubleClick: (topicId: string, e?: React.MouseEvent) => void;
    handleClosePanel: (topicId: string) => void;
    handleProjectClick: (projectPath: string) => void;
    handleCloseProject: (projectPath: string) => void;
    handleFocusPanel: (topicId: string) => void;
    handleReorderPanels: (panels: string[]) => void;
    handleOpenPanelAt: (topicId: string, index: number) => void;
    handleOpenAsProject: (path: string) => void;
    handleAddProjectPane: (projectPath: string, type: PaneType, subType?: string) => void;
    handleArchiveProject: (projectPath: string, archive: boolean) => Promise<boolean>;
    handleTopicContextMenu: (e: React.MouseEvent, topic: Topic) => void;
    // Returns the created Topic (project-level) or the new DRAFT pane id
    // (app-level, string) so split-cell "+ New Chat" can re-target the pane.
    handleQuickCreateTopic: (projectPath?: string, targetGroupId?: string) => Promise<Topic | string | null>;
    handleCreateTopic: (data: CreateTopicRequest) => Promise<Topic | null>;
    promoteDraft: (draftId: string, firstMessage: string, options?: { planMode?: boolean }) => Promise<void>;
    handleQuickCreateTerminal: (termType?: TerminalAgentType, skipPermissions?: boolean, opts?: { role?: 'master'; name?: string }) => Promise<string | null>;
    handleCloseTerminal: (sessionId: string) => Promise<void>;
    handleTerminalClick: (sessionId: string, sessionName: string) => void;
    handleOpenAsPage: (type: 'activity' | 'agents' | 'dashboard' | 'cron') => void;
    handleExternalDrop: () => void;
    handleReopenClosedTab: (record: ClosedTabRecord) => Promise<void>;
    handleProjectActiveTopicChange: (projectPath: string, topicId: string | null) => void;
    handleProjectOpenPanesChange: (projectPath: string, paneIds: string[]) => void;
    handlePendingBrowserPaneConsumed: () => void;
    handlePendingSoloConsumed: () => void;
    openBrowserPane: (contextId: string) => void;
    setNextPanelMode: Dispatch<SetStateAction<'side' | 'below'>>;
    setExpandedProjects: Dispatch<SetStateAction<string[]>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
    setPendingProjectFocus: Dispatch<SetStateAction<PendingProjectFocus | null>>;
    setPendingProjectPane: Dispatch<SetStateAction<PendingProjectPane | null>>;
    setPanelInitialTab: Dispatch<SetStateAction<Record<string, PanelTab>>>;
  };
}

export function usePanelLifecycle(args: UsePanelLifecycleArgs): UsePanelLifecycleReturn {
  const {
    isDetached, detachedTopicId, isMobile,
    topics, topicsLoading, loadTopics, createTopic, applyTopicFromWS, archiveProject, archiveTopic,
    workspaceProjects,
    terminalSessions, pruneStaleTerminalPanes, terminalOps,
    onWSMessage, sendWS, wsStatus, windowId,
    chatStreamHandlers,
    setSidebarCollapsed, removeClosedTab,
  } = args;

  const {
    isOwnStream, getSessionMessages, addMessageFromWS, clearSession,
    loadHistory, appendMediaToLastAssistant, sendMessage, drainQueue,
  } = chatStreamHandlers;

  // ---- 1. State ----
  const [openPanels, setOpenPanels] = useState<string[]>(() => {
    if (isDetached && detachedTopicId) return [detachedTopicId];
    return loadSavedPanels();
  });
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(() => {
    if (isDetached && detachedTopicId) return detachedTopicId;
    return loadSavedFocused();
  });

  // ---- 2. Sync refs for WS / keyboard handlers (ISSUE 3) ----
  // All three are read inside stable callbacks that can't take the React
  // state as a dep (would cause re-binds on every change). useRefMirror
  // is the canonical helper for this pattern.
  const focusedPanelIdRef = useRefMirror(focusedPanelId);
  const openPanelsRef = useRefMirror(openPanels);
  const topicsRef = useRefMirror(topics);
  // Mirrored so the stable handleFocusPanel callback (deps: [openPanel]) can
  // read the current project paths + sessions when applying the broad-path
  // guard — without these it would close over the first render's values.
  const workspaceProjectsRef = useRefMirror(workspaceProjects);
  const terminalSessionsRef = useRefMirror(terminalSessions);
  // openPanel is declared far below (it depends on many of the above), but the
  // stable WS effects need to call it. Declare the mirror ref here (before
  // those effects) and sync it after openPanel's declaration — referencing the
  // openPanel const directly in the effects reads it before declaration.
  const openPanelRef = useRef<(topicId: string, mode: 'preview' | 'permanent' | 'below', autoFocus?: boolean) => void>(() => {});


  // ---- 4-6. Pane-store <-> React three-effect bridge (CRITIQUE C3) ----
  const storeSyncInternalRef = useRef(false);
  // Effect A: store -> React
  useEffect(() => {
    if (isDetached) return;
    const applyFromStore = () => {
      const s = usePaneStore.getState();
      const storeOrder = s.groups['group:default']?.paneIds ?? [];
      const storeFocus = s.focusedPaneId;
      // Pre-hydrate guard: the bootstrap path runs Effect A synchronously
      // at mount, before WS init or the 500ms /api/ui-state fallback has
      // hydrated the store. At that moment storeOrder=[] and storeFocus=null.
      // Letting the fallback `storeOrder[0] ?? null` run would WIPE the
      // local-only focused pane id seeded from `pane-store-focused-id`,
      // and then post-hydrate apply would land on the first pane regardless
      // of where the user was before reload. Skip until the store has panes.
      if (storeOrder.length === 0) return;
      storeSyncInternalRef.current = true;
      setOpenPanels(prev => {
        if (prev.length === storeOrder.length && prev.every((id, i) => id === storeOrder[i])) return prev;
        return storeOrder;
      });
      setFocusedPanelId(prev => {
        if (prev === storeFocus) return prev;
        if (storeFocus && storeOrder.includes(storeFocus)) return storeFocus;
        if (prev && storeOrder.includes(prev)) return prev;
        return storeOrder[0] ?? storeFocus ?? null;
      });
      queueMicrotask(() => { storeSyncInternalRef.current = false; });
    };
    applyFromStore();
    const unsub = usePaneStore.subscribe(
      (s) => s.lastSeq,
      () => applyFromStore(),
    );
    return () => unsub();
  }, [isDetached]);

  // Effect B: React -> store openPanels
  useEffect(() => {
    if (isDetached) return;
    if (storeSyncInternalRef.current) return;
    const s = usePaneStore.getState();
    const storeOrder = s.groups['group:default']?.paneIds ?? [];
    const changed = storeOrder.length !== openPanels.length || !storeOrder.every((id, i) => id === openPanels[i]);
    if (changed) {
      s.dispatch({
        type: 'REORDER_PANES',
        payload: { groupId: 'group:default', paneIds: openPanels },
      });
    }
  }, [openPanels, isDetached]);

  // Effect C: React -> store focusedPanelId
  useEffect(() => {
    if (isDetached) return;
    if (storeSyncInternalRef.current) return;
    const s = usePaneStore.getState();
    if (s.focusedPaneId !== focusedPanelId) {
      s.dispatch({ type: 'FOCUS_PANE', payload: { id: focusedPanelId } });
    }
  }, [focusedPanelId, isDetached]);

  // ---- Pending focus / project state ----
  const [pendingProjectFocus, setPendingProjectFocus] = useState<PendingProjectFocus | null>(null);
  const [projectActiveTopics, setProjectActiveTopics] = useState<Record<string, string | null>>({});
  const handleProjectActiveTopicChange = useCallback((projectPath: string, topicId: string | null) => {
    setProjectActiveTopics(prev => prev[projectPath] === topicId ? prev : { ...prev, [projectPath]: topicId });
  }, []);
  const [projectOpenPanes, setProjectOpenPanes] = useState<Record<string, string[]>>({});
  const handleProjectOpenPanesChange = useCallback((projectPath: string, paneIds: string[]) => {
    setProjectOpenPanes(prev => {
      const existing = prev[projectPath];
      if (existing && existing.length === paneIds.length && existing.every((id, i) => id === paneIds[i])) return prev;
      return { ...prev, [projectPath]: paneIds };
    });
  }, []);
  // Ref mirror so the WS force-open handler can read the latest project-owned
  // panes without re-subscribing on every layout change.
  const projectOpenPanesRef = useRefMirror(projectOpenPanes);

  // Cross-window drag state
  const [externalDragTopicId, setExternalDragTopicId] = useState<string | null>(null);
  const [externalDragSourceWindow, setExternalDragSourceWindow] = useState<string | null>(null);

  const [pendingProjectPane, setPendingProjectPane] = useState<PendingProjectPane | null>(null);
  const [panelInitialTab, setPanelInitialTab] = useState<Record<string, PanelTab>>({});
  const [draftMeta, setDraftMeta] = useState<Record<string, { projectPath?: string; createdAt?: string }>>(() => {
    try {
      const saved = localStorage.getItem('draft-meta');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });

  // DraftMeta persistence
  useEffect(() => {
    try { localStorage.setItem('draft-meta', JSON.stringify(draftMeta)); } catch {}
  }, [draftMeta]);

  // DraftMeta 24h cleanup
  useEffect(() => {
    const now = Date.now();
    setDraftMeta(prev => {
      const next: typeof prev = {};
      let changed = false;
      for (const [id, meta] of Object.entries(prev)) {
        if (meta.createdAt && (now - new Date(meta.createdAt).getTime()) >= TWENTY_FOUR_HOURS) {
          changed = true;
          try { localStorage.removeItem(`draft-content-${id}`); } catch {}
        } else {
          next[id] = meta;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  // ---- 7. Validation effect (CRITIQUE C4 array-ref-equality preserved) ----
  const prevOpenPanelsForValidation = useRef<string[]>(openPanels);
  const prevTopicsForValidation = useRef(topics);
  useEffect(() => {
    if (!topicsLoading && Object.keys(topics).length > 0 && !isDetached) {
      const panelsChanged = openPanels !== prevOpenPanelsForValidation.current;
      const topicsChanged = topics !== prevTopicsForValidation.current;
      prevTopicsForValidation.current = topics;
      if (!panelsChanged && !topicsChanged) return;

      const projectPanesToAdd: string[] = [];
      // Post-mortem (May 3 sidebar-flash): a topic with `projectPath` that
      // somehow ended up in openPanels must NOT just be filtered out of
      // React state — the same id is still in pane-store-v2.panes/groups
      // and ui_state, and the next WS hydrate re-applies it, producing a
      // ~750 Hz Effect 7 ↔ HYDRATE ping-pong. We accumulate the orphan
      // ids here and dispatch PURGE_ORPHAN_PANE for each one AFTER the
      // setOpenPanels call below — so the removal lands in the store and
      // the outbound sync clears ui_state on the server too.
      const orphanTopicIdsToPurge: string[] = [];
      const validPanels = openPanels.filter(id => {
        if (isKnownPanePrefix(id)) return true;
        const topic = topics[id];
        if (!topic) return isUUIDLike(id);
        if (topic.archived) return false;
        if (topic.projectPath) {
          const paneId = createPaneId('project', topic.projectPath);
          if (!projectPanesToAdd.includes(paneId)) projectPanesToAdd.push(paneId);
          if (!orphanTopicIdsToPurge.includes(id)) orphanTopicIdsToPurge.push(id);
          return false;
        }
        return true;
      });
      for (const p of projectPanesToAdd) {
        if (!validPanels.includes(p)) validPanels.push(p);
      }
      const changed = validPanels.length !== openPanels.length || validPanels.some((v, i) => v !== openPanels[i]);
      if (changed) {
        prevOpenPanelsForValidation.current = validPanels;
        setOpenPanels(validPanels);
        // Drain the orphan list into the pane store so this corruption
        // doesn't bounce back through the next hydrate. Dispatched after
        // setOpenPanels so the React state and store state converge in
        // the same frame (Effect B then sees a clean openPanels and the
        // store already free of the orphan — no spurious REORDER_PANES).
        if (orphanTopicIdsToPurge.length > 0) {
          const dispatch = usePaneStore.getState().dispatch;
          for (const orphanId of orphanTopicIdsToPurge) {
            dispatch({ type: 'PURGE_ORPHAN_PANE', payload: { id: orphanId } });
          }
        }
        if (focusedPanelId && !validPanels.includes(focusedPanelId) && !isBrowserPaneId(focusedPanelId)) {
          const movedTopic = topics[focusedPanelId];
          if (movedTopic?.projectPath) {
            const projectPaneId = createPaneId('project', movedTopic.projectPath);
            setFocusedPanelId(projectPaneId);
            setPendingProjectFocus({ projectPath: movedTopic.projectPath, topicId: focusedPanelId });
          } else {
            setFocusedPanelId(validPanels.length > 0 ? validPanels[0] : null);
          }
        }
      } else {
        prevOpenPanelsForValidation.current = openPanels;
      }
    }
  }, [topics, topicsLoading, isDetached, openPanels, focusedPanelId]);

  // ---- 8. Terminal cleanup effect (CRITIQUE C5: pure helper) ----
  useEffect(() => {
    setOpenPanels(prev => {
      const filtered = pruneStaleTerminalPanes(prev);
      return filtered === prev ? prev : filtered;
    });
  }, [terminalSessions, pruneStaleTerminalPanes]);

  // ---- Derived: focusedProjectPath ----
  const focusedProjectPath = useMemo(() => {
    if (!focusedPanelId) return undefined;
    if (isProjectPaneId(focusedPanelId)) return getProjectPathFromPaneId(focusedPanelId) || undefined;
    return topics[focusedPanelId]?.projectPath || undefined;
  }, [focusedPanelId, topics]);

  // ---- Browser pane management ----
  const [pendingBrowserPane, setPendingBrowserPane] = useState<string | null>(null);
  const handlePendingBrowserPaneConsumed = useCallback(() => setPendingBrowserPane(null), []);
  const [pendingSoloPanelId, setPendingSoloPanelId] = useState<string | null>(null);
  const handlePendingSoloConsumed = useCallback(() => setPendingSoloPanelId(null), []);
  // A browser pane is GENUINELY owned by a project window only when that
  // project's tab is actually open at the app level (its project pane is in
  // `openPanels`, i.e. the ProjectWindow is mounted and reacting to the
  // open-near-pane broadcast). `projectOpenPanes` is an upsert-only map — it is
  // NEVER pruned when a project tab closes (handleProjectOpenPanesChange only
  // adds/replaces per path), so a `browser:term-<id>` left over from a CLOSED
  // project lingers forever. Such a STALE entry would otherwise (a) make the
  // force-open fallback below skip — nothing visible mounts despite the 200 —
  // and (b) make the PURGE reconcile delete a legitimate standalone fallback
  // that happens to share the id. Gate every ownership check through here so a
  // closed project can't swallow a session-initiated open. Returns the owning
  // project PATH when a live window renders it, else null.
  const owningRenderedProject = useCallback((browserPaneId: string): string | null => {
    const owner = Object.entries(projectOpenPanesRef.current)
      .find(([, ids]) => ids.includes(browserPaneId))?.[0];
    if (!owner) return null;
    return openPanelsRef.current.includes(createPaneId('project', owner)) ? owner : null;
  }, [projectOpenPanesRef, openPanelsRef]);
  const openBrowserPane = useCallback((contextId: string) => {
    const paneId = `browser:${contextId}`;
    // If this browser pane is already open somewhere (standalone group or
    // a solo split cell), don't queue another `pendingBrowserPane` — that
    // path runs `ensureBrowserPane` inside the *standalone* group's
    // singleton reducer, which would create a second `browser:${contextId}`
    // entry there even when an identically-keyed pane already lives in a
    // solo cell. The duplicate then mounts two `useNativeBrowser` hooks
    // for the same contextId and Electron's view-reuse logic
    // (electron-app/main.ts: `browser-native:create` reuses by topicId)
    // hands them the SAME viewId. Both placeholders race to set bounds,
    // and clicks land on whichever placeholder won the last setBounds.
    // Focus-only is the right behaviour — the existing pane comes back
    // to the front in whichever cell hosts it.
    if (openPanelsRef.current.includes(paneId)) {
      setFocusedPanelId(paneId);
      if (isMobile) setSidebarCollapsed(true);
      return;
    }
    // Already open INSIDE a project window: the pane is owned by that project's
    // own layout (projectOpenPanes), so it never appears in the app-level
    // openPanels the check above scans. Without this, a sidebar click on a
    // project-owned browser falls through and spawns a SECOND standalone
    // `browser:<ctx>` pane — but one native WebContentsView can only mount in a
    // single DOM slot, so the user ends up with the live page in the project
    // cell and an EMPTY browser in the new split (the bug the force-open guard
    // and the PURGE_ORPHAN reconcile below already defend against on other
    // paths). Focus the owning project instead of duplicating.
    const owningProject = owningRenderedProject(paneId);
    if (owningProject) {
      setFocusedPanelId(createPaneId('project', owningProject));
      if (isMobile) setSidebarCollapsed(true);
      return;
    }
    setPendingBrowserPane(contextId);
    setPendingSoloPanelId(paneId);
    if (isMobile) {
      setSidebarCollapsed(true);
    }
  }, [isMobile, setSidebarCollapsed, openPanelsRef, owningRenderedProject]);

  // Server fallback for open_browser_pane: when the normal broadcast
  // (browser:navigate / browser:open-near-pane) mounted NO visible pane in any
  // rendered cell — because the spawner terminal/topic isn't a tab anywhere — the
  // server emits browser:force-open so the PRIMARY window opens a visible browser
  // pane the user can SEE. Without this the agent's browser_* tools silently drove
  // an off-screen Playwright phantom (now also refused server-side). openBrowserPane
  // is single-owner (routes through pendingBrowserPane → the standalone cell only)
  // and idempotent (focus-only if already open), so this can't double-mount; the
  // url is loaded by the server over CDP once the forced pane registers its target.
  useEffect(() => {
    return onWSMessage((msg) => {
      if (msg.type === 'browser:force-open' && msg.contextId) {
        // A project window may already OWN this browser: it claimed the earlier
        // `browser:open-near-pane` (the spawner terminal/chat is a tab in its
        // layout) and mounted the pane beside that pane. force-open is only a
        // fallback for when NO visible surface showed it. Opening a standalone
        // pane with the SAME id (`browser:<contextId>`) here would duplicate the
        // tab ACROSS surfaces — and since one native WebContentsView can mount in
        // a single DOM slot, the user sees the page in the project cell and an
        // EMPTY browser in the standalone cell (or vice-versa). Skip when any
        // project window already lists this browser pane.
        const browserPaneId = `browser:${msg.contextId}`;
        const owner = owningRenderedProject(browserPaneId);
        if (owner) {
          // A LIVE project window owns and renders this pane — its
          // open-near-pane handler already mounted the browser beside the
          // spawner and activated the browser's in-cell tab. The one thing it
          // could NOT do is surface a project tab that's a background app-level
          // tab (display:none). Bring that project tab to the front so the pane
          // is actually visible (idempotent when the project is already active).
          setFocusedPanelId(createPaneId('project', owner));
          return;
        }
        // No live owner — either no project ever owned it, OR the only entry is
        // STALE from a project tab that was since closed (owningRenderedProject
        // returns null for those). Mount a visible standalone pane so a
        // session-initiated open ALWAYS surfaces something, instead of being
        // silently swallowed by a dead ownership record. Seed the URL BEFORE the
        // pane mounts (the native hook ref-captures initialUrl once at mount) so
        // it NAVIGATES — on Tauri the server can't drive it over CDP, so the
        // client is the only thing that loads the page (else: blank pane).
        seedBrowserPaneInitialUrl(browserPaneId, msg.url);
        openBrowserPane(msg.contextId);
      }
    });
  }, [onWSMessage, openBrowserPane, owningRenderedProject]);

  // Reconcile: a browser pane OWNED by a project window must never ALSO live at
  // the app level (group:default). The force-open fallback racing a project's
  // own open-near-pane (CDP target registering >4s after the project mounted
  // the pane) — or a stale persisted layout from before the force-open guard —
  // can leave the SAME `browser:<ctx>` id in both surfaces. A single native
  // WebContentsView then mounts in one DOM slot, so the user sees the page in
  // the project cell and an EMPTY browser tab "outside" the project (or
  // vice-versa). Purge the app-level copy — the project that spawned it owns it.
  // PURGE_ORPHAN_PANE (not CLOSE_PANE) leaves no closedStack tombstone, so it
  // won't ping-pong; idempotent because we only dispatch when the id is actually
  // present at app level.
  useEffect(() => {
    // Only a project whose window is actually mounted (its tab is open at app
    // level) owns its browser panes. A STALE entry from a closed project must
    // NOT purge a legitimately-mounted app-level browser pane that shares the id
    // (e.g. the force-open standalone fallback above) — that would re-introduce
    // the "nothing visible" bug from the other direction.
    const ownedByProject = new Set<string>();
    for (const [path, ids] of Object.entries(projectOpenPanes)) {
      if (!openPanelsRef.current.includes(createPaneId('project', path))) continue;
      for (const id of ids) if (id.startsWith('browser:')) ownedByProject.add(id);
    }
    if (ownedByProject.size === 0) return;
    const state = usePaneStore.getState();
    for (const id of ownedByProject) {
      const atAppLevel = Object.values(state.groups).some(g => g.paneIds.includes(id));
      if (atAppLevel) state.dispatch({ type: 'PURGE_ORPHAN_PANE', payload: { id } });
    }
  }, [projectOpenPanes, openPanelsRef]);

  // A browser opened by a session (chat/terminal via the WS/DOM handlers in
  // usePaneOrdering) should split out into its own cell BESIDE the chat, just
  // like the manual open above — not sit hidden as a tab. usePaneOrdering
  // dispatches `browser:request-solo` once the pane is added; we route it into
  // the same `pendingSoloPanelId` signal. PanelGrid's auto-solo effect picks
  // the orientation by available space and is idempotent (an already-solo'd
  // pane is left alone, so re-opening the same browser just navigates it).
  useEffect(() => {
    const onRequestSolo = (e: Event) => {
      const id = (e as CustomEvent<{ paneId?: string }>).detail?.paneId;
      if (id) setPendingSoloPanelId(id);
    };
    window.addEventListener('browser:request-solo', onRequestSolo as EventListener);
    return () => window.removeEventListener('browser:request-solo', onRequestSolo as EventListener);
  }, []);

  // ---- Panel layout mode ----
  const [nextPanelMode, setNextPanelMode] = useState<'side' | 'below'>('side');
  const [previewPanelId, setPreviewPanelId] = useState<string | null>(null);

  // ---- handleOpenAsPage ----
  const handleOpenAsPage = useCallback((type: 'activity' | 'agents' | 'dashboard' | 'cron') => {
    const id = utilityPanelId(type);
    // Register in the pane store BEFORE pushing into openPanels —
    // otherwise Effect A reconciles openPanels back to the store-known
    // ids and silently drops the new utility id (same trap that
    // broke cmd+K project open).
    ensurePaneRegistered(
      { id, type: type as PaneType, title: type },
      { groupId: 'group:default' },
    );
    if (isMobile) {
      setOpenPanels([id]);
      setSidebarCollapsed(true);
    } else {
      setOpenPanels(prev => prev.includes(id) ? prev : [...prev, id]);
    }
    setFocusedPanelId(id);
  }, [isMobile, setSidebarCollapsed]);

  // ---- 11-16. Per-cluster WS subscriptions (CRITIQUE C6) ----

  // WS Cluster 1: topic sync
  useEffect(() => {
    return onWSMessage((msg) => {
      if (msg.type === 'topic:archived' || msg.type === 'topic:updated' || msg.type === 'topic:created') {
        if (msg.topic) applyTopicFromWS(msg.topic);
      }
    });
  }, [onWSMessage, applyTopicFromWS]);

  // WS Cluster 2: message sync (notifications, media, clear, agents-spawned)
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    return onWSMessage((msg) => {
      // message:new cross-window sync — uses stable messageId for dedupe.
      // Falls back to last-of-role/content match for legacy emissions that
      // pre-date the messageId field (still in flight from older servers).
      if (msg.type === 'message:new') {
        if (isOwnStream(msg.sessionKey)) return;
        const fullContent = msg.content ?? msg.preview ?? '';
        if (!fullContent) return;
        const id = msg.messageId;
        const existingMessages = getSessionMessages(msg.sessionKey);
        if (id && existingMessages.some(m => m.id === id)) return;
        if (!id) {
          // Legacy fallback: dedupe by last-of-role content match.
          const lastMsgOfRole = [...existingMessages].reverse().find(x => x.role === msg.role);
          if (lastMsgOfRole && lastMsgOfRole.content === fullContent) return;
        }
        addMessageFromWS(msg.sessionKey, {
          id,
          role: msg.role,
          content: fullContent,
          timestamp: new Date().toISOString(),
        });
      }
      // Notifications for messages in non-focused topics
      if (
        msg.type === 'message:new' &&
        msg.role === 'assistant' &&
        msg.topicId !== focusedPanelIdRef.current &&
        document.visibilityState === 'hidden'
      ) {
        {
          const topic = topicsRef.current[msg.topicId];
          if (topic) {
            // Shell bridge: web Notification on Electron/web, native `notify`
            // command on Tauri (WKWebView's web Notification API is unreliable).
            notifyNative(topic.name, msg.preview || 'New message', { tag: `topic-${msg.topicId}` });
          }
        }
      }
      // message:media
      if (msg.type === 'message:media') {
        appendMediaToLastAssistant(msg.sessionKey, msg.media);
      }
      // clear
      if (msg.type === 'clear') {
        clearSession(msg.sessionKey);
      }
      // agents:spawned
      if (msg.type === 'agents:spawned') {
        const parentTopic = topicsRef.current[msg.topicId];
        if (parentTopic) {
          addMessageFromWS(parentTopic.sessionKey, {
            role: 'assistant',
            content: `{{AGENT_SPAWN:${msg.sessionKey}|${msg.label || 'Claude Code'}}}`,
            timestamp: new Date().toISOString(),
          });
        }
      }
    });
  }, [onWSMessage, isOwnStream, getSessionMessages, addMessageFromWS, appendMediaToLastAssistant, clearSession, focusedPanelIdRef, topicsRef]);

  // WS Cluster 3: topic switch + topic switch complete (CRITIQUE C13)
  // ownTopicSwitchesRef writer + reader co-located here.
  const ownTopicSwitchesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    return onWSMessage((msg) => {
      if (msg.type === 'topic:switch') {
        const fromSK = msg.fromSessionKey;
        if (!fromSK || isOwnStream(fromSK)) {
          if (fromSK) ownTopicSwitchesRef.current.add(fromSK);
          if (!openPanelsRef.current.includes(msg.toTopicId)) {
            setOpenPanels(prev => [...prev, msg.toTopicId]);
          }
          setFocusedPanelId(msg.toTopicId);
        }
      }
      if (msg.type === 'topic:switch:complete') {
        if (!ownTopicSwitchesRef.current.has(msg.fromSessionKey)) return;
        ownTopicSwitchesRef.current.delete(msg.fromSessionKey);
        clearSession(msg.fromSessionKey);
        loadHistory(msg.fromSessionKey);
        if (msg.userContent) {
          addMessageFromWS(msg.toSessionKey, { role: 'user', content: msg.userContent, timestamp: new Date().toISOString() });
        }
        if (msg.assistantContent) {
          addMessageFromWS(msg.toSessionKey, { role: 'assistant', content: msg.assistantContent, timestamp: new Date().toISOString() });
        }
        setOpenPanels(prev => prev.filter(id => id !== msg.fromTopicId));
        setFocusedPanelId(msg.toTopicId);
      }
    });
  }, [onWSMessage, isOwnStream, clearSession, loadHistory, addMessageFromWS, openPanelsRef]);

  // WS Cluster 4: open-project broadcast
  useEffect(() => {
    return onWSMessage((msg) => {
      if (msg.type === 'open-project') {
        const projectPaneId = createPaneId('project', msg.projectPath);
        setOpenPanels(prev => prev.includes(projectPaneId) ? prev : [...prev, projectPaneId]);
        setFocusedPanelId(projectPaneId);
      }
      // KANBAN-DELTA-01 (Phase D, jump-to-tab) — when a task is bound to a
      // teammate Topic via the board, the server emits this so the layout
      // brings that pane into focus. Use openPanel so registry + groups are
      // populated correctly (a bare setOpenPanels skips ensurePaneRegistered
      // and the pane renders as a ghost).
      //
      // Project-scoped topics must be opened through their PROJECT pane
      // (with pendingProjectFocus), not as a standalone chat pane —
      // otherwise they appear as ghost tabs that don't render. The
      // Master strip surfaces project topics, so this path runs often.
      if (msg.type === 'pane:focus-suggest') {
        const topic = topicsRef.current[msg.topicId];
        // Prefer the projectPath carried on the message (a cloud session that
        // just bound itself to a project) over the topic's synced field, so we
        // don't depend on a preceding topic:updated having landed first.
        const projectPath = msg.projectPath ?? topic?.projectPath;
        if (projectPath) {
          const projectPaneId = createPaneId('project', projectPath);
          ensurePaneRegistered({ id: projectPaneId, type: 'project', projectPath });
          if (!openPanelsRef.current.includes(projectPaneId)) {
            setOpenPanels((prev) => prev.includes(projectPaneId) ? prev : [...prev, projectPaneId]);
          }
          setFocusedPanelId(projectPaneId);
          setPendingProjectFocus({ projectPath, topicId: msg.topicId });
        } else if (!openPanelsRef.current.includes(msg.topicId)) {
          openPanelRef.current(msg.topicId, 'permanent');
        } else {
          setFocusedPanelId(msg.topicId);
        }
      }
    });
  }, [onWSMessage, openPanelsRef, topicsRef]);

  // WS Cluster 5: cross-window drag
  useEffect(() => {
    return onWSMessage((msg) => {
      if (msg.type === 'drag:start' && msg.sourceWindowId !== windowId) {
        setExternalDragTopicId(msg.topicId ?? null);
        // `sourceWindowId` is now optional on the wire (some emit sites only
        // set `windowId`); coalesce so the state setter, which is
        // `string | null`, never sees `undefined`.
        setExternalDragSourceWindow(msg.sourceWindowId ?? null);
      }
      if (msg.type === 'drag:end' && msg.sourceWindowId !== windowId) {
        setExternalDragTopicId(null);
        setExternalDragSourceWindow(null);
      }
      if (msg.type === 'drag:accepted' && msg.sourceWindowId === windowId) {
        if (msg.topicId) {
          setOpenPanels(prev => prev.filter(id => id !== msg.topicId));
          if (focusedPanelIdRef.current === msg.topicId) {
            setFocusedPanelId(null);
          }
        }
      }
    });
  }, [onWSMessage, windowId, focusedPanelIdRef]);

  // ---- 17. Drain queue + reload histories on WS reconnect ----
  // `prevWsStatus !== 'connected' && current === 'connected'` was ALSO true
  // for the very first 'connecting' → 'connected' transition on page load,
  // which made this effect pile a second loadHistory on top of ChatPane's
  // mount-effect load — the user saw the message list flash to a skeleton
  // and back as the second fetch's loading=true clobbered the first's
  // loading=false. Track whether we've ever seen 'connected' so we only
  // trigger on a real disconnect→reconnect cycle. ChatPane's mount effect
  // and useTopics' mount effect already handle the cold-start fetch.
  const prevWsStatus = useRef(wsStatus);
  const everConnected = useRef(false);
  useEffect(() => {
    const transitionedToConnected =
      prevWsStatus.current !== 'connected' && wsStatus === 'connected';
    if (transitionedToConnected && everConnected.current) {
      drainQueue();
      loadTopics();
      for (const panelId of openPanels) {
        const topic = topics[panelId];
        if (topic) {
          loadHistory(topic.sessionKey);
        }
      }
    }
    if (wsStatus === 'connected') everConnected.current = true;
    prevWsStatus.current = wsStatus;
  }, [wsStatus, drainQueue, openPanels, topics, loadHistory, loadTopics]);

  // ---- Auto-expand projects on openPanels change ----
  const [expandedProjects, setExpandedProjects] = useState<string[]>(() => {
    const panels = loadSavedPanels();
    return panels
      .filter(id => id.startsWith('project:'))
      .map(id => `project:${decodeURIComponent(id.slice('project:'.length))}`);
  });
  useEffect(() => {
    const sidebarProjectIds = openPanels
      .filter(id => id.startsWith('project:'))
      .map(id => `project:${decodeURIComponent(id.slice('project:'.length))}`);
    if (sidebarProjectIds.length > 0) {
      setExpandedProjects(prev => {
        const set = new Set(prev);
        let changed = false;
        for (const sid of sidebarProjectIds) {
          if (!set.has(sid)) { set.add(sid); changed = true; }
        }
        return changed ? Array.from(set) : prev;
      });
    }
  }, [openPanels]);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // ---- Handlers ----

  // openPanel
  const openPanel = useCallback((topicId: string, mode: 'preview' | 'permanent' | 'below', autoFocus = true) => {
    if (openPanels.includes(topicId)) {
      if (autoFocus) setFocusedPanelId(topicId);
      if (mode === 'permanent' && previewPanelId === topicId) {
        setPreviewPanelId(null);
      }
      return;
    }
    // 2-state model: opening a topic as a tab makes it "open", and open ⟺
    // non-archived — so opening an archived (= closed) topic restores it.
    // Optimistic archived:false lands this render, so the validPanels effect
    // (which evicts archived ids) keeps the freshly-opened tab.
    if (topics[topicId]?.archived) void archiveTopic(topicId, false);
    // App-level open: always land in the standalone group, never inside a
    // focused project's inner group (otherwise the new tab would appear as a
    // child of whatever project happens to have focus).
    ensurePaneRegistered(
      { id: topicId, type: 'chat', topicId, title: topics[topicId]?.name },
      { groupId: 'group:default' },
    );
    let newPanels: string[];
    if (isMobile) {
      newPanels = [topicId];
    } else if (mode === 'preview' && previewPanelId) {
      newPanels = openPanels.filter(id => id !== previewPanelId).concat(topicId);
    } else {
      newPanels = [...openPanels, topicId];
    }
    setOpenPanels(newPanels);
    if (autoFocus) setFocusedPanelId(topicId);
    setPreviewPanelId(mode === 'preview' ? topicId : null);
    setNextPanelMode(mode === 'below' ? 'below' : 'side');
  }, [openPanels, previewPanelId, isMobile, topics, archiveTopic]);

  // Keep the openPanelRef (declared up top, before the WS effects) pointed at
  // the latest openPanel so the stable [onWSMessage] handlers invoke the
  // current closure without referencing openPanel before its declaration.
  useEffect(() => { openPanelRef.current = openPanel; }, [openPanel]);

  // ---- 19. Electron navigate-to-topic + report focused ----
  // Register the IPC listener exactly ONCE. The preload's onNavigateToTopic is
  // purely additive (ipcRenderer.on), so an effect keyed on the frequently-
  // changing openPanel identity stacked a fresh native listener on every layout
  // change → MaxListenersExceeded + N-fire + an unbounded leak with no remover.
  // Read openPanel through openPanelRef (kept current above) and tear the
  // listener down on unmount.
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { onNavigateToTopic?: (cb: (id: string) => void) => void; removeNavigateToTopicListener?: () => void } }).electronAPI;
    if (!api?.onNavigateToTopic) return;
    api.onNavigateToTopic((topicId: string) => {
      if (topicId) openPanelRef.current(topicId, 'permanent');
    });
    return () => { api.removeNavigateToTopicListener?.(); };
  }, []);
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { reportFocusedTopic?: (id: string | null) => void } }).electronAPI;
    if (!api?.reportFocusedTopic) return;
    api.reportFocusedTopic(focusedPanelId || null);
  }, [focusedPanelId]);

  // ---- 2-state model: project-window chat close/reopen events ----
  // useProjectLayout can't reach archiveTopic (TopicsContext omits actions),
  // so it emits window events; translate them into the same archive/unarchive
  // the standalone path does inline. Close → archive (lead exempt, like
  // handleClosePanel); reopen/undo → unarchive.
  useEffect(() => {
    const onArchive = (e: Event) => {
      const id = (e as CustomEvent<{ topicId?: string }>).detail?.topicId;
      const t = id ? topicsRef.current[id] : undefined;
      if (id && t) void archiveTopic(id, true);
    };
    const onUnarchive = (e: Event) => {
      const id = (e as CustomEvent<{ topicId?: string }>).detail?.topicId;
      if (id) void archiveTopic(id, false);
    };
    window.addEventListener('topic-archive-on-close', onArchive);
    window.addEventListener('topic-unarchive-on-open', onUnarchive);
    return () => {
      window.removeEventListener('topic-archive-on-close', onArchive);
      window.removeEventListener('topic-unarchive-on-open', onUnarchive);
    };
  }, [archiveTopic, topicsRef]);

  const handleTopicClick = useCallback((topicId: string, e?: React.MouseEvent) => {
    const topic = topics[topicId];
    if (topic?.projectPath) {
      // 2-state model: opening an (archived = closed) project chat restores it.
      if (topic.archived) void archiveTopic(topicId, false);
      const projectPaneId = createPaneId('project', topic.projectPath);
      ensurePaneRegistered({ id: projectPaneId, type: 'project', projectPath: topic.projectPath });
      if (isMobile) {
        setOpenPanels([projectPaneId]);
        setSidebarCollapsed(true);
      } else if (!openPanels.includes(projectPaneId)) {
        setOpenPanels(prev => [...prev, projectPaneId]);
      }
      setFocusedPanelId(projectPaneId);
      setPendingProjectFocus({ projectPath: topic.projectPath, topicId });
      return;
    }
    ensurePaneRegistered(
      { id: topicId, type: 'chat', topicId, title: topic?.name },
      { groupId: 'group:default' },
    );
    if (e && (e.metaKey || e.ctrlKey)) {
      openPanel(topicId, 'below');
    } else {
      openPanel(topicId, 'preview');
    }
    if (isMobile) setSidebarCollapsed(true);
  }, [openPanel, isMobile, topics, openPanels, setSidebarCollapsed, archiveTopic]);

  const handleTopicDoubleClick = useCallback((topicId: string, _e?: React.MouseEvent) => {
    openPanel(topicId, 'permanent');
  }, [openPanel]);

  // handleClosePanel (stable identity via ref-backed impl)
  const handleClosePanelRef = useRef<(topicId: string) => void>(() => {});
  // Intentional ref-backed stable-callback pattern: handleClosePanel (below, deps [])
  // stays stable while .current always holds the latest closure; only invoked from
  // event handlers / undo, never read during render.
  handleClosePanelRef.current = (topicId: string) => {
    const closingTopic = topicsRef.current[topicId];
    // 2-state model: a USER-closed chat tab archives the topic (closed ⟺
    // archived). Guard to REAL chat topics only — never drafts, never the
    // prefixed terminal/browser/project pane ids (topicsRef holds only chats).
    // This sits in the single user-close funnel (X / right-click Close-now /
    // Cmd+W / deferred-commit all reach here); incidental closes go through the
    // reducer / setOpenPanels and never call this, so they won't archive.
    const archivesOnClose = !!closingTopic && !isDraftPaneId(topicId);
    let panelIndex = 0;
    {
      const s = usePaneStore.getState();
      const loc = findPaneLocation(s, topicId);
      if (loc && s.panes[topicId]) {
        s.dispatch({
          type: 'CLOSE_PANE',
          payload: { id: topicId, groupId: loc.groupId, groupIndex: loc.groupIndex },
        });
      }
    }
    setOpenPanels(prev => {
      panelIndex = prev.indexOf(topicId);
      const next = prev.filter(id => id !== topicId);
      if (focusedPanelIdRef.current === topicId) {
        // Same-index (clamped) — the tab that slides into the closed tab's
        // slot inherits focus, matching the project groups' rule and the
        // pre-shift in App.handleClosePanelDeferred. `next[next.length - 1]`
        // could snap focus to an unrelated split cell appended last.
        setFocusedPanelId(next.length > 0 ? next[Math.min(panelIndex, next.length - 1)] : null);
      }
      return next;
    });
    if (isDraftPaneId(topicId)) {
      setDraftMeta(prev => {
        const next = { ...prev };
        delete next[topicId];
        return next;
      });
    }
    pushUndo({
      description: `Close panel`,
      undo: () => {
        // Unarchive FIRST (optimistic archived:false this render) so the
        // re-added pane isn't immediately evicted by the validPanels effect.
        if (archivesOnClose) void archiveTopic(topicId, false);
        setOpenPanels(prev => {
          const next = [...prev];
          const idx = Math.min(panelIndex, next.length);
          next.splice(idx, 0, topicId);
          return next;
        });
        setFocusedPanelId(topicId);
      },
      redo: () => {
        handleClosePanelRef.current(topicId);
      },
    });
    if (archivesOnClose) void archiveTopic(topicId, true);
  };
  const handleClosePanel = useCallback(
    (topicId: string) => handleClosePanelRef.current(topicId),
    [],
  );

  const handleProjectClick = useCallback((projectPath: string) => {
    const paneId = createPaneId('project', projectPath);
    ensurePaneRegistered({ id: paneId, type: 'project', projectPath });
    if (isMobile) {
      setOpenPanels([paneId]);
      setSidebarCollapsed(true);
    } else {
      setOpenPanels(prev => prev.includes(paneId) ? prev : [...prev, paneId]);
    }
    setFocusedPanelId(paneId);
    // Track recently-opened projects so the cmd+K palette can surface
    // projects the user has touched even when no topics live there yet.
    try {
      const KEY = 'recent-projects';
      const raw = localStorage.getItem(KEY);
      const list: string[] = raw ? JSON.parse(raw) : [];
      const next = [projectPath, ...list.filter(p => p !== projectPath)].slice(0, 20);
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch { /* localStorage may be unavailable */ }
  }, [isMobile, setSidebarCollapsed]);

  const handleCloseProject = useCallback((projectPath: string) => {
    const paneId = createPaneId('project', projectPath);
    setOpenPanels(prev => {
      const next = prev.filter(id => id !== paneId);
      if (focusedPanelIdRef.current === paneId) {
        setFocusedPanelId(next.length > 0 ? next[next.length - 1] : null);
      }
      return next;
    });
  }, [focusedPanelIdRef]);

  const handleFocusPanel = useCallback((topicId: string) => {
    // Direct terminal pane ids (e.g. `terminal:<sessionId>`) — produced by
    // the Master sessions endpoint when surfacing Claude Code terminals.
    // These aren't topics, so handleTerminalClick handles them: if the cwd
    // matches a known project, the click lands inside that project; else a
    // standalone terminal pane is opened.
    if (topicId.startsWith('terminal:')) {
      const sessionId = topicId.slice('terminal:'.length);
      const session = terminalSessionsRef.current.find(s => s.id === sessionId);
      if (session) {
        // Inline routing — duplicates the body of handleTerminalClick but
        // avoids reaching into it here (avoids a deps cycle).
        if (session.cwd) {
          // Same broad-path guard as handleTerminalClick: a cwd that is an
          // ANCESTOR of a known project (e.g. the home dir, parent of all
          // your projects) is too broad to be a project — its window would
          // adopt every terminal/chat underneath it. Open such a session as
          // a standalone terminal instead of a catch-all home project tab.
          const knownProjectPaths = new Set<string>();
          for (const t of Object.values(topicsRef.current)) {
            if (t.projectPath) knownProjectPaths.add(t.projectPath);
          }
          for (const p of workspaceProjectsRef.current) knownProjectPaths.add(p);
          // Open project panes count as known projects too (see handleTerminalClick).
          for (const id of openPanelsRef.current) {
            const pp = getProjectPathFromPaneId(id);
            if (pp) knownProjectPaths.add(pp);
          }
          const cwd = session.cwd;
          const isBroad = [...knownProjectPaths].some(p => p !== cwd && p.startsWith(cwd + '/'));
          if (knownProjectPaths.has(cwd) && !isBroad) {
            const projectPaneId = createPaneId('project', session.cwd);
            ensurePaneRegistered({ id: projectPaneId, type: 'project', projectPath: session.cwd });
            setOpenPanels((prev) => prev.includes(projectPaneId) ? prev : [...prev, projectPaneId]);
            setFocusedPanelId(projectPaneId);
            usePaneStore.getState().dispatch({ type: 'FOCUS_PANE', payload: { id: projectPaneId } });
            setPendingProjectPane({ projectPath: session.cwd, type: 'terminal' as PaneType, terminalSessionId: sessionId });
            return;
          }
        }
      }
      // Fall through: open as a standalone terminal pane.
      ensurePaneRegistered(
        { id: topicId, type: 'terminal', terminalSessionId: sessionId },
        { groupId: 'group:default' },
      );
      setOpenPanels((prev) => prev.includes(topicId) ? prev : [...prev, topicId]);
      setFocusedPanelId(topicId);
      usePaneStore.getState().dispatch({ type: 'FOCUS_PANE', payload: { id: topicId } });
      return;
    }
    // Project-scoped topics must be opened through their PROJECT pane,
    // mirroring handleTopicClick — otherwise they appear as ghost tabs.
    const topic = topicsRef.current[topicId];
    if (topic?.projectPath) {
      const projectPaneId = createPaneId('project', topic.projectPath);
      ensurePaneRegistered({ id: projectPaneId, type: 'project', projectPath: topic.projectPath });
      setOpenPanels((prev) => prev.includes(projectPaneId) ? prev : [...prev, projectPaneId]);
      setFocusedPanelId(projectPaneId);
      // Also dispatch directly to the store so Effect A's store→React
      // bridge can't snap focus back to a previously-focused pane on
      // the next subscribe-tick.
      usePaneStore.getState().dispatch({ type: 'FOCUS_PANE', payload: { id: projectPaneId } });
      setPendingProjectFocus({ projectPath: topic.projectPath, topicId });
      return;
    }
    if (!openPanelsRef.current.includes(topicId)) {
      ensurePaneRegistered(
        { id: topicId, type: 'chat', topicId, title: topic?.name },
        { groupId: 'group:default' },
      );
      openPanel(topicId, 'permanent');
    }
    setFocusedPanelId(topicId);
    usePaneStore.getState().dispatch({ type: 'FOCUS_PANE', payload: { id: topicId } });
  }, [openPanel, openPanelsRef, terminalSessionsRef, topicsRef, workspaceProjectsRef]);

  const handleReorderPanels = useCallback((panels: string[]) => {
    setOpenPanels(panels);
  }, []);

  const handleOpenPanelAt = useCallback((topicId: string, index: number) => {
    setOpenPanels(prev => {
      const without = prev.filter(id => id !== topicId);
      const insertAt = Math.min(index, without.length);
      const next = [...without];
      next.splice(insertAt, 0, topicId);
      return next;
    });
    setFocusedPanelId(topicId);
  }, []);

  // FLAG-V2: useCallback wrap (prerequisite for stable identity downstream).
  const handleCreateTopic = useCallback(async (data: CreateTopicRequest): Promise<Topic | null> => {
    const topic = await createTopic(data);
    if (topic) {
      if (data.projectPath) {
        const projectPaneId = createPaneId('project', data.projectPath);
        ensurePaneRegistered({ id: projectPaneId, type: 'project', projectPath: data.projectPath });
        setOpenPanels(prev => prev.includes(projectPaneId) ? prev : [...prev, projectPaneId]);
        setFocusedPanelId(projectPaneId);
        setPendingProjectFocus({ projectPath: data.projectPath, topicId: topic.id });
      } else {
        openPanel(topic.id, 'permanent', false);
      }
    }
    return topic;
  }, [createTopic, openPanel]);

  // FLAG-V1: MUST be useCallback'd — keyboard hook depends on stable identity.
  // App-level quick-create returns the new DRAFT pane id (string) so the
  // caller — e.g. a split cell's "+ New Chat" — can re-target the pane into
  // its own cell; project-level returns the created Topic.
  const handleQuickCreateTopic = useCallback(async (projectPath?: string, targetGroupId?: string): Promise<Topic | string | null> => {
    if (projectPath) {
      const topic = await createTopic({
        name: 'New Chat',
        icon: DEFAULT_TOPIC_ICON,
        color: '#0066ff',
        projectPath,
      });
      if (topic) {
        const projectPaneId = createPaneId('project', projectPath);
        ensurePaneRegistered({ id: projectPaneId, type: 'project', projectPath });
        setOpenPanels(prev => prev.includes(projectPaneId) ? prev : [...prev, projectPaneId]);
        setFocusedPanelId(projectPaneId);
        // targetGroupId, when present, routes the new chat into the exact group
        // whose "+ new chat" the user clicked (consumed by useProjectLayout's
        // pending-focus effect → reopenChatPane). Empty string = no target.
        setPendingProjectFocus({ projectPath, topicId: topic.id, targetGroupId: targetGroupId || undefined });
      }
      return topic;
    }
    const draftId = createDraftPaneId();
    setDraftMeta(prev => ({ ...prev, [draftId]: { createdAt: new Date().toISOString() } }));
    openPanel(draftId, 'permanent', true);
    return draftId;
  }, [createTopic, openPanel]);

  const promoteDraft = useCallback(async (draftId: string, firstMessage: string, options?: { planMode?: boolean }) => {
    const meta = draftMeta[draftId] || {};
    const topic = await createTopic({
      name: 'New Chat',
      icon: DEFAULT_TOPIC_ICON,
      color: '#0066ff',
      projectPath: meta.projectPath,
    });
    if (!topic) return;
    // Atomically remap the draft pane to the new topic id in the pane store
    // (covers groups + focusedPaneId + closedStack in one shot). REORDER_PANES
    // alone would silently drop the new id because the pane entity didn't
    // exist yet, leaving the store stuck on the draft id while React moved on.
    const s = usePaneStore.getState();
    if (s.panes[draftId]) {
      s.dispatch({
        type: 'PANE_ID_REMAP',
        payload: {
          from: draftId,
          to: topic.id,
          updates: { topicId: topic.id, title: topic.name },
        },
      });
      // PANE_ID_REMAP bails silently on collision (a pane with topic.id
      // already exists). Proceeding would delete the draft meta + content
      // below while the store still holds the draft pane — Effect B's
      // REORDER re-append then resurrects it as a ghost tab with no backing
      // content. Keep the draft (and the user's text) intact instead.
      if (usePaneStore.getState().panes[draftId]) {
        console.warn('promoteDraft: id collision, keeping draft', draftId, '→', topic.id);
        return;
      }
    }
    setOpenPanels(prev => prev.map(id => id === draftId ? topic.id : id));
    // Split-layout remap: PanelGrid keys its solo split cells (and their grid
    // slots) by pane id. Announce the promotion so a draft living in a split
    // cell is renamed IN PLACE instead of being pruned on the next render —
    // without this, the first message visibly teleported the tab back to the
    // main pool and collapsed a single-tab draft cell. Dispatched in the same
    // task as the setOpenPanels remap above, so React batches both and the
    // grid never sees an intermediate state.
    window.dispatchEvent(new CustomEvent('topics:pane-id-remap', {
      detail: { from: draftId, to: topic.id },
    }));
    if (focusedPanelIdRef.current === draftId) {
      setFocusedPanelId(topic.id);
    }
    setDraftMeta(prev => {
      const next = { ...prev };
      delete next[draftId];
      try { localStorage.removeItem(`draft-content-${draftId}`); } catch {}
      return next;
    });
    await sendMessage(topic.sessionKey, firstMessage, options);
  }, [draftMeta, createTopic, sendMessage, focusedPanelIdRef]);

  const handleQuickCreateTerminal = useCallback(async (termType: TerminalAgentType = 'shell', skipPermissions = true): Promise<string | null> => {
    try {
      const name = TERMINAL_AGENT_LABELS[termType];
      const body = buildTerminalSessionBody(termType, { skipPermissions });
      const res = await fetch('/api/terminal/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const paneId = createPaneId('terminal', data.id);
      terminalOps.markRecentlyCreated(data.id);
      terminalOps.addOptimisticSession({
        id: data.id, name: data.name || name, createdAt: data.createdAt,
        cwd: data.cwd, command: data.command, clients: 0,
        topicId: data.topicId, type: data.type,
      });
      {
        const s = usePaneStore.getState();
        const focusLoc = s.focusedPaneId
          ? findPaneLocation(s, s.focusedPaneId)
          : null;
        const targetGroupId = focusLoc?.groupId ?? 'group:default';
        s.dispatch({
          type: 'OPEN_PANE',
          payload: {
            id: paneId,
            type: 'terminal',
            title: data.name || name,
            terminalType: termType,
            preview: false,
            groupId: targetGroupId,
          },
        });
      }
      setOpenPanels(prev => prev.includes(paneId) ? prev : [...prev, paneId]);
      setFocusedPanelId(paneId);
      // Don't mark the new terminal as a top-level solo cell — that would
      // render it as its own column outside any tab bar (the "split" the user
      // sees when clicking + → Claude Code on the standalone/non-project tab
      // bar). Let it land as a regular tab in the standalone group instead,
      // mirroring the project tab bar behaviour. The user can manually split
      // it into its own cell via the existing split affordances.
      if (isMobile) setSidebarCollapsed(true);
      // Return the new pane id so the caller can re-target it — a "+" clicked
      // on a SPLIT cell's tab bar merges the pane into that cell (see
      // usePaneLifecycle.handleAddPane), otherwise it stays in the pool.
      return paneId;
    } catch { return null; }
  }, [isMobile, terminalOps, setSidebarCollapsed]);

  const handleCloseTerminal = useCallback(async (sessionId: string) => {
    fetch(`/api/terminal/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    terminalOps.removeSession(sessionId);
    const paneId = createPaneId('terminal', sessionId);
    setOpenPanels(prev => prev.filter(p => p !== paneId));
  }, [terminalOps]);

  const handleOpenAsProject = useCallback((path: string) => {
    const projectPaneId = createPaneId('project', path);
    // Register the pane entity in the store BEFORE pushing it into openPanels.
    // Without this, Effect B's REORDER_PANES dispatch is silently filtered
    // (the reducer drops ids whose pane entity doesn't exist), then Effect A
    // resyncs openPanels back to storeOrder — dropping our new id and leaving
    // focus stranded on whatever was active before. Same fix as
    // handleProjectClick / handleAddProjectPane.
    ensurePaneRegistered({ id: projectPaneId, type: 'project', projectPath: path });
    if (isMobile) {
      setOpenPanels([projectPaneId]);
      setSidebarCollapsed(true);
    } else {
      setOpenPanels(prev => prev.includes(projectPaneId) ? prev : [...prev, projectPaneId]);
    }
    setFocusedPanelId(projectPaneId);
  }, [isMobile, setSidebarCollapsed]);

  const handleTerminalClick = useCallback((sessionId: string, _sessionName: string) => {
    const session = terminalSessions.find(s => s.id === sessionId);
    if (session?.cwd) {
      const knownProjectPaths = new Set<string>();
      for (const t of Object.values(topics)) {
        if (t.projectPath) knownProjectPaths.add(t.projectPath);
      }
      for (const p of workspaceProjects) knownProjectPaths.add(p);
      // Also treat any CURRENTLY-OPEN project pane as a known project. A
      // project window can be open while having no chat topics and not being
      // in `workspaceProjects` (e.g. opened purely to host Claude Code
      // terminals). Without this, clicking such a project's terminal sub-tab
      // in the sidebar fell through to the standalone branch below and never
      // selected the tab inside the project — the sidebar groups the terminal
      // under the project (by cwd) but this routing didn't, so the two
      // disagreed. Including open project panes keeps them consistent.
      for (const id of openPanels) {
        const pp = getProjectPathFromPaneId(id);
        if (pp) knownProjectPaths.add(pp);
      }
      // A path that is an ANCESTOR of another known project (e.g. the home
      // dir, parent of all your projects) is too broad to be a project: its
      // window would adopt every terminal/chat underneath it. Treat such a
      // terminal as standalone instead of opening a catch-all project.
      const cwd = session.cwd;
      const isBroad = [...knownProjectPaths].some(p => p !== cwd && p.startsWith(cwd + '/'));
      if (knownProjectPaths.has(cwd) && !isBroad) {
        const projectPath = session.cwd;
        const projectPaneId = createPaneId('project', projectPath);
        if (isMobile) {
          setOpenPanels([projectPaneId]);
          setSidebarCollapsed(true);
        } else if (!openPanels.includes(projectPaneId)) {
          setOpenPanels(prev => [...prev, projectPaneId]);
        }
        setFocusedPanelId(projectPaneId);
        setPendingProjectPane({ projectPath, type: 'terminal' as PaneType, terminalSessionId: sessionId });
        if (isMobile) setSidebarCollapsed(true);
        return;
      }
    }
    const paneId = createPaneId('terminal', sessionId);
    if (!openPanels.includes(paneId)) {
      setOpenPanels(prev => [...prev, paneId]);
    }
    setFocusedPanelId(paneId);
    if (isMobile) setSidebarCollapsed(true);
  }, [openPanels, isMobile, terminalSessions, topics, workspaceProjects, setSidebarCollapsed]);

  const handleAddProjectPane = useCallback((projectPath: string, type: PaneType, subType?: string) => {
    const projectPaneId = createPaneId('project', projectPath);
    ensurePaneRegistered({ id: projectPaneId, type: 'project', projectPath });
    if (isMobile) {
      setOpenPanels([projectPaneId]);
      setSidebarCollapsed(true);
    } else if (!openPanels.includes(projectPaneId)) {
      setOpenPanels(prev => [...prev, projectPaneId]);
    }
    setFocusedPanelId(projectPaneId);
    setPendingProjectPane({
      projectPath,
      type,
      terminalType: type === 'terminal' ? normalizeTerminalAgent(subType) : undefined,
    });
  }, [openPanels, isMobile, setSidebarCollapsed]);


  const handleArchiveProject = useCallback(async (projectPath: string, archive: boolean) => {
    const success = await archiveProject(projectPath, archive);
    if (success && archive) {
      handleCloseProject(projectPath);
      // Prune the project's per-path persistence keys — nothing else ever
      // removes them, so archived projects' layout/tab records accumulate
      // in localStorage forever. Un-archiving starts from a clean layout,
      // which matches the 2-state model (closed ⟺ archived).
      try {
        localStorage.removeItem(projectPanesLocalKey(projectPath));
        localStorage.removeItem(projectLayoutLocalKey(projectPath));
      } catch { /* private mode — ignore */ }
    }
    return success;
  }, [archiveProject, handleCloseProject]);

  const handleTopicContextMenu = useCallback((e: React.MouseEvent, topic: Topic) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, topic });
  }, []);

  const handleExternalDrop = useCallback(() => {
    if (externalDragTopicId && externalDragSourceWindow) {
      if (!openPanels.includes(externalDragTopicId)) {
        setOpenPanels(prev => [...prev, externalDragTopicId]);
        setFocusedPanelId(externalDragTopicId);
      }
      sendWS({
        type: 'drag:drop',
        topicId: externalDragTopicId,
        windowId: windowId,
        sourceWindowId: externalDragSourceWindow,
      });
      setExternalDragTopicId(null);
      setExternalDragSourceWindow(null);
    }
  }, [externalDragTopicId, externalDragSourceWindow, openPanels, sendWS, windowId]);

  // In-flight reopen guard, keyed by closed-record id. ⇧⌘T can momentarily fire
  // from two surfaces at once (the Electron native menu accelerator + the
  // renderer keydown), and the record isn't popped off the stack until the END
  // of this async handler (after `await reopenClosedTab`), so two calls used to
  // both reopen the SAME record → a duplicate tab. Claiming the id synchronously
  // makes a concurrent call for the same record a no-op. Rapid reopen of
  // DIFFERENT records is unaffected: each completes, pops its own id, and clears.
  const reopeningRef = useRef<Set<string>>(new Set());
  const handleReopenClosedTab = useCallback(async (record: ClosedTabRecord) => {
    if (reopeningRef.current.has(record.id)) return;
    reopeningRef.current.add(record.id);
    try {
      if (record.level === 'project') {
        // Project-inner records are restored by the OWNING project window —
        // it has the panes/groups React state these ids live in, and its
        // restore flow already calls reopenClosedTab (terminal session
        // recreation) itself. Calling it here too would double-POST a new
        // terminal session. Cancelable event = claim protocol: the window
        // whose projectPath matches preventDefault()s, and only then is the
        // record consumed off the stack.
        const ev = new CustomEvent('reopen-closed-tab', { detail: record, cancelable: true });
        window.dispatchEvent(ev);
        if (ev.defaultPrevented) {
          removeClosedTab(record.id);
        } else {
          console.warn('No project window claimed reopen for', record.projectPath);
        }
        return;
      }
      const pane = await reopenClosedTab(record);
      // 2-state model: reopening a closed chat tab restores it -> unarchive.
      if (pane.type === 'chat' && pane.topicId) void archiveTopic(pane.topicId, false);
      // App-level reopen: CLOSE_PANE deleted the pane entity. We must
      // re-register it before pushing into openPanels — otherwise
      // Effect A reconciles openPanels back to the store and our id
      // disappears (the same trap that broke cmd+K project open).
      ensurePaneRegistered({
        id: pane.id,
        type: pane.type,
        title: pane.title,
        topicId: pane.topicId,
        projectPath: pane.projectPath,
      });
      // Reopen is ADDITIVE: mark the restored id so the standalone tab-ordering
      // (usePaneOrdering) doesn't treat this single add as a preview-navigation
      // and replace+close the current preview tab (the reopen "swap" bug). Set
      // before setOpenPanels so the marker is present when the topicIds effect
      // runs on the next render.
      markTabRestored(pane.id);
      setOpenPanels(prev => prev.includes(pane.id) ? prev : [...prev, pane.id]);
      setFocusedPanelId(pane.id);
      removeClosedTab(record.id);
    } catch (err) {
      console.warn('Failed to reopen closed tab:', err);
    } finally {
      reopeningRef.current.delete(record.id);
    }
  }, [removeClosedTab, archiveTopic]);

  // ---- 20. Detached auto-close ----
  useEffect(() => {
    if (isDetached && openPanels.length === 0) {
      window.close();
      setTimeout(() => {
        window.location.href = window.location.origin;
      }, 200);
    }
  }, [isDetached, openPanels.length]);

  return {
    state: {
      openPanels,
      focusedPanelId,
      previewPanelId,
      nextPanelMode,
      draftMeta,
      pendingProjectFocus,
      projectActiveTopics,
      projectOpenPanes,
      pendingProjectPane,
      panelInitialTab,
      contextMenu,
      expandedProjects,
      externalDragTopicId,
      externalDragSourceWindow,
      pendingBrowserPane,
      pendingSoloPanelId,
    },
    refs: { focusedPanelIdRef, openPanelsRef },
    derived: { focusedProjectPath },
    handlers: {
      openPanel,
      handleTopicClick,
      handleTopicDoubleClick,
      handleClosePanel,
      handleProjectClick,
      handleCloseProject,
      handleFocusPanel,
      handleReorderPanels,
      handleOpenPanelAt,
      handleOpenAsProject,
      handleAddProjectPane,
      handleArchiveProject,
      handleTopicContextMenu,
      handleQuickCreateTopic,
      handleCreateTopic,
      promoteDraft,
      handleQuickCreateTerminal,
      handleCloseTerminal,
      handleTerminalClick,
      handleOpenAsPage,
      handleExternalDrop,
      handleReopenClosedTab,
      handleProjectActiveTopicChange,
      handleProjectOpenPanesChange,
      handlePendingBrowserPaneConsumed,
      handlePendingSoloConsumed,
      openBrowserPane,
      setNextPanelMode,
      setExpandedProjects,
      setContextMenu,
      setPendingProjectFocus,
      setPendingProjectPane,
      setPanelInitialTab,
    },
  };
}
