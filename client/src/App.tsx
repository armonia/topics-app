import { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { Settings as SettingsIcon, X, ChevronDown, BarChart3, Radio, Timer, Search, Archive, LayoutGrid, List, RotateCcw, Grid2x2, Hourglass } from 'lucide-react';
import { useGlobalBoardCount } from './hooks/useGlobalBoardCount';
import { useTaskTopicIndex } from './hooks/useTaskTopicIndex';
import { openTaskInApp } from './lib/openTaskLink';
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
import { useOpenClawAvailable } from './hooks/useOpenClawAvailable';
import { useClaudeSkipPermissions } from './hooks/useClaudePrefs';
import { useClaudeCodeModelSync } from './hooks/useClaudeCodeModelSync';
import { useSidebarState, nextSidebarViewMode } from './hooks/useSidebarState';
import { useSettingsSync } from './hooks/useSettingsSync';
import { useSidebarAndLayout } from './hooks/useSidebarAndLayout';
import { useFloatingVibrancy } from './hooks/useFloatingVibrancy';
import { useSidebarFitCoalesce } from './hooks/useSidebarFitCoalesce';
import { useSidebarFlipPush } from './hooks/useSidebarFlipPush';
import { isDesktop, isTauri } from './lib/shell';
import { selectDirectory } from './lib/shell/app';
import { initDevBundleReload } from './lib/devBundleReload';
import { initDevLayoutProbe } from './lib/devLayoutProbe';
import { initDevHeapProbe, registerHeapOwner, roughBytes } from './lib/devHeapProbe';
import { residencyHeapReport } from './state/pane/residency/registry';
import { initChunkReloadGuard } from './lib/chunkReloadGuard';
import { DevBundleToast } from './components/DevBundleToast';
import { openTaskFromUrl, currentTaskTarget, subscribeServiceWorkerTaskOpen } from './lib/openTaskLink';
import { consumeTabLinkFromUrl, currentTabTarget, openTabInApp, openTabInAppWhenHydrated, tabAckReleasesIntent } from './lib/tabLink';
import { TAB_PATH_PREFIX, type TabTarget } from '../../shared/tab-link';
import { useDismissable } from './hooks/useDismissable';
import { POPOVER_SURFACE, POPOVER_PANEL, POPOVER_MARGIN, Z_POPOVER } from './lib/popoverStyles';

// Tauri-on-macOS chrome parity: like Electron, the traffic lights are HIDDEN by
// default and revealed only while the Topics menu is open (the Rust shell hides
// them on launch; `set_traffic_lights` toggles them). So — same as Electron — no
// permanent left inset is needed; instead, while the menu is open the "Topics"
// label is hidden so the revealed lights occupy that spot.
const isTauriMac = isTauri && typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');
import { useAnimationPause } from './hooks/useAnimationPause';
import { useTerminalLifecycle } from './hooks/useTerminalLifecycle';
import { usePanelLifecycle } from './hooks/usePanelLifecycle';
import { useRefMirror } from './hooks/useRefMirror';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useBrowserContexts } from './hooks/useBrowserContexts';
import { useClosedTabs, createPaneId } from './state/pane/adapters';

import { TopicTree } from './components/Sidebar/TopicTree';
import { SpaceGroups } from './components/Sidebar/SpaceGroups';
import { groupChromeActive, isDetachedWindow } from './components/Layout/spaceHelpers';
import { spaceWindowId } from './lib/windowRole';
import { SplitPositionProvider } from './contexts/SplitPositionContext';
import { ContextMenu } from './components/Modals/ContextMenu';
import { PanelGrid } from './components/Layout/PanelGrid';
import { ToastProvider, ToastOutlet, useToast } from './components/Shared/Toast';
import { ConfirmProvider } from './hooks/useConfirm';
import { CompletionNotifierBridge } from './hooks/useCompletionNotifier';
import { PendingActionProvider, enqueuePendingAction, tickPendingAction, cancelPendingAction, flushPendingActions } from './contexts/PendingActionContext';
import { DRAG_REGION, NO_DRAG_REGION } from './lib/shell/dragRegion';
import { flushPaneStoreNow, flushLocalPaneStoreNow } from './state/pane/middleware';
import { usePaneStore } from './state/pane/store';
import { useSignalsSync } from './state/useSignalsSync';
import { useTaskBrowserTabsSync } from './hooks/useTaskBrowserTabsSync';
import { PaneAddMenu } from './components/Shared/PaneAddMenu';
import { RESTING_SURFACE, ROW_INSET } from './lib/selectionStyles';
import { normalizeTerminalAgent } from './lib/terminalAgents';
import { popOutTopic } from './lib/popOutTopic';
import { ErrorBoundary } from './components/Shared/ErrorBoundary';
import { SkeletonTopicList } from './components/Shared/Skeleton';
import { SidebarStatusBar } from './components/Sidebar/SidebarStatusBar';

// Lazy-load components that are only shown on demand
const NewTopicModal = lazy(() => import('./components/Modals/NewTopicModal').then(m => ({ default: m.NewTopicModal })));
const GlobalSettings = lazy(() => import('./components/Settings/GlobalSettings').then(m => ({ default: m.GlobalSettings })));
// Shared factory so the idle prefetch (App mount) and the `lazy()` boundary
// resolve the SAME module — a first ⌘K then finds the chunk already parsed
// instead of paying a ~25–40ms synchronous fetch+eval on the opening frame
// (measured: cold open worst 41.7ms/1 frame >33ms; warmed open worst 9.4ms,
// 0 frames >16.7ms).
const importCommandPalette = () => import('./components/Shared/CommandPalette');
const CommandPalette = lazy(() => importCommandPalette().then(m => ({ default: m.CommandPalette })));
const KeyboardShortcuts = lazy(() => import('./components/Shared/KeyboardShortcuts').then(m => ({ default: m.KeyboardShortcuts })));
const FileSearch = lazy(() => import('./components/Project/FileSearch').then(m => ({ default: m.FileSearch })));
const RemoteAccessPanel = lazy(() => import('./components/Sidebar/RemoteAccessPanel').then(m => ({ default: m.RemoteAccessPanel })));
// BrowserSidebarControl replaced by useBrowserContexts hook + unified TopicTree
/**
 * Il target del deep-link che la URL porta al boot, o `null`.
 *
 * `currentTabTarget()` copre tutta la grammatica dei permalink (`/tab/…`) e gli
 * alias `/task/<id>` e `/topic/<id>`. Resta fuori UNA forma sola: la query
 * LEGACY `?task=<slug>~<id>`, che non sta nella grammatica di `/tab/` e la sa
 * leggere solo `openTaskLink`. Il ponte serve perché quei link sono già
 * incollati nei commenti di review: senza, aprirebbero il drawer al mount e poi
 * si vedrebbero rubare il focus dall'hydrate — cioè esattamente la regressione
 * che la ri-asserzione esiste per impedire.
 */
