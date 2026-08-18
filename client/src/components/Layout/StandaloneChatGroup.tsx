import { useState, useCallback, useMemo, lazy, Suspense } from 'react';
import type { TerminalAgentType } from '../../../../shared/terminal-session-types';
import type { Topic, ChatMessage, WSMessage, UpdateTopicRequest, Pane, PaneType, PanelTab, CompactionMarker } from '../../types';
import { useTopics, useTerminalSessions } from '../../contexts/TopicsContext';
import { PaneTabBar } from './PaneTabBar';
import { ChatPanel } from './ChatPanel';
import { LazyPane } from './LazyPane';
import { SidebarToggleButton } from '../Shared/SidebarToggleButton';
import { DND_TYPES, STANDALONE_SCOPE } from '../../lib/dndTypes';
import { CHROME_BAR, CHROME_BAR_H_VAR, CHROME_ROW_ACTION_INSET_LEFT, CHROME_ROW_ACTION_RESERVE_LEFT, RAISED_CONTROL, TAB_LABEL } from '../../lib/selectionStyles';
import { isUtilityPanelId, parseUtilityPanelType } from './UtilityPanel';
import {
  PANE_CONFIG,
  getAddableTypesForScope,
  isProjectPaneId,
  isBrowserPaneId,
  isTerminalPaneId,
  getTerminalSessionFromPaneId,
  getProjectPathFromPaneId,
  getBrowserContextFromPaneId,
  isDraftPaneId,
} from '../../state/pane/adapters';
import { persistBrowserPaneUrl, getBrowserPaneUrl, persistBrowserPaneTitle, getBrowserPaneTitle, setBrowserPaneUserTitle, tryHostname } from '../../state/pane/browserPaneUrl';
import { TERMINAL_AGENT_LABELS, normalizeTerminalAgent } from '../../lib/terminalAgents';
import { useTabNotifications } from '../../hooks/useTabNotifications';
import { useClaudeSkipPermissions } from '../../hooks/useClaudePrefs';
import { ProjectWindowPane } from './ProjectWindow';
import { getProjectName, hashToColor } from './projectColors';
import { usePaneOrdering } from './hooks/usePaneOrdering';
import { useActivePaneState } from './hooks/useActivePaneState';
import { usePaneResidency } from './hooks/usePaneResidency';
import { usePaneAlive } from '../../state/paneLiveness';
import { usePaneLifecycle } from './hooks/usePaneLifecycle';
import { resolveStandaloneCrossGroupDrop } from './standaloneDrop';
import { primaryFromSoloCellKey } from './soloCells';
import { canSplitPane, standaloneSplitSurface } from './splitRules';
import { paneCellBg, paneCellTopInset } from '../../lib/paneCellBg';
import { PaneKeepAlive } from './PaneKeepAlive';
import { DRAG_REGION, NO_DRAG_REGION } from '../../lib/shell/dragRegion';
import { isTauri } from '../../lib/shell';
import { currentWindowLabel } from '../../lib/shell/tauri';
import type { SendMessageOptions } from '@/hooks/useChat';

const RemoteBrowserPanel = lazy(() => import('../Browser/RemoteBrowserPanel').then(m => ({ default: m.RemoteBrowserPanel })));
const SingleTerminalPane = lazy(() => import('../Terminal/SingleTerminalPane').then(m => ({ default: m.SingleTerminalPane })));

const TopicSettingsModal = lazy(() => import('../Modals/TopicSettingsModal').then(m => ({ default: m.TopicSettingsModal })));
const DashboardPane = lazy(() => import('../Dashboard/DashboardPane').then(m => ({ default: m.DashboardPane })));
const KanbanBoardPane = lazy(() => import('../Board/KanbanBoardPane').then(m => ({ default: m.KanbanBoardPane })));
const CronJobsPanel = lazy(() => import('../Sidebar/CronJobsPanel').then(m => ({ default: m.CronJobsPanel })));
const ProfilePane = lazy(() => import('../Profile/ProfilePane').then(m => ({ default: m.ProfilePane })));


