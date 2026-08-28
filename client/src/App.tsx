import { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense, type ComponentType } from 'react';
import { sweepAskDrafts } from './components/Chat/askDraft';
import { createPortal } from 'react-dom';
import { Settings as SettingsIcon, ChevronDown, Search, Archive, List, RotateCcw, Grid2x2, Hourglass, History } from 'lucide-react';
import { useGlobalBoard } from './hooks/useGlobalBoard';
import { useTaskTopicIndex } from './hooks/useTaskTopicIndex';
import { openTaskInApp } from './lib/openTaskLink';
import { OPEN_SETTINGS_EVENT, type OpenSettingsDetail, type SettingsPanelSection } from './lib/openSettings';
import { runNotificationAction } from './lib/notify/notificationAction';
import { decodeNotifyTarget, openNotifyToken } from './lib/notify/notifyTarget';
import { boardNotificationDeps } from './lib/notify/boardActionDeps';
import { SidebarToggleButton } from './components/Shared/SidebarToggleButton';
import { TooltipDelegate } from './components/Shared/TooltipDelegate';
import { UpdaterToast } from './components/UpdaterToast';
import type { PaneType } from './types';
import { useTopics } from './hooks/useTopics';
import { useT } from './hooks/useT';
import { useChat } from './hooks/useChat';
import { useWebSocket } from './hooks/useWebSocket';
import { TabNotificationProvider } from './hooks/useTabNotifications';
import { useTheme } from './hooks/useTheme';
import { useClaudeSessionState } from './hooks/useClaudeSessionState';
import { TopicsProvider } from './contexts/TopicsContext';
import { useOpenClawAvailable } from './hooks/useOpenClawAvailable';
import { useSplitLayoutAvailable } from './hooks/useSplitLayoutAvailable';
import { useClaudeSkipPermissions } from './hooks/useClaudePrefs';
import { useSidebarState, nextSidebarViewMode } from './hooks/useSidebarState';
import { useSettingsSync } from './hooks/useSettingsSync';
import { useSidebarAndLayout } from './hooks/useSidebarAndLayout';
import { useFloatingVibrancy } from './hooks/useFloatingVibrancy';
import { useSidebarFitCoalesce } from './hooks/useSidebarFitCoalesce';
import { useSidebarFlipPush } from './hooks/useSidebarFlipPush';
import { useSidebarSwipe, mobileDrawerStyle } from './hooks/useSidebarSwipe';
import { isDesktop, isTauri, isTauriWindows } from './lib/shell';
import { selectDirectory } from './lib/shell/app';
import { TOPICS_LABEL_MIN_W_WINDOWS } from './lib/shell/windowControlsGeometry';
import { initDevBundleReload } from './lib/devBundleReload';
import { initDevLayoutProbe } from './lib/devLayoutProbe';
import { initDevHeapProbe } from './lib/devHeapProbe';
import { registerFeatureWeightSources } from './lib/featureWeightSources';
import { initChunkReloadGuard } from './lib/chunkReloadGuard';
import { DevBundleToast } from './components/DevBundleToast';
import { ReloadedFlash } from './components/ReloadedFlash';
import { openTaskFromUrl, currentTaskTarget, subscribeServiceWorkerTaskOpen } from './lib/openTaskLink';
import { subscribeServiceWorkerBanner } from './lib/push/swBridge';
import { InAppBanners } from './components/Notifications/InAppBanners';
import { PushEnrollPrompt } from './components/Notifications/PushEnrollPrompt';
import { consumeTabLinkFromUrl, currentTabTarget, openTabInApp, openTabInAppWhenHydrated, tabAckReleasesIntent } from './lib/tabLink';
import { TAB_PATH_PREFIX, type TabTarget } from '../../shared/tab-link';
import { installOsOpenPathBridge, defaultOsOpenDeps } from './lib/osOpenPath';
import { useDismissable } from './hooks/useDismissable';
import { useSheetDrag } from './hooks/useSheetDrag';
import { SheetGrabber } from './components/Shared/SheetGrabber';
import { POPOVER_SURFACE, POPOVER_MARGIN, POPOVER_SHEET, Z_POPOVER, Z_POPOVER_SCRIM } from './lib/popoverStyles';
import { SidebarSystemMenu } from './components/Sidebar/SidebarSystemMenu';
import { ChangelogModal } from './components/ChangelogModal';

// Tauri-on-macOS chrome parity: like Electron, the traffic lights are HIDDEN by
// default and revealed only while the Topics menu is open (the Rust shell hides
// them on launch; `set_traffic_lights` toggles them). So — same as Electron — no
// permanent left inset is needed; instead, while the menu is open the "Topics"
// label is hidden so the revealed lights occupy that spot.
const isTauriMac = isTauri && typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');
import { useAnimationPause } from './hooks/useAnimationPause';
import { useTerminalLifecycle } from './hooks/useTerminalLifecycle';
import { usePanelLifecycle } from './hooks/usePanelLifecycle';
import { sendBlur } from './lib/focusMessaging';
import { useRefMirror } from './hooks/useRefMirror';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useBrowserContexts } from './hooks/useBrowserContexts';
import { useClosedTabs, createPaneId, isProjectPaneId, getProjectPathFromPaneId, setPaneCapability, newBrowserContextId } from './state/pane/adapters';
import { seedBrowserPaneInitialUrl } from './state/pane/browserPaneUrl';
import { isUtilityPanelType } from './state/pane/adapters/utilityPanelId';

import { TopicTree } from './components/Sidebar/TopicTree';
import { groupChromeActive, isDetachedWindow, firstOtherLiveSpace, tabsPerSpace } from './components/Layout/spaceHelpers';
import { focusSpaceWindow, isSpaceClaimedLocally } from './lib/popOutSpace';
import { useGoToSpace } from './components/Sidebar/useSpaceCards';
import { spaceWindowId } from './lib/windowRole';
import { useSpaceWindows } from './state/windowPresence';
import { SpaceElsewherePanel } from './components/Layout/SpaceElsewherePanel';
import { SplitPositionProvider } from './contexts/SplitPositionContext';
import { ContextMenu } from './components/Modals/ContextMenu';
import { PanelGrid } from './components/Layout/PanelGrid';
import { ToastProvider, ToastOutlet, useToast } from './components/Shared/Toast';
import { PairingApproval } from './components/Auth/PairingApproval';
import { ConfirmProvider } from './hooks/useConfirm';
import { CompletionNotifierBridge } from './hooks/useCompletionNotifier';
import { useVoiceLoop } from './hooks/useVoiceLoop';
import { PendingActionProvider, enqueuePendingAction, tickPendingAction, cancelPendingAction, flushPendingActions } from './contexts/PendingActionContext';
import { DRAG_REGION, NO_DRAG_REGION } from './lib/shell/dragRegion';
import { WindowControls } from './components/Shared/WindowControls';
import { flushPaneStoreNow, flushLocalPaneStoreNow } from './state/pane/middleware';
import { usePaneStore } from './state/pane/store';
import { useShallow } from 'zustand/react/shallow';
import { resolvePaneSpace, isLiveSpaceId } from './state/pane/reducers/spaces';
import { DEFAULT_SPACE_ID } from './state/pane/types';
import { useSignalsSync } from './state/useSignalsSync';
import { useTaskBrowserTabsSync } from './hooks/useTaskBrowserTabsSync';
import { PaneAddMenu } from './components/Shared/PaneAddMenu';
import { GLYPH_KBD_PADDING, RAISED_CONTROL, ROW_INSET, ROW_PX, SIDEBAR_ACTIVE, SIDEBAR_HOVER } from './lib/selectionStyles';
import { initEdgeSwipeGuard } from './lib/edgeSwipeGuard';
import { normalizeTerminalAgent } from './lib/terminalAgents';
import { popOutTopic } from './lib/popOutTopic';
import { ErrorBoundary } from './components/Shared/ErrorBoundary';
import { SkeletonTopicList } from './components/Shared/Skeleton';
import { SidebarStatusBar } from './components/Sidebar/SidebarStatusBar';
import { NotificationHistoryButton } from './components/Sidebar/NotificationHistoryButton';
import { MobileChromeBar } from './components/Sidebar/MobileChromeBar';
import { shortcut, usesCtrl } from './lib/shortcutLabel';
import { useSidebarBottomInset } from './hooks/useSidebarBottomInset';

// Lazy-load components that are only shown on demand
const NewTopicModal = lazy(() => import('./components/Modals/NewTopicModal').then(m => ({ default: m.NewTopicModal })));
const GlobalSettings = lazy(() => import('./components/Settings/GlobalSettings').then(m => ({ default: m.GlobalSettings })));
// Shared factory so the idle prefetch (App mount) and the `lazy()` boundary
// resolve the SAME module — a first ⌘K then finds the chunk already parsed
// instead of paying a ~25–40ms synchronous fetch+eval on the opening frame
// (measured: cold open worst 41.7ms/1 frame >33ms; warmed open worst 9.4ms,
// 0 frames >16.7ms).
// La destrutturazione dentro l'`await` non è stile: è l'unica forma in cui il
// cancello sul codice morto vede QUALI export usi. Un `import()` il cui
// risultato non finisce in un `const { … } =` è opaco per knip, che assume di
// usarli tutti e non può più segnalarne nessuno come morto.
// Guardia: `bun run check:deadcode-blindspots`.
const importCommandPalette = async () => {
  const { CommandPalette: Component } = await import('./components/Shared/CommandPalette');
  return { default: Component };
};
const CommandPalette = lazy(importCommandPalette);
const KeyboardShortcuts = lazy(() => import('./components/Shared/KeyboardShortcuts').then(m => ({ default: m.KeyboardShortcuts })));
const FileSearch = lazy(() => import('./components/Project/FileSearch').then(m => ({ default: m.FileSearch })));
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

