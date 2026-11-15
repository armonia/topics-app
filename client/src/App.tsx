import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, Suspense } from 'react';
import { useGlobalBoard } from './hooks/useGlobalBoard';
import { useWorktrees } from './hooks/useWorktrees';
import { useTaskTopicIndex } from './hooks/useTaskTopicIndex';
import { useMenuPreferences } from './hooks/useUserMenuHost';
import { SidebarToggleButton } from './components/Shared/SidebarToggleButton';
import { TooltipDelegate } from './components/Shared/TooltipDelegate';
import type { PaneType } from './types';
import { useTopics } from './hooks/useTopics';
import { useChat } from './hooks/useChat';
import { useWebSocket } from './hooks/useWebSocket';
import { noteCommandRunFrame } from './components/Chat/commandRunStore';
import { TabNotificationProvider } from './hooks/useTabNotifications';
import { useTheme } from './hooks/useTheme';
import { useClaudeSessionState } from './hooks/useClaudeSessionState';
import { TopicsProvider } from './contexts/TopicsContext';
import { useSplitLayoutAvailable } from './hooks/useSplitLayoutAvailable';
import { useClaudeSkipPermissions } from './hooks/useClaudePrefs';
import { useSidebarState } from './hooks/useSidebarState';
import { useSettingsSync } from './hooks/useSettingsSync';
import { useSidebarAndLayout } from './hooks/useSidebarAndLayout';
import { useFloatingVibrancy } from './hooks/useFloatingVibrancy';
import { useSidebarFitCoalesce } from './hooks/useSidebarFitCoalesce';
import { useSidebarFlipPush } from './hooks/useSidebarFlipPush';
import { useSidebarSwipe } from './hooks/useSidebarSwipe';
import { isDesktop } from './lib/shell';
import {
  CONTENT_CHROME_INSET_PX,
  CONTENT_CHROME_INSET_PROPERTY,
} from './lib/shell/windowControlsGeometry';
import { windowChrome } from './lib/shell/windowChrome';
import { useAnimationPause } from './hooks/useAnimationPause';
import { useTerminalLifecycle } from './hooks/useTerminalLifecycle';
import { usePanelLifecycle } from './hooks/usePanelLifecycle';
import { sendBlur } from './lib/focusMessaging';
import { useRefMirror } from './hooks/useRefMirror';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useBrowserContexts } from './hooks/useBrowserContexts';
import { useClosedTabs, isProjectPaneId, getProjectPathFromPaneId, newBrowserContextId } from './state/pane/adapters';
import { seedBrowserPaneInitialUrl } from './state/pane/browserPaneUrl';
import { isUtilityPanelType, utilityPanelId } from './state/pane/adapters/utilityPanelId';
import { AppInteractiveMark } from './lib/appInteractiveMark';
import { SpaceElsewherePanel } from './components/Layout/SpaceElsewherePanel';
import { SplitPositionProvider } from './contexts/SplitPositionContext';
import { ToastProvider } from './components/Shared/Toast';
import { ConfirmProvider } from './hooks/useConfirm';
import { CompletionNotifierBridge } from './hooks/useCompletionNotifier';
import { useVoiceLoop } from './hooks/useVoiceLoop';
import { rememberTerminals } from './state/pane/adapters/terminalMemory';
import { PendingActionProvider } from './contexts/PendingActionContext';
import { useSignalsSync } from './state/useSignalsSync';
import { useSeenFocusedPane } from './state/paneSeen';
import { useWaitingQueueStore } from './state/waitingQueue';
import { useTaskBrowserTabsSync } from './hooks/useTaskBrowserTabsSync';
import { lazyWarm } from './lib/lazyWarm';
import { loadPanelGrid } from './state/pane/panePreload';
import { RAISED_CONTROL, ROW_INSET, BAND_OWN_PROPERTY, SIDEBAR_SCROLL_TOP_PROPERTY } from './lib/selectionStyles';
import { normalizeTerminalAgent } from './lib/terminalAgents';
import { ErrorBoundary } from './components/Shared/ErrorBoundary';
import { SkeletonTopicList } from './components/Shared/Skeleton';
import { UnsentContext, useUnsentController } from './state/unsentMessages';
import { shortcut } from './lib/shortcutLabel';
import { useSidebarHandleInsets } from './hooks/useSidebarBottomInset';
import { TopicTree, PairingApproval, InAppBanners, PushEnrollPrompt } from './app/lazyHosts';
import { BootDeepLinkResolver } from './app/BootDeepLinkResolver';
import { useAppBootstrap, useShellGlobals } from './app/useAppBootstrap';
import { useAppEventBus } from './app/useAppEventBus';
import { useDeferredActions } from './app/useDeferredActions';
import { useSpaceGroups } from './app/useSpaceGroups';
import { useTopicsMenu } from './app/useTopicsMenu';
import { AppSidebar } from './app/AppSidebar';
import { TopicsMenuPortal } from './app/TopicsMenuPortal';
import { AppDialogs } from './app/AppDialogs';
import { FirstRunAndUpdates } from './app/FirstRunAndUpdates';

const PanelGrid = lazyWarm(loadPanelGrid, (m) => m.PanelGrid);

/** The voice loop board has no control and stays off (USERMENU-06: a
 *  preference with no door left `AppSettings`). */
const VOICE_LOOP_MODE = 'off' as const;

// BrowserSidebarControl replaced by useBrowserContexts hook + unified TopicTree

// The three PAGE entries of the «Topics ▾» dropdown (Board, «Statistics», «Cron
// Jobs») used to live here. They were the «+» menu under other names: opening
// a page IS opening a pane, and the «+» (⌘N) is the place that already has that
// job. Board showed up TWICE there, it already had `addableScopes:
// ['standalone']`, while Dashboard and Cron existed only there, with labels
// no other surface used. Now the three panes have `addableScopes` in
// PANE_CONFIG and open from a single place, with the name they carry in the tab
// and in the sidebar. The dropdown is what it really is: view state, layout
// actions, and the door to Settings.

// Phase 30 PANE-01: persistence for open panels is owned by the pane-store
// middleware. Component reads/writes happen via the panel-lifecycle hook
// (`usePanelLifecycle`); App-level helpers were inlined into that hook
// during the Commit 5 refactor.

/**
 * App, root component.
 *
 * Phase 3 refactor (commits on `refactor/app-hooks`) extracted four hooks:
 *  - useSidebarAndLayout   , layout chrome, sidebar resize, traffic lights.
 *  - useTerminalLifecycle  , terminal sessions + pure pruneStaleTerminalPanes
 *                             helper.
 *  - usePanelLifecycle     , full panel-state cluster: state, store-sync,
 *                             validation, draft persistence, six per-cluster
 *                             WS subscriptions, all panel handlers, electron
 *                             effects, drain-on-reconnect, detached auto-close.
 *  - useKeyboardShortcuts  , global keydown + open-all-boards listener with
 *                             ref-mirror pattern (CRITIQUE C2 fix).
 *
 * The sibling modules in `./app` hold the rest: mount-time bootstrap and shell
 * globals, the boot deep-link, the CustomEvent bus, the soft-destructive
 * actions, the group hand-offs, the title menu, the sidebar column and the
 * dialogs. App.tsx now owns: detached-mode detection, the modal useState
 * declarations (CRITIQUE C10), and the JSX tree of the main content.
 */
