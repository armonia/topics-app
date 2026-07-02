import { useState, useRef, useEffect, useCallback, lazy, Suspense, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { Settings as SettingsIcon, X, ChevronDown, Cpu, Activity, BarChart3, Radio, Timer, Search, Archive, LayoutGrid, List } from 'lucide-react';
import { SidebarToggleButton } from './components/Shared/SidebarToggleButton';
import { UpdaterToast } from './components/UpdaterToast';
import type { SidebarTab } from './types';
import { useTopics } from './hooks/useTopics';
import { useChat } from './hooks/useChat';
import { useWebSocket } from './hooks/useWebSocket';
import { TabNotificationProvider } from './hooks/useTabNotifications';
import { useTheme } from './hooks/useTheme';
import { useClaudeSessionState } from './hooks/useClaudeSessionState';
import { TopicsProvider } from './contexts/TopicsContext';
import { useAgents } from './hooks/useAgents';
import { useOpenClawAvailable } from './hooks/useOpenClawAvailable';
import { useClaudeSkipPermissions } from './hooks/useClaudePrefs';
import { useClaudeCodeModelSync } from './hooks/useClaudeCodeModelSync';
import { useSidebarState } from './hooks/useSidebarState';
import { useSidebarAndLayout } from './hooks/useSidebarAndLayout';
import { useFloatingVibrancy } from './hooks/useFloatingVibrancy';
import { useSidebarFitCoalesce } from './hooks/useSidebarFitCoalesce';
import { useSidebarFlipPush } from './hooks/useSidebarFlipPush';
import { isDesktop, isTauri } from './lib/shell';
import { selectDirectory } from './lib/shell/app';
import { wireTauriDragRegions } from './lib/shell/window';

// Tauri-on-macOS chrome parity: like Electron, the traffic lights are HIDDEN by
// default and revealed only while the Topics menu is open (the Rust shell hides
// them on launch; `set_traffic_lights` toggles them). So — same as Electron — no
// permanent left inset is needed; instead, while the menu is open the "Topics"
// label is hidden so the revealed lights occupy that spot.
const isTauriMac = isTauri && typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');
import { useAnimationPause } from './hooks/useAnimationPause';
import { useTerminalLifecycle } from './hooks/useTerminalLifecycle';
import { usePanelLifecycle } from './hooks/usePanelLifecycle';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useBrowserContexts } from './hooks/useBrowserContexts';
import { useClosedTabs, createPaneId } from './state/pane/adapters';