interface StandaloneChatGroupProps {
  topicIds: string[];
  focusedPanelId: string | null;
  onFocusPanel: (topicId: string) => void;
  onClosePanel: (topicId: string, onCommit?: () => void) => void;
  /** Optional bypass-the-countdown close, plumbed to PaneTabBar's
   *  right-click "Close now" entry. Falls back to onClosePanel. */
  onClosePanelImmediate?: (topicId: string) => void;
  onDragStart: (topicId: string) => (e: React.DragEvent) => void;
  // Chat props pass-through
  getSessionMessages: (sk: string) => ChatMessage[];
  getCompactionMarkers?: (sk: string) => CompactionMarker[];
  isSessionLoading: (sk: string) => boolean;
  isSessionStreaming: (sk: string) => boolean;
  wasSessionStopped: (sk: string) => boolean;
  sendMessage: (sk: string, content: string, options?: SendMessageOptions) => Promise<boolean>;
  editMessage?: (sk: string, messageId: string, newContent: string) => Promise<boolean>;
  regenerateMessage?: (sk: string, messageId: string) => Promise<boolean>;
  deleteMessage?: (sk: string, messageId: string) => Promise<boolean>;
  switchBranch?: (sk: string, messageId: string, branchIndex: number) => Promise<boolean>;
  loadHistory: (sk: string) => Promise<boolean>;
  chatError: string | null;
  sendWS: (msg: WSMessage) => void;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  onToggleSidebar?: () => void;
  /**
   * IL TELEFONO NON DISEGNA LA STRISCIA DELLE TAB.
   *
   * Sotto i 768px la colonna dei topic è a schermo intero ed è GIÀ l'elenco
   * delle superfici aperte: chat, terminali, browser, board, progetti. Una
   * seconda copia di quell'elenco in cima allo schermo non aggiunge una
   * destinazione, ripete quelle che ci sono già e si porta via 46px di altezza
   * su un'area di lettura alta 844 (chi usa la app, dalla PWA: «da mobile la barra
   * delle tab in alto non serve, c'è già la lista delle tab»).
   *
   * Resta la RIGA, non la striscia: il nome della superficie che hai davanti
   * (senza il quale, con una pane sola a schermo, non sapresti dire quale) e
   * il comando che riapre la lista, che è l'unico della riga a non avere un
   * gemello nella fila in basso — il «+» invece ce l'ha (`MobileChromeBar`),
   * quindi qui sparisce insieme alle tab.
   *
   * Lo decide chi ci sta SOPRA e non `useMobile()`: il predicato che conta è
   * quello con cui `PanelGrid` sceglie il suo render (`innerWidth < 768`), e
   * due predicati diversi per la stessa domanda sono due predicati che prima o
   * poi divergono — su un tablet toccabile a 900px `useMobile().isMobile` dice
   * sì mentre la griglia splitta ancora, e la striscia sparirebbe da una
   * superficie che ha davvero due riquadri affiancati da distinguere.
   */
  mobile?: boolean;
  panelInitialTab?: Record<string, PanelTab>;
  onPanelInitialTabConsumed?: (topicId: string) => void;
  // App-level quick-create. May resolve to the new DRAFT pane id (string) —
  // a split cell uses it to re-target the pane into itself (see the wrapper
  // around PaneTabBar's onNewChat below).
  onNewChat?: () => void | Promise<unknown>;
  stopSession: (sessionKey: string) => Promise<boolean>;
  // Pending pane request for project tabs
  pendingProjectPane?: { projectPath: string; type: import('../../types').PaneType; terminalSessionId?: string; terminalType?: TerminalAgentType } | null;
  onPendingProjectPaneConsumed?: () => void;
  // Create new chat in a project (optional groupId = the tab bar clicked)
  onNewChatInProject?: (projectPath: string, groupId?: string) => void;
  // Pending focus for project tabs (navigate to a topic inside a project)
  pendingProjectFocus?: { projectPath: string; topicId: string; targetGroupId?: string } | null;
  onPendingProjectFocusConsumed?: () => void;
  // Report which topic is active inside the focused project
  onProjectActiveTopicChange?: (projectPath: string, topicId: string | null) => void;
  // Report all open pane IDs inside each project (for sidebar filtering)
  onProjectOpenPanesChange?: (projectPath: string, paneIds: string[]) => void;
  // Create a new terminal (delegates to App). Returns the new pane id so the
  // "+" on a split cell's tab bar can re-target the pane into that cell.
  onCreateTerminal?: (type: TerminalAgentType, skipPermissions?: boolean) => void | Promise<string | null>;
  // Report whether this group has utility panes (browser/terminal)
  onUtilityPaneChange?: (has: boolean) => void;
  // Pending browser pane request (from sidebar) — contextId or null
  pendingBrowserPane?: string | null;
  onPendingBrowserPaneConsumed?: () => void;
  // Report open browser context IDs to parent
  onOpenBrowserContextIds?: (ids: string[]) => void;
  // Draft chat support
  promoteDraft?: (draftId: string, firstMessage: string, options?: SendMessageOptions) => Promise<void>;
  draftMeta?: Record<string, { projectPath?: string }>;
  // Split a pane into its own grid cell (right or down)
  onSplitPane?: (topicId: string, direction: 'right' | 'down') => void;
  // "Reimposta pannelli" — flatten the surrounding grid back to one row of
  // equal cells. Passed through to PaneTabBar's context menu; undefined when
  // the grid is already flat (PanelGrid hides the entry).
  onResetLayout?: () => void;
  // Only the main standalone group should persist panel order (solo groups skip)
  persistOrder?: boolean;
  // Grid item key — used as groupId in PaneTabBar for cross-group DnD detection.
  // "standalone" for the main group, "solo:<topicId>" for split-out groups.
  gridItemKey?: string;
  // Unsolo: merge a solo topic back into the main group
  onUnsolo?: (topicId: string) => void;
  // Accept a solo topic drop (main group only) — unsolos the dropped topic
  onAcceptSoloDrop?: (topicId: string) => void;
  // Merge a dropped tab INTO this split cell (multi-tab column). `targetPrimary`
  // is this cell's primary topic id; `insertIdx` is the tab slot the drop
  // indicators promised (omitted = append). Enables "drop a tab into a
  // populated cell".
  onMergeIntoCell?: (topicId: string, targetPrimary: string, insertIdx?: number) => void;
  // Persist a tab reorder upstream (main pool only — PanelGrid merges the
  // pool's order back into App.openPanels so it survives reload).
  onPersistReorder?: (newPaneIds: string[]) => void;
  // Sidebar "Fissati" pin toggle + state for a tab's subject (chat topicId or
  // `terminal:<sessionId>`). Forwarded to PaneTabBar's context menu so a tab
  // can be pinned/unpinned like its sidebar row. App-level only.
  onToggleFissato?: (pinKey: string) => void;
  isFissato?: (pinKey: string) => boolean;
}

