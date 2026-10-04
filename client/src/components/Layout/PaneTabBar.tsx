import { markDraftTouched } from '../../state/draftPane';
import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, useSyncExternalStore } from 'react';
import { MessageSquare, FolderTree, Globe, Terminal, GitBranch, Activity, BookOpen, Cpu, FileCode, BarChart3, Kanban, Clock, UserRound } from 'lucide-react';
import { usePanePendingStatus } from '../../contexts/PendingActionContext';
import { PendingActionProgressOverlay } from '../Shared/PendingActionProgressOverlay';
import { PaneAddMenu } from '../Shared/PaneAddMenu';
import type { Pane, PaneType, PaneGroupType, AttentionTier } from '../../types';
import { getPaneConfig, getTerminalSessionFromPaneId, isDraftPaneId, pinKeyForPane, sessionKeyForPaneId, type PaneScope } from '../../state/pane/adapters';
import { isUtilityPanelId } from '../../state/pane/adapters/utilityPanelId';
import { getProjectLabel } from '../../lib/buildSidebarItems';
import { getBrowserPaneUrl } from '../../state/pane/browserPaneUrl';
import { attentionFillFor } from '../../state/signals';
import { litTierOf, useAttentionRows } from '../../state/attention';
import { projectAttention } from '../../state/attentionRollups';
import { terminalSubject, topicSubject } from '../../../../shared/attention';
import { ClaudeIcon } from '../Shared/ClaudeIcon';
import { TopicColorDot } from '../Shared/TopicColorDot';
import { CodexIcon } from '../Shared/CodexIcon';
import { getFileIconDef } from '../../lib/fileIcons';
import { rememberDraggedPane } from '../../lib/dragPayload';
import { startDragPreview, endDragPreview } from '../../lib/dragPreview';
import { DND_TYPES, paneTabScopeType, dragMatchesScope, STANDALONE_SCOPE } from '../../lib/dndTypes';
import { dragLeftHost } from '../../lib/dragLeave';
import { EDGE_DROP_PX } from './constants';
import { useMobile } from '../../hooks/useMobile';
import type { ZoomScope } from './zoomScope';
import { paneZoomActions } from '../../state/paneZoom';
import { useLongPress } from '../../hooks/useLongPress';
import { SwapIce } from '../Shared/SwapIce';
import { pickSwapFreeze, useSwapFreezeViews } from '../../state/swapFreeze';
import { useTabNotifications } from '../../hooks/useTabNotifications';
import { useT } from '../../hooks/useT';
import { TabSlot, TabLabel, ProjectTabLead } from './TabSlot';
import { useSpawnedBrowserMap } from '../../state/browserSpawner';
import { TAB_SELECTED_SURFACE, TAB_SELECTED_SURFACE_SOFT, TAB_RESTING_SURFACE, ROW_PX, ROW_GAP, CARD_H, ROW_CARD, CHROME_ROW_ACTION_INSET, CHROME_ROW_ACTION_RESERVE, CHROME_ROW_ACTION_RESERVE_LEFT, TAB_GAP_CLASS, attentionSurface, TAB_LABEL } from '../../lib/selectionStyles';
import { ensurePaneUsageFresh, formatPaneUsageLine, subscribePaneUsage, getPaneUsageVersion } from '@/lib/paneUsage';
import { useTopics, useTerminalSessions } from '../../contexts/TopicsContext';
import {
  BrowserTabIcon, BrowserTabMenuButton, BrowserTabCornerMark, BrowserTabTakeControl,
} from '../Browser/BrowserTabChrome';
import { useBrowserKindNames } from '../Browser/browserKindNames';
import { TabSheet, TAB_SHEET_ANCHOR_ATTR } from '../Shared/TabSheet';
import { prefetchTabSheet } from '../Shared/tabSheetLazy';
import type { TabSheetActions } from '../Shared/tabSheetTypes';
import { openTabSheet } from '../../state/tabSheet';
import { getBrowserPaneChrome } from '../../state/browserPaneChrome';
import { browserTabLabel, browserTabSubtitle, NEW_TAB_LABEL } from '../../lib/browserTabLabel';
import { releaseNativeFocus } from '../../lib/shell/tauri';
import { DRAG_REGION, NO_DRAG_REGION } from '../../lib/shell/dragRegion';
import { prefersReducedMotion } from '../../lib/reducedMotion';

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

