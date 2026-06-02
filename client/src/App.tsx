import { useState, useRef, useEffect, useCallback, lazy, Suspense, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { Settings as SettingsIcon, X, ChevronDown, Cpu, Activity, BarChart3, Radio, Timer } from 'lucide-react';
import { SidebarToggleButton } from './components/Shared/SidebarToggleButton';
import { UpdaterToast } from './components/UpdaterToast';
import type { SidebarTab } from './types';
import { useTopics } from './hooks/useTopics';
import { useChat } from './hooks/useChat';
import { useWebSocket } from './hooks/useWebSocket';
import { TabNotificationProvider } from './hooks/useTabNotifications';
import { GlobalTabIndexProvider } from './contexts/GlobalTabIndexContext';
import { useTheme } from './hooks/useTheme';
import { useClaudeSessionState } from './hooks/useClaudeSessionState';
import { TopicsProvider } from './contexts/TopicsContext';
import { useAgents } from './hooks/useAgents';
import { useOpenClawAvailable } from './hooks/useOpenClawAvailable';
import { useClaudeSkipPermissions } from './hooks/useClaudePrefs';
import { useClaudeCodeModelSync } from './hooks/useClaudeCodeModelSync';
import { useSidebarState } from './hooks/useSidebarState';
import { useSidebarAndLayout } from './hooks/useSidebarAndLayout';
import { useTerminalLifecycle } from './hooks/useTerminalLifecycle';
import { usePanelLifecycle } from './hooks/usePanelLifecycle';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useBrowserContexts } from './hooks/useBrowserContexts';
import { useClosedTabs, createPaneId } from './state/pane/adapters';

import { TopicTree } from './components/Sidebar/TopicTree';
import { SidebarControls } from './components/Sidebar/SidebarControls';
import { ContextMenu } from './components/Modals/ContextMenu';
import { PanelGrid } from './components/Layout/PanelGrid';
import { ToastProvider, ToastOutlet } from './components/Shared/Toast';
import { CompletionNotifierBridge } from './hooks/useCompletionNotifier';
import { PendingActionProvider, enqueuePendingAction, tickPendingAction } from './contexts/PendingActionContext';
import { flushPaneStoreNow } from './state/pane/middleware';
import { useSignalsSync } from './state/useSignalsSync';
import { PaneAddMenu } from './components/Shared/PaneAddMenu';
import { ErrorBoundary } from './components/Shared/ErrorBoundary';
import { SkeletonTopicList } from './components/Shared/Skeleton';
import { SidebarStatusBar } from './components/Sidebar/SidebarStatusBar';

// Lazy-load components that are only shown on demand
const NewTopicModal = lazy(() => import('./components/Modals/NewTopicModal').then(m => ({ default: m.NewTopicModal })));
const GlobalSettings = lazy(() => import('./components/Settings/GlobalSettings').then(m => ({ default: m.GlobalSettings })));
const CommandPalette = lazy(() => import('./components/Shared/CommandPalette').then(m => ({ default: m.CommandPalette })));
const KeyboardShortcuts = lazy(() => import('./components/Shared/KeyboardShortcuts').then(m => ({ default: m.KeyboardShortcuts })));
const FileSearch = lazy(() => import('./components/Project/FileSearch').then(m => ({ default: m.FileSearch })));
const RemoteAccessPanel = lazy(() => import('./components/Sidebar/RemoteAccessPanel').then(m => ({ default: m.RemoteAccessPanel })));
// BrowserSidebarControl replaced by useBrowserContexts hook + unified TopicTree
const AgentAssignPanel = lazy(() => import('./components/Agents/AgentAssignPanel').then(m => ({ default: m.AgentAssignPanel })));
const TOPICS_MENU_PAGES = [
  { id: 'dashboard' as const, icon: BarChart3, label: 'Statistics' },
  { id: 'cron' as const, icon: Timer, label: 'Cron Jobs' },
];

// Phase 30 PANE-01: persistence for open panels is owned by the pane-store
// middleware. Component reads/writes happen via the panel-lifecycle hook
// (`usePanelLifecycle`); App-level helpers were inlined into that hook
// during the Commit 5 refactor.

export function _SafeAreaFill() {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        height: 'env(safe-area-inset-bottom, 0px)',
        background: 'var(--bg-surface)',
        zIndex: 99998,
        pointerEvents: 'none',
      }}
    />
  );
}

export function _SafeAreaDebug() {
  const [info, setInfo] = useState({ safe: '...', bodyBg: '...', appBg: '...' });
  useEffect(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;height:env(safe-area-inset-bottom,0px);pointer-events:none;visibility:hidden;';
    document.body.appendChild(probe);
    requestAnimationFrame(() => {
      const safe = probe.offsetHeight;
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      const appEl = document.getElementById('root')?.firstElementChild as HTMLElement;
      const appBg = appEl ? getComputedStyle(appEl).backgroundColor : '?';
      document.body.removeChild(probe);
      setInfo({ safe: safe + 'px', bodyBg, appBg });
    });
  }, []);
  return (
    <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 99999, pointerEvents: 'none', padding: '2px 6px', background: 'rgba(200,0,0,0.9)', color: 'white', fontSize: '10px', fontFamily: 'monospace', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      <span>safe: {info.safe}</span>
      <span>body: {info.bodyBg}</span>
      <span>app: {info.appBg}</span>
      <span>dvh: {window.innerHeight}px</span>
    </div>
  );
}

