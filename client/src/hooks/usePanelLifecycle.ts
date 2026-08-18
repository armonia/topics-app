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

import { findEmptyDraftPane, forgetDraft, isDraftDisposable, draftTextKey } from '../state/draftPane';
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
  isTaskWorkspacePath,
  isTerminalPaneId,
  isUUIDLike,
  reopenClosedTab,
  selectProjectBrowserReopen,
  type ClosedTabRecord,
  getProjectPathFromPaneId,
  projectPanesLocalKey,
  projectLayoutLocalKey,
  locateTerminalPane,
  browserProjectPanesStore,
  getPaneConfig,
  getBrowserOrigin,
  enqueueProjectBrowserReopen,
} from '../state/pane/adapters';
import { findPaneLocation, usePaneStore } from '../state/pane/store';
import { filterVisiblePaneIds, resolvePaneSpace } from '../state/pane/selectors';
import { isLiveSpaceId } from '../state/pane/reducers/spaces';
import { DEFAULT_SPACE_ID } from '../state/pane/types';
import { seedBrowserPaneInitialUrl } from '../state/pane/browserPaneUrl';
import { applyMessagePreview, clearTopicPreview, hydrateTopicPreviews } from '../state/topicPreviews';
import { resolveTerminalBrowserContext } from '../state/browserSpawner';
import {
  buildTerminalSessionBody,
  normalizeTerminalAgent,
  TERMINAL_AGENT_LABELS,
  type TerminalAgentType,
} from '../lib/terminalAgents';

import { utilityPanelId } from '../components/Layout/UtilityPanel';
import { UTILITY_PANEL_TYPES, type UtilityPanelType } from '../state/pane/adapters/utilityPanelId';
import type { SendMessageOptions } from '@/hooks/useChat';
import { DEFAULT_TOPIC_ICON } from '../lib/topicIcons';
import { primeWebNotificationPermission } from '../lib/shell/app';
import { isTauri } from '../lib/shell';
import { getBrowserContextFromPaneId } from '../state/pane/adapters/paneConfig';
import { clearBrowserSpawner } from '../state/browserSpawner';
import { addBrowserTombstone } from '../state/pane/adapters/closedTabRecord';
import { tauriInvoke, currentWindowLabel } from '../lib/shell/tauri';
import { spaceWindowId } from '../lib/windowRole';
import { markTabRestored } from '../lib/previewTabs';
import { pushUndo } from '../contexts/UndoContext';
import { useRefMirror } from './useRefMirror';
import { shouldFillFromBroadcast } from './liveTurn';
import { tabAckReleasesIntent } from '../lib/tabLink';
import {
  armFocusIntent,
  liveFocusIntent,
  resolveStoreFocus,
  type FocusIntent,
} from './focusIntent';
import { useShallow } from 'zustand/react/shallow';

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

/**
 * Does this topic open into a PROJECT PANE (a splittable window) rather than a
 * loose chat tab? True for:
 *  - a normal project chat (`projectPath`, not standalone) → its project window;
 *  - a TASK WORKSPACE session (`standalone` + a `…/workspace/tasks/<id>` path)
 *    → the task's own splittable workspace (reuses the project-pane machinery).
 * A `standalone` topic that is NOT a task workspace stays a loose chat tab.
 * Single source of truth for the four routing sites below.
 */
function opensAsProjectPane(t: Topic | undefined | null): boolean {
  if (!t?.projectPath) return false;
  return !t.standalone || isTaskWorkspacePath(t.projectPath);
}

export interface UsePanelLifecycleArgs {
  isDetached: boolean;
  detachedTopicId: string | null;
  /** All topics this detached window hosts (`?topics=a,b,c`). Seeds openPanels
   *  in detach mode. `detachedTopicId` is kept as the first element / focus. */
  detachedTopicIds?: string[];
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
  // Pinning (Fissati): retained for App wiring compatibility (App passes it
  // from useSidebarState.isPinned). NO LONGER gates archive-on-close — a
  // pinned chat archives on close like every other chat (its durable
  // cross-client closed signal), and the buildSidebarItems pinnedIds escape
  // keeps its row while reopen unarchives. See handleClosePanel for why the
  // former pinned-exempt behaviour resurrected closed pinned chats.
  isPinnedRef?: React.RefObject<(id: string) => boolean>;
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
  /** Recently-closed records (newest first). Lets openBrowserPane route a
   *  reopened pinned browser back into its owning project instead of a blank
   *  standalone pane (project browser url/affinity live only on the record). */
  closedTabs: ClosedTabRecord[];
}