/**
 * Did this event start INSIDE the tab's own DOM, or did it only reach the tab
 * through React?
 *
 * React bubbles events along the COMPONENT tree, not the DOM tree, so anything
 * portalled from inside a tab arrives at the tab's handlers even though it is
 * drawn in `<body>`. A browser tab portals its whole sheet (`TabSheet`):
 * a double click on the address field zoomed the pane (or pinned a preview
 * tab), a right click opened the TAB's menu instead of the field's, selecting
 * text and dragging it started a TAB drag, and a long press armed the tab menu.
 * One guard on the tab side covers every handler, including the ones added
 * later; a list of `stopPropagation` on the sheet would always leave one out.
 * `onPointerDown` deliberately stays unguarded: taking AppKit's first
 * responder back to the chrome is exactly what typing in the sheet needs.
 */
function fromThisTab(e: React.SyntheticEvent): boolean {
  return (e.currentTarget as Node).contains(e.target as Node);
}

const ICONS: Record<string, React.FC<{ size: number; className?: string; style?: React.CSSProperties }>> = {
  MessageSquare, FolderTree, Globe, Terminal, GitBranch, Activity, BookOpen, Cpu, FileCode, BarChart3, Kanban, Clock, UserRound,
};

// Tab status lives in ONE slot at the end of the tab (`TabSlot`, TABSLOT-02):
// the same loader and NotificationBadge the sidebar draws, one at a time, so
// the label never moves when a state comes or goes.

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
   * Zoom the cell hosting `paneId`, or leave the zoom when it is already the
   * zoomed one (LAYOUT-34). `scope` is what the GESTURE asked for — 'cell' with
   * the modifier, 'derived' without — never the scope that ends up stored: the
   * degradation lives in `resolveEntryScope`, upstream, and nothing here
   * recomputes it.
   *
   * TWO obligations on the host, both from LAYOUT-40, because this bar cannot
   * enforce either one: while `isZoomed` is true EVERY trigger must REDUCE,
   * whatever `paneId` and `scope` it receives (re-anchoring on another tab
   * would be a third state nobody can read off the screen); and `canZoom` must
   * stay true while zoomed, or the way out dies with it.
   */
  onToggleZoom?: (paneId: string, scope: ZoomScope) => void;
  /**
   * The surface offers the zoom command. STRUCTURAL and surface-wide: "more
   * than one live cell", plus the 768px gate — the predicate lives with the
   * host that owns the cells (LAYOUT-34), not here.
   *
   * The one rule this bar adds is the only one that lives on a TAB: a draft is
   * never zoomable. A draft is opened permanent, so `preview` is false, and
   * without that rule it would fall into the zoom branch of the double click
   * while today the gesture only marks it as touched.
   */
  canZoom?: boolean;
  /** The zoom is open on THIS surface. While it is, the menu offers the single
   *  "Riduci" entry and every trigger reduces (LAYOUT-40). */
  isZoomed?: boolean;
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

