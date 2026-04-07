import { useState, useCallback, useMemo, useEffect, useRef, lazy, Suspense } from 'react';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, Pane, PaneType, PanelTab, TerminalSessionInfo } from '../../types';
import { PaneTabBar } from './PaneTabBar';
import { ChatPanel } from './ChatPanel';
import { SidebarToggleButton } from '../Shared/SidebarToggleButton';
import { DND_TYPES } from '../../lib/dndTypes';
import { useMultiContextPercent } from '../../hooks/useContextInspector';
import { isUtilityPanelId, parseUtilityPanelType } from './UtilityPanel';
import { PANE_CONFIG, isProjectPaneId, isBrowserPaneId, isTerminalPaneId, isSessionViewerPaneId, getTerminalSessionFromPaneId, getProjectPathFromPaneId, getSessionKeyFromViewerPaneId, getBrowserContextFromPaneId, createPaneId, isDraftPaneId } from '../../lib/paneConfig';
import { useProjectTabStatus } from '../../hooks/useProjectTabStatus';
import { useClaudeSkipPermissions } from '../../hooks/useClaudePrefs';
import type { ProjectTabStatus } from '../../hooks/useProjectTabStatus';
import { findPreviewInList, replaceInList } from '../../lib/previewTabs';
import { loadPanelOrder, usePanelOrderPersistence } from '../../hooks/usePanelOrder';
import { ProjectWindowPane } from './ProjectWindow';
import { getProjectName, hashToColor } from './ProjectHeader';

const RemoteBrowserPanel = lazy(() => import('../Browser/RemoteBrowserPanel').then(m => ({ default: m.RemoteBrowserPanel })));
const SingleTerminalPane = lazy(() => import('../Terminal/SingleTerminalPane').then(m => ({ default: m.SingleTerminalPane })));

const TopicSettingsModal = lazy(() => import('../Modals/TopicSettingsModal').then(m => ({ default: m.TopicSettingsModal })));
const ActivityFeedPanel = lazy(() => import('../Sidebar/ActivityFeedPanel').then(m => ({ default: m.ActivityFeedPanel })));
const JournalPanel = lazy(() => import('../Journal/JournalPanel').then(m => ({ default: m.JournalPanel })));
const AgentsPane = lazy(() => import('../Agents/AgentsPane').then(m => ({ default: m.AgentsPane })));
const DashboardPane = lazy(() => import('../Dashboard/DashboardPane').then(m => ({ default: m.DashboardPane })));
const AllBoardsPane = lazy(() => import('../Board/AllBoardsPane').then(m => ({ default: m.AllBoardsPane })));
const SessionViewerPane = lazy(() => import('../Agents/SessionViewerPane').then(m => ({ default: m.SessionViewerPane })));

const isNativeApp = typeof window !== 'undefined' && !!(window as any).webkit?.messageHandlers;
const LazySpinner = <div className="flex items-center justify-center h-full"><div className="w-4 h-4 border-2 border-app-border-light border-t-primary rounded-full animate-spin" /></div>;

interface StandaloneChatGroupProps {
  topicIds: string[];
  topics: Record<string, Topic>;
  focusedPanelId: string | null;
  onFocusPanel: (topicId: string) => void;
  onClosePanel: (topicId: string) => void;
  onDragStart: (topicId: string) => (e: React.DragEvent) => void;
  // Chat props pass-through
  getSessionMessages: (sk: string) => ChatMessage[];
  isSessionLoading: (sk: string) => boolean;
  isSessionStreaming: (sk: string) => boolean;
  sendMessage: (sk: string, content: string, options?: { planMode?: boolean }) => Promise<boolean>;
  editMessage?: (sk: string, messageId: string, newContent: string) => Promise<boolean>;
  switchBranch?: (sk: string, messageId: string, branchIndex: number) => Promise<boolean>;
  loadHistory: (sk: string) => Promise<boolean>;
  chatError: string | null;
  sendWS: (msg: WSMessage) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  onToggleSidebar?: () => void;
  panelInitialTab?: Record<string, PanelTab>;
  onPanelInitialTabConsumed?: (topicId: string) => void;
  onNewChat?: () => void;
  // Grid item drag (for reordering in PanelGrid)
  onGroupDragStart?: (e: React.DragEvent) => void;
  stopSession: (sessionKey: string) => boolean;
  // Cross-panel-type: accept topic drops from project windows
  onAcceptProjectTopicDrop?: (topicId: string) => void;
  // Pending pane request for project tabs
  pendingProjectPane?: { projectPath: string; type: import('../../types').PaneType; terminalSessionId?: string; terminalType?: 'shell' | 'claude-code' } | null;
  onPendingProjectPaneConsumed?: () => void;
  // Create new chat in a project
  onNewChatInProject?: (projectPath: string) => void;
  // Pending focus for project tabs (navigate to a topic inside a project)
  pendingProjectFocus?: { projectPath: string; topicId: string } | null;
  onPendingProjectFocusConsumed?: () => void;
  // Report which topic is active inside the focused project
  onProjectActiveTopicChange?: (projectPath: string, topicId: string | null) => void;
  // Report all open pane IDs inside each project (for sidebar filtering)
  onProjectOpenPanesChange?: (projectPath: string, paneIds: string[]) => void;
  // Terminal sessions for label resolution (from server)
  terminalSessions?: TerminalSessionInfo[];
  // Create a new terminal (delegates to App)
  onCreateTerminal?: (type: 'shell' | 'claude-code', skipPermissions?: boolean) => void;
  // Report whether this group has utility panes (browser/terminal)
  onUtilityPaneChange?: (has: boolean) => void;
  // Pending browser pane request (from sidebar) — contextId or null
  pendingBrowserPane?: string | null;
  onPendingBrowserPaneConsumed?: () => void;
  // Report open browser context IDs to parent
  onOpenBrowserContextIds?: (ids: string[]) => void;
  // Draft chat support
  promoteDraft?: (draftId: string, firstMessage: string, options?: { planMode?: boolean }) => Promise<void>;
  draftMeta?: Record<string, { projectPath?: string }>;
  // Split a pane into its own grid cell (right or down)
  onSplitPane?: (topicId: string, direction: 'right' | 'down') => void;
  // Batch-close multiple panels atomically (for "Close Others" etc.)
  onCloseMultiplePanels?: (panelIds: string[]) => void;
  // Only the main standalone group should persist panel order (solo groups skip)
  persistOrder?: boolean;
  // Grid item key — used as groupId in PaneTabBar for cross-group DnD detection.
  // "standalone" for the main group, "solo:<topicId>" for split-out groups.
  gridItemKey?: string;
  // Unsolo: merge a solo topic back into the main group
  onUnsolo?: (topicId: string) => void;
  // Accept a solo topic drop (main group only) — unsolos the dropped topic
  onAcceptSoloDrop?: (topicId: string) => void;
}