export interface UsePanelLifecycleReturn {
  state: {
    openPanels: string[];
    /**
     * `openPanels` filtered to the active Spazio — what the visible surfaces
     * (PanelGrid, tab strips, next-focus math) render. `openPanels` stays the
     * FULL unfiltered set: the React→store REORDER_PANES bridge (Effect B)
     * runs on it, and filtering THAT would evict hidden panes from the store.
     */
    visiblePanels: string[];
    /** The Spazio this window is showing (device-local; PanelGrid remounts
     *  via key={activeSpaceId} so per-space grid layouts stay isolated). */
    activeSpaceId: string;
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
    focusedPanelIdRef: React.RefObject<string | null>;
    openPanelsRef: React.RefObject<string[]>;
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
    promoteDraft: (draftId: string, firstMessage: string, options?: SendMessageOptions) => Promise<void>;
    handleQuickCreateTerminal: (termType?: TerminalAgentType, skipPermissions?: boolean, opts?: { role?: 'master'; name?: string }) => Promise<string | null>;
    handleCloseTerminal: (sessionId: string) => Promise<void>;
    handleTerminalClick: (sessionId: string, sessionName: string) => void;
    // L'INSIEME canonico, non tre literal a mano: l'implementazione qui sotto
    // accetta già `UtilityPanelType`, e questa firma la restringeva — un tipo
    // nuovo (`profile`) compilava nel modulo e veniva rifiutato a chi chiama.
    handleOpenAsPage: (type: UtilityPanelType) => void;
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

/** Field separator for the presence-tab snapshot string. A control character
 *  no pane title can contain, so the encode/decode round-trip is total. */
const PRESENCE_TAB_SEP = '\u0001';

// Una bozza che non hai mai TOCCATO — nessun doppio clic sulla tab, nessun clic
// dentro, nessun tasto — non l'hai scelta: l'hai aperta e basta. È un'anteprima,
// e si richiude da sola quando passi ad altro. Dal momento in cui la tocchi
// diventa tua e non se ne va più, come non se ne va una con del testo dentro.
//
// Questa è la regola CHIESTA, ed è più giusta di quella che avevo scritto io:
// «hai smesso di guardarla» chiudeva anche le tab che stavi usando, e per due
// giri ho dato la colpa a lei di una sparizione che era di un altro strato (le
// pane filtrate per spazio). Il predicato ora è l'interazione, non lo sguardo.
const DRAFT_CLOSE_DELAY_MS = 400;
const DRAFT_MIN_LOOKED_AT_MS = 500;

export function usePanelLifecycle(args: UsePanelLifecycleArgs): UsePanelLifecycleReturn {
  const {
    isDetached, detachedTopicId, detachedTopicIds, isMobile,
    topics, topicsLoading, loadTopics, createTopic, applyTopicFromWS, archiveProject, archiveTopic,
    workspaceProjects,
    terminalSessions, pruneStaleTerminalPanes, terminalOps,
    onWSMessage, sendWS, wsStatus, windowId,
    chatStreamHandlers,
    setSidebarCollapsed, removeClosedTab, closedTabs,
  } = args;

  // The full detached set — seeds openPanels; empty off-detach. `detachedTopicId`
  // stays the focused/first id for back-compat with the singular guards below.
  const detachedIds = detachedTopicIds && detachedTopicIds.length > 0
    ? detachedTopicIds
    : (detachedTopicId ? [detachedTopicId] : []);

  const {
    loadHistory, sendMessage, drainQueue,
  } = chatStreamHandlers;

  // ---- 1. State ----
  const [openPanels, setOpenPanels] = useState<string[]>(() => {
    if (isDetached && detachedIds.length > 0) return detachedIds;
    return loadSavedPanels();
  });
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(() => {
    if (isDetached && detachedIds.length > 0) return detachedIds[0];
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
  // Gli handler di chat letti dai cluster WS, mirrorati. I cluster si iscrivono
  // UNA VOLTA e pescano da qui: metterli fra le dipendenze dell'effect voleva
  // dire rifare unsubscribe+subscribe a ogni cambio di identità, e
  // `getSessionMessages` cambia identità a ogni token di stream (dipende da
  // `messages`). Era un ciclo di teardown per chunk — e il Cluster 1 nel
  // teardown butta via anche i timer di riconciliazione del thread, quindi la
  // riconciliazione debounced poteva non arrivare mai durante uno stream.
  const chatHandlersRef = useRefMirror(chatStreamHandlers);
  const applyTopicFromWSRef = useRefMirror(applyTopicFromWS);
  // openPanel is declared far below (it depends on many of the above), but the
  // stable WS effects need to call it. Declare the mirror ref here (before
  // those effects) and sync it after openPanel's declaration — referencing the
  // openPanel const directly in the effects reads it before declaration.
  const openPanelRef = useRef<(topicId: string, mode: 'preview' | 'permanent' | 'below', autoFocus?: boolean) => void>(() => {});
  // Forward ref to handleProjectClick (declared ~650 lines below) so
  // openBrowserPane can open a CLOSED project to route a pinned browser back
  // into it. Assigned right after handleProjectClick's definition.
  const handleProjectClickRef = useRef<((projectPath: string) => void) | null>(null);

  // ---- Spazi: visiblePanels derivation (derive, never mutate) ----
  // openPanels stays the FULL set (Effect B's REORDER_PANES bridge depends on
  // it); the render surfaces get this filtered view. Subscribed slices are
  // structurally shared by Immer, so `panes`/`spaces` only change identity
  // when a pane/space actually changes.
  const activeSpaceId = usePaneStore((s) => s.activeSpaceId);
  const storeSpaces = usePaneStore((s) => s.spaces);
  // NON ci si iscrive a `s.panes`. Il commento qui sopra è vero ma incompleto:
  // Immer condivide le strutture, sì, ma `panes` cambia identità a ogni
  // modifica di UNA QUALSIASI pane — e `setPaneScrollOffset` ne scrive una
  // ogni 250 ms mentre si scorre una chat. Ogni tick cambiava lo snapshot,
  // rompeva questo memo (`filterVisiblePaneIds` è un `.filter()` puro, quindi
  // rende sempre un array nuovo) e ridisegnava App e con lui `<PanelGrid>`,
  // che non è memoizzato: quattro render al secondo dell'intera griglia per
  // un dato che nessuno di questi due guarda.
  //
  // Iscriversi al RISULTATO con `useShallow` toglie il problema alla radice:
  // il selettore rigira comunque, ma lo snapshot cambia solo quando cambia
  // l'insieme delle pane VISIBILI. Uno scroll non lo tocca.
  const visibleFromStore = usePaneStore(
    useShallow((s) => filterVisiblePaneIds(openPanels, s.panes, s.spaces, s.activeSpaceId)),
  );
  const visiblePanels = isDetached ? openPanels : visibleFromStore;
  // Mirrorata per i callback stabili (la «nuova chat» che riusa una bozza
  // vuota già davanti): leggere `visiblePanels` da dentro un useCallback
  // significherebbe leggerne la copia del primo render.
  const visiblePanelsRef = useRefMirror(visiblePanels);

  // Finestra-GRUPPO (`?space=<id>`): lo Spazio lo decide la query, e va
  // RI-affermato. Al boot la registry può non contenerlo ancora (il gruppo
  // nasce su un'altra finestra e arriva col primo hydrate), e SET_ACTIVE_SPACE
  // risolve un id sconosciuto sul default: senza questo la finestra staccata
  // resterebbe sul gruppo principale, cioè mostrerebbe le tab di un altro.
  const pinnedSpaceId = spaceWindowId();
  useEffect(() => {
    if (!pinnedSpaceId) return;
    if (activeSpaceId === pinnedSpaceId) return;
    if (!isLiveSpaceId(pinnedSpaceId, storeSpaces)) return;
    usePaneStore.getState().dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: pinnedSpaceId } });
  }, [pinnedSpaceId, activeSpaceId, storeSpaces]);

  // Space died remotely (a hydrate brought its deleted:true tombstone) while
  // this window was looking at it → fall back to the default space. Read-time
  // resolution (resolvePaneSpace) already reassigned the panes; this just
  // moves the viewport. SET_ACTIVE_SPACE resolves dead ids itself, so the
  // dispatch is safe even if the registry changes again in flight.
  useEffect(() => {
    if (isDetached) return;
    if (isLiveSpaceId(activeSpaceId, storeSpaces)) return;
    usePaneStore.getState().dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: DEFAULT_SPACE_ID } });
  }, [isDetached, activeSpaceId, storeSpaces]);

  // Focus follows across Spazi: any path that focuses an OPEN pane living in
  // another space (sidebar click, ⌘K, WS topic:switch / focus-suggest, tray
  // navigation) switches the window to that pane's space — the one central
  // hook instead of per-call-site SET_ACTIVE_SPACE sprinkles. The inverse
  // (space switch away from the focused pane) is handled synchronously by the
  // SET_ACTIVE_SPACE reducer's focus handoff, so the two rules can't fight.
  useEffect(() => {
    if (isDetached) return;
    // In una finestra-gruppo il fuoco non porta MAI altrove: quella finestra è
    // un gruppo solo, e seguire il fuoco vorrebbe dire cambiarle identità sotto
    // i piedi (e portarci le tab di un'altra).
    if (pinnedSpaceId) return;
    if (!focusedPanelId) return;
    if (!openPanels.includes(focusedPanelId)) return;
    if (visiblePanels.includes(focusedPanelId)) return;
    const s = usePaneStore.getState();
    const target = resolvePaneSpace(s.panes[focusedPanelId], s.spaces);
    if (target !== s.activeSpaceId) {
      // Push the focus into the STORE first: Effect C (React→store focus) is
      // gated by storeSyncInternalRef and may not have run yet, so the
      // SET_ACTIVE_SPACE reducer would otherwise read a STALE store focus and
      // hand off to the space's first pane instead of the one just clicked.
      // With the store focus current, the reducer sees it already lives in
      // the target space and leaves it alone.
      s.dispatch({ type: 'FOCUS_PANE', payload: { id: focusedPanelId } });
      s.dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: target } });
    }
  }, [isDetached, pinnedSpaceId, focusedPanelId, openPanels, visiblePanels]);

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
      // La precedenza fra intenti, fuoco dello store e fuoco locale sta in
      // `resolveStoreFocus` (hooks/focusIntent.ts), che è pura e testata: qui
      // restano solo le letture. Entrambi gli intenti passano dalla stessa
      // scadenza — un deep-link difende la sua pane per la finestra di boot, non
      // per il resto della sessione.
      const visibleOrder = filterVisiblePaneIds(storeOrder, s.panes, s.spaces, s.activeSpaceId);
      const boardIntent = liveFocusIntent(deepLinkFocusRef.current);
      const tabIntent = liveFocusIntent(deepLinkTabFocusRef.current);
      setFocusedPanelId(prev => resolveStoreFocus({
        prev, storeFocus, storeOrder, visibleOrder, boardIntent, tabIntent,
      }));
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

  // ---- Deep-link focus intent (survives the pane-store hydrate) ----
  // A `?task=` deep-link must ACTIVATE the global board and keep it active even
  // as boot-time WS hydrates (`ui-state:init`/`updated`) re-run Effect A and try
  // to restore the previously-focused pane. This ref is a high-precedence local
  // intent: while set, Effect A's focus reconciliation forces it (above the
  // storeFocus/fallback branches) after every hydrate — the server_seq UNION
  // gate is untouched (the board pane rides the UNION's local-pane
  // re-injection; focus is device-local). Set on `topics:open-task` (only
  // deep-links emit it), released quando il drawer si apre davvero
  // (`topics:task-opened`), quando l'utente naviga di sua volontà
  // (`releaseFocusIntents`), e comunque alla SCADENZA.
  //
  // La scadenza è la novità, e nasce da un guasto vero: il drawer risponde
  // «sono aperto» solo se ci riesce, e ha tre vicoli ciechi (il task non esiste
  // più, il trasporto cade, la board non monta). In quei casi l'intento restava
  // armato per sempre e la sottoscrizione a `lastSeq` — che si sveglia a OGNI
  // dispatch, anche un FOCUS_PANE — riportava il fuoco su `__board__` a ogni
  // mutazione dello store. Sintomo riportato: apro un progetto dalla sidebar,
  // faccio una chat nuova, e la finestra torna sulla board.
  const deepLinkFocusRef = useRef<FocusIntent | null>(null);

  // Il GEMELLO per un permalink di tab (`/tab/…`). Stessa malattia, stessa
  // cura, due differenze:
  //  • il pane id NON è fisso (per la board è sempre `__board__`): lo porta
  //    l'evento, perché solo chi risolve il permalink sa su cosa atterra —
  //    `terminal:<sid>`, `project:<enc>`, `browser:<ctx>`, il topicId nudo per
  //    la chat, `__<type>__` per i panel (lib/tabLink.appPaneIdForTarget);
  //  • non ha un ack «sono arrivata» come il drawer del task, quindi sulla
  //    scadenza ci conta di più — ma la scadenza ora ce l'hanno entrambi
  //    (`FOCUS_INTENT_TTL_MS`), perché anche l'ack del drawer può non arrivare.
  const deepLinkTabFocusRef = useRef<FocusIntent | null>(null);

  // Una NAVIGAZIONE VOLUTA batte qualunque intento, e lo spegne: da quel
  // momento è l'utente a dire dove sta la scena, non un link di dieci secondi
  // fa. Una porta sola perché prima erano due (handleTopicClick e
  // handleFocusPanel) su una decina di posti che spostano il fuoco — e le
  // altre otto lasciavano l'intento armato dietro di sé.
  const releaseFocusIntents = useCallback(() => {
    deepLinkFocusRef.current = null;
    deepLinkTabFocusRef.current = null;
  }, []);

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
      // paneId → projectPath, so we can register the pane ENTITY below before
      // its id flows into openPanels. Per the ensurePaneRegistered header, an
      // unregistered project id is silently dropped by Effect B's REORDER_PANES.
      const projectPanePaths = new Map<string, string>();
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
        if (!topic) {
          // Optimistic: a UUID with no topic record yet is very likely a real
          // topic still loading (or a peer's create not yet hydrated) — keep it.
          if (isUUIDLike(id)) return true;
          // A NON-UUID id with no topic record is a phantom: a stale search
          // result's synthetic id, or a deleted topic reached via navigation
          // (e.g. onOpenTopic → openPanel). Filtering it out of React state
          // alone is NOT enough — openPanel/handleTopicClick already called
          // ensurePaneRegistered, so the id lives in pane-store-v2.panes/groups
          // + ui_state; the next store→openPanels sync re-adds it and this
          // validation re-evicts it, an unbounded add/evict ping-pong (the same
          // ~750 Hz Effect 7 ↔ HYDRATE loop the projectPath orphan below guards,
          // observed as a /api/context/analyze storm that starves the server).
          // Purge it from the store too so the loop can't close.
          if (!orphanTopicIdsToPurge.includes(id)) orphanTopicIdsToPurge.push(id);
          return false;
        }
        if (topic.archived) return false;
        // A project-bound chat lives INSIDE its project window: convert the
        // standalone pane into a project pane and purge the loose chat pane.
        // TASK WORKSPACE sessions also route here (into their own per-task
        // splittable workspace). Only a `standalone` topic that is NOT a task
        // workspace stays a loose tab (never a phantom project).
        if (opensAsProjectPane(topic)) {
          const paneId = createPaneId('project', topic.projectPath!);
          projectPanePaths.set(paneId, topic.projectPath!);
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
        // Register the project pane ENTITIES before Effect B dispatches
        // REORDER_PANES for the new openPanels — otherwise the reducer drops
        // these ids (no `state.panes` entity) and the project tab never opens.
        // Effect 7 previously skipped this (every other call site honors the
        // ensurePaneRegistered contract); the focus branch below only ever
        // patched the *focused* pane, leaving non-focused project panes orphaned.
        for (const p of projectPanesToAdd) {
          const pp = projectPanePaths.get(p);
          if (pp) ensurePaneRegistered({ id: p, type: 'project', projectPath: pp });
        }
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
  //
  // «Qual è il progetto su cui sto lavorando adesso»: lo leggono ⌘F (cerca nel
  // progetto), ⌘P (apri un file) e il quick-open, quindi quando resta undefined
  // quelle scorciatoie non fanno NIENTE e sembrano rotte.
  //
  // Le prime due strade riconoscono la tab del progetto e una chat che vi
  // appartiene. Ne mancava una, ed è quella che si percorre di più: aprendo un
  // progetto il fuoco si sposta quasi subito su una pane INTERNA — un terminale,
  // git, i file, un browser — che non è un `project:` pane id e non sta in
  // `topics`. Da lì `focusedProjectPath` tornava undefined pur essendo dentro un
  // progetto a schermo intero: si cliccava la tab del progetto e ⌘F non
  // rispondeva.
  //
  // `projectOpenPanes` sa già di chi è ogni pane (ogni finestra di progetto
  // pubblica le sue). È upsert-only e non viene mai potata alla chiusura di una
  // tab — un `browser:term-…` di un progetto chiuso resta per sempre — quindi
  // l'appartenenza vale solo se quel progetto è ANCORA aperto a livello app
  // (`openPanels`), la stessa condizione che usa `owningRenderedProject`.
  const focusedProjectPath = useMemo(() => {
    if (!focusedPanelId) return undefined;
    if (isProjectPaneId(focusedPanelId)) return getProjectPathFromPaneId(focusedPanelId) || undefined;
    const viaTopic = topics[focusedPanelId]?.projectPath;
    if (viaTopic) return viaTopic;
    const owner = Object.entries(projectOpenPanes)
      .find(([, ids]) => ids.includes(focusedPanelId))?.[0];
    if (owner && openPanels.includes(createPaneId('project', owner))) return owner;
    return undefined;
  }, [focusedPanelId, topics, projectOpenPanes, openPanels]);

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
      // Focusing the project window is NOT enough: the browser may sit behind
      // another tab of its group. Ask the owning window to activate THAT tab
      // (claim protocol handled in useProjectLayout) — this was the "click on
      // a sidebar browser does nothing" report: the window focused, the tab
      // never switched.
      window.dispatchEvent(new CustomEvent('topics:focus-project-pane', {
        detail: { projectPath: owningProject, paneId },
        cancelable: true,
      }));
      if (isMobile) setSidebarCollapsed(true);
      return;
    }
    // Closed while pinned INSIDE a project: a project-level record survives on
    // the closed-tab stack carrying the pane's url + projectPath. A project
    // browser's url lives ONLY in that project's snapshot (updatePane), never
    // the global store — so the standalone fallback below would reopen it
    // about:blank AND out of its project. Route it back to the owning window
    // via the SAME cancelable claim protocol as ⌘⇧U (handleReopenClosedTab):
    // the window whose projectPath matches restores the pane (url included) and
    // preventDefault()s, and only then do we consume the record. If no project
    // window is mounted to claim it, fall through to the standalone pane so the
    // click still surfaces something.
    const closedProjectRec = selectProjectBrowserReopen(closedTabs, paneId);
    if (closedProjectRec) {
      const ev = new CustomEvent('reopen-closed-tab', { detail: closedProjectRec, cancelable: true });
      window.dispatchEvent(ev);
      if (ev.defaultPrevented) {
        removeClosedTab(closedProjectRec.id);
        if (isMobile) setSidebarCollapsed(true);
        return;
      }
    }
    // Route a browser back INTO a project window, reusing the ⌘⇧U claim protocol.
    // If a mounted ProjectWindow whose projectPath matches claims the event
    // (preventDefault), it restores the pane with `url`. If NONE claims it, the
    // project is closed → open it and park the record so its window restores the
    // browser on mount (drainProjectBrowserReopens), instead of a blank standalone.
    const routeIntoProject = (projectPath: string, url: string, title?: string): void => {
      const synthetic: ClosedTabRecord = {
        id: paneId,
        closedAt: Date.now(),
        // groupId '' → restoreClosedRecord falls back to the window's first group
        // (record.groupId not found); the exact cell isn't durably recoverable.
        pane: { id: paneId, type: 'browser', title: title || 'Browser', url },
        groupId: '',
        groupIndex: 0,
        level: 'project',
        projectPath,
      };
      const ev = new CustomEvent('reopen-closed-tab', { detail: synthetic, cancelable: true });
      window.dispatchEvent(ev);
      if (!ev.defaultPrevented) {
        enqueueProjectBrowserReopen(projectPath, synthetic);
        handleProjectClickRef.current?.(projectPath);
      }
      if (isMobile) setSidebarCollapsed(true);
    };

    // Durable fallback (closedStack-INDEPENDENT). The stack above is bounded (50,
    // FIFO), so a browser pinned long ago — or one whose close record got
    // corrupted to a non-project/non-browser shape — has no usable record left
    // there. The origin store (written on every project-browser navigation and
    // NOT cleared on close) still knows this contextId's project + last url, so
    // we can route the reopen back into its window even when the stack forgot it.
    const origin = getBrowserOrigin(contextId);
    if (origin) {
      routeIntoProject(origin.projectPath, origin.url, origin.title);
      return;
    }
    // Last-resort recovery for a pin created BEFORE the origin store existed (its
    // url was never durably stored, so it's unrecoverable): if the contextId is a
    // topic id, that topic's projectPath is authoritative — route the browser back
    // into its project (blank until the user navigates, at which point updatePane
    // records a durable origin). Only topic-keyed contexts resolve here; uuid /
    // terminal-keyed ones have no reliable project association and fall through.
    const recoveredProject = topicsRef.current[contextId]?.projectPath;
    if (recoveredProject) {
      routeIntoProject(recoveredProject, '');
      return;
    }
    setPendingBrowserPane(contextId);
    setPendingSoloPanelId(paneId);
    if (isMobile) {
      setSidebarCollapsed(true);
    }
  }, [isMobile, setSidebarCollapsed, openPanelsRef, topicsRef, owningRenderedProject, closedTabs, removeClosedTab]);

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
  type UtilityPageType = UtilityPanelType;
  const handleOpenAsPage = useCallback((type: UtilityPageType) => {
    const id = utilityPanelId(type);
    // Register in the pane store BEFORE pushing into openPanels —
    // otherwise Effect A reconciles openPanels back to the store-known
    // ids and silently drops the new utility id (same trap that
    // broke cmd+K project open).
    ensurePaneRegistered(
      // Store the proper display label (e.g. "Dashboard"/"Cron"), NOT the raw
      // lowercase type string — the tab bar reads pane.title directly in some
      // surfaces (drag ghost, sidebar), so a stored "dashboard" would leak the
      // untitled-case label there even though the standalone bar recomputes it.
      { id, type: type as PaneType, title: getPaneConfig(type as PaneType).label },
      { groupId: 'group:default' },
    );
    if (isMobile) {
      setOpenPanels([id]);
      setSidebarCollapsed(true);
    } else {
      setOpenPanels(prev => prev.includes(id) ? prev : [...prev, id]);
    }
    setFocusedPanelId(id);
    // Plant the focus in the pane store SYNCHRONOUSLY, not just in React state.
    // `focusedPaneId` is device-local (HYDRATE never overwrites it), so setting
    // it here makes this pane the focus BEFORE any in-flight WS hydrate lands.
    // Effect C would do the same, but only after the next render commit — a
    // hydrate arriving in that gap re-runs Effect A, and with the store focus
    // still on the OLD pane its `visibleOrder[0]` fallback could steal focus
    // away (the deep-link "board opens but isn't active" bug). Doing it now
    // closes that race without touching the server_seq UNION gate.
    usePaneStore.getState().dispatch({ type: 'FOCUS_PANE', payload: { id } });
  }, [isMobile, setSidebarCollapsed]);

  // Utility panes opened from surfaces that don't get handleOpenAsPage as a
  // prop (e.g. the standalone tab bar's "+" → Board generale). Event-based
  // like `topics:open-project-picker`, so every host triggers it identically.
  useEffect(() => {
    const VALID = new Set<UtilityPageType>(UTILITY_PANEL_TYPES);
    const onOpenUtility = (e: Event) => {
      const type = (e as CustomEvent<{ type?: string }>).detail?.type as UtilityPageType | undefined;
      if (type && VALID.has(type)) handleOpenAsPage(type);
    };
    window.addEventListener('topics:open-utility', onOpenUtility as EventListener);
    return () => window.removeEventListener('topics:open-utility', onOpenUtility as EventListener);
  }, [handleOpenAsPage]);

  // Deep-link focus intent lifecycle. `topics:open-task` (emitted only by the
  // board deep-link path — boot URL + in-app self-link) arms the intent so the
  // board survives the hydrate storm; the board fires `topics:task-opened` once
  // the drawer actually opens, which releases it (the user is where they asked
  // to be — later hydrates may focus elsewhere normally again).
  //
  // `topics:open-tab` / `topics:tab-opened` sono i gemelli per un permalink di
  // tab: li emette `lib/tabLink.openTabInApp` (arma prima di instradare,
  // rilascia su ogni vicolo cieco), e App.tsx li usa per la ri-asserzione
  // debounced del boot. L'intento porta il pane id nell'evento e scade da solo.
  useEffect(() => {
    const onOpenTask = () => { deepLinkFocusRef.current = armFocusIntent(utilityPanelId('board')); };
    const onTaskOpened = () => { deepLinkFocusRef.current = null; };
    const onOpenTab = (e: Event) => {
      const paneId = (e as CustomEvent<{ paneId?: string }>).detail?.paneId;
      if (paneId) deepLinkTabFocusRef.current = armFocusIntent(paneId);
    };
    // L'ack di un permalink ha due letture (vedi `TabOpenedDetail` in
    // lib/tabLink): App.tsx ci spegne la ri-asserzione di boot in OGNI caso,
    // noi rilasciamo l'intento SOLO se è un vicolo cieco. Su un'apertura
    // riuscita l'intento va lasciato scadere da sé: è l'unica cosa che tiene la
    // tab a fuoco mentre il primo hydrate prova a restituire la scena alla pane
    // di prima — spegnerlo qui vorrebbe dire riaprire il bug che esiste per
    // chiudere. Lo rilascia comunque un focus DELIBERATO dell'utente
    // (handleFocusPanel / handleTopicClick), che è la sola cosa che deve batterlo.
    const onTabOpened = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail;
      if (tabAckReleasesIntent(detail)) deepLinkTabFocusRef.current = null;
    };
    window.addEventListener('topics:open-task', onOpenTask as EventListener);
    window.addEventListener('topics:task-opened', onTaskOpened as EventListener);
    window.addEventListener('topics:open-tab', onOpenTab as EventListener);
    window.addEventListener('topics:tab-opened', onTabOpened as EventListener);
    return () => {
      window.removeEventListener('topics:open-task', onOpenTask as EventListener);
      window.removeEventListener('topics:task-opened', onTaskOpened as EventListener);
      window.removeEventListener('topics:open-tab', onOpenTab as EventListener);
      window.removeEventListener('topics:tab-opened', onTabOpened as EventListener);
    };
  }, []);

  // Open/focus a project window from any surface (e.g. the board task detail's
  // project selector). Local mirror of the WS `open-project` branch below —
  // event-based like `topics:open-utility` so hosts don't need a prop chain.
  useEffect(() => {
    const onOpenProject = (e: Event) => {
      const projectPath = (e as CustomEvent<{ projectPath?: string }>).detail?.projectPath;
      if (!projectPath) return;
      // Stessa regola del click in sidebar: portare la scena su un progetto è
      // una destinazione, e chiude qualunque intento ancora aperto.
      releaseFocusIntents();
      const projectPaneId = createPaneId('project', projectPath);
      ensurePaneRegistered({ id: projectPaneId, type: 'project', projectPath });
      setOpenPanels(prev => prev.includes(projectPaneId) ? prev : [...prev, projectPaneId]);
      setFocusedPanelId(projectPaneId);
    };
    window.addEventListener('topics:open-project', onOpenProject as EventListener);
    return () => window.removeEventListener('topics:open-project', onOpenProject as EventListener);
  }, [releaseFocusIntents]);

  // ---- 11-16. Per-cluster WS subscriptions (CRITIQUE C6) ----

  // Per-session debounce for out-of-band thread reconciles (see Cluster 1).
  const threadReconcileTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // WS Cluster 1: topic sync + open-pane thread reconcile.
  //
  // `topic:updated` rides along with EVERY out-of-band thread change: a Path-B
  // sub-agent exit appending its result, a cross-window turn finalizing, a
  // server-side repair. The single `message:new` that usually accompanies it
  // keeps most panes in sync — but that broadcast is fire-and-forget (a dropped
  // frame loses the append), and it can't repair a thread whose *linearization*
  // changed under an already-mounted pane (the pane keeps a stale/truncated
  // cache with nothing to heal it until the user reopens it or the WS
  // reconnects). That was exactly the "chat looks cut in half" failure.
  //
  // So: whenever a topic we have OPEN gets a `topic:updated`, reconcile its
  // thread against the server. `loadHistory` MERGES (server truth + local-only
  // messages), so it's safe/idempotent; it also early-returns while we're the
  // one streaming, and we skip our own live stream up front. Debounced per
  // session so a finalize burst collapses to one fetch.
  useEffect(() => {
    // Capture the (stable, never-reassigned) timers Map once so the cleanup
    // clears exactly the map this effect wrote to — the react-hooks ref-in-
    // cleanup gotcha, even though here the ref identity can't actually change.
    const timers = threadReconcileTimersRef.current;
    const unsub = onWSMessage((msg) => {
      if (msg.type === 'topic:archived' || msg.type === 'topic:updated' || msg.type === 'topic:created') {
        if (msg.topic) applyTopicFromWSRef.current(msg.topic);
      }
      if (msg.type === 'topic:updated' && msg.topic?.sessionKey) {
        const t = msg.topic;
        if (!openPanelsRef.current.includes(t.id)) return;
        if (chatHandlersRef.current.isOwnStream(t.sessionKey)) return;
        const pending = timers.get(t.sessionKey);
        if (pending) clearTimeout(pending);
        timers.set(t.sessionKey, setTimeout(() => {
          timers.delete(t.sessionKey);
          chatHandlersRef.current.loadHistory(t.sessionKey);
        }, 400));
      }
    });
    return () => {
      unsub();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [onWSMessage, openPanelsRef, chatHandlersRef, applyTopicFromWSRef]);

  // Anteprime di sidebar: la fotografia iniziale, una volta al boot.
  //
  // Da qui in poi le tiene aggiornate il `message:new` del Cluster 2 qui sotto
  // (nessun secondo listener: il messaggio è già in mano lì). Senza questa
  // idratazione una chat ferma da ieri resterebbe muta finché non le arriva un
  // messaggio nuovo — cioè per sempre, che è esattamente il buco da chiudere.
  // UNA richiesta per tutte le chat: il server risponde con una query batch.
  useEffect(() => { void hydrateTopicPreviews(); }, []);

  // WS Cluster 2: message sync (notifications, media, clear, agents-spawned)
  useEffect(() => {
    // Permesso dei banner web, dalla porta unica: sotto Tauri NON si chiede.
    //
    // Qui c'era la richiesta nuda, senza il guard nativo. Questo effetto è
    // montato una volta PER FINESTRA, quindi con i gruppi staccati partivano N
    // prompt insieme a ogni avvio — e in WKWebView il permesso non sopravvive
    // al rilancio, quindi ripartivano SEMPRE. Sono «le tre spuntine da
    // rimettere ogni volta». Vedi `primeWebNotificationPermission`.
    void primeWebNotificationPermission();
    return onWSMessage((msg) => {
      // message:new cross-window sync — uses stable messageId for dedupe.
      // Falls back to last-of-role/content match for legacy emissions that
      // pre-date the messageId field (still in flight from older servers).
      if (msg.type === 'message:new') {
        // L'anteprima della riga di sidebar si aggiorna PRIMA del bail su
        // `isOwnStream`. Quel bail esiste perché la pane che sta streammando ha
        // già il messaggio in pagina — ma la riga in sidebar no, e sotto il bail
        // la chat che stai davvero guardando sarebbe l'unica a restare con
        // l'anteprima vecchia.
        applyMessagePreview(msg.topicId, msg.role, msg.content ?? msg.preview ?? '');
        if (chatHandlersRef.current.isOwnStream(msg.sessionKey)) return;
        const fullContent = msg.content ?? msg.preview ?? '';
        if (!fullContent) return;
        const id = msg.messageId;
        const existingMessages = chatHandlersRef.current.getSessionMessages(msg.sessionKey);
        // Lo stesso id non vuol dire più «ce l'abbiamo già»: il segnaposto della
        // bolla viva porta l'id durevole da `stream:start`, e per una finestra
        // che non è iscritta alla topic questa riga persistita è l'UNICO
        // contenuto che le arriverà (le delta le vengono filtrate). Si esce solo
        // se non c'è niente da riempire. Vedi `hooks/liveTurn.ts`.
        const held = id ? existingMessages.find(m => m.id === id) : undefined;
        if (held && !shouldFillFromBroadcast(held, fullContent)) return;
        if (!id) {
          // Legacy fallback: dedupe by last-of-role content match.
          const lastMsgOfRole = [...existingMessages].reverse().find(x => x.role === msg.role);
          if (lastMsgOfRole && lastMsgOfRole.content === fullContent) return;
        }
        chatHandlersRef.current.addMessageFromWS(msg.sessionKey, {
          id,
          role: msg.role,
          content: fullContent,
          timestamp: new Date().toISOString(),
        });
      }
      // Il banner del messaggio a finestra nascosta NON sta più qui.
      //
      // Stava, e chiamava `notifyNative` di suo: fuori dall'unica porta delle
      // notifiche e quindi fuori da tutti i suoi gate — suonava a topic
      // silenziato, con un Focus attivo, e con l'interruttore generale spento.
      // Per di più questo effetto è montato una volta PER FINESTRA e il frame è
      // un broadcast, quindi con i gruppi staccati un messaggio solo faceva N
      // banner. Ora vive in `useCompletionNotifier` insieme a tutti gli altri
      // segnali, con una claim cross-finestra per messageId che ne fa consegnare
      // uno solo (lib/notify/messageBannerClaim.ts).
      //
      // Attenzione a chi tocca il blocco `message:new` qui sopra: i suoi `return`
      // uscivano dall'INTERO handler, quindi zittivano anche il banner. Quei due
      // gate (isOwnStream, corpo vuoto) ora viaggiano espliciti nel notificatore.
      // message:media
      if (msg.type === 'message:media') {
        chatHandlersRef.current.appendMediaToLastAssistant(msg.sessionKey, msg.media);
      }
      // clear
      if (msg.type === 'clear') {
        chatHandlersRef.current.clearSession(msg.sessionKey);
        // …e l'anteprima di sidebar con esso. Senza, «Svuota chat» svuotava i
        // messaggi ma lasciava la riga a mostrare per sempre l'ultimo messaggio
        // appena cancellato: l'unica cosa che poteva sovrascriverla era un
        // messaggio NUOVO, e una chat svuotata non ne ha per definizione.
        // Il frame porta solo la `sessionKey`; il topic si ritrova dalla mappa
        // che questo cluster ha già in mano (nessuna fetch, nessuna dipendenza
        // nuova).
        const cleared = Object.values(topicsRef.current).find(t => t.sessionKey === msg.sessionKey);
        if (cleared) clearTopicPreview(cleared.id);
      }
    });
  }, [onWSMessage, topicsRef, chatHandlersRef]);

  // WS Cluster 3: topic switch + topic switch complete (CRITIQUE C13)
  // ownTopicSwitchesRef writer + reader co-located here.
  const ownTopicSwitchesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    return onWSMessage((msg) => {
      if (msg.type === 'topic:switch') {
        const fromSK = msg.fromSessionKey;
        if (!fromSK || chatHandlersRef.current.isOwnStream(fromSK)) {
          if (fromSK) ownTopicSwitchesRef.current.add(fromSK);
          // Register the pane BEFORE pushing into openPanels — same trap the
          // open-project handler below documents: Effect B's REORDER_PANES
          // bridge filters to ids WITH a pane entity in the store, so a bare
          // setOpenPanels here leaves the id in React state but absent from
          // state.panes, and the next Effect A tick silently drops it back
          // out of openPanels (the tab never appears).
          ensurePaneRegistered(
            { id: msg.toTopicId, type: 'chat', topicId: msg.toTopicId, title: topicsRef.current[msg.toTopicId]?.name },
            { groupId: 'group:default' },
          );
          if (!openPanelsRef.current.includes(msg.toTopicId)) {
            setOpenPanels(prev => [...prev, msg.toTopicId]);
          }
          setFocusedPanelId(msg.toTopicId);
        }
      }
      if (msg.type === 'topic:switch:complete') {
        if (!ownTopicSwitchesRef.current.has(msg.fromSessionKey)) return;
        ownTopicSwitchesRef.current.delete(msg.fromSessionKey);
        const h = chatHandlersRef.current;
        h.clearSession(msg.fromSessionKey);
        h.loadHistory(msg.fromSessionKey);
        if (msg.userContent) {
          h.addMessageFromWS(msg.toSessionKey, { role: 'user', content: msg.userContent, timestamp: new Date().toISOString() });
        }
        if (msg.assistantContent) {
          h.addMessageFromWS(msg.toSessionKey, { role: 'assistant', content: msg.assistantContent, timestamp: new Date().toISOString() });
        }
        setOpenPanels(prev => prev.filter(id => id !== msg.fromTopicId));
        setFocusedPanelId(msg.toTopicId);
      }
    });
  }, [onWSMessage, openPanelsRef, topicsRef, chatHandlersRef]);

  // WS Cluster 4: open-project broadcast
  useEffect(() => {
    return onWSMessage((msg) => {
      if (msg.type === 'open-project') {
        const projectPaneId = createPaneId('project', msg.projectPath);
        // Register the pane in the store FIRST (same as the pane:focus-suggest
        // branch below). A bare setOpenPanels leaves the id in React openPanels
        // but absent from state.panes, so Effect B's REORDER_PANES — which
        // filters to ids WITH a pane entity (groups.ts orphan-ID guard) — drops
        // it, and the next Effect A tick wipes it back out of openPanels. That's
        // the "open_project says done but the project never appears" bug for a
        // terminal-tab move: the server splices the terminal into the project's
        // membership and broadcasts open-project, but the project pane was a
        // ghost that the store→React bridge immediately reaped.
        ensurePaneRegistered({ id: projectPaneId, type: 'project', projectPath: msg.projectPath });
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
    // Project chat / TASK WORKSPACE session → open its PROJECT PANE (splittable
    // window), not a loose chat. For a task workspace this is what gives the
    // agent's browser/output panes a home (they route by the task's unique
    // projectPath). Mirrors handleTopicClick's project route.
    const opTopic = topics[topicId];
    if (opensAsProjectPane(opTopic) && opTopic?.projectPath) {
      const projectPaneId = createPaneId('project', opTopic.projectPath);
      ensurePaneRegistered({ id: projectPaneId, type: 'project', projectPath: opTopic.projectPath, title: opTopic.name });
      if (isMobile) {
        setOpenPanels([projectPaneId]);
        setSidebarCollapsed(true);
      } else if (!openPanels.includes(projectPaneId)) {
        setOpenPanels(prev => [...prev, projectPaneId]);
      }
      setFocusedPanelId(projectPaneId);
      setPendingProjectFocus({ projectPath: opTopic.projectPath, topicId });
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
  }, [openPanels, previewPanelId, isMobile, topics, archiveTopic, setSidebarCollapsed]);

  // Open a TOPIC as a chat tab from any surface (e.g. the global board's task
  // drawer "apri la sessione" — its hosts have no openPanel in scope). Same
  // event-based pattern as `topics:open-project`; goes through the standard
  // open funnel (unarchives = the 2-state model's "open").
  //
  // PREVIEW (transient) tab: a task's agent session is a peek, not a commitment
  // — it opens in the single ephemeral slot (replaced by the next preview,
  // gone if you don't engage), and gets pinned the moment you interact (send a
  // message / double-click), exactly like a single-clicked sidebar topic. The
  // `permanent` opt-in stays available for callers that pass it in the detail.
  useEffect(() => {
    const onOpenTopic = (e: Event) => {
      const detail = (e as CustomEvent<{ topicId?: string; mode?: 'preview' | 'permanent' }>).detail;
      if (detail?.topicId) openPanel(detail.topicId, detail.mode ?? 'preview');
    };
    window.addEventListener('topics:open-topic', onOpenTopic as EventListener);
    return () => window.removeEventListener('topics:open-topic', onOpenTopic as EventListener);
  }, [openPanel]);


  // Keep the openPanelRef (declared up top, before the WS effects) pointed at
  // the latest openPanel so the stable [onWSMessage] handlers invoke the
  // current closure without referencing openPanel before its declaration.
  useEffect(() => { openPanelRef.current = openPanel; }, [openPanel]);

  // ---- 2-state model: project-window chat close/reopen events ----
  // useProjectLayout can't reach archiveTopic (TopicsContext omits actions),
  // so it emits window events; translate them into the same archive/unarchive
  // the standalone path does inline. Close → archive (lead exempt, like
  // handleClosePanel); reopen/undo → unarchive.
  useEffect(() => {
    const onArchive = (e: Event) => {
      const id = (e as CustomEvent<{ topicId?: string }>).detail?.topicId;
      const t = id ? topicsRef.current[id] : undefined;
      // Pinned (Fissati) chats archive on close like every other chat — BOTH
      // archive funnels share the one contract. `archived` is the durable,
      // cross-client closed signal; the pinnedIds sidebar escape keeps the row
      // and reopen unarchives. See handleClosePanel for the full rationale
      // (the pinned-exempt variant resurrected closed pinned chats across a
      // multi-client sync because only the device-local tombstone protected
      // them).
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
    // A deliberate tab switch releases any pending deep-link focus intent, so a
    // later hydrate doesn't yank the user back to the board — o alla tab di un
    // permalink, che ha lo stesso privilegio e la stessa uscita.
    releaseFocusIntents();
    const topic = topics[topicId];
    // Project chat / TASK WORKSPACE session → its splittable project pane. A
    // `standalone` non-task topic falls through to the loose-chat funnel.
    if (opensAsProjectPane(topic)) {
      // 2-state model: opening an (archived = closed) project chat restores it.
      if (topic!.archived) void archiveTopic(topicId, false);
      const projectPaneId = createPaneId('project', topic!.projectPath!);
      ensurePaneRegistered({ id: projectPaneId, type: 'project', projectPath: topic!.projectPath!, title: topic!.name });
      if (isMobile) {
        setOpenPanels([projectPaneId]);
        setSidebarCollapsed(true);
      } else if (!openPanels.includes(projectPaneId)) {
        setOpenPanels(prev => [...prev, projectPaneId]);
      }
      setFocusedPanelId(projectPaneId);
      setPendingProjectFocus({ projectPath: topic!.projectPath!, topicId });
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
  }, [openPanel, isMobile, topics, openPanels, setSidebarCollapsed, archiveTopic, releaseFocusIntents]);

  const handleTopicDoubleClick = useCallback((topicId: string, _e?: React.MouseEvent) => {
    openPanel(topicId, 'permanent');
  }, [openPanel]);

  // handleClosePanel (stable identity via ref-backed impl)
  const handleClosePanelRef = useRef<(topicId: string, opts?: { silent?: boolean }) => void>(() => {});
  // Intentional ref-backed stable-callback pattern: handleClosePanel (below, deps [])
  // stays stable while .current always holds the latest closure; only invoked from
  // event handlers / undo, never read during render.
  handleClosePanelRef.current = (topicId: string, opts?: { silent?: boolean }) => {
    // Dedup rapid double-invokes: a fast double-click on a tab's close button
    // fires two discrete click events, and React flushes the first close between
    // them. openPanelsRef is a render-time mirror, so by the second call topicId
    // is already gone — bail before pushing a SECOND, spurious undo entry (its
    // panelIndex would be -1, and undo would splice the tab back at the wrong
    // slot, duplicating it). Undo/redo re-add the pane first, so both still work.
    if (!openPanelsRef.current.includes(topicId)) return;
    // Le tre (ora quattro) conseguenze della chiusura di una pane BROWSER
    // vivono qui, e non solo nel gestore per-tipo di usePaneLifecycle, perche'
    // questo e' l'UNICO imbuto da cui passano tutte le strade: la X, ⌘W, il
    // «Chiudi ora» del tasto destro, il commit della chiusura differita e il
    // broadcast dell'agente. Passando solo dalla X, con ⌘W la tab spariva di
    // qui ma restava sul telefono (nessun tombstone cross-device) e il pallino
    // «ha aperto un browser» restava appeso alla chat che l'aveva aperta
    // (relazione spawner mai cancellata).
    //
    // La guardia qui sopra (`openPanelsRef.current.includes`) garantisce che
    // non scatti mai per una pane interna a un progetto, che ha il suo
    // percorso in useProjectLayout. E il doppio scatto con la X e' innocuo:
    // `destroyContext` esce in silenzio su un id sconosciuto, tombstone e
    // spawner sono idempotenti, e `browser_close` su una label gia' chiusa e'
    // un no-op.
    if (isBrowserPaneId(topicId)) {
      const bctx = getBrowserContextFromPaneId(topicId);
      if (bctx) {
        fetch(`/api/browsers/${encodeURIComponent(bctx)}`, { method: 'DELETE', keepalive: true }).catch(() => {});
        clearBrowserSpawner(bctx);
        addBrowserTombstone(bctx);
        if (isTauri) void tauriInvoke('browser_close', { id: bctx }).catch(() => {});
      }
    }
    const closingTopic = topicsRef.current[topicId];
    // 2-state model: a USER-closed chat tab archives the topic (closed ⟺
    // archived). Guard to REAL chat topics only — never drafts, never the
    // prefixed terminal/browser/project pane ids (topicsRef holds only chats).
    // This sits in the single user-close funnel (X / right-click Close-now /
    // Cmd+W / deferred-commit all reach here); incidental closes go through the
    // reducer / setOpenPanels and never call this, so they won't archive.
    //
    // Pinned (Fissati) chats archive on close EXACTLY like every other chat.
    // `archived` is the durable, server-authoritative, cross-client closed
    // signal (the 2-state model): the client-side validPanels effect evicts an
    // archived chat on every hydrate regardless of what a stale peer's pane
    // snapshot says. Exempting pinned chats (the original Fissati behaviour)
    // left the closure represented ONLY by the device-local, FIFO-bounded
    // closedStack tombstone — a stale second client / mobile PWA / the server's
    // own stored snapshot then out-raced the close and resurrected the tab
    // ("closed pinned chat reappears"). The pinned sidebar ROW does not depend
    // on the topic being non-archived: buildSidebarItems' pinnedIds escape keeps
    // it listed even when archived, and openPanel/handleTopicClick unarchive on
    // reopen — so "one click reopens" (Arc semantics) is fully preserved.
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
        //
        // Spazi: the math runs on the VISIBLE subset — `next` still contains
        // panes hidden in other spaces, and focusing one of those would make
        // the focus-follow effect switch the whole window. Closing the last
        // visible tab focuses null (the space stays, rendered empty).
        const s = usePaneStore.getState();
        const visNext = filterVisiblePaneIds(next, s.panes, s.spaces, s.activeSpaceId);
        const visIndex = prev
          .slice(0, panelIndex)
          .filter(id => visNext.includes(id)).length;
        setFocusedPanelId(visNext.length > 0 ? visNext[Math.min(visIndex, visNext.length - 1)] : null);
      }
      return next;
    });
    if (isDraftPaneId(topicId)) {
      forgetDraft(topicId);
      setDraftMeta(prev => {
        const next = { ...prev };
        delete next[topicId];
        return next;
      });
    }
    // Chiusure che l'utente non ha chiesto (la bozza vuota che si congeda
    // quando cambi tab) non entrano nella pila dell'annulla: ⌘Z deve disfare
    // l'ultima cosa FATTA, non resuscitare un foglio bianco.
    if (opts?.silent) return;
    pushUndo({
      description: `Close panel`,
      undo: () => {
        // Unarchive FIRST (optimistic archived:false this render) so the
        // re-added pane isn't immediately evicted by the validPanels effect.
        if (archivesOnClose) void archiveTopic(topicId, false);
        // Undo is ADDITIVE (same contract as the Cmd+Shift+T reopen path at
        // §19): UNDO_CLOSE re-inserts topicId, Effect A propagates it into
        // openPanels → the standalone tab-ordering effect (usePaneOrdering)
        // then sees a single-tab add. Without this marker it mis-reads that add
        // as a preview-navigation and replace+closes the FIRST unpinned tab
        // (findPreviewInList returns the first non-pinned id, not a real
        // preview) — a bystander tab silently vanishes on every undo. Mark the
        // restored id BEFORE the dispatch so consumeTabRestored short-circuits
        // the preview replacement on the next render.
        markTabRestored(topicId);
        // CLOSE_PANE deleted the entity from state.panes and pushed a
        // ClosedPaneRecord onto closedStack. A bare openPanels-splice can't
        // bring it back: Effect B fires REORDER_PANES, which filters out any
        // id missing from state.panes (a permutation can't resurrect a deleted
        // pane), then Effect A snaps openPanels back to the store's group. Only
        // UNDO_CLOSE re-inserts the entity (at its recorded groupIndex),
        // retracts the tombstone, and restores focus — Effect A then syncs
        // openPanels from the restored group.
        usePaneStore.getState().dispatch({ type: 'UNDO_CLOSE' });
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

  // Remote pane close (close_browser_pane MCP tool → POST browser/close-pane →
  // `browser:close-pane` broadcast): whichever window renders `browser:<ctx>`
  // closes it through the NORMAL close flow. Server-side membership edits
  // can't do this — the keys are LWW documents live clients re-persist from
  // memory, clobbering the removal back within seconds — so the close must
  // originate in the owning client. Ownership-guarded on both surfaces:
  //   - project windows: the existing `browser:request-close` DOM listener
  //     (useProjectLayout) closes ONLY when its layout lists the pane;
  //   - app level: close only when this window's store/tabs hold the id.
  // Windows that don't own the pane no-op, so the broadcast is idempotent.
  useEffect(() => {
    return onWSMessage((msg) => {
      const m = msg as { type?: string; contextId?: string };
      if (m.type !== 'browser:close-pane' || !m.contextId) return;
      // A pane opened from a TERMINAL mounts under the owning topic/project's
      // browser ctx, not the `term-<id>` the server broadcasts — resolve it via
      // the spawner registry so the session that opened it can actually close
      // it (otherwise it leaks as an unclosable ghost). Non-terminal ids pass
      // through, so the topic/chat close path is unchanged.
      const contextId = resolveTerminalBrowserContext(m.contextId);
      window.dispatchEvent(new CustomEvent('browser:request-close', {
        detail: { contextId },
      }));
      const paneId = createPaneId('browser', contextId);
      const state = usePaneStore.getState();
      const atAppLevel = Object.values(state.groups).some(g => g.paneIds.includes(paneId));
      if (atAppLevel || openPanelsRef.current.includes(paneId)) {
        handleClosePanel(paneId);
      }
    });
  }, [onWSMessage, handleClosePanel, openPanelsRef]);

  // Remote pane FOCUS (browser_focus_tab MCP tool → POST browser/focus-pane →
  // `browser:focus-pane` broadcast): whichever window renders `browser:<ctx>`
  // brings that tab to the front. Mirror of the close-pane path, idempotent:
  //   - project windows: the `browser:request-focus` DOM listener
  //     (useProjectLayout) activates the pane in its group when its layout
  //     owns it;
  //   - app level: if this window's store/tabs hold the id, surface it (add to
  //     openPanels if backgrounded) and mark it focused.
  // Windows that don't own the pane no-op, so the broadcast is safe to fan out.
  useEffect(() => {
    return onWSMessage((msg) => {
      const m = msg as { type?: string; contextId?: string };
      if (m.type !== 'browser:focus-pane' || !m.contextId) return;
      window.dispatchEvent(new CustomEvent('browser:request-focus', {
        detail: { contextId: m.contextId },
      }));
      const paneId = createPaneId('browser', m.contextId);
      const state = usePaneStore.getState();
      const atAppLevel = Object.values(state.groups).some(g => g.paneIds.includes(paneId));
      if (atAppLevel || openPanelsRef.current.includes(paneId)) {
        // Ensure a backgrounded tab is actually open before focusing it.
        setOpenPanels(prev => prev.includes(paneId) ? prev : [...prev, paneId]);
        setFocusedPanelId(paneId);
      }
    });
  }, [onWSMessage, openPanelsRef, setOpenPanels, setFocusedPanelId]);

  const handleProjectClick = useCallback((projectPath: string) => {
    // Aprire un progetto dalla sidebar è una navigazione VOLUTA quanto un click
    // su una tab: rilascia l'intento, o il primo dispatch che passa riporta la
    // finestra sulla board (era esattamente il guasto riportato).
    releaseFocusIntents();
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
  }, [isMobile, setSidebarCollapsed, releaseFocusIntents]);
  // Pin into the forward ref so openBrowserPane (declared above) can open a
  // CLOSED project to route a pinned browser back into it.
  handleProjectClickRef.current = handleProjectClick;

  const handleCloseProject = useCallback((projectPath: string) => {
    const paneId = createPaneId('project', projectPath);
    // Project tabs have no undo affordance here (no pushUndo, unlike
    // handleClosePanel's CLOSE_PANE), so purge the pane entity from the store
    // outright instead of leaving it orphaned. Without this, the entity and
    // its group membership survive in `state.panes` forever — and worse,
    // REORDER_PANES (Effect B, dispatched next render from the shrunk
    // openPanels) is a pure permutation primitive that RE-APPENDS any current
    // group member missing from its payload (groups.ts orphan-guard), so a
    // bare setOpenPanels filter would resurrect the closed tab on the very
    // next Effect A store→React sync tick.
    usePaneStore.getState().dispatch({ type: 'PURGE_ORPHAN_PANE', payload: { id: paneId } });
    setOpenPanels(prev => {
      const next = prev.filter(id => id !== paneId);
      if (focusedPanelIdRef.current === paneId) {
        // Spazi: hand focus to the last VISIBLE pane, not a hidden one (which
        // would drag the window to another space via focus-follow).
        const s = usePaneStore.getState();
        const visNext = filterVisiblePaneIds(next, s.panes, s.spaces, s.activeSpaceId);
        setFocusedPanelId(visNext.length > 0 ? visNext[visNext.length - 1] : null);
      }
      return next;
    });
  }, [focusedPanelIdRef]);

  const handleFocusPanel = useCallback((topicId: string) => {
    // A deliberate focus change releases any pending deep-link focus intent
    // (board E permalink di tab: nessuno dei due deve battere una scelta
    // esplicita dell'utente).
    releaseFocusIntents();
    // Direct terminal pane ids (e.g. `terminal:<sessionId>`) — produced by
    // the Master sessions endpoint when surfacing Claude Code terminals.
    // These aren't topics, so handleTerminalClick handles them: if the cwd
    // matches a known project, the click lands inside that project; else a
    // standalone terminal pane is opened.
    if (topicId.startsWith('terminal:')) {
      const sessionId = topicId.slice('terminal:'.length);
      const session = terminalSessionsRef.current.find(s => s.id === sessionId);
      // Inline routing — duplicates the body of handleTerminalClick but
      // avoids reaching into it here (avoids a deps cycle). Build the known-
      // project set first so both the locator (dedup) and the broad-path
      // routing guard share it.
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

      // STRUCTURAL DEDUP (mirrors handleTerminalClick): focus the session where
      // it already lives instead of duplicating it. Without this, a focus-signal
      // (awaiting-feedback / Master session surfacing) for a session already
      // open standalone — or in another project — spawned a second tab.
      const existing = locateTerminalPane(
        sessionId,
        openPanelsRef.current,
        [...knownProjectPaths],
        browserProjectPanesStore(),
      );
      if (existing.kind === 'standalone') {
        setOpenPanels((prev) => prev.includes(topicId) ? prev : [...prev, topicId]);
        setFocusedPanelId(topicId);
        usePaneStore.getState().dispatch({ type: 'FOCUS_PANE', payload: { id: topicId } });
        return;
      }
      if (existing.kind === 'project') {
        const projectPaneId = createPaneId('project', existing.projectPath);
        ensurePaneRegistered({ id: projectPaneId, type: 'project', projectPath: existing.projectPath });
        setOpenPanels((prev) => prev.includes(projectPaneId) ? prev : [...prev, projectPaneId]);
        setFocusedPanelId(projectPaneId);
        usePaneStore.getState().dispatch({ type: 'FOCUS_PANE', payload: { id: projectPaneId } });
        setPendingProjectPane({ projectPath: existing.projectPath, type: 'terminal' as PaneType, terminalSessionId: sessionId });
        return;
      }
      // 'project-unknown' / 'none' → fall through to routing below.

      if (session?.cwd) {
        // Same broad-path guard as handleTerminalClick: a cwd that is an
        // ANCESTOR of a known project (e.g. the home dir, parent of all
        // your projects) is too broad to be a project — its window would
        // adopt every terminal/chat underneath it. Open such a session as
        // a standalone terminal instead of a catch-all home project tab.
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
    // Project-scoped topics + TASK WORKSPACE sessions open through their PROJECT
    // pane, mirroring handleTopicClick — otherwise they appear as ghost tabs.
    // A `standalone` non-task topic is the exception: a loose tab by design.
    const topic = topicsRef.current[topicId];
    if (opensAsProjectPane(topic)) {
      const projectPaneId = createPaneId('project', topic!.projectPath!);
      ensurePaneRegistered({ id: projectPaneId, type: 'project', projectPath: topic!.projectPath!, title: topic!.name });
      setOpenPanels((prev) => prev.includes(projectPaneId) ? prev : [...prev, projectPaneId]);
      setFocusedPanelId(projectPaneId);
      // Also dispatch directly to the store so Effect A's store→React
      // bridge can't snap focus back to a previously-focused pane on
      // the next subscribe-tick.
      usePaneStore.getState().dispatch({ type: 'FOCUS_PANE', payload: { id: projectPaneId } });
      setPendingProjectFocus({ projectPath: topic!.projectPath!, topicId });
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
  }, [openPanel, openPanelsRef, terminalSessionsRef, topicsRef, workspaceProjectsRef, releaseFocusIntents]);

  // Reorders arrive from the VISIBLE surface (PanelGrid gets visiblePanels),
  // so `panels` may be a SUBSET of openPanels — panes hidden in other Spazi
  // are absent. MERGE instead of replace: reordered members take their new
  // relative order, hidden panes keep their slots (replacing outright would
  // evict them from React state and reset their order via Effect B's
  // permutation-guard re-append). Same merge shape as PanelGrid's
  // handlePersistPoolReorder. A full-set reorder degenerates to the identity
  // merge, so legacy callers are unaffected.
  const handleReorderPanels = useCallback((panels: string[]) => {
    setOpenPanels(prev => {
      const prevSet = new Set(prev);
      const orderable = panels.filter(id => prevSet.has(id));
      const orderSet = new Set(orderable);
      let i = 0;
      const merged = prev.map(id => (orderSet.has(id) ? orderable[i++] : id));
      for (const id of panels) {
        if (!prevSet.has(id)) merged.push(id); // defensive: brand-new id
      }
      return merged;
    });
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
    // Chiedere una chat nuova è dire dove si vuole stare: nessun intento
    // rimasto in giro deve poter riportare la scena altrove mentre la chat
    // nasce (la creazione muta lo store, e ogni mutazione risveglia Effect A).
    releaseFocusIntents();
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
    // Una chat nuova alla volta. Chiedere «nuova chat» mentre un foglio bianco
    // è già aperto non ne apre un secondo: riporta il fuoco su quello. Erano
    // tab identiche e indistinguibili, e nessuna delle due era «quella
    // giusta». Basta scriverci una parola perché la bozza smetta di essere
    // vuota, e da lì in poi la prossima «nuova chat» ne apre davvero una nuova.
    // Cercata fra le pane VISIBILI, non fra tutte: una bozza vuota lasciata in
    // un altro spazio non è «la chat nuova che hai già aperto», e riusarla
    // teleporterebbe la finestra su un altro gruppo per un ⌘N.
    const alreadyOpen = findEmptyDraftPane(visiblePanelsRef.current);
    if (alreadyOpen) {
      // È già in openPanels: openPanel qui non duplica niente, le ridà solo il
      // fuoco (e il composer di una chat vuota se lo prende da sé).
      openPanel(alreadyOpen, 'permanent', true);
      return alreadyOpen;
    }
    const draftId = createDraftPaneId();
    setDraftMeta(prev => ({ ...prev, [draftId]: { createdAt: new Date().toISOString() } }));
    openPanel(draftId, 'permanent', true);
    return draftId;
  }, [createTopic, openPanel, visiblePanelsRef, releaseFocusIntents]);

  // ── «Aperta ma non aperta»: la bozza vuota se ne va da sé ────────────────
  //
  // Apri la chat nuova, cambi idea, torni su una tab esistente: il foglio
  // bianco non ha ragione di restare. Si chiude quando smetti di guardarlo — e
  // SOLO se è ancora bianco: una parola scritta, un file allegato o
  // un'immagine incollata lo rendono tuo, e da quel momento non se ne va più
  // da solo (`state/draftPane.ts` è l'unico posto dove «vuota» è definita).
  // «Ha perso il fuoco» non basta a dire che l'hai lasciata. Il fuoco di una
  // pane appena nata RIMBALZA: React lo mette sulla bozza, il ponte
  // store→React rimanda indietro quello vecchio dello store, e un istante dopo
  // torna sulla bozza. Chiudere sul primo di quei fotogrammi vuol dire chiudere
  // la chat che l'utente ha appena aperto — «mi si apre al volo ma poi mi si
  // chiude subito». Due guardie, e nessuna delle due indovina:
  //   • la chiusura è DIFFERITA: se il fuoco torna sulla bozza entro la
  //     finestra, si annulla e non è successo niente;
  //   • una bozza che non ha mai avuto il fuoco per almeno mezzo secondo non
  //     è mai stata guardata, quindi non può essere stata lasciata.
  const prevFocusedForDraftRef = useRef<string | null>(focusedPanelId);
  const draftFocusedAtRef = useRef<Map<string, number>>(new Map());
  const pendingDraftCloseRef = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => {
    const prev = prevFocusedForDraftRef.current;
    prevFocusedForDraftRef.current = focusedPanelId;

    if (focusedPanelId && isDraftPaneId(focusedPanelId) && !draftFocusedAtRef.current.has(focusedPanelId)) {
      draftFocusedAtRef.current.set(focusedPanelId, Date.now());
    }
    // È tornata davanti mentre la chiusura era in volo: annullala.
    const pending = pendingDraftCloseRef.current;
    if (pending && pending.id === focusedPanelId) {
      clearTimeout(pending.timer);
      pendingDraftCloseRef.current = null;
    }

    if (!prev || prev === focusedPanelId) return;
    if (!isDraftPaneId(prev)) return;
    if (pendingDraftCloseRef.current?.id === prev) return;
    const since = draftFocusedAtRef.current.get(prev);
    if (since === undefined || Date.now() - since < DRAFT_MIN_LOOKED_AT_MS) return;

    const timer = setTimeout(() => {
      pendingDraftCloseRef.current = null;
      // Rileggere TUTTO allo scadere, non fidarsi della fotografia: nel
      // frattempo la bozza può essere tornata davanti, essere stata promossa
      // (l'id cambia sotto), chiusa a mano, o aver ricevuto del testo.
      if (focusedPanelIdRef.current === prev) return;
      if (!openPanelsRef.current.includes(prev)) return;
      if (!isDraftDisposable(prev)) return;
      draftFocusedAtRef.current.delete(prev);
      forgetDraft(prev);
      // `silent`: la chiusura non l'hai chiesta tu, quindi non deve finire nella
      // pila dell'annulla — ⌘Z deve disfare l'ultima cosa che hai FATTO, non
      // riportare indietro un foglio bianco che avevi lasciato.
      handleClosePanelRef.current(prev, { silent: true });
    }, DRAFT_CLOSE_DELAY_MS);
    pendingDraftCloseRef.current = { id: prev, timer };
  }, [focusedPanelId, openPanelsRef, focusedPanelIdRef]);
  // Nessun timer sopravvive allo smontaggio della finestra.
  useEffect(() => () => {
    if (pendingDraftCloseRef.current) clearTimeout(pendingDraftCloseRef.current.timer);
  }, []);


  const promoteDraft = useCallback(async (draftId: string, firstMessage: string, options?: SendMessageOptions) => {
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
    try { localStorage.removeItem(draftTextKey(draftId)); } catch {}
    forgetDraft(draftId);
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
    // Same PURGE as handleCloseProject above: terminal tabs have no undo
    // path, so drop the pane entity from the store instead of leaving it
    // orphaned (a bare setOpenPanels filter would let REORDER_PANES
    // re-append it — see handleCloseProject for the full mechanism).
    usePaneStore.getState().dispatch({ type: 'PURGE_ORPHAN_PANE', payload: { id: paneId } });
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
    // Collect every path we consider a "project" for this session (topics,
    // workspace, and any currently-open project pane). Used BOTH to decide
    // routing AND, more importantly, to let the locator attribute an existing
    // in-project tab to a named window.
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

    // STRUCTURAL DEDUP: a terminal session's pane id (`terminal:<sessionId>`) is
    // a global identity — it may legitimately be shown in exactly ONE place.
    // Before routing, ask the single locator where (if anywhere) it already
    // lives, scanning BOTH the app-level tab set and every project's persisted
    // inner layout. If it's already open, FOCUS that surface instead of minting
    // a second tab (the bug: the same session appearing standalone AND inside a
    // project, because each open path only checked its own surface).
    const existing = locateTerminalPane(
      sessionId,
      openPanels,
      [...knownProjectPaths],
      browserProjectPanesStore(),
    );
    if (existing.kind === 'standalone') {
      const paneId = createPaneId('terminal', sessionId);
      setFocusedPanelId(paneId);
      if (isMobile) setSidebarCollapsed(true);
      return;
    }
    if (existing.kind === 'project') {
      const projectPaneId = createPaneId('project', existing.projectPath);
      if (isMobile) {
        setOpenPanels([projectPaneId]);
        setSidebarCollapsed(true);
      } else if (!openPanels.includes(projectPaneId)) {
        setOpenPanels(prev => [...prev, projectPaneId]);
      }
      setFocusedPanelId(projectPaneId);
      // Ask the project window to focus (not add) its existing terminal tab —
      // the pendingPane consumer's own dedup guard reuses it by id.
      setPendingProjectPane({ projectPath: existing.projectPath, type: 'terminal' as PaneType, terminalSessionId: sessionId });
      if (isMobile) setSidebarCollapsed(true);
      return;
    }
    // 'project-unknown': it's open in a project window whose path we can't name
    // from here. Fall through to the normal routing below — the destination's
    // pendingPane guard (keyed on the same pane id) still reuses the tab rather
    // than duplicating, and we avoid creating a competing standalone tab.

    if (session?.cwd) {
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
      // On Tauri, WKWebView's window.close() is a no-op — ask the shell to close
      // THIS NSWindow. The old location.href fallback would silently reload a
      // full app instance that double-syncs pane-store, so it must not run here.
      if (isTauri) {
        void tauriInvoke('window_close_self').catch(() => {});
        return;
      }
      window.close();
      setTimeout(() => {
        window.location.href = window.location.origin;
      }, 200);
    }
  }, [isDetached, openPanels.length]);

  // ---- 21. Cross-window presence announce ----
  // Every window advertises the chat topics it currently holds so peers can
  // render "open in another window" markers/glyphs and route a sidebar click to
  // the right OS window. WS-ephemeral (server never persists it). The chat set
  // is openPanels minus the non-topic pane kinds (project/terminal/browser/
  // draft ids are not topics). Re-announced on every set/focus
  // change and on WS reconnect (the connection carries no presence until we do).
  const presenceTopicIds = useMemo(
    () =>
      openPanels.filter(
        (id) =>
          !isProjectPaneId(id) &&
          !isTerminalPaneId(id) &&
          !isBrowserPaneId(id) &&
          !isDraftPaneId(id),
      ),
    [openPanels],
  );
  const focusedTopicForPresence =
    focusedPanelId && presenceTopicIds.includes(focusedPanelId) ? focusedPanelId : undefined;

  // Every tab this window holds, not just its chats: a window is the group its
  // tabs belong to, and the sidebar's "Finestre" section listed only chats — so
  // a window made of three terminals and a project announced nothing and drew
  // as an empty row.
  //
  // Subscribed as a flat array of STRINGS with useShallow, never as `s.panes`.
  // That store's identity changes on every pane write — `setPaneScrollOffset`
  // does one every 250ms while a chat scrolls — and subscribing to it would
  // re-announce presence to every socket four times a second (the same trap
  // documented above `visibleFromStore`). Encoded this way the snapshot only
  // changes when a tab is added, removed, renamed or retyped.
  const paneTabsEncoded = usePaneStore(
    useShallow((s) =>
      openPanels.map((id) => {
        const p = s.panes[id];
        return [id, p?.type ?? 'chat', p?.title ?? ''].join(PRESENCE_TAB_SEP);
      }),
    ),
  );
  const presenceTabs = useMemo(
    () => paneTabsEncoded.map((enc) => {
      const [id, type, ...rest] = enc.split(PRESENCE_TAB_SEP);
      const title = rest.join(PRESENCE_TAB_SEP);
      return title ? { id, type, title } : { id, type };
    }),
    [paneTabsEncoded],
  );
  const prevPresenceWsStatus = useRef(wsStatus);
  useEffect(() => {
    const reconnected =
      prevPresenceWsStatus.current !== 'connected' && wsStatus === 'connected';
    prevPresenceWsStatus.current = wsStatus;
    if (wsStatus !== 'connected') return;
    // `reconnected` is referenced only to make the reconnect edge a real dep
    // trigger; the announce below is identical whether it's a set change or a
    // fresh connection (full-snapshot semantics make it idempotent).
    void reconnected;
    sendWS({
      type: 'presence:announce',
      windowId,
      windowLabel: currentWindowLabel() ?? undefined,
      detached: isDetached,
      spaceId: spaceWindowId() ?? undefined,
      topicIds: presenceTopicIds,
      focusedTopicId: focusedTopicForPresence,
      tabs: presenceTabs,
    });
    // Same trigger, same topic set: declare the open topics for per-token delta
    // routing (server → WSData.openTopicIds). Kept in lock-step with the presence
    // announce so a window never has a stale subscription and misses its stream;
    // a window that never sends this still receives everything (legacy branch).
    sendWS({ type: 'subscribe', topicIds: presenceTopicIds });
  }, [wsStatus, windowId, isDetached, presenceTopicIds, focusedTopicForPresence, presenceTabs, sendWS]);

  return {
    state: {
      openPanels,
      visiblePanels,
      activeSpaceId,
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
