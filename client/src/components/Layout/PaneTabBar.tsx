import { markDraftTouched } from '../../state/draftPane';
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowUpRight, MessageSquare, FolderTree, Globe, Terminal, GitBranch, Activity, BookOpen, Cpu, FileCode, ExternalLink, Edit3, Settings, BarChart3, Kanban, Columns2, Rows2, Cloud, RotateCw, LayoutGrid, Combine, Layers, Plus, Check, ChevronRight, Pin, PinOff, Clock, UserRound, Link2 } from 'lucide-react';
import { usePanePendingStatus } from '../../contexts/PendingActionContext';
import { PendingActionRing } from '../Shared/PendingActionRing';
import { PendingActionProgressOverlay } from '../Shared/PendingActionProgressOverlay';
import { PaneAddMenu } from '../Shared/PaneAddMenu';
import type { Pane, PaneType, PaneGroupType, AttentionTier } from '../../types';
import { getPaneConfig, getTerminalSessionFromPaneId, isTerminalPaneId, isBrowserPaneId, pinKeyForPane, sessionKeyForPaneId, tabTargetForPane, type PaneScope } from '../../state/pane/adapters';
import { isUtilityPanelId } from '../../state/pane/adapters/utilityPanelId';
import { getProjectLabel } from '../../lib/buildSidebarItems';
import { getBrowserPaneUrl, isRealUrl } from '../../state/pane/browserPaneUrl';
import { useCopyTabLink } from '../../hooks/useCopyTabLink';
import { signalsActions, useSignalsStore, projectAttentionTier, attentionFillFor, useSeenDwell } from '../../state/signals';
import { ClaudeIcon } from '../Shared/ClaudeIcon';
import { CodexIcon } from '../Shared/CodexIcon';
import { getFileIconDef } from '../../lib/fileIcons';
import { rememberDraggedPane } from '../../lib/dragPayload';
import { startDragPreview, endDragPreview } from '../../lib/dragPreview';
import { DND_TYPES, paneTabScopeType, dragMatchesScope, STANDALONE_SCOPE } from '../../lib/dndTypes';
import { BoardTabCounts } from './BoardTabCounts';
import { EDGE_DROP_PX } from './constants';
import { useMobile } from '../../hooks/useMobile';
import { useSplitLayoutAvailable } from '../../hooks/useSplitLayoutAvailable';
import { useLongPress } from '../../hooks/useLongPress';
import { TopicStreamingSpinner, ProjectStreamingSpinner, TerminalStreamingSpinner, BrowserStreamingSpinner } from './StreamingIndicator';
import { NotificationBadge } from '../Shared/NotificationBadge';
import { SessionElapsed, ProjectElapsed } from '../Shared/SessionActivity';
import { useTabNotifications } from '../../hooks/useTabNotifications';
import { useT } from '../../hooks/useT';
import { useSpawnedBrowserMap } from '../../state/browserSpawner';
import { TAB_SELECTED_SURFACE, TAB_SELECTED_SURFACE_SOFT, TAB_RESTING_SURFACE, ROW_PX, ROW_GAP, CARD_H, ROW_ACTION_BOX, ROW_ACTION_GLYPH, ROW_CARD, ROW_TRAIL, ROW_ACTIONS, CHROME_ROW_ACTION_INSET, CHROME_ROW_ACTION_RESERVE, CHROME_ROW_ACTION_RESERVE_LEFT, TAB_GAP_CLASS, attentionSurface, ON_FILL_TEXT_SOFT, TAB_LABEL } from '../../lib/selectionStyles';
import { POPOVER_SURFACE, Z_CONTEXT_MENU, POPOVER_MARGIN } from '@/lib/popoverStyles';
import { computeMenuPosition, type AnchorRect } from '@/lib/popoverPosition';
import { ensurePaneUsageFresh, formatPaneUsageLine, subscribePaneUsage, getPaneUsageVersion } from '@/lib/paneUsage';
import { useDismissable } from '@/hooks/useDismissable';
import { usePaneStore } from '../../state/pane/store';
import { resolvePaneSpace, liveSpaceCount } from '../../state/pane/reducers/spaces';
import { DEFAULT_SPACE_ID, SPACES_MAX } from '../../state/pane/types';
import {
  DEFAULT_SPACE_LABEL,
  createSpaceId,
  isDetachedWindow,
  liveSpacesOrdered,
  movePaneToSpace,
  nextSpaceName,
} from './spaceHelpers';
import { useTopics, useTerminalSessions } from '../../contexts/TopicsContext';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { SharedOrgBadge } from '../Shared/SharedOrgBadge';
import { BrowserTabIcon, BrowserTabMenuButton, BrowserTabConsoleCue } from '../Browser/BrowserTabChrome';
import { BrowserTabAddress } from './BrowserTabAddress';
import { getBrowserPaneChrome } from '../../state/browserPaneChrome';
import { browserTabLabel, browserTabSubtitle, NEW_TAB_LABEL } from '../../lib/browserTabLabel';
import { releaseNativeFocus } from '../../lib/shell/tauri';
import { DRAG_REGION, NO_DRAG_REGION } from '../../lib/shell/dragRegion';
import { prefersReducedMotion } from '../../lib/reducedMotion';
import { useToast } from '../Shared/Toast';
import { restartTerminalSession } from '../../lib/terminalReload';
import { renameTerminalSession } from '../../lib/terminalActions';

/** The width of a tab, in px. Fixed on purpose: tabs that resize with their
 *  own content make the tab under the pointer move while you are aiming at it. */
const TAB_W = 150;
/** ...and the width of a BROWSER tab at rest, which carries a page title plus
 *  a favicon and a menu. See the note at the call site for why it is wider. */
const TAB_W_BROWSER = 200;
/** ...and the width of the ACTIVE browser tab, the one that is showing the
 *  address. The extra 100px are the address bar this pane no longer draws. */
const TAB_W_BROWSER_ACTIVE = 300;

// Every pane type closes through the same soft-confirm path: hovering the X
// reveals an empty "mark as done" circle, clicking it starts the 3 s L→R
// progress fill, and a re-click cancels. There used to be a READ_ONLY_PANE_TYPES
// exception (file / session-viewer / process-log) that swapped in a classic X
// with no feedback — but the wired onClose (handleClosePane) defers those
// closes anyway, so the exception just hid the countdown that was already
// running. Closing is reversible via Cmd+Shift+U regardless, so a single
// uniform affordance is both cleaner and less surprising.

/** Max px a native tab "drag" may travel and still count as a click the browser
 *  ate (see dragStartPtRef). Mirrors SplitTree's DRAG_SLOP_PX. */
const TAB_DRAG_SLOP_PX = 4;

const ICONS: Record<string, React.FC<{ size: number; className?: string; style?: React.CSSProperties }>> = {
  MessageSquare, FolderTree, Globe, Terminal, GitBranch, Activity, BookOpen, Cpu, FileCode, BarChart3, Kanban, Clock, UserRound,
};

// Tab status reads as two orthogonal cues, both shared with the sidebar so the
// surfaces can't drift: a StreamingSpinner ("working right now") and a
// NotificationBadge ("needs you" — Claude awaiting/error, unread, finished
// terminal turn, project rollup). There is no separate Claude phase dot.

/**
 * Chi OSPITA questa barra di tab, per il permalink «Copia link».
 *
 * Non è un campo del `Pane` e non deve diventarlo: la whitelist di
 * `reducers/sanitizeSnapshot.ts` cancella a ogni round-trip col server tutto ciò
 * che non conosce (classe di bug già occorsa due volte), e comunque l'ospite è
 * un fatto della SUPERFICIE, non della pane — la stessa pane browser vale
 * `?in=<progetto>` in una finestra di progetto e `?task=<id>` nel drawer di un
 * task. Lo sa solo chi monta la barra, e da lì arriva.
 */
export interface TabLinkContext {
  /** Il progetto la cui finestra ospita queste tab (ProjectWindow). */
  projectPath?: string;
  /** Il task il cui drawer ospita queste tab (useTaskBrowserGroupLayout). */
  taskId?: string;
}

interface PaneTabBarProps {
  panes: Pane[];
  activePaneId: string | null;
  onActivate: (paneId: string) => void;
  /** Default close — typically deferred via the PendingAction countdown. */
  onClose: (paneId: string) => void;
  /** Optional immediate close — invoked by right-click "Close now" so the
   *  user can opt out of the countdown when they're sure. Falls back to
   *  `onClose` when not provided (legacy callers). */
  onCloseImmediate?: (paneId: string) => void;
  onAddPane: (type: PaneType, subType?: string) => void;
  availableTypes: PaneType[];
  groupType?: PaneGroupType;
  groupId?: string;
  onNewChat?: () => void;
  onReorderPanes?: (newPaneIds: string[]) => void;
  onCrossGroupDrop?: (sourcePaneId: string, sourceGroupId: string, insertIdx: number) => void;
  onEdgeSplitDrop?: (sourcePaneId: string, sourceGroupId: string, edge: 'left' | 'right') => void;
  /**
   * Drag scope — the window/project this tab bar belongs to. Tab drags only
   * reorder/move within the same scope: "main" for the top-level standalone
   * (and solo) groups, the projectPath for a project's groups. A drag from a
   * different scope shows no drop indicators here and is ignored on drop, so a
   * main tab can only land in main and a project tab only within that project.
   * Undefined keeps the legacy unrestricted behavior (no scope enforcement).
   */
  dndScope?: string;
  className?: string;
  onContextRingClick?: (paneId: string) => void;
  onCloseOthers?: (paneId: string) => void;
  onDetach?: (paneId: string) => void;
  /**
   * Merge this tab back into its parent group (a solo split cell's tab
   * returning to the main pool). The inverse of `onDetach` — the two used to
   * share a single 'Detach' entry with opposite semantics per group kind.
   */
  onReattach?: (paneId: string) => void;
  onSplitRight?: (paneId: string) => void;
  onSplitDown?: (paneId: string) => void;
  /**
   * "Reimposta pannelli" — flatten the surrounding split layout back to a
   * single row of equal-width columns (cellStacks dissolve into top-level
   * columns; no tab closes, no groups merge — geometry only). Hosts pass
   * `undefined` when the layout is already flat, so the menu entry hides.
   */
  onResetLayout?: () => void;
  /**
   * Offer "Sposta nello Spazio →" in the tab context menu. Passed ONLY by
   * app-level hosts (StandaloneChatGroup) — Spazi group app-level tabs, so
   * project-inner tab bars never see the entry. The move itself is handled
   * in-place via the pane store (movePaneToSpace).
   */
  canMoveToSpace?: boolean;
  /**
   * Rename a chat tab from its context menu (parity with the terminal tab's
   * inline rename). Reuses the host's canonical topic-update path so the change
   * is optimistic + persisted + broadcast, exactly like a sidebar rename.
   */
  onRenameChat?: (topicId: string, name: string) => void;
  /**
   * Rename a browser tab. Pins pane.title with titleSource='user' so the live
   * page-title poll stops overwriting it (see browserPaneUrl.setBrowserPaneUserTitle).
   */
  onRenameBrowser?: (paneId: string, name: string) => void;
  /**
   * Pane ids whose close affordance (the tab X + the context-menu "Close"
   * entries) must be hidden: panes the host owns structurally rather than
   * free-standing tabs — the task drawer's derived Thread / Piano / media
   * surfaces. Default undefined ⇒ every tab is closable (app unchanged).
   */
  nonClosablePaneIds?: Set<string>;
  /**
   * L'ospite di queste tab, per «Copia link» (vedi TabLinkContext). Senza, il
   * link resta quello che la pane sa dire da sola: una chat/terminale/progetto
   * si indirizza comunque, un file — che ha bisogno del progetto — non offre
   * la voce invece di produrre un link non risolvibile.
   */
  linkContext?: TabLinkContext;
  /**
   * «Apri nel progetto»: promuove QUESTA scheda nel workspace del progetto.
   *
   * Vive sul tasto destro e non su un'icona in testata perché è un gesto che si
   * fa a una scheda precisa, e il posto dove si parla a una scheda precisa è il
   * suo menu. La cabla il drawer del task (`useTaskBrowserGroupLayout`); dove
   * non è cablata la voce non esiste, quindi le barre di primo livello e quelle
   * di progetto restano com'erano.
   */
  onOpenPaneInProject?: (paneId: string) => void;
  onSettings?: (paneId: string) => void;
  onPopOut?: (paneId: string) => void;
  /** Pop the WHOLE group (all its tabs) out into ONE window ("stacca il gruppo").
   *  Offered only on a real group (more than one tab). */
  onPopOutGroup?: () => void;
  onStopStreaming?: (paneId: string) => void;
  onPinPane?: (paneId: string) => void;
  /**
   * Sidebar "Fissati" pin toggle for a tab's underlying subject — DISTINCT from
   * `onPinPane` (which promotes a preview tab to a permanent one). `pinKey` is
   * the sidebar-item id: a chat's bare topicId, or `terminal:<sessionId>` for a
   * terminal. Paired with `isFissato` so the entry can render "Fissa" vs
   * "Rimuovi dai Fissati".
   *
   * Lo passano sia gli ospiti di primo livello sia le finestre di progetto:
   * finora le seconde no, ed è il motivo per cui dentro un progetto la voce non
   * c'era proprio.
   */
  onToggleFissato?: (pinKey: string) => void;
  isFissato?: (pinKey: string) => boolean;
  /**
   * La chiave di pin del PROGETTO che contiene questa barra, quando ce n'è uno.
   *
   * È ciò che rende il menu capace di distinguere «fissa il progetto» da «fissa
   * questa tab»: senza, le due cose avevano lo stesso nome e una sola voce.
   * Le barre di primo livello la lasciano indefinita e tornano alla voce unica.
   */
  projectPinKey?: string;
  /** Notification badge counts per pane ID */
  tabNotifications?: Map<string, number>;
  /** Reserve left padding for a floating sidebar toggle overlay */
  hasLeftOverlay?: boolean;
  /** C'è un blocco IN TESTA alla riga, prima della strip — la card del progetto,
   *  che `GroupLayout` monta nel suo `leadingSlot`. La barra non lo disegna e
   *  non lo può misurare: deve solo sapere che c'è, per non sommare il proprio
   *  incasso a quello che quel blocco ha già messo. Vedi il commento sulla
   *  strip. */
  hasLeadingBlock?: boolean;
  /**
   * Whether THIS group currently owns focus. When false, the tab-bar still
   * renders `activePaneId` as the local-active fallback (for content render
   * downstream) but suppresses the visual highlight so the user doesn't see
   * two simultaneously "selected" tabs across split groups. Default: true,
   * so legacy callers that don't pass this prop keep the old behavior.
   */
  groupIsFocused?: boolean;
  /**
   * Whether the panel hosting THIS group is the App-level focused panel.
   * When `groupIsFocused` is true but `groupIsAppFocused` is false the
   * active tab renders in a dimmed-active state (visible enough to identify
   * "this is the tab here" but clearly less prominent than full focus).
   * Defaults to `groupIsFocused`'s value for legacy callers.
   */
  groupIsAppFocused?: boolean;
  /** Which of the two canonical add-menu variants this tab bar's "+" opens.
   *  StandaloneChatGroup passes 'standalone' (adds the Apri/Crea Progetto
   *  actions); project tab bars (GroupLayout) default to 'project'. The
   *  variant's items/order/icons live in <PaneAddMenu> — see its docs. */
  addMenuScope?: PaneScope;
  /**
   * Questa barra sta SOTTO un'altra riga di chrome (le tab di un progetto sotto
   * la tab del progetto). Vedi {@link CHROME_BAR_SUB}: la riga è più bassa e
   * l'aria in cima l'ha già messa la riga sopra.
   */
  subordinate?: boolean;
}