export function StandaloneChatGroup({
  topicIds, topics, focusedPanelId,
  onFocusPanel, onClosePanel, onDragStart,
  getSessionMessages, isSessionLoading, isSessionStreaming,
  sendMessage, editMessage, switchBranch, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
  onToggleSidebar, panelInitialTab, onPanelInitialTabConsumed,
  onNewChat, onGroupDragStart: _onGroupDragStart, onAcceptProjectTopicDrop, stopSession,
  pendingProjectPane, onPendingProjectPaneConsumed,
  onNewChatInProject, pendingProjectFocus, onPendingProjectFocusConsumed,
  onProjectActiveTopicChange, onProjectOpenPanesChange,
  terminalSessions = [], onCreateTerminal,
  onUtilityPaneChange,
  pendingBrowserPane, onPendingBrowserPaneConsumed,
  onOpenBrowserContextIds,
  promoteDraft, draftMeta: _draftMeta,
  onSplitPane,
  onCloseMultiplePanels,
  persistOrder = true,
  gridItemKey = 'standalone',
  onUnsolo, onAcceptSoloDrop,
}: StandaloneChatGroupProps) {
  const [claudeSkipPermissions] = useClaudeSkipPermissions();
  // Track order locally for tab reordering
  const [orderedIds, setOrderedIds] = useState<string[]>(() => {
    if (!persistOrder) return topicIds;
    const saved = loadPanelOrder();
    if (saved.order.length > 0) {
      // Merge saved order with current topicIds: keep saved order for known IDs, append new ones
      const savedSet = new Set(saved.order);
      const existing = saved.order.filter(id => topicIds.includes(id) || isBrowserPaneId(id) || isSessionViewerPaneId(id));
      const added = topicIds.filter(id => !savedSet.has(id));
      return [...existing, ...added];
    }
    return topicIds;
  });
  const [panelDragOver, setPanelDragOver] = useState(false);
  // Track which panes have been pinned (not preview)
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => {
    if (!persistOrder) return new Set();
    const saved = loadPanelOrder();
    return new Set(saved.pinned);
  });
  // Ref for topicIds to use in the external update callback without recreating it
  const topicIdsRef = useRef(topicIds);
  // ISSUE 3 fix: move ref assignment to useEffect instead of during render
  useEffect(() => { topicIdsRef.current = topicIds; });
  // Persist tab order and pinned state (only for main group, not solo groups)
  const pinnedArray = useMemo(() => Array.from(pinnedIds), [pinnedIds]);
  usePanelOrderPersistence(
    persistOrder ? orderedIds : [],
    persistOrder ? pinnedArray : [],
    useCallback((state) => {
      if (state.order?.length > 0) {
        setOrderedIds(prev => {
          // Filter incoming order by our actual topicIds to prevent cross-group contamination
          const validSet = new Set(topicIdsRef.current);
          const filtered = state.order.filter(id => validSet.has(id) || isBrowserPaneId(id) || isSessionViewerPaneId(id));
          // Keep local-only panes not in the external state
          const localOnly = prev.filter(id => (isBrowserPaneId(id) || isSessionViewerPaneId(id)) && !state.order.includes(id));
          return [...filtered, ...localOnly];
        });
      }
      if (state.pinned?.length > 0) {
        setPinnedIds(new Set(state.pinned));
      }
    }, []),
    persistOrder ? onWSMessage : undefined,
  );

  // ISSUE 2 guard: orderedIds must NEVER contain an ID not in openPanels (topicIds)
  // This runs synchronously via useMemo so it's atomic with the render cycle
  const validatedOrderedIds = useMemo(() => {
    const openSet = new Set(topicIds);
    const filtered = orderedIds.filter(id =>
      openSet.has(id) || isBrowserPaneId(id) || isSessionViewerPaneId(id)
    );
    return filtered.length === orderedIds.length ? orderedIds : filtered;
  }, [orderedIds, topicIds]);

  // If validation pruned stale IDs, sync state (deferred to avoid render-phase setState)
  useEffect(() => {
    if (validatedOrderedIds !== orderedIds) {
      setOrderedIds(validatedOrderedIds);
    }
  }, [validatedOrderedIds, orderedIds]);

  // Effective pinned set: always includes project & utility panes (they must never be replaced)
  // ISSUE 23 fix: cache previous result and only return new reference when contents change
  const prevEffectivePinnedRef = useRef<Set<string>>(new Set());
  const effectivePinnedIds = useMemo(() => {
    const s = new Set(pinnedIds);
    for (const id of validatedOrderedIds) {
      if (isProjectPaneId(id) || isUtilityPanelId(id) || isBrowserPaneId(id) || isTerminalPaneId(id) || isSessionViewerPaneId(id) || isDraftPaneId(id)) s.add(id);
    }
    // Compare with previous: if contents are identical, return same reference
    const prev = prevEffectivePinnedRef.current;
    if (s.size === prev.size && [...s].every(id => prev.has(id))) {
      return prev;
    }
    prevEffectivePinnedRef.current = s;
    return s;
  }, [pinnedIds, validatedOrderedIds]);
  const pinnedIdsRef = useRef(effectivePinnedIds);
  // ISSUE 3 fix: move ref assignment to useEffect
  useEffect(() => { pinnedIdsRef.current = effectivePinnedIds; });
  // Context inspector state (lifted from ChatPanel so ring click can toggle it)
  const [contextOpen, setContextOpen] = useState(false);
  // Settings modal state (opened via right-click menu on tabs)
  const [settingsTopicId, setSettingsTopicId] = useState<string | null>(null);

  // Browser navigate URL (from WS)
  const [browserNavigateUrl, setBrowserNavigateUrl] = useState<string | null>(null);

  // Terminal pane labels derived from server sessions
  const terminalLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of terminalSessions) {
      map[`terminal:${s.id}`] = s.name;
    }
    return map;
  }, [terminalSessions]);

  // Sync when topicIds change externally (add/remove)
  // Handles preview replacement: new tab replaces the existing preview tab
  const prevTopicIdsRef = useRef(topicIds);
  // ISSUE 5 fix: track pending close with dependency on topicIds instead of running on every render
  const pendingCloseRef = useRef<string | null>(null);
  useEffect(() => {
    const prevTopicIds = prevTopicIdsRef.current;
    prevTopicIdsRef.current = topicIds;

    const wasAdded = topicIds.length > prevTopicIds.length;

    setOrderedIds(prev => {
      // Keep browser/session-viewer panes (they are managed locally, not via topicIds)
      // Terminal panes are managed via topicIds (openPanels) for persistence
      const existing = prev.filter(id => {
        if (isBrowserPaneId(id)) return true;
        if (isSessionViewerPaneId(id)) return true;
        return topicIds.includes(id);
      });
      const added = topicIds.filter(id => !prev.includes(id));

      // Preview replacement: if a single new tab was added, replace existing preview
      if (wasAdded && added.length === 1) {
        const previewId = findPreviewInList(existing, pinnedIdsRef.current, added[0]);
        if (previewId && !isBrowserPaneId(previewId) && !isTerminalPaneId(previewId) && !isSessionViewerPaneId(previewId) && !isDraftPaneId(previewId)) {
          pendingCloseRef.current = previewId;
          return replaceInList(existing, previewId, added[0]);
        }
      }

      return [...existing, ...added];
    });
    // Cleanup pinnedIds for removed topics (keep browser panes)
    setPinnedIds(prev => {
      const next = new Set([...prev].filter(id => topicIds.includes(id) || isBrowserPaneId(id) || isSessionViewerPaneId(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [topicIds]);

  // ISSUE 5 fix: Close the replaced preview tab — only runs when topicIds change (not every render)
  useEffect(() => {
    if (pendingCloseRef.current) {
      const id = pendingCloseRef.current;
      pendingCloseRef.current = null;
      onClosePanel(id);
    }
  }, [topicIds, onClosePanel]);

  // Active pane: prefer focusedPanelId if in our list, else first
  const activePaneId = validatedOrderedIds.includes(focusedPanelId || '')
    ? focusedPanelId!
    : validatedOrderedIds[0] || null;

  // Determine if the active pane is a utility panel, project pane, browser pane, terminal pane, session viewer, or a chat topic
  const activeIsBrowser = activePaneId ? isBrowserPaneId(activePaneId) : false;
  const activeIsTerminal = activePaneId ? isTerminalPaneId(activePaneId) : false;
  const activeIsSessionViewer = activePaneId ? isSessionViewerPaneId(activePaneId) : false;
  const activeSessionKey = activePaneId && activeIsSessionViewer ? getSessionKeyFromViewerPaneId(activePaneId) : null;
  const activeIsProject = activePaneId && !activeIsBrowser && !activeIsTerminal && !activeIsSessionViewer ? isProjectPaneId(activePaneId) : false;
  const activeProjectPath = activePaneId && activeIsProject ? getProjectPathFromPaneId(activePaneId) : null;
  const activeIsUtility = activePaneId && !activeIsProject && !activeIsBrowser && !activeIsTerminal && !activeIsSessionViewer ? isUtilityPanelId(activePaneId) : false;
  const activeUtilityType = activePaneId && activeIsUtility ? parseUtilityPanelType(activePaneId) : null;

  // Synthetic topics for draft panes (not yet persisted on server)
  const draftTopics = useMemo(() => {
    const map: Record<string, Topic> = {};
    for (const id of validatedOrderedIds) {
      if (isDraftPaneId(id)) {
        map[id] = {
          id,
          name: 'New Chat',
          icon: '💬',
          color: '#0066ff',
          sessionKey: `draft-session:${id}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as Topic;
      }
    }
    return map;
  }, [validatedOrderedIds]);

  const activeTopic = activePaneId && !activeIsUtility && !activeIsProject && !activeIsBrowser && !activeIsTerminal && !activeIsSessionViewer
    ? (topics[activePaneId] || draftTopics[activePaneId] || null)
    : null;

  // Compute browser context ID for RemoteBrowserPanel
  const browserContextId = useMemo(() => {
    // If the active pane is a browser pane, use its encoded context ID
    if (activePaneId && isBrowserPaneId(activePaneId)) {
      const ctx = getBrowserContextFromPaneId(activePaneId);
      if (ctx) return ctx;
    }
    // Find a topic with projectPath among ordered IDs for context
    for (const id of validatedOrderedIds) {
      if (isProjectPaneId(id)) {
        const p = getProjectPathFromPaneId(id);
        if (p) return p;
      }
      const t = topics[id];
      if (t?.projectPath) return t.id.slice(0, 8);
    }
    return validatedOrderedIds[0]?.slice(0, 8) || 'default';
  }, [activePaneId, validatedOrderedIds, topics]);
  const browserContextIdRef = useRef(browserContextId);
  // ISSUE 3 fix: move ref assignment to useEffect
  useEffect(() => { browserContextIdRef.current = browserContextId; });

  // Report utility pane status to parent (PanelGrid uses this to keep standalone alive)
  const hasUtilityPanes = useMemo(
    () => validatedOrderedIds.some(id => isBrowserPaneId(id) || isSessionViewerPaneId(id)),
    [validatedOrderedIds],
  );
  useEffect(() => {
    onUtilityPaneChange?.(hasUtilityPanes);
  }, [hasUtilityPanes, onUtilityPaneChange]);

  // Report open browser context IDs to parent for sidebar highlighting
  const openBrowserContextIds = useMemo(
    () => validatedOrderedIds.filter(isBrowserPaneId).map(id => getBrowserContextFromPaneId(id)).filter((id): id is string => id !== null),
    [validatedOrderedIds],
  );
  useEffect(() => {
    onOpenBrowserContextIds?.(openBrowserContextIds);
  }, [openBrowserContextIds, onOpenBrowserContextIds]);

  // Listen for browser:navigate WS — add browser pane if needed and navigate
  // Skip when a project pane exists (projects manage their own browser internally)
  const hasProjectPaneRef = useRef(false);
  // ISSUE 3 fix: move ref assignment to useEffect
  useEffect(() => { hasProjectPaneRef.current = validatedOrderedIds.some(id => isProjectPaneId(id)); });
  useEffect(() => {
    const unsub = onWSMessage((msg: any) => {
      if (msg.type === 'browser:navigate' && msg.url) {
        if (hasProjectPaneRef.current) return; // Let ProjectWindowPane handle it
        // Rewrite localhost URLs to use the current hostname (supports Tailscale / remote access)
        let navigateUrl: string = msg.url;
        try {
          const parsed = new URL(navigateUrl);
          if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
            parsed.hostname = window.location.hostname;
            // Keep protocol consistent with current page
            parsed.protocol = window.location.protocol;
            navigateUrl = parsed.toString();
          }
        } catch { /* not a valid URL, leave as-is */ }
        setBrowserNavigateUrl(navigateUrl);
        setOrderedIds(prev => {
          if (msg.topicId && !prev.includes(msg.topicId)) return prev;
          const existing = prev.find(id => isBrowserPaneId(id));
          if (existing) {
            queueMicrotask(() => onFocusPanel(existing));
            return prev;
          }
          const newId = createPaneId('browser');
          queueMicrotask(() => onFocusPanel(newId));
          return [...prev, newId];
        });
      }
    });
    return unsub;
  }, [onWSMessage, onFocusPanel]);

  // Handle initialTab === 'browser' by adding a browser pane
  useEffect(() => {
    if (activePaneId && panelInitialTab?.[activePaneId] === 'browser') {
      onPanelInitialTabConsumed?.(activePaneId);
      setOrderedIds(prev => {
        const existing = prev.find(id => isBrowserPaneId(id));
        if (existing) {
          queueMicrotask(() => onFocusPanel(existing));
          return prev;
        }
        const newId = createPaneId('browser');
        queueMicrotask(() => onFocusPanel(newId));
        return [...prev, newId];
      });
    }
  }, [activePaneId, panelInitialTab, onPanelInitialTabConsumed, onFocusPanel]);

  // Consume pending browser pane request (from sidebar — contextId string)
  useEffect(() => {
    if (pendingBrowserPane) {
      // Notify parent that we have utility panes BEFORE consuming the pending request,
      // so PanelGrid keeps the standalone group alive across the re-render
      onUtilityPaneChange?.(true);
      onPendingBrowserPaneConsumed?.();
      const targetId = createPaneId('browser', pendingBrowserPane);
      setOrderedIds(prev => {
        // Check if we already have a pane for this context
        if (prev.includes(targetId)) {
          queueMicrotask(() => onFocusPanel(targetId));
          return prev;
        }
        // Check for any existing browser pane — reuse it (swap context)
        const existing = prev.find(id => isBrowserPaneId(id));
        if (existing) {
          queueMicrotask(() => onFocusPanel(targetId));
          return prev.map(id => id === existing ? targetId : id);
        }
        queueMicrotask(() => onFocusPanel(targetId));
        return [...prev, targetId];
      });
    }
  }, [pendingBrowserPane, onPendingBrowserPaneConsumed, onFocusPanel]);

  // Build Pane[] for PaneTabBar (mix of chat topics, utility panes, project panes, browser panes, and terminal panes)
  const panes: Pane[] = useMemo(() =>
    validatedOrderedIds.map(id => {
      const isPreview = !effectivePinnedIds.has(id);
      if (isBrowserPaneId(id)) {
        return {
          id,
          type: 'browser' as PaneType,
          title: 'Browser',
          preview: false,
        };
      }
      if (isTerminalPaneId(id)) {
        return {
          id,
          type: 'terminal' as PaneType,
          title: terminalLabels[id] || 'Terminal',
          preview: false,
        };
      }
      if (isProjectPaneId(id)) {
        const projectPath = getProjectPathFromPaneId(id)!;
        return {
          id,
          type: 'project' as PaneType,
          title: getProjectName(projectPath),
          preview: false, // project panes are always pinned
          color: hashToColor(projectPath),
        };
      }
      if (isSessionViewerPaneId(id)) {
        const sk = getSessionKeyFromViewerPaneId(id);
        return {
          id,
          type: 'session-viewer' as PaneType,
          title: sk ? `Session: ${sk.split(':').pop()?.slice(0, 8) || 'viewer'}` : 'Session',
          sessionKey: sk || undefined,
          preview: false,
        };
      }
      if (isUtilityPanelId(id)) {
        const utilType = parseUtilityPanelType(id);
        const paneType = (utilType || 'activity') as PaneType;
        const config = PANE_CONFIG[paneType];
        return {
          id,
          type: paneType,
          title: config?.label || 'Panel',
          preview: isPreview,
        };
      }
      if (isDraftPaneId(id)) {
        return {
          id,
          type: 'chat' as PaneType,
          title: 'New Chat',
          preview: false,
        };
      }
      return {
        id,
        type: 'chat' as PaneType,
        topicId: id,
        title: topics[id]?.name || 'Chat',
        preview: isPreview,
      };
    }), [validatedOrderedIds, topics, effectivePinnedIds, terminalLabels]);

  const handleReorderPanes = useCallback((newPaneIds: string[]) => {
    setOrderedIds(newPaneIds);
  }, []);

  // Pin a preview pane (make it permanent)
  const handlePinPane = useCallback((paneId: string) => {
    setPinnedIds(prev => new Set([...prev, paneId]));
  }, []);

  // Add a pane via the "+" menu
  const handleAddPane = useCallback(async (type: PaneType, subType?: string) => {
    if (type === 'browser') {
      // Singleton: if browser pane already exists, just focus it
      const existing = validatedOrderedIds.find(id => isBrowserPaneId(id));
      if (existing) {
        onFocusPanel(existing);
        return;
      }
      const newId = createPaneId('browser');
      setOrderedIds(prev => [...prev, newId]);
      queueMicrotask(() => onFocusPanel(newId));
    } else if (type === 'terminal') {
      const termType = subType === 'claude-code' ? 'claude-code' : 'shell';
      onCreateTerminal?.(termType, claudeSkipPermissions);
    }
  }, [validatedOrderedIds, onFocusPanel, claudeSkipPermissions, onCreateTerminal]);

  // Close handler: support closing browser/terminal panes locally (they're not in topicIds)
  const handleClosePane = useCallback((paneId: string) => {
    if (isBrowserPaneId(paneId)) {
      setOrderedIds(prev => prev.filter(id => id !== paneId));
      // Destroy THIS pane's specific server browser context
      const paneContextId = getBrowserContextFromPaneId(paneId);
      if (paneContextId) {
        fetch(`/api/browsers/${encodeURIComponent(paneContextId)}`, { method: 'DELETE' }).catch(() => {});
      }
      // If the closed pane was active, focus the first remaining
      if (activePaneId === paneId) {
        const remaining = validatedOrderedIds.filter(id => id !== paneId);
        if (remaining.length > 0) onFocusPanel(remaining[0]);
      }
    } else if (isSessionViewerPaneId(paneId)) {
      setOrderedIds(prev => prev.filter(id => id !== paneId));
      if (activePaneId === paneId) {
        const remaining = validatedOrderedIds.filter(id => id !== paneId);
        if (remaining.length > 0) onFocusPanel(remaining[0]);
      }
    } else if (isTerminalPaneId(paneId)) {
      const sessionId = getTerminalSessionFromPaneId(paneId);
      if (sessionId) {
        fetch(`/api/terminal/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
      }
      onClosePanel(paneId);
    } else {
      onClosePanel(paneId);
    }
  }, [onClosePanel, activePaneId, validatedOrderedIds, onFocusPanel]);

  // Cross-group drop: accept a tab dragged from another group (solo or project).
  // When a tab is dropped onto another group's tab bar:
  // - Unsolo the dragged topic (returns to standalone)
  // - If the TARGET is also solo, unsolo it too (both merge into standalone)
  const handleCrossGroupDrop = useCallback((sourcePaneId: string, sourceGroupId: string, _insertIdx: number) => {
    const topicId = sourcePaneId.startsWith('chat:') ? sourcePaneId.slice(5) : sourcePaneId;

    if (onAcceptSoloDrop && sourceGroupId !== 'standalone' && !sourcePaneId.startsWith('chat:')) {
      // Unsolo the dragged topic
      onAcceptSoloDrop(topicId);
      // Also unsolo this group's topic if it's a solo group (merge both into standalone)
      if (onUnsolo && topicIds.length === 1) {
        onUnsolo(topicIds[0]);
      }
      return;
    }

    if (!onAcceptProjectTopicDrop) return;
    if (topicIds.includes(topicId)) return;
    onAcceptProjectTopicDrop(topicId);
  }, [onAcceptProjectTopicDrop, onAcceptSoloDrop, onUnsolo, topicIds]);

  // Handle drops from project tabs or solo groups (cross-panel-type)
  const handleStandaloneDragOver = useCallback((e: React.DragEvent) => {
    if (!onAcceptProjectTopicDrop && !onAcceptSoloDrop) return;
    // Accept PANEL_ID drops that also have PANE_TAB (from project tab bars or solo groups)
    if (!e.dataTransfer.types.includes(DND_TYPES.PANEL_ID)) return;
    if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB)) return;
    // Don't accept grid item drags
    if (e.dataTransfer.types.includes(DND_TYPES.GRID_ITEM)) return;
    e.preventDefault();
    setPanelDragOver(true);
  }, [onAcceptProjectTopicDrop, onAcceptSoloDrop]);

  const handleStandaloneDragLeave = useCallback(() => {
    setPanelDragOver(false);
  }, []);

  const handleStandaloneDrop = useCallback((e: React.DragEvent) => {
    const topicId = e.dataTransfer.getData(DND_TYPES.PANEL_ID);
    if (!topicId) return;
    e.preventDefault();
    e.stopPropagation();
    setPanelDragOver(false);

    // If the topic is already in this group, skip
    if (topicIds.includes(topicId)) return;

    // Unsolo the dropped topic
    if (onAcceptSoloDrop) {
      onAcceptSoloDrop(topicId);
      // Also unsolo this group if it's solo (merge both into standalone)
      if (onUnsolo && topicIds.length === 1) {
        onUnsolo(topicIds[0]);
      }
      return;
    }
    if (onAcceptProjectTopicDrop) {
      onAcceptProjectTopicDrop(topicId);
    }
  }, [onAcceptProjectTopicDrop, onAcceptSoloDrop, onUnsolo, topicIds]);

  // Build paneId → topicId map for context percent (only for real chat panes, not drafts)
  const paneToTopicMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const id of validatedOrderedIds) {
      if (!isUtilityPanelId(id) && !isProjectPaneId(id) && !isBrowserPaneId(id) && !isTerminalPaneId(id) && !isSessionViewerPaneId(id) && !isDraftPaneId(id)) map[id] = id;
    }
    return map;
  }, [validatedOrderedIds]);
  const contextPercent = useMultiContextPercent(paneToTopicMap, onWSMessage);

  // Project tab status indicators (git + processes)
  const projectPaths = useMemo(() => {
    const paths: string[] = [];
    for (const id of validatedOrderedIds) {
      if (isProjectPaneId(id)) {
        const p = getProjectPathFromPaneId(id);
        if (p) paths.push(p);
      }
    }
    return paths;
  }, [validatedOrderedIds]);
  const projectStatusByPath = useProjectTabStatus(projectPaths);
  const projectStatus = useMemo(() => {
    const map: Record<string, ProjectTabStatus> = {};
    for (const id of validatedOrderedIds) {
      if (isProjectPaneId(id)) {
        const p = getProjectPathFromPaneId(id);
        if (p && projectStatusByPath[p]) map[id] = projectStatusByPath[p];
      }
    }
    return map;
  }, [validatedOrderedIds, projectStatusByPath]);

  // Build set of pane IDs that are currently streaming (only real chat panes stream, not drafts)
  const streamingPaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of validatedOrderedIds) {
      if (isUtilityPanelId(id) || isBrowserPaneId(id) || isTerminalPaneId(id) || isSessionViewerPaneId(id) || isDraftPaneId(id)) continue;
      const topic = topics[id];
      if (topic && isSessionStreaming(topic.sessionKey)) {
        ids.add(id);
      }
    }
    return ids;
  }, [validatedOrderedIds, topics, isSessionStreaming]);

  // Stop streaming for a pane (paneId = topicId in standalone)
  const handleStopStreaming = useCallback((paneId: string) => {
    const topic = topics[paneId];
    if (topic) {
      const isFirst = stopSession(topic.sessionKey);
      if (isFirst) onClosePanel(paneId);
    }
  }, [topics, stopSession, onClosePanel]);

  const handleToggleContext = useCallback(() => {
    setContextOpen(prev => !prev);
  }, []);

  // Open session viewer pane (used by AgentSpawnCard in chat and AgentsPane)
  const handleOpenSessionViewer = useCallback((sessionKey: string) => {
    const newId = createPaneId('session-viewer', sessionKey);
    setOrderedIds(prev => prev.includes(newId) ? prev : [...prev, newId]);
    queueMicrotask(() => onFocusPanel(newId));
  }, [onFocusPanel]);

  // Right-click menu: Settings opens TopicSettingsModal
  const handleSettings = useCallback((paneId: string) => {
    setSettingsTopicId(paneId);
  }, []);

  // Right-click menu: Pop Out opens in new window
  const handlePopOut = useCallback((paneId: string) => {
    const url = `${window.location.origin}?topic=${paneId}`;
    isNativeApp
      ? window.open(url, `topic-${paneId}`, 'width=900,height=700')
      : window.open(url, `topic-${paneId}`);
    onClosePanel(paneId);
  }, [onClosePanel]);

  // Determine if a pane type can be split to its own grid cell
  // Chat topics and project panes are splittable — not terminal/browser/utility/draft/session-viewer
  const isSplittable = useCallback((id: string) =>
    !isTerminalPaneId(id) && !isBrowserPaneId(id) &&
    !isUtilityPanelId(id) && !isDraftPaneId(id) && !isSessionViewerPaneId(id),
  []);

  // Split Right: detach pane to a new grid column on the right
  const handleSplitRight = useCallback((paneId: string) => {
    if (!onSplitPane || !isSplittable(paneId)) return;
    onSplitPane(paneId, 'right');
  }, [onSplitPane, isSplittable]);

  // Split Down: detach pane to a new grid row below
  const handleSplitDown = useCallback((paneId: string) => {
    if (!onSplitPane || !isSplittable(paneId)) return;
    onSplitPane(paneId, 'down');
  }, [onSplitPane, isSplittable]);

  // Detach handler: split the pane to its own grid cell (right by default)
  const handleDetach = useMemo(() => {
    if (!onSplitPane) return undefined;
    return (paneId: string) => {
      if (!isSplittable(paneId)) return;
      onSplitPane(paneId, 'right');
    };
  }, [onSplitPane, isSplittable]);

  // Unsolo handler: merge a solo pane back into the main group
  const handleUnsolo = useMemo(() => {
    if (!onUnsolo) return undefined;
    return (paneId: string) => {
      onUnsolo(paneId);
    };
  }, [onUnsolo]);

  // ISSUE 22 fix: "Close Others" — batch-close multiple panels atomically
  const handleCloseOthers = useCallback((keepPaneId: string) => {
    const toClose = validatedOrderedIds.filter(id => id !== keepPaneId);
    if (toClose.length === 0) return;

    // Close locally-managed panes (browser/session-viewer) from orderedIds
    const localToClose = toClose.filter(id => isBrowserPaneId(id) || isSessionViewerPaneId(id));
    if (localToClose.length > 0) {
      setOrderedIds(prev => prev.filter(id => id === keepPaneId || (!isBrowserPaneId(id) && !isSessionViewerPaneId(id))));
      // Destroy browser contexts for closed browser panes
      for (const id of localToClose) {
        if (isBrowserPaneId(id)) {
          const ctx = getBrowserContextFromPaneId(id);
          if (ctx) fetch(`/api/browsers/${encodeURIComponent(ctx)}`, { method: 'DELETE' }).catch(() => {});
        }
      }
    }

    // Close parent-managed panes atomically (terminals, topics, utilities, etc.)
    const parentToClose = toClose.filter(id => !isBrowserPaneId(id) && !isSessionViewerPaneId(id));
    if (parentToClose.length > 0 && onCloseMultiplePanels) {
      onCloseMultiplePanels(parentToClose);
    } else {
      // Fallback: close one by one if batch callback not available
      for (const id of parentToClose) onClosePanel(id);
    }

    onFocusPanel(keepPaneId);
  }, [validatedOrderedIds, onCloseMultiplePanels, onClosePanel, onFocusPanel]);

  if (validatedOrderedIds.length === 0) return null;
  // Need at least one valid pane (either a topic, a utility, a project, a browser, or a terminal)
  if (!activeTopic && !activeIsUtility && !activeIsProject && !activeIsBrowser && !activeIsTerminal && !activeIsSessionViewer) return null;

  // Available pane types for the "+" menu
  const availableTypes: PaneType[] = (() => {
    const types: PaneType[] = ['browser', 'terminal'];
    // Only offer types that aren't already open (singleton check)
    return types.filter(t => {
      if (t === 'browser') return !validatedOrderedIds.some(id => isBrowserPaneId(id));
      return true; // terminal is not singleton — can have multiple
    });
  })();

  // Tab bar rendered inline in header
  const tabBar = (
    <PaneTabBar
      className="flex-1 py-1 pr-0 min-w-0 app-drag-region"
      panes={panes}
      activePaneId={activePaneId}
      onActivate={(paneId) => {
        if (isBrowserPaneId(paneId)) {
          // Browser panes are managed locally, just update focus
          onFocusPanel(paneId);
        } else {
          onFocusPanel(paneId);
        }
      }}
      onClose={handleClosePane}
      onAddPane={handleAddPane}
      availableTypes={availableTypes}
      groupId={gridItemKey}
      onNewChat={onNewChat}
      onReorderPanes={handleReorderPanes}
      onCrossGroupDrop={(onAcceptProjectTopicDrop || onAcceptSoloDrop) ? handleCrossGroupDrop : undefined}
      contextPercent={contextPercent}
      onContextRingClick={handleToggleContext}
      onSplitRight={onSplitPane ? handleSplitRight : undefined}
      onSplitDown={onSplitPane ? handleSplitDown : undefined}
      onDetach={onSplitPane ? handleDetach : undefined}
      onCloseOthers={handleCloseOthers}
      onSettings={handleSettings}
      onPopOut={handlePopOut}
      onDetach={handleUnsolo || handleDetach}
      streamingPaneIds={streamingPaneIds}
      onStopStreaming={handleStopStreaming}
      onPinPane={handlePinPane}
      projectStatus={projectStatus}
      hasLeftOverlay={!!onToggleSidebar}
    />
  );

  const settingsTopic = settingsTopicId ? topics[settingsTopicId] : null;

  return (
    <>
      <div
        className={`flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden transition-all ${panelDragOver ? 'ring-2 ring-primary/50' : ''}`}
        onDragOver={handleStandaloneDragOver}
        onDragLeave={handleStandaloneDragLeave}
        onDrop={handleStandaloneDrop}
      >
        {activeIsTerminal ? (
          /* ---- Terminal pane content ---- */
          <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-surface overflow-hidden">
            <div className="flex items-center pr-0 h-10 border-b border-app-border select-none flex-shrink-0 bg-surface app-drag-region" style={{ position: 'relative' }}>
              {onToggleSidebar && <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pl-1"><SidebarToggleButton onClick={onToggleSidebar} size="sm" className="!w-6 !h-6 bg-surface !rounded-md" /></div>}
              <div className="flex-1 flex items-center min-w-0 overflow-hidden app-no-drag">{tabBar}</div>
            </div>
            <Suspense fallback={LazySpinner}>
              <SingleTerminalPane sessionId={getTerminalSessionFromPaneId(activePaneId!)!} />
            </Suspense>
          </div>
        ) : activeIsSessionViewer && activeSessionKey ? (
          /* ---- Session viewer pane content ---- */
          <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-surface overflow-hidden">
            <div className="flex items-center pr-0 h-10 border-b border-app-border select-none flex-shrink-0 bg-surface app-drag-region" style={{ position: 'relative' }}>
              {onToggleSidebar && <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pl-1"><SidebarToggleButton onClick={onToggleSidebar} size="sm" className="!w-6 !h-6 bg-surface !rounded-md" /></div>}
              <div className="flex-1 flex items-center min-w-0 overflow-hidden app-no-drag">{tabBar}</div>
            </div>
            <Suspense fallback={LazySpinner}>
              <SessionViewerPane sessionKey={activeSessionKey} onNavigateToTopic={(topicId) => onFocusPanel(topicId)} />
            </Suspense>
          </div>
        ) : activeIsBrowser ? (
          /* ---- Browser pane content ---- */
          <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-surface overflow-hidden">
            <div className="flex items-center pr-0 h-10 border-b border-app-border select-none flex-shrink-0 bg-surface app-drag-region" style={{ position: 'relative' }}>
              {onToggleSidebar && <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pl-1"><SidebarToggleButton onClick={onToggleSidebar} size="sm" className="!w-6 !h-6 bg-surface !rounded-md" /></div>}
              <div className="flex-1 flex items-center min-w-0 overflow-hidden app-no-drag">{tabBar}</div>
            </div>
            <Suspense fallback={LazySpinner}>
              <RemoteBrowserPanel
                contextId={browserContextId}
                navigateUrl={browserNavigateUrl || undefined}
                onNavigateConsumed={() => setBrowserNavigateUrl(null)}
              />
            </Suspense>
          </div>
        ) : activeIsProject && activeProjectPath ? (
          /* ---- Project pane content ---- */
          <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-surface overflow-hidden">
            <div className="flex items-center pr-0 h-10 border-b border-app-border select-none flex-shrink-0 bg-surface app-drag-region" style={{ position: 'relative' }}>
              {onToggleSidebar && <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pl-1"><SidebarToggleButton onClick={onToggleSidebar} size="sm" className="!w-6 !h-6 bg-surface !rounded-md" /></div>}
              <div className="flex-1 flex items-center min-w-0 overflow-hidden app-no-drag">{tabBar}</div>
            </div>
            <ProjectWindowPane
              key={activeProjectPath}
              projectPath={activeProjectPath}
              topics={topics}
              focusedPanelId={focusedPanelId}
              onFocusPanel={onFocusPanel}
              onClosePanel={onClosePanel}
              getSessionMessages={getSessionMessages}
              isSessionLoading={isSessionLoading}
              isSessionStreaming={isSessionStreaming}
              stopSession={stopSession}
              sendMessage={sendMessage}
              editMessage={editMessage}
              switchBranch={switchBranch}
              loadHistory={loadHistory}
              chatError={chatError}
              sendWS={sendWS}
              onWSMessage={onWSMessage}
              onUpdateTopic={onUpdateTopic}
              pendingPane={pendingProjectPane && pendingProjectPane.projectPath === activeProjectPath ? pendingProjectPane.type : undefined}
              pendingTerminalSessionId={pendingProjectPane && pendingProjectPane.projectPath === activeProjectPath ? pendingProjectPane.terminalSessionId : undefined}
              pendingTerminalType={pendingProjectPane && pendingProjectPane.projectPath === activeProjectPath ? pendingProjectPane.terminalType : undefined}
              onPendingPaneConsumed={onPendingProjectPaneConsumed}
              onNewChat={onNewChatInProject ? () => onNewChatInProject(activeProjectPath) : undefined}
              pendingFocusTopicId={pendingProjectFocus && pendingProjectFocus.projectPath === activeProjectPath ? pendingProjectFocus.topicId : null}
              onPendingFocusConsumed={onPendingProjectFocusConsumed}
              onActiveTopicChange={onProjectActiveTopicChange ? (topicId) => onProjectActiveTopicChange(activeProjectPath, topicId) : undefined}
              onOpenPanesChange={onProjectOpenPanesChange ? (paneIds) => onProjectOpenPanesChange(activeProjectPath, paneIds) : undefined}
            />
          </div>
        ) : activeIsUtility ? (
          /* ---- Utility pane content ---- */
          <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-surface overflow-hidden">
            {/* Header with tab bar */}
            <div className="flex items-center pr-0 h-10 border-b border-app-border select-none flex-shrink-0 bg-surface app-drag-region" style={{ position: 'relative' }}>
              {onToggleSidebar && <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pl-1"><SidebarToggleButton onClick={onToggleSidebar} size="sm" className="!w-6 !h-6 bg-surface !rounded-md" /></div>}
              <div className="flex-1 flex items-center min-w-0 overflow-hidden app-no-drag">{tabBar}</div>
            </div>
            {/* Utility panel body */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <Suspense fallback={LazySpinner}>
                {activeUtilityType === 'activity' && <ActivityFeedPanel enabled />}
                {activeUtilityType === 'journal' && <JournalPanel enabled />}
                {activeUtilityType === 'agents' && <AgentsPane
                  onNavigateToTopic={(topicId) => onFocusPanel(topicId)}
                  onOpenSessionViewer={handleOpenSessionViewer}
                  onMessage={onWSMessage}
                />}
                {activeUtilityType === 'dashboard' && <DashboardPane onMessage={onWSMessage} />}
                {activeUtilityType === 'all-boards' && <AllBoardsPane onMessage={onWSMessage} />}
              </Suspense>
            </div>
          </div>
        ) : activeTopic ? (
          /* ---- Chat topic content ---- */
          <ChatPanel
            topic={activeTopic}
            isFocused={focusedPanelId === activePaneId}
            onFocus={() => onFocusPanel(activePaneId!)}
            onClose={() => onClosePanel(activePaneId!)}
            onDragStart={onDragStart(activePaneId!)}
            onToggleSidebar={onToggleSidebar}
            isDragOver={false}
            headerLeft={tabBar}
            showCloseButton={false}
            contextOpen={contextOpen}
            onToggleContext={handleToggleContext}
            getSessionMessages={getSessionMessages}
            isSessionLoading={isSessionLoading}
            isSessionStreaming={isSessionStreaming}
            sendMessage={
              isDraftPaneId(activePaneId!)
                ? async (_sk: string, content: string, options?: { planMode?: boolean }) => {
                    if (promoteDraft) {
                      await promoteDraft(activePaneId!, content, options);
                    }
                    return true;
                  }
                : !effectivePinnedIds.has(activePaneId!)
                  ? async (sk: string, content: string, options?: { planMode?: boolean }) => {
                      setPinnedIds(prev => new Set([...prev, activePaneId!]));
                      return sendMessage(sk, content, options);
                    }
                  : sendMessage
            }
            editMessage={editMessage}
            switchBranch={switchBranch}
            loadHistory={loadHistory}
            chatError={chatError}
            sendWS={sendWS}
            onWSMessage={onWSMessage}
            onUpdateTopic={isDraftPaneId(activePaneId!)
              ? async () => null
              : onUpdateTopic
            }
            initialTab={panelInitialTab?.[activePaneId!]}
            onInitialTabConsumed={onPanelInitialTabConsumed ? () => onPanelInitialTabConsumed(activePaneId!) : undefined}
            onOpenSessionViewer={handleOpenSessionViewer}
          />
        ) : (
          /* ---- Empty state with header ---- */
          <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-surface overflow-hidden">
            <div className="flex items-center pr-0 h-10 border-b border-app-border select-none flex-shrink-0 bg-surface app-drag-region" style={{ position: 'relative' }}>
              {onToggleSidebar && <div className="absolute left-0 top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10 pl-1"><SidebarToggleButton onClick={onToggleSidebar} size="sm" className="!w-6 !h-6 bg-surface !rounded-md" /></div>}
              <div className="flex-1 flex items-center min-w-0 overflow-hidden app-no-drag">{tabBar}</div>
            </div>
            <div className="flex-1" />
          </div>
        )}
      </div>
      {settingsTopic && (
        <Suspense fallback={null}>
          <TopicSettingsModal
            topic={settingsTopic}
            isOpen={!!settingsTopicId}
            onClose={() => setSettingsTopicId(null)}
            onUpdate={onUpdateTopic}
          />
        </Suspense>
      )}
    </>
  );
}
