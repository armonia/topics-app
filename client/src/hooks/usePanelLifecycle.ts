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
} from '../state/pane/adapters';
import { findPaneLocation, usePaneStore } from '../state/pane/store';
import { loadLocalFocusedPaneId } from '../state/pane/middleware';
import { utilityPanelId } from '../components/Layout/UtilityPanel';
import { DEFAULT_TOPIC_ICON } from '../lib/topicIcons';
import { globalBoardApi } from '../lib/api';
import { pushUndo } from '../contexts/UndoContext';

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

const loadSavedFocused = (): string | null => {
  try {
    // The store hydrates focusedPaneId from server-synced state, but focus
    // is device-local and stripped from the synced snapshot — so on a fresh
    // reload the store has it as `null`. Read the dedicated localStorage
    // key first so reload preserves the user's last focused tab.
    const local = loadLocalFocusedPaneId();
    if (local) return local;
    return usePaneStore.getState().focusedPaneId;
  } catch {
    return null;
  }
};

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
  pane: { id: string; type: PaneType; title?: string; topicId?: string; projectPath?: string },
  options?: { groupId?: string },
): void {
  const s = usePaneStore.getState();
  if (s.panes[pane.id]) return;
  // Caller-provided groupId wins (App-level openings must always land in the
  // standalone group regardless of which inner project pane is focused).
  // Otherwise we fall back to the focused group, then to the default.
  const focusLoc = s.focusedPaneId ? findPaneLocation(s, s.focusedPaneId) : null;
  const groupId = options?.groupId ?? focusLoc?.groupId ?? 'group:default';
  s.dispatch({
    type: 'OPEN_PANE',
    payload: { ...pane, preview: false, groupId },
  });
}