export function StandaloneChatGroup({
  topicIds, focusedPanelId,
  onFocusPanel, onClosePanel, onClosePanelImmediate, onDragStart,
  getSessionMessages, getCompactionMarkers, isSessionLoading, isSessionStreaming, wasSessionStopped,
  sendMessage, editMessage, regenerateMessage, deleteMessage, switchBranch, loadHistory, chatError, sendWS, onWSMessage, onUpdateTopic,
  onToggleSidebar, mobile = false, panelInitialTab, onPanelInitialTabConsumed,
  onNewChat, stopSession,
  pendingProjectPane, onPendingProjectPaneConsumed,
  onNewChatInProject, pendingProjectFocus, onPendingProjectFocusConsumed,
  onProjectActiveTopicChange, onProjectOpenPanesChange,
  onCreateTerminal,
  onUtilityPaneChange,
  pendingBrowserPane, onPendingBrowserPaneConsumed,
  onOpenBrowserContextIds,
  promoteDraft, draftMeta: _draftMeta,
  onSplitPane,
  onResetLayout,
  persistOrder = true,
  gridItemKey = 'standalone',
  onUnsolo, onAcceptSoloDrop, onMergeIntoCell, onPersistReorder,
  onToggleFissato, isFissato,
}: StandaloneChatGroupProps) {
  const [claudeSkipPermissions] = useClaudeSkipPermissions();

  // Topics + terminal sessions from TopicsContext — both used to be
  // drilled here as props.
  const topics = useTopics();
  const terminalSessions = useTerminalSessions();

  // Component-local UI state.
  const [panelDragOver, setPanelDragOver] = useState(false);
  // Browser navigate URL (from WS) — owned here, mutated by ordering hook via callback.
  const [browserNavigateUrl, setBrowserNavigateUrl] = useState<string | null>(null);

  // Hook 1: pane ordering, pinning, preview-replacement, browser singleton,
  // WS browser:navigate, initialTab, pendingBrowserPane, utility/browser
  // reporters, and Path 4 activePaneId derivation.
  const ordering = usePaneOrdering({
    topicIds,
    persistOrder,
    onClosePanel,
    onFocusPanel,
    onWSMessage,
    pendingBrowserPane,
    onPendingBrowserPaneConsumed,
    onUtilityPaneChange,
    onOpenBrowserContextIds,
    panelInitialTab,
    onPanelInitialTabConsumed,
    focusedPanelId,
    onBrowserNavigateUrl: setBrowserNavigateUrl,
  });
  const { validatedOrderedIds, effectivePinnedIds, activePaneId } = ordering.derived;

  // Terminal pane labels derived from server sessions. Fall back to the
  // agent-specific label (Shell / Claude Code / Codex) when the roster carries
  // no name yet — the SAME expression the project window uses (useProjectLayout),
  // so a session with no name reads identically in both tab bars (was a generic
  // "Terminal" here vs the agent label there).
  const terminalLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of terminalSessions) {
      map[`terminal:${s.id}`] = s.name || TERMINAL_AGENT_LABELS[normalizeTerminalAgent(s.type)];
    }
    return map;
  }, [terminalSessions]);

  // Hook 3: pure derivations from validatedOrderedIds + activePaneId + topics.
  const active = useActivePaneState({
    validatedOrderedIds,
    activePaneId,
    topics,
  });
  const {
    // Per-pane type flags are consumed inside `renderPaneBody` directly off
    // pane.id (so hidden panes get the right body too). The active-* flags that
    // the old whole-group early-return checked are gone — a broken active pane
    // now degrades to an error body instead of blanking the group, so those
    // flags are no longer needed here. We keep `activeTopic` (context ring),
    // plus draftTopics + browserContextId for the chat / browser branches.
    activeTopic, browserContextId,
    draftTopics,
  } = active;

  // Build Pane[] for PaneTabBar (mix of chat topics, utility panes, project panes, browser panes, and terminal panes)
  const panes: Pane[] = useMemo(() =>
    validatedOrderedIds.map(id => {
      const isPreview = !effectivePinnedIds.has(id);
      if (isBrowserPaneId(id)) {
        // This map rebuilds panes from ids each render and ignores the stored
        // pane.title, so read the persisted title back explicitly. Resolution
        // order matches the sidebar (buildSidebarItems): live/persisted page
        // title → hostname of the real URL → "Browser".
        const bUrl = getBrowserPaneUrl(id);
        return {
          id,
          type: 'browser' as PaneType,
          title: getBrowserPaneTitle(id) || tryHostname(bUrl) || 'Browser',
          preview: false,
          // Seed the persisted URL from the store so renderPaneBody passes it
          // as initialUrl → the tab reopens to its page after a restart instead
          // of about:blank. (This map reconstructs panes from ids, so without
          // this the url never reaches the render.)
          url: bUrl,
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
          // Without projectPath on the pane, PaneTabBar gates out the
          // project-level tab indicators (streaming spinner + notification
          // rollup badge) — they'd only render on the sidebar, which uses the
          // raw path. Set it so the project TAB matches the row.
          projectPath,
          title: getProjectName(projectPath),
          preview: false, // project panes are always pinned
          color: hashToColor(projectPath),
        };
      }
      if (isUtilityPanelId(id)) {
        const utilType = parseUtilityPanelType(id);
        const paneType = (utilType || 'board') as PaneType;
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
        // One placeholder for an as-yet-unnamed chat everywhere ("New Chat" —
        // the server's own default topic name), so a loading/draft tab never
        // flips between "Chat" and "New Chat" across surfaces.
        title: topics[id]?.name || 'New Chat',
        preview: isPreview,
      };
    }), [validatedOrderedIds, topics, effectivePinnedIds, terminalLabels]);

  // Il nome della superficie davanti — lo legge la riga del telefono (vedi la
  // prop `mobile`). Viene dalla STESSA lista da cui nascono le tab, così il
  // nome in cima e quello nella colonna non possono divergere: sono la stessa
  // stringa passata per due strade.
  const titoloSuperficie = panes.find((p) => p.id === activePaneId)?.title ?? '';

  // Build tab notification badge map from context. Project tabs inherit their
  // children's badges via the central rollup (getProjectBadgeCount); other
  // panes use their own badge.
  const { getBadgeCount, getProjectBadgeCount, clearPane } = useTabNotifications();
  const tabNotifications = useMemo(() => {
    const map = new Map<string, number>();
    // «La stai guardando» = attiva E in un gruppo che ha il fuoco: la stessa
    // espressione che `PaneTabBar` riceve come `groupIsFocused` e con cui decide
    // di sopprimere il badge. Passare la sola `pane.id === activePaneId` faceva
    // scattare la scorciatoia di `getBadgeCount` (solo attenzione Claude, senza
    // unread) anche su una superficie che non hai davanti.
    const gruppoAFuoco = !focusedPanelId || validatedOrderedIds.includes(focusedPanelId);
    for (const pane of panes) {
      const count =
        pane.type === 'project' && pane.projectPath
          ? getProjectBadgeCount(pane.projectPath)
          : getBadgeCount(pane.id, pane.topicId, pane.id === activePaneId && gruppoAFuoco);
      if (count > 0) map.set(pane.id, count);
    }
    return map;
  }, [panes, getBadgeCount, getProjectBadgeCount, activePaneId, validatedOrderedIds, focusedPanelId]);

  // Keep-alive: le pane visitate restano montate attraverso gli switch di tab,
  // così non si perdono scroll, cache di cronologia, buffer del terminale,
  // bozze e tool call espansi. Solo l'attiva è visibile (display:flex; le altre
  // sono display:none e fuori dal layout).
  //
  // Quanto a lungo restano montate lo decide il REGISTRO DI RESIDENZA
  // (`state/pane/residency/`), non più un `Set` locale che cresceva a ogni
  // visita e si svuotava solo alla chiusura della pane. Il tetto è globale al
  // renderer: questa superficie è una delle tante che vi si registrano.
  //
  // Le chiavi sono `stableKey ?? id`, così PANE_ID_REMAP (promozione bozza →
  // topic vero, che cambia l'`id` e conserva lo `stableKey`) non forza un
  // remount del sottoalbero.
  const stableKeyOf = useCallback((p: Pane) => p.stableKey ?? p.id, []);
  // Vedi la nota gemella in `GroupLayout`: una superficie NASCOSTA non ha pane
  // visibili, e dichiararne una come tale la renderebbe pavimento — cioe'
  // esente dal tetto — per sempre.
  const surfaceAlive = usePaneAlive();
  const visibleKeys = useMemo(() => {
    if (!surfaceAlive) return [];
    const p = activePaneId ? panes.find((q) => q.id === activePaneId) : undefined;
    return p ? [stableKeyOf(p)] : [];
  }, [surfaceAlive, panes, activePaneId, stableKeyOf]);
  const isResidentPane = usePaneResidency(panes, visibleKeys);

  // La pane attiva entra comunque, anche se il registro non l'ha ancora
  // ammessa: la registrazione avviene in un effetto, che gira DOPO il render,
  // quindi il primo frame dopo un'attivazione mostrerebbe il vuoto.
  const visitedPanes = useMemo(
    () => panes.filter((p) => isResidentPane(p) || p.id === activePaneId),
    [panes, isResidentPane, activePaneId],
  );

  // Hook 2: action handlers (browser singleton, close, split, settings, etc.)
  // `onMergeIntoCell` lets handleAddPane route a pane created from THIS split
  // cell's "+" into the cell itself instead of the main standalone pool.
  const lifecycle = usePaneLifecycle({
    ordering, active,
    topics, topicIds, gridItemKey,
    onClosePanel, onFocusPanel,
    onSplitPane, onUnsolo,
    onCreateTerminal, onMergeIntoCell, onPersistReorder, claudeSkipPermissions,
    stopSession,
  });
  const { settingsTopicId, setSettingsTopicId } = lifecycle;
  const {
    handleReorderPanes, handlePinPane, handleAddPane, handleClosePane,
    handleStopStreaming, handleSettings, handlePopOut, handlePopOutGroup,
    handleSplitRight, handleSplitDown, handleDetach, handleUnsolo,
    handleCloseOthers,
  } = lifecycle.handlers;

  // Cross-group drop: accept a tab dragged from another group (solo or project).
  // When a tab is dropped onto another group's tab bar:
  // - Unsolo the dragged topic (returns to standalone)
  // - If the TARGET is also solo, unsolo it too (both merge into standalone)
  const handleCrossGroupDrop = useCallback((sourcePaneId: string, sourceGroupId: string, insertIdx: number) => {
    // All the routing/anti-collapse logic lives in the pure, unit-tested
    // resolver (standaloneDrop.ts). The handler just dispatches its decision.
    const decision = resolveStandaloneCrossGroupDrop({
      sourcePaneId,
      sourceGroupId,
      targetGroupId: gridItemKey,
      targetTopicIds: topicIds,
      canAcceptSolo: !!onAcceptSoloDrop,
      canMergeIntoCell: !!onMergeIntoCell,
      insertIdx,
    });
    switch (decision.kind) {
      case 'noop':
        return;
      case 'merge-into-cell':
        // The dragged tab joins THIS split cell at the indicated tab slot —
        // no collapse, and the drop indicator's promise is honored.
        onMergeIntoCell?.(decision.draggedTopicId, decision.targetPrimary, decision.insertIdx);
        return;
      case 'unsolo-dragged':
        // Dropped on the main pool → un-split the dragged tab back into it.
        onAcceptSoloDrop?.(decision.draggedTopicId);
        return;
    }
  }, [onAcceptSoloDrop, onMergeIntoCell, topicIds, gridItemKey]);

  // Handle drops from solo groups (cross-panel-type)
  const handleStandaloneDragOver = useCallback((e: React.DragEvent) => {
    if (!onAcceptSoloDrop && !onMergeIntoCell) return;
    // Accept PANEL_ID drops that also have PANE_TAB (from project tab bars or solo groups)
    if (!e.dataTransfer.types.includes(DND_TYPES.PANEL_ID)) return;
    if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB)) return;
    // Don't accept grid item drags
    if (e.dataTransfer.types.includes(DND_TYPES.GRID_ITEM)) return;
    e.preventDefault();
    // WKWebView (Tauri) needs an explicit dropEffect or the source dragend reads
    // 'none' and the pop-out path closes the dragged pane (this merge drop has
    // its own handler, so PanelGrid's dropConsumedRef guard doesn't cover it).
    e.dataTransfer.dropEffect = 'move';
    setPanelDragOver(true);
  }, [onAcceptSoloDrop, onMergeIntoCell]);

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

    // Dropping onto a split cell's body merges into that cell; onto the main
    // pool un-splits the dropped topic. (Mirrors the tab-bar cross-group drop.)
    if (onMergeIntoCell && gridItemKey.startsWith('solo:')) {
      onMergeIntoCell(topicId, gridItemKey.slice('solo:'.length));
      return;
    }
    if (onAcceptSoloDrop) {
      onAcceptSoloDrop(topicId);
    }
  }, [onAcceptSoloDrop, onMergeIntoCell, topicIds, gridItemKey]);

  // The Context Inspector is a popover owned by the active topic's composer
  // (`ChatInput`), which listens for this event. The header ring just fires it.
  const handleToggleContext = useCallback(() => {
    if (!activeTopic) return;
    window.dispatchEvent(new CustomEvent('chat-input:toggle-context', { detail: { topicId: activeTopic.id } }));
  }, [activeTopic]);

  // Stabile e non un arrow inline sulla board: quella prop scende su OGNI card,
  // e un'identità nuova a ogni render del gruppo (una tab che cambia, un titolo
  // che arriva) manda a vuoto il memo di tutte quante. La board di progetto
  // passa già una callback stabile (`ProjectWindow`), questa no.
  const openTopicFromBoard = useCallback((topicId: string) => {
    window.dispatchEvent(new CustomEvent('topics:open-topic', { detail: { topicId } }));
  }, []);

  if (validatedOrderedIds.length === 0) return null;
  // NOTE: we deliberately do NOT bail the whole group when the ACTIVE pane is
  // unrenderable (e.g. a chat whose topic no longer resolves). That old bail —
  // `if (!activeTopic && !activeIsUtility && …) return null` — took down the
  // ENTIRE window (blank screen, only the sidebar left) the moment a single
  // broken pane happened to be active. A broken pane must degrade to an error
  // BODY under a live tab strip, never abbattere la finestra: the tab bar keeps
  // rendering (you can switch away or close the tab) and `renderPaneBody`
  // returns a "Topic non trovato" fallback for the broken pane below.

  // Single source of truth — `addableScopes: ['standalone']` in PANE_CONFIG.
  // Previously this was a hardcoded ['browser', 'terminal'] with a bespoke
  // browser-singleton check; now `getAddableTypesForScope` does both via
  // `singleton` + `addableScopes` flags and the project tab bar derives
  // its list the same way (see useProjectLayout.availableTypesForGroup).
  const availableTypes: PaneType[] = (() => {
    const present = new Set<PaneType>();
    if (validatedOrderedIds.some(id => isBrowserPaneId(id))) present.add('browser');
    const types = getAddableTypesForScope('standalone', present);
    // In una finestra POP-OUT il Browser non si offre nel menu «+».
    //
    // Il difetto strutturale è risolto: `browser_open` ora riceve l'etichetta
    // della finestra e parenta la webview alla finestra ospite (get_window(&label)),
    // quindi una pane browser in un pop-out compare NEL pop-out e viene distrutta
    // con esso. Questo filtro resta come contenimento intenzionale (il pop-out è
    // un thread singolo: niente split/browser nel suo «+»), non più come workaround
    // per un bug del guscio.
    const detached = isTauri && (currentWindowLabel() ?? 'main') !== 'main';
    return detached ? types.filter((t) => t !== 'browser') : types;
  })();

  // Shared split gating (splitRules.ts) — the ONE predicate this group's
  // menu entries, usePaneLifecycle's handlers and the project surface all
  // agree on, so "Split Right/Down" is offered exactly when it works.
  const groupCanSplit = canSplitPane({
    surface: standaloneSplitSurface(gridItemKey),
    groupSize: validatedOrderedIds.length,
  });

  // Tab bar rendered inline in header
  const tabBar = (
    <PaneTabBar
      className="flex-1 py-1 pr-0 min-w-0 app-drag-region"
      panes={panes}
      activePaneId={activePaneId}
      // Nessun pannello a fuoco = questa superficie e' comunque quella che hai
      // davanti: qui il gruppo e' UNO, e `focusedPanelId` resta null finche' non
      // clicchi. Trattarlo come «non a fuoco» diceva che non stai guardando
      // niente — e da quel giudizio dipende sia il rilievo della tab attiva sia
      // la soppressione del suo badge.
      groupIsFocused={!focusedPanelId || validatedOrderedIds.includes(focusedPanelId)}
      onActivate={(paneId) => {
        clearPane(paneId); // clear non-chat badge on tab activation
        onFocusPanel(paneId);
      }}
      onClose={handleClosePane}
      onCloseImmediate={onClosePanelImmediate}
      onAddPane={handleAddPane}
      availableTypes={availableTypes}
      addMenuScope="standalone"
      groupId={gridItemKey}
      // Every top-level group (the main standalone group and any solo split
      // cells) shares the standalone scope, so tabs reorder/merge freely among
      // them but a project's tabs can't be dropped here (and vice-versa).
      dndScope={STANDALONE_SCOPE}
      // Split-cell "+ New Chat": app-level creation appends the draft to the
      // MAIN standalone pool, so when this group is a solo cell re-target the
      // fresh draft into the cell — same routing as terminals/browsers in
      // usePaneLifecycle.handleAddPane.
      onNewChat={onNewChat ? () => {
        const res = onNewChat();
        const targetPrimary = primaryFromSoloCellKey(gridItemKey);
        if (res instanceof Promise && targetPrimary && onMergeIntoCell) {
          void res.then((created) => {
            if (typeof created === 'string') onMergeIntoCell(created, targetPrimary);
          });
        }
      } : undefined}
      onReorderPanes={handleReorderPanes}
      onCrossGroupDrop={onAcceptSoloDrop ? handleCrossGroupDrop : undefined}
      onContextRingClick={handleToggleContext}
      // Gated by the SHARED canSplitPane rule (splitRules.ts) — the same
      // predicate usePaneLifecycle's isSplittable guards the handlers with,
      // so an offered entry always works: the pool always splits (single-tab
      // auto-spawns a draft companion), a solo cell splits only when it
      // holds MORE than one tab (a member splits out into its own cell,
      // exactly like the drag path's extractToOwnCell).
      onSplitRight={onSplitPane && groupCanSplit ? handleSplitRight : undefined}
      onSplitDown={onSplitPane && groupCanSplit ? handleSplitDown : undefined}
      onResetLayout={onResetLayout}
      // Spazi: every top-level (app-level) group offers "Sposta nello
      // Spazio →" — project-inner tab bars never pass this.
      canMoveToSpace
      onCloseOthers={handleCloseOthers}
      onSettings={handleSettings}
      onPopOut={handlePopOut}
      // "Stacca il gruppo": pop ALL the group's chat topics out into ONE window.
      onPopOutGroup={() => handlePopOutGroup(panes.filter(p => p.type === 'chat' && p.topicId).map(p => p.topicId!))}
      // Tab-level rename parity with terminals: chat tabs go through the
      // canonical topic-update path (optimistic + persisted + broadcast);
      // browser tabs pin pane.title (titleSource='user') so the page-title
      // poll stops overwriting the chosen name.
      onRenameChat={(tid, name) => { void onUpdateTopic(tid, { name }); }}
      onRenameBrowser={(id, name) => setBrowserPaneUserTitle(id, name)}
      // 'Detach' = split OUT into an own cell (pool tabs). A solo cell's tab
      // instead offers 'Riporta nel gruppo' (onReattach → unsolo) — the two
      // used to share one 'Detach' label with opposite semantics.
      onDetach={handleUnsolo ? undefined : (onSplitPane && groupCanSplit ? handleDetach : undefined)}
      onReattach={handleUnsolo}
      onStopStreaming={handleStopStreaming}
      onPinPane={handlePinPane}
      onToggleFissato={onToggleFissato}
      isFissato={isFissato}
      tabNotifications={tabNotifications}
      hasLeftOverlay={!!onToggleSidebar}
    />
  );

  const settingsTopic = settingsTopicId ? topics[settingsTopicId] : null;

  // Renders the BODY of a single pane (no header — the header lives once
  // at the top of the standalone group). All visited panes render their
  // body simultaneously so their React state survives tab switches; only
  // the active body is visible (display:flex), the others are
  // display:none and out of layout. `isPaneActive` lets us thread per-
  // pane focus / browser-navigate-url props without leaking transient
  // signals into hidden siblings.
  const renderPaneBody = (pane: Pane, isPaneActive: boolean): React.ReactNode => {
    const paneId = pane.id;
    if (isTerminalPaneId(paneId)) {
      const sessionId = getTerminalSessionFromPaneId(paneId);
      if (!sessionId) return null;
      return (
        <LazyPane>
          <SingleTerminalPane sessionId={sessionId} isActive={isPaneActive} />
        </LazyPane>
      );
    }
    if (isBrowserPaneId(paneId)) {
      const ctx = getBrowserContextFromPaneId(paneId) || browserContextId;
      return (
        <LazyPane>
          <RemoteBrowserPanel
            contextId={ctx}
            // Restore the tab to its last page after a window restart (the
            // browser analogue of a chat tab restoring its conversation).
            // pane.url round-trips via the pane snapshot; mount-only in the hook.
            initialUrl={pane.url}
            navigateUrl={isPaneActive && browserNavigateUrl ? browserNavigateUrl : undefined}
            onNavigateConsumed={isPaneActive ? () => setBrowserNavigateUrl(null) : undefined}
            // Persist each navigation onto the pane so the next restart restores it.
            onUrlChange={(u) => persistBrowserPaneUrl(paneId, u)}
            // Persist the live page title so the tab labels with it (gated so a
            // manual rename — titleSource='user' — is never overwritten).
            onTitleChange={(t) => persistBrowserPaneTitle(paneId, t)}
            // Drives WebContentsView visibility — `display:none` on the
            // keep-alive wrapper doesn't reach the OS-level overlay, so
            // we tell it explicitly. Without this, the inactive browser's
            // native view would stay at its last-known bounds and bleed
            // through underneath the active pane.
            isVisible={isPaneActive}
            // Wires the back-to-spawner toolbar button — the panel reads
            // browserSpawner registry internally and only surfaces the
            // button when this browser was opened from a known chat.
            onFocusPanel={onFocusPanel}
            topics={topics}
            // A click inside the native pane never reaches React; activate this
            // pane's tab the same way the tab bar's onActivate does (line ~512).
            onSelfFocus={() => onFocusPanel(paneId)}
          />
        </LazyPane>
      );
    }
    if (isProjectPaneId(paneId)) {
      const projectPath = getProjectPathFromPaneId(paneId);
      if (!projectPath) return null;
      return (
        <ProjectWindowPane
          key={projectPath}
          projectPath={projectPath}
          // Same signal the browser pane above gets, for the same reason: the
          // keep-alive wrapper's `display:none` does not reach the panes nested
          // inside this window (nor their OS-level native views), so a window
          // sitting behind another tab has to be TOLD it is off screen.
          isVisible={isPaneActive}
          focusedPanelId={focusedPanelId}
          onFocusPanel={onFocusPanel}
          onClosePanel={onClosePanel}
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
          onUpdateTopic={onUpdateTopic}
          pendingPane={pendingProjectPane && pendingProjectPane.projectPath === projectPath ? pendingProjectPane.type : undefined}
          pendingTerminalSessionId={pendingProjectPane && pendingProjectPane.projectPath === projectPath ? pendingProjectPane.terminalSessionId : undefined}
          pendingTerminalType={pendingProjectPane && pendingProjectPane.projectPath === projectPath ? pendingProjectPane.terminalType : undefined}
          onPendingPaneConsumed={onPendingProjectPaneConsumed}
          onNewChat={onNewChatInProject ? (groupId?: string) => onNewChatInProject(projectPath, groupId) : undefined}
          // Il pin della sidebar scende fin qui: dentro il progetto il menu
          // di una tab può così offrire «Fissa il progetto» e «Fissa questa
          // tab». Senza, `PaneTabBar` nasconde la voce e col dito non resta
          // nessuna strada (su iOS il drag HTML5 non esiste).
          onToggleFissato={onToggleFissato}
          isFissato={isFissato}
          pendingFocusTopicId={pendingProjectFocus && pendingProjectFocus.projectPath === projectPath ? pendingProjectFocus.topicId : null}
          pendingFocusTargetGroupId={pendingProjectFocus && pendingProjectFocus.projectPath === projectPath ? pendingProjectFocus.targetGroupId : undefined}
          onPendingFocusConsumed={onPendingProjectFocusConsumed}
          onActiveTopicChange={onProjectActiveTopicChange ? (topicId) => onProjectActiveTopicChange(projectPath, topicId) : undefined}
          onOpenPanesChange={onProjectOpenPanesChange ? (paneIds) => onProjectOpenPanesChange(projectPath, paneIds) : undefined}
        />
      );
    }
    if (isUtilityPanelId(paneId)) {
      const utilityType = parseUtilityPanelType(paneId);
      return (
        <LazyPane>
          {utilityType === 'dashboard' && <DashboardPane onMessage={onWSMessage} />}
          {utilityType === 'cron' && <CronJobsPanel />}
          {utilityType === 'board' && <KanbanBoardPane global onMessage={onWSMessage} onOpenTopic={openTopicFromBoard} />}
          {utilityType === 'profile' && <ProfilePane />}
        </LazyPane>
      );
    }
    // Chat (real or draft).
    const topic = topics[paneId] || draftTopics[paneId];
    // A chat pane whose topic no longer resolves (deleted/archived topic, a
    // stale id from an external write) degrades to an error body — NOT null,
    // which used to leave a blank cell, and NOT a group-wide bail, which used to
    // blank the whole window. The tab strip above stays live so the user can
    // close this tab or switch away. Mirrors ProjectWindow's chat fallback.
    if (!topic) return <div className="flex-1 flex items-center justify-center text-app-text-muted text-sm">Topic non trovato</div>;
    const isDraft = isDraftPaneId(paneId);
    const isPinned = effectivePinnedIds.has(paneId);
    const wrappedSendMessage = isDraft
      ? async (_sk: string, content: string, options?: SendMessageOptions) => {
          if (promoteDraft) {
            await promoteDraft(paneId, content, options);
          }
          return true;
        }
      : !isPinned
        ? async (sk: string, content: string, options?: SendMessageOptions) => {
            ordering.ops.pin(paneId);
            return sendMessage(sk, content, options);
          }
        : sendMessage;
    return (
      <ChatPanel
        bodyOnly
        topic={topic}
        isFocused={isPaneActive && focusedPanelId === paneId}
        onFocus={() => onFocusPanel(paneId)}
        onClose={() => onClosePanel(paneId)}
        onDragStart={onDragStart(paneId)}
        onToggleSidebar={onToggleSidebar}
        isDragOver={false}
        showCloseButton={false}
        getSessionMessages={getSessionMessages}
        getCompactionMarkers={getCompactionMarkers}
        isSessionLoading={isSessionLoading}
        isSessionStreaming={isSessionStreaming}
        wasSessionStopped={wasSessionStopped}
        stopSession={stopSession}
        sendMessage={wrappedSendMessage}
        editMessage={editMessage}
        regenerateMessage={regenerateMessage}
        deleteMessage={deleteMessage}
        switchBranch={switchBranch}
        loadHistory={loadHistory}
        chatError={chatError}
        sendWS={sendWS}
        onWSMessage={onWSMessage}
        onUpdateTopic={isDraft ? async () => null : onUpdateTopic}
        initialTab={panelInitialTab?.[paneId]}
        onInitialTabConsumed={onPanelInitialTabConsumed ? () => onPanelInitialTabConsumed(paneId) : undefined}
        onFocusPanel={onFocusPanel}
      />
    );
  };

  return (
    <>
      <div
        data-split-card
        className={`relative flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden transition-shadow ${panelDragOver ? 'ring-2 ring-primary/50' : ''}`}
        style={CHROME_BAR_H_VAR}
        onMouseDownCapture={() => {
          if (activePaneId && focusedPanelId !== activePaneId) {
            onFocusPanel(activePaneId);
          }
        }}
        onDragOver={handleStandaloneDragOver}
        onDragLeave={handleStandaloneDragLeave}
        onDrop={handleStandaloneDrop}
      >
        {/* Single shared header — tab bar + (optional) sidebar toggle.
            Previously every pane-type branch rendered its own copy of
            this header; consolidating it lets the body switch underneath
            without re-mounting the tab bar / re-running its hooks. */}
        <div className={`${CHROME_BAR} pr-0 select-none app-drag-region`} {...DRAG_REGION}>
          {mobile ? (
            // Il nome della superficie al posto della striscia. Stesso corpo
            // della tab che c'era qui (`TAB_LABEL`) e stessa riserva a sinistra
            // che la strip usava per non finire sotto il comando: la riga si
            // svuota, non si sposta. Non è un bersaglio — non attiva, non
            // chiude, non si trascina: per cambiare superficie c'è la lista.
            <div
              data-testid="mobile-pane-title"
              className={`flex-1 flex items-center min-w-0 overflow-hidden ${onToggleSidebar ? CHROME_ROW_ACTION_RESERVE_LEFT : 'pl-1.5'}`}
            >
              <span className={`truncate ${TAB_LABEL}`}>{titoloSuperficie}</span>
            </div>
          ) : (
            <div className="flex-1 flex items-center min-w-0 overflow-hidden app-no-drag" {...NO_DRAG_REGION}>{tabBar}</div>
          )}
          {onToggleSidebar && (
            // La coppia del «+» in coda alla riga: stesso box
            // (`ROW_ACTION_BOX`), stesso incasso derivato, stessa scatola
            // rialzata, e `raised-control-overlay` perché anche questo sta
            // SOPRA la strip delle tab, che gli scorre sotto.
            <div className={`raised-control-overlay absolute ${CHROME_ROW_ACTION_INSET_LEFT} top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10`} {...NO_DRAG_REGION}>
              <SidebarToggleButton onClick={onToggleSidebar} size="action" className={`edge-lit ${RAISED_CONTROL} rounded-lg`} />
            </div>
          )}
        </div>

        {/* Keep-alive body area — every visited pane stays mounted; only
            the active one is `display: flex`, the rest are `display: none`
            and removed from layout entirely. Preserves chat scroll,
            history caches, terminal buffers, virtuoso state, and form
            drafts across tab switches.
            `chrome-glass`: under Electron-mac this backdrop goes transparent so
            the native vibrancy reads through; each content pane wrapper below
            picks its tier via paneCellBg — `project`/`terminal` transparent,
            chat + kanban frosted (`pane-frost`), the rest opaque `bg-surface`
            (matching GroupLayout so a standalone shell rides the vibrancy like
            one inside a project). Outside Electron, `bg-surface` is the
            backdrop. */}
        <div className="chrome-glass flex-1 flex flex-col min-h-0 min-w-0 bg-surface overflow-hidden relative">
          {visitedPanes.length === 0 ? (
            <div className="flex-1" aria-hidden="true" />
          ) : (
            visitedPanes.map((pane) => {
              const isPaneActive = pane.id === activePaneId;
              return (
                <PaneKeepAlive
                  // `stableKey` (when set by the pane reducer) survives
                  // PANE_ID_REMAP — same pattern as PaneTabBar's tab DOM
                  // and GroupLayout's keep-alive wrapper.
                  key={stableKeyOf(pane)}
                  paneKey={stableKeyOf(pane)}
                  isVisible={isPaneActive}
                  className={`flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden ${paneCellBg(pane.type)} ${paneCellTopInset(pane.type)}`}
                >
                  {renderPaneBody(pane, isPaneActive)}
                </PaneKeepAlive>
              );
            })
          )}
        </div>
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