/** The panes that scroll under the button row instead of stopping at its edge. */
const BAND_OWNER_PANES: ReadonlySet<string> = new Set([utilityPanelId('board'), utilityPanelId('profile'), utilityPanelId('dashboard')]);

function App() {
  const DevOverlay = useAppBootstrap();

  // Check if we're in detached/pop-out mode (a real OS window hosting one or
  // more popped-out topics). `?topics=a,b,c` is the current contract; `?topic=`
  // (singular) stays as a back-compat alias. The window boots showing exactly
  // these topics and skips pane-store sync (see usePanelLifecycle isDetached).
  // The query string is fixed for a window's lifetime, so parse it ONCE. App
  // re-renders on every useChat state change (i.e. every WS/SSE chunk); computing
  // this in the render body re-parsed the URL and allocated a fresh array on each
  // one. It feeds a lazy useState initializer downstream (runs once), so a stable
  // reference costs nothing and drops the per-chunk churn.
  const detachedTopicIds = useMemo(() => {
    const urlParams = new URLSearchParams(window.location.search);
    return (urlParams.get('topics') ?? urlParams.get('topic'))
      ?.split(',')
      .map((t) => decodeURIComponent(t).trim())
      .filter(Boolean) ?? [];
  }, []);
  const detachedTopicId = detachedTopicIds[0] ?? null;
  const isDetached = detachedTopicIds.length > 0;

  // The boot deep-link lives in `<BootDeepLinkResolver>` (app/BootDeepLinkResolver),
  // mounted INSIDE `<ToastProvider>`. This is not a structural whim: the
  // rejection of a dead permalink must be told to the user, and `useToast()`
  // here would return the no-op, App RENDERS the provider, so there is no
  // context above it. `isDetached` travels as a prop.

  // The changelog opened from the phone menu: on the desktop it is reached from
  // the version number in the status bar, which under 768px no longer exists.
  const [showChangelogFromMenu, setShowChangelogFromMenu] = useState<string | null>(null);

  // Sidebar + layout chrome (Phase 3 hook 1)
  const layout = useSidebarAndLayout({ isDetached });
  const {
    appSettings,
    sidebarWidth,
    sidebarCollapsed,
    isMobile,
    viewportHeight,
    viewportTop,
    windowId,
  } = layout.state;
  // «A command appears where it has effect»: under 768px PanelGrid draws no
  // splits at all, so the commands that govern them are not shown.
  // The rule, and the measure that justifies it, lives in the hook, not here.
  const splitLayoutAvailable = useSplitLayoutAvailable();
  const { sidebarRef } = layout.refs;
  const {
    toggleSidebar,
    handleSidebarResizeStart,
    handleSidebarDoubleClick,
    setSidebarCollapsed,
    setAppSettings,
  } = layout.handlers;
  useShellGlobals(toggleSidebar);

  // Native per-region vibrancy (macOS desktop only, Electron + Tauri). Streams
  // panel rects to the transparent window so floating-splits gaps show the clear
  // desktop while each panel frosts; host-resolved internally, no-op off-mac/web.
  useFloatingVibrancy(appSettings.floatingSplits);
  // Sidebar reveal is ONE model on every non-mobile shell (Electron, Tauri, desktop web):
  // the sidebar is position:fixed and the content is FLIP-pushed (paddingLeft committed in
  // one reflow, then a compositor-only translateX slide), see useSidebarFlipPush. No
  // per-shell branch and no "overlay vs push" toggle: the FLIP is 60fps regardless of how
  // many terminals are live (it replaced the old in-flow width animation that relayed out
  // every .xterm each frame, ~25fps with 8). Mobile keeps its own full-width drawer below.
  const sidebarFixed = !isMobile;
  // SYNCHRONISED PUSH via FLIP (useSidebarFlipPush): the content reveal is a compositor-only
  // transform:translateX, NOT an animated paddingLeft. Animating paddingLeft (a layout prop)
  // relayouts every visible .xterm box each frame (~25fps with 8), which the old code dodged
  // by SNAPPING the pad under load (a feature-disable we removed). FLIP commits the final pad
  // in ONE reflow (terminals settle once) then slides a transform at 60fps regardless of N,
  // with nothing hidden/held. In FLOATING-SPLITS mode the expanded pad gets the same inter-card
  // gap (2×--float-gap = 4px) the floating sidebar card uses, matching the split-card gaps.
  const sidebarHandleInsets = useSidebarHandleInsets();

  const FLOAT_SIDEBAR_GAP = 4; // px, keep in sync with index.css --float-gap (2px) ×2
  const expandedPad = sidebarWidth + (appSettings.floatingSplits ? FLOAT_SIDEBAR_GAP : 0);
  // Refs for the FLIP: #main-content owns the committed paddingLeft (imperative, so the layout
  // effect can read the pre-commit position); the inner flip layer carries the translateX.
  const mainContentRef = useRef<HTMLDivElement | null>(null);
  const contentFlipRef = useRef<HTMLDivElement | null>(null);
  useSidebarFlipPush(mainContentRef, contentFlipRef, { collapsed: sidebarCollapsed, expandedPad, enabled: sidebarFixed });
  // THE ROOM FOR THE NATIVE LIGHTS, decided once. Only the Mac has native
  // lights, only a collapsed sidebar puts the content under them, and only
  // the desktop has a collapsible column (the phone's drawer is an overlay).
  // Carried as a custom property, not a padding: paddingLeft on #main-content
  // belongs to useSidebarFlipPush, which writes it imperatively.
  const contentChromeInset = windowChrome === 'mac' && sidebarCollapsed && !isMobile ? `${CONTENT_CHROME_INSET_PX}px` : '0px';
  // THE DRAWER FOLLOWS THE FINGER (mobile only): a real drag, not a threshold
  // read when the gesture is over. It all lives in `useSidebarSwipe` because it is
  // imperative code on `document`, what React, with its passive listeners,
  // cannot do.
  useSidebarSwipe({ enabled: isMobile, sidebarRef, collapsed: sidebarCollapsed, setCollapsed: setSidebarCollapsed });
  // Coalesce xterm fit() across the sidebar collapse/expand (held during the slide, one fit at
  // the settled size), driven off the SIDEBAR's own transform transition, untouched by FLIP.
  useSidebarFitCoalesce();
  // Stop the always-running loaders / awaiting-pulse breathers from burning the
  // compositor while the window is backgrounded (minimized / occluded / blurred).
  useAnimationPause();

  // Modals
  const [showSearch, setShowSearch] = useState(false);
  // ⌘K opens the palette in 'all' mode; ⌘F opens it pre-scoped to PROJECTS
  // (find/jump to a project). The scope is sticky for the open session of
  // the palette and reset by whichever shortcut/button opens it next.
  const [searchScope, setSearchScope] = useState<'all' | 'projects' | 'history'>('all');
  // `worktreeId` rides along from a sidebar worktree section ("New topic in
  // this worktree"): the dialog opens with that worktree already picked.
  const [showNewTopic, setShowNewTopic] = useState<false | { projectPath?: string; worktreeId?: string }>(false);
  // There is no Settings window: each form lives where it is used (SETHOME-01),
  // drawn by `HomePanelHost` below; the user menu keeps who you are and how the
  // app looks, and ⌘, opens it (`openUserMenu`).
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showFileSearch, setShowFileSearch] = useState<false | { projectPaths: string[]; mode: 'name' | 'content' }>(false);
  // The sidebar header "New" button used to track its dropdown via a
  // local `showNewMenu` boolean and a `newMenuBtnRef`. Both moved into
  // <PaneAddMenu> when we unified the three add-menu implementations
  // (top tab bar, sidebar project header, sidebar global header).
  // The yolo-toggle setter lived here while App owned the New menu; it
  // moved into <PaneAddMenu> when we unified, so we only need the
  // current value here for the spawn arg.
  const [claudeSkipPermissions] = useClaudeSkipPermissions();
  // There used to be a `useClaudeCodeModelSync()` here: at boot it re-read the
  // Claude Code model from localStorage and re-applied it to the server. It was
  // the saved default in the wrong place, per-DEVICE, so another browser saw
  // another default, and the re-application went through `registerProvider`,
  // which stops the provider and with it the live CLI processes. Now the default
  // model is a field of `app_settings` written by the provider card: the server
  // is the source, cross-device as a consequence, and no boot kills a chat in
  // progress any more.
  const sidebarContentRef = useRef<HTMLDivElement>(null);
  const topicsMenu = useTopicsMenu(isMobile, sidebarContentRef);

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
    ensureTopic,
    ensureArchivedTopics,
  } = useTopics();
  // Archive affordances can outlive the render that created them (for example a
  // pending-action commit). Read the current server-projected coordinator marker
  // at execution time rather than trusting a stale callback closure.
  const topicsRef = useRefMirror(topics);

  const {
    sendMessage,
    editMessage,
    regenerateMessage,
    deleteMessage,
    switchBranch,
    stopSession,
    getSessionMessages,
    getCompactionMarkers,
    addMessageFromWS,
    isSessionLoading,
    isSessionStreaming,
    wasSessionStopped,
    reconcileServerStreams,
    loadHistory,
    appendMediaToLastAssistant,
    clearSession,
    drainQueue,
    expiredMessages,
    retryExpired,
    dismissExpiredSession,
    onWSMessage: chatStreamHandler,
    error: chatError,
    gatewayConnected: _gatewayConnected,
    isOwnStream,
  } = useChat();


  const { status: wsStatus, sendWS, onMessage: onWSMessage, lastConnectedAt } = useWebSocket();

  // Live count of active (non-done) tasks across all projects, gates the
  // "General board" sidebar row and shows its badge.
  const { activeCount: boardTaskCount, byStatus: boardByStatus } = useGlobalBoard(onWSMessage);
  // Every worktree of the workspace, kept live over WS: the sidebar names a
  // bound topic's chip and a project's worktree sections from it.
  const { worktrees } = useWorktrees({ onMessage: onWSMessage });

  // topicId → task index for dispatched tasks, published to the per-topic
  // store (`state/taskSessions.ts`) that the chats read. The banners no longer
  // use it: the server decides who is announced (a board agent's topic never
  // is, its card is the subject).
  useTaskTopicIndex();

  // Task-owned browser fork → per-task tab store. Consumes the server's
  // `browser:open-task-tab` frame (feature-flagged) so an agent's browser lands
  // in its task's in-drawer group, never the global layout. App-level so it's
  // captured whichever drawer is open. See useTaskBrowserTabsSync.
  useTaskBrowserTabsSync(onWSMessage);

  // Voice loop board: announces a task reaching review out loud and, outside
  // `'off'` (what App passes, see VOICE_LOOP_MODE), listens for a spoken reply. No toast
  // context needed (unlike CompletionNotifierBridge below), so it's called
  // directly here instead of through a renderless bridge component. See
  // useVoiceLoop.ts.
  useVoiceLoop({ onWSMessage, mode: VOICE_LOOP_MODE });

  // Wire up chat stream handler to WebSocket (enables cross-window streaming)
  useEffect(() => {
    return onWSMessage(chatStreamHandler);
  }, [onWSMessage, chatStreamHandler]);

  // The runs of commands from the chat, under their code blocks (CHAT-RUN-03).
  useEffect(() => onWSMessage((msg) => noteCommandRunFrame(msg as Parameters<typeof noteCommandRunFrame>[0])), [onWSMessage]);

  // Terminal lifecycle (Phase 3 hook 2). Owns terminal sessions + grace
  // period ref + WS subscription. Exposes a pure pruneStaleTerminalPanes
  // helper used by the App-side cleanup effect below (CRITIQUE C5: NO
  // setOpenPanels crosses the seam).
  const terminals = useTerminalLifecycle({ wsStatus, lastConnectedAt, onWSMessage });
  const terminalSessions = terminals.sessions;
  // Every session seen, kept past its retirement: ⇧⌘T recreates it in its own
  // folder with its conversation (state/pane/adapters/terminalMemory.ts).
  useEffect(() => { rememberTerminals(terminalSessions); }, [terminalSessions]);

  // Phase 30 PANE-01: cross-device panels sync is owned by state/pane/middleware/syncWS.ts.
  // The middleware subscribes to the pane-store reducer's lastSeq and applies
  // `ui-state:init` / `ui-state:updated` frames with the Option-A envelope
  // (frame.data['pane-store-v2'] + frame.meta['pane-store-v2'].server_seq) with
  // an LWW guard. The store-subscription effect above mirrors those updates
  // back into React state, so there is no need for a WS listener here.

  const { themeMode, toggleTheme, setTheme } = useTheme(onWSMessage);

  const openShortcuts = useCallback(() => setShowShortcuts(true), []);
  const menuPreferences = useMenuPreferences({ settings: appSettings, setSettings: setAppSettings, themeMode, setTheme, onOpenShortcuts: openShortcuts });
  // Claude Code session tracker, subscribes to /api/claude-hooks-driven
  // `session:state` broadcasts. Feeds the unified signals store (useSignalsSync
  // below), which derives the per-topic "needs you" attention the notification
  // badge surfaces across the tab bar and the sidebar.
  const { sessions: claudeSessions } = useClaudeSessionState({ onWSMessage });
  // Feed the unified signals store from every raw input in one place
  // (Claude attention / live stream / hydrated mid-reply / server pty
  // activity). Consumers only read the facade (usePaneLoading / getBadgeCount).
  useSignalsSync({
    topics,
    claudeSessions,
    terminalSessions,
    isSessionStreaming,
    reconcileServerStreams,
    onWSMessage,
  });
  const { closedTabs, removeClosedTab } = useClosedTabs();

  // Sidebar state (view mode, expanded nodes, pinned "Pinned" items),
  // declared BEFORE usePanelLifecycle so the pin predicate can feed its
  // archive-on-close guards (ref-backed, stays a stable identity).
  const sidebar = useSidebarState(onWSMessage);

  // The archive is not in the boot list (1,535 of 1,554 topics on the
  // workspace this was measured on): the two surfaces that draw closed chats
  // ask for it the moment they open. Both calls are one request at most -
  // `ensureArchivedTopics` answers from memory once the archive is loaded.
  useEffect(() => {
    if (sidebar.showArchived) void ensureArchivedTopics();
  }, [sidebar.showArchived, ensureArchivedTopics]);
  useEffect(() => {
    if (showSearch) void ensureArchivedTopics();
  }, [showSearch, ensureArchivedTopics]);
  const isPinnedRef = useRefMirror(sidebar.isPinned);

  // READ direction of the preferences: `saveSettings` always did the PUT, but
  // nobody ever read back. Without this, a second device or the desktop shell's
  // WebView (its own storage) restart from the defaults with the right value
  // sitting on the server.
  useSettingsSync(onWSMessage);

  // Phase 3 hook 3, full panel-state cluster (state, store-sync,
  // validation, per-cluster WS subs, handlers). See usePanelLifecycle.ts
  // for the full effect-declaration-order contract.
  const panelLifecycle = usePanelLifecycle({
    isDetached, detachedTopicId, detachedTopicIds, isMobile,
    topics, topicsLoading, loadTopics, createTopic, applyTopicFromWS, archiveProject, archiveTopic, ensureTopic,
    workspaceProjects,
    terminalSessions,
    pruneStaleTerminalPanes: terminals.pruneStaleTerminalPanes,
    terminalOps: terminals.ops,
    isPinnedRef,
    onWSMessage, sendWS, windowId,
    chatStreamHandlers: {
      isOwnStream, isSessionStreaming, getSessionMessages, addMessageFromWS, clearSession,
      loadHistory, appendMediaToLastAssistant, sendMessage, drainQueue,
    },
    setSidebarCollapsed,
    removeClosedTab, closedTabs,
  });
  const {
    openPanels, visiblePanels, activeSpaceId,
    focusedPanelId, previewPanelId, nextPanelMode, draftMeta,
    pendingProjectFocus, projectActiveTopics, projectOpenPanes,
    pendingProjectPane, panelInitialTab, contextMenu, expandedProjects,
    pendingBrowserPane, pendingSoloPanelId,
  } = panelLifecycle.state;
  const { focusedProjectPath } = panelLifecycle.derived;
  // ONE seen event per pane: the window's focused pane, whatever input put it
  // there (tab, a click inside, keyboard, palette, sidebar row), after the
  // dwell, clears every mark of it on every surface.
  useSeenFocusedPane(focusedPanelId);
  const {
    handleTopicClick, handleTopicDoubleClick, handleClosePanel,
    handleProjectClick, handleFocusPanel, handleReorderPanels,
    handleOpenPanelAt, handleOpenAsProject, handleAddProjectPane,
    handleArchiveProject, handleTopicContextMenu,
    handleQuickCreateTopic, handleCreateTopic, promoteDraft,
    handleQuickCreateTerminal, handleCloseTerminal, handleTerminalClick,
    handleOpenAsPage, handleReopenClosedTab,
    handleProjectActiveTopicChange, handleProjectOpenPanesChange,
    handlePendingBrowserPaneConsumed, handlePendingSoloConsumed,
    openBrowserPane,
    setNextPanelMode, setExpandedProjects, setContextMenu,
    setPendingProjectFocus, setPendingProjectPane, setPanelInitialTab,
  } = panelLifecycle.handlers;

  const { paneSpaceById, goToSpace, activeSpaceWindow, spaceScoped } = useSpaceGroups(openPanels, activeSpaceId);

  // ONE OPENER, so a history row answers the same click whether it fires from
  // the palette or from the user card's quick history dropdown: both host the
  // same list (`buildHistoryRows`), and a second hand-written copy of "how a
  // page reopens" is exactly the kind of pair that drifts apart.
  const openHistoryUrl = useCallback((url: string) => {
    const contextId = newBrowserContextId();
    seedBrowserPaneInitialUrl(`browser:${contextId}`, url);
    openBrowserPane(contextId);
  }, [openBrowserPane]);

  /**
   * «Create this thing in the standalone context». ONE, and both the ⌘N palette
   * and the ⌘K pills take it: before, ⌘K had its own separate callbacks
   * (onNewClaude/onNewCodex/onNewTerminal) and in fact offered a DIFFERENT set
   *, no opencode, no Browser, no Board.
   */
  /**
   * The search perimeter: the FOCUSED project first, then the others open as
   * tabs. Same rule as ⌘F/⌘P in `useKeyboardShortcuts`, here it serves the
   * «Search in files» entry of the ⌘K palette, which must open the same thing
   * the key opens, not a narrowed version.
   */
  const searchProjectPaths = useMemo(() => {
    const open = openPanels
      .filter((id) => isProjectPaneId(id))
      .map((id) => getProjectPathFromPaneId(id))
      .filter(Boolean) as string[];
    const ordered = [...new Set([...(focusedProjectPath ? [focusedProjectPath] : []), ...open])];
    if (ordered.length > 0) return ordered;
    return [...new Set(Object.values(topics).map((t) => t.projectPath).filter(Boolean))] as string[];
  }, [focusedProjectPath, openPanels, topics]);

  const handleStandaloneAddPane = useCallback((type: PaneType, subType?: string) => {
    if (type === 'terminal') {
      handleQuickCreateTerminal(normalizeTerminalAgent(subType), claudeSkipPermissions);
    } else if (type === 'browser') {
      openBrowserPane(newBrowserContextId());
    } else if (isUtilityPanelType(type)) {
      // The UTILITY panes: fixed id (`__board__`, `__dashboard__`, `__cron__`,
      // `__profile__`) and therefore not `createPaneId`, which would draw a
      // new one at every opening, the second tab of the same page.
      // `handleOpenAsPage` is the only door that knows that shape.
      //
      // The predicate comes from the canonical SET (`UTILITY_PANEL_TYPES`) and not
      // from three hand-written `===`, which is how it stood and how it already
      // broke twice: the branch listed `board` alone until Dashboard and Cron
      // arrived from the «Topics ▾» dropdown, and their rows in the «+»
      // appeared doing NOTHING. Profile would have been the third time.
      handleOpenAsPage(type);
    }
  }, [handleQuickCreateTerminal, claudeSkipPermissions, openBrowserPane, handleOpenAsPage]);

  // THE BOARD OPENS FROM ONE PLACE. The sidebar row and the door at the foot
  // of the phone call THIS function: two copies of the same gesture (first
  // bring the window where its tab is, then open) diverge at the first
  // touch-up, and the first thing lost is `goToSpace`, i.e. the board would
  // open in a group you are not looking at.
  const handleOpenBoard = useCallback(() => {
    const boardSpace = paneSpaceById.get('__board__');
    if (boardSpace) goToSpace(boardSpace);
    handleOpenAsPage('board');
  }, [paneSpaceById, goToSpace, handleOpenAsPage]);

  const { handleOpenProjectPicker } = useAppEventBus({
    handleProjectClick, handleTerminalClick, handleTopicClick, handleQuickCreateTopic,
    handleQuickCreateTerminal, handleOpenBoard, claudeSkipPermissions, topicsRef,
  });

  // The palette's two callbacks that feed its effects and memos: as inline
  // arrows they changed on every App render (every topic:updated), and the
  // palette sent its message search again and rebuilt its topic rows each time.
  // `handleTopicClick` itself changes with `topics`, hence the ref.
  const handleTopicClickRef = useRef(handleTopicClick);
  useLayoutEffect(() => { handleTopicClickRef.current = handleTopicClick; });
  const openTopicFromSearch = useCallback((id: string) => handleTopicClickRef.current(id), []);
  const closePalette = useCallback(() => setShowSearch(false), []);

  // Browser-context state (App-level, sidebar UI consumers). `sidebar`
  // (useSidebarState) is declared above, before usePanelLifecycle.
  const browserCtx = useBrowserContexts(true, onWSMessage);

  const {
    handleClosePanelImmediate, handleClosePanelDeferred,
    handleArchiveTopicDeferred, handleArchiveProjectDeferred,
    unpinAlsoArchives, handleTogglePin,
    handleCloseTerminalDeferred, handleCloseBrowserDeferred,
  } = useDeferredActions({
    topics, topicsRef, focusedPanelId, visiblePanels, openPanels, projectOpenPanes,
    handleClosePanel, handleFocusPanel, handleArchiveProject, handleCloseTerminal,
    archiveTopic, browserCtx,
    sidebarIsPinned: sidebar.isPinned, sidebarTogglePin: sidebar.togglePin,
  });

  // Keyboard shortcuts (Phase 3 hook 4, ref-mirror pattern fixes
  // CRITIQUE C2 listener churn). Snapshot args mirrored into refs
  // inside the hook so the keydown listener registers ONCE on mount.
  useKeyboardShortcuts({
    focusedPanelId,
    // Spaces: ⌘1-9 / ⌘W and the tab-cycling chords target what the user can
    // SEE, the visible subset, not the full cross-space set.
    openPanels: visiblePanels,
    projectOpenPanes,
    topics,
    focusedProjectPath,
    showSearch,
    showNewTopic,
    showShortcuts,
    showFileSearch,
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
    isSessionStreaming,
    stopSession,
  });

  // THE SWITCH OF THE BOTTOM ROW, board ⇄ list.
  //
  // «In front» means two things together: the board is the focused pane AND
  // the drawer is closed. Looking only at the focus would make the button read «Tab»
  // while the list is already on screen, i.e. the button would say to take you where
  // you are, and the next click would have nothing to do.
  const boardInFront = isMobile && sidebarCollapsed && focusedPanelId === '__board__';
  // Does the focused screen spend the button row's band itself? The utility
  // panes with a scrolling list, and a chat: its transcript already reserves the
  // composer's height as a trailing spacer, and the band goes into the composer
  // block as one more box at its foot (ChatPane), so the transcript reaches the
  // glass and the composer stays whole above the row. A project window does not:
  // its active pane can be a terminal, which has no spacer to give. The others
  // stay as they were, with the band reserved by the root.
  const bandOwned = isMobile && !!focusedPanelId && (BAND_OWNER_PANES.has(focusedPanelId) || !!topics[focusedPanelId]);
  const handleMobileBoardToggle = useCallback(() => {
    if (boardInFront) setSidebarCollapsed(false);
    else { handleOpenBoard(); setSidebarCollapsed(true); }
  }, [boardInFront, handleOpenBoard, setSidebarCollapsed]);
  // The ⌘J door's number: the queue the sidebar publishes (CHAT-WAIT-04).
  const waitingCount = useWaitingQueueStore((s) => s.queue.length);

  // THE FOCUS THAT LEAVES A CHAT MUST REACH THE SERVER, not only the one that
  // enters it.
  //
  // `sendFocusTopic` fires when a chat BECOMES active (ChatPanel, ChatPane), and
  // `sendBlur` lived in exactly one place: inside a project, when the active
  // pane is not a chat (`ProjectWindow`). At app level that twin was missing, so
  // moving from a chat to a top-level NON-chat pane, the board, a terminal, a
  // browser, sent nothing, and for the server the last chat looked at was still
  // the one in front.
  //
  // This is not cosmetic. After `SEEN_DWELL_MS` that chat entered `seenTopicRef`,
  // and from there every unread about it was RE-MARKED READ on the spot (the
  // old "a message arrived while you were already reading" branch of
  // `useWebSocket`). Measured with two chats open and focus moved to the board: the
  // first chat never raises the badge (delta 0), the second does (delta 1). So a
  // turn finishing on a chat you are not watching can leave no trace on the
  // dock, and WHICH chat loses the count depends on which tab was opened first.
  //
  // It is also what turned MUTE-01 red on the full run: the test sends two
  // unreads and sees one arrive, "expected 5, received 4".
  //
  // The condition is the same one `ProjectWindow` uses: active pane is not a chat
  // => blur. Project panes stay with the inner handler, which knows which chat is
  // active INSIDE the project and sends its focus.
  const focusedIsChat = !!focusedPanelId && !!topics[focusedPanelId];
  useEffect(() => {
    if (focusedPanelId && !focusedIsChat && !focusedProjectPath) sendBlur(sendWS);
  }, [focusedPanelId, focusedIsChat, focusedProjectPath, sendWS]);

  // The unsent queue, for every chat (each shows its own above its composer)
  // and for the band that lists the chats not on screen. Provided here and not
  // in the grid, because on the phone the band lives outside it. On the phone
  // an open drawer covers the whole grid: nothing in it counts as seen.
  const unsent = useUnsentController(expiredMessages, retryExpired, dismissExpiredSession, isMobile && !sidebarCollapsed);

  return (
    <TopicsProvider topics={topics} terminalSessions={terminalSessions} terminalRosterAuthoritative={terminals.rosterAuthoritative} workspaceProjects={workspaceProjects} topicsPending={topicsLoading && Object.keys(topics).length === 0}>
    <UnsentContext.Provider value={unsent}>
    <TabNotificationProvider>
    <SplitPositionProvider>
    <ToastProvider>
    <ConfirmProvider>
    {/* THE APP'S TOOLTIP, for the WHOLE app. A single delegate that intercepts
        every existing `title=` (there were 422) and renders it with the design
        component instead of the operating system rectangle: same colours,
        more lines, and above all it appears in 350 ms instead of after the
        system delay, which on macOS exceeds a second. The attribute is
        PUT BACK on exit, so screen readers keep finding it where they look
        for it. See `Shared/TooltipDelegate.tsx`. */}
    <TooltipDelegate />
    {/* Mark the end of the first topic load, when the sidebar shows real data.
        Not gated on a topic count: a first-run profile has none and must still be measured. */}
    <AppInteractiveMark ready={!topicsLoading} />
    {/* The boot deep-link (`/tab/…`, `/task/…`, `/topic/…`). It sits HERE inside,
        and not in an App effect, because the rejection of a dead permalink must
        reach the user as a toast, and `useToast()` above `<ToastProvider>`
        (i.e. inside App) returns the no-op. It renders nothing. */}
    <BootDeepLinkResolver isDetached={isDetached} />
    {/* Surfaces a toast (and optional sound) when an agent completes or
        errors on any topic. Reads settings live so the master toggle in
        Settings → Notifications takes effect without a reload. Native
        desktop notifications are dispatched independently from
        electron-app/main.ts, see notifyAgentCompleted there. */}
    <CompletionNotifierBridge onWSMessage={onWSMessage} settings={appSettings} />
    {/*
      countdownMs=1500: soft-destructive close window. 3s was the original
      conservative default; 1.5s still leaves an obvious "click again to
      cancel" margin (the progress overlay reaches ~half-fill before
      commit) but stops feeling laggy. The animation now runs faster
      across every tab, chat, terminal, browser, project, through the
      same context.
    */}
    <PendingActionProvider countdownMs={1500}>
    <Suspense fallback={null}>
      <PairingApproval />
      <InAppBanners />
      <PushEnrollPrompt />
    </Suspense>
      <div
      // NB: the landing demo (client/src/demo/landing-cursor.js, scene
      // "floating") toggles `.floating-splits` on THIS element from outside
      // React, to show the mode on the marketing site. That works only because
      // on web `isDesktop` is false, so this template string is constant
      // between renders and React never rewrites the attribute. Add anything
      // dynamic here and the demo chapter goes quietly dead, nothing breaks,
      // it just stops showing what it claims to show.
      className={`flex bg-app-bg overflow-hidden max-w-[100vw] ${appSettings.floatingSplits && isDesktop ? 'floating-splits' : ''}`}
      style={{
        fontSize: `${appSettings.fontSize}px`,
        // The chat's reading measure travels as a variable, not as a
        // class: the class above MUST stay constant between renders (the
        // comment says so), and a variable in `style` does not touch it. It is read
        // by the `chat-measure` utility, one place for four points that
        // must stay aligned.
        '--chat-measure': appSettings.chatMaxWidth > 0 ? `${appSettings.chatMaxWidth}px` : 'none',
        // THE BAND OF THE BOTTOM ROW, reserved ONCE for everyone.
        // The height is published by the bar itself (`--mobile-chrome-h`, see
        // MobileChromeBar): here it is only read. It is 0px when the bar is
        // not there, desktop, or keyboard open, so there is no branch, and
        // nothing changes off the phone. Without this line the row
        // would cover the chat's last message and the composer.
        //
        // The screens that can spend it themselves (`BAND_OWNER_PANES` and a
        // chat, see `bandOwned`) get
        // it back: the root keeps none of it and publishes it as
        // `--mobile-band-own-h`, so their list scrolls under the buttons
        // instead of stopping at their edge. The same goes for the notice
        // band (`--mobile-transport-h`, «Claude usage»): its ground is
        // translucent and blurred, not solid, so what scrolls passes behind
        // it as it does behind the buttons (01/10).
        paddingBottom: bandOwned ? 0 : 'calc(var(--mobile-chrome-h, 0px) + var(--mobile-transport-h, 0px))',
        [BAND_OWN_PROPERTY]: bandOwned ? 'calc(var(--mobile-chrome-h, 0px) + var(--mobile-transport-h, 0px))' : '0px',
        position: 'fixed',
        top: viewportHeight != null ? `${viewportTop}px` : 0, left: 0, right: 0,
        bottom: viewportHeight != null ? undefined : 0,
        height: viewportHeight != null ? `${viewportHeight}px` : undefined,
      } as React.CSSProperties}
    >
      {/* Skip to main content link for keyboard users */}
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:bg-primary focus:text-white focus:px-4 focus:py-2 focus:rounded-lg focus:text-body-lg focus:leading-5">
        Skip to main content
      </a>
      {/* THE SCRIM of the mobile drawer. It is ALWAYS mounted (on mobile) and at
          rest CSS turns it off, `.sidebar-scrim[data-open="false"]` is opacity 0,
          `visibility: hidden` and no click. Before, it was mounted and unmounted
          with the state: during the column drag (useSidebarSwipe) it did not
          exist yet, and appeared all at once when the gesture ended, i.e.
          the jolt that the drag exists to remove. Now the gesture
          writes its opacity inline frame by frame, and at the end of the run it
          clears it, handing the decision back to CSS. */}
      {isMobile && (
        <div
          data-sidebar-scrim
          data-open={!sidebarCollapsed}
          className="fixed inset-0 bg-black/50 z-40 sidebar-scrim"
          onClick={() => setSidebarCollapsed(true)}
          aria-hidden="true"
        />
      )}

      <AppSidebar
        sidebarRef={sidebarRef}
        sidebarContentRef={sidebarContentRef}
        isMobile={isMobile}
        sidebarCollapsed={sidebarCollapsed}
        sidebarWidth={sidebarWidth}
        floatingSplits={appSettings.floatingSplits}
        viewportHeight={viewportHeight}
        topicsMenu={topicsMenu}
        wsStatus={wsStatus}
        topicsError={topicsError}
        onWSMessage={onWSMessage}
        sidebar={sidebar}
        menuPreferences={menuPreferences}
        splitLayoutAvailable={splitLayoutAvailable}
        setSearchScope={setSearchScope}
        setShowSearch={setShowSearch}
        setShowChangelogFromMenu={setShowChangelogFromMenu}
        handleReopenClosedTab={handleReopenClosedTab}
        openHistoryUrl={openHistoryUrl}
        handleQuickCreateTopic={handleQuickCreateTopic}
        handleStandaloneAddPane={handleStandaloneAddPane}
        boardInFront={boardInFront}
        handleMobileBoardToggle={handleMobileBoardToggle}
        waitingCount={waitingCount}
      >
          {/* THE GROUPS are cards inside the tree (TopicTree): each one holds
              its own tabs and opens and closes by itself. There is no
              separate place where the groups «live». */}
          <ErrorBoundary fallbackMessageKey="crash.sidebar">
          {topicsLoading && Object.keys(topics).length === 0 ? (
            <div className="overflow-y-auto sidebar-scroll" style={{ paddingTop: `var(${SIDEBAR_SCROLL_TOP_PROPERTY}, 0px)` }}><SkeletonTopicList count={5} /></div>
          ) : (
          // `openPanels={openPanels}`: ALL the open tabs, not only those of the
          // active group, because the sidebar shows ALL the groups together, and
          // each row goes in the card of its own (`paneSpaceById`). It is the grid
          // that stays filtered on the active group: there, one thing at a time.
          <Suspense fallback={<div className="overflow-y-auto sidebar-scroll" style={{ paddingTop: `var(${SIDEBAR_SCROLL_TOP_PROPERTY}, 0px)` }}><SkeletonTopicList count={5} /></div>}>
          <TopicTree
            topics={topics}
            workspaceProjects={workspaceProjects}
            searchQuery=""
            expandedNodes={sidebar.expandedNodes}
            onToggleNode={sidebar.toggleNode}
            focusedTopicId={focusedPanelId}
            projectActiveTopics={projectActiveTopics}
            previewPanelId={previewPanelId}
            openPanels={spaceScoped ? openPanels : visiblePanels}
            onTopicClick={handleTopicClick}
            onTopicDoubleClick={handleTopicDoubleClick}
            onTopicContextMenu={handleTopicContextMenu}
            onArchiveTopic={handleArchiveTopicDeferred}
            onArchiveProject={handleArchiveProjectDeferred}
            onNewTopicInProject={(projectPath) => handleQuickCreateTopic(projectPath)}
            worktrees={worktrees}
            onNewTopicInWorktree={(projectPath, worktreeId) => setShowNewTopic({ projectPath, worktreeId })}
            onAddProjectPane={handleAddProjectPane}
            onProjectClick={handleProjectClick}
            stopSession={stopSession}
            onNewChat={() => handleQuickCreateTopic()}
            onNewBrowser={() => openBrowserPane(newBrowserContextId())}
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
            pinnedItems={sidebar.pinnedItems}
            onTogglePin={handleTogglePin}
            pinnedLayout={sidebar.pinnedLayout}
            onPinnedLayoutChange={sidebar.setPinnedLayout}
            onPinAt={sidebar.pinAt}
            // The bare pin: «put it back in the list» archives nothing.
            onUnpinToList={sidebar.togglePin}
            onSnapshotPinned={sidebar.snapshotPinned}
            onRestorePinned={sidebar.restorePinned}
            boardTaskCount={boardTaskCount}
            boardByStatus={boardByStatus}
            boardOpen={openPanels.includes('__board__')}
            automationsOpen={openPanels.includes('__automations__')}
            agentsOpen={openPanels.includes('__agents__')}
            // Preference, not signal: it goes through here (and not through a
            // `loadSettings()` inside the tree) because it must make the sidebar
            // REDRAW when the switch is changed, `appSettings` is already the
            // state that updates both from the server and from the other tabs.
            showBoardRow={appSettings.showBoardRow}
            // The board stays fixed at the top of the sidebar, above the pinned
            // and above every group, but its TAB lives in a group like all the
            // others. If it is in another one, the window goes there first:
            // opening it alone would make it appear where you are not looking.
            onOpenBoard={handleOpenBoard}
            spaceScoped={spaceScoped}
            paneSpaceById={paneSpaceById}
          />
          </Suspense>
          )}
          </ErrorBoundary>
      </AppSidebar>

      {/* Sidebar resize handle. The sidebar is position:fixed (FLIP push), so a
          flex divider here would collapse to x=0 under the sidebar's LEFT edge,
          nothing to grab at the real sidebar/content boundary (the bug: "resizing
          does not work"). The handle must therefore be fixed at the sidebar's RIGHT
          edge (left = sidebarWidth). Grab band biased INTO the sidebar: native
          WKWebView panes trail the sidebar flush on the content side and would
          eat any hover/click past the edge. z-50 + wide band: same lesson as
          the SplitTree dividers. Hidden while collapsed, the edge is gone. */}
      {/* AND IT STOPS WHERE THE SIDEBAR HAS SOMETHING TO CLICK. The band is
          biased 8px INTO the sidebar (see above) and used to run the full
          height, so at the bottom it sat on top of the identity block, whose
          rightmost controls end exactly under it. Measured 2026-08-26:
          `org-chip` (the organisation chip, x 241-249) could not be clicked at
          all, on macOS as much as elsewhere, with Playwright naming the
          culprit, "`div.cursor-col-resize` intercepts pointer events". Nothing
          had caught it because no test ever clicked that chip.
          The end is asked of the DOM (`identity-block`) and not written as a
          number: a fixed inset would be right today and wrong the first time a
          line is added down there, and it would be wrong in silence. */}
      {!isMobile && !sidebarCollapsed && (
        <div
          className="group fixed z-50 cursor-col-resize"
          style={{ left: sidebarWidth - 8, width: 10, top: sidebarHandleInsets.top, bottom: sidebarHandleInsets.bottom }}
          onMouseDown={handleSidebarResizeStart}
          onDoubleClick={handleSidebarDoubleClick}
        >
          {/* No resting visuals, the sidebar's own shadow separates it from the
              content (a visible edge line was rejected as "not right"). The handle
              paints only on hover. */}
          <div className="absolute inset-0 group-hover:bg-primary/25" />
          <div className="absolute inset-y-0 right-[1px] w-[3px] group-hover:bg-primary" />
        </div>
      )}

      {/* Collapsed sidebar expand button - only when no panels are open (panels have inline button in their header) */}
      {sidebarCollapsed && visiblePanels.length === 0 && (
        <div
          // `left` is 0.5rem PLUS the room the lights take: with no pane open
          // this is the only element in the content's top-left corner, and the
          // collapsed sidebar leaves it under the native lights. It rides the
          // same variable and the same 200ms as the chrome row, so it never
          // crosses the cluster during the slide either. The variable is set
          // HERE as well as on #main-content: this wrapper is a sibling of the
          // content, not a child, so it inherits nothing from it. Measured
          // before this line existed: left stayed at 8 with the sidebar away.
          className="content-chrome-inset absolute z-30 flex items-center gap-1"
          style={{
            [CONTENT_CHROME_INSET_PROPERTY as string]: contentChromeInset,
            left: `calc(0.5rem + var(${CONTENT_CHROME_INSET_PROPERTY}, 0px))`,
            top: isMobile ? 'calc(0.5rem + env(safe-area-inset-top, 0px))' : '0.5rem',
          }}
        >
          {/* `RAISED_CONTROL` + `edge-lit`: the SAME button as the «+» and the
              search, which is the parity asked for («at this point make the
              sidebar-opening key the same»). It was `bg-surface` + a border,
              and `--bg-surface` under 768px COLLAPSES onto the chrome (index.css):
              the only way to reopen the column when no pane is open
              vanished into the background precisely on the phone. */}
          <SidebarToggleButton onClick={toggleSidebar} title={`Expand sidebar (${shortcut('B')})`} size="action" className={`edge-lit ${RAISED_CONTROL} rounded-lg shadow-sm`} />
        </div>
      )}

      {/* Main Content */}
      {/* `bg-app-chrome`, not `bg-app-bg`, and the colour of the CONTENT goes down onto the
          child below. The reason is the safe-area `paddingTop`: the
          padding is painted by the background of THIS element, so the band
          under the notch came out in the colour of the PAGE while the sidebar, which
          paints the same band by itself, came out in the colour of the CHROME. Two
          tints for the same strip, depending on whether the drawer was open
          or closed. Now the strip is always chrome: it is the edge of the app, and
          the edge of the app is chrome. */}
      <div id="main-content" ref={mainContentRef} role="main" className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-app-chrome"
        style={{
          contain: 'layout style',
          paddingTop: 'env(safe-area-inset-top, 0px)',
          // The room for the lights (`contentChromeInset`, above), consumed two
          // levels down by the chrome row that owns the sidebar toggle
          // (StandaloneChatGroup) as its own padding-left, on the slide's clock.
          [CONTENT_CHROME_INSET_PROPERTY as string]: contentChromeInset,
          // NOT THE BOTTOM, and it is a correction: the first version also put
          // the safe-area here, i.e. it RAISED THE WHOLE CONTENT, «you should not have
          // raised the whole app but only the input, now the chat is cut off in the
          // safe area below». True: the conversation lost 34px of useful
          // height and a dead strip remained below.
          //
          // The top and the bottom are not symmetric, and the difference is what
          // sits against them.
          // At the top sits the iOS status bar, OPAQUE (`black`, see index.html):
          // in a standalone PWA the viewport starts below it and this inset is 0;
          // where it is not (a notch in landscape, a browser tab) the main column
          // starts below the inset, on a strip of the same chrome, because the
          // tab row (`--chrome-bar-h`, read by every pane) is up there.
          // At the bottom there is the home indicator, a dash on a TRANSPARENT
          // ground: the content may scroll under it, it only must not end up
          // with something to TOUCH under it. So the push is taken by the composer
          // alone, see ChatInput, which computes it by itself.
          // paddingLeft (the overlay-sidebar reserved column) is owned imperatively by
          // useSidebarFlipPush, NOT a React inline style, so the FLIP can read the
          // pre-commit position and animate the reveal as a compositor transform on the
          // inner flip layer below. overflow:hidden here clips the over-shifted layer at
          // the sidebar edge during the slide.
        }}
>

        {/* Connection status is now shown inline in the sidebar top line */}
        {/* FLIP layer: carries the translateX push reveal (useSidebarFlipPush). Must keep the
            flex column so PanelGrid sizes exactly as before. */}
        <div ref={contentFlipRef} className="content-flip-layer flex-1 flex flex-col min-h-0 min-w-0 bg-app-bg">
        <ErrorBoundary fallbackMessageKey="crash.panel">
        {/* Spaces: the grid gets the VISIBLE subset (openPanels stays the full
            store-backed set, see usePanelLifecycle.visiblePanels) and
            remounts per space (key) so per-space grid layouts stay isolated:
            PanelGrid prunes soloCells/gridRows against its openPanels prop,
            and a filtered set against a SHARED layout would erase the other
            spaces' geometry on every switch. */}
        {/* The group's frame (`.space-frame`, index.css): the same card that
            the sidebar draws around the tabs, here around the work. It is there
            only when groups exist; keyed on activeSpaceId like the grid, so
            changing group replays the entrance. */}
        <div key={activeSpaceId} className={`flex-1 flex flex-col min-h-0 min-w-0 ${spaceScoped ? 'space-frame' : ''}`}>
        {activeSpaceWindow ? (
          <SpaceElsewherePanel spaceId={activeSpaceId} windowLabel={activeSpaceWindow} />
        ) : (
        <Suspense fallback={<div className="flex-1 min-h-0 min-w-0" aria-busy="true" />}>
        <PanelGrid
          openPanels={visiblePanels}
          focusedPanelId={focusedPanelId}
          onFocusPanel={handleFocusPanel}
          onClosePanel={handleClosePanelDeferred}
          onClosePanelImmediate={handleClosePanelImmediate}
          onToggleFissato={handleTogglePin}
          isFissato={sidebar.isPinned}
          onReorderPanels={handleReorderPanels}
          onOpenPanelAt={handleOpenPanelAt}
          nextPanelMode={nextPanelMode}
          onPanelModeUsed={() => setNextPanelMode('side')}
          getSessionMessages={getSessionMessages}
          getCompactionMarkers={getCompactionMarkers}
          isSessionLoading={isSessionLoading}
          isSessionStreaming={isSessionStreaming}
          wasSessionStopped={wasSessionStopped}
          stopSession={stopSession}
          sendMessage={sendMessage}
          editMessage={editMessage}
          regenerateMessage={regenerateMessage}
          deleteMessage={deleteMessage}
          switchBranch={switchBranch}
          loadHistory={loadHistory}
          chatError={chatError}
          sendWS={sendWS}
          onWSMessage={onWSMessage}
          onUpdateTopic={updateTopic}
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
        </Suspense>
        )}
        </div>{/* /space-frame */}
        </ErrorBoundary>
        </div>{/* /content-flip-layer */}
        {/* The version banner's second slot, for a collapsed sidebar (whose own
            slot is slid off screen). IN FLOW, under the panes: the banner takes
            a row of its own and the panes give it the height, instead of a
            floating card over the composer's send and voice buttons (measured
            2026-09-29, 1280x800: the corner card covered both). The bottom pad
            keeps it off the home indicator on a phone. */}
        <div data-update-slot-main className="flex flex-shrink-0 justify-end empty:hidden"
          style={{ paddingInline: ROW_INSET, paddingTop: ROW_INSET, paddingBottom: `max(${ROW_INSET}px, env(safe-area-inset-bottom, 0px))` }} />
      </div>

      <TopicsMenuPortal
        isMobile={isMobile}
        topicsMenu={topicsMenu}
        sidebar={sidebar}
        menuPreferences={menuPreferences}
        splitLayoutAvailable={splitLayoutAvailable}
        setSearchScope={setSearchScope}
        setShowSearch={setShowSearch}
        setShowChangelogFromMenu={setShowChangelogFromMenu}
        handleReopenClosedTab={handleReopenClosedTab}
        openHistoryUrl={openHistoryUrl}
      />

      <AppDialogs
        contextMenu={contextMenu}
        setContextMenu={setContextMenu}
        updateTopic={updateTopic}
        archiveTopic={archiveTopic}
        pinnedIds={sidebar.pinnedIds}
        unpinAlsoArchives={unpinAlsoArchives}
        handleTogglePin={handleTogglePin}
        handleClosePanel={handleClosePanel}
        stopSession={stopSession}
        showNewTopic={showNewTopic}
        setShowNewTopic={setShowNewTopic}
        handleCreateTopic={handleCreateTopic}
        onWSMessage={onWSMessage}
        showSearch={showSearch}
        setShowSearch={setShowSearch}
        searchScope={searchScope}
        closePalette={closePalette}
        topics={topics}
        workspaceProjects={workspaceProjects}
        openTopicFromSearch={openTopicFromSearch}
        handleProjectClick={handleProjectClick}
        handleQuickCreateTopic={handleQuickCreateTopic}
        handleStandaloneAddPane={handleStandaloneAddPane}
        handleOpenProjectPicker={handleOpenProjectPicker}
        toggleTheme={toggleTheme}
        themeMode={themeMode}
        splitLayoutAvailable={splitLayoutAvailable}
        searchProjectPaths={searchProjectPaths}
        showFileSearch={showFileSearch}
        setShowFileSearch={setShowFileSearch}
        focusedProjectPath={focusedProjectPath}
        focusedPanelId={focusedPanelId}
        closedTabs={closedTabs}
        handleReopenClosedTab={handleReopenClosedTab}
        openHistoryUrl={openHistoryUrl}
        showShortcuts={showShortcuts}
        setShowShortcuts={setShowShortcuts}
      />

      <FirstRunAndUpdates
        DevOverlay={DevOverlay}
        sidebarCollapsed={sidebarCollapsed}
        showChangelogFromMenu={showChangelogFromMenu}
        setShowChangelogFromMenu={setShowChangelogFromMenu}
      />
    </div>
    </PendingActionProvider>
    </ConfirmProvider>
    </ToastProvider>
    </SplitPositionProvider>
    </TabNotificationProvider>
    </UnsentContext.Provider>
    </TopicsProvider>
  );
}

export default App;