interface PendingProjectFocus { projectPath: string; topicId: string }
interface PendingProjectPane { projectPath: string; type: PaneType; terminalSessionId?: string; terminalType?: 'shell' | 'claude-code' }
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
    boardTaskCounts: Record<string, number>;
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
    handleOpenProjectBoard: (projectPath: string) => void;
    handleArchiveProject: (projectPath: string, archive: boolean) => Promise<boolean>;
    handleTopicContextMenu: (e: React.MouseEvent, topic: Topic) => void;
    handleQuickCreateTopic: (projectPath?: string) => Promise<Topic | null>;
    handleCreateTopic: (data: CreateTopicRequest) => Promise<Topic | null>;
    promoteDraft: (draftId: string, firstMessage: string, options?: { planMode?: boolean }) => Promise<void>;
    handleQuickCreateTerminal: (termType?: 'shell' | 'claude-code', skipPermissions?: boolean) => Promise<void>;
    handleCloseTerminal: (sessionId: string) => Promise<void>;
    handleTerminalClick: (sessionId: string, sessionName: string) => void;
    handleOpenAsPage: (type: 'activity' | 'agents' | 'dashboard' | 'all-boards' | 'cron') => void;
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
    topics, topicsLoading, loadTopics, createTopic, applyTopicFromWS, archiveProject,
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

  // ---- 2. focusedPanelIdRef sync (ISSUE 3) ----
  const focusedPanelIdRef = useRef(focusedPanelId);
  useEffect(() => { focusedPanelIdRef.current = focusedPanelId; }, [focusedPanelId]);

  // ---- 3. openPanelsRef + topicsRef sync (for WS / keyboard handlers) ----
  const openPanelsRef = useRef(openPanels);
  useEffect(() => { openPanelsRef.current = openPanels; }, [openPanels]);
  const topicsRef = useRef(topics);
  useEffect(() => { topicsRef.current = topics; }, [topics]);

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
      const validPanels = openPanels.filter(id => {
        if (isKnownPanePrefix(id)) return true;
        const topic = topics[id];
        if (!topic) return isUUIDLike(id);
        if (topic.archived) return false;
        if (topic.projectPath) {
          const paneId = createPaneId('project', topic.projectPath);
          if (!projectPanesToAdd.includes(paneId)) projectPanesToAdd.push(paneId);
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

  // ---- Board task counts ----
  const [boardTaskCounts, setBoardTaskCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    globalBoardApi.listTasks().then(data => {
      const counts: Record<string, number> = {};
      for (const t of data.tasks) {
        if (t.status !== 'done') counts[t.projectId] = (counts[t.projectId] || 0) + 1;
      }
      setBoardTaskCounts(counts);
    }).catch(() => {});
  }, []);

  // ---- Browser pane management ----
  const [pendingBrowserPane, setPendingBrowserPane] = useState<string | null>(null);
  const handlePendingBrowserPaneConsumed = useCallback(() => setPendingBrowserPane(null), []);
  const [pendingSoloPanelId, setPendingSoloPanelId] = useState<string | null>(null);
  const handlePendingSoloConsumed = useCallback(() => setPendingSoloPanelId(null), []);
  const openBrowserPane = useCallback((contextId: string) => {
    setPendingBrowserPane(contextId);
    setPendingSoloPanelId(`browser:${contextId}`);
    if (isMobile) {
      setSidebarCollapsed(true);
    }
  }, [isMobile, setSidebarCollapsed]);

  // ---- Panel layout mode ----
  const [nextPanelMode, setNextPanelMode] = useState<'side' | 'below'>('side');
  const [previewPanelId, setPreviewPanelId] = useState<string | null>(null);

  // ---- handleOpenAsPage ----
  const handleOpenAsPage = useCallback((type: 'activity' | 'agents' | 'dashboard' | 'all-boards' | 'cron') => {
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
      if ((msg.type === 'topic:archived' || msg.type === 'topic:updated' || msg.type === 'topic:created') && (msg as unknown as { topic?: Topic }).topic) {
        applyTopicFromWS((msg as unknown as { topic: Topic }).topic);
      }
    });
  }, [onWSMessage, applyTopicFromWS]);

  // WS Cluster 2: message sync (notifications, media, clear, agents-spawned)
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    return onWSMessage((msg) => {
      const m = msg as Record<string, unknown> & { type: string };
      // message:new cross-window sync
      if (m.type === 'message:new' && m.sessionKey && m.content) {
        const sessionKey = m.sessionKey as string;
        if (isOwnStream(sessionKey)) return;
        const role = m.role as 'user' | 'assistant';
        const content = m.content as string;
        const existingMessages = getSessionMessages(sessionKey);
        const lastMsgOfRole = [...existingMessages].reverse().find(x => x.role === role);
        if (!lastMsgOfRole || lastMsgOfRole.content !== content) {
          addMessageFromWS(sessionKey, { role, content, timestamp: new Date().toISOString() });
        }
      }
      // Notifications for messages in non-focused topics
      if (
        m.type === 'message:new' &&
        m.role === 'assistant' &&
        m.topicId !== focusedPanelIdRef.current &&
        document.visibilityState === 'hidden'
      ) {
        if ('Notification' in window && Notification.permission === 'granted') {
          const topic = topicsRef.current[m.topicId as string];
          if (topic) {
            new Notification(topic.name, {
              body: (m.preview as string) || 'New message',
              tag: `topic-${m.topicId}`,
            });
          }
        }
      }
      // message:media
      if (m.type === 'message:media' && m.sessionKey && m.media) {
        appendMediaToLastAssistant(m.sessionKey as string, m.media as string[]);
      }
      // clear
      if (m.type === 'clear' && m.sessionKey) {
        clearSession(m.sessionKey as string);
      }
      // agents:spawned
      if (m.type === 'agents:spawned' && m.topicId && m.sessionKey) {
        const parentTopic = topicsRef.current[m.topicId as string];
        if (parentTopic) {
          addMessageFromWS(parentTopic.sessionKey, {
            role: 'assistant',
            content: `{{AGENT_SPAWN:${m.sessionKey}|${(m.label as string) || 'Claude Code'}}}`,
            timestamp: new Date().toISOString(),
          });
        }
      }
    });
  }, [onWSMessage, isOwnStream, getSessionMessages, addMessageFromWS, appendMediaToLastAssistant, clearSession]);

  // WS Cluster 3: topic switch + topic switch complete (CRITIQUE C13)
  // ownTopicSwitchesRef writer + reader co-located here.
  const ownTopicSwitchesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    return onWSMessage((msg) => {
      const m = msg as Record<string, unknown> & { type: string };
      if (m.type === 'topic:switch' && m.toTopicId) {
        const fromSK = m.fromSessionKey as string;
        if (!fromSK || isOwnStream(fromSK)) {
          const toId = m.toTopicId as string;
          if (fromSK) ownTopicSwitchesRef.current.add(fromSK);
          if (!openPanelsRef.current.includes(toId)) {
            setOpenPanels(prev => [...prev, toId]);
          }
          setFocusedPanelId(toId);
        }
      }
      if (m.type === 'topic:switch:complete' && m.fromSessionKey && m.toSessionKey) {
        const fromSK = m.fromSessionKey as string;
        if (!ownTopicSwitchesRef.current.has(fromSK)) return;
        ownTopicSwitchesRef.current.delete(fromSK);
        const fromId = m.fromTopicId as string;
        const toSK = m.toSessionKey as string;
        const userContent = m.userContent as string;
        const assistantContent = m.assistantContent as string;
        clearSession(fromSK);
        loadHistory(fromSK);
        if (userContent) {
          addMessageFromWS(toSK, { role: 'user', content: userContent, timestamp: new Date().toISOString() });
        }
        if (assistantContent) {
          addMessageFromWS(toSK, { role: 'assistant', content: assistantContent, timestamp: new Date().toISOString() });
        }
        setOpenPanels(prev => prev.filter(id => id !== fromId));
        const toId = m.toTopicId as string;
        setFocusedPanelId(toId);
      }
    });
  }, [onWSMessage, isOwnStream, clearSession, loadHistory, addMessageFromWS]);

  // WS Cluster 4: open-project broadcast
  useEffect(() => {
    return onWSMessage((msg) => {
      const m = msg as Record<string, unknown> & { type: string };
      if (m.type === 'open-project' && m.projectPath) {
        const projectPaneId = createPaneId('project', m.projectPath as string);
        setOpenPanels(prev => prev.includes(projectPaneId) ? prev : [...prev, projectPaneId]);
        setFocusedPanelId(projectPaneId);
      }
    });
  }, [onWSMessage]);

  // WS Cluster 5: cross-window drag
  useEffect(() => {
    return onWSMessage((msg) => {
      const m = msg as Record<string, unknown> & { type: string };
      if (m.type === 'drag:start' && m.sourceWindowId !== windowId) {
        setExternalDragTopicId(m.topicId as string);
        setExternalDragSourceWindow(m.sourceWindowId as string);
      }
      if (m.type === 'drag:end' && m.sourceWindowId !== windowId) {
        setExternalDragTopicId(null);
        setExternalDragSourceWindow(null);
      }
      if (m.type === 'drag:accepted' && m.sourceWindowId === windowId) {
        const topicId = m.topicId as string;
        setOpenPanels(prev => prev.filter(id => id !== topicId));
        if (focusedPanelIdRef.current === topicId) {
          setFocusedPanelId(null);
        }
      }
    });
  }, [onWSMessage, windowId]);

  // WS Cluster 6: board task counts
  useEffect(() => {
    return onWSMessage((msg) => {
      if (msg.type === 'task:created' || msg.type === 'task:moved' || msg.type === 'task:updated' || msg.type === 'task:deleted') {
        globalBoardApi.listTasks().then(data => {
          const counts: Record<string, number> = {};
          for (const t of data.tasks) {
            if (t.status !== 'done') counts[t.projectId] = (counts[t.projectId] || 0) + 1;
          }
          setBoardTaskCounts(counts);
        }).catch(() => {});
      }
    });
  }, [onWSMessage]);

  // ---- 17. Drain queue + reload histories on WS reconnect ----
  const prevWsStatus = useRef(wsStatus);
  useEffect(() => {
    if (prevWsStatus.current !== 'connected' && wsStatus === 'connected') {
      drainQueue();
      // Reload topics on reconnect (moved here from App.tsx in Commit 5)
      loadTopics();
      for (const panelId of openPanels) {
        const topic = topics[panelId];
        if (topic) {
          loadHistory(topic.sessionKey);
        }
      }
    }
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
  }, [openPanels, previewPanelId, isMobile, topics]);

  // ---- 19. Electron navigate-to-topic + report focused ----
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { onNavigateToTopic?: (cb: (id: string) => void) => void } }).electronAPI;
    if (!api?.onNavigateToTopic) return;
    api.onNavigateToTopic((topicId: string) => {
      if (topicId) openPanel(topicId, 'permanent');
    });
  }, [openPanel]);
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: { reportFocusedTopic?: (id: string | null) => void } }).electronAPI;
    if (!api?.reportFocusedTopic) return;
    api.reportFocusedTopic(focusedPanelId || null);
  }, [focusedPanelId]);

  const handleTopicClick = useCallback((topicId: string, e?: React.MouseEvent) => {
    const topic = topics[topicId];
    if (topic?.projectPath) {
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
  }, [openPanel, isMobile, topics, openPanels, setSidebarCollapsed]);

  const handleTopicDoubleClick = useCallback((topicId: string, _e?: React.MouseEvent) => {
    openPanel(topicId, 'permanent');
  }, [openPanel]);

  // handleClosePanel (stable identity via ref-backed impl)
  const handleClosePanelRef = useRef<(topicId: string) => void>(() => {});
  handleClosePanelRef.current = (topicId: string) => {
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
        setFocusedPanelId(next.length > 0 ? next[next.length - 1] : null);
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
  }, []);

  const handleFocusPanel = useCallback((topicId: string) => {
    setFocusedPanelId(topicId);
  }, []);

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
  const handleQuickCreateTopic = useCallback(async (projectPath?: string): Promise<Topic | null> => {
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
        setPendingProjectFocus({ projectPath, topicId: topic.id });
      }
      return topic;
    }
    const draftId = createDraftPaneId();
    setDraftMeta(prev => ({ ...prev, [draftId]: { createdAt: new Date().toISOString() } }));
    openPanel(draftId, 'permanent', true);
    return null;
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
    }
    setOpenPanels(prev => prev.map(id => id === draftId ? topic.id : id));
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
  }, [draftMeta, createTopic, sendMessage]);

  const handleQuickCreateTerminal = useCallback(async (termType: 'shell' | 'claude-code' = 'shell', skipPermissions = true) => {
    try {
      const name = termType === 'claude-code' ? 'Claude Code' : 'Shell';
      const body: Record<string, unknown> = { type: termType, name };
      if (termType === 'claude-code') body.skipPermissions = skipPermissions;
      const res = await fetch('/api/terminal/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return;
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
      setPendingSoloPanelId(paneId);
      if (isMobile) setSidebarCollapsed(true);
    } catch {}
  }, [isMobile, terminalOps, setSidebarCollapsed]);

  const handleCloseTerminal = useCallback(async (sessionId: string) => {
    fetch(`/api/terminal/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    terminalOps.removeSession(sessionId);
    const paneId = createPaneId('terminal', sessionId);
    setOpenPanels(prev => prev.filter(p => p !== paneId));
  }, [terminalOps]);

  const handleOpenAsProject = useCallback((path: string) => {
    const projectPaneId = createPaneId('project', path);
    setOpenPanels(prev => prev.includes(projectPaneId) ? prev : [...prev, projectPaneId]);
    setFocusedPanelId(projectPaneId);
  }, []);

  const handleTerminalClick = useCallback((sessionId: string, _sessionName: string) => {
    const session = terminalSessions.find(s => s.id === sessionId);
    if (session?.cwd) {
      const knownProjectPaths = new Set<string>();
      for (const t of Object.values(topics)) {
        if (t.projectPath) knownProjectPaths.add(t.projectPath);
      }
      for (const p of workspaceProjects) knownProjectPaths.add(p);
      if (knownProjectPaths.has(session.cwd)) {
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
      terminalType: type === 'terminal' ? ((subType as 'shell' | 'claude-code') || 'shell') : undefined,
    });
  }, [openPanels, isMobile, setSidebarCollapsed]);

  const handleOpenProjectBoard = useCallback((projectPath: string) => {
    handleAddProjectPane(projectPath, 'board');
  }, [handleAddProjectPane]);

  const handleArchiveProject = useCallback(async (projectPath: string, archive: boolean) => {
    const success = await archiveProject(projectPath, archive);
    if (success && archive) {
      handleCloseProject(projectPath);
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
      } as unknown as WSMessage);
      setExternalDragTopicId(null);
      setExternalDragSourceWindow(null);
    }
  }, [externalDragTopicId, externalDragSourceWindow, openPanels, sendWS, windowId]);

  const handleReopenClosedTab = useCallback(async (record: ClosedTabRecord) => {
    try {
      const pane = await reopenClosedTab(record);
      if (record.level === 'project') {
        window.dispatchEvent(new CustomEvent('reopen-closed-tab', { detail: record }));
      } else {
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
        setOpenPanels(prev => prev.includes(pane.id) ? prev : [...prev, pane.id]);
        setFocusedPanelId(pane.id);
      }
      removeClosedTab(record.id);
    } catch (err) {
      console.warn('Failed to reopen closed tab:', err);
    }
  }, [removeClosedTab]);

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
      boardTaskCounts,
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
      handleOpenProjectBoard,
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