/**
 * App — root component.
 *
 * Phase 3 refactor (commits on `refactor/app-hooks`) extracted four hooks:
 *  - useSidebarAndLayout    — layout chrome, sidebar resize, traffic lights.
 *  - useTerminalLifecycle   — terminal sessions + pure pruneStaleTerminalPanes
 *                             helper.
 *  - usePanelLifecycle      — full panel-state cluster: state, store-sync,
 *                             validation, draft persistence, six per-cluster
 *                             WS subscriptions, all panel handlers, electron
 *                             effects, drain-on-reconnect, detached auto-close.
 *  - useKeyboardShortcuts   — global keydown + open-all-boards listener with
 *                             ref-mirror pattern (CRITIQUE C2 fix).
 *
 * App.tsx now owns: detached-mode detection, ten modal/menu useState
 * declarations (CRITIQUE C10), DOM refs for App-local dropdowns, two
 * outside-click effects, and the JSX tree.
 */
function App() {
  // DEV-only overlay — lazy-loaded via dynamic import() so the module stays
  // out of the production graph entirely (PANE-05 strip contract). The static
  // import was fragile: Vite minification could flatten the path string and
  // the strip-assert script would false-green.
  const [DevOverlay, setDevOverlay] = useState<ComponentType | null>(null);
  useEffect(() => {
    if (import.meta.env.DEV) {
      import('./state/pane/devOverlay').then((m) => {
        setDevOverlay(() => m.MutationLogOverlay);
      });
    }
  }, []);

  // Check if we're in detached/pop-out mode (single topic window)
  const urlParams = new URLSearchParams(window.location.search);
  const detachedTopicId = urlParams.get('topic');
  const isDetached = !!detachedTopicId;

  // Topics-menu modal state declared up-front so useSidebarAndLayout can
  // observe it for the macOS traffic-light effect (CRITIQUE C10: modal
  // state stays in App, but the side-effect lives in the layout hook).
  const [showTopicsMenu, setShowTopicsMenu] = useState(false);

  // Sidebar + layout chrome (Phase 3 hook 1)
  const layout = useSidebarAndLayout({ isDetached, showTopicsMenu });
  const {
    appSettings,
    sidebarWidth,
    sidebarCollapsed,
    isMobile,
    isPWA,
    viewportHeight,
    isElectron,
    windowId,
  } = layout.state;
  const { sidebarRef } = layout.refs;
  const {
    toggleSidebar,
    handleSidebarResizeStart,
    handleSidebarDoubleClick,
    handleSidebarTouchStart,
    handleSidebarTouchEnd,
    handleEdgeTouchStart,
    handleEdgeTouchEnd,
    setSidebarCollapsed,
    setAppSettings,
  } = layout.handlers;

  // Modals
  const [showSearch, setShowSearch] = useState(false);
  const [showNewTopic, setShowNewTopic] = useState<false | { projectPath?: string }>(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showFileSearch, setShowFileSearch] = useState<false | { projectPath: string }>(false);
  const [assignAgentsTarget, setAssignAgentsTarget] = useState<{ topicId: string; topicName: string } | null>(null);
  // The sidebar header "New" button used to track its dropdown via a
  // local `showNewMenu` boolean and a `newMenuBtnRef`. Both moved into
  // <PaneAddMenu> when we unified the three add-menu implementations
  // (top tab bar, sidebar project header, sidebar global header).
  // The yolo-toggle setter lived here while App owned the New menu; it
  // moved into <PaneAddMenu> when we unified, so we only need the
  // current value here for the spawn arg.
  const [claudeSkipPermissions] = useClaudeSkipPermissions();
  // Re-apply the user's saved Claude Code model preference once the providers
  // snapshot is available; resets each session unless localStorage has been set.
  useClaudeCodeModelSync();
  const remoteAccessBtnRef = useRef<HTMLButtonElement>(null);
  const remoteAccessDropdownRef = useRef<HTMLDivElement>(null);
  const [expandedTool, setExpandedTool] = useState<SidebarTab | null>(null);
  const topicsMenuRef = useRef<HTMLDivElement>(null);
  const topicsDropdownRef = useRef<HTMLDivElement>(null);
  const [topicsMenuPos, setTopicsMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Close topics menu on outside click or Escape
  useEffect(() => {
    if (!showTopicsMenu) return;
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (topicsMenuRef.current?.contains(t) || topicsDropdownRef.current?.contains(t)) return;
      setShowTopicsMenu(false); setExpandedTool(null);
    };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setShowTopicsMenu(false); setExpandedTool(null); e.stopPropagation(); } };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k, true);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k, true); };
  }, [showTopicsMenu]);

  // Close remote access dropdown on outside click or Escape
  useEffect(() => {
    if (expandedTool !== 'remote') return;
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (remoteAccessBtnRef.current?.contains(t) || remoteAccessDropdownRef.current?.contains(t)) return;
      setExpandedTool(null);
    };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setExpandedTool(null); e.stopPropagation(); } };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k, true);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k, true); };
  }, [expandedTool]);


  const {
    topics,
    workspaceProjects,
    loading: topicsLoading,
    error: topicsError,
    loadTopics,
    createTopic,
    updateTopic,
    archiveTopic,
    archiveProject,
    applyTopicFromWS,
  } = useTopics();

  const {
    sendMessage,
    editMessage,
    switchBranch,
    stopSession,
    getSessionMessages,
    addMessageFromWS,
    isSessionLoading,
    isSessionStreaming,
    loadHistory,
    appendMediaToLastAssistant,
    clearSession,
    drainQueue,
    expiredMessages,
    retryExpired,
    clearExpired,
    onWSMessage: chatStreamHandler,
    error: chatError,
    gatewayConnected: _gatewayConnected,
    isOwnStream,
  } = useChat();

  const { status: wsStatus, unreadData, sendWS, onMessage: onWSMessage } = useWebSocket();

  // Wire up chat stream handler to WebSocket (enables cross-window streaming)
  useEffect(() => {
    return onWSMessage(chatStreamHandler);
  }, [onWSMessage, chatStreamHandler]);

  // Terminal lifecycle (Phase 3 hook 2). Owns terminal sessions + grace
  // period ref + WS subscription. Exposes a pure pruneStaleTerminalPanes
  // helper used by the App-side cleanup effect below (CRITIQUE C5: NO
  // setOpenPanels crosses the seam).
  const terminals = useTerminalLifecycle({ wsStatus, onWSMessage });
  const terminalSessions = terminals.sessions;

  // Phase 30 PANE-01: cross-device panels sync is owned by state/pane/middleware/syncWS.ts.
  // The middleware subscribes to the pane-store reducer's lastSeq and applies
  // `ui-state:init` / `ui-state:updated` frames with the Option-A envelope
  // (frame.data['pane-store-v2'] + frame.meta['pane-store-v2'].server_seq) with
  // an LWW guard. The store-subscription effect above mirrors those updates
  // back into React state, so there is no need for a WS listener here.

  const { themeMode, toggleTheme, setTheme } = useTheme(onWSMessage);
  // Claude Code session tracker — subscribes to /api/claude-hooks-driven
  // `session:state` broadcasts. Feeds the unified signals store (useSignalsSync
  // below), which derives the per-topic "needs you" attention the notification
  // badge surfaces across the tab bar and the sidebar.
  const { sessions: claudeSessions } = useClaudeSessionState({ onWSMessage });
  const openclawAvailable = useOpenClawAvailable();
  const { activeSessions, idleSessions } = useAgents({ activeMinutes: 120, enabled: openclawAvailable });
  const agentLiveCount = activeSessions.length + idleSessions.length;
  // Feed the unified signals store from every raw input in one place
  // (agent / Claude attention / live stream / hydrated mid-reply / server pty
  // activity). Consumers only read the facade (usePaneLoading / getBadgeCount).
  useSignalsSync({
    topics,
    claudeSessions,
    activeAgentSessions: activeSessions,
    terminalSessions,
    isSessionStreaming,
    onWSMessage,
  });
  const { closedTabs, removeClosedTab } = useClosedTabs();

  const sidebarContentRef = useRef<HTMLDivElement>(null);

  // Phase 3 hook 3 — full panel-state cluster (state, store-sync,
  // validation, per-cluster WS subs, handlers). See usePanelLifecycle.ts
  // for the full effect-declaration-order contract.
  const panelLifecycle = usePanelLifecycle({
    isDetached, detachedTopicId, isMobile,
    topics, topicsLoading, loadTopics, createTopic, applyTopicFromWS, archiveProject,
    workspaceProjects,
    terminalSessions,
    pruneStaleTerminalPanes: terminals.pruneStaleTerminalPanes,
    terminalOps: terminals.ops,
    onWSMessage, sendWS, wsStatus, windowId,
    chatStreamHandlers: {
      isOwnStream, getSessionMessages, addMessageFromWS, clearSession,
      loadHistory, appendMediaToLastAssistant, sendMessage, drainQueue,
    },
    setSidebarCollapsed,
    removeClosedTab,
  });
  const {
    openPanels, focusedPanelId, previewPanelId, nextPanelMode, draftMeta,
    pendingProjectFocus, projectActiveTopics, projectOpenPanes,
    pendingProjectPane, panelInitialTab, contextMenu, expandedProjects,
    externalDragTopicId, pendingBrowserPane, pendingSoloPanelId,
    boardTaskCounts,
  } = panelLifecycle.state;
  const { focusedProjectPath } = panelLifecycle.derived;
  const {
    handleTopicClick, handleTopicDoubleClick, handleClosePanel,
    handleProjectClick, handleFocusPanel, handleReorderPanels,
    handleOpenPanelAt, handleOpenAsProject, handleAddProjectPane,
    handleOpenProjectBoard, handleArchiveProject, handleTopicContextMenu,
    handleQuickCreateTopic, handleCreateTopic, promoteDraft,
    handleQuickCreateTerminal, handleCloseTerminal, handleTerminalClick,
    handleOpenAsPage, handleExternalDrop, handleReopenClosedTab,
    handleProjectActiveTopicChange, handleProjectOpenPanesChange,
    handlePendingBrowserPaneConsumed, handlePendingSoloConsumed,
    openBrowserPane,
    setNextPanelMode, setExpandedProjects, setContextMenu,
    setPendingProjectFocus, setPendingProjectPane, setPanelInitialTab,
  } = panelLifecycle.handlers;

  // ── Pending-action wrappers (Things3-style soft-destructive flow) ──
  // Each soft-destructive action (close tab, archive topic, archive project)
  // gets two entry points:
  //   1. The default user-facing button → `*Deferred` wrapper, which queues
  //      a PendingAction toast. Nothing commits until the user ticks the
  //      checkbox + the 3s countdown elapses.
  //   2. The right-click "now" variant → calls the raw handler directly,
  //      bypassing the countdown for power users who know what they want.
  // The raw handlers (handleClosePanel, archiveTopic, handleArchiveProject)
  // remain available for both cases.
  // Helper — enqueue + auto-tick, so the countdown starts on the very first
  // click of the X / archive button. The user's "tick the checkbox" gesture
  // becomes the click itself; cancellation is a re-click on the now-filled
  // checkbox (rendered inline by the PaneTabBar / TopicItem callsites that
  // subscribe to PendingAction state). No bottom-right toast.
  const enqueueAndTick = useCallback((args: Parameters<typeof enqueuePendingAction>[0]) => {
    enqueuePendingAction(args);
    tickPendingAction(args.key);
  }, []);

  const handleClosePanelDeferred = useCallback((topicId: string, onCommit?: () => void) => {
    const topic = topics[topicId];
    const label = topic?.name || topicId.replace(/^[a-z]+:/, '') || 'Tab';
    // Pre-shift focus to the tab that WILL receive focus on commit, so the
    // user already sees the destination while the 3s progress runs (the
    // commit path uses the same "last remaining pane" rule). Only relevant
    // when this pane was the focused one — closing a background tab must
    // not steal focus from where the user is currently looking.
    let focusBeforeClose: string | null = null;
    if (focusedPanelId === topicId) {
      const remaining = openPanels.filter(id => id !== topicId);
      const nextFocus = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      if (nextFocus) {
        focusBeforeClose = topicId;
        handleFocusPanel(nextFocus);
      }
    }
    enqueueAndTick({
      key: `close-tab:${topicId}`,
      kind: 'close-tab',
      label,
      color: topic?.color,
      // Run the upstream commit (handleClosePanel — drops the pane from the
      // store + openPanels) BEFORE the kind-specific side effect (e.g. server
      // DELETE for terminal/browser). Order matters: pane has to unmount
      // first so the xterm cleanup goes through `intentionalClose=true` and
      // doesn't paint "[Session ended]" when the PTY exits.
      commit: () => { handleClosePanel(topicId); onCommit?.(); },
      // Restore focus if the user cancels mid-countdown — without this, the
      // tab they pressed cancel on isn't the one in front anymore. We only
      // restore when we actually shifted (focusBeforeClose is non-null),
      // otherwise this becomes a no-op refocus of an unrelated pane.
      onCancel: focusBeforeClose
        ? () => handleFocusPanel(focusBeforeClose!)
        : undefined,
    });
  }, [topics, handleClosePanel, enqueueAndTick, focusedPanelId, openPanels, handleFocusPanel]);

  const handleArchiveTopicDeferred = useCallback((topicId: string, archive: boolean): Promise<boolean> => {
    // Unarchive (archive=false) is restorative — commit immediately.
    if (!archive) return archiveTopic(topicId, false);
    const topic = topics[topicId];
    const label = topic?.name || topicId;
    enqueueAndTick({
      key: `archive-topic:${topicId}`,
      kind: 'archive-topic',
      label,
      color: topic?.color,
      commit: async () => { await archiveTopic(topicId, true); },
    });
    return Promise.resolve(true);
  }, [topics, archiveTopic, enqueueAndTick]);

  const handleArchiveProjectDeferred = useCallback((projectPath: string, archive: boolean): Promise<boolean> => {
    if (!archive) return handleArchiveProject(projectPath, false);
    const label = projectPath.split('/').filter(Boolean).pop() || projectPath;
    enqueueAndTick({
      key: `archive-project:${projectPath}`,
      kind: 'archive-project',
      label,
      commit: async () => { await handleArchiveProject(projectPath, true); },
    });
    return Promise.resolve(true);
  }, [handleArchiveProject, enqueueAndTick]);

  // Sidebar / browser-context state (App-level — sidebar UI consumers).
  const sidebar = useSidebarState(onWSMessage);
  const browserCtx = useBrowserContexts(true, onWSMessage);

  // Sidebar close handlers — same Things3 pattern. The raw close function
  // is server-touching (DELETE on terminal sessions / browser contexts) so
  // we wrap it in the 3 s soft window. Right-click bypasses (touch
  // overflow menu) still call the raw handlers directly.
  const handleCloseTerminalDeferred = useCallback((sessionId: string, sessionName?: string) => {
    enqueueAndTick({
      key: `close-terminal:${sessionId}`,
      kind: 'close-terminal',
      label: sessionName || 'Terminal',
      commit: async () => { await handleCloseTerminal(sessionId); },
    });
  }, [handleCloseTerminal, enqueueAndTick]);

  const handleCloseBrowserDeferred = useCallback((contextId: string) => {
    enqueueAndTick({
      key: `close-browser:${contextId}`,
      kind: 'close-browser',
      label: 'Browser',
      commit: async () => {
        // Three writes, in order:
        //
        //  1. `handleClosePanel(browser:${contextId})` — drops the pane
        //     id from `openPanels` and dispatches `CLOSE_PANE` to the
        //     pane-store so the React subtree unmounts (which in turn
        //     destroys the WebContentsView via `useNativeBrowser`'s
        //     cleanup). Has to be first: tearing down the context
        //     before the renderer is gone leaves a dangling viewId
        //     for one frame.
        //
        //  2. `flushPaneStoreNow()` — bypass the 500 ms debounce on
        //     `/api/ui-state/pane-store-v2` and PUT the new snapshot
        //     synchronously. Without this, a fast Cmd+R while the
        //     debounce is still buffering means the server snapshot
        //     still has `browser:${contextId}` in it; the next boot
        //     hydrates that snapshot, `<RemoteBrowserPanel>` mounts,
        //     `useNativeBrowser` calls `api.create(contextId)`, and
        //     Electron re-creates the partition session from disk —
        //     "ressuscitating" the tab the user just closed.
        //     `flushPaneStoreNow` returns a promise we don't await
        //     (fire-and-forget — the keepalive/beacon path picks up
        //     any retry on pagehide).
        //
        //  3. `browserCtx.closeContext(contextId)` — server DELETE
        //     for the context. Final because it's the destructive
        //     action and we want every layer above to be quiescent
        //     before the context teardown actually runs.
        handleClosePanel(`browser:${contextId}`);
        void flushPaneStoreNow();
        await browserCtx.closeContext(contextId);
      },
    });
  }, [browserCtx, enqueueAndTick, handleClosePanel]);

  // Keyboard shortcuts (Phase 3 hook 4 — ref-mirror pattern fixes
  // CRITIQUE C2 listener churn). Snapshot args mirrored into refs
  // inside the hook so the keydown listener registers ONCE on mount.
  useKeyboardShortcuts({
    isElectron,
    focusedPanelId,
    openPanels,
    projectOpenPanes,
    topics,
    focusedProjectPath,
    showSearch,
    showNewTopic,
    showShortcuts,
    showFileSearch,
    handleClosePanel,
    handleQuickCreateTopic,
    toggleSidebar,
    handleOpenAsPage,
    setFocusedPanelId: handleFocusPanel,
    handleReopenClosedTab,
    closedTabs,
    setShowSearch,
    setShowNewTopic,
    setShowShortcuts,
    setShowFileSearch,
  });

  return (
    <TopicsProvider topics={topics} terminalSessions={terminalSessions} workspaceProjects={workspaceProjects}>
    <TabNotificationProvider unreadData={unreadData} onWSMessage={onWSMessage} openPanels={openPanels} focusedPanelId={focusedPanelId}>
    <GlobalTabIndexProvider openPanels={openPanels} projectOpenPanes={projectOpenPanes}>
    <ToastProvider>
    {/* Surfaces a toast (and optional sound) when an agent completes or
        errors on any topic. Reads settings live so the master toggle in
        Settings → Notifications takes effect without a reload. Native
        desktop notifications are dispatched independently from
        electron-app/main.ts — see notifyAgentCompleted there. */}
    <CompletionNotifierBridge
      onWSMessage={onWSMessage}
      settings={appSettings}
      topics={topics}
      focusedPanelId={focusedPanelId}
    />
    {/*
      countdownMs=1500: soft-destructive close window. 3s was the original
      conservative default; 1.5s still leaves an obvious "click again to
      cancel" margin (the progress overlay reaches ~half-fill before
      commit) but stops feeling laggy. The animation now runs faster
      across every tab — chat, terminal, browser, project — through the
      same context.
    */}
    <PendingActionProvider countdownMs={1500}>
    <div
      className="flex bg-app-bg overflow-hidden max-w-[100vw]"
      onTouchStart={isMobile ? handleEdgeTouchStart : undefined}
      onTouchEnd={isMobile ? handleEdgeTouchEnd : undefined}
      style={{
        fontSize: `${appSettings.fontSize}px`,
        position: 'fixed',
        top: 0, left: 0, right: 0,
        bottom: viewportHeight != null ? undefined : 0,
        height: viewportHeight != null ? `${viewportHeight}px` : undefined,
      }}
    >
      {/* Skip to main content link for keyboard users */}
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:bg-primary focus:text-white focus:px-4 focus:py-2 focus:rounded-lg focus:text-sm">
        Skip to main content
      </a>
      {/* Mobile sidebar overlay */}
      {isMobile && !sidebarCollapsed && (
        <div
          className="fixed inset-0 bg-black/50 z-40"
          onClick={() => setSidebarCollapsed(true)}
          aria-hidden="true"
        />
      )}
      
      {/* Sidebar */}
      <div
        ref={sidebarRef}
        onTouchStart={isMobile ? handleSidebarTouchStart : undefined}
        onTouchEnd={isMobile ? handleSidebarTouchEnd : undefined}
        role="navigation"
        aria-label="Topics sidebar"
        className={`bg-surface flex flex-col flex-shrink-0 sidebar-transition overflow-hidden ${
          isMobile ? 'fixed inset-y-0 left-0 z-50 w-full' : ''
        }`}
        style={{
          width: isMobile ? (sidebarCollapsed ? 0 : '100vw') : (sidebarCollapsed ? 0 : `${sidebarWidth}px`),
          transform: isMobile && sidebarCollapsed ? 'translateX(-100%)' : 'translateX(0)',
          paddingTop: isPWA ? 'env(safe-area-inset-top, 0px)' : undefined,
        }}
      >

        
        {/* Header - draggable for window move */}
        <div
          className={`flex items-center justify-between px-2 border-b border-app-border flex-shrink-0 app-drag-region ${isMobile ? 'h-12' : 'h-10'}`}
        >
          <div className="flex items-center gap-2">
            {/* Close button on mobile */}
            {isMobile && (
              <button
                onClick={() => setSidebarCollapsed(true)}
                className="w-10 h-10 -ml-1 mr-1 flex items-center justify-center text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 rounded-md app-no-drag"
                aria-label="Close sidebar"
              >
                <X size={22} aria-hidden="true" />
              </button>
            )}
            {/* Topics button - opens combined settings & tools menu */}
            <div className="app-no-drag" ref={topicsMenuRef}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!showTopicsMenu) {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setTopicsMenuPos({ top: rect.bottom + 4, left: rect.left });
                  }
                  setShowTopicsMenu(!showTopicsMenu);
                }}
                className={`flex items-center ${isElectron ? 'gap-2' : 'gap-1'} px-1.5 py-0.5 rounded-md transition-colors cursor-pointer ${
                  showTopicsMenu ? 'bg-app-hover' : 'hover:bg-app-hover'
                }`}
                style={{ pointerEvents: 'auto' }}
                title="Settings & Tools"
              >
                <span className={`font-semibold text-app-text tracking-[-0.01em] ${isMobile ? 'text-[17px]' : 'text-[15px]'} ${isElectron && showTopicsMenu ? 'invisible' : ''}`}>Topics</span>
                <ChevronDown size={12} className={`text-app-text-muted transition-transform ${showTopicsMenu ? 'rotate-180' : ''}`} />
              </button>
            </div>
            {wsStatus !== 'connected' && (
              <span className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400 animate-pulse">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse flex-shrink-0" />
                {wsStatus === 'connecting' ? 'Connecting…' : wsStatus === 'reconnecting' ? 'Reconnecting…' : 'Offline'}
              </span>
            )}
            {wsStatus === 'connected' && topicsLoading && (
              <div className="w-3 h-3 border border-gray-300 dark:border-gray-600 border-t-transparent rounded-full animate-spin" aria-hidden />
            )}
          </div>
          <div className={`flex items-center ${isMobile ? 'gap-2' : 'gap-1'} relative z-50 app-no-drag`} style={{ pointerEvents: 'auto' }}>
            {openclawAvailable && (
              <button
                onClick={() => handleOpenAsPage('activity')}
                className={`${isMobile ? 'w-10 h-10' : 'w-7 h-7'} flex items-center justify-center text-app-text-tertiary hover:text-app-text hover:bg-app-hover rounded-md transition-colors cursor-pointer`}
                style={{ pointerEvents: 'auto' }}
                title="Activity"
                aria-label="Activity"
              >
                <Activity size={isMobile ? 18 : 14} />
              </button>
            )}
            {openclawAvailable && (
              <button
                onClick={() => handleOpenAsPage('agents')}
                className={`${isMobile ? 'w-10 h-10' : 'w-7 h-7'} flex items-center justify-center text-app-text-tertiary hover:text-app-text hover:bg-app-hover rounded-md transition-colors cursor-pointer relative`}
                style={{ pointerEvents: 'auto' }}
                title="Agents"
                aria-label="Agents"
              >
                <Cpu size={isMobile ? 18 : 14} />
                {agentLiveCount > 0 && (
                  <span className="absolute -top-0.5 -right-1.5 md:-top-1 md:-right-2.5 min-w-[14px] h-[14px] flex items-center justify-center bg-primary text-white text-[8px] font-bold rounded-full leading-none px-1">
                    {agentLiveCount}
                  </span>
                )}
              </button>
            )}
            <button
              onClick={() => setExpandedTool(expandedTool === 'remote' ? null : 'remote')}
              className={`${isMobile ? 'w-10 h-10' : 'w-7 h-7'} flex items-center justify-center text-app-text-tertiary hover:text-app-text hover:bg-app-hover rounded-md transition-colors cursor-pointer ${expandedTool === 'remote' ? 'bg-app-hover text-app-text' : ''}`}
              style={{ pointerEvents: 'auto' }}
              title="Remote Access"
              aria-label="Remote Access"
              ref={remoteAccessBtnRef}
            >
              <Radio size={isMobile ? 18 : 14} />
            </button>
            {/* Single canonical <PaneAddMenu> — same trigger button,
                same opened menu, same brand-tinted icons (Claude
                orange, Shell purple, Browser green, Git red, Files
                amber) as the top tab bar and the sidebar project
                header. The trigger is the default 'pill' variant
                (6×6 with `bg-surface` plate) so all three "+" buttons
                across the app look identical. */}
            <PaneAddMenu
              onNewChat={() => handleQuickCreateTopic()}
              onAddPane={(type, subType) => {
                if (type === 'terminal') {
                  handleQuickCreateTerminal(
                    subType === 'claude-code' ? 'claude-code' : 'shell',
                    claudeSkipPermissions,
                  );
                } else if (type === 'browser') {
                  openBrowserPane(`new-${Date.now()}`);
                }
              }}
              availableTypes={['terminal', 'browser']}
              showShortcuts
              triggerTitle="New (⌘N)"
            />
          </div>
        </div>

        {/* Search + view controls */}
        <SidebarControls
          onOpenCommandPalette={() => setShowSearch(true)}
          viewMode={sidebar.viewMode}
          onToggleViewMode={sidebar.toggleViewMode}
          showArchived={sidebar.showArchived}
          onToggleArchived={sidebar.toggleShowArchived}
        />
        {topicsError && <div className="px-2 text-red-500 text-[11px]">{topicsError}</div>}

        <div ref={sidebarContentRef} className="flex-1 flex flex-col min-h-0" data-testid="sidebar-topic-list">
          <ErrorBoundary fallbackMessage="Sidebar error">
          {topicsLoading && Object.keys(topics).length === 0 ? (
            <div className="overflow-y-auto sidebar-scroll"><SkeletonTopicList count={5} /></div>
          ) : (
          <TopicTree
            topics={topics}
            workspaceProjects={workspaceProjects}
            searchQuery=""
            expandedNodes={sidebar.expandedNodes}
            onToggleNode={sidebar.toggleNode}
            focusedTopicId={focusedPanelId}
            projectActiveTopics={projectActiveTopics}
            previewPanelId={previewPanelId}
            openPanels={openPanels}
            onTopicClick={handleTopicClick}
            onTopicDoubleClick={handleTopicDoubleClick}
            onTopicContextMenu={handleTopicContextMenu}
            unreadData={unreadData}
            onArchiveTopic={handleArchiveTopicDeferred}
            onArchiveProject={handleArchiveProjectDeferred}
            onNewTopicInProject={(projectPath) => handleQuickCreateTopic(projectPath)}
            onAddProjectPane={handleAddProjectPane}
            onProjectClick={handleProjectClick}
            stopSession={stopSession}
            onOpenProjectBoard={handleOpenProjectBoard}
            onOpenMaster={async () => {
              // Master is now an interactive `claude` PTY with the orchestrator
              // system prompt (subscription, human-driven) — NOT a chat topic.
              // Open it as a normal terminal TAB so it doesn't disrupt the
              // layout. interactive-claude-primitive (was: POST /api/topics/master
              // → chat pane, which broke the layout).
              await handleQuickCreateTerminal('claude-code', true, { role: 'master', name: 'Master' });
            }}
            boardTaskCounts={boardTaskCounts}
            onNewChat={() => handleQuickCreateTopic()}
            onNewBrowser={() => openBrowserPane(`new-${Date.now()}`)}
            terminalSessions={terminalSessions}
            browserContexts={browserCtx.contexts}
            onTerminalClick={handleTerminalClick}
            onNewTerminal={handleQuickCreateTerminal}
            onCloseTerminal={(sessionId) => {
              const session = terminalSessions.find(s => s.id === sessionId);
              handleCloseTerminalDeferred(sessionId, session?.name);
            }}
            onOpenAsProject={handleOpenAsProject}
            onOpenBrowser={(contextId) => openBrowserPane(contextId)}
            onCloseBrowser={handleCloseBrowserDeferred}
            viewMode={sidebar.viewMode}
            showArchived={sidebar.showArchived}
            expandedProjects={expandedProjects}
            onToggleProject={setExpandedProjects}
            projectOpenPanes={projectOpenPanes}
          />
          )}
          </ErrorBoundary>
        </div>

        {/* Status bar */}
        <ErrorBoundary fallbackMessage="Status bar error">
        <SidebarStatusBar />
        </ErrorBoundary>
      </div>

      {/* Sidebar resize handle - hide on mobile */}
      {!isMobile && (
        <div
          className="w-[1px] flex-shrink-0 cursor-col-resize relative bg-app-border hover:bg-primary transition-colors z-20"
          onMouseDown={handleSidebarResizeStart}
          onDoubleClick={handleSidebarDoubleClick}
        >
          <div className="absolute inset-y-0 -left-[3px] -right-[3px]" />
        </div>
      )}

      {/* Collapsed sidebar expand button - only when no panels are open (panels have inline button in their header) */}
      {sidebarCollapsed && openPanels.length === 0 && (
        <div
          className="absolute left-2 z-30 flex items-center gap-1"
          style={{ top: isMobile && isPWA ? 'calc(0.5rem + env(safe-area-inset-top, 0px))' : '0.5rem' }}
        >
          <SidebarToggleButton onClick={toggleSidebar} title="Expand sidebar (⌘B)" className="bg-surface border border-app-border-light rounded-lg shadow-sm" />
        </div>
      )}

      {/* Window close button (top-right) - only in Electron and when no panels open */}
      {isElectron && openPanels.length === 0 && (
        <button
          onClick={() => {
            // Use native bridge if available (macOS app), fallback to window.close()
            const webkit = (window as any).webkit;
            if (webkit?.messageHandlers?.closeWindow) {
              webkit.messageHandlers.closeWindow.postMessage(null);
            } else {
              window.close();
            }
          }}
          className="absolute right-2 z-30 w-7 h-7 bg-transparent hover:bg-red-500/10 dark:hover:bg-red-500/20 rounded-md flex items-center justify-center text-app-text-secondary hover:text-red-500 transition-colors"
          style={{ top: '0.5rem' }}
          title="Close window (⌘W)"
        >
          <X size={16} />
        </button>
      )}

      {/* Main Content */}
      <div id="main-content" role="main" className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-app-bg"
        style={{ contain: 'layout style', paddingTop: isPWA ? 'env(safe-area-inset-top, 0px)' : undefined }}