export function PaneTabBar({ panes, activePaneId, onActivate, onClose, onCloseImmediate, onAddPane, availableTypes, groupType: _groupType, groupId, onNewChat, onReorderPanes, onCrossGroupDrop, onEdgeSplitDrop, dndScope, className, onContextRingClick: _onContextRingClick, onCloseOthers, onDetach, onReattach, onSplitRight, onSplitDown, onResetLayout, canMoveToSpace, onRenameChat, onRenameBrowser, onSettings, onPopOut, onPopOutGroup, onStopStreaming, onPinPane, onToggleFissato, isFissato, projectPinKey, tabNotifications, hasLeftOverlay, hasLeadingBlock, groupIsFocused = true, groupIsAppFocused, addMenuScope = 'project', nonClosablePaneIds, linkContext, onOpenPaneInProject, subordinate = false }: PaneTabBarProps) {
  // Le voci del menu passano dal dizionario (`lib/i18n.ts`): sono fra le
  // stringhe più viste dell'app, ed erano gia' in italiano — quindi la
  // conversione non cambia una virgola di cio' che vedi in italiano, e in
  // inglese finalmente dice qualcosa.
  const tr = useT();
  const toast = useToast();
  // Ridisegna quando arriva uno snapshot di consumo nuovo. Senza, il title
  // resterebbe fermo al valore del primo render e la fetch su hover non si
  // vedrebbe mai. `useSyncExternalStore` e non uno stato locale: lo snapshot
  // e' UNO per tutta l'app, e ogni tab bar deve leggere lo stesso.
  useSyncExternalStore(subscribePaneUsage, getPaneUsageVersion, getPaneUsageVersion);
  // Una misura in anticipo, al montaggio della barra. Senza, il PRIMO passaggio
  // del mouse trovava sempre lo store vuoto e leggeva «non ancora misurato»:
  // tecnicamente esatto, praticamente una porta in faccia — la fetch parte in
  // quel momento e il dato arriva quando il mouse se n'è già andato.
  // Non è un polling e non rompe RES-ATTR-04: lo store dedupa, quindi N barre
  // montate insieme fanno UNA richiesta, e poi non se ne fanno più finché
  // qualcuno non passa davvero il mouse.
  useEffect(() => { ensurePaneUsageFresh(); }, []);
  // Default groupIsAppFocused to groupIsFocused so non-project callers
  // (StandaloneChatGroup) keep the existing two-state behavior.
  const isAppFocused = groupIsAppFocused ?? groupIsFocused;
  // Il CONTEGGIO delle tab arriva come prop (`tabNotifications`), perché ogni
  // host lo compone a modo suo; la DESCRIZIONE di un badge di progetto no — è la
  // stessa ovunque e dipende solo dagli store globali, quindi si legge dal
  // contesto invece di aggiungere una seconda mappa a ogni chiamante. Fuori dal
  // provider l'hook restituisce dei no-op, quindi non serve una guardia.
  const { describeProjectBadge } = useTabNotifications();
  // Spawner map (chat topicId | terminal paneId → browser contextId) so each
  // tab can show a quiet "opened a browser" cue. One subscription, read per tab.
  const spawnedBrowserMap = useSpawnedBrowserMap();
  // Resolve per-topic icon + colour for chat tabs so the tab bar reads in the
  // SAME visual language as the sidebar (which already shows the topic's own
  // icon). Without this, every chat tab fell back to a generic MessageSquare
  // while the sidebar row showed the real icon — a jarring inconsistency.
  const topics = useTopics();
  // Authoritative claude-code detection: a terminal pane is a Claude Code
  // session if its persisted `terminalType` says so OR the live terminal
  // roster reports that session id as claude-code. The persisted field can be
  // absent on panes created before it was tracked (or not yet rehydrated),
  // which used to make a "Claude Code" tab fall through to the generic
  // Terminal glyph — i.e. Claude Code shown without its own icon. The sidebar
  // already keys off the roster `type`; the tab bar now matches it.
  const terminalSessions = useTerminalSessions();
  // Awaiting-feedback sets, read once here (not per-pane in the map below, which
  // would break the rules-of-hooks). Each pane derives its blue electric-bg
  // state synchronously from these in the loop.
  const awaitingTopics = useSignalsStore((s) => s.awaitingFeedbackTopics);
  const awaitingTermIds = useSignalsStore((s) => s.claudePhaseAwaitingTermIds);
  // The LOUD 'input' tier subsets (amber, act-now) — the rest of the awaiting
  // sets are the calm 'done' tier (blue). Used to pick the tab fill colour.
  const inputTopics = useSignalsStore((s) => s.awaitingInputTopics);
  const inputTermIds = useSignalsStore((s) => s.claudePhaseAwaitingInputTermIds);
  // I soggetti che l'utente ha DAVVERO guardato. Letto una volta qui e consultato
  // dentro il map: gli hook non possono stare in un ciclo, ed è anche la ragione
  // per cui questa lista legge i Set a monte invece di chiamare un hook per tab.
  const seenSubjects = useSignalsStore((s) => s.seenSubjects);
  // Arma la soglia del "visto" sul soggetto della tab ATTIVA — la sola che possa
  // essere guardata — e solo se il gruppo e l'app hanno il fuoco: è la stessa
  // definizione severa (`isFullyActive`) che questa barra usa per la superficie
  // neutra, quindi le due cose non possono divergere.
  const activePane = panes.find((p) => p.id === activePaneId);
  const activeSubjectId =
    activePane?.type === 'chat'
      ? activePane.topicId ?? undefined
      : activePane?.type === 'terminal'
        ? activePane.terminalSessionId ?? getTerminalSessionFromPaneId(activePane.id) ?? undefined
        : undefined;
  useSeenDwell(activeSubjectId, groupIsFocused && isAppFocused);
  const claudeCodeSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of terminalSessions) {
      if (s.type === 'claude-code' || s.type === 'claude-code-team') ids.add(s.id);
    }
    return ids;
  }, [terminalSessions]);
  // Codex sessions get the same authoritative detection (persisted
  // terminalType OR live roster) so their tabs always show the OpenAI
  // glyph instead of the generic Terminal icon.
  const codexSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of terminalSessions) {
      if (s.type === 'codex') ids.add(s.id);
    }
    return ids;
  }, [terminalSessions]);
  // Add-pane menu (button + portal + items + Electron overlay path) is
  // entirely owned by <PaneAddMenu>. PaneTabBar used to inline the
  // button + click handler + portal + outside-click effect — all of that
  // moved into the shared component so the sidebar's "+" button and this
  // one are byte-identical.
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [draggedPaneId, setDraggedPaneId] = useState<string | null>(null);
  const [edgeSplitZone, setEdgeSplitZone] = useState<'left' | 'right' | null>(null);
  const [crossGroupDragActive, setCrossGroupDragActive] = useState(false);
  // Mirror the hovered insert position into a ref so the drop handler reads the
  // latest value even when `drop` fires in the same frame as the final
  // `dragover` (React state may not have committed yet — the "drop lands
  // nowhere / needs a second try" bug, same fix GroupLayout/PanelGrid use).
  const dragOverIdxRef = useRef<number | null>(null);
  // Native-drag click recovery: a tab is `draggable`, so a plain click with a
  // sub-pixel hand tremor (common on trackpads, worse in WKWebView whose native
  // drag threshold is tiny) can spuriously START a drag — and per the HTML5 DnD
  // spec the browser then never dispatches the `click`, so the tab silently
  // doesn't activate ("sometimes I can't click a tab"). We record where the drag
  // began and whether a real drop consumed it; on dragend, a release within
  // TAB_DRAG_SLOP_PX of the start that dropped nowhere is treated as the click
  // it really was. Same slop philosophy as SplitTree's divider DRAG_SLOP_PX.
  const dragStartPtRef = useRef<{ paneId: string; x: number; y: number } | null>(null);
  const dropConsumedRef = useRef(false);

  const { isTouch } = useMobile();
  // «Un comando compare dove ha effetto»: sotto i 768px non ci sono split, e le
  // tre voci che li governano — Dividi a destra, Dividi in basso, Reimposta
  // pannelli — non facevano niente. Il gate è qui, sul menu, e non sui
  // chiamanti: le callback restano quelle, cambia solo chi le mostra.
  const splitLayoutAvailable = useSplitLayoutAvailable();

  // Context menu state. Si tiene il RETTANGOLO della tab, non un punto: la
  // posizione va ricalcolata ogni volta che il pannello cambia altezza da sé
  // (editor di rinomina aperto, sottomenu «Sposta nel gruppo» espanso), e per
  // farlo serve l'ancora, non l'esito di un conto fatto una volta sola.
  const [ctxMenu, setCtxMenu] = useState<{ paneId: string; anchor: AnchorRect } | null>(null);
  // Dove il pannello è finito DOPO essere stato misurato. `null` = non ancora
  // misurato: il pannello è renderizzato ma invisibile (vedi lo stile in fondo).
  const [ctxPos, setCtxPos] = useState<{ top: number; left: number } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  // "Sposta nello Spazio →" inline submenu (expanded space list inside the
  // context menu). Collapses whenever the menu re-opens on another tab.
  const [spaceSubmenuOpen, setSpaceSubmenuOpen] = useState(false);
  // Inline "Rinomina" editor for terminal tabs, expanded IN PLACE inside the
  // context menu (mirrors the sidebar ContextMenu rename submenu). null = not
  // editing; a string = the draft label. Collapses whenever the menu re-opens.
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  // Collapse both inline sub-editors whenever the context menu re-opens on
  // another tab (or closes). Adjusting state DURING render on the prev-value
  // change is React's idiomatic reset — one render, no effect round-trip — and
  // keeps clear of react-hooks/set-state-in-effect.
  const [ctxMenuForReset, setCtxMenuForReset] = useState(ctxMenu);
  if (ctxMenu !== ctxMenuForReset) {
    setCtxMenuForReset(ctxMenu);
    setSpaceSubmenuOpen(false);
    setRenameDraft(null);
  }
  useEffect(() => {
    if (renameDraft !== null) {
      // Defer focus so the input has mounted; select-all so a re-label is one keystroke.
      const t = window.setTimeout(() => { renameInputRef.current?.focus(); renameInputRef.current?.select(); }, 30);
      return () => window.clearTimeout(t);
    }
  }, [renameDraft]);

  // Persist a terminal-tab rename via PATCH /api/terminal/sessions/:id (marks
  // name_source='user' so the auto-namer leaves it alone) — mirrors the raw
  // fetch the "Ricarica" entry uses. The server re-broadcasts the roster so the
  // tab relabels without a local write.
  const submitRename = useCallback((paneId: string, next: string) => {
    const name = next.replace(/\s+/g, ' ').trim();
    if (name) {
      const pane = panes.find(p => p.id === paneId);
      const sid = getTerminalSessionFromPaneId(paneId);
      if (sid) {
        // Terminal: PATCH the session name (name_source='user') — the server
        // re-broadcasts the roster so the tab relabels without a local write.
        // Which is exactly why a refusal has to be SAID: with no local write,
        // a 404 or a dead network just leaves the old label there, and the
        // editor has already closed on the line below.
        renameTerminalSession(sid, name, toast, tr);
      } else if (pane?.type === 'chat' && pane.topicId) {
        // Chat: route through the host's canonical topic-update path.
        onRenameChat?.(pane.topicId, name);
      } else if (isBrowserPaneId(paneId)) {
        // Browser: pin the tab title (titleSource='user') via the host.
        onRenameBrowser?.(paneId, name);
      }
    }
    setRenameDraft(null);
    setCtxMenu(null);
  }, [panes, onRenameChat, onRenameBrowser, toast, tr]);
  // «Copia link»: costruzione + copia + toast stanno in un posto solo, condiviso
  // con il menu del topic in sidebar e con la palette ⌘K (useCopyTabLink), così
  // le tre superfici non possono dire parole diverse per lo stesso gesto.
  const { copyTabLink, copyUrl } = useCopyTabLink();
  // Registry read is cheap (identity-stable slice); only consulted when the
  // context menu offers the move entry.
  const spacesRegistry = usePaneStore((s) => s.spaces);
  const showMoveToSpace = !!canMoveToSpace && !isDetachedWindow();

  // Auto-scroll the active tab into view when it changes. The FIRST positioning
  // (mount / reload) must be INSTANT — a tab bar that was already scrolled
  // should reappear already scrolled, not animate from 0. Only genuine tab
  // switches after mount animate. useLayoutEffect runs before paint, so the
  // instant case lands with no visible jump from scrollLeft 0.
  // Adjust the strip's OWN scrollLeft directly (never element.scrollIntoView():
  // a freshly-mounted tab can still be 0-width when this fires, so the
  // browser's ancestor-walk escapes past this strip onto a distant unrelated
  // overflow-hidden ancestor — scrolling whole panes out of view elsewhere in
  // the app with no scrollbar to recover it).
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const didInitialScrollRef = useRef(false);
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!activePaneId || !container) return;
    const el = container.querySelector(`[data-pane-id="${CSS.escape(activePaneId)}"]`) as HTMLElement;
    if (el) {
      // `prefers-reduced-motion` vale anche qui, e questa e' l'unica strada per
      // farglielo rispettare: le tre media query in `index.css` spengono le
      // transizioni CSS, ma uno scroll animato in JS non le vede — chi ha
      // chiesto al sistema di ridurre il movimento se lo prendeva lo stesso,
      // ogni volta che cambiava tab.
      //
      // Adesso lo esercita la suite intera: `reducedMotion: "reduce"` sta nel
      // `use` di playwright.config.ts, quindi OGNI spec che cambia tab passa di
      // qui col ramo istantaneo. Restava chiuso da un difetto che sembrava di
      // questa famiglia e non lo era — `reopen-closed-tab` andava in timeout sul
      // click all'angolo della barra — ma la causa era mezzo pixel di inset del
      // comando in testa alla riga, identico nelle due modalita': vedi
      // `tests/e2e/reduced-motion-chrome-controls.spec.ts`, che ora misura
      // posizione e cliccabilita' con e senza movimento ridotto.
      const reduceMovement = prefersReducedMotion();
      const behavior: ScrollBehavior =
        didInitialScrollRef.current && !reduceMovement ? 'smooth' : 'auto';
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      if (elRect.left < containerRect.left) {
        container.scrollBy({ left: elRect.left - containerRect.left, behavior });
      } else if (elRect.right > containerRect.right) {
        container.scrollBy({ left: elRect.right - containerRect.right, behavior });
      }
      didInitialScrollRef.current = true;
    }
  }, [activePaneId]);

  // Close context menu on outside pointer / Escape via the shared dismissal
  // contract (capture-phase pointerdown+touchstart+Escape, focus-restore). The
  // rename editor and the "Sposta nello Spazio" submenu both live inside
  // ctxMenuRef, so one panel ref covers every "inside" target.
  useDismissable({ open: !!ctxMenu, onClose: () => setCtxMenu(null), refs: [ctxMenuRef] });

  // Apre il menu della tab ANCORANDOLO alla tab. Una sola porta per il tasto
  // destro e per il dito: il menu è lo stesso, e non può divergere.
  const openTabMenu = useCallback((paneId: string, tabEl: HTMLElement) => {
    const r = tabEl.getBoundingClientRect();
    setCtxMenu({ paneId, anchor: { top: r.top, right: r.right, bottom: r.bottom, left: r.left } });
  }, []);

  // IL MENU SI MISURA, NON SI INDOVINA.
  //
  // Qui c'era un'altezza stimata a costante (`menuHeight = 296`), e il commento
  // lo ammetteva: «Stima, non misura». Su una tab chat le voci sono una quindicina
  // più i divisori, e sotto i 768px una riga di menu è alta 44px: ~730px reali
  // contro 296 stimati. Con quel numero il conto diceva sempre «ci sta sotto la
  // tab», e su una viewport da iPhone le ultime voci finivano fuori schermo —
  // senza scroll con cui raggiungerle.
  //
  // Adesso il pannello si rende invisibile, si MISURA quello vero e lo si colloca
  // con `computeMenuPosition` (la stessa funzione di <Menu>, che clampa ai bordi e
  // ribalta sopra se sotto non ci sta). La misura da sola però non basterebbe: un
  // pannello più alto della viewport non sta da nessuna parte. Serve il TETTO —
  // `max-height` a viewport meno i margini + `overflow-y-auto`, sullo stile del
  // pannello in fondo al file — ed è quello che rende la misura sempre
  // risolvibile: comunque vadano le voci, il pannello sta nello schermo e il resto
  // si scorre.
  //
  // Perché (a) e non portare il menu su <Menu>/<DropdownPortal>: il pannello non è
  // una lista di bottoni e basta, ci vivono dentro l'editor di rinomina e il
  // sottomenu «Sposta nel gruppo», più l'esclusività popover legata a `ctxMenuRef`
  // (useDismissable, sopra). <Menu> vuole un `anchorRef` stabile — qui l'ancora è
  // una tab diversa a ogni apertura — e su mobile diventa un foglio dal basso che
  // si porta dietro il proprio fuoco e la propria tastiera roving, che
  // litigherebbe con il campo di rinomina.
  //
  // Le dipendenze includono `renameDraft` e `spaceSubmenuOpen` perché sono le due
  // cose che cambiano l'altezza del pannello DOPO l'apertura.
  useLayoutEffect(() => {
    if (!ctxMenu) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset a una costante alla chiusura: converge subito e non può ciclare
      setCtxPos(null);
      return;
    }
    const el = ctxMenuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const next = computeMenuPosition(ctxMenu.anchor, { width: r.width, height: r.height }, { margin: POPOVER_MARGIN });
    // Confronto prima di scrivere: riaprire il menu sulla STESSA tab ricrea
    // l'oggetto `ctxMenu` e rifarebbe partire un render per una posizione
    // identica. E scrivendo sempre, una misura invariata riaccendeva l'effetto
    // in coda a se stesso.
    setCtxPos((prev) =>
      prev && prev.top === next.top && prev.left === next.left ? prev : { top: next.top, left: next.left },
    );
  }, [ctxMenu, renameDraft, spaceSubmenuOpen]);

  // «Tieni premuto» = la primitiva condivisa (hooks/useLongPress). Qui c'era la
  // copia locale del gesto: timer a 500ms, tolleranza ZERO su `onTouchMove` (un
  // pixel di tremolio lo uccideva, quindi con un dito vero spesso non partiva) e
  // nessun `onTouchCancel` (se il sistema si prendeva il tocco il timer restava
  // armato e il menu si apriva dopo, da solo).
  //
  // L'hook è UNO per tutta la barra — gli hook non possono stare dentro
  // `panes.map` — quindi `pressed` da solo marcherebbe TUTTE le tab: la tab
  // premuta si ricorda a parte, e il feedback visivo è l'intersezione dei due.
  const [pressingPaneId, setPressingPaneId] = useState<string | null>(null);
  const tabLongPress = useLongPress(({ element }) => {
    // L'ancora è la tab su cui è partito il gesto: la porta il callback, non
    // serve una closure per riga.
    const paneId = element.dataset.paneId;
    if (paneId) openTabMenu(paneId, element);
  }, { enabled: isTouch });

  const handleContextMenu = useCallback((paneId: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openTabMenu(paneId, e.currentTarget as HTMLElement);
  }, [openTabMenu]);

  // L'ETICHETTA DI UNA TAB, UNA VOLTA SOLA. Il `title` non basta da solo: per
  // le utility è una copia congelata il giorno in cui la pane è nata (comanda
  // `PANE_CONFIG`), e una chat senza nome è «New Chat», non il suo id. La regola
  // la applica anche il render, più sotto: qui serve perché l'anteprima del
  // trascinamento deve dire la STESSA parola che sta scritta sulla tab.
  const etichettaTab = useCallback((pane: Pane | undefined, paneId: string): string => {
    if (!pane) return paneId;
    const config = getPaneConfig(pane.type);
    // A BROWSER TAB WRITES THE PAGE TITLE, whether it is the active one or not.
    // The address is not on the label any more: it is on the hover card and in
    // the dropdown the tab opens under itself (`BrowserTabAddress`), so the tab
    // you are working in says what page it is like every other tab in the bar.
    // The rule (and the why) lives in `lib/browserTabLabel`; here we only hand
    // it the pane's state.
    if (pane.type === 'browser') {
      const raw = browserTabLabel({
        title: pane.title,
        titleSource: pane.titleSource,
        url: pane.url || getBrowserPaneUrl(pane.id),
      });
      // The constant is English by construction (`lib/` has no translator); the
      // tab is read in the app's language, next to a page that says the same
      // words in it ("Nuova scheda").
      return raw === NEW_TAB_LABEL ? tr('browser.newTab.title') : raw;
    }
    return (isUtilityPanelId(pane.id) ? config.label : pane.title)
      || (pane.type === 'chat' ? 'New Chat' : config.label);
  }, [tr]);

  const handleTabDragStart = useCallback((paneId: string) => (e: React.DragEvent) => {
    if (!onReorderPanes) return;
    // Record the gesture origin for the sub-slop click recovery (see the ref
    // decl). Reset the drop-consumed flag for this fresh drag.
    dragStartPtRef.current = { paneId, x: e.clientX, y: e.clientY };
    dropConsumedRef.current = false;
    setDraggedPaneId(paneId);
    e.dataTransfer.setData(DND_TYPES.PANE_TAB, paneId);
    rememberDraggedPane(paneId);
    if (groupId) {
      e.dataTransfer.setData(DND_TYPES.PANE_TAB_GROUP, groupId);
    }
    // Set PANEL_ID for edge-split drops at the PanelGrid level.
    // Chat panes use topicId; all other panes use paneId.
    // Top-level groups: "standalone", solo groups ("solo:xxx"), or no groupId.
    const isTopLevel = !groupId || groupId === 'standalone' || groupId.startsWith('solo:');
    if (isTopLevel) {
      const pane = panes.find(p => p.id === paneId);
      if (pane?.type === 'chat' && pane?.topicId) {
        e.dataTransfer.setData(DND_TYPES.PANEL_ID, pane.topicId!);
      } else if (pane) {
        e.dataTransfer.setData(DND_TYPES.PANEL_ID, pane.id);
      }
    }
    // Tag the drag with this tab bar's scope so only same-scope drop targets
    // (this window / this project) accept it. Encoded as a type (readable in
    // dragover) AND a value (readable on drop) — see lib/dndTypes.
    if (dndScope) {
      e.dataTransfer.setData(paneTabScopeType(dndScope), '1');
      e.dataTransfer.setData(DND_TYPES.PANE_TAB_SCOPE, dndScope);
    }
    e.dataTransfer.effectAllowed = 'move';
    // COSA HO IN MANO. Qui c'era la pillola scritta a mano — un nodo costruito
    // e stilizzato in questo file, la quinta copia della stessa idea — e la
    // segnalazione nasce proprio qui: «fra tabbar splittate è difficile fare il
    // drop perché non c'è nessuna anteprima». Adesso la decide `lib/dragPreview`
    // per tutti, e la scheda RESTA sotto al puntatore invece di sparire al
    // frame dopo la fotografia.
    //
    // Sotto il nome sta il contesto, che è la metà mancante quando i gruppi
    // sono due: il progetto per una tab di progetto, l'indirizzo per una pane
    // browser, il tipo per tutto il resto. Due tab chiamate «index.ts» in due
    // colonne diverse sono indistinguibili senza.
    const dragged = panes.find(p => p.id === paneId);
    const sottotitolo = dragged?.projectPath
      ? getProjectLabel(dragged.projectPath)
      : dragged?.type === 'browser'
        ? (getBrowserPaneUrl(dragged.id) || undefined)
        : dragged
          ? getPaneConfig(dragged.type).label
          : undefined;
    startDragPreview(e, {
      // Stessa regola dell'etichetta disegnata sulla tab: per le utility
      // comanda la config, perché il loro `title` è solo una copia congelata
      // il giorno in cui la pane è nata.
      title: etichettaTab(dragged, paneId),
      subtitle: sottotitolo,
      badges: tabNotifications?.get(paneId) ? [String(tabNotifications.get(paneId))] : [],
    });
  }, [onReorderPanes, groupId, panes, dndScope, tabNotifications, etichettaTab]);

  const handleTabDragOver = useCallback((paneIdx: number) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB)) return;
    // Scope guard: a tab from another window/project must not paint insert
    // indicators here — we'd only reject it on drop. (No preventDefault, so the
    // browser shows "no-drop" and the foreign tab bar stays inert.)
    if (!dragMatchesScope(e.dataTransfer.types, dndScope)) return;
    e.preventDefault();
    e.stopPropagation();
    // WKWebView (Tauri) won't infer dropEffect from preventDefault — without
    // this the source dragend sees 'none' and the standalone pop-out path
    // closes the dragged tab. Signal acceptance for the tab-bar reorder/insert.
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    let idx = xRatio < 0.5 ? paneIdx : paneIdx + 1;
    // Solo split cells clamp CROSS-GROUP inserts to slot ≥ 1: slot 0 is the
    // cell's primary, and landing there would re-key the whole cell mid-drop
    // (moveTopicToCell clamps the same way) — so never paint a slot-0 caret
    // the drop won't honor. Same-group reorders (draggedPaneId set) keep 0.
    if (idx === 0 && !draggedPaneId && groupId?.startsWith('solo:')) idx = 1;
    dragOverIdxRef.current = idx;
    setDragOverIdx(idx);
    // Clear stale edge split zone — cursor is over a tab, not an edge
    setEdgeSplitZone(null);
    // Detect cross-group drag for indicator rendering
    if (!draggedPaneId && e.dataTransfer.types.includes(DND_TYPES.PANE_TAB_GROUP)) {
      setCrossGroupDragActive(true);
    }
  }, [draggedPaneId, dndScope, groupId]);

  // Single reset for every drag-end path (successful drop, cancel, foreign
  // drag, and the window-level `dragend` below). Clears both the state and the
  // ref mirror so no insert indicator or stale index survives the gesture.
  const resetDrag = useCallback(() => {
    dragOverIdxRef.current = null;
    setDraggedPaneId(null);
    setDragOverIdx(null);
    setEdgeSplitZone(null);
    setCrossGroupDragActive(false);
  }, []);

  const handleTabDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const sourcePaneId = e.dataTransfer.getData(DND_TYPES.PANE_TAB);
    // Read the insert position from the ref (state may lag a frame behind the
    // final dragover, which silently dropped the tab nowhere before).
    const overIdx = dragOverIdxRef.current;
    if (!sourcePaneId || overIdx === null) { resetDrag(); return; }

    // Scope guard: reject a tab dragged in from another window/project. Belt to
    // the dragover suspenders — getData is only readable here, on drop.
    const sourceScope = e.dataTransfer.getData(DND_TYPES.PANE_TAB_SCOPE);
    if (dndScope && sourceScope && sourceScope !== dndScope) { resetDrag(); return; }

    const sourceGroupId = e.dataTransfer.getData(DND_TYPES.PANE_TAB_GROUP);
    const isCrossGroup = sourceGroupId && groupId && sourceGroupId !== groupId;

    let didDrop = false;
    if (isCrossGroup && onCrossGroupDrop) {
      // Cross-group drop: move pane from source group to this group at insertIdx
      onCrossGroupDrop(sourcePaneId, sourceGroupId, overIdx);
      didDrop = true;
    } else if (onReorderPanes) {
      // Same-group reorder
      const currentIds = panes.map(p => p.id);
      const sourceIdx = currentIds.indexOf(sourcePaneId);
      if (sourceIdx === -1) { resetDrag(); return; }

      // No-op: tab dropped at its own position or immediately after itself
      if (sourceIdx === overIdx || sourceIdx + 1 === overIdx) { resetDrag(); return; }

      const newIds = currentIds.filter(id => id !== sourcePaneId);
      let insertIdx = overIdx;
      if (sourceIdx < overIdx) insertIdx--;
      newIds.splice(Math.max(0, insertIdx), 0, sourcePaneId);

      onReorderPanes(newIds);
      didDrop = true;
    }

    // After a successful drop, activate the dropped pane so focus matches
    // the visual position. Two guards:
    //   1. Skip when the dropped pane is already active in THIS group — calling
    //      onActivate would re-fire FOCUS_PANE and steal focus away from a
    //      different group that currently owns the cursor (review B1).
    //   2. Cross-group drops always activate, since the pane just moved here.
    if (didDrop && onActivate) {
      const isCrossGroupDrop = !!(isCrossGroup && onCrossGroupDrop);
      if (isCrossGroupDrop || sourcePaneId !== activePaneId) {
        onActivate(sourcePaneId);
      }
    }

    // A real drop landed — the dragend click-recovery must NOT then re-fire as a
    // spurious activation.
    if (didDrop) dropConsumedRef.current = true;

    resetDrag();
  }, [panes, onReorderPanes, onCrossGroupDrop, groupId, onActivate, activePaneId, dndScope, resetDrag]);

  const handleTabDragEnd = useCallback((e: React.DragEvent) => {
    // Sub-slop click recovery: if this "drag" never actually moved (release is
    // within TAB_DRAG_SLOP_PX of where it started) and no drop consumed it, the
    // user meant to CLICK — the native drag just ate the click event. Activate
    // the tab as the click would have. A genuine drag moves far past the slop,
    // so a real reorder / cross-group move / cancel-elsewhere never trips this.
    // (WKWebView occasionally reports 0,0 on dragend; the distance check then
    // simply fails and we no-op — harmless, the stuck-overlay reset covers the
    // other half of the "can't click a tab" report.)
    const start = dragStartPtRef.current;
    dragStartPtRef.current = null;
    const consumed = dropConsumedRef.current;
    dropConsumedRef.current = false;
    resetDrag();
    // Ridondante con le porte di spegnimento del contratto, e voluto: nella
    // WKWebView il `dragend` che quelle ascoltano si perde quando il rilascio
    // cade sopra una vista nativa, e questo è l'unico posto in cui SAPPIAMO che
    // il gesto della tab è finito.
    endDragPreview();
    if (!consumed && start && onActivate && Number.isFinite(e.clientX) && (e.clientX !== 0 || e.clientY !== 0)) {
      const dx = Math.abs(e.clientX - start.x);
      const dy = Math.abs(e.clientY - start.y);
      if (dx <= TAB_DRAG_SLOP_PX && dy <= TAB_DRAG_SLOP_PX) {
        onActivate(start.paneId);
      }
    }
  }, [resetDrag, onActivate]);

  // Belt-and-suspenders cleanup: a TARGET group never receives `onDragEnd`
  // (that only fires on the source element), so a cross-group drag that ended
  // without a clean `dragleave` here (escape-cancel, drop elsewhere, a flaky
  // boundary) used to leave this bar's insert indicators painted. `dragend`
  // bubbles to the window for EVERY drag, so one window listener resets every
  // mounted tab bar — source and target alike.
  // dragend OR drop. A cross-group move unmounts the source tab inside the drop
  // handler, so the browser may never fire `dragend` on it — the source bar's
  // indicators would then stay painted. `drop` bubbles to the window AFTER
  // React's own onDrop has already read dragOverIdxRef and performed the move,
  // so resetting on it too clears the source bar without eating the drop.
  useEffect(() => {
    const onEnd = () => resetDrag();
    window.addEventListener('dragend', onEnd);
    window.addEventListener('drop', onEnd);
    return () => {
      window.removeEventListener('dragend', onEnd);
      window.removeEventListener('drop', onEnd);
    };
  }, [resetDrag]);

  // Keyboard shortcut: Cmd/Ctrl+1-9 is owned globally by `useKeyboardShortcuts`
  // — it walks both top-level panels AND project sub-panes so every tab gets
  // a single global slot. The local handler that used to live here was
  // removed; we keep the badges wired up so users still see ⌘N hints, but
  // the indices now reflect the global tab order, not the per-group order.
  const hasMenuItems = onNewChat || availableTypes.length > 0;

  // La zona di trascinamento si DERIVA dalla classe che finisce nel DOM, non da
  // "il chiamante ha passato una className": la barra standalone ne passa una
  // che contiene `app-drag-region`, e legarsi alla presenza della prop lasciava
  // proprio quella scoperta. Beccato da `tests/e2e/drag-regions.spec.ts`.
  //
  // Il `py-1` c'è solo sopra i 768px, e non è cosmesi: le tab passano a `h-9`
  // (36px) sotto, e la riga di chrome che le ospita è alta 40px FISSI con
  // `overflow-hidden` (GroupLayout, quattro punti). Il conto era 36 + 2 di
  // padding della strip + 8 di `py-1` = 46 dentro 40: `items-center` centra e
  // il clipping mangia 3px sopra e 3px sotto, quindi gli angoli arrotondati
  // della tab attiva spariscono e la pillola tocca i bordi. Senza `py-1` fa 38
  // e ci sta. Alzare invece la riga a `h-12` romperebbe altro: `TAB_BAR_H = 40`
  // (GroupLayout.tsx:30) è l'`edgeOffset` dello strip di drop superiore, che
  // finirebbe 8px fuori posto — e andrebbe rialzato in lockstep anche l'header
  // della sidebar progetto, o l'allineamento fra rail e tab si spezza di nuovo.
  // `md:py-1` SPARISCE nella riga subordinata, e non è cosmesi: là la scatola
  // del contenuto vale 28 (34 meno l'incasso in coda), e una radice da 38 —
  // 28 + 2 di padding della strip + 8 di `py-1` — sborda di 5px per lato. La
  // tab ci starebbe lo stesso (`items-center` la centra a 40..68), ma il suo
  // alone `edge-lit` e l'anello di fuoco dipingono FUORI dalla scatola e li
  // taglierebbe l'`overflow-hidden` della barra. Senza `py-1` la radice è 30 e
  // sborda di uno.
  //
  // Visivamente non toglie niente nemmeno nella riga normale: 38 centrato in 40
  // e 30 centrato in 40 mettono la tab nello stesso posto (misurato: 6..34 in
  // entrambi i casi). Resta dov'era perché la radice porta `app-drag-region`, e
  // una fascia trascinabile più stretta di 4px per lato è un cambiamento vero.
  const barClass = className ?? `flex-initial ${subordinate ? '' : 'md:py-1'} pr-0 min-w-0 app-drag-region`;

  return (
    // `flex-initial` (flex: 0 1 auto), NOT `flex-shrink-0`: as a flex child the
    // root must be allowed to SHRINK below its content width, otherwise the
    // inner `overflow-x-auto` strip never gets a constrained width and the tabs
    // just overflow (and get clipped by the parent's `overflow-hidden`) instead
    // of scrolling. This is the bug where narrowing a split INSIDE a project
    // (GroupLayout, which uses this default className) left the overflowing tabs
    // unreachable — no horizontal scroll. With grow:0 it still sits at content
    // width when there's room, so the trailing add-menu doesn't move; `min-w-0`
    // lets it collapse far enough for the scroll strip to take over. The
    // standalone tab bar already passes its own `flex-1 … min-w-0` and scrolled
    // fine — this brings the project-group default in line.
    <div className={barClass} {...(barClass.includes('app-drag-region') ? DRAG_REGION : {})} data-testid="panel-tab-bar" data-group-id={groupId ?? ''} style={{ position: 'relative' }}>
      {/* Scrollable tab area */}
      <div
        ref={scrollContainerRef}
        // DOVE SI FERMA LA STRIP, ai due capi, con la stessa regola.
        //
        // Con un comando: `ROW_INSET + box + ROW_INSET`
        // (CHROME_ROW_ACTION_RESERVE) — il bottone sta 6 dal bordo e la tab si
        // ferma altri 6 prima di lui. Senza: `pl-1.5`/`pr-1.5`, cioè gli stessi
        // 6 con cui ogni riga della colonna sta lontana dal bordo, così le due
        // liste si allineano ai lati.
        //
        // Ci sono voluti tre giri, e ognuno ha sbagliato un pezzo diverso:
        //  1. `paddingLeft: 30` inline a sinistra contro una riserva derivata a
        //     destra — 30 contro 34 col mouse, 30 contro 38 col dito: due
        //     grammatiche per due capi della stessa barra;
        //  2. specchiate ma ancora `box + incasso VERTICALE`, cioè la strip che
        //     finiva ESATTAMENTE sul bordo del bottone: zero aria fra la tab e
        //     il comando;
        //  3. il comando rimpicciolito a 28 fisso per far tornare il verticale
        //     — «hai fatto i tasti più piccoli ma non dovevi» (Attilio, 09/08).
        // Il verticale non era un problema di box ma di predicato, e sta nella
        // classe della tab qui sotto.
        // …e il quarto giro: DUE SEI IN FILA, che singolarmente sono giusti.
        //
        // «Il + della tabbar progetto è troppo lontano dal trigger sidebar
        // (quando chiuso)» (Attilio, 10/08). Misurato: trigger a 442, «+» a 454
        // — DODICI, dove ogni altra coppia della barra ne ha sei. Non è un
        // numero sbagliato, è una somma: 6 di incasso della strip dal blocco che
        // la precede, PIÙ i 6 che la riserva lascia fra l'ultima tab e il
        // comando. Con delle tab in mezzo i due 6 misurano due cose diverse e il
        // conto è giusto; con la strip VUOTA misurano lo stesso vuoto due volte,
        // e il bottone si stacca dal trigger del doppio.
        //
        // Quindi l'incasso sinistro cade solo in quel caso: c'è un blocco in
        // testa (la card del progetto) e non c'è nessuna tab a separarlo dal
        // comando. È la stessa regola della colonna — «il primo non porta la sua
        // metà perché sopra c'è chi l'ha già messa» — applicata in orizzontale.
        className={`flex items-center ${TAB_GAP_CLASS} min-w-0 min-h-7 overflow-x-auto scrollbar-topbar ${
          hasMenuItems ? CHROME_ROW_ACTION_RESERVE : 'pr-1.5'
        } ${
          hasLeftOverlay
            ? CHROME_ROW_ACTION_RESERVE_LEFT
            : hasLeadingBlock && panes.length === 0
              ? 'pl-0'
              : 'pl-1.5'
        }`}
        style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-x', paddingTop: 1, paddingBottom: 1 }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB)) return;
          // Scope guard: ignore drags from another window/project entirely (no
          // edge-split overlay, no preventDefault → browser shows "no drop").
          if (!dragMatchesScope(e.dataTransfer.types, dndScope)) return;
          e.preventDefault();
          // WKWebView (Tauri) won't infer dropEffect from preventDefault — without
          // it, dragend reads dropEffect==='none' even after a successful drop into
          // the empty bar / edge zone and fires the pop-out-close path (same guard
          // the tab-level handler already applies).
          e.dataTransfer.dropEffect = 'move';
          // Cross-group drag detection (draggedPaneId is only set for same-group drags)
          const isCrossGroupDrag = !draggedPaneId && e.dataTransfer.types.includes(DND_TYPES.PANE_TAB_GROUP);
          if (isCrossGroupDrag) setCrossGroupDragActive(true);
          if (onEdgeSplitDrop && isCrossGroupDrag) {
            // Edge-only split (EDGE_DROP_PX border zones). A former "group
            // holds a project pane → force whole-bar split" branch was dead
            // code: onEdgeSplitDrop only exists on project-INNER groups, and
            // a project wrapper pane can never live inside one (stripped on
            // hydrate, no addableScope, created standalone-only).
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const x = e.clientX - rect.left;
            if (x < EDGE_DROP_PX) {
              setEdgeSplitZone('left');
              setDragOverIdx(null);
              return;
            } else if (x > rect.width - EDGE_DROP_PX) {
              setEdgeSplitZone('right');
              setDragOverIdx(null);
              return;
            }
          }
          // Empty bar area: not over a tab (tabs call stopPropagation) and not
          // in an edge-split zone → treat as "append to the end of this group".
          // Without this, dropping ON the bar (rather than precisely on a tab)
          // showed no indicator and landed nowhere — the reported "dragged onto
          // the tab bar, no indicator" bug. The trailing tab paints the
          // right-edge marker for dragOverIdx === panes.length; mirror into the
          // ref so the drop reads it on the same frame as this dragover.
          setEdgeSplitZone(null);
          dragOverIdxRef.current = panes.length;
          setDragOverIdx(panes.length);
        }}
        onDragLeave={(e) => {
          // Only reset when the pointer truly left the bar. A dragleave fired
          // while crossing from the container into one of its child tabs would
          // otherwise flicker the insert indicator off mid-drag.
          const rt = e.relatedTarget as Node | null;
          if (rt && (e.currentTarget as HTMLElement).contains(rt)) return;
          setEdgeSplitZone(null);
          setCrossGroupDragActive(false);
          setDragOverIdx(null);
          dragOverIdxRef.current = null;
        }}
        onDrop={(e) => {
          if (edgeSplitZone && onEdgeSplitDrop) {
            // Re-verify the zone from the cursor's ACTUAL position at drop time.
            // A fast drag can leave `edgeSplitZone` set from an earlier edge
            // frame even though the release happened at center — which used to
            // SPLIT when the user meant to MOVE the tab into this bar. Only
            // split when the cursor is genuinely in the EDGE_DROP_PX band at
            // release. (The old "project groups always split" carve-out keyed
            // on a project pane in THIS group — impossible for the
            // project-inner groups that have onEdgeSplitDrop, see dragover.)
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const x = e.clientX - rect.left;
            const doSplit = x < EDGE_DROP_PX || x > rect.width - EDGE_DROP_PX;
            if (doSplit) {
              e.preventDefault();
              const sourcePaneId = e.dataTransfer.getData(DND_TYPES.PANE_TAB);
              const sourceGroupId = e.dataTransfer.getData(DND_TYPES.PANE_TAB_GROUP);
              if (sourcePaneId && sourceGroupId) {
                onEdgeSplitDrop(sourcePaneId, sourceGroupId, edgeSplitZone);
                dropConsumedRef.current = true;
              }
              setEdgeSplitZone(null);
              setDraggedPaneId(null);
              setDragOverIdx(null);
              setCrossGroupDragActive(false);
              return;
            }
            // Center release despite a stale edge zone → fall through to a normal
            // move/reorder, appending to the end of this bar.
            setEdgeSplitZone(null);
            dragOverIdxRef.current = panes.length;
          }
          handleTabDrop(e);
        }}
      >
      {panes.map((pane, paneIdx) => {
        const config = getPaneConfig(pane.type);
        const Icon = ICONS[config.icon];
        // Claude Code / Codex = persisted terminalType OR live roster says so
        // (see memos above).
        const termSid = pane.type === 'terminal' ? (pane.terminalSessionId ?? getTerminalSessionFromPaneId(pane.id)) : null;
        const isClaudeCodeTab = pane.type === 'terminal' && (pane.terminalType === 'claude-code' || (!!termSid && claudeCodeSessionIds.has(termSid)));
        const isCodexTab = pane.type === 'terminal' && !isClaudeCodeTab && (pane.terminalType === 'codex' || (!!termSid && codexSessionIds.has(termSid)));
        // Selection reads in the SAME visual language as the sidebar (shared
        // SELECTED_SURFACE): the focused tab is a clearly raised NEUTRAL card,
        // every other split group still shows ITS active tab one step softer,
        // and inactive tabs stay quiet. No blue/colour wash anywhere.
        const isSelected = activePaneId === pane.id;
        const isFullyActive = isSelected && groupIsFocused && isAppFocused;
        const isActiveDimmed = isSelected && !(groupIsFocused && isAppFocused);
        // "Awaiting" background split by TIER: amber 'input' (a permission gate,
        // act now) vs blue 'done' (turn finished, look when ready) — a chat /
        // Claude-Code terminal parked for the user, or a project rolling up such
        // a child. Codex/shell never qualify (no Claude phase).
        //
        // Per una CHAT o un TERMINALE questo tier è GREZZO, e deve restarlo: è lo
        // stato di quella sessione, che attende una risposta anche dopo che l'hai
        // guardata (il fill lo spegne il "visto", più sotto; l'etichetta no).
        //
        // Per un PROGETTO no. Lì il tier non è uno stato ma un AGGREGATO — "qui
        // dentro c'è qualcosa che ti aspetta" — e una cosa che hai già letto non
        // ti aspetta più. Quindi il rollup sconta il "visto" dei figli
        // (`projectAttentionTier`), e da qui passa sia al fondo sia alle parole:
        // letta la chat dentro al progetto, la tab smette di dirlo.
        const rawTier: AttentionTier | null =
          pane.type === 'chat'
            ? (pane.topicId ? (inputTopics.has(pane.topicId) ? 'input' : awaitingTopics.has(pane.topicId) ? 'done' : null) : null)
            : pane.type === 'terminal'
              ? (isClaudeCodeTab && termSid ? (inputTermIds.has(termSid) ? 'input' : awaitingTermIds.has(termSid) ? 'done' : null) : null)
              : pane.type === 'project'
                ? (pane.projectPath ? projectAttentionTier(pane.projectPath, topics, terminalSessions, awaitingTopics, awaitingTermIds, inputTopics, inputTermIds, seenSubjects) : null)
                : null;
        // Il fill cade quando la tab è stata VISTA, non appena diventa attiva.
        // Prima il gate era `!isFullyActive`: selezionare una tab per un istante —
        // di passaggio, cercandone un'altra — ne spegneva il fill anche se non
        // avevi letto niente. Ora la decisione è una sola, in `attentionFillFor`,
        // e "visto" pretende SEEN_DWELL_MS davanti con la finestra sveglia (la
        // soglia è armata da `useSeenDwell` sul soggetto della tab attiva).
        //
        // Una pane 'project' non ha un soggetto proprio, e tiene qui la regola
        // vecchia — attiva = vista — come valvola: fra i suoi figli ce ne sono di
        // NON raggiungibili (una sessione claude-code nel roster, senza riga né
        // tab, che nessuna soglia può mai marcare vista), e senza valvola la tab
        // pulserebbe per sempre in faccia a chi la sta guardando. Ma è una valvola
        // TRANSITORIA: da sola era anche l'unica cosa che spegneva il progetto, ed
        // è il bug — leggevi la chat dentro al progetto, passavi a un'altra tab e
        // il progetto tornava blu per una cosa appena letta, perché la fase Claude
        // resta `awaiting-user` fino al turno dopo. Il pezzo durevole ora sta nel
        // rollup (`rawTier` qui sopra salta i figli già visti): letto il figlio, la
        // tab del progetto resta spenta anche quando non è più selezionata.
        const seenKey = pane.type === 'chat' ? pane.topicId : pane.type === 'terminal' ? termSid : null;
        const isSeenTab = seenKey ? seenSubjects.has(seenKey) : isFullyActive;
        const attentionTier = attentionFillFor(rawTier, isSeenTab);
        const onFill = attentionTier !== null;
        // Le utility (`__board__`, `__dashboard__`, `__cron__`) non si
        // rinominano: il loro `title` è solo una COPIA dell'etichetta congelata
        // il giorno in cui la pane è nata. Farla vincere significa che
        // ribattezzare la board lascia «Board generale» sulla tab di chi ce
        // l'ha già aperta, per sempre. Per loro comanda la config.
        // La regola sta in `etichettaTab`, in cima: la parola scritta sulla tab
        // e quella dell'anteprima di trascinamento devono essere la stessa.
        // ...and for a browser pane the STATE does not enter into it: the
        // active tab writes the page title exactly like the resting ones. The
        // label used to swap to the address when the tab was selected, which
        // made it change under you every time focus moved and left the tab you
        // were working in as the only one not naming its page. The address has
        // two surfaces of its own now: the hover card just below, and the
        // dropdown the tab opens under itself.
        const label = etichettaTab(pane, pane.id);
        // THE HOVER CARD SAYS BOTH THINGS, ALWAYS, in the shape every browser
        // uses: the page name on the first line, the WHOLE address on the
        // second. That second line is what tells three tabs called
        // "Vite + React" apart, and it costs the label nothing. And it is not
        // the system tooltip: `TooltipDelegate` intercepts `title` and redraws
        // it after 350 ms instead of the well over a second macOS takes.
        const browserHover = pane.type === 'browser'
          ? (() => {
            const input = {
              title: pane.title,
              titleSource: pane.titleSource,
              url: pane.url || getBrowserPaneUrl(pane.id),
            };
            const raw = browserTabLabel(input);
            const name = raw === NEW_TAB_LABEL ? tr('browser.newTab.title') : raw;
            const address = browserTabSubtitle(input);
            return address ? `${name}\n${address}` : name;
          })()
          : null;
        // Lo stato A PAROLE, per chi non vede il colore.
        //
        // Una tab non diceva il proprio stato da nessuna parte: né `title` né
        // `aria-label`. Chi usa uno screen reader lo trovava solo nei title dei
        // figli (lo spinner, la riga SessionActivity in sidebar), che sono metà in
        // italiano e metà in inglese. Il fondo ambra/blu era l'unico veicolo, ed è
        // un veicolo che non parla.
        //
        // USA `rawTier`, NON `attentionTier`: il fill si spegne quando hai
        // guardato la tab, ma lo STATO no — una sessione che attende una tua
        // risposta la attende ancora anche dopo che l'hai guardata. Il colore
        // risponde a "devo attirare l'attenzione?", questa etichetta a "com'è".
        // (Per un progetto le due domande coincidono: il suo tier è l'aggregato
        // di ciò che resta da guardare — vedi la nota su `rawTier`.)
        const stateTab = rawTier === 'input'
          ? 'attende una tua risposta'
          : rawTier === 'done'
            ? 'turno finito'
            : null;
        // Per un PROGETTO lo stato non basta: il tier è un aggregato e il numero
        // pure, quindi «turno finito» non dice di CHI. Il nome accessibile porta
        // i figli per nome, come il tooltip del badge.
        const detailProject = pane.type === 'project' && pane.projectPath
          ? describeProjectBadge(pane.projectPath)
          : '';
        const isDragged = draggedPaneId === pane.id;
        const hasDragSource = draggedPaneId || crossGroupDragActive;
        const isNotSelf = !draggedPaneId || draggedPaneId !== pane.id;
        const showLeftIndicator = dragOverIdx === paneIdx && hasDragSource && isNotSelf;
        const showRightIndicator = paneIdx === panes.length - 1 && dragOverIdx === panes.length && hasDragSource && isNotSelf;
        // Streaming spinner: chat panes pulse during an LLM stream;
        // Loading affordance is owned by the canonical widgets below —
        // each reads from StreamingContext, no upstream prop needed.
        // Suppress the badge for the tab you're looking at — EXCEPT a project
        // tab. A project badge is a ROLLUP of its children (chats / terminals in
        // inner groups you may not be viewing), so selecting the project tab
        // doesn't mean you've seen them. Zeroing it here also made the project
        // tab disagree with the sidebar project row (which never suppresses the
        // rollup): same project, two different numbers. Keep the rollup visible
        // on the selected project tab so the two surfaces always match.
        // `isFullyActive`, non `isSelected`: la soppressione deve valere per «la
        // stai guardando», e `isSelected` dice solo «e' l'attiva DEL SUO GRUPPO».
        // In split view ogni gruppo ha la sua attiva, quindi il badge spariva
        // anche dai gruppi che non hai davanti — mentre la riga di sidebar dello
        // stesso soggetto continuava a mostrarlo: due superfici in disaccordo,
        // che e' proprio l'invariante che questi helper esistono per difendere.
        // Stessa cosa quando l'app perde il fuoco: tornavi e la tab che avevi
        // lasciato era muta.
        const suppressOnSelect = isFullyActive && pane.type !== 'project';
        const badgeCount = !suppressOnSelect && tabNotifications ? (tabNotifications.get(pane.id) || 0) : 0;
        // A BROWSER TAB IS WIDER, and it is paying for the row it removed.
        //
        // 150px fits a topic name; it does not fit `localhost:5173/board/task`,
        // and an address truncated to the host is an address that stopped
        // telling two tabs apart. The pane used to spend a whole 40px chrome
        // row on saying it, for every browser pane on screen. Trading 40px of
        // HEIGHT for 50px of WIDTH on one tab is a win the moment more than one
        // browser pane is open, and it costs the other tabs nothing: they keep
        // their 150.
        //
        // AND THE ACTIVE ONE EXPANDS, to 300. The chrome of a browser pane has
        // to live somewhere, and the two candidates were "everything inside the
        // tab's dropdown" and "the tab itself grows when you are in it". The
        // second one wins for the thing you touch most: the ADDRESS, which at
        // 200px was truncated exactly where a path stops being recognisable,
        // and which is edited in place right there (click the label). The extra
        // width also leaves room for what will be added next, without stealing
        // a pixel from the tabs you are not in.
        //
        // The fixed-width rule above ("tabs that resize with their content make
        // the tab under the pointer move while you are aiming at it") is not
        // broken by this: nothing here resizes with the CONTENT: the width
        // changes only when you ACTIVATE the tab, which is a click you meant,
        // and it is animated, so what moves is visibly a consequence of it.
        const tabWidth = pane.type === 'browser'
          ? (isSelected ? TAB_W_BROWSER_ACTIVE : TAB_W_BROWSER)
          : TAB_W;

        return (
          <div
            // Use stableKey so the tab DOM survives PANE_ID_REMAP (draft → real
            // topic). Otherwise React unmounts/remounts on first message
            // submission and the tab visibly flashes.
            key={pane.stableKey ?? pane.id}
            data-pane-id={pane.id}
            data-active={isSelected ? 'true' : 'false'}
            role="tab"
            // Lo stato come ATTRIBUTO, non come classe: i locator dei test erano
            // agganciati alle classi Tailwind del badge, e rinominarne una li
            // faceva passare a verde-vuoto senza che nulla fosse rotto. Un
            // data-attribute è il vero appiglio.
            data-attention={rawTier ?? undefined}
            // Il nome accessibile porta lo stato, che prima non era detto da
            // nessuna parte (il colore non parla). `aria-label` e non `title`: un
            // title qui aprirebbe un tooltip sopra una tab il cui nome è già
            // scritto accanto, e duplicherebbe i title dei figli (spinner,
            // SessionActivity) che dicono la loro parte.
            aria-label={[label, stateTab, detailProject].filter(Boolean).join(' · ')}
            style={{ width: tabWidth, minWidth: tabWidth, maxWidth: tabWidth, flexShrink: 0 }}
            // overflow-hidden clips a tab whose trailing widgets (project git
            // status + spinner + notification badge + close) would otherwise
            // sum past the fixed 150px and spill into the next tab. The label
            // already truncates; this guarantees the rest can't escape either.
            // L'attenzione PRECEDE la selezione, come nella sidebar: `attentionTier`
            // è già passato per `attentionFillFor`, quindi se arriva qui vuol dire
            // che l'utente non ha ancora guardato questa tab — e va dipinto anche
            // se la tab è attiva. Era l'inverso, ed è per questo che selezionarla
            // per un istante bastava a spegnerla.
            // `edge-lit` — il bordo riflesso della famiglia card (index.css):
            // due capelli, uno chiaro in cima e uno scuro in fondo, che fanno
            // leggere la tab come una superficie rialzata anche quando NON è
            // selezionata. È lo stesso trattamento del «+», del cerca e delle
            // tessere fissate: un elemento arrotondato che flotta lo porta.
            // L'ALTEZZA È UNA DOMANDA DI LARGHEZZA, non di dito: `h-9 md:h-7`.
            //
            // Era `isTouch ? 'h-9' : 'h-7'`, cioè un predicato JS, mentre il
            // comando in coda alla stessa riga (`ROW_ACTION_BOX`) usa il
            // breakpoint CSS `md:`. Due meccanismi per la stessa domanda
            // divergono appena i due non coincidono: in una finestra stretta
            // senza touch la tab veniva 28 e il «+» accanto 36 — nella stessa
            // riga da 40, 6 di aria contro 2. `useMobile` lo dice già: le
            // affordance del dito seguono `isTouch`, quante-colonne-e-quanto-
            // alto seguono la larghezza.
            className={`group ${ROW_CARD} edge-lit flex items-center ${ROW_GAP} ${ROW_PX} ${CARD_H} ${TAB_LABEL} transition-all relative cursor-pointer select-none rounded-lg overflow-hidden app-no-drag ${
              attentionTier
                ? attentionSurface(attentionTier)
                : isFullyActive
                  ? TAB_SELECTED_SURFACE
                  : isActiveDimmed
                    ? TAB_SELECTED_SURFACE_SOFT
                    // NESSUN colore qui: il testo lo porta `TAB_LABEL` ed è
                    // pieno per tutte. A dire quale tab è quella corrente ci
                    // pensa la superficie — spegnere anche il testo lo diceva
                    // due volte, e la seconda male.
                    : TAB_RESTING_SURFACE
            } ${isDragged ? 'opacity-40' : ''}`}
            // Fuori dal trascinamento della finestra, SINCRONAMENTE al montaggio.
            // Questa riga era già scritta a mano proprio qui, e il commento che
            // portava spiegava perché: la classe `.app-no-drag` diventava un
            // opt-out solo quando il MutationObserver debounced (250 ms) la
            // specchiava sull'attributo, e in quei 250 ms una tab appena montata
            // stava dentro un antenato `deep` — il mousedown trascinava la
            // FINESTRA, non la tab, che "sembrava congelata". Adesso vale per
            // ogni zona, non solo per questa, perché l'observer non c'è più.
            {...NO_DRAG_REGION}
            // Tauri: a native browser pane (sibling WKWebView) can hold AppKit
            // first-responder; yank it back to the chrome on pointer-down so the
            // tab switch isn't swallowed by the pane. No-op off Tauri / fire-and-forget.
            onPointerDown={() => releaseNativeFocus()}
            onClick={() => { if (tabLongPress.consumeClick()) return; if (pane.type === 'terminal') { const sid = pane.terminalSessionId ?? getTerminalSessionFromPaneId(pane.id); if (sid) signalsActions.clearTerminalFinished(sid); } onActivate(pane.id); }}
            // Il doppio clic è il gesto con cui si dice «questa la tengo»: vale
            // anche per una chat nuova, che da quel momento non si richiude più
            // da sola (`state/draftPane.ts`). Vale ANCHE quando non c'è niente
            // da fissare: il gesto conta di per sé.
            onDoubleClick={() => { markDraftTouched(pane.id); if (pane.preview && onPinPane) onPinPane(pane.id); }}
            onContextMenu={handleContextMenu(pane.id)}
            data-testid={`pane-tab-${pane.id}`}
            // Il feedback della pressione vale SOLO per la tab premuta: l'hook è
            // uno per tutta la barra (vedi `pressingPaneId`).
            data-pressing={(tabLongPress.pressed && pressingPaneId === pane.id) || undefined}
            {...tabLongPress.handlers}
            onTouchStart={(e) => { setPressingPaneId(pane.id); tabLongPress.handlers.onTouchStart(e); }}
            // …e a fine gesto si azzera. `pressingPaneId` restava all'ultima tab
            // premuta per sempre: innocuo finché l'AND con `tabLongPress.pressed`
            // regge il feedback, ma è uno stato che sopravvive al gesto che lo ha
            // creato — cioè la premessa del prossimo «si accende la tab
            // sbagliata». Si spegne dove si spegne il gesto, in tutti e due i
            // modi in cui può finire (dito sollevato o tocco preso dal sistema).
            onTouchEnd={(e) => { tabLongPress.handlers.onTouchEnd(e); setPressingPaneId(null); }}
            onTouchCancel={(e) => { tabLongPress.handlers.onTouchCancel(e); setPressingPaneId(null); }}
            // Su touch il drag nativo HTML5 resta spento: il suo lift contende lo
            // stesso gesto del «tieni premuto».
            draggable={!isTouch && !!onReorderPanes}
            onDragStart={handleTabDragStart(pane.id)}
            onDragOver={handleTabDragOver(paneIdx)}
            onDragEnd={handleTabDragEnd}
            // DOVE CADRÀ: la tab lo dice da sé, con l'attributo del contratto
            // (`lib/dragPreview`, DROP_ACTIVE_ATTR) invece di montarsi dentro
            // una lama disegnata a parte. Il disegno sta in `index.css` in una
            // regola sola, quindi la barra e ogni altra superficie che accetta
            // un inserimento posizionale mostrano ORA la stessa cosa. Si spegne
            // con `resetDrag`, che è già agganciato a ogni via d'uscita del
            // gesto — drop, dragend, e il `dragend` di finestra per il bersaglio
            // che un `dragend` proprio non lo riceve mai.
            data-drop-active={showLeftIndicator ? 'before' : showRightIndicator ? 'after' : undefined}
          >
            {/* No selection colour wash: the tab colour is an auto-assigned
                topic default ("invented"), not a manifest-provided colour, so a
                selected tab just uses the normal selected styling. When a real
                project manifest (icon + colour) is wired, drive the wash from
                that instead. */}
            {/* PendingAction progress fill — covers the tab background L→R
                during the 3 s soft-close countdown. Sub-component subscribes
                to the context per-pane so an unrelated pane's state changes
                don't re-render every other tab. It self-guards on a null
                pending status, so it's safe to mount for every pane type. */}
            <PaneTabPendingOverlay paneId={pane.id} />
            {/* "Awaiting feedback" is now the tab's own electric-blue background
                (see isAwaiting + AWAITING_SURFACE above), not an overlay. */}
            {/* Icon slot. Every branch that ALWAYS resolves to a glyph wraps it
                in a fixed 14×14 box so labels line up across tabs. The project
                branch deliberately does NOT: a project without a shipped
                favicon renders nothing (fallback=null) and must reserve NO
                empty box — otherwise every generic project tab showed a blank
                gap where an icon would be. Claude Code uses the authoritative
                `isClaudeCodeTab` so its tab never falls through to the generic
                Terminal glyph. */}
            {pane.type === 'file' && pane.title ? (
              <span className="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">{(() => { const d = getFileIconDef(pane.title); const I = d.icon; return <I size={14} style={{ color: d.color }} />; })()}</span>
            ) : pane.type === 'browser' ? (
              // The SITE's icon, the same one the address bar shows, from the
              // same component: a browser tab that shows a generic globe is a
              // browser tab you have to read to recognise. Under the pointer
              // the same slot becomes Reload (see BrowserTabIcon).
              <BrowserTabIcon paneId={pane.id} url={pane.url || getBrowserPaneUrl(pane.id) || ''} />
            ) : isClaudeCodeTab ? (
              <span className="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">
                <ClaudeIcon size={14} className="text-[#D97757]" />
              </span>
            ) : isCodexTab ? (
              <span className="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">
                {/* Mono ink on purpose — OpenAI's brand is monochrome. */}
                <CodexIcon size={14} />
              </span>
            ) : pane.type === 'chat' ? (
              // Topic chats carry NO leading glyph — name only. Only the actual
              // agent sessions (Claude Code / Codex TERMINAL tabs, handled above
              // via isClaudeCodeTab / isCodexTab) get a brand mark. Explicit
              // null so a chat never falls through to the generic MessageSquare
              // fallback below (same "no fake glyph" rule as an icon-less project).
              null
            ) : pane.type === 'project' && pane.projectPath ? (
              // Same real project favicon the sidebar shows (GET /api/projects/icon);
              // projects WITHOUT a shipped favicon/manifest icon render nothing and
              // reserve no space — zero footprint, no fake glyph, no monogram.
              <ProjectFavicon path={pane.projectPath} size={14} className="flex-shrink-0" />
            ) : Icon ? (
              <span className="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">
                <Icon size={14} />
              </span>
            ) : null}
            {/* Il consumo va QUI e non sulla tab: il contenitore usa apposta
                `aria-label` e non `title` (vedi sopra), perché un title là
                duplicherebbe il nome già scritto accanto e i title dei figli.
                Questo span invece il title non ce l'aveva e il nome lo tronca,
                quindi il tooltip serve già di suo — il consumo ci si appende
                senza rubare il posto a nessuno. `onMouseEnter` aggiorna il dato
                al momento giusto: un numero che nessuno guarda non vale una
                richiesta ogni N secondi (e la fetch è condivisa fra tutte le
                tab bar, vedi `paneUsage.ts`). */}
            <span
              // Ancora stabile per chi conta le tab da fuori. `.truncate.flex-1`
              // non lo è: sono due utility di layout che oggi porta anche una
              // riga dell'albero dei file e una riga di git — entrambe dentro
              // `[role="main"]` — quindi un locator agganciato lì conta come
              // «tab» cose che tab non sono. Il repo lo dichiara già altrove:
              // «i locator dei test erano agganciati alle classi Tailwind, e
              // rinominarne una li faceva passare a verde-vuoto senza che nulla
              // fosse rotto. Un data-attribute è il vero appiglio».
              data-testid="pane-tab-label"
              className={`truncate flex-1 min-w-0 ${pane.preview ? 'italic' : ''} ${
                pane.type === 'browser' && isFullyActive ? 'cursor-text' : ''
              }`}
              // CLICK THE LABEL AND THE ADDRESS DROPS DOWN (BrowserTabAddress).
              // Only on the tab you are already looking at: the first click on
              // another tab still means "bring me there". The label itself is
              // never replaced - the panel opens under the tab.
              onClick={pane.type === 'browser' && isFullyActive
                ? (e) => {
                  const edit = getBrowserPaneChrome(pane.id)?.commands.editAddress;
                  if (!edit) return;
                  e.stopPropagation();
                  edit();
                }
                : undefined}
              onMouseEnter={ensurePaneUsageFresh}
              // A browser tab carries its hover card (name + address, see
              // `browserHover`); every other tab carries its name alone.
              title={`${browserHover ?? label}${formatPaneUsageLine(
                pane.type === 'terminal' ? termSid : null,
                pane.type === 'terminal' || pane.type === 'browser',
                // Le due sorgenti sono diverse: un terminale si cerca per
                // sessione (il server tiene il pid di testa del suo albero PTY),
                // una pane browser per label di webview (la shell sa quale
                // WebContent la rende). Vedi `paneUsage.ts`.
                pane.type === 'browser' ? pane.id : null,
                // La chat non ha un processo, ma tiene i suoi MESSAGGI: la sua
                // `sessionKey` e' l'unico modo di contarli. Un `paneId` non e'
                // una sessionKey (per una chat il pane e' il TOPIC), quindi si
                // passa da `sessionKeyForPaneId` invece di indovinare.
                pane.type === 'chat' ? sessionKeyForPaneId(pane.id, topics) : null,
              )}`}
            >{pane.type === 'browser' ? <BrowserTabAddress paneId={pane.id} label={label} /> : label}</span>
            {/* Project tabs intentionally do NOT show git status numbers (changed
                files / ahead-behind / running processes) — the sidebar project row
                dropped them (cryptic numbers) and the two surfaces must read the
                same: icon + name + notification badge + loading spinner. Git /
                process status lives in the git & terminal panes where it's
                actionable. */}
            {/* LA CHIUSURA NON STA PIÙ QUI, ed è la correzione di una regola che
                questo commento dichiarava: «sta PRIMA dei widget di caricamento
                e stato, così spinner e badge sono le cose più in coda alla tab».
                Era coerente con sé stessa e sbagliata dal lato dell'uso: il
                comando finiva in mezzo ai glifi, e la sua x dipendeva da quanti
                ce n'erano — una tab con lo spinner e una senza mettevano la X in
                due punti diversi. «Il tasto chiusura deve essere sempre a fine
                tab, andando in hover sulle icone invece inutili» (Attilio,
                09/08). Adesso è l'ULTIMO elemento e sta fuori dal flusso: vedi
                ROW_ACTIONS, in fondo alla tab. */}
            {/* Loading spinner — one canonical widget per pane kind.
                All three read from StreamingContext; rendering only when
                the corresponding signal is on. Chat is interruptible
                (onStop wired), project + terminal are read-only. */}
            {pane.type === 'chat' && pane.topicId && (
              <TopicStreamingSpinner
                topicId={pane.topicId}
                onStop={onStopStreaming ? () => onStopStreaming(pane.id) : undefined}
              />
            )}
            {/* A PROJECT TAB IS A FOLDER, and its roll-up only shows while the
                folder is SHUT. Selected, the project window is the one on
                screen: its own tab bar is right there with a loader and a clock
                on every child that is working, so the parent's aggregate
                repeats them one bar above and you cannot tell which is which.
                Not selected, the children are behind it and the aggregate is
                the only thing that can speak for them. Same rule as the sidebar
                project row, where "shut" is the collapsed accordion. */}
            {pane.type === 'project' && pane.projectPath && !isSelected && (
              <ProjectStreamingSpinner projectPath={pane.projectPath} />
            )}
            {pane.type === 'terminal' && (() => {
              // Terminal panes are created at several sites that don't set
              // terminalSessionId; derive it from the pane id (`terminal:<id>`)
              // so the tab's own spinner isn't gated out. Mirrors the rollup
              // in ProjectWindow + useProjectLayout's terminal sync.
              const sid = pane.terminalSessionId ?? getTerminalSessionFromPaneId(pane.id);
              return sid ? <TerminalStreamingSpinner sessionId={sid} /> : null;
            })()}
            {pane.type === 'browser' && <BrowserStreamingSpinner paneId={pane.id} />}
            {/* IL BINARIO QUIETO — i segnali che il comando può coprire. Lo
                spinner resta FUORI (sopra): fermare un turno e chiudere la tab
                sono due azioni diverse nello stesso istante.

                I `ml-0.5` scritti a mano su ognuno se ne vanno: erano 2px sopra
                il `gap` del contenitore, cioè 8 effettivi fra due cue e 6 fra la
                X e lo spinner — due passi nella stessa tab. Adesso l'aria la
                mette il contenitore, una volta. */}
            <div className={`${ROW_TRAIL} flex items-center ${ROW_GAP} flex-shrink-0`}>
            {/* Quanto lavoro c'è su questa board, per stato. Vale per le DUE
                tab che aprono una kanban — quella generale (`board`) e quella
                di un progetto (`kanban`) — e la seconda conta solo i suoi: il
                progetto è quello della finestra, che questa barra conosce come
                `dndScope` (per il main è `STANDALONE_SCOPE`, cioè nessuno).
                Vedi BoardTabCounts per il perché di quali stati e da dove. */}
            {(pane.type === 'board' || pane.type === 'kanban') && (
              <BoardTabCounts
                projectPath={
                  pane.type === 'kanban'
                    ? (pane.projectPath ?? (dndScope && dndScope !== STANDALONE_SCOPE ? dndScope : undefined))
                    : undefined
                }
              />
            )}
            {/* Quiet cue, and the only one that is a WARNING: this project is
                visible to an organisation with other people in it. It sits in
                the quiet rail rather than next to the favicon because it is not
                the project's identity — but unlike the three dots it is always
                DRAWN, never hover-only, because the whole point is to be read
                BEFORE typing rather than found afterwards. Who decides when it
                shows — and why `org_id != null` is not the condition — is in
                `lib/projectSharing.ts`, which also carries the request that
                asked for it, verbatim. */}
            {pane.type === 'project' && pane.projectPath && (
              <SharedOrgBadge
                path={pane.projectPath}
                className={onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-faint/70'}
              />
            )}
            {/* Quiet cue: this chat/terminal tab opened a browser. A third,
                independent signal — not attention (NotificationBadge) and not
                loading (spinner) — so it stays muted. Keyed by topicId (chat)
                or pane id (terminal); see browserSpawner registry. */}
            {(() => {
              const spawnerKey = pane.type === 'chat' ? pane.topicId : pane.type === 'terminal' ? pane.id : undefined;
              if (!spawnerKey || !spawnedBrowserMap[spawnerKey]) return null;
              return (
                <span
                  className={`ml-0.5 flex items-center ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-faint/70'}`}
                  title={tr('tab.openedBrowser')}
                  data-testid="tab-spawned-browser"
                  aria-label="Ha aperto un browser"
                >
                  <Globe size={11} />
                </span>
              );
            })()}
            {/* Quiet cue: this page logged errors to its console. It belongs in
                the quiet rail and NOT on the three dots, because the dots only
                exist under the pointer: a notification you have to hover to
                find is not a notification. The count and the console itself
                are one click away, in the menu. */}
            {pane.type === 'browser' && <BrowserTabConsoleCue paneId={pane.id} onFill={onFill} />}
            {/* Quiet cue: this chat is backed by the cloud (OpenClaw) provider —
                a cloud session, not a local one. Muted, like the browser cue. */}
            {pane.type === 'chat' && pane.topicId && topics[pane.topicId]?.provider === 'openclaw' && (
              <span
                className={`ml-0.5 flex items-center ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-faint/70'}`}
                title="Cloud (OpenClaw)"
                data-testid="tab-cloud"
                aria-label={tr('tab.cloudSession')}
              >
                <Cloud size={11} />
              </span>
            )}
            {/* Pinned ("Fissato") cue — parity with the sidebar rows, which show
                a Pin glyph on pinned chat/terminal/browser/project rows. Same
                canonical pinKeyForPane the context menu uses, so every pinnable
                type gets the indicator consistently. Only rendered when the host
                wires isFissato (standalone tab bars; project tab bars don't). */}
            {isFissato && (() => {
              const pk = pinKeyForPane(pane);
              if (!pk || !isFissato(pk)) return null;
              return (
                <span
                  className={`ml-0.5 flex items-center ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-faint/70'}`}
                  title="Fissato"
                  data-testid="tab-pinned"
                  aria-label="Fissato"
                >
                  <Pin size={11} />
                </span>
              );
            })()}
            {/* Tempo: da quanto lavora, o quanto fa che ha finito. Stessa regola
                della riga di sidebar (`deriveSubjectTime`), così le due superfici
                non possono dire due numeri diversi per lo stesso soggetto. Si
                auto-nasconde quando non c'è niente da dire — vedi SessionElapsed. */}
            {(() => {
              const subjectId = pane.type === 'chat'
                ? pane.topicId
                : pane.type === 'terminal'
                  ? (pane.terminalSessionId ?? getTerminalSessionFromPaneId(pane.id))
                  : undefined;
              return subjectId ? <SessionElapsed subjectId={subjectId} onFill={onFill} /> : null;
            })()}
            {/* The PROJECT's time, under the same rule as its loader: only
                while the folder is shut, because open it is the children that
                say it. It is a time that RUNS (the loader's colour and motion),
                never a receipt. */}
            {pane.type === 'project' && pane.projectPath && !isSelected && (
              <ProjectElapsed projectPath={pane.projectPath} onFill={onFill} />
            )}
            {/* The split position mini-map lives on the SIDEBAR topic cards
                only (user preference), NOT on the top tab bar — see
                Sidebar/TopicItem + SplitMiniMap (fed by SplitPositionContext).
                The tab bar deliberately renders no split schematic. */}
            <NotificationBadge
              count={badgeCount}
              variant={onFill ? 'onFill' : 'default'}
              // Il numero di un PROGETTO è un aggregato: dice quanto, mai di chi.
              // E i suoi figli possono benissimo non mostrare niente — quello
              // selezionato non porta badge per contratto (TAB-BADGE-07), quello
              // in un altro gruppo non è sott'occhio. Risultato osservato: la tab
              // «Guido AI» con un 1 e nessuna tab dentro che lo rivendicasse. Il
              // tooltip chiude il cerchio: il numero ha sempre un nome.
              title={
                pane.type === 'project' && pane.projectPath
                  ? describeProjectBadge(pane.projectPath) || undefined
                  : undefined
              }
            />
            </div>
            {/* IL COMANDO, ULTIMO NEL DOM E FUORI DAL FLUSSO.
                Anche una tab FISSATA si chiude. Il fissaggio non è un
                lucchetto: è una scorciatoia che resta — chiusa la tab, la
                tessera nei Fissati rimane e riaprirla la riporta dov'era
                (riaprendo si disarchivia). Il lucchetto restava solo finché non
                toglievi il pin, cioè chiedeva di smontare la scorciatoia per
                fare la cosa più comune che ci si fa. */}
            {/* THE RAIL IS ONE, and the close ring is its LAST child (see
                ROW_ACTIONS: "a new command goes in BEFORE the circle, never
                after"). A second `.row-actions` sibling would be a second
                absolute box on the same anchor, i.e. two commands stacked on
                top of each other, so the browser's three dots ride inside this
                one. A pane that cannot be closed still gets its menu. */}
            {(!nonClosablePaneIds?.has(pane.id) || pane.type === 'browser') && (
              <PaneCloseButton
                paneId={pane.id}
                label={label}
                onClose={onClose}
                closable={!nonClosablePaneIds?.has(pane.id)}
                before={pane.type === 'browser' ? <BrowserTabMenuButton paneId={pane.id} /> : undefined}
              />
            )}
          </div>
        );
      })}
      </div>

      {/* Edge-split preview — a narrow strip at the bar's left or right edge
          (EDGE_DROP_PX wide, matching the actual trigger band) with a seam accent
          on the inner edge. The old half-bar SplitRegion covered 50% of the bar
          width, which looked broken when the user was simply aiming at the bar to
          add a tab: the visual claimed half the bar but only 30px at the edge
          actually trigger a split. Mutually exclusive with the insert caret. */}
      {edgeSplitZone && (
        <div
          data-tab-edge-split={edgeSplitZone}
          // `split`, cioè «questo rilascio taglia il bersaglio in due»: il
          // colore, il filo e il raggio li porta la regola unica di `index.css`.
          // Qui restano solo GEOMETRIA e posizione, che sono le uniche cose che
          // questa striscia sa e la regola no — dove comincia il bordo, e che è
          // larga quanto la banda che il taglio lo fa scattare davvero.
          data-drop-active="split"
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            width: EDGE_DROP_PX,
            ...(edgeSplitZone === 'left' ? { left: 0 } : { right: 0 }),
            pointerEvents: 'none',
            zIndex: 40,
          }}
        />
      )}

      {/* Add-pane affordance — single canonical component. Owns the
          trigger button, the click handler (web portal AND Electron
          native overlay), the items, and the mobile bottom-sheet. The
          sidebar's project-header "+" renders the SAME component with
          different `availableTypes` and a hover-revealed trigger. */}
      {hasMenuItems && (
        <div
          // `ROW_INSET` e non `pr-1`. Il «+» stava a 4px dal bordo destro —
          // l'unico numero della barra fuori dal passo della colonna, e proprio
          // nell'angolo in alto a destra della FINESTRA, che sotto la shell mac
          // è arrotondato a 12. Da lì nasceva il «non si trova col border radius
          // della finestra»: non è il raggio del bottone a essere sbagliato (le
          // superfici stanno tutte a 8), è che a 4px dalla curva della finestra
          // due archi diversi si toccano e il confronto diventa inevitabile.
          // A 6 il bottone respira, sta sul ritmo di tutto il resto, e smette di
          // essere letto insieme all'angolo.
          //
          // `raised-control-overlay`: questo «+» non è in fila con le tab, ci
          // sta SOPRA — la strip scorre sotto di lui. Sotto la vibrancy il
          // fondo di un comando è un'alpha (6-10%), e a quell'alpha una tab che
          // passa sotto si legge attraverso il bottone. La variante non lo
          // rende opaco: sfoca ciò che gli passa sotto, così resta di vetro
          // senza diventare un velo. Vedi index.css.
          // L'incasso a destra è `ROW_INSET` (CHROME_ROW_ACTION_INSET), lo
          // stesso 6 con cui ogni riga e ogni tab stanno lontane dal loro
          // bordo. C'è stato un giro in cui lo ricavava dall'altezza della riga
          // (`chromeRowInset`): col dito veniva DUE, e il bottone stava
          // incollato al bordo mentre la strip senza comando si ferma a 6.
          // Il bordo è una domanda orizzontale e ha già il suo numero.
          // `bar-action-reveal`: col mouse esce al passaggio sulla barra, col
          // dito resta acceso. Vedi index.css — lo spazio resta riservato in
          // ogni caso, quindi l'ultima tab non balla quando compare.
          className={`bar-action-reveal raised-control-overlay absolute ${CHROME_ROW_ACTION_INSET} top-1/2 -translate-y-1/2 flex items-center app-no-drag z-10`}
          {...NO_DRAG_REGION}
        >
          <PaneAddMenu
            scope={addMenuScope}
            onNewChat={onNewChat}
            onAddPane={onAddPane}
            availableTypes={availableTypes}
            // NESSUN hint ⌘N qui. Il commento che c'era («Cmd+N targets the
            // focused group's New Chat — true here») era falso: ⌘N apre la
            // palette STANDALONE dell'header, cioè una seconda superficie sopra
            // il gruppo che stai guardando, e non crea niente in questo gruppo.
            // Le lettere per-riga restano: quelle sono vere ovunque.
            noElectronDrag
          />
        </div>
      )}

      {/* Right-click context menu — portaled so position:fixed escapes transformed ancestors */}
      {ctxMenu && createPortal(
        <div
          ref={ctxMenuRef}
          role="menu"
          // `overflow-y-auto` + il tetto qui sotto: senza, le voci oltre il bordo
          // dello schermo non erano raggiungibili in nessun modo. `overscroll-contain`
          // perché lo scroll del menu non deve travasare nella pagina sotto.
          className={`fixed ${POPOVER_SURFACE} min-w-[150px] overflow-y-auto overscroll-contain`}
          style={{
            // Finché la misura non c'è il pannello sta fuori campo e invisibile:
            // renderizzato (serve per misurarlo) ma mai mostrato alla posizione
            // sbagliata, così non lampeggia da un angolo all'altro.
            top: ctxPos?.top ?? -9999,
            left: ctxPos?.left ?? -9999,
            visibility: ctxPos ? 'visible' : 'hidden',
            // Il tetto è la viewport meno i margini. È anche ciò che rende la
            // misura sempre risolvibile: `getBoundingClientRect` legge l'altezza
            // GIÀ tagliata, quindi `computeMenuPosition` non può mai collocare un
            // pannello più alto dello schermo.
            maxHeight: Math.max(160, window.innerHeight - POPOVER_MARGIN * 2),
            zIndex: Z_CONTEXT_MENU,
          }}
        >
          {/* "Fissa" / "Rimuovi dai Fissati" — sidebar pinning parity for tabs.
              Pin key = the sidebar-item id, resolved by the canonical
              pinKeyForPane so every pinnable type (chat, terminal, browser,
              project) is covered from one place — previously this was inlined
              as chat|terminal only, which silently hid "Fissa" on browser tabs.
              Returns undefined for non-pinnable panes → item hidden. Also hidden
              when the host doesn't wire onToggleFissato (project tab bars). */}
          {onToggleFissato && (() => {
            const pane = panes.find(p => p.id === ctxMenu.paneId);
            if (!pane) return null;
            const tabKey = pinKeyForPane(pane);
            /**
             * DENTRO UN PROGETTO LE COSE FISSABILI SONO DUE, e finora il menu
             * ne offriva zero.
             *
             * «Per le sotto-tab di un progetto dovremmo mettere fissa progetto
             * e tab» (Attilio, 08/08). La voce singola diceva solo «Fissa» e —
             * peggio — dentro una finestra di progetto non compariva affatto,
             * perché l'ospite non cablava `onToggleFissato`: il commento
             * precedente lo ammetteva («hidden … project tab bars»). Il
             * risultato era che sulla tab di un progetto fissare era possibile
             * solo trascinando, e sul telefono il drag HTML5 non esiste — cioè
             * lì non era possibile affatto.
             *
             * Quando `projectPinKey` c'è, le due voci si nominano: fissare il
             * PROGETTO (torna sempre sotto mano con tutte le sue tab) è una
             * cosa diversa dal fissare QUESTA tab (che si riapre da sola,
             * fuori dal progetto). Senza `projectPinKey` — barra di primo
             * livello — resta la voce singola di prima, che lì non è ambigua.
             */
            const voci: { key: string; etichetta: string; pinned: boolean }[] = [];
            if (projectPinKey) {
              voci.push({ key: projectPinKey, etichetta: 'il progetto', pinned: isFissato?.(projectPinKey) ?? false });
            }
            // `tabKey !== projectPinKey`: la tab del progetto stesso, dentro la
            // sua barra, sarebbe la stessa voce due volte.
            if (tabKey && tabKey !== projectPinKey) {
              voci.push({
                key: tabKey,
                etichetta: projectPinKey ? 'questa tab' : '',
                pinned: isFissato?.(tabKey) ?? false,
              });
            }
            if (voci.length === 0) return null;
            return voci.map(({ key, etichetta, pinned }) => (
              <button
                key={key}
                data-testid={`tab-menu-pin-${etichetta === 'il progetto' ? 'project' : 'tab'}`}
                onClick={() => { onToggleFissato(key); setCtxMenu(null); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
              >
                {pinned ? <PinOff size={14} /> : <Pin size={14} />}
                <span className="flex-1 text-left">
                  {pinned
                    ? (etichetta ? `Togli ${etichetta} dai Fissati` : 'Rimuovi dai Fissati')
                    : (etichetta ? `Fissa ${etichetta}` : 'Fissa')}
                </span>
              </button>
            ));
          })()}
          {/* "Ricarica" — terminal panes only (pane id `terminal:<sessionId>`).
              Restarts the session in place via POST /reload: claude/codex resume
              via --resume (conversation preserved, same tab id), shell gets a fresh
              PTY in the same cwd. Unsticks a wedged session (e.g. a claude CLI
              latched on "Not logged in") without CLI surgery or an app restart. */}
          {isTerminalPaneId(ctxMenu.paneId) && (
            <button
              onClick={() => {
                const sid = getTerminalSessionFromPaneId(ctxMenu.paneId);
                if (sid) {
                  // Show a "Riavvio…" overlay over the pane during the  allow-italian: quoted UI string
                  // kill→respawn gap (cleared on WS reconnect); safety-clear if
                  // it never comes back.
                  //
                  // A REFUSAL IS NOT A WAIT. Before, the result of the POST was
                  // thrown away — no check on `ok`, and a `.catch(() => {})`
                  // that swallowed everything. But the server refuses in three
                  // ways (409 if a reload is already under way, 404 if the
                  // session is not there, 500 if the spawn fails:
                  // `routes/terminal.ts`), and in all three the interface showed
                  // «Riavvio…» for FIFTEEN SECONDS and then took it away  allow-italian: quoted UI string
                  // in silence. That is exactly the shape of "it doesn't work,
                  // or it hangs": it looks like it is working, and nothing is
                  // happening. The 15s cap is the safety net for the case where
                  // the reconnect never arrives, not the normal way of finding
                  // out that it went wrong.
                  restartTerminalSession(sid, toast, tr);
                }
                setCtxMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
              title={tr('tab.restartSession')}
            >
              <RotateCw size={14} />
              <span className="flex-1 text-left">{tr('terminal.reload')}</span>
            </button>
          )}
          {/* "Rinomina" — inline editor (Enter saves, Esc cancels).  allow-italian: quoted UI string
              Terminal tabs PATCH the session name (name_source='user'); chat
              tabs route through the host's topic-update path; browser tabs pin
              pane.title (titleSource='user'). The chat/browser entries hide
              when the host doesn't wire the matching callback (e.g.
              project-inner bars that don't thread onRenameChat). */}
          {(() => {
            const ctxPane = panes.find(p => p.id === ctxMenu.paneId);
            const canRename = isTerminalPaneId(ctxMenu.paneId)
              || (ctxPane?.type === 'chat' && !!ctxPane.topicId && !!onRenameChat)
              || (isBrowserPaneId(ctxMenu.paneId) && !!onRenameBrowser);
            if (!canRename) return null;
            return renameDraft === null ? (
              <button
                onClick={() => setRenameDraft(ctxPane?.title ?? '')}
                className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
                title={tr('tab.rename')}
              >
                <Edit3 size={14} />
                <span className="flex-1 text-left">{tr('tab.menu.rename')}</span>
              </button>
            ) : (
              <div className="flex items-center gap-2 px-3 py-2">
                <Edit3 size={14} className="shrink-0 text-app-text-muted" />
                <input
                  ref={renameInputRef}
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') submitRename(ctxMenu.paneId, renameDraft);
                    else if (e.key === 'Escape') setRenameDraft(null);
                  }}
                  placeholder={tr('tab.newName')}
                  maxLength={120}
                  className="flex-1 min-w-0 bg-app-input border border-app-border rounded px-2 py-1 text-[13px] md:text-[12px] text-app-text focus:outline-none focus:border-primary"
                />
                <button
                  onClick={() => submitRename(ctxMenu.paneId, renameDraft)}
                  className="shrink-0 p-1 rounded hover:bg-app-hover text-app-text-muted hover:text-app-text transition-colors"
                  title={tr('common.save')}
                  aria-label={tr('common.save')}
                >
                  <Check size={14} />
                </button>
              </div>
            );
          })()}
          {/* «Copia link» — il permalink `/tab/…` di QUESTA tab.
              Il gate è il `null` di `tabTargetForPane`: la voce compare solo se
              la tab è davvero indirizzabile. Sono esclusi per costruzione i
              pane il cui id è sorteggiato a ogni apertura (kanban, git, files,
              log) e le pane SINTETICHE del drawer di un task — Thread (una chat
              senza topicId), Piano, allegati — che non esistono nel pane-store
              e non avrebbero niente da riaprire.
              Su una tab BROWSER le voci sono due, perché le domande sono due:
              «Copia link alla tab» dà l'indirizzo della tab dentro l'app,
              «Copia URL della pagina» quello del sito che ci sta dentro.
              Il feedback è un toast: il menu si chiude al click, quindi lo swap
              d'icona alla TaskDetail non si vedrebbe mai. */}
          {/* «Apri nel progetto». Sta PRIMA dei due «copia link» perché è
              l'unico gesto di questo menu che sposta la scheda invece di
              descriverla, e perché è quello che si cerca: prima viveva come
              icona-mappamondo nella testata del drawer, senza nome scritto e
              per TUTTE le tab insieme. Qui parla alla tab su cui hai premuto. */}
          {onOpenPaneInProject && (() => {
            const ctxPane = panes.find(p => p.id === ctxMenu.paneId);
            if (!ctxPane || ctxPane.type !== 'browser') return null;
            const paneId = ctxMenu.paneId;
            return (
              <button
                onClick={() => { onOpenPaneInProject(paneId); setCtxMenu(null); }}
                data-testid="tab-menu-open-in-project"
                title={tr('board.task.openTabInProjectTitle')}
                className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
              >
                <ArrowUpRight size={14} />
                <span className="flex-1 text-left">{tr('board.task.openTabInProject')}</span>
              </button>
            );
          })()}
          {(() => {
            const ctxPane = panes.find(p => p.id === ctxMenu.paneId);
            if (!ctxPane) return null;
            const target = tabTargetForPane(ctxPane, linkContext);
            // `pane.url` è la fonte per le pane di progetto e del drawer (non
            // sono nel pane-store); `getBrowserPaneUrl` copre quelle di primo
            // livello, che la barra standalone ricostruisce dai soli id.
            const pageUrl = ctxPane.type === 'browser'
              ? (isRealUrl(ctxPane.url) ? ctxPane.url : getBrowserPaneUrl(ctxPane.id))
              : undefined;
            if (!target && !pageUrl) return null;
            return (
              <>
                {target && (
                  <button
                    onClick={() => { void copyTabLink(target); setCtxMenu(null); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
                    title={tr('tab.copyLink')}
                  >
                    <Link2 size={14} />
                    <span className="flex-1 text-left">{pageUrl ? 'Copia link alla tab' : 'Copia link'}</span>
                  </button>
                )}
                {pageUrl && (
                  <button
                    onClick={() => { void copyUrl(pageUrl); setCtxMenu(null); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
                    title={pageUrl}
                  >
                    <Globe size={14} />
                    <span className="flex-1 text-left">{tr('tab.menu.copyUrl')}</span>
                  </button>
                )}
              </>
            );
          })()}
          {/* Right-click "Close" is the explicit-confirmation path — bypass
              the PendingAction countdown that gates the default X button.
              Falls back to onClose for legacy callers that don't pass
              onCloseImmediate. Hidden for structurally-owned (non-closable)
              panes, same as the tab X. */}
          {!nonClosablePaneIds?.has(ctxMenu.paneId) && (
            <>
              <button
                onClick={() => {
                  (onCloseImmediate ?? onClose)(ctxMenu.paneId);
                  setCtxMenu(null);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
              >
                <X size={14} />
                <span className="flex-1 text-left">{tr('tab.menu.closeNow')}</span>
              </button>
              <button
                onClick={() => { onClose(ctxMenu.paneId); setCtxMenu(null); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
                title={tr('tab.closeCountdown')}
              >
                <X size={14} />
                <span className="flex-1 text-left">{tr('tab.menu.closeCountdown')}</span>
              </button>
            </>
          )}
          {panes.length > 1 && (
            <button
              onClick={() => {
                if (onCloseOthers) {
                  onCloseOthers(ctxMenu.paneId);
                } else {
                  // Fallback: close all except the targeted pane
                  panes.forEach(p => { if (p.id !== ctxMenu.paneId) onClose(p.id); });
                }
                setCtxMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
            >
              <X size={14} />
              <span>{tr('tab.menu.closeOthers')}</span>
            </button>
          )}
          {splitLayoutAvailable && (onSplitRight || onSplitDown) && (
            <>
              <div className="h-px bg-app-border my-1" />
              {onSplitRight && (
                <button
                  onClick={() => { onSplitRight(ctxMenu.paneId); setCtxMenu(null); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
                >
                  <Columns2 size={14} />
                  <span>{tr('tab.menu.splitRight')}</span>
                </button>
              )}
              {onSplitDown && (
                <button
                  onClick={() => { onSplitDown(ctxMenu.paneId); setCtxMenu(null); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
                >
                  <Rows2 size={14} />
                  <span>{tr('tab.menu.splitDown')}</span>
                </button>
              )}
            </>
          )}
          {/* Layout-actions section (divider owned here): "Reimposta pannelli"
              first, then "Sposta nello Spazio →" (Spazi), then "Sposta in una
              nuova finestra" (pop-out) — coherence ruling 3.2 order. */}
          {(() => {
            const ctxPane = panes.find(p => p.id === ctxMenu.paneId);
            const showPopOutHere = ctxPane?.type === 'chat' && !!onPopOut;
            return ((onResetLayout && splitLayoutAvailable) || showMoveToSpace || showPopOutHere);
          })() && (
            <>
              <div className="h-px bg-app-border my-1" />
              {onResetLayout && splitLayoutAvailable && (
                <button
                  onClick={() => { onResetLayout(); setCtxMenu(null); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
                  title={tr('tab.flattenSplits')}
                >
                  <LayoutGrid size={14} />
                  <span className="flex-1 text-left">Reimposta pannelli</span>
                </button>
              )}
              {showMoveToSpace && (() => {
                // Read the AUTHORITATIVE store pane, not the `panes` prop: the
                // latter is reconstructed from ids in StandaloneChatGroup and
                // never copies `spaceId`, so resolvePaneSpace(ctxPane) always
                // returned DEFAULT_SPACE_ID → the "Principale" row was ALWAYS
                // disabled, so a pane in another Space could never be moved back
                // to Principale ("non mi fa selezionare il progetto principale").
                const ctxPane = usePaneStore.getState().panes[ctxMenu.paneId] ?? panes.find(p => p.id === ctxMenu.paneId);
                const currentSpace = resolvePaneSpace(ctxPane, spacesRegistry);
                const targets: { id: string; name: string }[] = [
                  { id: DEFAULT_SPACE_ID, name: DEFAULT_SPACE_LABEL },
                  ...liveSpacesOrdered(spacesRegistry).map(s => ({ id: s.id, name: s.name || 'Gruppo' })),
                ];
                return (
                  <>
                    <button
                      onClick={() => setSpaceSubmenuOpen(open => !open)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
                      title={tr('tab.moveToGroup.hint')}
                      aria-expanded={spaceSubmenuOpen}
                    >
                      <Layers size={14} />
                      <span className="flex-1 text-left">{tr('tab.moveToGroup')}</span>
                      <ChevronRight size={12} className={`text-app-text-muted transition-transform ${spaceSubmenuOpen ? 'rotate-90' : ''}`} />
                    </button>
                    {spaceSubmenuOpen && (
                      <>
                        {targets.map(target => {
                          const isCurrent = target.id === currentSpace;
                          return (
                            <button
                              key={target.id}
                              disabled={isCurrent}
                              onClick={() => {
                                movePaneToSpace(ctxMenu.paneId, target.id);
                                setCtxMenu(null);
                              }}
                              className={`w-full flex items-center gap-2 pl-8 pr-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] transition-colors ${
                                isCurrent
                                  ? 'text-app-text-muted cursor-default'
                                  : 'text-app-text hover:bg-app-hover'
                              }`}
                            >
                              <span className="flex-1 text-left truncate">{target.name}</span>
                              {isCurrent && <Check size={12} className="text-app-text-muted" />}
                            </button>
                          );
                        })}
                        {liveSpaceCount(spacesRegistry) < SPACES_MAX && (
                          <button
                            onClick={() => {
                              const id = createSpaceId();
                              usePaneStore.getState().dispatch({
                                type: 'SPACE_UPSERT',
                                payload: { space: { id, name: nextSpaceName(spacesRegistry) } },
                              });
                              movePaneToSpace(ctxMenu.paneId, id);
                              setCtxMenu(null);
                            }}
                            className="w-full flex items-center gap-2 pl-8 pr-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
                          >
                            <Plus size={12} />
                            <span className="flex-1 text-left">{tr('tab.newGroup')}</span>
                          </button>
                        )}
                      </>
                    )}
                  </>
                );
              })()}
              {(() => {
                const ctxPane = panes.find(p => p.id === ctxMenu.paneId);
                if (ctxPane?.type !== 'chat' || !onPopOut) return null;
                return (
                  <button
                    onClick={() => { onPopOut!(ctxMenu!.paneId); setCtxMenu(null); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
                    title={tr('tab.popOut.hint')}
                  >
                    <ExternalLink size={14} />
                    <span className="flex-1 text-left">{tr('tab.popOut')}</span>
                  </button>
                );
              })()}
              {onPopOutGroup && panes.length > 1 && (
                <button
                  onClick={() => { onPopOutGroup!(); setCtxMenu(null); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
                  title={tr('tab.popOutGroup.hint')}
                >
                  <ExternalLink size={14} />
                  <span className="flex-1 text-left">{tr('tab.popOutGroup')}</span>
                </button>
              )}
            </>
          )}
          {onDetach && (
            <>
              <div className="h-px bg-app-border my-1" />
              <button
                onClick={() => { onDetach(ctxMenu.paneId); setCtxMenu(null); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
                title={tr('tab.splitOut.hint')}
              >
                <Columns2 size={14} />
                <span>{tr('tab.splitOut')}</span>
              </button>
            </>
          )}
          {/* Inverse of Detach — a solo split cell's tab merging back into the
              main pool. Distinct label + icon: the two directions used to share
              one 'Detach' entry that meant the OPPOSITE thing per group kind. */}
          {onReattach && (
            <>
              <div className="h-px bg-app-border my-1" />
              <button
                onClick={() => { onReattach(ctxMenu.paneId); setCtxMenu(null); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
                title={tr('tab.reattach.hint')}
              >
                <Combine size={14} />
                <span>{tr('tab.reattach')}</span>
              </button>
            </>
          )}
          {(() => {
            const ctxPane = panes.find(p => p.id === ctxMenu.paneId);
            const isChat = ctxPane?.type === 'chat';
            const showSettings = isChat && onSettings;
            // Pop-out moved into the layout-actions section as "Sposta in una
            // nuova finestra" (ruling 3.2) — this trailing section is now
            // Settings only.
            if (!showSettings) return null;
            return (
              <>
                <div className="h-px bg-app-border my-1" />
                <button
                  onClick={() => { onSettings!(ctxMenu!.paneId); setCtxMenu(null); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors"
                >
                  <Settings size={14} />
                  <span>{tr('common.settings')}</span>
                </button>
              </>
            );
          })()}
        </div>,
        document.body
      )}
    </div>
  );
}

/**
 * Per-tab close button: empty on idle, the soft-close ring (X) revealed on
 * hover. The grey ⌘N keyboard-index badge that used to occupy this slot when
 * idle was removed — it read as a cryptic indicator on the first nine tabs and
 * earned its keep nowhere; the Cmd/Ctrl+1-9 shortcut still works (owned by
 * useKeyboardShortcuts). Pulled out of the main render loop because it calls
 * `usePanePendingStatus` — hooks can't run inside `panes.map(...)`.
 */
function PaneCloseButton({
  paneId, label, onClose, before, closable = true,
}: {
  paneId: string;
  /**
   * THE HUMAN NAME OF THE TAB, the one written on the tab itself
   * (`etichettaTab`).
   *
   * It feeds the accessible name of the X, which used to carry the INTERNAL ID:
   * VoiceOver announced a destructive action as «Chiudi tab 7f3a1c22-4b9e-...», allow-italian: the exact string a screen reader used to speak
   * i.e. it asked to destroy something that cannot be recognised. The twins in
   * the sidebar (TopicItem, TopicTree) have always said the chat name.
   */
  label: string;
  onClose: (id: string) => void;
  /** Commands that ride in the same rail, BEFORE the close ring (the browser
   *  tab's three dots). See the ROW_ACTIONS contract. */
  before?: React.ReactNode;
  /** false = the rail exists for `before` only; this pane does not close. */
  closable?: boolean;
}) {
  // v3 sidebar↔topbar sync: usePanePendingStatus also picks up the
  // sidebar-side keys (`archive-topic:<id>` for chat panes,
  // `close-terminal:<id>` / `close-browser:<id>`) so the topbar tab shows
  // the same countdown regardless of which surface kicked it off.
  const pendingStatus = usePanePendingStatus(paneId);

  // La regola che stava qui — «chiudere una tab non ha un altro percorso col
  // dito, quindi senza puntatore il cerchio si VEDE» — è ancora quella, ma non
  // la implementa più un hook: la scrive il CSS del binario, una volta per tutte
  // le superfici (`@media (hover: hover)` in index.css). Un `useHoverReveal` per
  // superficie erano N copie della stessa domanda, e infatti rispondevano
  // diversamente: qui `hasHover`, sulle righe di sidebar `isTouch`, sul progetto
  // un `group-hover` che spegneva anche il conto alla rovescia.

  // IL BERSAGLIO STA SUL BOTTONE, NON SULLO SPAN.
  //
  // Il glifo è 14px dentro uno span da 20, in una tab alta 36 su touch: sotto
  // metà della soglia iOS, e infatti col dito si prende la tab invece della X.
  // L'area sensibile si allarga con un `::after` (solo su `pointer: coarse`), e
  // la classe va messa sull'elemento che il clic lo GESTISCE: sullo span esterno
  // l'area allargata non apparterrebbe al bottone e il tocco cadrebbe sulla tab,
  // cioè attiverebbe invece di chiudere.
  //
  // QUI C'ERA `tap-expand` (44×44), E IL CONTO NON TORNAVA. Rifatto per davvero,
  // in px, sulla tab larga 150 FISSE con `px-2` e figli separati da `gap-1.5`
  // (6px) — cioè 134px di contenuto:
  //
  //  · Tab chat SENZA widget in coda: icona 14 + etichetta + X 20, due gap → la
  //    etichetta prende 88 e la X sta a 122→142, centro 132. I 44 centrati vanno
  //    110→154: a destra sporgono 4px oltre il bordo della tab (150), e lì
  //    `overflow-hidden` taglia sia il disegno sia l'hit-test — la tab vicina
  //    resta intoccabile, quella parte del conto era giusta. A sinistra i 12px
  //    cadono sulla coda dell'ETICHETTA, che è la tab stessa: attiva, non
  //    chiude. Prezzo accettabile.
  //  · Tab chat MENTRE STREAMA — ed è il caso che rompe. Dopo la X c'è il
  //    LoaderSlot, che con `onStop` è un `<button>` vero da 16px. L'etichetta
  //    scende a 66, la X sta a 100→120 (centro 110), i 44 vanno 88→132: dentro
  //    la tab, quindi niente clipping, e i 12px di destra si mangiano i 6 di gap
  //    PIÙ i primi 6 dei 16 dello Stop (il 37% del bottone). Lo span della X ha
  //    `relative z-10` e lo Stop sta nel flusso normale senza z-index: il
  //    pseudo-elemento VINCE l'hit-test. Col dito, il terzo sinistro di «Stop»
  //    chiude la tab invece di fermare il turno.
  //
  // Quindi `tap-expand-y`: cresce SOLO in altezza, larghezza 100%, e non toglie
  // un pixel a nessun vicino. Detto senza abbellirlo: i 44px di altezza li taglia
  // comunque l'`overflow-hidden` della tab a 36.
  //
  // MA LA LARGHEZZA RESTAVA 14, ed è l'asse su cui il dito sbaglia di più. Il
  // motivo è che `tap-expand-y` proietta `left:0; right:0`, cioè il 100% DEL
  // BOTTONE — e il bottone era largo `size` (14) perché `PendingActionRing` la
  // metteva in uno `style` inline, che nessuna classe scavalca. Lo span esterno
  // ne riservava già 20 e 6 andavano sprecati: l'area sensibile non arrivava nemmeno
  // al bordo dello slot che le era stato messo da parte.
  //
  // Adesso il box del bottone lo detta il chiamante (`boxClassName="w-full h-full"`
  // riempie lo slot) e su touch lo slot passa da 20 a 28. Il conto, sulla tab larga
  // 150 FISSE con `px-2` e `gap-1.5`, cioè 134px di contenuto:
  //
  //  · l'etichetta è l'unico `flex-1`, quindi gli 8px in più li paga solo lei:
  //    88 → 80 (-9%) su un testo che tronca già di suo;
  //  · il bersaglio passa da 14×36 a 28×36 — il DOPPIO dell'area, e in largo è
  //    esattamente lo spazio che lo slot occupava e non usava;
  //  · a 36 (`w-9`, la misura delle righe di sidebar) l'etichetta scenderebbe a
  //    72 (-18%), e mentre la chat streama il vicino a destra è il bottone Stop
  //    da 16px: è il conto che questo commento ha già litigato una volta. Qui i
  //    44 di Apple non ci sono e non si possono avere senza rubarli allo Stop.
  //
  // 07/08: il GLIFO passa da 14 a 16 (`ROW_ACTION_GLYPH`, la stessa misura che
  // ora hanno tutti i cerchi «fatto / chiudi» dell'app) e lo slot col mouse da
  // 20 a 24, o un cerchio da 16 in un box da 20 tocca i bordi. Il conto qui
  // sopra si sposta di 4px, non di 8: l'etichetta scende da 88 a 84 — meno di
  // quanto era già costato allargare il bersaglio col dito, e il motivo è lo
  // stesso: «il tasto per poter spuntare una tab e chiuderla è troppo piccolo».
  // Stesso breakpoint della tab che lo contiene (`h-9 md:h-7`): con due
  // meccanismi diversi uno slot da 28 finiva dentro una tab da 28, cioè a filo
  // dei bordi, ogni volta che larghezza e touch non coincidevano.
  //
  // ── E TUTTO IL CONTO QUI SOPRA È DECADUTO, perché lo slot non è più in fila ─
  //
  // Ogni riga di quell'aritmetica pesava lo stesso pezzo: quanti px il comando
  // toglie all'ETICHETTA dentro i 134 utili della tab. 14 → 20 → 24 → 28, e
  // ogni volta l'etichetta scendeva (88 → 84 → 80) e ogni volta bisognava
  // decidere se valeva. Il paragrafo che si chiude con «i 44 di Apple non ci
  // sono e non si possono avere senza rubarli allo Stop» era vero: in una fila,
  // allargare un bersaglio vuol dire stringerne un altro.
  //
  // Fuori dal flusso quel conto sparisce. Il binario è `absolute` (vedi
  // ROW_ACTIONS), quindi il box può essere quello CONDIVISO — 36 col dito, 28
  // col mouse, `ROW_ACTION_BOX` come ogni altro comando dell'app — e l'etichetta
  // non paga niente: anzi, riprende i 24-28px che lo slot le toglieva. La
  // docstring di `ROW_ACTION_BOX` dichiarava già «vale ANCHE nella barra delle
  // tab», e per tre giri era stata l'unica superficie a non rispettarla, con
  // 28/24 contro 36/28.
  //
  // Niente `useHoverReveal` e niente ternario sul pending: la visibilità la
  // decide il CSS del binario, che è dove `hover: hover` si può chiedere bene —
  // è una proprietà del dispositivo, non un booleano che React ricalcola. E
  // `data-pending` tiene il cerchio acceso mentre il conto scorre, anche se il
  // mouse se ne va.
  return (
    <span
      // `w-auto` when the rail carries more than one command: ROW_ACTION_BOX
      // sizes ONE box, and a two-command rail clipped its first child to the
      // width of the second.
      className={`${ROW_ACTIONS} ${before ? 'h-7 md:h-7 w-auto' : ROW_ACTION_BOX}`}
      data-pending={pendingStatus ? 'true' : undefined}
    >
      {before}
      {closable && <PendingActionRing
        status={pendingStatus}
        size={ROW_ACTION_GLYPH}
        boxClassName={ROW_ACTION_BOX}
        className="tap-expand-y"
        testId="pane-tab-close"
        onIdleClick={() => onClose(paneId)}
        idleTitle="Chiudi tab"
        // The NAME, not the id: see the `label` prop. The prefix below stays
        // first because test locators hook onto it and because in a spoken
        // announcement the action has to come before its subject.
        idleAriaLabel={`Chiudi tab ${label}`}
        pendingTitle="Annulla chiusura"
        pendingAriaLabel="Annulla chiusura"
      />}
    </span>
  );
}

/**
 * Sub-component co-located in this file because it needs to live as a
 * direct child of the per-pane `<button>` (so the absolute overlay covers
 * just that tab) and needs its own subscription to PendingActionContext
 * keyed by paneId. Module scope keeps the hook out of the parent's
 * `panes.map(...)` loop.
 */
function PaneTabPendingOverlay({ paneId }: { paneId: string }) {
  // v3 sidebar↔topbar sync: the overlay paints the per-pane countdown
  // regardless of whether the close was initiated from the topbar (X)
  // or from the sidebar (archive icon / close-terminal / close-browser).
  const status = usePanePendingStatus(paneId);
  if (!status) return null;
  return <PendingActionProgressOverlay status={status} className="rounded-lg" />;
}

/**
 * Blue "awaiting feedback" overlay for a chat tab. Co-located (like
 * PaneTabPendingOverlay) so the per-topic signal hook stays out of the parent's
 * `panes.map(...)` loop. Translucent fill + gentle pulse, painted over the tab
 * content so it layers atop the neutral selection surface without clobbering it.
 */