function bootDeepLinkTarget(): TabTarget | null {
  try {
    const direct = currentTabTarget();
    if (direct) return direct;
    const legacy = currentTaskTarget();
    return legacy ? { kind: 'task', key: legacy.taskId } : null;
  } catch {
    return null;
  }
}

// Il deep-link del boot si legge UNA VOLTA SOLA, al caricamento del modulo —
// prima che React monti. Non è un'ottimizzazione: una rotta `/tab/…` si CONSUMA
// (viene strippata dalla URL), quindi rileggerla dopo darebbe `null`. In dev
// StrictMode monta→smonta→rimonta, e con la lettura dentro l'effetto il secondo
// giro troverebbe una URL già pulita: il permalink non aprirebbe niente proprio
// mentre lo si sta provando. Stessa ragione per cui `detachedTopicIds` parsa la
// query una volta.
const BOOT_TAB_PERMALINK = (() => {
  try {
    return window.location.pathname.startsWith(TAB_PATH_PREFIX);
  } catch {
    return false;
  }
})();
const BOOT_DEEP_LINK = bootDeepLinkTarget();

const TOPICS_MENU_PAGES = [
  { id: 'board' as const, icon: LayoutGrid, label: 'Board generale' },
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

  // Dev bundle freshness: when the server (behind its dev flag) says /public
  // was rebuilt, OR a lazy chunk 404s against a rebuilt bundle, surface a
  // "Ricarica" prompt (DevBundleToast) — never an auto-reload under the user.
  // See lib/devBundleReload.ts + lib/chunkReloadGuard.ts.
  useEffect(() => {
    const offRev = initDevBundleReload();
    const offChunk = initChunkReloadGuard();
    return () => { offRev(); offChunk(); };
  }, []);

  // Sonda di diagnosi del layout: inerte finché qualcuno non la ARMA scrivendo
  // `dev-layout-probe` nello ui-state. Serve a dire CHI sporca il layout
  // nell'app vera, dove i profili nativi non sanno nominare il JS e l'ambiente
  // E2E non riproduce il problema. Vedi lib/devLayoutProbe.ts.
  useEffect(() => initDevLayoutProbe(), []);
  useEffect(() => initDevHeapProbe(), []);
  // Gli altri due possessori di stato di lunga vita, cosi' la sonda puo'
  // CONFRONTARE invece di guardare una voce sola: senza un termine di paragone
  // "chat.messages tiene 40 MB" non dice se e' tanto.
  useEffect(() => registerHeapOwner('pane.store', () => {
    const st = usePaneStore.getState();
    return {
      entries: Object.keys(st.panes).length,
      items: Object.keys(st.tombstones ?? {}).length + (st.closedStack?.length ?? 0),
      bytes: roughBytes(st),
      detail: { tombstoni: Object.keys(st.tombstones ?? {}).length, closedStack: st.closedStack?.length ?? 0 },
    };
  }), []);
  useEffect(() => registerHeapOwner('pane.residency', residencyHeapReport), []);

  // Click su una web-push (app aperta ma in secondo piano): il service worker
  // mette a fuoco questa finestra e ci passa la destinazione, perché non può
  // navigarla senza ricaricare la SPA. Stessa via dei deep-link `/task/<id>`.
  useEffect(() => subscribeServiceWorkerTaskOpen(), []);

  // Warm the ⌘K command-palette chunk on idle so its FIRST open is composited
  // from an already-parsed module (no fetch+eval on the opening frame). Idle-
  // scheduled so it never competes with the initial paint; guarded for Safari
  // (no requestIdleCallback) with a setTimeout fallback.
  useEffect(() => {
    const warm = () => { void importCommandPalette().catch(() => {}); };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) { const id = ric(warm, { timeout: 3000 }); return () => (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(id); }
    const t = window.setTimeout(warm, 1500);
    return () => window.clearTimeout(t);
  }, []);

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

  // Il deep-link del boot vive in `<BootDeepLinkResolver>` (in fondo a questo
  // file), montato DENTRO `<ToastProvider>`. Non è un vezzo di struttura: il
  // rifiuto di un permalink morto deve dirlo all'utente, e `useToast()` qui
  // restituirebbe il no-op — è App a RENDERIZZARE il provider, quindi non c'è
  // nessun context sopra di lei. `isDetached` viaggia come prop.

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
    viewportTop,
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

  // Close topics menu on outside click or Escape (canonical useDismissable
  // contract: capture-phase pointer/touch + Escape). Trigger wrapper + dropdown
  // panel both count as "inside". restoreFocus off to preserve prior behaviour.
  useDismissable({
    open: showTopicsMenu,
    onClose: () => { setShowTopicsMenu(false); setExpandedTool(null); },
    refs: [topicsMenuRef, topicsDropdownRef],
    restoreFocus: false,
  });

  // Close remote access dropdown on outside click or Escape. The trigger now
  // lives inside the Topics ▾ menu, so the Topics menu wrapper counts as "inside".
  useDismissable({
    open: expandedTool === 'remote',
    onClose: () => setExpandedTool(null),
    refs: [topicsMenuRef, remoteAccessDropdownRef],
    restoreFocus: false,
  });


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
    clearExpired,
    onWSMessage: chatStreamHandler,
    error: chatError,
    gatewayConnected: _gatewayConnected,
    isOwnStream,
  } = useChat();

  const { status: wsStatus, unreadData, sendWS, onMessage: onWSMessage, lastConnectedAt } = useWebSocket();

  // Live count of active (non-done) tasks across all projects — gates the
  // "Board generale" sidebar row and shows its badge.
  const boardTaskCount = useGlobalBoardCount(onWSMessage);

  // topicId → task index for dispatched tasks. Due consumatori: il banner di
  // completamento ci mette dentro il taskId (un click apre il drawer del task)
  // e i due notificatori lo usano per NON bannerizzare la fine turno di un
  // agente di board al lavoro — quella la annuncia `task:review-ready`.
  const taskForTopic = useTaskTopicIndex(onWSMessage);

  // A stable global the native (Tauri) notification delegate can call on click to
  // open a task — the web/Electron path opens it directly via notifyNative.onclick.
  useEffect(() => {
    (window as unknown as { __topicsOpenTask?: (id: string) => void }).__topicsOpenTask =
      (id: string) => { if (id) openTaskInApp({ taskId: id }); };
    return () => { delete (window as unknown as { __topicsOpenTask?: (id: string) => void }).__topicsOpenTask; };
  }, []);

  // Task-owned browser fork → per-task tab store. Consumes the server's
  // `browser:open-task-tab` frame (feature-flagged) so an agent's browser lands
  // in its task's in-drawer group, never the global layout. App-level so it's
  // captured whichever drawer is open. See useTaskBrowserTabsSync.
  useTaskBrowserTabsSync(onWSMessage);

  // Wire up chat stream handler to WebSocket (enables cross-window streaming)
  useEffect(() => {
    return onWSMessage(chatStreamHandler);
  }, [onWSMessage, chatStreamHandler]);

  // Terminal lifecycle (Phase 3 hook 2). Owns terminal sessions + grace
  // period ref + WS subscription. Exposes a pure pruneStaleTerminalPanes
  // helper used by the App-side cleanup effect below (CRITIQUE C5: NO
  // setOpenPanels crosses the seam).
  const terminals = useTerminalLifecycle({ wsStatus, lastConnectedAt, onWSMessage });
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


  const sidebarContentRef = useRef<HTMLDivElement>(null);

  // Sidebar state (view mode, expanded nodes, pinned "Fissati" items) —
  // declared BEFORE usePanelLifecycle so the pin predicate can feed its
  // archive-on-close guards (ref-backed, stays a stable identity).
  const sidebar = useSidebarState(onWSMessage);
  const isPinnedRef = useRefMirror(sidebar.isPinned);

  // Verso di LETTURA delle preferenze: `saveSettings` faceva il PUT da sempre,
  // ma nessuno leggeva mai indietro. Senza questo, un secondo dispositivo o la
  // WebView del guscio desktop (storage suo) ripartono dai default con il
  // valore giusto fermo sul server.
  useSettingsSync(onWSMessage);

  // Phase 3 hook 3 — full panel-state cluster (state, store-sync,
  // validation, per-cluster WS subs, handlers). See usePanelLifecycle.ts
  // for the full effect-declaration-order contract.
  const panelLifecycle = usePanelLifecycle({
    isDetached, detachedTopicId, detachedTopicIds, isMobile,
    topics, topicsLoading, loadTopics, createTopic, applyTopicFromWS, archiveProject, archiveTopic,
    workspaceProjects,
    terminalSessions,
    pruneStaleTerminalPanes: terminals.pruneStaleTerminalPanes,
    terminalOps: terminals.ops,
    isPinnedRef,
    onWSMessage, sendWS, wsStatus, windowId,
    chatStreamHandlers: {
      isOwnStream, getSessionMessages, addMessageFromWS, clearSession,
      loadHistory, appendMediaToLastAssistant, sendMessage, drainQueue,
    },
    setSidebarCollapsed,
    removeClosedTab, closedTabs,
    taskForTopic,
  });
  const {
    openPanels, visiblePanels, activeSpaceId,
    focusedPanelId, previewPanelId, nextPanelMode, draftMeta,
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

  // ── Il gruppo, per la sidebar ────────────────────────────────────────────
  // `openPanels` è l'insieme PIENO, `visiblePanels` il sottoinsieme del gruppo
  // attivo: la differenza è già, esattamente, "vive in un altro gruppo". Niente
  // seconda iscrizione allo store, e nessun rischio che le due superfici
  // rispondano in modo diverso alla stessa domanda.
  const otherSpacePaneIds = useMemo(() => {
    const visible = new Set(visiblePanels);
    return new Set(openPanels.filter((id) => !visible.has(id)));
  }, [openPanels, visiblePanels]);
  // Vero quando l'intestazione del gruppo c'è: allora l'albero si divide in
  // "le tab di questo gruppo" e "fuori dai gruppi". Stessa risposta che dà
  // SpaceGroups per decidere se disegnarsi.
  const spaceChrome = usePaneStore((s) => groupChromeActive(s.spaces, spaceWindowId()));
  const spaceScoped = spaceChrome && !isDetachedWindow();

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

  // In-chat sub-agent strip → open/focus the sub-agent's terminal pane. Routed
  // via the CustomEvent bus (same pattern as topics:open-project-picker) so the
  // chat pane doesn't need handleTerminalClick threaded down three layers. The
  // handler is the exact same one the sidebar sub-agent rows use, so a click
  // from inside the topic lands on the identical (now non-blank) terminal pane.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { sessionId?: string; name?: string } | undefined;
      if (detail?.sessionId) handleTerminalClick(detail.sessionId, detail.name || '');
    };
    window.addEventListener('topics:open-terminal-pane', handler as EventListener);
    return () => window.removeEventListener('topics:open-terminal-pane', handler as EventListener);
  }, [handleTerminalClick]);

  // Preavviso di compaction nel composer → "Nuova chat". Stesso bus del picker
  // di progetto: la strip vive dentro ChatInput, tre livelli sotto, e l'unica
  // alternativa sarebbe stata infilare onNewChat in ChatPane → ChatInput solo
  // per un bottone che compare sopra il 90% di contesto.
  useEffect(() => {
    const handler = () => { if (appSettings.enableNewChat) handleQuickCreateTopic(); };
    window.addEventListener('topics:new-chat', handler);
    return () => window.removeEventListener('topics:new-chat', handler);
  }, [handleQuickCreateTopic, appSettings.enableNewChat]);

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
  // Una tab fissata non si chiude, da NESSUNA strada.
  //
  // Nascondere la X nella barra copre il click, non la scorciatoia da tastiera,
  // il tasto centrale, «chiudi le altre», o un chiamante che arriverà domani.
  // Siccome chiudere è diventato un ritiro (la chat si archivia, la sessione si
  // ritira), la protezione deve stare sull'AZIONE, non sul bottone. Il criterio
  // è `isPaneClosable`, la stessa chiave con cui il fissaggio è stato messo.
  const isCloseBlockedByPin = useCallback((paneId: string): boolean => {
    const pinKey = paneId.startsWith('chat:') ? paneId.slice('chat:'.length) : paneId;
    return isPinnedRef.current?.(pinKey) ?? false;
  }, [isPinnedRef]);

  const handleClosePanelImmediate = useCallback((topicId: string) => {
    if (isCloseBlockedByPin(topicId)) return;
    cancelPendingAction(`close-tab:${topicId}`);
    handleClosePanel(topicId);
  }, [handleClosePanel, isCloseBlockedByPin]);

  const handleClosePanelDeferred = useCallback((topicId: string, onCommit?: () => void) => {
    if (isCloseBlockedByPin(topicId)) return;
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
    // Spazi: the pre-shift runs on the VISIBLE set — pre-focusing a pane
    // hidden in another space would switch the whole window mid-countdown.
    let focusBeforeClose: string | null = null;
    if (focusedPanelId === topicId) {
      const idx = visiblePanels.indexOf(topicId);
      const remaining = visiblePanels.filter(id => id !== topicId);
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
  }, [topics, handleClosePanel, enqueueAndTick, focusedPanelId, visiblePanels, handleFocusPanel, isCloseBlockedByPin]);

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

  // Browser-context state (App-level — sidebar UI consumers). `sidebar`
  // (useSidebarState) is declared above, before usePanelLifecycle.
  const browserCtx = useBrowserContexts(true, onWSMessage);

  // Pin/unpin (Fissati). Unpinning a CLOSED chat archives it so it falls back
  // to the 2-state model (closed ⟺ archived) instead of becoming a phantom
  // non-archived tab-less topic; unpinning an OPEN one just drops the glyph.
  // Projects are pure pin removal (their row visibility is gate-driven).
  // RULING 2.2 (binding): the liveness check runs on the FULL openPanels set —
  // NEVER visiblePanels — so unpinning a chat living in a hidden Spazio must
  // not archive an open tab. Project-internal opens count only through a LIVE
  // project tab (owningRenderedProject pattern): projectOpenPanes is
  // upsert-only, and a stale entry from a closed project must not make the
  // unpin skip the archive.
  const { isPinned: sidebarIsPinned, togglePin: sidebarTogglePin } = sidebar;
  const handleTogglePin = useCallback((id: string) => {
    // Chat-only unpin-while-closed archive semantics. Projects (`project:<path>`),
    // terminals (`terminal:<id>`) and browsers (`browser:<ctx>`) don't archive on
    // unpin — none is an archivable topic record — so those prefixes skip this
    // branch and just toggle the pin. (A bare topicId has no prefix → chat.)
    if (
      sidebarIsPinned(id) &&
      !id.startsWith('project:') &&
      !id.startsWith('terminal:') &&
      !id.startsWith('browser:')
    ) {
      const topic = topics[id];
      if (topic && !topic.archived) {
        const chatPaneId = createPaneId('chat', id);
        const openTopLevel = openPanels.includes(id);
        const openInLiveProject = Object.entries(projectOpenPanes).some(([pp, ids]) =>
          (ids.includes(chatPaneId) || ids.includes(id)) &&
          openPanels.includes(createPaneId('project', pp)),
        );
        if (!openTopLevel && !openInLiveProject) void archiveTopic(id, true);
      }
    }
    sidebarTogglePin(id);
  }, [sidebarIsPinned, sidebarTogglePin, topics, openPanels, projectOpenPanes, archiveTopic]);

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
    focusedPanelId,
    // Spazi: ⌘1-9 / ⌘W and the tab-cycling chords target what the user can
    // SEE — the visible subset, not the full cross-space set.
    openPanels: visiblePanels,
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
    setShowSettings,
    setShowFileSearch,
    isSessionStreaming,
    stopSession,
  });

  return (
    <TopicsProvider topics={topics} terminalSessions={terminalSessions} terminalRosterAuthoritative={terminals.rosterAuthoritative} workspaceProjects={workspaceProjects}>
    <TabNotificationProvider unreadData={unreadData} onWSMessage={onWSMessage} openPanels={openPanels} focusedPanelId={focusedPanelId}>
    <SplitPositionProvider>
    <ToastProvider>
    <ConfirmProvider>
    {/* Il deep-link del boot (`/tab/…`, `/task/…`, `/topic/…`). Sta QUI dentro,
        e non in un effetto di App, perché il rifiuto di un permalink morto deve
        arrivare all'utente come toast — e `useToast()` sopra `<ToastProvider>`
        (cioè dentro App) restituisce il no-op. Non renderizza niente. */}
    <BootDeepLinkResolver isDetached={isDetached} />
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
      taskForTopic={taskForTopic}
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
      // NB: the landing demo (client/src/demo/landing-cursor.js, scene
      // "floating") toggles `.floating-splits` on THIS element from outside
      // React, to show the mode on the marketing site. That works only because
      // on web `isDesktop` is false, so this template string is constant
      // between renders and React never rewrites the attribute. Add anything
      // dynamic here and the demo chapter goes quietly dead — nothing breaks,
      // it just stops showing what it claims to show.
      className={`flex bg-app-bg overflow-hidden max-w-[100vw] ${appSettings.floatingSplits && isDesktop ? 'floating-splits' : ''}`}
      onTouchStart={isMobile ? handleEdgeTouchStart : undefined}
      onTouchEnd={isMobile ? handleEdgeTouchEnd : undefined}
      style={{
        fontSize: `${appSettings.fontSize}px`,
        position: 'fixed',
        top: viewportHeight != null ? `${viewportTop}px` : 0, left: 0, right: 0,
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
        // `group/sidebar`: alcune affordance della sidebar si accendono solo
        // quando ci passi sopra (il "+" dei gruppi in fondo). Il gruppo di
        // hover sta QUI e non sulla singola barra perché il bersaglio nascosto
        // sarebbe altrimenti impossibile da trovare: entri nella sidebar e il
        // controllo c'è.
        className={`group/sidebar bg-surface flex flex-col flex-shrink-0 sidebar-transition overflow-hidden ${
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
          className={`flex items-center justify-between gap-2 border-b border-app-border flex-shrink-0 app-drag-region ${isMobile ? 'h-12' : 'h-10'}`} {...DRAG_REGION}
          style={{ paddingRight: ROW_INSET, paddingLeft: ROW_INSET }}
        >
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {/* Close button on mobile */}
            {isMobile && (
              <button
                onClick={() => setSidebarCollapsed(true)}
                className="w-10 h-10 -ml-1 mr-1 flex items-center justify-center text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 rounded-md app-no-drag" {...NO_DRAG_REGION}
                aria-label="Close sidebar"
              >
                <X size={22} aria-hidden="true" />
              </button>
            )}
            {/* Topics button - opens combined settings & tools menu */}
            <div className="app-no-drag" {...NO_DRAG_REGION} ref={topicsMenuRef}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!showTopicsMenu) {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setTopicsMenuPos({ top: rect.bottom + 4, left: rect.left });
                  }
                  setShowTopicsMenu(!showTopicsMenu);
                }}
                className={`flex items-center ${isTauriMac ? 'gap-2' : 'gap-1'} px-1.5 py-0.5 rounded-md transition-colors cursor-pointer ${
                  showTopicsMenu ? 'bg-app-hover' : 'hover:bg-app-hover'
                }`}
                style={{ pointerEvents: 'auto' }}
                title="Settings & Tools"
              >
                <span className={`font-semibold text-app-text tracking-[-0.01em] ${isMobile ? 'text-[17px]' : 'text-[15px]'} ${isTauriMac && showTopicsMenu ? 'invisible' : ''}`}>Topics</span>
                <ChevronDown size={12} className={`text-app-text-muted transition-transform ${showTopicsMenu ? 'rotate-180' : ''}`} />
              </button>
            </div>
            {/* Connection + loading status live in the bottom SidebarStatusBar
                and the tree skeleton — no stray spinner in the header. The
                middle of the header stays empty (drag region on Electron). */}
          </div>
          <div className={`flex items-center ${isMobile ? 'gap-2' : 'gap-1'} relative z-50 app-no-drag`} {...NO_DRAG_REGION} style={{ pointerEvents: 'auto' }}>
            {/* Activity / Agents / Remote Access moved into the Topics ▾ menu;
                the header right side is the Search launcher + the canonical
                "+" add menu — two icon-only RESTING_SURFACE twins. */}
            {/* Search launcher — icon-only (the magnifier + kbd hint say it
                all; a "Search…" label was redundant). Opens the ⌘K command
                palette in 'all' scope. No inline tree filtering; ⌘K is the
                canonical search. */}
            <button
              onClick={() => { setSearchScope('all'); setShowSearch(true); }}
              className={`${isMobile ? 'h-9 px-2.5' : 'h-7 px-2'} flex items-center gap-1.5 rounded-md ${RESTING_SURFACE} text-app-text-muted hover:text-app-text transition-colors flex-shrink-0 cursor-pointer app-no-drag`} {...NO_DRAG_REGION}
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
                } else if (type === 'board') {
                  handleOpenAsPage('board');
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
          {/* Il GRUPPO è il contenitore delle sue tab: l'albero qui sotto è il
              suo contenuto (`openPanels` filtrato per gruppo), e l'intestazione
              che lo avvolge è ciò che lo dice. Gli altri gruppi sono righe
              chiuse sopra — nessuna barra separata da nessun'altra parte. */}
          <SpaceGroups>
          <ErrorBoundary fallbackMessage="Sidebar error">
          {topicsLoading && Object.keys(topics).length === 0 ? (
            <div className="overflow-y-auto sidebar-scroll"><SkeletonTopicList count={5} /></div>
          ) : (
          // `openPanels={visiblePanels}`: LE TAB DEL GRUPPO ATTIVO, non tutte.
          // La sidebar è il gruppo che stai guardando; una riga che appartiene
          // a un altro gruppo si raggiunge commutando in fondo, non
          // trovandosela qui in mezzo senza sapere da dove viene. Stessa fonte
          // della griglia, così le due superfici non divergono.
          <TopicTree
            topics={topics}
            workspaceProjects={workspaceProjects}
            searchQuery=""
            expandedNodes={sidebar.expandedNodes}
            onToggleNode={sidebar.toggleNode}
            focusedTopicId={focusedPanelId}
            projectActiveTopics={projectActiveTopics}
            previewPanelId={previewPanelId}
            openPanels={visiblePanels}
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
            pinnedItems={sidebar.pinnedItems}
            onTogglePin={handleTogglePin}
            boardTaskCount={boardTaskCount}
            boardOpen={visiblePanels.includes('__board__')}
            onOpenBoard={() => handleOpenAsPage('board')}
            spaceScoped={spaceScoped}
            otherSpacePaneIds={otherSpacePaneIds}
          />
          )}
          </ErrorBoundary>
          </SpaceGroups>
        </div>

        {/* Status bar */}
        <ErrorBoundary fallbackMessage="Status bar error">
        <SidebarStatusBar wsStatus={wsStatus} dataNotice={topicsError} />
        </ErrorBoundary>
      </div>

      {/* Sidebar resize handle. The sidebar is position:fixed (FLIP push), so a
          flex divider here would collapse to x=0 under the sidebar's LEFT edge —
          nothing to grab at the real sidebar/content boundary (the bug: "resize
          non va"). The handle must therefore be fixed at the sidebar's RIGHT
          edge (left = sidebarWidth). Grab band biased INTO the sidebar: native
          WKWebView panes trail the sidebar flush on the content side and would
          eat any hover/click past the edge. z-50 + wide band: same lesson as
          the SplitTree dividers. Hidden while collapsed — the edge is gone. */}
      {!isMobile && !sidebarCollapsed && (
        <div
          className="group fixed inset-y-0 z-50 cursor-col-resize"
          style={{ left: sidebarWidth - 8, width: 10 }}
          onMouseDown={handleSidebarResizeStart}
          onDoubleClick={handleSidebarDoubleClick}
        >
          {/* No resting visuals — the sidebar's own shadow separates it from the
              content (Attilio: a visible edge line "non va bene"). The handle
              paints only on hover. */}
          <div className="absolute inset-0 group-hover:bg-primary/25" />
          <div className="absolute inset-y-0 right-[1px] w-[3px] group-hover:bg-primary" />
        </div>
      )}

      {/* Collapsed sidebar expand button - only when no panels are open (panels have inline button in their header) */}
      {sidebarCollapsed && visiblePanels.length === 0 && (
        <div
          className="absolute left-2 z-30 flex items-center gap-1"
          style={{ top: isMobile ? 'calc(0.5rem + env(safe-area-inset-top, 0px))' : '0.5rem' }}
        >
          <SidebarToggleButton onClick={toggleSidebar} title="Expand sidebar (⌘B)" className="bg-surface border border-app-border-light rounded-lg shadow-sm" />
        </div>
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
        {/* Spazi: the grid gets the VISIBLE subset (openPanels stays the full
            store-backed set — see usePanelLifecycle.visiblePanels) and
            remounts per space (key) so per-space grid layouts stay isolated:
            PanelGrid prunes soloCells/gridRows against its openPanels prop,
            and a filtered set against a SHARED layout would erase the other
            spaces' geometry on every switch. */}
        <PanelGrid
          key={activeSpaceId}
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
          // Height cap + scroll, and a left clamp. This menu opened at
          // `trigger.bottom + 4` with NO bound of any kind: it has ~12 rows and
          // simply ran off the bottom on a short window, with the overflowing
          // rows unreachable. Capping to the space actually below the trigger
          // (and clamping the left edge to the shared POPOVER_MARGIN) keeps
          // every row reachable without a measure-then-place pass.
          className={`${POPOVER_SURFACE} min-w-[200px] overflow-y-auto overscroll-contain`}
          style={{
            position: 'fixed',
            top: topicsMenuPos.top,
            left: Math.max(POPOVER_MARGIN, topicsMenuPos.left),
            maxHeight: `calc(100vh - ${topicsMenuPos.top + POPOVER_MARGIN}px)`,
            zIndex: Z_POPOVER,
          }}
        >
          {/* Sidebar controls relocated from the old <SidebarControls> row. */}
          <button
            onClick={() => { sidebar.toggleShowArchived(); }}
            className={`w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] hover:bg-app-hover transition-colors ${sidebar.showArchived ? 'text-primary' : 'text-app-text'}`}
          >
            <Archive size={isMobile ? 18 : 14} className={sidebar.showArchived ? 'text-primary' : ''} />
            <span className="flex-1 text-left">Mostra archiviati</span>
          </button>
          <button
            onClick={() => { sidebar.toggleViewMode(); }}
            className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
          >
            {/* Icona ed etichetta descrivono il modo SUCCESSIVO — cosa fa il
                click — e lo chiedono a `nextSidebarViewMode`, la stessa funzione
                che il toggle usa per muoversi: con tre modi, due liste di casi
                scritte a mano divergerebbero al primo che se ne aggiunge. */}
            {(() => {
              const next = nextSidebarViewMode(sidebar.viewMode);
              const Icon = next === 'grouped' ? LayoutGrid : next === 'state' ? Hourglass : List;
              return <Icon size={isMobile ? 18 : 14} />;
            })()}
            {/* "Vista per tipo", NOT "Vista a gruppi": this buckets the tree by
                ITEM TYPE (progetti / chat / terminali / …). A "gruppo" in this
                app is a WINDOW — the unit that detaches — so calling a
                type-bucketed tree "a gruppi" made two unrelated things share a
                word (the "non capisco spazi e gruppi" confusion). */}
            <span className="flex-1 text-left">{
              (() => {
                const next = nextSidebarViewMode(sidebar.viewMode);
                return next === 'grouped' ? 'Vista per tipo'
                  : next === 'state' ? 'Vista per stato'
                  : 'Vista timeline';
              })()
            }</span>
          </button>
          {/* "Reimposta pannelli" — same per-window action the ⌘K palette and
              the tab-bar context menu expose (the shared 'topics:reset-split-
              layout' CustomEvent bus). The standalone grid COLLAPSES every split
              — columns and stacks — into the single 'standalone' pool cell, where
              panes live as tabs; nothing is closed and it's ⌘Z-undoable. Always
              offered (like the palette); no-ops when already a single pane. */}
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('topics:reset-split-layout'));
              setShowTopicsMenu(false);
              setExpandedTool(null);
            }}
            className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
            title="Riunisce tutti i pannelli in uno solo (le schede restano aperte)"
          >
            <RotateCcw size={isMobile ? 18 : 14} />
            <span className="flex-1 text-left">Reimposta pannelli</span>
          </button>
          {/* "Disponi automaticamente" — the inverse of Reimposta pannelli: auto-tile
              every open standalone pane into its own cell in a balanced grid (the
              shared 'topics:auto-tile-layout' bus; PanelGrid handles it). Always
              offered; no-ops when fewer than two panes are open. ⌘Z-undoable. */}
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('topics:auto-tile-layout'));
              setShowTopicsMenu(false);
              setExpandedTool(null);
            }}
            className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
            title="Dispone tutte le schede aperte affiancate in una griglia bilanciata"
          >
            <Grid2x2 size={isMobile ? 18 : 14} />
            <span className="flex-1 text-left">Disponi automaticamente</span>
          </button>
          <button
            onClick={() => { setShowTopicsMenu(false); setExpandedTool('remote'); }}
            className="w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors"
          >
            <Radio size={isMobile ? 18 : 14} />
            <span className="flex-1 text-left">Remote Access</span>
          </button>
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
          // Same cap as the Topics menu above: RemoteAccessPanel is a tall
          // panel with no max-h of its own, opening at the same unbounded
          // coordinates — it ran off the bottom edge.
          className={`${POPOVER_PANEL} min-w-[300px] overflow-y-auto overscroll-contain`}
          style={{
            position: 'fixed',
            // Anchored to the Topics ▾ menu (its trigger is now the menu item),
            // opening at the same spot as the Topics dropdown.
            top: topicsMenuPos.top,
            left: Math.max(POPOVER_MARGIN, topicsMenuPos.left),
            maxHeight: `calc(100vh - ${topicsMenuPos.top + POPOVER_MARGIN}px)`,
            zIndex: Z_POPOVER,
          }}
        >
          <Suspense fallback={<div className="p-3 text-[11px] text-app-text-muted text-center">Loading...</div>}>
            <RemoteAccessPanel enabled />
          </Suspense>
        </div>,
        document.body
      )}

      {/* Context menu — keyed by topic so a right-click on a DIFFERENT topic
          remounts it: without the key, React reuses the instance and its local
          state (open subMenu, half-typed renameValue seeded in a useState
          initializer) survives the prop swap — Save/Delete would then act on
          the NEW topic with the OLD topic's state. */}
      {contextMenu && (
        <ContextMenu
          key={contextMenu.topic.id}
          x={contextMenu.x}
          y={contextMenu.y}
          topic={contextMenu.topic}
          onClose={() => setContextMenu(null)}
          onUpdate={updateTopic}
          onDelete={archiveTopic}
          isPinned={sidebar.pinnedIds.has(contextMenu.topic.id)}
          onTogglePin={() => handleTogglePin(contextMenu.topic.id)}
          onPopOut={() => {
            // Same contract as the pane-menu pop-out: drop the source pane only
            // when a window actually opened (popOutTopic returns false when it
            // just focused an existing window or the popup was blocked).
            void popOutTopic(contextMenu.topic.id).then((opened) => {
              if (opened) handleClosePanel(contextMenu.topic.id);
            });
          }}
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

      {/* Command Palette (⌘K = everything, ⌘F = projects scope). */}
      {showSearch && (
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
            onNewClaude={() => handleQuickCreateTerminal('claude-code', claudeSkipPermissions)}
            onNewCodex={() => handleQuickCreateTerminal('codex')}
            onNewTerminal={() => handleQuickCreateTerminal('shell')}
            onCreateProject={handleOpenProjectPicker}
            onNewProject={handleOpenProjectPicker}
            onToggleTheme={toggleTheme}
            onOpenSettings={() => { setShowSearch(false); setShowSettings(true); }}
            // "Reimposta pannelli" (collapse to one tabbed cell) + "Disponi
            // automaticamente" (auto-tile into a balanced grid) — per-window
            // CustomEvent bus (same pattern as topics:open-project-picker); the
            // standalone PanelGrid listener performs each.
            onResetPanels={() => window.dispatchEvent(new CustomEvent('topics:reset-split-layout'))}
            onAutoTilePanels={() => window.dispatchEvent(new CustomEvent('topics:auto-tile-layout'))}
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
      {/* In-page bundle refresh prompt (dev rebuilds + stale-chunk 404s) —
          the manual-reload replacement for the old silent auto-reload. */}
      <DevBundleToast />

      {/* Root-level fallback outlet for global notifications (e.g. agent
          completion). When a scoped outlet (ProjectWindow's) is mounted,
          this one stays hidden to avoid double-rendering — the scoped
          outlet wins and toasts appear inside the project pane. */}
      <ToastOutlet fixed fallback />
    </div>
    </PendingActionProvider>
    </ConfirmProvider>
    </ToastProvider>
    </SplitPositionProvider>
    </TabNotificationProvider>
    </TopicsProvider>
  );
}

/**
 * Il deep-link del boot. TRE rotte, un solo effetto perché è UNA sola corsa:
 *   /task/<taskId>  (+ la forma legacy ?task=<slug>~<taskId>) → drawer della board
 *   /topic/<topicId>                                          → la chat
 *   /tab/<kind>/…                                             → una tab qualunque
 *
 * ── Perché è un componente, e perché sta DENTRO ToastProvider ────────────────
 * Perché un rifiuto MUTO è il peggiore dei tre esiti. `openTabInApp` sa dire
 * «questa tab non esiste più», ma solo a chi gli passa un `notify` — e per un
 * anno intero nessun call-site gliel'ha passato, quindi ogni vicolo cieco era
 * un no-op silenzioso: clicchi il link, non succede niente, e non sai perché.
 * Il toast però è un context, e App non può leggerlo: è LEI a renderizzare
 * `<ToastProvider>`, quindi `useToast()` dentro App restituisce il no-op
 * (Toast.tsx). Da qui l'estrazione: l'effetto è identico, ma gira in un
 * componente montato sotto il provider, dove il toast c'è davvero.
 *
 * ── La ri-asserzione, e perché esiste ───────────────────────────────────────
 * The single mount-time fire RACES the boot pane-store hydrate: the first
 * `ui-state:init` re-runs the focus reconciliation and restores the
 * previously-focused pane, stealing the board activation before its drawer
 * opens (repro: open /task/<id> cold → the last project pane shows, no
 * drawer). So we RE-ASSERT the deep-link on each pane-store hydrate during a
 * short boot window, riding the same (proven-working) open path once the store
 * is stable. Bounded and safe: it stops the instant the drawer opens
 * (`topics:task-opened`) o quando il permalink dichiara di essere ARRIVATO — o
 * di non avere destinazione — con `topics:tab-opened`; only re-fires while the
 * URL still carries the target, and self-cancels after the boot window so it
 * can never yank focus from a user who has since navigated elsewhere.
 *
 * ⚠︎ Perché l'ack di SUCCESSO conta quanto quello di fallimento: `stop` è
 * l'unica cosa che spegne la finestra da 8s, e dentro quella finestra la
 * sottoscrizione a `lastSeq` si sveglia a OGNI dispatch — un click su un'altra
 * tab ne produce uno (FOCUS_PANE), quindi 400ms dopo la ri-asserzione
 * ributtava l'utente sul permalink. A ogni click, per otto secondi.
 *
 * Il target si legge con `currentTabTarget()`, che è il SOVRAINSIEME: `/tab/…`
 * più gli alias `/task/` e `/topic/`. Da qui due conseguenze volute: un
 * `/topic/<id>` aperto a freddo — la destinazione della push di fine turno —
 * prima moriva sulla guardia `currentTaskTarget()` e non apriva niente; e ogni
 * permalink di tab eredita la stessa protezione anti-furto-di-focus del
 * deep-link della board (l'intento `topics:open-tab` in usePanelLifecycle).
 */
function BootDeepLinkResolver({ isDetached }: { isDetached: boolean }) {
  // Il valore del context dei toast NON è memoizzato (ToastProvider ricrea
  // l'oggetto a ogni render), quindi metterlo fra le dipendenze rifarebbe
  // partire l'intera corsa di boot a ogni toast mostrato. Rifless in un ref:
  // l'effetto gira UNA volta, e legge il toast che c'è nel momento in cui
  // deve parlare.
  const toast = useToast();
  const toastRef = useRef(toast);
  // Sincronizzato in un effetto, non durante il render: scrivere un ref mentre
  // React sta renderizzando e' proprio la cosa che rompe sotto concurrent. Gli
  // effetti girano nell'ordine di dichiarazione, quindi questo aggiorna il ref
  // PRIMA che il corpo dell'effetto di boot qui sotto lo legga, al mount e a
  // ogni render successivo. E' lo stesso schema di pinnedIdsRef/orderedIdsRef
  // in usePaneOrdering.
  useEffect(() => { toastRef.current = toast; });
  useEffect(() => {
    // Le finestre STACCATE (`?topics=`) sono read-only verso il pane-store
    // (bootstrap.ts: niente persistenza locale, niente PUT, niente cross-tab):
    // se risolvessero un permalink in casa propria conierebbero pane che
    // nessuno persiste — l'incidente del 2026-07-20, nove browser pane orfane
    // in group:default. Non consumano e non aprono: è la via meno invasiva,
    // perché INOLTRARE alla main vorrebbe dire accendere qui il canale
    // cross-tab che la finestra staccata si tiene spento di proposito. E
    // soprattutto NON si strippa la URL: la query `?topics=` È l'identità della
    // finestra, ripulirla la trasformerebbe in una main al primo reload.
    // (`consumeTabLinkFromUrl` ha ora la stessa guardia in casa propria: questa
    // resta perché qui c'è anche tutto il resto della corsa.)
    if (isDetached) return;
    const boot = BOOT_DEEP_LINK;
    if (!BOOT_TAB_PERMALINK && !boot) return;
    // Il canale per dire all'utente che il link non porta da nessuna parte.
    // `warning` e non `error`: non è un guasto dell'app, è un indirizzo vecchio.
    const notify = (message: string) => toastRef.current.warning(message);
    // Una rotta `/tab/` si CONSUMA (il pane-store è già la persistenza della
    // tab: lasciarla nella URL la riaprirebbe a ogni reload, per sempre — il
    // difetto noto di `/topic/<id>`). Va consumata anche quando il target è
    // ILLEGGIBILE: una `/tab/…` che non apre niente deve comunque sparire, o si
    // ripresenta identica a ogni reload. `/task/` e `/topic/` invece restano
    // dove sono: la prima è la riflessione viva del drawer, e non è roba nostra.
    //
    // `consumeTabLinkFromUrl` STRIPPA subito e INSTRADA dopo l'idratazione: è
    // lui, ora, il colpo garantito per un permalink `/tab/…` (vedi `kick`).
    const consumed = BOOT_TAB_PERMALINK ? consumeTabLinkFromUrl({ notify }) : null;
    if (!BOOT_TAB_PERMALINK) openTaskFromUrl();
    if (!boot) return;
    let done = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (done) return;
      done = true;
      unsub();
      kick();
      clearTimeout(settleTimer);
      clearTimeout(deadline);
      window.removeEventListener('topics:task-opened', stop);
      window.removeEventListener('topics:tab-opened', onTabAck);
    };
    // L'ack di un permalink spegne la ri-asserzione SOLO se è un vicolo cieco.
    //
    // Perché non anche sul successo, che pure sarebbe la lettura naturale di
    // «la corsa è finita»: l'ack di successo lo emette `scheduleOpenAck` non
    // appena la pane COMPARE nello store, cioè un istante dopo l'apertura —
    // mentre l'onda di idratazione può avere ancora code (`ui-state:updated`
    // dai peer). Fermarsi lì significa ritirare la guardia troppo presto: la
    // tab si apre, un hydrate tardivo le ruba il fuoco e non resta più niente
    // che gliela riporti (TABLINK-05/06, `data-active` che resta `false` per
    // sempre). Su un vicolo cieco invece fermarsi subito resta giusto: non c'è
    // nessuna pane da riportare a fuoco.
    const onTabAck = (e: Event) => {
      if (tabAckReleasesIntent((e as CustomEvent<unknown>).detail)) stop();
    };
    // DEBOUNCED re-assert: a hydrate wave re-runs the focus reconciliation, so
    // we wait for it to go QUIET (no new seq for 400ms) and then re-assert ONCE
    // — matching the stable post-boot open path. Re-asserting on every wave
    // instead flaps the drawer; firing only after the storm settles does not.
    const scheduleReassert = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        // La URL resta la fonte finché c'è: se il drawer l'ha già riportata a
        // '/' (l'utente ha chiuso il task), NON si riapre niente. Il target
        // catturato al boot vale SOLO per un permalink `/tab/`, che nella URL
        // non c'è più per costruzione — l'abbiamo consumato noi.
        const target = currentTabTarget() ?? (BOOT_TAB_PERMALINK ? boot : null);
        if (done || !target) return;
        openTabInApp(target, { notify });
        // UNA sola ri-asserzione per un permalink di TAB, poi si smette.
        // Cintura E bretelle: la tab ha già il suo ack (`topics:tab-opened`) e
        // il suo intento di focus con TTL in usePanelLifecycle, quindi questa
        // ri-asserzione è solo il rinforzo per il caso in cui l'ack tardi. Il
        // deep-link della BOARD invece resta a ciclo aperto: il suo ack arriva
        // dal drawer, che può metterci più di un assestamento, e lì la
        // ri-asserzione è l'unica protezione.
        if (BOOT_TAB_PERMALINK) stop();
      }, 400);
    };
    const unsub = usePaneStore.subscribe((s) => s.lastSeq, scheduleReassert);
    // Il colpo GARANTITO, e il motivo per cui non è più un `setTimeout(0)`.
    //
    // Gli ascoltatori del bus (`topics:open-topic`, `topics:open-terminal-pane`,
    // `topics:open-utility`…) vivono in usePanelLifecycle e al primo giro di
    // effetti non sono ancora registrati, quindi un'apertura al mount è persa:
    // serviva comunque un rinvio. Ma il rinvio giusto non è «un tick» — è LA
    // PRIMA IDRATAZIONE del pane-store (`openTabInAppWhenHydrated`, dove sta la
    // matrice delle cinque configurazioni misurate). Aprire prima è TABLINK-06:
    // il permalink verso una chat GIÀ APERTA che la faceva sparire dalla barra
    // a ~1800ms. Ed è anche concettualmente giusto: il link dice «portami su
    // questa tab», e per sapere se la tab c'è già bisogna aver ricevuto lo
    // stato.
    //
    // Per una rotta `/tab/…` il colpo l'ha già armato `consumeTabLinkFromUrl`
    // (stessa attesa): armarne un secondo vorrebbe dire aprire due volte, ed è
    // la configurazione che TABLINK-06 trova rossa. Quando invece la consume
    // non ha armato niente — `null`, cioè URL già ripulita: è il SECONDO mount
    // di StrictMode in dev — il colpo lo diamo da qui, sul target catturato a
    // livello di modulo. Senza questa distinzione, in dev il permalink non si
    // aprirebbe mai.
    const kick = consumed ?? openTabInAppWhenHydrated(boot, { notify });
    // Drawer opened → the deep-link is fulfilled, stand down.
    window.addEventListener('topics:task-opened', stop);
    // Permalink ARRIVATO (la pane è comparsa) oppure senza destinazione (la tab
    // non esiste più): in entrambi i casi non c'è più niente da ri-asserire, e
    // fermarsi subito evita 8s in cui ogni click viene strattonato indietro.
    window.addEventListener('topics:tab-opened', onTabAck);
    // Boot window only — never yank focus long after load.
    const deadline = setTimeout(stop, 8000);
    return stop;
  }, [isDetached]);
  return null;
}

export default App;