// Le tre voci-PAGINA del dropdown «Topics ▾» (Board, «Statistics», «Cron Jobs»)
// stavano qui. Erano il menu «+» con altri nomi: aprire una pagina È aprire una
// pane, e il «+» (⌘N) è il posto che quel mestiere ce l'ha già. Board vi
// compariva DUE volte — aveva già `addableScopes: ['standalone']` — mentre
// Dashboard e Cron esistevano solo lì, con etichette che nessun'altra
// superficie usava. Ora le tre pane hanno `addableScopes` in PANE_CONFIG e si
// aprono da un posto solo, col nome che portano nella tab e nella sidebar.
// Il dropdown resta quello che è davvero: stato della vista, azioni di layout,
// e la porta per Settings.

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
  const tr = useT();
  const [DevOverlay, setDevOverlay] = useState<ComponentType | null>(null);
  useEffect(() => {
    if (import.meta.env.DEV) {
      void (async () => {
        const { MutationLogOverlay } = await import('./state/pane/devOverlay');
        setDevOverlay(() => MutationLogOverlay);
      })();
    }
  }, []);

  // Le bozze del pannello di risposta scadono da sole, ma a una domanda mai
  // risposta non capita nessun altro momento in cui essere ripulita: si spazza
  // all'avvio. Vedi Chat/askDraft.ts.
  useEffect(() => { sweepAskDrafts(); }, []);

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
  /* L'INVENTARIO DEL PESO: chi dichiara cosa. Una registrazione sola, qui, e
   * non sparsa negli store — un elenco che omette in silenzio e' peggio di
   * nessun elenco, perche' chi legge crede di vedere tutto. Vedi
   * `lib/featureWeightSources.ts`.
   *
   * Ha ASSORBITO i due `registerHeapOwner` che stavano qui (`pane.store` e
   * `pane.residency`): erano lo stesso meccanismo con un registro suo, e due
   * elenchi di proprietari divergono al primo che ne aggiorna uno solo. */
  useEffect(() => registerFeatureWeightSources(), []);

  // Click su una web-push (app aperta ma in secondo piano): il service worker
  // mette a fuoco questa finestra e ci passa la destinazione, perché non può
  // navigarla senza ricaricare la SPA. Stessa via dei deep-link `/task/<id>`.
  useEffect(() => subscribeServiceWorkerTaskOpen(), []);
  // Il gemello: con la preferenza «banner in Topics» il service worker NON mostra
  // la notifica di sistema e manda qui il contenuto. Senza questo ascolto quella
  // preferenza sarebbe un modo elaborato di dire «niente notifica».
  useEffect(() => subscribeServiceWorkerBanner(), []);

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
  // Il changelog aperto dal menu del telefono: sul desktop ci si arriva dal
  // numero di versione nella barra di stato, che sotto i 768px non c'è più.
  const [showChangelogFromMenu, setShowChangelogFromMenu] = useState<string | null>(null);

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
  // «Un comando compare dove ha effetto»: sotto i 768px PanelGrid non disegna
  // affatto gli split, quindi i comandi che li governano non si mostrano.
  // La regola — e la misura che la giustifica — sta nell'hook, non qui.
  const splitLayoutAvailable = useSplitLayoutAvailable();
  const { sidebarRef } = layout.refs;
  const {
    toggleSidebar,
    handleSidebarResizeStart,
    handleSidebarDoubleClick,
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
  const sidebarBottomInset = useSidebarBottomInset();

  const FLOAT_SIDEBAR_GAP = 4; // px — keep in sync with index.css --float-gap (2px) ×2
  const expandedPad = sidebarWidth + (appSettings.floatingSplits ? FLOAT_SIDEBAR_GAP : 0);
  // Refs for the FLIP: #main-content owns the committed paddingLeft (imperative, so the layout
  // effect can read the pre-commit position); the inner flip layer carries the translateX.
  const mainContentRef = useRef<HTMLDivElement | null>(null);
  const contentFlipRef = useRef<HTMLDivElement | null>(null);
  useSidebarFlipPush(mainContentRef, contentFlipRef, { collapsed: sidebarCollapsed, expandedPad, enabled: sidebarFixed });
  // IL CASSETTO SEGUE IL DITO (solo mobile): trascinamento vero, non una soglia
  // letta a gesto finito. Vive tutto in `useSidebarSwipe` perché è codice
  // imperativo su `document` — quello che React, coi suoi listener passivi, non
  // può fare.
  useSidebarSwipe({ enabled: isMobile, sidebarRef, collapsed: sidebarCollapsed, setCollapsed: setSidebarCollapsed });
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
  const [searchScope, setSearchScope] = useState<'all' | 'projects' | 'history'>('all');
  const [showNewTopic, setShowNewTopic] = useState<false | { projectPath?: string }>(false);
  const [showSettings, setShowSettings] = useState(false);
  // La sezione da cui aprire le Impostazioni, quando si arriva da un punto
  // preciso (la riga dell'identità → Dispositivi). `undefined` = comportamento
  // normale, cioè «Aspetto».
  const [settingsSection, setSettingsSection] = useState<SettingsPanelSection | undefined>(undefined);
  const [showShortcuts, setShowShortcuts] = useState(false);
  // The deep link into Settings, from anywhere. The identity rows are the only
  // sender today, and they became a PANE when they moved into the Profile tab:
  // a pane cannot reach this state through props, so it asks by event, the same
  // way panes are opened (`topics:open-utility`). See `lib/openSettings`.
  useEffect(() => {
    const handleOpen = (e: Event) => {
      setSettingsSection((e as CustomEvent<OpenSettingsDetail>).detail?.section);
      setShowSettings(true);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, handleOpen);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, handleOpen);
  }, []);
  const [showFileSearch, setShowFileSearch] = useState<false | { projectPaths: string[]; mode: 'name' | 'content' }>(false);
  // The sidebar header "New" button used to track its dropdown via a
  // local `showNewMenu` boolean and a `newMenuBtnRef`. Both moved into
  // <PaneAddMenu> when we unified the three add-menu implementations
  // (top tab bar, sidebar project header, sidebar global header).
  // The yolo-toggle setter lived here while App owned the New menu; it
  // moved into <PaneAddMenu> when we unified, so we only need the
  // current value here for the spawn arg.
  const [claudeSkipPermissions] = useClaudeSkipPermissions();
  // Qui c'era `useClaudeCodeModelSync()`: al boot rileggeva da localStorage il
  // modello di Claude Code e lo ri-applicava al server. Era il default salvato
  // nel posto sbagliato — per-DISPOSITIVO, quindi un altro browser vedeva un
  // altro default — e la ri-applicazione passava da `registerProvider`, che
  // ferma il provider e con lui i processi CLI vivi. Adesso il modello di
  // default è un campo di `app_settings` scritto dalla card del provider: il
  // server è la fonte, cross-device di conseguenza, e nessun boot uccide più
  // una chat in corso.
  const topicsMenuRef = useRef<HTMLDivElement>(null);
  const topicsDropdownRef = useRef<HTMLDivElement>(null);
  const topicsScrimRef = useRef<HTMLDivElement>(null);
  const [topicsMenuPos, setTopicsMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Sotto i 768px questo menu è un foglio dal basso, e un foglio si spinge giù
  // col dito (hooks/useSheetDrag). Sul cartellino del desktop non si applica.
  useSheetDrag({
    enabled: showTopicsMenu && isMobile,
    sheetRef: topicsDropdownRef,
    scrimRef: topicsScrimRef,
    onClose: () => { setShowTopicsMenu(false); },
  });

  // Close topics menu on outside click or Escape (canonical useDismissable
  // contract: capture-phase pointer/touch + Escape). Trigger wrapper + dropdown
  // panel both count as "inside". restoreFocus off to preserve prior behaviour.
  useDismissable({
    open: showTopicsMenu,
    onClose: () => { setShowTopicsMenu(false); },
    refs: [topicsMenuRef, topicsDropdownRef],
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
  const { activeCount: boardTaskCount, byStatus: boardByStatus } = useGlobalBoard(onWSMessage);

  // topicId → task index for dispatched tasks. Un consumatore solo, e apposta:
  // `useCompletionNotifier` è l'unica porta dei banner. Ci mette dentro il
  // taskId (un click apre il drawer del task) e lo legge per NON bannerizzare
  // né la fine turno né i messaggi di un agente di board al lavoro — quelli li
  // annuncia `task:review-ready`.
  const taskForTopic = useTaskTopicIndex();

  // A stable global the native (Tauri) notification delegate can call on click to
  // open a banner's destination. Il percorso web/Electron ci arriva da solo
  // (notifyNative.onclick).
  //
  // Riceve un TOKEN, non un id di task: il guscio trasporta e basta, e la
  // stessa stringa vale per un task (`/task/<id>`) o per un topic
  // (`/topic/<id>`). Prima qui si assumeva «e' sempre un task», quindi ogni
  // banner di chat partiva senza bersaglio e il click alzava solo la finestra.
  // Il nome della globale resta questo perche' e' quello che i gusci gia'
  // installati chiamano: la decodifica sta in lib/notify/notifyTarget.ts.
  useEffect(() => {
    (window as unknown as { __topicsOpenTask?: (id: string) => void }).__topicsOpenTask =
      (id: string) => { openNotifyToken(id); };
    return () => { delete (window as unknown as { __topicsOpenTask?: (id: string) => void }).__topicsOpenTask; };
  }, []);

  // Il gemello del precedente per i TASTI del banner nativo: il delegate Rust
  // legge `actionIdentifier` e chiama qui. Il guscio trasporta, il client
  // esegue — la chiamata vuole sessione, cookie ed endpoint della board, che
  // vivono da questa parte.
  //
  // Il progetto si RISOLVE dall'id invece di viaggiare nella notifica: così un
  // banner ancora appeso in Centro Notifiche resta premibile anche dopo un
  // riavvio dell'app, che è precisamente quando una mappa in memoria avrebbe
  // già dimenticato tutto.
  //
  // A risolvere è `boardApi.resolve` (dentro `boardNotificationDeps`), la porta
  // unica «da un id al suo task, a qualunque profondità». Prima si cercava nel feed globale — che è
  // `rootsOnly`, quindi per un id di SOTTOTASK la find tornava `undefined`, il
  // progetto restava `null` e il tasto ripiegava su «apri il task». Cioè:
  // proprio i banner degli step, che sono la maggioranza di quelli che chiedono
  // una risposta, non facevano mai la loro azione.
  useEffect(() => {
    type ActionGlobal = { __topicsNotificationAction?: (taskId: string, actionId: string) => void };
    (window as unknown as ActionGlobal).__topicsNotificationAction = (taskId: string, actionId: string) => {
      // Il guscio manda lo stesso token del click sul corpo: qui si esegue solo
      // se e' un token di TASK, perche' i tasti sono azioni di board. Un token
      // di topic non porta tasti, ma decodificarlo costa niente e toglie la
      // possibilita' che una chiamata parta con un id che non e' un task.
      const target = decodeNotifyTarget(taskId);
      if (target?.kind !== 'task') return;
      // Le stesse dipendenze che usa il banner in pagina della push `in-app`
      // (`InAppBanners`): due superfici, un esecutore e un cablaggio solo.
      void runNotificationAction(target.id, actionId, boardNotificationDeps());
    };
    return () => { delete (window as unknown as ActionGlobal).__topicsNotificationAction; };
  }, []);

  // Task-owned browser fork → per-task tab store. Consumes the server's
  // `browser:open-task-tab` frame (feature-flagged) so an agent's browser lands
  // in its task's in-drawer group, never the global layout. App-level so it's
  // captured whichever drawer is open. See useTaskBrowserTabsSync.
  useTaskBrowserTabsSync(onWSMessage);

  // Voice loop board: announces a task reaching review out loud and, outside
  // `voiceMode: 'off'` (the default), listens for a spoken reply. No toast
  // context needed (unlike CompletionNotifierBridge below), so it's called
  // directly here instead of through a renderless bridge component. See
  // useVoiceLoop.ts.
  useVoiceLoop({ onWSMessage, settings: appSettings });

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
  // Cron è l'unica pane che richiede OpenClaw, e il suo gate vive in PANE_CONFIG
  // (`requires: 'openclaw'`), non nel menu che la apre: prima era un `.filter`
  // scritto a mano nel dropdown «Topics ▾», cioè un gate valido su UNA
  // superficie. Da qui vale per ogni menu di creazione, presente e futuro.
  //
  // In RENDER e non in un effetto, di proposito: App renderizza prima dei suoi
  // figli, quindi il «+» costruito nello stesso passo vede già il valore nuovo.
  // Un effetto scriverebbe DOPO il commit, e siccome la Set non è stato di
  // React nessuno pianificherebbe il render che la rilegge — la riga Cron
  // resterebbe assente fino al prossimo render capitato per altri motivi.
  // La scrittura è idempotente (StrictMode renderizza due volte) e non tocca
  // stato React, quindi non innesca cicli.
  setPaneCapability('openclaw', openclawAvailable);
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
  // In quale gruppo vive ciascuna pane aperta. Ci si iscrive al RISULTATO (un
  // array di stringhe, con `useShallow`) e non a `s.panes`: quello cambia
  // identità a ogni scrittura di pane — `setPaneScrollOffset` ne fa una ogni
  // 250 ms mentre scorri una chat — e ridisegnerebbe la sidebar per un dato
  // che nessuno di questi due guarda.
  const paneSpaces = usePaneStore(
    useShallow((s) => openPanels.map((id) => resolvePaneSpace(s.panes[id], s.spaces))),
  );
  const paneSpaceById = useMemo(
    () => new Map(openPanels.map((id, i) => [id, paneSpaces[i]])),
    [openPanels, paneSpaces],
  );
  // I gruppi che vivono in una finestra loro. Serve due volte, e la prima è
  // qui sotto: un gruppo staccato conta come "c'è" anche quando è a zero tab.
  const spaceWindows = useSpaceWindows();
  // Vero quando l'intestazione del gruppo c'è: allora l'albero si divide in
  // "le tab di questo gruppo" e "fuori dai gruppi". Stessa risposta che dà
  // SpaceGroups per decidere se disegnarsi.
  //
  // Il selettore restituisce un BOOLEANO, quindi iscriversi qui a `s.panes` non
  // ridisegna niente finché la risposta non cambia — la mappa dei conteggi
  // nasce e muore dentro la chiamata.
  const spaceChrome = usePaneStore((s) => groupChromeActive(
    s.spaces,
    spaceWindowId(),
    tabsPerSpace(s.groups['group:default']?.paneIds ?? [], s.panes, s.spaces),
    spaceWindows,
  ));
  const goToSpace = useGoToSpace();
  // Il gruppo attivo vive in un'ALTRA finestra? Allora qui non si disegna: due
  // finestre sulla stessa griglia sono due copie degli stessi terminali vivi.
  const activeSpaceWindow = spaceWindows.get(activeSpaceId);
  // ── Il gruppo vive di là: NON si fa vedere un cartello, ci si sposta ──────
  // La cosa giusta da fare quando questa finestra si ritrova addosso un gruppo
  // che ha già una casa è farlo vedere DOVE VIVE: si porta davanti la sua
  // finestra e ci si mette su un altro gruppo (uno LIBERO — mandarsi su un
  // altro gruppo staccato sarebbe un rimbalzo). Il pannello resta solo per il
  // caso in cui non ci sia nessun altro posto dove andare.
  //
  // Non in una finestra-GRUPPO: lì il gruppo è il suo, e la presenza esclude sé
  // stessa — se scattasse, la finestra scapperebbe da casa propria.
  const pinnedSpaceForHandoff = spaceWindowId();
  useEffect(() => {
    if (!activeSpaceWindow || pinnedSpaceForHandoff) return;
    // Se l'utente ha detto "lo voglio qui" (il ripiego di un clic sulla card,
    // quando quella finestra non rispondeva), la presenza vecchia non lo
    // rimanda indietro.
    if (isSpaceClaimedLocally(activeSpaceId)) return;
    void focusSpaceWindow(activeSpaceWindow);
    const store = usePaneStore.getState();
    const next = firstOtherLiveSpace(store.spaces, activeSpaceId, spaceWindows);
    if (next) store.dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: next } });
  }, [activeSpaceWindow, activeSpaceId, pinnedSpaceForHandoff, spaceWindows]);

  // ── Il gruppo su cui sei si è svuotato: si torna a casa ───────────────────
  // Un gruppo a zero tab non si disegna più (`useSpaceCards`), e restarci
  // dentro sarebbe il vicolo cieco: griglia vuota, e nessuna card da cliccare
  // per uscirne — proprio perché la sua non c'è più. Chiusa o portata via
  // l'ultima tab, la finestra torna al Principale.
  //
  // I due `usePaneStore` qui restituiscono BOOLEANI: iscriversi a `s.panes`
  // costa un confronto per scrittura, non un ridisegno.
  const activeSpaceHasTabs = usePaneStore((s) => (
    (tabsPerSpace(s.groups['group:default']?.paneIds ?? [], s.panes, s.spaces).get(s.activeSpaceId) ?? 0) > 0
  ));
  // Il gruppo attivo è un record VIVO della registry? Se no, la registry non è
  // ancora arrivata (all'avvio `activeSpaceId` si ripristina da localStorage
  // prima dello snapshot): senza questa guardia ogni ricarica dentro un gruppo
  // finirebbe nel Principale.
  const activeSpaceLive = usePaneStore((s) => isLiveSpaceId(s.activeSpaceId, s.spaces));
  useEffect(() => {
    if (pinnedSpaceForHandoff) return;      // la finestra-gruppo È il suo gruppo
    if (activeSpaceWindow) return;          // ci pensa l'effetto qui sopra
    if (activeSpaceId === DEFAULT_SPACE_ID) return;
    if (!activeSpaceLive || activeSpaceHasTabs) return;
    usePaneStore.getState().dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: DEFAULT_SPACE_ID } });
  }, [activeSpaceId, activeSpaceHasTabs, activeSpaceLive, activeSpaceWindow, pinnedSpaceForHandoff]);

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

  /**
   * «Crea questa cosa nel contesto standalone». UNO, e lo prendono sia la
   * palette ⌘N sia le pill di ⌘K: prima ⌘K aveva le sue callback separate
   * (onNewClaude/onNewCodex/onNewTerminal) e infatti offriva un insieme
   * DIVERSO — niente opencode, niente Browser, niente Board.
   */
  /**
   * Il perimetro di ricerca: progetto a FUOCO per primo, poi gli altri aperti
   * come tab. Stessa regola di ⌘F/⌘P in `useKeyboardShortcuts` — qui serve alla
   * voce «Cerca nei file» della palette ⌘K, che deve aprire la stessa cosa che
   * apre il tasto, non una versione ristretta.
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
      // Le pane UTILITY: id fisso (`__board__`, `__dashboard__`, `__cron__`,
      // `__profile__`) e quindi non `createPaneId`, che ne sorteggerebbe uno
      // nuovo a ogni apertura — la seconda tab della stessa pagina.
      // `handleOpenAsPage` è l'unica porta che conosce quella forma.
      //
      // Il predicato viene dall'INSIEME canonico (`UTILITY_PANEL_TYPES`) e non
      // da tre `===` scritti a mano, che è come stava e come si è già rotto due
      // volte: il ramo elencava il solo `board` finché Dashboard e Cron
      // arrivavano dal dropdown «Topics ▾», e le loro righe nel «+»
      // comparivano senza fare NIENTE. Profilo sarebbe stata la terza volta.
      handleOpenAsPage(type);
    }
  }, [handleQuickCreateTerminal, claudeSkipPermissions, openBrowserPane, handleOpenAsPage]);

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
    const handler = () => { handleQuickCreateTopic(); };
    window.addEventListener('topics:new-chat', handler);
    return () => window.removeEventListener('topics:new-chat', handler);
  }, [handleQuickCreateTopic]);

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
  // Una tab fissata SI CHIUDE come tutte le altre.
  //
  // Il 03/08 il pin era un lucchetto: chiudere è un ritiro (la chat si
  // archivia, la sessione si ritira), quindi fissare doveva poter dire «questa
  // no», e il divieto stava qui sull'AZIONE per coprire anche tastiera, tasto
  // centrale e «chiudi le altre». Rovesciato il 06/08 (Attilio): «le tab
  // pinnate dovrebbero essere comunque chiudibili ma restano pinnate e quindi
  // riapribili finché non togli il pin».
  //
  // Regge senza il lucchetto perché il ritiro non cancella niente: la chat si
  // archivia, ma l'escape `pinnedIds` di buildSidebarItems tiene la sua tessera
  // fra i Fissati anche archiviata, e riaprirla la disarchivia. Il pin torna
  // quello che sembra — una scorciatoia che resta — invece di chiedere di
  // smontare la scorciatoia per fare la cosa più comune che ci si fa.

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
  }, [topics, handleClosePanel, enqueueAndTick, focusedPanelId, visiblePanels, handleFocusPanel]);

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
  /**
   * «Sfissare questa chat la archivia anche?» — la domanda che il menu deve
   * poter fare PRIMA di scrivere la sua etichetta.
   *
   * È la condizione esatta di `handleTogglePin` qui sotto, estratta e non
   * ricopiata: due copie divergono, e una voce di menu che promette meno di
   * quello che fa è lo stesso difetto dell'anteprima del drag che prometteva
   * una riga poi cancellata.
   */
  const unpinAlsoArchives = useCallback((id: string): boolean => {
    if (
      !sidebarIsPinned(id) ||
      id.startsWith('project:') ||
      id.startsWith('terminal:') ||
      id.startsWith('browser:')
    ) return false;
    const topic = topics[id];
    if (!topic || topic.archived) return false;
    const chatPaneId = createPaneId('chat', id);
    const openTopLevel = openPanels.includes(id);
    const openInLiveProject = Object.entries(projectOpenPanes).some(([pp, ids]) =>
      (ids.includes(chatPaneId) || ids.includes(id)) &&
      openPanels.includes(createPaneId('project', pp)),
    );
    return !openTopLevel && !openInLiveProject;
  }, [sidebarIsPinned, topics, openPanels, projectOpenPanes]);
  const handleTogglePin = useCallback((id: string) => {
    // Chat-only unpin-while-closed archive semantics. Projects (`project:<path>`),
    // terminals (`terminal:<id>`) and browsers (`browser:<ctx>`) don't archive on
    // unpin — none is an archivable topic record — so those prefixes skip this
    // branch and just toggle the pin. (A bare topicId has no prefix → chat.)
    if (unpinAlsoArchives(id)) void archiveTopic(id, true);
    sidebarTogglePin(id);
  }, [unpinAlsoArchives, sidebarTogglePin, archiveTopic]);

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

  // Lo swipe dai bordi non naviga più (solo PWA iOS): vedi `edgeSwipeGuard`,
  // che spiega anche perché non si passa dalla cronologia e quale prezzo si
  // paga sui comandi che vivono sul bordo.
  useEffect(() => initEdgeSwipeGuard(), []);

  // I DUE COMANDI DELLA COLONNA, definiti UNA volta e montati dove serve.
  //
  // Col mouse stanno in testa alla sidebar, accanto al titolo; col dito in
  // fondo, dove arriva il pollice (Attilio, 07/08). Due copie del JSX sarebbero
  // due bottoni che aprono la stessa cosa e divergono al primo ritocco — è
  // esattamente come sono nati i menu doppi che questa passata ha tolto.
  // Cambia solo la MISURA: 44px col dito, 28 col mouse.
  const sidebarSearchButton = (
    <button
      onClick={() => { setSearchScope('all'); setShowSearch(true); }}
      className={`edge-lit ${isMobile ? 'h-11 w-11 justify-center' : 'h-7'} flex items-center gap-1.5 rounded-lg ${RAISED_CONTROL} text-app-text transition-colors flex-shrink-0 cursor-pointer app-no-drag`} {...NO_DRAG_REGION}
      style={{ pointerEvents: 'auto', ...(isMobile ? null : GLYPH_KBD_PADDING) }}
      title={`Search (${shortcut('K')})`}
      aria-label="Search, open the command palette"
    >
      {/* 16 e non 14: accanto a un'icona di sistema (il «+» di WhatsApp è il
          metro che Attilio ha usato) un glifo da 14 in una scatola da 28 legge
          come mezzo comando. Sedici riempie la scatola senza toccarne i bordi. */}
      <Search size={isMobile ? 20 : 16} className="flex-shrink-0" aria-hidden="true" />
      {/* Col dito niente etichetta: il bottone sta ACCANTO al titolo, in una
          riga dove ogni pixel orizzontale è conteso, e la lente da sola si
          legge. L'etichetta serviva alla barra in fondo, dove i due comandi
          erano soli in mezzo a una fascia larga. */}
      {/* `shortcut('K')` and not the glyph written out: the `title` two lines up
          is already per-platform, this one was pinned to "⌘K" — so on Windows
          the button said "Ctrl+K" on hover and "⌘K" on its face, naming a key
          that machine does not have.
          AND NOT SHOWN AT ALL WHERE THE MODIFIER IS Ctrl, because there the
          hint costs more than the row has. The sidebar is 255px and the sums
          are these: "⌘K"/"⌘N" leave 242px of content in 243 available, while
          "Ctrl+K"/"Ctrl+N" ask for 280 — 37px that have to come from somewhere,
          and they came from the notification bell, pushed out of its own group
          and underneath the `z-50` one, where it stopped taking clicks (twelve
          `notification-history` reds on Linux CI, measured 2026-08-26). The
          `title` keeps saying it on hover, in full and in the right words. */}
      {!isMobile && !usesCtrl && <kbd className="kbd flex-shrink-0 hidden md:inline">{shortcut('K')}</kbd>}
    </button>
  );
  const sidebarAddMenu = (
    <PaneAddMenu
      scope="standalone"
      presentation="palette"
      onNewChat={() => handleQuickCreateTopic()}
      onAddPane={handleStandaloneAddPane}
      triggerTitle={`New (${shortcut('N')})`}
      triggerVariant="header"
      // Same reason as the `<kbd>` of Search just above: where the modifier is
      // Ctrl the hint does not fit in the row, and the `title` already says it.
      triggerKbd={usesCtrl ? undefined : shortcut('N')}
    />
  );

  // LA BOARD SI APRE DA UN POSTO SOLO. La riga della sidebar e la porta in
  // fondo al telefono chiamano QUESTA funzione: due copie dello stesso gesto
  // (porta prima la finestra dov'è la sua tab, poi apri) divergono al primo
  // ritocco, e la prima cosa che si perde è il `goToSpace` — cioè la board si
  // aprirebbe in un gruppo che non stai guardando.
  const handleOpenBoard = useCallback(() => {
    const boardSpace = paneSpaceById.get('__board__');
    if (boardSpace) goToSpace(boardSpace);
    handleOpenAsPage('board');
  }, [paneSpaceById, goToSpace, handleOpenAsPage]);

  // La sezione «Board» della tray: una riga di stato apre QUEL task (stesso
  // deep-link del click su una notifica, quindi stesso atterraggio), la testa
  // della sezione apre la board dalla PORTA UNICA qui sopra — che è anche
  // l'unica che porta la finestra nel gruppo dove la board vive. Il mestiere
  // resta di qua: la tray dice COSA, il client sa COME.
  useEffect(() => {
    const onTask = (e: Event) => {
      const taskId = (e as CustomEvent<{ taskId?: string }>).detail?.taskId;
      if (taskId) openTaskInApp({ taskId });
    };
    const onBoard = () => { handleOpenBoard(); };
    window.addEventListener('topics:tray-open-task', onTask as EventListener);
    window.addEventListener('topics:tray-open-board', onBoard);
    return () => {
      window.removeEventListener('topics:tray-open-task', onTask as EventListener);
      window.removeEventListener('topics:tray-open-board', onBoard);
    };
  }, [handleOpenBoard]);

  // L'INTERRUTTORE DELLA FILA IN BASSO — board ⇄ lista.
  //
  // «Davanti» vuol dire due cose insieme: la board è la pane a fuoco E il
  // cassetto è chiuso. Guardare solo il fuoco farebbe leggere «Tab» sul tasto
  // mentre a schermo c'è già la lista, cioè il tasto direbbe di portare dove
  // sei — e il click successivo non avrebbe niente da fare.
  const boardInFront = isMobile && sidebarCollapsed && focusedPanelId === '__board__';
  const handleMobileBoardToggle = useCallback(() => {
    if (boardInFront) setSidebarCollapsed(false);
    else { handleOpenBoard(); setSidebarCollapsed(true); }
  }, [boardInFront, handleOpenBoard, setSidebarCollapsed]);

  // THE FOCUS THAT LEAVES A CHAT MUST REACH THE SERVER, not only the one that
  // enters it.
  //
  // `sendFocusTopic` fires when a chat BECOMES active (ChatPanel, ChatPane), and
  // `sendBlur` lived in exactly one place: inside a project, when the active
  // pane is not a chat (`ProjectWindow`). At app level that twin was missing, so
  // moving from a chat to a top-level NON-chat pane — the board, a terminal, a
  // browser — sent nothing, and for the server the last chat looked at was still
  // the one in front.
  //
  // This is not cosmetic. After `SEEN_DWELL_MS` that chat enters `seenTopicRef`,
  // and from there every `unread:updated{n>0}` about it is RE-MARKED READ on the
  // spot (`useWebSocket`, the "a message arrived while you were already reading"
  // branch). Measured with two chats open and focus moved to the board: the
  // first chat never raises the badge (delta 0), the second does (delta 1). So a
  // turn finishing on a chat you are not watching can leave no trace on the
  // dock, and WHICH chat loses the count depends on which tab was opened first.
  //
  // It is also what turned MUTE-01 red on the full run: the test sends two
  // unreads and sees one arrive — "expected 5, received 4".
  //
  // The condition is the same one `ProjectWindow` uses: active pane is not a chat
  // => blur. Project panes stay with the inner handler, which knows which chat is
  // active INSIDE the project and sends its focus.
  const focusedIsChat = !!focusedPanelId && !!topics[focusedPanelId];
  useEffect(() => {
    if (focusedPanelId && !focusedIsChat && !focusedProjectPath) sendBlur(sendWS);
  }, [focusedPanelId, focusedIsChat, focusedProjectPath, sendWS]);

  return (
    <TopicsProvider topics={topics} terminalSessions={terminalSessions} terminalRosterAuthoritative={terminals.rosterAuthoritative} workspaceProjects={workspaceProjects}>
    <TabNotificationProvider unreadData={unreadData} onWSMessage={onWSMessage} openPanels={openPanels} focusedPanelId={focusedPanelId}>
    <SplitPositionProvider>
    <ToastProvider>
    <ConfirmProvider>
    {/* IL TOOLTIP DELL'APP, per TUTTA l'app. Un delegato solo che intercetta
        ogni `title=` esistente (erano 422) e lo rende col componente di
        design invece che col rettangolo del sistema operativo: stessi colori,
        piu' righe, e soprattutto compare in 350 ms invece che dopo il ritardo
        del sistema, che su macOS supera il secondo. L'attributo viene
        RIMESSO all'uscita, quindi i lettori di schermo continuano a trovarlo
        dove lo cercano. Vedi `Shared/TooltipDelegate.tsx`. */}
    <TooltipDelegate />
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
      isOwnStream={isOwnStream}
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
    <PairingApproval />
    <InAppBanners />
    <PushEnrollPrompt />
      <div
      // NB: the landing demo (client/src/demo/landing-cursor.js, scene
      // "floating") toggles `.floating-splits` on THIS element from outside
      // React, to show the mode on the marketing site. That works only because
      // on web `isDesktop` is false, so this template string is constant
      // between renders and React never rewrites the attribute. Add anything
      // dynamic here and the demo chapter goes quietly dead — nothing breaks,
      // it just stops showing what it claims to show.
      className={`flex bg-app-bg overflow-hidden max-w-[100vw] ${appSettings.floatingSplits && isDesktop ? 'floating-splits' : ''}`}
      style={{
        fontSize: `${appSettings.fontSize}px`,
        // La misura di lettura della chat viaggia come variabile, non come
        // classe: la classe qui sopra DEVE restare costante fra i render (lo
        // dice il commento), e una variabile in `style` non la tocca. La legge
        // l'utility `chat-measure` — un posto solo per quattro punti che
        // devono restare allineati.
        '--chat-measure': appSettings.chatMaxWidth > 0 ? `${appSettings.chatMaxWidth}px` : 'none',
        // LA BANDA DELLA FILA IN BASSO, riservata UNA volta per tutti.
        // L'altezza la pubblica la barra stessa (`--mobile-chrome-h`, vedi
        // MobileChromeBar): qui si legge e basta. Vale 0px quando la barra non
        // c'è — desktop, o tastiera aperta — quindi non c'è nessun ramo, e
        // niente cambia fuori dal telefono. Senza questa riga la fila
        // coprirebbe l'ultimo messaggio della chat e il composer.
        paddingBottom: 'var(--mobile-chrome-h, 0px)',
        position: 'fixed',
        top: viewportHeight != null ? `${viewportTop}px` : 0, left: 0, right: 0,
        bottom: viewportHeight != null ? undefined : 0,
        height: viewportHeight != null ? `${viewportHeight}px` : undefined,
      } as React.CSSProperties}
    >
      {/* Skip to main content link for keyboard users */}
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:bg-primary focus:text-white focus:px-4 focus:py-2 focus:rounded-lg focus:text-sm">
        Skip to main content
      </a>
      {/* IL VELO del cassetto mobile. Sta montato SEMPRE (su mobile) e a riposo
          lo spegne il CSS — `.sidebar-scrim[data-open="false"]` è opacità 0,
          `visibility: hidden` e niente click. Prima si montava e smontava con
          lo stato: durante il trascinamento della colonna (useSidebarSwipe) non
          esisteva ancora, e compariva tutto insieme a gesto finito — cioè lo
          scatto che il trascinamento serve a togliere. Adesso il gesto gli
          scrive l'opacità in linea frame per frame, e a fine corsa la cancella
          restituendo la decisione al CSS. */}
      {isMobile && (
        <div
          data-sidebar-scrim
          data-open={!sidebarCollapsed}
          className="fixed inset-0 bg-black/50 z-40 sidebar-scrim"
          onClick={() => setSidebarCollapsed(true)}
          aria-hidden="true"
        />
      )}
      
      {/* Sidebar */}
      <div
        ref={sidebarRef}
        role="navigation"
        aria-label="Topics sidebar"
        // `group/sidebar`: alcune affordance della sidebar si accendono solo
        // quando ci passi sopra (il "+" dei gruppi in fondo). Il gruppo di
        // hover sta QUI e non sulla singola barra perché il bersaglio nascosto
        // sarebbe altrimenti impossibile da trovare: entri nella sidebar e il
        // controllo c'è.
        // `bg-app-chrome`, non `bg-surface`: la sidebar è CHROME, e il chrome
        // arretra sotto la pagina invece di stare sopra. Era `bg-surface`
        // (#fff / #181a20), cioè più CHIARA della pagina — su iPhone lasciava
        // un gradino verso la barra di stato nera di iOS, e la fascia in cima
        // cambiava tinta aprendo e chiudendo la sidebar. Il token porta con sé
        // anche la trasparenza sulla shell mac: vedi --chrome-bg in index.css.
        // UN'OMBRA SEPARA DUE PIANI, UN FILO SEPARA DUE ZONE DELLO STESSO PIANO.
        //
        // Su desktop la sidebar è `fixed` sopra il contenuto e proiettava uno
        // `shadow-2xl`: venticinque pixel di sfumatura stesi SUL contenuto.
        // Finché le due superfici avevano tinte diverse quella sfumatura si
        // leggeva come profondità. Da quando il velo è uno solo hanno lo stesso
        // pixel — misurato: sidebar #191b1e, contenuto #191b1e — e l'ombra resta
        // l'unica cosa in mezzo: una banda scura senza bordo netto, che si legge
        // come una spaziatura doppia e come una terza tinta (#17191c a x=211,
        // che risale a #191b1e solo a x=236). «Non hanno bordo, c'è una doppia
        // spaziatura e i colori non sono uguali» (Attilio, 09/08): sono tre
        // sintomi di una cosa sola.
        //
        // Con le pane FLOTTANTI l'ombra è giusta e resta: lì la sidebar sta
        // davvero su un piano diverso, staccata dal suo gap. Senza, i due piani
        // sono uno, e ciò che serve è un confine — un pixel, non venticinque.
        className={`group/sidebar bg-app-chrome flex flex-col flex-shrink-0 sidebar-transition overflow-hidden ${
          isMobile ? 'fixed inset-y-0 left-0 z-50 w-full'
            : `fixed inset-y-0 left-0 z-40 ${appSettings.floatingSplits ? 'shadow-2xl' : 'border-r border-app-border'}`
        }`}
        style={{
          // Non-mobile: the sidebar is position:fixed with a CONSTANT width and collapses
          // via a composited translateX, so the content area never resizes on toggle — the
          // reveal is the FLIP push on #main-content (useSidebarFlipPush). Mobile is a
          // full-width drawer that slides the same way.
          //
          // Su mobile le due misure arrivano da `mobileDrawerStyle`, che è la
          // stessa funzione con cui `useSidebarSwipe` rimette la colonna a posto
          // dopo un trascinamento: React e il gesto scrivono lo STESSO elemento,
          // e due copie delle stesse stringhe divergerebbero al primo ritocco.
          width: isMobile ? mobileDrawerStyle(sidebarCollapsed).width : `${sidebarWidth}px`,
          transform: isMobile
            ? mobileDrawerStyle(sidebarCollapsed).transform
            : (sidebarCollapsed ? 'translateX(-100%)' : 'translateX(0)'),
          // Safe-area top inset applied UNCONDITIONALLY: env() self-zeroes when
          // there's no inset (desktop, non-notched), so gating it on isPWA was
          // the bug that left content clipped under the notch when the app is
          // opened in a plain mobile browser tab (e.g. over Tailscale, where
          // display-mode is 'browser', not 'standalone'). The mobile sidebar is
          // `position: fixed inset-y-0`, so it escapes the root and needs its own.
          paddingTop: 'env(safe-area-inset-top, 0px)',
          // La colonna è `fixed inset-y-0`: sfugge al padding della radice,
          // quindi la banda della fila in basso se la riserva da sé. Stessa
          // variabile, stesso valore, un posto solo a deciderlo.
          paddingBottom: 'var(--mobile-chrome-h, 0px)',
        }}
      >

        
        {/* Header - draggable for window move. Horizontal inset = ROW_INSET,
            the same 6px the tab strip, the sidebar cards, and the list's
            vertical padding use — one inset on every sidebar axis. */}
        <div
          // L'ALTEZZA SEGUE I BOTTONI, non il contrario. Col dito i due comandi
          // sono 44px (la soglia iOS) e la riga era 48: 2px sopra e 2 sotto,
          // cioè «i tasti toccano il bordo». 44 + 2 × ROW_INSET = 56 (`h-14`) e
          // il respiro torna quello di tutta la colonna — lo STESSO 6px che
          // separa una card dal bordo e una riga dalla sua vicina. Col mouse i
          // bottoni sono 28 e la riga resta 40, che è la stessa identità:
          // 28 + 2 × 6 = 40.
          // NIENTE FILO SOTTO L'HEADER (Attilio, 08/08). Sopra e sotto c'è la
          // stessa superficie — la colonna è chrome dall'alto in basso — quindi
          // quella riga non separava due cose: ne disegnava il confine e basta.
          // A dire dove finisce l'header ci pensano già i due comandi, che hanno
          // un fondo proprio, e la prima card della lista, che è rientrata di 6.
          //
          // Nota per chi torna qui: la stessa cosa NON vale per il filo sotto la
          // tabbar delle pane. Là ho misurato — barra e contenuto hanno lo
          // STESSO fondo in tutte e quattro le combinazioni (telefono/desktop ×
          // chiaro/scuro), quindi quel filo è l'unica separazione che esiste e
          // toglierlo fonde le due zone. Qui invece l'header ha dentro di sé di
          // che farsi riconoscere.
          className={`flex items-center justify-between flex-shrink-0 app-drag-region ${isMobile ? 'h-14' : 'h-10'}`} {...DRAG_REGION}
          style={{ paddingRight: ROW_INSET, paddingLeft: ROW_INSET, gap: ROW_INSET }}
        >
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {/* NIENTE «X» accanto al titolo. Il cassetto mobile si chiude da
                solo appena apri qualcosa (`if (isMobile) setSidebarCollapsed(true)`,
                una dozzina di punti in usePanelLifecycle) e trascinandolo verso
                sinistra col dito (`useSidebarSwipe`) — quindi la crocetta non era l'uscita, era
                una terza copia della stessa uscita, messa dove l'occhio cerca il
                titolo. Costava anche la colonna: `w-10 -ml-1 mr-1` + il `gap-2`
                del contenitore spingevano «Topics» a x=60, cioè 46px più a
                destra del nome delle righe qui sotto (x=14). Tolta, il titolo
                torna in colonna con loro. */}
            {/* Topics button - opens combined settings & tools menu */}
            {/* `relative`: THE WINDOW COMMANDS ARE ANCHORED HERE. On Windows
                they come out over this button when the menu opens, exactly where
                the Mac's traffic lights come out (`trafficLightPosition`
                { x: 12, y: 12 }, i.e. ROW_INSET into this wrapper) — see
                WindowControls. They are absolute, so they add nothing to this
                row: `h-10` stays `h-10` whether they are lit or not. */}
            <div className="app-no-drag relative" {...NO_DRAG_REGION} ref={topicsMenuRef}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!showTopicsMenu) {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setTopicsMenuPos({ top: rect.bottom + 4, left: rect.left });
                  }
                  setShowTopicsMenu(!showTopicsMenu);
                }}
                // ROW_PX, non `px-1.5` scritto a mano: è lo stesso rientro
                // interno di ogni riga della sidebar, e serve perché «Topics»
                // e i nomi delle chat stiano sulla STESSA colonna. Misurato
                // (390×844 e 1280×800): la card di una riga parte da
                // ROW_INSET=6 e il suo testo da 6+8=14; il bottone parte da 6
                // (il paddingLeft dell'header) e con px-1.5 il titolo cadeva a
                // 12 — 2px a sinistra dei nomi sotto, il near-miss che si legge
                // peggio di una differenza netta. Con ROW_PX il titolo va a 14
                // e il rialzo dell'hover resta a filo col bordo delle card.
                // L'ALTEZZA LA DETTA LA RIGA, e la riga la dettano i suoi
                // comandi: `h-14` col dito attorno a bottoni da 44, `h-10` col
                // mouse attorno a bottoni da 28 (vedi il commento dell'header).
                // Il titolo non seguiva né l'una né gli altri: `min-h-7` fisso,
                // che col testo a 17px diventa 29,5 dentro una riga da 56 —
                // misurato. Effetto: il suo rialzo finiva 13px sopra il fondo
                // della riga mentre Cerca e «+», lì accanto, ci arrivano a 6.
                // Da lontano legge come spazio in più sotto l'header, ed è metà
                // della «doppia spaziatura» che si vedeva sul telefono. Di
                // rimbalzo il bersaglio del menu passa da 29,5 a 44, cioè alla
                // soglia che ogni altro comando di questa riga rispetta già.
                // `isMobile` e non `md:`: nell'header decide quel predicato,
                // e due meccanismi nella stessa riga divergono (è il difetto
                // appena tolto dalla barra delle tab).
                className={`flex items-center min-w-0 ${isTauriMac ? 'gap-2' : 'gap-1'} ${ROW_PX} py-0.5 ${isMobile ? 'min-h-11' : 'min-h-7'} rounded-lg transition-colors cursor-pointer ${
                  // Rialzo in ALPHA, non `bg-app-hover`: questo bottone sta sul
                  // chrome, e un opaco tarato su `--bg-surface` lì va nel verso
                  // sbagliato in tema chiaro. Vedi SIDEBAR_HOVER.
                  showTopicsMenu ? SIDEBAR_ACTIVE : SIDEBAR_HOVER
                }`}
                style={{ pointerEvents: 'auto' }}
                title="Settings & Tools"
                // Un appiglio stabile per il bottone del titolo: il suo NOME
                // accessibile è «Topics» (il testo), non il `title`, quindi
                // cercarlo per ruolo+nome vuol dire cercarlo per una parola che
                // compare in mezza colonna. È lo stesso motivo per cui le righe
                // di progetto hanno `project-toggle-*`.
                data-testid="sidebar-topics-menu"
              >
                {/* Room for the window commands on Windows. Why it is declared
                    and not inherited from a glyph: `windowControlsGeometry.ts`. */}
                <span className={`font-semibold text-app-text tracking-[-0.01em] truncate ${isMobile ? 'text-[17px]' : 'text-[15px]'} ${isTauriWindows ? TOPICS_LABEL_MIN_W_WINDOWS : ''} ${(isTauriMac || isTauriWindows) && showTopicsMenu ? 'invisible' : ''}`}>Topics</span>
                {/* 14, come il glifo di «Cerca» e del «+» che gli stanno accanto sulla
                    STESSA riga — misurato: era 12 contro i loro 14, e il raggio
                    6 contro 8. Tre elementi affiancati con tre forme diverse
                    non sono tre stili, sono un difetto: Aggiungi e Cerca sono
                    il riferimento (Attilio, 08/08). */}
                <ChevronDown size={14} className={`text-app-text-secondary transition-transform ${showTopicsMenu ? 'rotate-180' : ''}`} />
              </button>
              {/* The window commands, and ONLY on Windows: there the system frame
                  is off (the app draws its own) and without these there would be
                  no way left to minimise, maximise or close except through the
                  taskbar. They sit HERE, over the button, and not at the end of
                  the row: on macOS the component renders nothing because those
                  commands are the traffic lights, and the shell paints them over
                  this exact spot. Same place on both systems, same order.
                  A SIBLING of the button and not a child: a button inside a
                  button is invalid HTML, and the browser would take the nesting
                  apart on its own. */}
              <WindowControls visible={showTopicsMenu} />
            </div>
            {/* COL MOUSE STA ACCANTO A TOPICS, e non in coda alla riga con
                Cerca e «+»: quei due sono comandi che CREANO o CERCANO, questo
                è uno stato — dice quante cose sono successe mentre non
                guardavi. Sta a fianco dell'identità della colonna perché è la
                prima cosa che si guarda tornando all'app.
                COL DITO NO: sul telefono la riga in alto ha «Topics» a sinistra
                e la campanella a DESTRA (Attilio, 14/08), che è il lato dove il
                telefono tiene lo stato in ogni app che si apre — e dove Cerca e
                «+» non sono più, essendo scesi nella fila in fondo. Lo stesso
                bottone, montato dall'altra parte: il pannello si àncora al
                rettangolo del trigger e si tiene dentro lo schermo da sé. */}
            {!isMobile && (
              <div className="app-no-drag flex-shrink-0" {...NO_DRAG_REGION}>
                <NotificationHistoryButton
                  onWSMessage={onWSMessage}
                  isMobile={isMobile}
                  onOpenSettings={() => { setSettingsSection('notifications'); setShowSettings(true); }}
                />
              </div>
            )}
          </div>

          {isMobile && (
            <div className="app-no-drag flex-shrink-0" {...NO_DRAG_REGION}>
              <NotificationHistoryButton
                onWSMessage={onWSMessage}
                isMobile
                onOpenSettings={() => { setSettingsSection('notifications'); setShowSettings(true); }}
              />
            </div>
          )}
          {/* CERCA E «+», in coda alla riga del titolo.
              Hanno girato: erano qui, sono finiti in una barra in fondo alla
              colonna sul telefono (geometria giusta per il pollice, prezzo
              sbagliato — due comandi staccati dalla cosa che comandano), poi
              attaccati al logo, e ora tornano allineati a destra, che è dove
              l'occhio cerca le scorciatoie. Sono sempre gli STESSI due bottoni,
              definiti una volta in App: cambia solo la misura, 44px col dito e
              28 col mouse. */}
          {/* SUL TELEFONO IN ALTO NON C'È NIENT'ALTRO.
              «Da un lato topics, cliccabile; dall'altro nient'altro» (Attilio,
              12/08). Cerca e «+» non spariscono: scendono nella fila in fondo
              (`MobileChromeBar`), dove arriva il pollice e dove stanno insieme
              alla terza porta, la board. Sono sempre gli STESSI due comandi
              definiti una volta qui sopra — cambia dove si montano, non cosa
              sono. */}
          {!isMobile && <div
            className="flex items-center relative z-50 app-no-drag flex-shrink-0"
            {...NO_DRAG_REGION}
            // `gap: ROW_INSET`, non `gap-2` scritto a mano. La colonna ha UN
            // passo — 6px — ed è lo stesso che separa una card dal bordo, una
            // card dalla sua vicina, e questi bottoni dal bordo destro e dai
            // fili sopra e sotto. Fra i due era 8, cioè l'unica distanza della
            // riga che non tornava («la spaziatura non mi sembra corretta fra i
            // due tasti»): con tutto il resto a 6 uno scarto di due pixel non si
            // legge come una scelta, si legge come uno sbaglio.
            style={{ pointerEvents: 'auto', gap: ROW_INSET }}
          >
            {sidebarSearchButton}
            {sidebarAddMenu}
          </div>}
        </div>


        {/* SidebarControls removed: search is now the inline header input,
            view-mode + archived toggles live in the Topics ▾ menu, and ⌘K
            (CommandPalette) remains via setShowSearch / the keyboard shortcut. */}
        {/* topicsError ("Using cached data — server unreachable") moved to the
            bottom SidebarStatusBar — see <SidebarStatusBar dataNotice={…} />. */}

        <div ref={sidebarContentRef} className="flex-1 flex flex-col min-h-0" data-testid="sidebar-topic-list">
          {/* I GRUPPI sono card dentro l'albero (TopicTree): ognuna tiene in
              mano le sue tab e si apre e si chiude per conto suo. Non esiste
              nessun posto separato dove i gruppi «vivono». */}
          <ErrorBoundary fallbackMessage="Sidebar error">
          {topicsLoading && Object.keys(topics).length === 0 ? (
            <div className="overflow-y-auto sidebar-scroll"><SkeletonTopicList count={5} /></div>
          ) : (
          // `openPanels={openPanels}`: TUTTE le tab aperte, non solo quelle del
          // gruppo attivo — perché la sidebar mostra TUTTI i gruppi insieme, e
          // ciascuna riga va nella card del suo (`paneSpaceById`). È la griglia
          // che resta filtrata sul gruppo attivo: lì una cosa alla volta.
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
            unreadData={unreadData}
            onArchiveTopic={handleArchiveTopicDeferred}
            onArchiveProject={handleArchiveProjectDeferred}
            onNewTopicInProject={(projectPath) => handleQuickCreateTopic(projectPath)}
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
            // Il pin nudo: «rimettila nella lista» non archivia niente.
            onUnpinToList={sidebar.togglePin}
            onSnapshotPinned={sidebar.snapshotPinned}
            onRestorePinned={sidebar.restorePinned}
            boardTaskCount={boardTaskCount}
            boardByStatus={boardByStatus}
            boardOpen={openPanels.includes('__board__')}
            // Preferenza, non segnale: passa da qui (e non da un `loadSettings()`
            // dentro l'albero) perché deve far RIDISEGNARE la sidebar quando si
            // cambia l'interruttore — `appSettings` è già lo stato che si
            // aggiorna sia dal server sia dalle altre schede.
            showBoardRow={appSettings.showBoardRow}
            // La board sta ferma in cima alla sidebar, sopra i fissati e sopra
            // ogni gruppo — ma la sua TAB vive in un gruppo come tutte. Se è in
            // un altro, ci si porta prima la finestra: aprirla e basta la
            // farebbe comparire dove non stai guardando.
            onOpenBoard={handleOpenBoard}
            spaceScoped={spaceScoped}
            paneSpaceById={paneSpaceById}
          />
          )}
          </ErrorBoundary>
        </div>

        {/* IL BANNER DELLA VERSIONE ATTERRA QUI, dentro la colonna e a tutta la
            sua larghezza — non più come cartellino flottante ancorato al
            numeretto in fondo. Vedi DevBundleToast / UpdaterToast: cercano
            questo slot e ci si portalano dentro. */}
        <div data-update-slot className="flex-shrink-0 empty:hidden" style={{ paddingInline: ROW_INSET, paddingBottom: ROW_INSET }} />

        {/* LA BARRA DI STATO STA IN FONDO, su ogni schermo.
            Ha fatto due giri altrove in un giorno — una fascia dedicata sotto
            l'header, poi in linea nella riga del titolo — e Attilio l'ha
            rimandata qui: «per quanto riguarda lo status lascialo in fondo,
            meglio». Ed è anche il posto della riga dell'IDENTITÀ, che le sta
            attaccata sopra: fuori di qui non c'era spazio per una seconda riga
            e l'avevo tolta sul telefono — è il «gli account che fine hanno
            fatto?». Torna con lei, e con la fascia dell'home indicator che
            questa barra dipinge di suo. */}
        {/* SUL TELEFONO LA BARRA DI STATO NON È PIÙ UNA BARRA.
            Identità + stato costavano 80px in fondo alla colonna (36 + 44) per
            dire «Questo computer» a chi il computer ce l'ha in mano. Le stesse
            cose — chi sei, come va, che versione è — stanno nel menu «Topics»
            (`SidebarSystemMenu`), che è dove si va a cercarle: «è qualcosa che
            l'utente raramente utilizzerà».
            AGGIORNAMENTO (card b8ca85e8): quel «Questo computer» non c'è più
            nemmeno sul desktop. La riga dice la PERSONA — nome e faccia, da
            `etichettaIdentita` — e il ferro le sta accanto come dettaglio. Il
            taglio sul telefono RESTA valido lo stesso, e per la seconda metà
            dell'argomento: là le stesse informazioni sono nel menu, quindi non
            si toglie niente, si sposta. Sul desktop la barra resta dov'era. */}
        {!isMobile && (
        <ErrorBoundary fallbackMessage="Status bar error">
        <SidebarStatusBar
          wsStatus={wsStatus}
          dataNotice={topicsError}
          // The identity band stayed HERE, at the foot of the column, so "open
          // the devices" goes back to travelling as a prop: it is a child, not
          // a pane. The event deep link above stays and is still needed — it is
          // used by the parts that ARE panes (the org chip opening the group
          // management, the profile opening its pages), and those cannot reach
          // this state through props.
          onOpenDevices={() => { setSettingsSection('devices'); setShowSettings(true); }}
        />
        </ErrorBoundary>
        )}
      </div>

      {/* LE QUATTRO PORTE DEL TELEFONO — cerca · aggiungi · task · profilo.
          Sta FUORI dalla colonna, non dentro: la fila deve restare sotto le
          dita anche col cassetto chiuso, altrimenti l'interruttore della board
          sarebbe di sola andata (aperta la board, il tasto per tornare alla
          lista se ne sarebbe andato con la colonna). È anche il motivo per cui
          si dipinge da sé invece di ereditare il chrome della sidebar.
          Il «+» è lo STESSO `PaneAddMenu` del desktop, con la faccia della
          fila: l'elenco delle cose creabili è uno solo. */}
      <MobileChromeBar
        onSearch={() => { setSearchScope('all'); setShowSearch(true); }}
        addSlot={
          <PaneAddMenu
            scope="standalone"
            onNewChat={() => handleQuickCreateTopic()}
            onAddPane={handleStandaloneAddPane}
            triggerTitle="Aggiungi"
            triggerVariant="bar"
            triggerLabel="Aggiungi"
          />
        }
        boardInFront={boardInFront}
        onToggleBoard={handleMobileBoardToggle}
        // LA PANE Profilo, non più la modale delle Impostazioni.
        //
        // Portava a Impostazioni → Profilo, cioè dentro un pannello che si apre
        // sopra la app e va richiuso per tornare a lavorare. Adesso è una tab
        // come Dashboard e Board: `topics:open-utility` è il bus che le apre
        // tutte (l'ascoltatore sta in `usePanelLifecycle` e accetta l'insieme
        // `UTILITY_PANEL_TYPES`), e sul telefono `handleOpenAsPage` chiude da sé
        // il cassetto. La sezione in Impostazioni resta dov'era.
        onOpenProfile={() => { window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'profile' } })); setShowTopicsMenu(false); }}
      />

      {/* Sidebar resize handle. The sidebar is position:fixed (FLIP push), so a
          flex divider here would collapse to x=0 under the sidebar's LEFT edge —
          nothing to grab at the real sidebar/content boundary (the bug: "resize
          non va"). The handle must therefore be fixed at the sidebar's RIGHT
          edge (left = sidebarWidth). Grab band biased INTO the sidebar: native
          WKWebView panes trail the sidebar flush on the content side and would
          eat any hover/click past the edge. z-50 + wide band: same lesson as
          the SplitTree dividers. Hidden while collapsed — the edge is gone. */}
      {/* AND IT STOPS WHERE THE SIDEBAR HAS SOMETHING TO CLICK. The band is
          biased 8px INTO the sidebar (see above) and used to run the full
          height, so at the bottom it sat on top of the identity block, whose
          rightmost controls end exactly under it. Measured 2026-08-26:
          `org-chip` (the organisation chip, x 241-249) could not be clicked at
          all — on macOS as much as elsewhere — with Playwright naming the
          culprit, "`div.cursor-col-resize` intercepts pointer events". Nothing
          had caught it because no test ever clicked that chip.
          The end is asked of the DOM (`identity-block`) and not written as a
          number: a fixed inset would be right today and wrong the first time a
          line is added down there, and it would be wrong in silence. */}
      {!isMobile && !sidebarCollapsed && (
        <div
          className="group fixed z-50 cursor-col-resize"
          style={{ left: sidebarWidth - 8, width: 10, top: 0, bottom: sidebarBottomInset }}
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
          {/* `RAISED_CONTROL` + `edge-lit`: lo STESSO bottone del «+» e del
              cerca, che è la parità chiesta («a questo punto fare uguale il
              relativo tasto di apertura sidebar»). Era `bg-surface` + un bordo,
              e `--bg-surface` sotto i 768px COLLASSA sul chrome (index.css):
              l'unico modo di riaprire la colonna quando non c'è nessuna pane
              spariva nel fondo proprio sul telefono. */}
          <SidebarToggleButton onClick={toggleSidebar} title={`Expand sidebar (${shortcut('B')})`} size="action" className={`edge-lit ${RAISED_CONTROL} rounded-lg shadow-sm`} />
        </div>
      )}

      {/* Main Content */}
      {/* `bg-app-chrome`, non `bg-app-bg`, e il colore del CONTENUTO scende sul
          figlio qui sotto. Il motivo è il `paddingTop` della safe-area: il
          padding lo dipinge il background di QUESTO elemento, quindi la fascia
          sotto la tacca usciva del colore della PAGINA mentre la sidebar — che
          la stessa fascia la dipinge di suo — usciva del colore del CHROME. Due
          tinte per la stessa striscia, a seconda che il drawer fosse aperto o
          chiuso. Ora la striscia è chrome sempre: è il bordo dell'app, e il
          bordo dell'app è chrome. */}
      <div id="main-content" ref={mainContentRef} role="main" className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-app-chrome"
        style={{
          contain: 'layout style',
          paddingTop: 'env(safe-area-inset-top, 0px)',
          // IL FONDO NO, ed è una correzione: la prima versione metteva anche
          // qui la safe-area, cioè ALZAVA TUTTO IL CONTENUTO — «non dovevi
          // alzare tutta l'app ma solo l'input, ora la chat è tagliata nella
          // safe area sotto». Vero: la conversazione perdeva 34px di altezza
          // utile e sotto restava una fascia morta.
          //
          // La cima e il fondo non sono simmetrici, e la differenza è cosa ci
          // sta contro. In cima c'è la barra di stato di iOS, OPACA: ogni pixel
          // sotto di lei è perso, quindi il contenuto deve cominciare dopo. In
          // fondo c'è l'home indicator, un trattino su fondo TRASPARENTE: il
          // contenuto può scorrerci sotto, deve solo non finirci sotto qualcosa
          // da TOCCARE. Quindi la spinta la prende il solo composer — vedi
          // ChatInput, che se la calcola da sé.
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
        <div ref={contentFlipRef} className="content-flip-layer flex-1 flex flex-col min-h-0 min-w-0 bg-app-bg">
        <ErrorBoundary fallbackMessage="Panel error">
        {/* Spazi: the grid gets the VISIBLE subset (openPanels stays the full
            store-backed set — see usePanelLifecycle.visiblePanels) and
            remounts per space (key) so per-space grid layouts stay isolated:
            PanelGrid prunes soloCells/gridRows against its openPanels prop,
            and a filtered set against a SHARED layout would erase the other
            spaces' geometry on every switch. */}
        {/* La cornice del gruppo (`.space-frame`, index.css): la stessa card
            che la sidebar disegna attorno alle tab, qui attorno al lavoro. C'è
            solo quando i gruppi esistono; keyed su activeSpaceId come la
            griglia, così cambiare gruppo rigioca l'ingresso. */}
        <div key={activeSpaceId} className={`flex-1 flex flex-col min-h-0 min-w-0 ${spaceScoped ? 'space-frame' : ''}`}>
        {activeSpaceWindow ? (
          <SpaceElsewherePanel spaceId={activeSpaceId} windowLabel={activeSpaceWindow} />
        ) : (
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
        )}
        </div>{/* /space-frame */}
        </ErrorBoundary>
        </div>{/* /content-flip-layer */}
      </div>

      {/* Portal dropdowns (rendered outside sidebar to escape overflow-hidden) */}
      {showTopicsMenu && createPortal(
        <>
        {/* Il velo del foglio dal basso, come in `Menu`: sotto i 768px questo
            menu non è più un cartellino appeso al titolo ma un foglio, e un
            foglio senza velo resta in piedi sul solo bordo (misurato altrove:
            1,04:1 in tema chiaro). */}
        {isMobile && (
          <div ref={topicsScrimRef} className="fixed inset-0 bg-black/40" style={{ zIndex: Z_POPOVER_SCRIM }} onClick={() => setShowTopicsMenu(false)} />
        )}
        <div
          ref={topicsDropdownRef}
          data-testid="sidebar-topics-menu-panel"
          // Height cap + scroll, and a left clamp. This menu opened at
          // `trigger.bottom + 4` with NO bound of any kind: it has ~12 rows and
          // simply ran off the bottom on a short window, with the overflowing
          // rows unreachable. Capping to the space actually below the trigger
          // (and clamping the left edge to the shared POPOVER_MARGIN) keeps
          // every row reachable without a measure-then-place pass.
          className={
            isMobile
              // FOGLIO DAL BASSO, e le voci scendono nella fascia invece di
              // lasciarla vuota: è la stessa legge della barra di stato —
              // `max(sab − 12, 8)` — non un `env()` appiccicato sotto, che
              // lascerebbe una striscia morta alta un terzo di una riga.
              // Sotto i 768px questo è IL menu del telefono: ci vive anche
              // l'account, quindi deve arrivare col pollice.
              ? `fixed bottom-0 left-0 right-0 ${POPOVER_SHEET} overflow-y-auto overscroll-contain`
              : `${POPOVER_SURFACE} min-w-[200px] overflow-y-auto overscroll-contain`
          }
          style={
            isMobile
              ? {
                  zIndex: Z_POPOVER,
                  paddingBottom: 'max(calc(var(--sab) - 12px), 8px)',
                  maxHeight: 'calc(100dvh - 3rem)',
                }
              : {
                  position: 'fixed',
                  top: topicsMenuPos.top,
                  left: Math.max(POPOVER_MARGIN, topicsMenuPos.left),
                  maxHeight: `calc(100vh - ${topicsMenuPos.top + POPOVER_MARGIN}px)`,
                  zIndex: Z_POPOVER,
                }
          }
        >
          {isMobile && <SheetGrabber />}
          {/* CHI SEI, COME VA, CHE VERSIONE È — solo sul telefono, dove la
              barra in fondo alla colonna non c'è più. Sta in TESTA al menu:
              l'account è la porta che prima non esisteva da nessuna parte, e
              una porta in fondo a dieci voci è una porta che si trova per
              caso. */}
          {isMobile && (
            <>
              <SidebarSystemMenu
                onOpenChangelog={(versione) => { setShowTopicsMenu(false); setShowChangelogFromMenu(versione); }}
              />
              <div className="my-1 border-t border-app-border" />
            </>
          )}
          {/* Sidebar controls relocated from the old <SidebarControls> row. */}
          <button
            onClick={() => { sidebar.toggleShowArchived(); }}
            className={`w-full flex items-center gap-2 px-3 ${isMobile ? 'py-3 min-h-11 text-[14px]' : 'py-1.5 text-[12px] coarse:py-3 coarse:text-[14px]'} hover:bg-app-hover transition-colors ${sidebar.showArchived ? 'text-primary' : 'text-app-text'}`}
          >
            <Archive size={isMobile ? 18 : 14} className={sidebar.showArchived ? 'text-primary' : ''} />
            <span className="flex-1 text-left">{tr('app.showArchived')}</span>
          </button>
          <button
            onClick={() => { sidebar.toggleViewMode(); }}
            className={`w-full flex items-center gap-2 px-3 ${isMobile ? 'py-3 min-h-11 text-[14px]' : 'py-1.5 text-[12px] coarse:py-3 coarse:text-[14px]'} text-app-text hover:bg-app-hover transition-colors`}
          >
            {/* Icona ed etichetta descrivono il modo SUCCESSIVO — cosa fa il
                click — e lo chiedono a `nextSidebarViewMode`, la stessa funzione
                che il toggle usa per muoversi: due liste di casi scritte a mano
                divergerebbero al primo modo che si aggiunge o si toglie. */}
            {(() => {
              const next = nextSidebarViewMode(sidebar.viewMode);
              const Icon = next === 'state' ? Hourglass : List;
              return <Icon size={isMobile ? 18 : 14} />;
            })()}
            <span className="flex-1 text-left">{
              nextSidebarViewMode(sidebar.viewMode) === 'state' ? 'Vista per stato' : 'Vista timeline'
            }</span>
          </button>
          {/* I due comandi sui pannelli compaiono SOLO dove i pannelli esistono
              — vedi `useSplitLayoutAvailable`. Sotto i 768px PanelGrid rende una
              colonna di celle senza divisori e senza larghezze salvate: lì
              «Reimposta pannelli» e «Disponi automaticamente» non fallivano, non
              facevano niente, ed erano le due voci che dal telefono facevano
              sembrare complicato un menu che non lo è. */}
          {splitLayoutAvailable && <>
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
            }}
            className={`w-full flex items-center gap-2 px-3 ${isMobile ? 'py-3 min-h-11 text-[14px]' : 'py-1.5 text-[12px] coarse:py-3 coarse:text-[14px]'} text-app-text hover:bg-app-hover transition-colors`}
            title={tr('app.mergePanels')}
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
            }}
            className={`w-full flex items-center gap-2 px-3 ${isMobile ? 'py-3 min-h-11 text-[14px]' : 'py-1.5 text-[12px] coarse:py-3 coarse:text-[14px]'} text-app-text hover:bg-app-hover transition-colors`}
            title={tr('app.tileAll')}
          >
            <Grid2x2 size={isMobile ? 18 : 14} />
            <span className="flex-1 text-left">Disponi automaticamente</span>
          </button>
          </>}
          {/* HISTORY LIVES HERE, on the button that gives the column its name.
              It is where a browser keeps it (the application menu), and it is the
              only place in the app you look at when you are after something you
              had open and no longer know where. It opens the palette in its one
              and only perimeter: closed tabs and visited pages, mixed by time. */}
          <button
            onClick={() => { setSearchScope('history'); setShowSearch(true); setShowTopicsMenu(false); }}
            className={`w-full flex items-center gap-2 px-3 ${isMobile ? 'py-3 min-h-11 text-[14px]' : 'py-1.5 text-[12px] coarse:py-3 coarse:text-[14px]'} text-app-text hover:bg-app-hover transition-colors`}
            data-testid="topics-menu-history"
          >
            <History size={isMobile ? 18 : 14} />
            <span className="flex-1 text-left">{tr('palette.history')}</span>
          </button>
          {/* Board / Dashboard / Cron stavano qui e ora stanno nel «+» (⌘N) —
              vedi il commento al posto di TOPICS_MENU_PAGES, in testa al file.
              Settings invece RESTA: è raggiungibile anche da ⌘K e da ⌘, ma
              sono tre porte per la stessa stanza, non tre stanze. */}
          <button
            onClick={() => { setShowSettings(true); setShowTopicsMenu(false); }}
            className={`w-full flex items-center gap-2 px-3 ${isMobile ? 'py-3 min-h-11 text-[14px]' : 'py-1.5 text-[12px] coarse:py-3 coarse:text-[14px]'} text-app-text hover:bg-app-hover transition-colors`}
          >
            <SettingsIcon size={isMobile ? 18 : 14} />
            <span className="flex-1 text-left">Settings</span>
          </button>
        </div>
        </>,
        document.body
      )}

      {/* The "New" sidebar header menu used to live here as a hand-rolled
          DropdownPortal + 4 hard-coded items. It now renders inline above
          via <PaneAddMenu scope="standalone" presentation="palette" /> (⌘N),
          so the trigger button AND the centered palette are the canonical
          components — no third menu implementation. */}

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
          // Sfissare una chat che non stai guardando la ARCHIVIA, cioè la
          // toglie dalla lista: l'etichetta lo dice invece di lasciarlo
          // scoprire dopo.
          unpinAlsoArchives={unpinAlsoArchives(contextMenu.topic.id)}
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
        /* A SECTION THAT BREAKS DOES NOT TAKE THE APP WITH IT. Without this
           net an error inside Settings climbed to the root: a white screen,
           with not even a way to close it. Measured for real — a device with no
           `id` blew up `DevicesSection` and everything else with it (an
           optional-chain comparison that was true against null, closed over
           there). It is the same net the sidebar, the status bar and the panels
           already have. */
        <ErrorBoundary fallbackMessage="Settings error">
        <Suspense fallback={null}>
          <GlobalSettings
            isOpen={showSettings}
            initialSection={settingsSection}
            onClose={() => { setShowSettings(false); setSettingsSection(undefined); }}
            settings={appSettings}
            onSettingsChange={setAppSettings}
            themeMode={themeMode}
            onThemeChange={setTheme}
            // La scheda «Shortcuts» delle Impostazioni è stata rimossa (era una
            // terza lista scritta a mano, e sbagliata). Il rimando in Aspetto
            // porta alla finestra vera, ⌘? — che finora era l'UNICA porta, e
            // una scorciatoia non si scopre con una scorciatoia. Le Impostazioni
            // si chiudono: due modali sovrapposti non hanno un ordine di uscita.
            onOpenShortcuts={() => {
              setShowSettings(false);
              setSettingsSection(undefined);
              setShowShortcuts(true);
            }}
          />
        </Suspense>
        </ErrorBoundary>
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
            onAddPane={handleStandaloneAddPane}
            onProjectPicker={handleOpenProjectPicker}
            onToggleTheme={toggleTheme}
            onOpenSettings={() => { setShowSearch(false); setShowSettings(true); }}
            // "Reimposta pannelli" (collapse to one tabbed cell) + "Disponi
            // automaticamente" (auto-tile into a balanced grid) — per-window
            // CustomEvent bus (same pattern as topics:open-project-picker); the
            // standalone PanelGrid listener performs each.
            //
            // `undefined` sotto i 768px, che nella palette è già il modo in cui
            // una voce NON esiste (vedi `if (onResetPanels)` là dentro): stessa
            // regola del menu ⋯ qui sopra, applicata alla stessa coppia di
            // comandi da una sola sorgente di verità.
            onResetPanels={splitLayoutAvailable ? () => window.dispatchEvent(new CustomEvent('topics:reset-split-layout')) : undefined}
            onAutoTilePanels={splitLayoutAvailable ? () => window.dispatchEvent(new CustomEvent('topics:auto-tile-layout')) : undefined}
            onOpenFileSearch={() => {
              setShowSearch(false);
              // Stesso perimetro di ⌘F: progetto a fuoco più quelli aperti.
              if (searchProjectPaths.length > 0) setShowFileSearch({ projectPaths: searchProjectPaths, mode: 'content' });
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
            // A history row that is a PAGE opens in a brand new browser pane.
            // The seed for the URL goes in BEFORE the open: the pane captures
            // its `initialUrl` at mount, once and only once (see
            // `seedBrowserPaneInitialUrl`), so writing it afterwards would
            // mean a blank tab sitting next to a click that had promised a
            // page.
            onOpenHistoryUrl={(url) => {
              const contextId = newBrowserContextId();
              seedBrowserPaneInitialUrl(`browser:${contextId}`, url);
              openBrowserPane(contextId);
            }}
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
            projectPaths={showFileSearch.projectPaths}
            mode={showFileSearch.mode}
            onModeChange={(mode) => setShowFileSearch((prev) => (prev ? { ...prev, mode } : prev))}
            onOpenFile={(path, lineNumber) => {
              // Il file si apre nella finestra del progetto CHE LO CONTIENE, non
              // in quella a fuoco: da quando la ricerca è multi-progetto le due
              // possono essere diverse, e aprirlo nella finestra sbagliata
              // significa mostrarti il file giusto nel posto sbagliato.
              const owner = showFileSearch.projectPaths.find((root) => path.startsWith(root + '/'))
                ?? showFileSearch.projectPaths[0];
              window.dispatchEvent(new CustomEvent('open-file', {
                detail: { path, lineNumber, topicId: createPaneId('project', owner) },
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
      {/* ACK «Ricaricata» dopo un reload chiesto dall'utente: un ricarico che
          rifà lo stesso schermo, senza una parola, si legge come «non va». */}
      <ReloadedFlash />

      {/* Root-level fallback outlet for global notifications (e.g. agent
          completion). When a scoped outlet (ProjectWindow's) is mounted,
          this one stays hidden to avoid double-rendering — the scoped
          outlet wins and toasts appear inside the project pane. */}
      <ToastOutlet fixed fallback />

      {/* Il changelog, aperto dalla voce «Versione» del menu del telefono.
          Stessa modale del desktop: sul Mac ci si arriva dal numero nella
          barra di stato, che sotto i 768px non esiste più. */}
      {showChangelogFromMenu !== null && (
        <ChangelogModal currentVersion={showChangelogFromMenu} onClose={() => setShowChangelogFromMenu(null)} />
      )}
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
  // `useToast()` restituisce l'API STABILE del provider (Toast.tsx: due context,
  // quello dei mittenti non cambia mai identità dopo il mount), quindi sta fra
  // le dipendenze come qualunque altro valore fermo e l'effetto di boot gira una
  // volta sola. Fino al 2026-08-15 qui c'era un ref-shim sincronizzato in un
  // effetto: serviva perché il context value si ricostruiva a ogni render di
  // App, e metterlo fra le dipendenze avrebbe rifatto partire l'intera corsa di
  // boot a ogni toast mostrato.
  const toast = useToast();
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
    const notify = (message: string) => toast.warning(message);
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
  }, [isDetached, toast]);

  // «APRI CON TOPICS» dal sistema operativo: un file o una cartella aperti dal
  // Finder, o trascinati sull'icona nel dock. È un deep-link come quelli qui
  // sopra, solo che a consegnarlo è l'OS: il guscio Rust accoda il path e suona
  // il campanello, qui si svuota la coda e si apre dalla stessa porta
  // (`openTabInApp`), che sa già aspettare il mount della finestra di progetto.
  //
  // Il giro fatto al montaggio è la meta' che conta: il path del LANCIO A
  // FREDDO arriva prima che questa pagina esista, quindi nessun evento avrebbe
  // potuto raccoglierlo. Le finestre staccate non instradano niente, come sopra;
  // fuori da Tauri il ponte non registra nemmeno il listener.
  useEffect(() => {
    if (isDetached) return;
    return installOsOpenPathBridge(defaultOsOpenDeps((message) => toast.warning(message)));
  }, [isDetached, toast]);
  return null;
}

export default App;