import { TopicTree } from './components/Sidebar/TopicTree';
import { SplitPositionProvider } from './contexts/SplitPositionContext';
import { ContextMenu } from './components/Modals/ContextMenu';
import { PanelGrid } from './components/Layout/PanelGrid';
import { ToastProvider, ToastOutlet } from './components/Shared/Toast';
import { CompletionNotifierBridge } from './hooks/useCompletionNotifier';
import { PendingActionProvider, enqueuePendingAction, tickPendingAction, cancelPendingAction, flushPendingActions } from './contexts/PendingActionContext';
import { flushPaneStoreNow, flushLocalPaneStoreNow } from './state/pane/middleware';
import { useSignalsSync } from './state/useSignalsSync';
import { useAgentActivityCounts } from './state/signals';
import { PaneAddMenu } from './components/Shared/PaneAddMenu';
import { RESTING_SURFACE, ROW_INSET } from './lib/selectionStyles';
import { normalizeTerminalAgent } from './lib/terminalAgents';
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

  // Tauri: make the Electron drag-region chrome draggable under WKWebView by
  // mirroring `.app-drag-region`/`.app-no-drag` onto Tauri's drag attributes.
  // No-op off Tauri; safe to run once on mount.
  useEffect(() => { wireTauriDragRegions(); }, []);

  // Unload-time flush: a reload / navigation while a close is still counting
  // down must COMMIT the pending close, not drop it — otherwise the just-closed
  // browser / terminal / utility tab resurrects on the next boot (the pending
  // CLOSE_PANE that records the tombstone + removes the pane from the persisted
  // snapshot never ran). Order matters and is why this lives in ONE handler
  // instead of two independent `pagehide` listeners: flush the pending commits
  // FIRST (each dispatches CLOSE_PANE into the store), THEN write the store
  // snapshot to localStorage. The persistLocal middleware also has a `pagehide`
  // flush, but it registers at bootstrap — before this component mounts — so it
  // would run first and persist the stale pre-close snapshot. Calling the local
  // flush explicitly here guarantees the post-commit state is the one written.
  useEffect(() => {
    const onUnload = () => {
      flushPendingActions();
      flushLocalPaneStoreNow();
    };
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('beforeunload', onUnload);
    };
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

  // Native per-region vibrancy (macOS desktop only — Electron + Tauri). Streams
  // panel rects to the transparent window so floating-splits gaps show the clear
  // desktop while each panel frosts; host-resolved internally, no-op off-mac/web.
  useFloatingVibrancy(appSettings.floatingSplits);
  // Sidebar reveal is ONE model on every non-mobile shell (Electron, Tauri, desktop web):
  // the sidebar is position:fixed and the content is FLIP-pushed (paddingLeft committed in
  // one reflow, then a compositor-only translateX slide) — see useSidebarFlipPush. No
  // per-shell branch and no "overlay vs push" toggle: the FLIP is 60fps regardless of how
  // many terminals are live (it replaced the old in-flow width animation that relayed out
  // every .xterm each frame, ~25fps with 8). Mobile keeps its own full-width drawer below.
  const sidebarFixed = !isMobile;
  // SYNCHRONISED PUSH via FLIP (useSidebarFlipPush): the content reveal is a compositor-only
  // transform:translateX, NOT an animated paddingLeft. Animating paddingLeft (a layout prop)
  // relayouts every visible .xterm box each frame (~25fps with 8) — which the old code dodged
  // by SNAPPING the pad under load (a feature-disable we removed). FLIP commits the final pad
  // in ONE reflow (terminals settle once) then slides a transform at 60fps regardless of N,
  // with nothing hidden/held. In FLOATING-SPLITS mode the expanded pad gets the same inter-card
  // gap (2×--float-gap = 4px) the floating sidebar card uses, matching the split-card gaps.
  const FLOAT_SIDEBAR_GAP = 4; // px — keep in sync with index.css --float-gap (2px) ×2
  const expandedPad = sidebarWidth + (appSettings.floatingSplits ? FLOAT_SIDEBAR_GAP : 0);
  // Refs for the FLIP: #main-content owns the committed paddingLeft (imperative, so the layout
  // effect can read the pre-commit position); the inner flip layer carries the translateX.
  const mainContentRef = useRef<HTMLDivElement | null>(null);
  const contentFlipRef = useRef<HTMLDivElement | null>(null);
  useSidebarFlipPush(mainContentRef, contentFlipRef, { collapsed: sidebarCollapsed, expandedPad, enabled: sidebarFixed });
  // Coalesce xterm fit() across the sidebar collapse/expand (held during the slide, one fit at
  // the settled size) — driven off the SIDEBAR's own transform transition, untouched by FLIP.
  useSidebarFitCoalesce();
  // Diagnostic (Tauri): expose the sidebar toggle so the env-gated FPS self-test
  // (TOPICS_FPS_SELFTEST, injected at boot by src-tauri) can drive a real
  // collapse/expand and sample rAF frame timing. Inert when the test isn't running.
  useEffect(() => {
    if (!isTauri) return;
    (window as unknown as { __topicsToggleSidebar?: () => void }).__topicsToggleSidebar = toggleSidebar;
  }, [toggleSidebar]);
  // Stop the always-running loaders / awaiting-pulse breathers from burning the
  // compositor while the window is backgrounded (minimized / occluded / blurred).
  useAnimationPause();

  // Modals
  const [showSearch, setShowSearch] = useState(false);
  // ⌘K opens the palette in 'all' mode; ⌘F opens it pre-scoped to PROJECTS
  // (find/jump to a project). The scope is sticky for the open session of
  // the palette and reset by whichever shortcut/button opens it next.
  const [searchScope, setSearchScope] = useState<'all' | 'projects'>('all');
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

  // Close remote access dropdown on outside click or Escape. The trigger now
  // lives inside the Topics ▾ menu, so guard against the Topics menu wrapper.
  useEffect(() => {
    if (expandedTool !== 'remote') return;
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (topicsMenuRef.current?.contains(t) || remoteAccessDropdownRef.current?.contains(t)) return;
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
    reconcileServerStreams,
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
    reconcileServerStreams,
    onWSMessage,
  });
  const { closedTabs, removeClosedTab } = useClosedTabs();

  // Live agent counts for the status bar. Counted from the SAME signals the tab
  // spinners + blue "awaiting" fills use (useAgentActivityCounts) so the number
  // can't drift from the surfaces — and, unlike raw phase counting, a claude-code
  // session stuck at `starting` (hooks never fired) still counts as working via
  // the pty-busy signal.
  const agentCounts = useAgentActivityCounts(terminalSessions);

  const sidebarContentRef = useRef<HTMLDivElement>(null);

  // Phase 3 hook 3 — full panel-state cluster (state, store-sync,
  // validation, per-cluster WS subs, handlers). See usePanelLifecycle.ts
  // for the full effect-declaration-order contract.
  const panelLifecycle = usePanelLifecycle({
    isDetached, detachedTopicId, isMobile,
    topics, topicsLoading, loadTopics, createTopic, applyTopicFromWS, archiveProject, archiveTopic,
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
  } = panelLifecycle.state;
  const { focusedProjectPath } = panelLifecycle.derived;
  const {
    handleTopicClick, handleTopicDoubleClick, handleClosePanel,
    handleProjectClick, handleFocusPanel, handleReorderPanels,
    handleOpenPanelAt, handleOpenAsProject, handleAddProjectPane,
    handleArchiveProject, handleTopicContextMenu,
    handleQuickCreateTopic, handleCreateTopic, promoteDraft,
    handleQuickCreateTerminal, handleCloseTerminal, handleTerminalClick,
    handleOpenAsPage, handleExternalDrop, handleReopenClosedTab,
    handleProjectActiveTopicChange, handleProjectOpenPanesChange,
    handlePendingBrowserPaneConsumed, handlePendingSoloConsumed,
    openBrowserPane,
    setNextPanelMode, setExpandedProjects, setContextMenu,
    setPendingProjectFocus, setPendingProjectPane, setPanelInitialTab,
  } = panelLifecycle.handlers;

  // Electron "Reopen Closed Tab" menu accelerator (⇧⌘T) → reopen the most
  // recently closed tab via the SAME shared handler the keyboard chord and the
  // ⌘K palette use (single reopen entry point). The chord also resolves through
  // the renderer keydown (useKeyboardShortcuts); this IPC path additionally
  // covers the case where focus is inside a native pane that swallows the
  // renderer keydown. Ref-mirror so the listener registers once but always
  // reads the freshest stack head.
  const reopenClosedRef = useRef({ tabs: closedTabs, reopen: handleReopenClosedTab });
  useEffect(() => {
    reopenClosedRef.current = { tabs: closedTabs, reopen: handleReopenClosedTab };
  });
  useEffect(() => {
    const api = (window as unknown as {
      electronAPI?: {
        onReopenClosedTab?: (cb: () => void) => void;
        removeReopenClosedTabListener?: () => void;
      };
    }).electronAPI;
    if (!api?.onReopenClosedTab) return;
    api.onReopenClosedTab(() => {
      const { tabs, reopen } = reopenClosedRef.current;
      if (tabs[0]) reopen(tabs[0]);
    });
    return () => api.removeReopenClosedTabListener?.();
  }, []);

  // Open / create a project via the native folder picker (select an existing
  // folder OR create a new one in the OS dialog). Shared by CommandPalette
  // (onNewProject) and PaneAddMenu's "Apri/Crea Progetto" items, the latter
  // firing a window event so the action needs no prop-threading through every
  // menu host. Shell-resolved: Electron IPC dialog OR Tauri dialog plugin; no-op
  // (null) on web. Previously read electronAPI directly → dead under Tauri.
  const handleOpenProjectPicker = useCallback(async () => {
    // Guard the native dialog: a rejected/cancelled call must not bubble up as
    // an unhandled promise rejection. (Toast isn't reachable here — this
    // component renders ToastProvider, so swallow + log is the safe floor.)
    try {
      const path = await selectDirectory();
      if (path) handleProjectClick(path);
    } catch (err) {
      console.error('Project picker dialog failed', err);
    }
  }, [handleProjectClick]);

  useEffect(() => {
    const handler = () => { void handleOpenProjectPicker(); };
    window.addEventListener('topics:open-project-picker', handler);
    return () => window.removeEventListener('topics:open-project-picker', handler);
  }, [handleOpenProjectPicker]);

  // Native tray menu (Tauri) click on an attention row → open/focus that topic,
  // exactly like a sidebar click. The Rust `nav:` handler dispatches this DOM
  // CustomEvent into the webview (no @tauri-apps/event dependency).
  useEffect(() => {
    const handler = (e: Event) => {
      const topicId = (e as CustomEvent<{ topicId?: string }>).detail?.topicId;
      if (topicId) handleTopicClick(topicId);
    };
    window.addEventListener('topics:tray-navigate', handler);
    return () => window.removeEventListener('topics:tray-navigate', handler);
  }, [handleTopicClick]);

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

  // Immediate close ("Close now"): defuse a deferred close still counting
  // down before closing — otherwise the pending commit re-fires
  // handleClosePanel at T+3s (double pushUndo + re-run archive side effects).
  // Mirrors the project-level guard in useProjectLayout.handleClosePaneNow.
  // Memoized so renderGroupForKey in PanelGrid doesn't regenerate per render.
  const handleClosePanelImmediate = useCallback((topicId: string) => {
    cancelPendingAction(`close-tab:${topicId}`);
    handleClosePanel(topicId);
  }, [handleClosePanel]);

  const handleClosePanelDeferred = useCallback((topicId: string, onCommit?: () => void) => {
    const topic = topics[topicId];
    const label = topic?.name || topicId.replace(/^[a-z]+:/, '') || 'Tab';
    // Pre-shift focus to the tab that WILL receive focus on commit, so the
    // user already sees the destination while the 3s progress runs (the
    // commit path in usePanelLifecycle uses the same same-index-clamped
    // rule). Only relevant when this pane was the focused one — closing a
    // background tab must not steal focus from where the user is currently
    // looking. Same-index (clamped) matches the project groups' rule: focus
    // the tab that slides into the closed tab's slot, not the last pane in
    // openPanels — which can be an unrelated split cell appended later.
    let focusBeforeClose: string | null = null;
    if (focusedPanelId === topicId) {
      const idx = openPanels.indexOf(topicId);
      const remaining = openPanels.filter(id => id !== topicId);
      const nextFocus = remaining.length > 0 ? remaining[Math.min(idx, remaining.length - 1)] : null;
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
    enableNewChat: appSettings.enableNewChat,
    handleClosePanel,
    toggleSidebar,
    handleOpenAsPage,
    setFocusedPanelId: handleFocusPanel,
    handleReopenClosedTab,
    closedTabs,
    setShowSearch,
    setSearchScope,
    setShowNewTopic,
    setShowShortcuts,
    setShowFileSearch,
  });

  // Page-initiated close: a site (post-OAuth "you may now close this window") or
  // the agent (browser_eval("window.close()")) called window.close(). Electron
  // forwards it here with the browser pane's contextId. Close the OWNING pane:
  //  - app-level (group:default) → full deferred teardown (pane + server context).
  //  - project-internal → dispatch a CustomEvent the owning ProjectWindow handles
  //    (guarded by ownership there, so exactly one surface closes it). We must NOT
  //    run the app-level teardown for a project pane — closeContext would tear down
  //    the very context the project pane is still driving.
  const openPanelsForCloseRef = useRef(openPanels);
  openPanelsForCloseRef.current = openPanels;
  useEffect(() => {
    const api = window.electronAPI?.browserNative;
    if (!api?.onPageCloseRequest) return;
    return api.onPageCloseRequest((contextId) => {
      if (openPanelsForCloseRef.current.includes(`browser:${contextId}`)) {
        handleCloseBrowserDeferred(contextId);
      } else {
        window.dispatchEvent(new CustomEvent('browser:request-close', { detail: { contextId } }));
      }
    });
  }, [handleCloseBrowserDeferred]);

  // ── ⌘K overlay-host routing ────────────────────────────────────────────
  // In Electron the command palette must paint ABOVE the native browser
  // WebContentsView, so we render it in the transparent always-on-top overlay
  // window (electron-app/overlay-host.ts) instead of inline. The data snapshot
  // is sent on open; each palette action is relayed back here and run against
  // the SAME handlers the inline palette uses. On the web there's no overlay
  // API, so the inline palette below renders as before.
  const overlayHostAvailable = typeof window !== 'undefined' && !!window.electronAPI?.overlayHost;

  const cmdDataRef = useRef<Record<string, unknown>>({});
  cmdDataRef.current = {
    scope: searchScope,
    topics,
    workspaceProjects,
    themeMode,
    dark: themeMode === 'dark'
      || (themeMode === 'system' && typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches),
    projectPath: focusedProjectPath,
    enableNewChat: appSettings.enableNewChat,
    closedTabs,
  };

  const runCommandActionRef = useRef<(a: { type: string; args: unknown[] }) => void>(() => {});
  runCommandActionRef.current = ({ type, args }) => {
    switch (type) {
      case 'onOpenTopic': handleTopicClick(args[0] as string); break;
      case 'onOpenProject': handleProjectClick(args[0] as string); break;
      case 'onNewTopic': handleQuickCreateTopic(); break;
      case 'onNewProject': if (isElectron) handleOpenProjectPicker(); break;
      case 'onNewClaude': handleQuickCreateTerminal('claude-code', claudeSkipPermissions); break;
      case 'onNewCodex': handleQuickCreateTerminal('codex'); break;
      case 'onNewTerminal': handleQuickCreateTerminal('shell'); break;
      case 'onToggleTheme': toggleTheme(); break;
      case 'onOpenSettings': setShowSearch(false); setShowSettings(true); break;
      case 'onOpenFileSearch': {
        setShowSearch(false);
        if (focusedProjectPath) { setShowFileSearch({ projectPath: focusedProjectPath }); break; }
        const pps = [...new Set(Object.values(topics).map(t => t.projectPath).filter(Boolean))] as string[];
        if (pps.length >= 1) setShowFileSearch({ projectPath: pps[0] });
        break;
      }
      case 'onOpenFile': {
        const path = args[0] as string;
        const topicId = focusedProjectPath ? createPaneId('project', focusedProjectPath) : focusedPanelId;
        window.dispatchEvent(new CustomEvent('open-file', { detail: { path, topicId } }));
        setShowSearch(false);
        break;
      }
      case 'onReopenClosedTab':
        handleReopenClosedTab(args[0] as Parameters<typeof handleReopenClosedTab>[0]);
        break;
      case 'onResetPanels':
        // Relayed from the overlay-host palette (Electron) — same per-window
        // event the inline palette dispatches; runs in THIS (main) renderer.
        window.dispatchEvent(new CustomEvent('topics:reset-split-layout'));
        break;
    }
  };

  // Register the relay listeners once.
  useEffect(() => {
    const oh = window.electronAPI?.overlayHost;
    if (!oh) return;
    const offAction = oh.onAction((a) => runCommandActionRef.current(a));
    const offClosed = oh.onClosed(() => setShowSearch(false));
    return () => { offAction?.(); offClosed?.(); };
  }, []);

  // Show / hide the overlay-host palette as showSearch toggles (snapshot on open).
  useEffect(() => {
    const oh = window.electronAPI?.overlayHost;
    if (!oh) return;
    if (showSearch) oh.show({ modal: 'command-palette', data: cmdDataRef.current });
    else oh.hide();
  }, [showSearch]);

  return (
    <TopicsProvider topics={topics} terminalSessions={terminalSessions} workspaceProjects={workspaceProjects}>
    <TabNotificationProvider unreadData={unreadData} onWSMessage={onWSMessage} openPanels={openPanels} focusedPanelId={focusedPanelId}>
    <SplitPositionProvider>
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
      terminalSessions={terminalSessions}
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
      className={`flex bg-app-bg overflow-hidden max-w-[100vw] ${appSettings.floatingSplits && isDesktop ? 'floating-splits' : ''}`}
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
          isMobile ? 'fixed inset-y-0 left-0 z-50 w-full'
            : 'fixed inset-y-0 left-0 z-40 shadow-2xl'
        }`}
        style={{
          // Non-mobile: the sidebar is position:fixed with a CONSTANT width and collapses
          // via a composited translateX, so the content area never resizes on toggle — the
          // reveal is the FLIP push on #main-content (useSidebarFlipPush). Mobile is a
          // full-width drawer that slides the same way.
          width: isMobile
            ? (sidebarCollapsed ? 0 : '100vw')
            : `${sidebarWidth}px`,
          transform: sidebarCollapsed ? 'translateX(-100%)' : 'translateX(0)',
          // Safe-area top inset applied UNCONDITIONALLY: env() self-zeroes when
          // there's no inset (desktop, non-notched), so gating it on isPWA was
          // the bug that left content clipped under the notch when the app is
          // opened in a plain mobile browser tab (e.g. over Tailscale, where
          // display-mode is 'browser', not 'standalone'). The mobile sidebar is
          // `position: fixed inset-y-0`, so it escapes the root and needs its own.
          paddingTop: 'env(safe-area-inset-top, 0px)',
        }}
      >

        
        {/* Header - draggable for window move. Horizontal inset = ROW_INSET,
            the same 6px the tab strip, the sidebar cards, and the list's
            vertical padding use — one inset on every sidebar axis. */}
        <div
          data-tauri-drag-region="deep"
          className={`flex items-center justify-between gap-2 border-b border-app-border flex-shrink-0 app-drag-region ${isMobile ? 'h-12' : 'h-10'}`}
          style={{ paddingRight: ROW_INSET, paddingLeft: ROW_INSET }}
        >
          <div className="flex items-center gap-2 flex-1 min-w-0">
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
                className={`flex items-center ${isElectron || isTauriMac ? 'gap-2' : 'gap-1'} px-1.5 py-0.5 rounded-md transition-colors cursor-pointer ${
                  showTopicsMenu ? 'bg-app-hover' : 'hover:bg-app-hover'
                }`}
                style={{ pointerEvents: 'auto' }}
                title="Settings & Tools"
              >
                <span className={`font-semibold text-app-text tracking-[-0.01em] ${isMobile ? 'text-[17px]' : 'text-[15px]'} ${(isElectron || isTauriMac) && showTopicsMenu ? 'invisible' : ''}`}>Topics</span>
                <ChevronDown size={12} className={`text-app-text-muted transition-transform ${showTopicsMenu ? 'rotate-180' : ''}`} />
              </button>
            </div>
            {/* Connection + loading status live in the bottom SidebarStatusBar
                and the tree skeleton — no stray spinner in the header. The
                middle of the header stays empty (drag region on Electron). */}
          </div>
          <div className={`flex items-center ${isMobile ? 'gap-2' : 'gap-1'} relative z-50 app-no-drag`} style={{ pointerEvents: 'auto' }}>
            {/* Activity / Agents / Remote Access moved into the Topics ▾ menu;
                the header right side is the Search launcher + the canonical
                "+" add menu — two icon-only RESTING_SURFACE twins. */}
            {/* Search launcher — icon-only (the magnifier + kbd hint say it
                all; a "Search…" label was redundant). Opens the ⌘K command
                palette in 'all' scope. No inline tree filtering; ⌘K is the
                canonical search. */}
            <button
              onClick={() => { setSearchScope('all'); setShowSearch(true); }}
              className={`${isMobile ? 'h-9 px-2.5' : 'h-7 px-2'} flex items-center gap-1.5 rounded-md ${RESTING_SURFACE} text-app-text-muted hover:text-app-text transition-colors flex-shrink-0 cursor-pointer app-no-drag`}
              style={{ pointerEvents: 'auto' }}
              title="Search (⌘K)"
              aria-label="Search — open the command palette"
            >
              <Search size={isMobile ? 18 : 14} className="flex-shrink-0" aria-hidden="true" />
              {!isMobile && <kbd className="kbd flex-shrink-0 hidden md:inline">&#8984;K</kbd>}
            </button>
            {/* The canonical <PaneAddMenu>, STANDALONE variant, rendered as a
                centered ⌘K-style palette (presentation="palette") instead of a
                local dropdown — ⌘N opens the same surface. The trigger is the
                'header' variant: a compact RESTING_SURFACE button with an
                inline kbd hint, the visual twin of the Search button next to
                it. Items/order/icons are identical to the standalone tab
                bar's "+" — one component, one variant per context. */}
            <PaneAddMenu
              scope="standalone"
              presentation="palette"
              onNewChat={appSettings.enableNewChat ? () => handleQuickCreateTopic() : undefined}
              onAddPane={(type, subType) => {
                if (type === 'terminal') {
                  handleQuickCreateTerminal(
                    normalizeTerminalAgent(subType),
                    claudeSkipPermissions,
                  );
                } else if (type === 'browser') {
                  openBrowserPane(`new-${Date.now()}`);
                }
              }}
              showShortcuts
              triggerTitle="New (⌘N)"
              triggerVariant="header"
              triggerKbd="⌘N"
            />
          </div>
        </div>

        {/* SidebarControls removed: search is now the inline header input,
            view-mode + archived toggles live in the Topics ▾ menu, and ⌘K
            (CommandPalette) remains via setShowSearch / the keyboard shortcut. */}
        {/* topicsError ("Using cached data — server unreachable") moved to the
            bottom SidebarStatusBar — see <SidebarStatusBar dataNotice={…} />. */}

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
            onNewTopicInProject={appSettings.enableNewChat ? (projectPath) => handleQuickCreateTopic(projectPath) : undefined}
            onAddProjectPane={handleAddProjectPane}
            onProjectClick={handleProjectClick}
            stopSession={stopSession}
            onNewChat={appSettings.enableNewChat ? () => handleQuickCreateTopic() : undefined}
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
        <SidebarStatusBar wsStatus={wsStatus} dataNotice={topicsError} agentCounts={agentCounts} />
        </ErrorBoundary>
      </div>

      {/* Sidebar resize handle - hide on mobile. z-50 + wide grab band:
          adjacent pane content must not steal the grab (same lesson as the
          SplitTree dividers). The inner bands paint a visible affordance on
          hover so the resize is discoverable. */}
      {!isMobile && (
        <div
          className="group w-[1px] flex-shrink-0 cursor-col-resize relative bg-app-border transition-colors z-50"
          onMouseDown={handleSidebarResizeStart}
          onDoubleClick={handleSidebarDoubleClick}
        >
          <div className="absolute inset-y-0 -left-[5px] -right-[5px] group-hover:bg-primary/25" />
          <div className="absolute inset-y-0 -left-[1px] -right-[1px] group-hover:bg-primary" />
        </div>
      )}

      {/* Collapsed sidebar expand button - only when no panels are open (panels have inline button in their header) */}
      {sidebarCollapsed && openPanels.length === 0 && (
        <div
          className="absolute left-2 z-30 flex items-center gap-1"
          style={{ top: isMobile ? 'calc(0.5rem + env(safe-area-inset-top, 0px))' : '0.5rem' }}
        >
          <SidebarToggleButton onClick={toggleSidebar} title="Expand sidebar (⌘B)" className="bg-surface border border-app-border-light rounded-lg shadow-sm" />
        </div>
      )}

      {/* Window close button (top-right) - only in Electron and when no panels open */}
      {isElectron && openPanels.length === 0 && (
        <button
          onClick={() => {
            // Use native bridge if available (macOS app), fallback to window.close()
            const webkit = (window as Window & {
              webkit?: { messageHandlers?: { closeWindow?: { postMessage: (msg: unknown) => void } } };
            }).webkit;
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
      <div id="main-content" ref={mainContentRef} role="main" className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-app-bg"
        style={{
          contain: 'layout style',
          paddingTop: 'env(safe-area-inset-top, 0px)',
          // paddingLeft (the overlay-sidebar reserved column) is owned imperatively by
          // useSidebarFlipPush — NOT a React inline style — so the FLIP can read the
          // pre-commit position and animate the reveal as a compositor transform on the
          // inner flip layer below. overflow:hidden here clips the over-shifted layer at
          // the sidebar edge during the slide.
        }}
>

        {/* Connection status is now shown inline in the sidebar top line */}
        {/* FLIP layer: carries the translateX push reveal (useSidebarFlipPush). Must keep the
            flex column so PanelGrid sizes exactly as before. */}
        <div ref={contentFlipRef} className="content-flip-layer flex-1 flex flex-col min-h-0 min-w-0">
        <ErrorBoundary fallbackMessage="Panel error">
        <PanelGrid
          openPanels={openPanels}
          focusedPanelId={focusedPanelId}
          onFocusPanel={handleFocusPanel}
          onClosePanel={handleClosePanelDeferred}
          onClosePanelImmediate={handleClosePanelImmediate}
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
          onNewChatInProject={appSettings.enableNewChat ? (projectPath, groupId) => handleQuickCreateTopic(projectPath, groupId) : undefined}
          onNewChat={appSettings.enableNewChat ? () => handleQuickCreateTopic() : undefined}
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
        </div>{/* /content-flip-layer */}
      </div>

      {/* Portal dropdowns (rendered outside sidebar to escape overflow-hidden) */}
      {showTopicsMenu && createPortal(
        <div
          ref={topicsDropdownRef}
          className="glass-surface border border-app-border rounded-lg shadow-lg min-w-[200px]"
          style={{ position: 'fixed', top: topicsMenuPos.top, left: topicsMenuPos.left, zIndex: 9999 }}
        >
          {/* Sidebar controls relocated from the old <SidebarControls> row. */}
          <button
            onClick={() => { sidebar.toggleShowArchived(); }}
            className={`w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] hover:bg-app-hover transition-colors mt-1 ${sidebar.showArchived ? 'text-primary' : 'text-app-text'}`}
          >
            <Archive size={isMobile ? 18 : 14} className={sidebar.showArchived ? 'text-primary' : ''} />
            <span className="flex-1 text-left">Mostra archiviati</span>
          </button>
          <button
            onClick={() => { sidebar.toggleViewMode(); }}
            className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
          >
            {sidebar.viewMode === 'timeline'
              ? <LayoutGrid size={isMobile ? 18 : 14} />
              : <List size={isMobile ? 18 : 14} />}
            <span className="flex-1 text-left">{sidebar.viewMode === 'timeline' ? 'Vista a gruppi' : 'Vista timeline'}</span>
          </button>
          <button
            onClick={() => { setShowTopicsMenu(false); setExpandedTool('remote'); }}
            className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
          >
            <Radio size={isMobile ? 18 : 14} />
            <span className="flex-1 text-left">Remote Access</span>
          </button>
          {openclawAvailable && (
            <button
              onClick={() => { handleOpenAsPage('activity'); setShowTopicsMenu(false); setExpandedTool(null); }}
              className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
            >
              <Activity size={isMobile ? 18 : 14} />
              <span className="flex-1 text-left">Activity</span>
            </button>
          )}
          {openclawAvailable && (
            <button
              onClick={() => { handleOpenAsPage('agents'); setShowTopicsMenu(false); setExpandedTool(null); }}
              className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
            >
              <Cpu size={isMobile ? 18 : 14} />
              <span className="flex-1 text-left">Agents</span>
              {agentLiveCount > 0 && (
                <span className="ml-auto min-w-[16px] h-[16px] flex items-center justify-center bg-primary text-white text-[9px] font-bold rounded-full leading-none px-1">
                  {agentLiveCount}
                </span>
              )}
            </button>
          )}
          {TOPICS_MENU_PAGES
            .filter(({ id }) => id !== 'cron' || openclawAvailable)
            .map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                onClick={() => { handleOpenAsPage(id); setShowTopicsMenu(false); setExpandedTool(null); }}
                className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
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
          via <PaneAddMenu scope="standalone" presentation="palette" /> (⌘N),
          so the trigger button AND the centered palette are the canonical
          components — no third menu implementation. */}

      {expandedTool === 'remote' && topicsMenuRef.current && createPortal(
        <div
          ref={remoteAccessDropdownRef}
          className="glass-surface border border-app-border rounded-lg shadow-lg min-w-[300px]"
          style={{
            position: 'fixed',
            // Anchored to the Topics ▾ menu (its trigger is now the menu item),
            // opening at the same spot as the Topics dropdown.
            top: topicsMenuPos.top,
            left: topicsMenuPos.left,
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
            isElectron={isElectron}
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

      {/* Command Palette (⌘K = everything, ⌘F = projects scope). In Electron it
          renders in the overlay-host window (above the native browser); inline
          only on the web where there's no overlay API. */}
      {showSearch && !overlayHostAvailable && (
        <Suspense fallback={null}>
          <CommandPalette
            isOpen={showSearch}
            scope={searchScope}
            onClose={() => setShowSearch(false)}
            topics={topics}
            workspaceProjects={workspaceProjects}
            onOpenTopic={(id) => handleTopicClick(id)}
            onOpenProject={handleProjectClick}
            onNewTopic={handleQuickCreateTopic}
            enableNewChat={appSettings.enableNewChat}
            onNewProject={isElectron ? handleOpenProjectPicker : undefined}
            onNewClaude={() => handleQuickCreateTerminal('claude-code', claudeSkipPermissions)}
            onNewCodex={() => handleQuickCreateTerminal('codex')}
            onNewTerminal={() => handleQuickCreateTerminal('shell')}
            onToggleTheme={toggleTheme}
            onOpenSettings={() => { setShowSearch(false); setShowSettings(true); }}
            // "Reimposta pannelli al primo livello" — per-window CustomEvent bus
            // (same pattern as topics:open-project-picker); the FOCUSED surface's
            // listener (GroupLayout / PanelGrid) performs the flatten.
            onResetPanels={() => window.dispatchEvent(new CustomEvent('topics:reset-split-layout'))}
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
    </SplitPositionProvider>
    </TabNotificationProvider>
    </TopicsProvider>
  );
}

export default App;