export function PaneTabBar({ panes, activePaneId, onActivate, onClose, onCloseImmediate, onAddPane, availableTypes, groupType: _groupType, groupId, onNewChat, onReorderPanes, onCrossGroupDrop, onEdgeSplitDrop, dndScope, className, onContextRingClick: _onContextRingClick, onCloseOthers, onDetach, onReattach, onSplitRight, onSplitDown, onToggleZoom, canZoom, isZoomed, onResetLayout, canMoveToSpace, onRenameChat, onRenameBrowser, onSettings, onPopOut, onPopOutGroup, onStopStreaming, onPinPane, onToggleFissato, isFissato, projectPinKey, tabNotifications, hasLeftOverlay, hasLeadingBlock, groupIsFocused = true, groupIsAppFocused, addMenuScope = 'project', nonClosablePaneIds, linkContext, onOpenPaneInProject, subordinate = false }: PaneTabBarProps) {
  // Le voci del menu passano dal dizionario (`lib/i18n.ts`): sono fra le
  // stringhe più viste dell'app, ed erano gia' in italiano — quindi la
  // conversione non cambia una virgola di cio' che vedi in italiano, e in
  // inglese finalmente dice qualcosa.
  const tr = useT();
  /** The sessions Topics is holding stopped: one list for the whole bar. */
  const swapFreezes = useSwapFreezeViews();
  // Ridisegna quando arriva uno snapshot di consumo nuovo. Senza, il title
  // resterebbe fermo al valore del primo render e la fetch su hover non si
  // vedrebbe mai. `useSyncExternalStore` e non uno stato locale: lo snapshot
  // e' UNO per tutta l'app, e ogni tab bar deve leggere lo stesso.
  useSyncExternalStore(subscribePaneUsage, getPaneUsageVersion, getPaneUsageVersion);
  // A browser tab's kind in words (TABSLOT-03): its corner can be taken by the
  // console errors, and the kind it loses is still said by the tab's name and
  // tooltip. One subscription for the bar, re-rendering only on a kind change.
  const browserKindNames = useBrowserKindNames(panes.filter((p) => p.type === 'browser').map((p) => p.id));
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
  // tab can SAY it opened a browser in its accessible name. One subscription,
  // read per tab.
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
  // The attention state, read once here (not per-pane in the map below, which
  // would break the rules-of-hooks). Each pane derives its fill from it
  // synchronously in the loop: the same rows every other surface reads.
  const attention = useAttentionRows();
  // The bar arms no seen dwell of its own: the one dwell is the window's
  // focused pane (`useSeenFocusedPane`, App), whatever input focused it.
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
  // «Un comando compare dove ha effetto» (no splits under 768px) is applied
  // by the tab sheet, which reads the same gate (`TabSheetBody`).

  // Is the zoom command reachable from THIS tab?
  //
  // The structural half of the predicate — "more than one live cell", plus the
  // 768px gate — is resolved by the host and arrives in `canZoom` (LAYOUT-34).
  // Nothing is recomputed here: this adds the one rule that lives on a tab and
  // nowhere else, that a draft is not zoomable.
  //
  // `isZoomed` is in the OR for a case the spec writes down, not as padding.
  // A 'derived' zoom whose companion cell is closed stays OPEN, pruned to the
  // single surviving cell (LAYOUT-40): live cells are down to one, so `canZoom`
  // is false, and without the OR the double click and both menu entries would
  // go dead on a zoom that is still on screen — while LAYOUT-40 requires the
  // menu to offer "Riduci" the whole time the zoom is open. The tab sheet
  // applies the same predicate to its Layout level.
  const zoomAvailableFor = (paneId: string): boolean =>
    !!onToggleZoom && (isZoomed || !!canZoom) && !isDraftPaneId(paneId);

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

  // A RIGHT CLICK, A LONG PRESS AND SHIFT+F10 OPEN THE TAB'S SHEET, from the
  // commands door (TABSHEET-01): the same surface a click on an active browser
  // tab opens, grown out of the tab, and no dropdown of its own. A right click
  // on the tab whose sheet is open closes it: `TabSheet` sees that press first
  // and drops the request this handler makes (`state/tabSheet`).
  //
  // The long press is the shared primitive (hooks/useLongPress), ONE for the
  // whole bar because hooks cannot live inside `panes.map`: the pressed tab is
  // remembered apart, and the visual feedback is the intersection of the two.
  const [pressingPaneId, setPressingPaneId] = useState<string | null>(null);
  /** A press on a tab is under way: the focus it brings is not kept (see the tab's `onFocus`). */
  const pointerOnTab = useRef(false);
  /** The tab a press focused, to be let go of when the press ends. */
  const focusedByPress = useRef<HTMLElement | null>(null);
  // THE FOCUS A PRESS BROUGHT IS DROPPED WHEN THE PRESS ENDS, never while it is
  // under way: a blur inside the focus event of the mousedown cancels the drag
  // that press is starting, in WebKit and in Chromium alike (measured on this
  // branch: `focusin`, `focusout`, then no `dragstart` at all). Only when the
  // tab still holds it: a sheet opened by the same press has moved it already.
  const releasePressFocus = useCallback(() => {
    const tab = focusedByPress.current;
    focusedByPress.current = null;
    if (tab && document.activeElement === tab) tab.blur();
  }, []);
  const tabLongPress = useLongPress(({ element }) => {
    const paneId = element.dataset.paneId;
    if (paneId) openTabSheet(paneId, 'commands');
  }, { enabled: isTouch });

  const handleContextMenu = useCallback((paneId: string) => (e: React.MouseEvent) => {
    // The field inside a portalled sheet keeps its own menu (see `fromThisTab`).
    if (!fromThisTab(e)) return;
    e.preventDefault();
    e.stopPropagation();
    openTabSheet(paneId, 'commands');
  }, []);

  // What every tab's sheet acts with: the callbacks this bar already receives
  // from its host, nothing new (`TabSheetActions`).
  const sheetActions = useMemo<TabSheetActions>(() => ({
    panes, activePaneId, onActivate, onClose, onCloseImmediate, onCloseOthers, onSplitRight, onSplitDown,
    onToggleZoom, canZoom, isZoomed, onResetLayout, canMoveToSpace, onRenameChat, onRenameBrowser,
    onSettings, onPopOut, onPopOutGroup, onStopStreaming, onToggleFissato, isFissato, projectPinKey,
    nonClosablePaneIds, linkContext, onOpenPaneInProject, onDetach, onReattach,
  }), [
    panes, activePaneId, onActivate, onClose, onCloseImmediate, onCloseOthers, onSplitRight, onSplitDown,
    onToggleZoom, canZoom, isZoomed, onResetLayout, canMoveToSpace, onRenameChat, onRenameBrowser,
    onSettings, onPopOut, onPopOutGroup, onStopStreaming, onToggleFissato, isFissato, projectPinKey,
    nonClosablePaneIds, linkContext, onOpenPaneInProject, onDetach, onReattach,
  ]);

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
    // the sheet the tab opens under itself (`TabSheet`), so the tab
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
      // tab is read in the app's language, next to a new-tab page that already
      // says the same words in that language.
      return raw === NEW_TAB_LABEL ? tr('browser.newTab.title') : raw;
    }
    return (isUtilityPanelId(pane.id) ? config.label : pane.title)
      || (pane.type === 'chat' ? 'New Chat' : config.label);
  }, [tr]);

  const handleTabDragStart = useCallback((paneId: string) => (e: React.DragEvent) => {
    if (!onReorderPanes) return;
    // Text dragged out of a portalled sheet is not a tab drag (see `fromThisTab`).
    if (!fromThisTab(e)) return;
    // D8: any intent to REORGANISE leaves the zoom before it applies. A tab
    // drag has every one of its targets (`FullWidthRowZone`, `RowGapDropZone`,
    // `InsertDividers`) inside the collapsed area, so starting one with the
    // zoom open means dragging towards places that are not on screen.
    // `exitTop()` and not `exit(surfaceId)`: this bar is not told which surface
    // hosts it, and the store exposes that getter precisely for callers who
    // cannot name it. The `isZoomed` gate keeps the gesture at home, so a bar
    // that is not zoomed never closes somebody else's zoom.
    if (isZoomed) paneZoomActions.exitTop();
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
  }, [onReorderPanes, isZoomed, groupId, panes, dndScope, tabNotifications, etichettaTab]);

  const handleTabDragOver = useCallback((paneIdx: number) => (e: React.DragEvent) => {
    if (!fromThisTab(e)) return;
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
          if (!dragLeftHost(e.currentTarget, e)) return;
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
        // The attention TIER of the tab, from the server's attention state
        // (notifications-redesign): amber 'needs-you', red 'error', blue 'done',
        // only while the subject is LIT. A chat or a terminal seen by the
        // person (in any window) is not lit, so there is no "seen" gate here
        // any more: the state already says it. Codex and shell terminals get
        // a tier too when the server lights them (a hook-less finished turn).
        //
        // A PROJECT has no subject of its own: its tier is the rollup of its
        // lit children (`projectAttention`), and it keeps one local valve, as
        // before: the project tab you are looking at does not pulse a blue or
        // red at you (`attentionFillFor` with "selected"), while an amber
        // child is never hidden.
        const rawTier: AttentionTier | null =
          pane.type === 'chat'
            ? (pane.topicId ? litTierOf(attention, topicSubject(pane.topicId)) : null)
            : pane.type === 'terminal'
              ? (termSid ? litTierOf(attention, terminalSubject(termSid)) : null)
              : pane.type === 'project'
                ? (pane.projectPath ? projectAttention(attention, pane.projectPath, topics, terminalSessions).tier : null)
                : null;
        const attentionTier = pane.type === 'project' ? attentionFillFor(rawTier, isFullyActive) : rawTier;
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
        // Is this tab's session frozen? A tab has no room for a sentence: it
        // gets the snowflake and a thread of rime along its edge, and the card
        // and the pane carry the rest.
        const tabFreeze = pickSwapFreeze(swapFreezes, {
          topicId: pane.topicId ?? null,
          terminalId: pane.type === 'terminal' ? (pane.terminalSessionId ?? getTerminalSessionFromPaneId(pane.id)) : null,
        });
        // THE HOVER CARD SAYS BOTH THINGS, ALWAYS, in the shape every browser
        // uses: the page name on the first line, the WHOLE address on the
        // second. That second line is what tells three tabs called
        // "Vite + React" apart, and it costs the label nothing. And it is not
        // the system tooltip: `TooltipDelegate` intercepts `title` and redraws
        // it after 350 ms instead of the well over a second macOS takes.
        const browserKind = pane.type === 'browser' ? browserKindNames.get(pane.id) : undefined;
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
            return [name, address, browserKind].filter(Boolean).join('\n');
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
        const stateTab = rawTier === 'needs-you'
          ? tr('attention.state.needsYou')
          : rawTier === 'error'
            ? tr('attention.state.error')
            : rawTier === 'done'
              ? tr('attention.state.done')
              : null;
        // Per un PROGETTO lo stato non basta: il tier è un aggregato e il numero
        // pure, quindi «turno finito» non dice di CHI. Il nome accessibile porta
        // i figli per nome, come il tooltip del badge.
        const detailProject = pane.type === 'project' && pane.projectPath
          ? describeProjectBadge(pane.projectPath)
          : '';
        // What left the tab's face for the label's sake (TABSLOT-03) is still
        // said: the sidebar row shows it, and the tab's accessible name tells it.
        const pinKey = isFissato ? pinKeyForPane(pane) : null;
        const pinned = !!pinKey && !!isFissato?.(pinKey);
        const spawnerKey = pane.type === 'chat' ? pane.topicId : pane.type === 'terminal' ? pane.id : undefined;
        const spawnedBrowser = !!spawnerKey && !!spawnedBrowserMap[spawnerKey];
        const cloud = pane.type === 'chat' && !!pane.topicId && topics[pane.topicId]?.provider === 'openclaw';
        const isDragged = draggedPaneId === pane.id;
        const hasDragSource = draggedPaneId || crossGroupDragActive;
        const isNotSelf = !draggedPaneId || draggedPaneId !== pane.id;
        const showLeftIndicator = dragOverIdx === paneIdx && hasDragSource && isNotSelf;
        const showRightIndicator = paneIdx === panes.length - 1 && dragOverIdx === panes.length && hasDragSource && isNotSelf;
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
            // The pane in front of the person: active in a focused group of a
            // focused surface (`isFullyActive`), the one a click inside moves.
            data-focused={isFullyActive ? 'true' : undefined}
            role="tab"
            // Lo stato come ATTRIBUTO, non come classe: i locator dei test erano
            // agganciati alle classi Tailwind del badge, e rinominarne una li
            // faceva passare a verde-vuoto senza che nulla fosse rotto. Un
            // data-attribute è il vero appiglio.
            data-attention={rawTier ?? undefined}
            // The PAINTED tier, after the seen gate: what the blue/amber fill
            // shows. `data-attention` is the state; this is the mark.
            data-attention-fill={attentionTier ?? undefined}
            // Il nome accessibile porta lo stato, che prima non era detto da
            // nessuna parte (il colore non parla). `aria-label` e non `title`: un
            // title qui aprirebbe un tooltip sopra una tab il cui nome è già
            // scritto accanto, e duplicherebbe i title dei figli (spinner,
            // SessionActivity) che dicono la loro parte.
            aria-label={[
              label, tabFreeze && tr('swapFreeze.short'), stateTab,
              // The slot shows at most "99+": the exact count is said here.
              badgeCount > 0 && tr('tab.attentionCount', { n: String(badgeCount) }),
              detailProject,
              browserKind,
              pinned && tr('sidebar.pinned'),
              spawnedBrowser && tr('tab.openedBrowser'),
              cloud && tr('tab.cloudSession'),
            ].filter(Boolean).join(' · ')}
            // A browser tab has extra commands that cover the label's tail on
            // hover: the label fades under them (index.css, `.tab-extras`).
            data-tab-extras={pane.type === 'browser' ? '' : undefined}
            style={{ width: tabWidth, minWidth: tabWidth, maxWidth: tabWidth, flexShrink: 0 }}
            // overflow-hidden clips the command box, which is larger than the
            // slot it sits on, at the tab's own edge.
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
            onPointerDown={() => { pointerOnTab.current = true; releaseNativeFocus(); }}
            onPointerUp={() => { pointerOnTab.current = false; releasePressFocus(); }}
            // A finger the system took back. Not a mouse: a native drag starts
            // with a `pointercancel` too, and its focus waits for `dragend`.
            onPointerCancel={(e) => { if (e.pointerType !== 'touch') return; pointerOnTab.current = false; releasePressFocus(); }}
            // The sheet's body is a lazy chunk: warm it while the pointer is
            // on its way to the click, so the panel does not open empty.
            onPointerEnter={prefetchTabSheet}
            onFocus={(e) => {
              prefetchTabSheet();
              // A TAB TAKES THE FOCUS FROM THE KEYBOARD, NOT FROM THE POINTER.
              // It is focusable so Shift+F10 has a target and its sheet can give
              // the focus back; a click focusing it too would light the bar's
              // and the row's focus-within reveals (the «+», the X) and leave
              // them on. After a press the focus goes where it went before the
              // tab was focusable: nowhere in particular.
              if (e.target === e.currentTarget && pointerOnTab.current) {
                pointerOnTab.current = false;
                focusedByPress.current = e.currentTarget;
              }
            }}
            // The tab is the surface its sheet grows out of, and it takes the
            // focus (out of the Tab order) so Shift+F10 and the return of the
            // focus on close have somewhere to be.
            {...{ [TAB_SHEET_ANCHOR_ATTR]: '' }}
            tabIndex={-1}
            // No private clear here: the tab click only FOCUSES the pane, like a
            // click inside it, and the seen event of the focused pane clears its
            // marks on every surface (`useSeenFocusedPane`).
            onClick={() => { if (tabLongPress.consumeClick()) return; onActivate(pane.id); }}
            // Il doppio clic è il gesto con cui si dice «questa la tengo»: vale
            // anche per una chat nuova, che da quel momento non si richiude più
            // da sola (`state/draftPane.ts`). Vale ANCHE quando non c'è niente
            // da fissare: il gesto conta di per sé.
            // LAYERED, and the order is the requirement (LAYOUT-34): the
            // gesture pins first, and only on an already-pinned tab does it
            // zoom. The meaning above does not change, it scales.
            //
            // The first gate is `pane.preview` and NOT the presence of
            // `onPinPane`. That prop is optional and arrives undefined from
            // some hosts, so gating on it would send a preview tab into the
            // zoom branch depending on WHO mounted the bar. With `?.` the
            // preview branch absorbs the gesture and returns either way: with
            // no callback the double click on a preview stays the no-op it is
            // today.
            //
            // Holding the modifier asks for the anchor's cell ALONE
            // (LAYOUT-40). It names what the gesture asked for; which cells
            // that buys is `resolveEntryScope`'s answer, upstream.
            onDoubleClick={(e) => {
              if (!fromThisTab(e)) return;
              markDraftTouched(pane.id);
              if (pane.preview) { onPinPane?.(pane.id); return; }
              if (zoomAvailableFor(pane.id)) onToggleZoom?.(pane.id, e.altKey ? 'cell' : 'derived');
            }}
            onContextMenu={handleContextMenu(pane.id)}
            data-testid={`pane-tab-${pane.id}`}
            // Il feedback della pressione vale SOLO per la tab premuta: l'hook è
            // uno per tutta la barra (vedi `pressingPaneId`).
            data-pressing={(tabLongPress.pressed && pressingPaneId === pane.id) || undefined}
            {...tabLongPress.handlers}
            onTouchStart={(e) => { if (!fromThisTab(e)) return; setPressingPaneId(pane.id); tabLongPress.handlers.onTouchStart(e); }}
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
            // A drag ends without a `pointerup`: its focus is let go here.
            onDragEnd={(e) => { handleTabDragEnd(e); releasePressFocus(); }}
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
            {/* The tab's frost: rime along the edges, under every other child. */}
            <SwapIce freeze={tabFreeze} size="mini" />
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
            {/* ZONE 1, THE LEAD ICON (TABSLOT-01): fixed per type. Every
                branch wraps its glyph in a fixed box so labels line up across
                tabs, and so a mark that appears on its corner costs no width.
                Claude Code uses the authoritative `isClaudeCodeTab` so its tab
                never falls through to the generic Terminal glyph. */}
            {pane.type === 'file' && pane.title ? (
              <span className="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">{(() => { const d = getFileIconDef(pane.title); const I = d.icon; return <I size={14} style={{ color: d.color }} />; })()}</span>
            ) : pane.type === 'browser' ? (
              // The SITE's icon, the same one the address bar shows. Under the
              // pointer it becomes Reload (see BrowserTabIcon); the tab's kind
              // or its console errors are a mark on its corner.
              <span className="relative flex flex-shrink-0">
                <BrowserTabIcon paneId={pane.id} url={pane.url || getBrowserPaneUrl(pane.id) || ''} />
                <BrowserTabCornerMark paneId={pane.id} />
              </span>
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
              // Topic chats carry NO leading glyph, name only, and never fall
              // through to the generic MessageSquare below. The one mark a chat
              // tab can carry is the colour the person CHOSE for the topic
              // (TOPIC-02), the same dot as its sidebar row; a default colour
              // draws nothing.
              pane.topicId ? <TopicColorDot color={topics[pane.topicId]?.color} onFill={onFill} /> : null
            ) : pane.type === 'project' && pane.projectPath ? (
              // The real project favicon, or the project-type glyph when it
              // ships none, with the marker / org warning on its corner
              // (CHROME-14, TABSLOT-03).
              <ProjectTabLead path={pane.projectPath} onFill={onFill} />
            ) : Icon ? (
              <span className="flex items-center justify-center w-3.5 h-3.5 flex-shrink-0">
                <Icon size={14} />
              </span>
            ) : null}
            {/* ZONE 2, THE LABEL: the only zone that flexes, never under 56px.
                Usage and elapsed time ride in its tooltip (see TabLabel): the
                container uses `aria-label` and not `title` on purpose. */}
            <TabLabel
              className={`truncate flex-1 min-w-[56px] ${pane.preview ? 'italic' : ''} ${
                pane.type === 'browser' && isFullyActive ? 'cursor-text' : ''
              }`}
              sheetDoor={pane.type === 'browser'}
              subjectId={pane.type === 'chat' ? pane.topicId : termSid}
              projectPath={pane.type === 'project' && !isSelected ? pane.projectPath : undefined}
              // CLICK THE LABEL AND THE TAB SHEET DROPS DOWN
              // (`TabSheet`). Only on the tab you are already looking
              // at: the first click on another tab still means "bring me
              // there".
              onClick={pane.type === 'browser' && isFullyActive
                ? (e) => {
                  const edit = getBrowserPaneChrome(pane.id)?.commands.editAddress;
                  if (!edit) return;
                  e.stopPropagation();
                  edit();
                }
                : undefined}
              title={`${browserHover ?? label}${formatPaneUsageLine(
                pane.type === 'terminal' ? termSid : null,
                pane.type === 'terminal' || pane.type === 'browser',
                // A terminal is looked up by session, a browser pane by webview
                // label, a chat by its sessionKey (see `paneUsage.ts`).
                pane.type === 'browser' ? pane.id : null,
                pane.type === 'chat' ? sessionKeyForPaneId(pane.id, topics) : null,
              )}`}
            >{label}</TabLabel>
            <TabSheet
              sheetKey={pane.id}
              target={{ pane, label, surface: 'bar', focused: isFullyActive, actions: sheetActions }}
            />
            {/* The browser's extra commands, on hover only and OVER the label's
                tail (`.tab-extras`): take back control while an agent drives,
                and the dots, which open the sheet, downloads and console
                included. */}
            {pane.type === 'browser' && (
              <span className="tab-extras">
                <BrowserTabTakeControl paneId={pane.id} />
                <BrowserTabMenuButton paneId={pane.id} />
              </span>
            )}
            {/* ZONE 3, THE SLOT: one signal at rest, one command under the
                pointer (TABSLOT-02, CHROME-12). Also a PINNED tab closes: the
                pin is a shortcut that stays in Fissati, not a lock. */}
            <TabSlot
              paneId={pane.id}
              type={pane.type}
              label={label}
              topicId={pane.type === 'chat' ? pane.topicId : undefined}
              terminalSessionId={termSid}
              projectPath={pane.projectPath}
              boardProjectPath={pane.type === 'kanban'
                ? (pane.projectPath ?? (dndScope && dndScope !== STANDALONE_SCOPE ? dndScope : undefined))
                : undefined}
              selected={isSelected}
              freeze={tabFreeze}
              attention={badgeCount}
              attentionTitle={pane.type === 'project' && pane.projectPath ? describeProjectBadge(pane.projectPath) || undefined : undefined}
              onFill={onFill}
              closable={!nonClosablePaneIds?.has(pane.id)}
              onClose={onClose}
              onStop={pane.type === 'chat' && onStopStreaming ? () => onStopStreaming(pane.id) : undefined}
            />
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

    </div>
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