>

        {/* Connection status is now shown inline in the sidebar top line */}
        <ErrorBoundary fallbackMessage="Panel error">
        <PanelGrid
          openPanels={openPanels}
          focusedPanelId={focusedPanelId}
          masterPaneId={Object.values(topics).find((t) => !t.archived && t.agentTeamRole === 'lead')?.id ?? null}
          onFocusPanel={handleFocusPanel}
          onClosePanel={handleClosePanelDeferred}
          onClosePanelImmediate={handleClosePanel}
          onReorderPanels={handleReorderPanels}
          onOpenPanelAt={handleOpenPanelAt}
          nextPanelMode={nextPanelMode}
          onPanelModeUsed={() => setNextPanelMode('side')}
          getSessionMessages={getSessionMessages}
          isSessionLoading={isSessionLoading}
          isSessionStreaming={isSessionStreaming}
          stopSession={stopSession}
          sendMessage={sendMessage}
          editMessage={editMessage}
          switchBranch={switchBranch}
          loadHistory={loadHistory}
          chatError={chatError}
          expiredMessages={expiredMessages}
          retryExpired={retryExpired}
          clearExpired={clearExpired}
          sendWS={sendWS}
          onWSMessage={onWSMessage}
          onUpdateTopic={updateTopic}
          windowId={windowId}
          externalDragTopicId={externalDragTopicId}
          onExternalDrop={handleExternalDrop}
          onToggleSidebar={toggleSidebar}
          panelInitialTab={panelInitialTab}
          onPanelInitialTabConsumed={(topicId) => setPanelInitialTab((prev: typeof panelInitialTab) => { const n = { ...prev }; delete n[topicId]; return n; })}
          pendingProjectPane={pendingProjectPane}
          onPendingProjectPaneConsumed={() => setPendingProjectPane(null)}
          onNewChatInProject={(projectPath, groupId) => handleQuickCreateTopic(projectPath, groupId)}
          onNewChat={() => handleQuickCreateTopic()}
          pendingProjectFocus={pendingProjectFocus}
          onPendingProjectFocusConsumed={() => setPendingProjectFocus(null)}
          onProjectActiveTopicChange={handleProjectActiveTopicChange}
          onProjectOpenPanesChange={handleProjectOpenPanesChange}
          onCreateTerminal={handleQuickCreateTerminal}
          pendingBrowserPane={pendingBrowserPane}
          onPendingBrowserPaneConsumed={handlePendingBrowserPaneConsumed}
          pendingSoloPanelId={pendingSoloPanelId}
          onPendingSoloPanelIdConsumed={handlePendingSoloConsumed}
          promoteDraft={promoteDraft}
          draftMeta={draftMeta}
        />
        </ErrorBoundary>
      </div>

      {/* Portal dropdowns (rendered outside sidebar to escape overflow-hidden) */}
      {showTopicsMenu && createPortal(
        <div
          ref={topicsDropdownRef}
          className="bg-surface border border-app-border rounded-lg shadow-lg min-w-[200px]"
          style={{ position: 'fixed', top: topicsMenuPos.top, left: topicsMenuPos.left, zIndex: 9999 }}
        >
          {TOPICS_MENU_PAGES
            .filter(({ id }) => id !== 'cron' || openclawAvailable)
            .map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => { handleOpenAsPage(id); setShowTopicsMenu(false); setExpandedTool(null); }}
                className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors mt-1"
              >
                <Icon size={isMobile ? 18 : 14} />
                <span className="flex-1 text-left">{label}</span>
              </button>
            ))}
          <button
            onClick={() => { setShowSettings(true); setShowTopicsMenu(false); setExpandedTool(null); }}
            className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
          >
            <SettingsIcon size={isMobile ? 18 : 14} />
            <span className="flex-1 text-left">Settings</span>
          </button>
          <div className="h-1" />
        </div>,
        document.body
      )}

      {/* The "New" sidebar header menu used to live here as a hand-rolled
          DropdownPortal + 4 hard-coded items. It now renders inline above
          via <PaneAddMenu triggerVariant="ghost" />, so the trigger button
          AND the dropdown are the canonical components — no third menu
          implementation. */}

      {expandedTool === 'remote' && !showTopicsMenu && remoteAccessBtnRef.current && createPortal(
        <div
          ref={remoteAccessDropdownRef}
          className="bg-surface border border-app-border rounded-lg shadow-lg min-w-[300px]"
          style={{
            position: 'fixed',
            top: remoteAccessBtnRef.current.getBoundingClientRect().bottom + 4,
            right: window.innerWidth - remoteAccessBtnRef.current.getBoundingClientRect().right,
            zIndex: 9999,
          }}
        >
          <Suspense fallback={<div className="p-3 text-[11px] text-app-text-muted text-center">Loading...</div>}>
            <RemoteAccessPanel enabled />
          </Suspense>
        </div>,
        document.body
      )}

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          topic={contextMenu.topic}
          onClose={() => setContextMenu(null)}
          onUpdate={updateTopic}
          onDelete={archiveTopic}
          onAssignAgents={(topicId, topicName) => setAssignAgentsTarget({ topicId, topicName })}
          onOpenBoard={handleOpenProjectBoard}
        />
      )}

      {/* New topic modal */}
      {showNewTopic && (
        <Suspense fallback={null}>
          <NewTopicModal
            isOpen={!!showNewTopic}
            onClose={() => setShowNewTopic(false)}
            onCreate={handleCreateTopic}
            projectPath={showNewTopic ? showNewTopic.projectPath : undefined}
            onMessage={onWSMessage}
          />
        </Suspense>
      )}

      {/* Settings modal */}
      {showSettings && (
        <Suspense fallback={null}>
          <GlobalSettings
            isOpen={showSettings}
            onClose={() => setShowSettings(false)}
            settings={appSettings}
            onSettingsChange={setAppSettings}
            themeMode={themeMode}
            onThemeChange={setTheme}
          />
        </Suspense>
      )}

      {/* Agent Assign Panel */}
      {assignAgentsTarget && (
        <Suspense fallback={null}>
          <AgentAssignPanel
            topicId={assignAgentsTarget.topicId}
            topicName={assignAgentsTarget.topicName}
            onClose={() => setAssignAgentsTarget(null)}
          />
        </Suspense>
      )}

      {/* Command Palette (⌘K / ⌘P) */}
      {showSearch && (
        <Suspense fallback={null}>
          <CommandPalette
            isOpen={showSearch}
            onClose={() => setShowSearch(false)}
            topics={topics}
            onOpenTopic={(id) => handleTopicClick(id)}
            onOpenProject={handleProjectClick}
            onNewTopic={handleQuickCreateTopic}
            onNewProject={isElectron ? async () => {
              const path = await (window as any).electronAPI?.selectDirectory?.();
              if (path) handleProjectClick(path);
            } : undefined}
            onNewClaude={() => handleQuickCreateTerminal('claude-code', claudeSkipPermissions)}
            onNewTerminal={() => handleQuickCreateTerminal('shell')}
            onToggleTheme={toggleTheme}
            onOpenSettings={() => { setShowSearch(false); setShowSettings(true); }}
            onOpenFileSearch={() => {
              setShowSearch(false);
              // Resolve projectPath the same way as Cmd+Shift+F
              if (focusedProjectPath) { setShowFileSearch({ projectPath: focusedProjectPath }); return; }
              const projectPaths = [...new Set(Object.values(topics).map(t => t.projectPath).filter(Boolean))] as string[];
              if (projectPaths.length >= 1) { setShowFileSearch({ projectPath: projectPaths[0] }); }
            }}
            themeMode={themeMode}
            projectPath={focusedProjectPath}
            onOpenFile={(path) => {
              // Target the searched project's WINDOW explicitly (not just the
              // focused panel id) so the file opens ONLY in that project window,
              // never in every project open in split view.
              const topicId = focusedProjectPath ? createPaneId('project', focusedProjectPath) : focusedPanelId;
              window.dispatchEvent(new CustomEvent('open-file', { detail: { path, topicId } }));
              setShowSearch(false);
            }}
            isElectron={isElectron}
            closedTabs={closedTabs}
            onReopenClosedTab={handleReopenClosedTab}
          />
        </Suspense>
      )}

      {/* Keyboard Shortcuts (⌘?) */}
      {showShortcuts && (
        <Suspense fallback={null}>
          <KeyboardShortcuts
            isOpen={showShortcuts}
            onClose={() => setShowShortcuts(false)}
            isElectron={isElectron}
          />
        </Suspense>
      )}

      {showFileSearch !== false && (
        <Suspense fallback={null}>
          <FileSearch
            projectPath={showFileSearch.projectPath}
            onOpenFile={(path, lineNumber) => {
              // The file-search modal is scoped to a specific project; target
              // THAT project's window so the file opens only there.
              window.dispatchEvent(new CustomEvent('open-file', {
                detail: { path, lineNumber, topicId: createPaneId('project', showFileSearch.projectPath) },
              }));
            }}
            onClose={() => setShowFileSearch(false)}
          />
        </Suspense>
      )}

      {import.meta.env.DEV && DevOverlay && <DevOverlay />}

      {/* Phase E · UpdaterToast (rendered at root, listens to electron-updater) */}
      <UpdaterToast />

      {/* Root-level fallback outlet for global notifications (e.g. agent
          completion). When a scoped outlet (ProjectWindow's) is mounted,
          this one stays hidden to avoid double-rendering — the scoped
          outlet wins and toasts appear inside the project pane. */}
      <ToastOutlet fixed fallback />
    </div>
    </PendingActionProvider>
    </ToastProvider>
    </GlobalTabIndexProvider>
    </TabNotificationProvider>
    </TopicsProvider>
  );
}

export default App;
