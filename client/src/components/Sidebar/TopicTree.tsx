import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useT } from '../../hooks/useT';
import type { TerminalAgentType } from '../../../../shared/terminal-session-types';
import { ChevronRight, Archive, ArchiveRestore, TerminalSquare, Globe, FolderOpen, MoreHorizontal, X, CheckCheck, Pin, PinOff, LayoutGrid, Activity, BookOpen, Cpu, BarChart3, Clock, Kanban, Hourglass, BellOff, BellRing, type LucideIcon } from 'lucide-react';
import {
  usePendingActionStatus,
  useTerminalPendingStatus,
  useBrowserPendingStatus,
} from '../../contexts/PendingActionContext';
import { PendingActionRing } from '../Shared/PendingActionRing';
import { PendingActionProgressOverlay } from '../Shared/PendingActionProgressOverlay';
import { PaneAddMenu, PaneAddMenuItems } from '../Shared/PaneAddMenu';
import { TopicItem } from './TopicItem';
import { topicsApi } from '@/lib/api';
import { createPaneId, getTerminalSessionFromPaneId, pinKeyFromPaneId, resolvePinnedBrowserOrigin, useClosedTabs, type BrowserOrigin } from '@/state/pane/adapters';
import { PinnedTiles, type PinnedTileMeta } from './PinnedTiles';
import type { PinnedRow } from './pinnedLayout';
import { draggedPaneId, rememberDraggedPane } from '@/lib/dragPayload';
import { DND_TYPES } from '@/lib/dndTypes';
import type { Topic, UnreadData, PaneType, TerminalSessionInfo } from '@/types';
import { useTabNotifications } from '@/hooks/useTabNotifications';
import { ClaudeIcon } from '@/components/Shared/ClaudeIcon';
import { CodexIcon } from '@/components/Shared/CodexIcon';
import { ProjectFavicon } from '@/components/Shared/ProjectFavicon';
import { ProjectStreamingSpinner, TerminalStreamingSpinner, BrowserStreamingSpinner } from '@/components/Layout/StreamingIndicator';
import { SplitMiniMap } from '@/components/Shared/SplitMiniMap';
import { useSplitPosition } from '@/contexts/SplitPositionContext';
import { useAttentionSignals, signalsActions, useTerminalAttentionFill, useSeenDwell, attentionFillFor, useSignalsStore, projectAttentionTier, useSessionLastActivity } from '@/state/signals';
import { useProjectFocusStore } from '@/state/projectFocus';
import { usePaneStore } from '@/state/pane/store';
import { useShallow } from 'zustand/react/shallow';
import { useDetachedTopicMap } from '@/state/windowPresence';
import { POPOVER_ITEM } from '@/lib/popoverStyles';
import { loadSettings, saveSettings } from '@/lib/settings';
import { ContextMenuPortal } from '@/components/Shared/ContextMenuPortal';
import { tauriInvoke } from '@/lib/shell/tauri';
import { NotificationBadge } from '@/components/Shared/NotificationBadge';
import { sidebarRowCard, ROW_PX, ROW_INSET, SIDEBAR_INDENT_STEP, ON_FILL_TEXT, ON_FILL_TEXT_SOFT, SIDEBAR_HOVER } from '@/lib/selectionStyles';
import { spawnDragGhost } from '@/components/Layout/dragGhost';
import { useLongPress, openContextMenuAt } from '@/hooks/useLongPress';
import { SessionActivity } from '@/components/Shared/SessionActivity';
import { RelativeTime } from '@/components/Shared/RelativeTime';
import { DropdownPortal } from '@/components/Shared/DropdownPortal';
import { useMobile } from '@/hooks/useMobile';
import type { PinnedDropTarget, SidebarViewMode } from '@/hooks/useSidebarState';
import type { BoardTask, TaskStatus } from '@/lib/board';
import { BoardStatusCounts } from './BoardStatusCounts';
import { utilityPanelId } from '@/state/pane/adapters/utilityPanelId';
import { buildSidebarItems, filterSidebarItems, groupSidebarItemsByState, groupSidebarItemsBySpace, type SidebarItem, type SidebarStateBucket, type BrowserContextInfo } from '@/lib/buildSidebarItems';
import { SpaceGroupCard } from './SpaceGroups';
import { useSpaceCards } from './useSpaceCards';

/**
 * Le sezioni della vista per STATO, nell'ordine in cui si leggono.
 *
 * "Attende te" prima di tutto: è l'unica riga su cui devi muoverti tu. Poi "al
 * lavoro", che è informazione (sta andando, non toccare). Poi il resto.
 *
 * Le etichette dicono CHI deve muoversi, non il nome tecnico della fase: "attende
 * te" invece di "awaiting", "al lavoro" invece di "active". È la stessa distinzione
 * che i tier ambra/blu fanno col colore.
 */
const STATE_SECTIONS: readonly { key: SidebarStateBucket; icon: LucideIcon; label: string }[] = [
  { key: 'awaiting', icon: Hourglass, label: 'Attende te' },
  { key: 'working', icon: Activity, label: 'Al lavoro' },
  { key: 'rest', icon: MoreHorizontal, label: 'Il resto' },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Gruppi richiusi dall'utente (accordion). Device-local come tutto ciò che
 *  riguarda "cosa vedo io adesso": un altro dispositivo ha altri occhi. */
const COLLAPSED_GROUPS_KEY = 'topics-collapsed-groups';

function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedGroups(ids: Set<string>): void {
  try { localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...ids])); } catch { /* private mode */ }
}

// `relativeTime` locale rimosso: era la terza copia della stessa formattazione e,
// come le altre due, leggeva `Date.now()` dentro il render — quindi il numero si
// congelava al primo disegno della riga. Ora è il componente `RelativeTime`, che
// prende il tempo dal tick condiviso e si ri-renderizza da solo.

/** «2 da guardare: Lavori aperti · build» dai figli che il builder ha già
 *  calcolato. Gemello di `describeProjectAttention` (che parte dagli store, per
 *  la tab): qui la lista dei figli è già in mano, e ricalcolarla dagli store
 *  vorrebbe dire due walk che possono divergere. `undefined` quando non c'è
 *  niente da dire, così `title` non nasce vuoto. */
function describeChildAttention(children: SidebarItem[] | undefined): string | undefined {
  const ringing = (children ?? []).filter((c) => c.notificationCount > 0);
  if (!ringing.length) return undefined;
  const total = ringing.reduce((n, c) => n + c.notificationCount, 0);
  const shown = ringing.slice(0, 4).map((c) => c.name);
  const rest = ringing.length - shown.length;
  return `${total} da guardare: ${shown.join(' · ')}${rest > 0 ? ` · +altri ${rest}` : ''}`;
}

// Utility-row glyphs, keyed by the icon NAME the builder lifts from
// PANE_CONFIG — one lookup shared with the tab bar's config, no re-mapping
// per utility type at the call sites.
const UTILITY_ROW_ICONS: Record<string, LucideIcon> = {
  Kanban, BarChart3, Activity, BookOpen, Cpu, Clock, LayoutGrid,
};

/** La pane della Board generale. È anche la sua chiave di fissaggio: al
 *  contrario di `file`/`git`/`kanban` — che nascono con un uuid diverso a ogni
 *  apertura — questa stringa è la STESSA fra sessioni e fra device, che è
 *  esattamente ciò che rende la board fissabile. */
const BOARD_ID = utilityPanelId('board');
const BOARD_LABEL = 'Board';

/**
 * L'ALTEZZA DI UNA RIGA D'ALBERO, in un posto solo.
 *
 * 44 SOTTO i 768px perché è il minimo di bersaglio delle linee guida iOS; 34
 * sopra perché è la misura che regge la subline (nome + «cosa sta facendo»),
 * quella che la riga chat ha già.
 *
 * La soglia è la LARGHEZZA (`md:`), non il puntatore: su un iPad in orizzontale
 * — dito, ma 1024px — la riga è 34 e la card la ritaglia (`overflow-hidden` in
 * sidebarRowCard). Lì i 44px non ci sono, e nessun bersaglio dentro la riga può
 * prometterli: detto qui una volta, invece che promesso in ogni commento.
 *
 * Prima ce n'erano tre: `h-11 md:h-8` (44/32)
 * per progetto, sezione, terminale e browser, `h-8` FISSA per utility e board —
 * cioè 32px anche su iPhone, sotto soglia e 12px più basse delle vicine — e la
 * chat per conto suo. Tre numeri per la stessa riga si vedono solo mettendole
 * una sopra l'altra, che è come la sidebar si guarda sempre.
 */
const ROW_H = 'h-11 md:h-[34px]';

/** I fantasmi di trascinamento ancora attaccati al DOM. `spawnDragGhost` li
 *  aggiunge e li toglie da sé al frame dopo; il Set è il registro condiviso che
 *  la sua firma pretende, e vale da rete di sicurezza se una riga sparisce a
 *  metà trascinamento. */
const DRAG_GHOSTS = new Set<HTMLElement>();

/**
 * Una riga che, TENUTA PREMUTA, apre LO STESSO menu del tasto destro.
 *
 * Esiste come componente per due motivi che il solo hook non copre:
 *  · le righe dell'albero nascono dentro un `.map` (`renderProjectItem` non è un
 *    componente), e lì un hook non si può chiamare;
 *  · `pressed` deve essere di QUELLA riga: una sola istanza condivisa fra tutte
 *    le righe di progetto le farebbe rimpicciolire tutte insieme.
 *
 * Il clic-eco si mangia in CATTURA sul contenitore, non nei figli: l'`onClick`
 * di una riga di progetto sta sui bottoni dentro (chevron e nome), e fermare
 * l'evento prima che scenda è l'unico modo di coprirli tutti senza ripetere
 * `consumeClick()` in ognuno.
 */
function LongPressRow({
  isTouch,
  children,
  onClickCapture,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { isTouch: boolean }) {
  const lp = useLongPress(openContextMenuAt, { enabled: isTouch });
  return (
    <div
      {...rest}
      {...lp.handlers}
      data-pressing={lp.pressed || undefined}
      onClickCapture={(e) => {
        if (lp.consumeClick()) { e.stopPropagation(); e.preventDefault(); return; }
        onClickCapture?.(e);
      }}
    >
      {children}
    </div>
  );
}

// ── Props ──────────────────────────────────────────────────────────────────────

export interface TopicTreeProps {
  topics: Record<string, Topic>;
  workspaceProjects?: string[];
  searchQuery: string;
  expandedNodes: Set<string>;
  onToggleNode?: (id: string) => void;
  focusedTopicId: string | null;
  projectActiveTopics?: Record<string, string | null>;
  previewPanelId: string | null;
  openPanels: string[];
  onTopicClick: (topicId: string, e?: React.MouseEvent) => void;
  onTopicDoubleClick: (topicId: string, e?: React.MouseEvent) => void;
  onTopicContextMenu: (e: React.MouseEvent, topic: Topic) => void;
  unreadData: UnreadData;
  onArchiveTopic: (topicId: string, archive: boolean) => Promise<boolean>;
  onArchiveProject?: (projectPath: string, archive: boolean) => Promise<boolean>;
  onNewTopicInProject?: (projectPath: string) => void;
  onAddProjectPane?: (projectPath: string, type: PaneType, subType?: string) => void;
  onProjectClick?: (projectPath: string) => void;
  stopSession?: (sessionKey: string) => boolean;
  onNewChat?: () => void;
  onNewBrowser?: () => void;
  terminalSessions?: TerminalSessionInfo[];
  browserContexts?: BrowserContextInfo[];
  onTerminalClick?: (sessionId: string, sessionName: string) => void;
  onNewTerminal?: (type: TerminalAgentType, skipPermissions?: boolean) => void;
  onCloseTerminal?: (sessionId: string) => void;
  onOpenAsProject?: (path: string) => void;
  onOpenBrowser?: (contextId: string) => void;
  onCloseBrowser?: (contextId: string) => void;
  // New sidebar state
  viewMode: SidebarViewMode;
  showArchived: boolean;
  // Project accordion state (lifted to App to survive remounts)
  expandedProjects: string[];
  onToggleProject: React.Dispatch<React.SetStateAction<string[]>>;
  // Open pane IDs inside each project (from ProjectWindow callback)
  projectOpenPanes?: Record<string, string[]>;
  /** Pinned ("Fissati") item ids in USER PIN ORDER (useSidebarState.pinnedItems).
   *  The pinned block renders in this order, exempt from the notification-first
   *  sort. Chats pin by raw topic id, projects by `project:<rawPath>`. */
  pinnedItems?: string[];
  /** Pin/unpin an item ("Fissa" / "Rimuovi dai Fissati") — App-level wrapper
   *  owns the unpin-while-closed archive semantics. */
  onTogglePin?: (id: string) => void;
  /** La disposizione delle tessere fissate: righe di chiavi con le loro
   *  larghezze. Viaggia con i pin (stesso `sidebar-state`), quindi segue
   *  l'utente fra i device. Assente ⇒ derivata dall'ordine di pin. */
  pinnedLayout?: PinnedRow[];
  /** Nuova disposizione dopo un drag. */
  onPinnedLayoutChange?: (next: PinnedRow[]) => void;
  /** Fissa una cosa arrivata da fuori PIAZZANDOLA dove è stata lasciata cadere:
   *  una sola operazione, perché pin e disposizione riconciliano l'uno
   *  sull'altro e in due passi la cella si perde (vedi `pinAt`). */
  onPinAt?: (id: string, at: PinnedDropTarget) => void;
  /** Toglie il pin e BASTA. Distinto da `onTogglePin`, che per una chat con la
   *  tab chiusa la ARCHIVIA anche — semantica giusta per «non mi serve più»,
   *  sbagliata per «rimettila nella lista»: la riga sparirebbe proprio dal
   *  posto in cui l'hai appena trascinata. */
  onUnpinToList?: (id: string) => void;
  /** Active (non-done) task count across all projects. When > 0, a
   *  "Board generale" row is shown above the Fissati block. */
  boardTaskCount?: number;
  /** I task attivi raggruppati per stato — il contenuto della fascia quando la
   *  Board generale è fissata a tessera. */
  boardByStatus?: Record<TaskStatus, BoardTask[]>;
  /** True while the Board generale tab is open — makes the row tab-aware (it is
   *  the ONLY sidebar row for the board, so it must show selection like a tab). */
  boardOpen?: boolean;
  /** Opens the global board pane (the '__board__' utility tab). */
  onOpenBoard?: () => void;
  /** True quando esiste almeno un gruppo (o siamo in una finestra-gruppo): la
   *  sidebar diventa allora un elenco di CARD, una per gruppo, ognuna con le
   *  sue tab dentro. Con il solo gruppo implicito resta una lista sola, come è
   *  sempre stata (fissati + viste per tipo/stato). */
  spaceScoped?: boolean;
  /** In quale gruppo vive ciascuna pane aperta. Chi non è qui dentro non è la
   *  tab di nessun gruppo e finisce fuori dalle card. */
  paneSpaceById?: ReadonlyMap<string, string>;
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function TopicTree({
  topics,
  workspaceProjects = [],
  searchQuery,
  expandedNodes: _expandedNodes,
  onToggleNode: _onToggleNode,
  focusedTopicId,
  projectActiveTopics,
  previewPanelId,
  openPanels,
  onTopicClick,
  onTopicDoubleClick,
  onTopicContextMenu,
  unreadData,
  onArchiveTopic,
  onArchiveProject,
  onNewTopicInProject,
  onAddProjectPane,
  onProjectClick,
  stopSession,
  onNewChat: _onNewChat,
  onNewBrowser: _onNewBrowser,
  terminalSessions = [],
  browserContexts = [],
  onTerminalClick,
  onNewTerminal: _onNewTerminal,
  onCloseTerminal,
  onOpenAsProject,
  onOpenBrowser,
  onCloseBrowser,
  viewMode,
  showArchived,
  expandedProjects: expandedProjectsProp,
  onToggleProject,
  projectOpenPanes = {},
  pinnedItems = [],
  onTogglePin,
  pinnedLayout = [],
  onPinnedLayoutChange,
  onPinAt,
  onUnpinToList,
  boardTaskCount = 0,
  boardByStatus,
  boardOpen = false,
  onOpenBoard,
  spaceScoped = false,
  paneSpaceById,
}: TopicTreeProps) {
  const tr = useT();
  // Claude "yolo" toggle state lives inside <PaneAddMenu> now (via
  // useClaudeSkipPermissions in PaneAddMenuItems). No longer threaded
  // through here. The legacy `projectAddMenu` / `addBtnRef` state is
  // also gone — the canonical <PaneAddMenu> component owns its own
  // button ref and open/close state.
  const [projectContextMenu, setProjectContextMenu] = useState<{ x: number; y: number; projectPath: string; projectName: string; allArchived: boolean; unreadTopicIds: string[]; pinned: boolean; muted: boolean } | null>(null);
  /** Menu della tessera fissata di un terminale o di un browser: quei tipi non
   *  hanno un menu di riga proprio, e senza questo una volta fissati non si
   *  potrebbero più togliere dai Fissati da nessuna parte. */
  const [pinOnlyMenu, setPinOnlyMenu] = useState<{ x: number; y: number; id: string; name: string } | null>(null);
  const expandedProjects = useMemo(() => new Set(expandedProjectsProp), [expandedProjectsProp]);
  const { isTouch } = useMobile();
  // La riga della board: una sola in tutta la sidebar, quindi il gesto può
  // stare qui invece che dentro un componente suo. Il suo menu ha UNA voce —
  // «Aggiungi/Rimuovi dai Fissati» — e col solo tasto destro da telefono la
  // board, una volta fissata, non si sarebbe più potuta togliere.
  const boardPress = useLongPress(openContextMenuAt, { enabled: isTouch });
  // Awaiting-feedback sets, read once here so the (non-component) renderProjectItem
  // closure can derive a project's electric-blue rollup synchronously.
  const awaitingTopics = useSignalsStore((s) => s.awaitingFeedbackTopics);
  const awaitingTermIds = useSignalsStore((s) => s.claudePhaseAwaitingTermIds);
  // The LOUD 'input' tier subsets (amber) — the rest of the awaiting sets are the
  // calm 'done' tier (blue). Feed projectAttentionTier so a project row picks the
  // colour of its loudest child.
  const inputTopics = useSignalsStore((s) => s.awaitingInputTopics);
  const inputTermIds = useSignalsStore((s) => s.claudePhaseAwaitingInputTermIds);
  // I soggetti già guardati: il rollup di progetto li salta, così la riga del
  // progetto si spegne quando hai letto ciò che segnalava — e resta spenta, invece
  // di dipendere da «è selezionata adesso». Stessa regola della tab omonima.
  const seenSubjects = useSignalsStore((s) => s.seenSubjects);

  const toggleProject = useCallback((projectId: string) => {
    onToggleProject(prev => {
      const set = new Set(prev);
      if (set.has(projectId)) set.delete(projectId);
      else set.add(projectId);
      return Array.from(set);
    });
  }, [onToggleProject]);

  // ── Build unified items ──────────────────────────────────────────────────

  // `extraCounts` rides along with lastNotifiedAt: it is the badge source for
  // every pane that is neither a chat nor a terminal (agents panes,
  // session-viewer). The tab bar has always read it via getBadgeCount; the
  // sidebar hard-coded 0, which is how a badge could show on the tab and not on
  // the row for the very same pane.
  const { lastNotifiedAt, extraCounts } = useTabNotifications();
  // Attention signals — fed into buildSidebarItems so the sidebar badge counts
  // the same thing the tab bar does (Claude needs-you, finished terminal turns),
  // not just raw server unread.
  const { claudeAttentionTopics, terminalFinishedIds } = useAttentionSignals();
  // Real last-touched timestamp per claude-code terminal (idle/finished
  // sessions included — see deriveSessionLastActivity) so a terminal row sorts
  // and displays by actual Claude activity, not just when the session opened.
  const sessionLastActivityById = useSessionLastActivity();
  // Active inner pane per open project (reported by each ProjectWindow). Lets a
  // project's child row (chat/terminal) light up when that project is the
  // focused pane — focusedPanelId stays the project pane, so without this only
  // the folder would highlight. See state/projectFocus.ts.
  const activePaneByProject = useProjectFocusStore(s => s.activePaneByProject);
  const isActiveInnerChild = useCallback((projectPath: string | undefined, innerPaneId: string) => {
    if (!projectPath) return false;
    if (focusedTopicId !== createPaneId('project', projectPath)) return false;
    return activePaneByProject[projectPath] === innerPaneId;
  }, [focusedTopicId, activePaneByProject]);
  // Pinned ids as React state through props (NOT a localStorage read inside
  // the builder) so pin toggles repaint — pinnedIds joins the memo deps.
  const pinnedIds = useMemo(() => new Set(pinnedItems), [pinnedItems]);
  // Topics open in ANOTHER window (pop-out presence). A zustand hook = React
  // state, so this memo re-fires when a window detaches/closes.
  const detachedTopicIds = useDetachedTopicMap();
  // Live page titles of top-level browser panes, straight from the global pane
  // store. The server can't title native WKWebView panes, so this is the only
  // source that matches what the tab bar shows. `useShallow` over a titles-only
  // projection means a navigation/scroll that leaves the title set unchanged
  // does NOT repaint the (hot) sidebar tree — only an actual title change does.
  const browserPaneTitles = usePaneStore(useShallow((s) => {
    const m: Record<string, string> = {};
    for (const p of Object.values(s.panes)) {
      if (p.type === 'browser' && typeof p.title === 'string' && p.title.trim()) m[p.id] = p.title.trim();
    }
    return m;
  }));
  const paneTitleById = useMemo(() => new Map(Object.entries(browserPaneTitles)), [browserPaneTitles]);
  // Durable origin for pinned browsers whose tab is CLOSED — resolved from the
  // origin store ∪ closedStack so the row nests back under its project WITH its
  // title instead of leaking to the top-level Fissati block. Recomputes when a
  // pin toggles or a tab closes (closedTabs is a reactive closedStack view).
  const { closedTabs } = useClosedTabs();
  const browserOriginById = useMemo(() => {
    const m = new Map<string, BrowserOrigin>();
    for (const id of pinnedItems) {
      if (!id.startsWith('browser:')) continue;
      const o = resolvePinnedBrowserOrigin(id, closedTabs);
      if (o) m.set(id, o);
    }
    return m;
  }, [pinnedItems, closedTabs]);
  const allItems = useMemo(() => buildSidebarItems({
    topics,
    workspaceProjects,
    terminalSessions,
    browserContexts,
    unreadData,
    showArchived,
    openPanels,
    projectOpenPanes,
    lastNotifiedAt,
    claudeAttentionTopics,
    terminalFinishedIds,
    pinnedIds,
    extraCounts,
    detachedTopicIds,
    paneTitleById,
    browserOriginById,
    sessionLastActivityById,
  }), [topics, workspaceProjects, terminalSessions, browserContexts, unreadData, showArchived, openPanels, projectOpenPanes, lastNotifiedAt, claudeAttentionTopics, terminalFinishedIds, pinnedIds, extraCounts, detachedTopicIds, paneTitleById, browserOriginById, sessionLastActivityById]);

  // Union of every open pane id — top-level panes AND panes open inside any
  // project window. The sidebar used to check only the top-level `openPanels`,
  // so a terminal/browser opened *inside a project* never lit up as open in the
  // sidebar even though its tab was clearly mounted: the sidebar and the tab
  // bars disagreed. Folding in `projectOpenPanes` keeps the two in sync.
  const allOpenPaneIds = useMemo(() => {
    const s = new Set<string>(openPanels);
    for (const ids of Object.values(projectOpenPanes)) {
      for (const id of ids) s.add(id);
    }
    return s;
  }, [openPanels, projectOpenPanes]);

  const filteredItems = useMemo(
    () => filterSidebarItems(allItems, searchQuery),
    [allItems, searchQuery]
  );

  // Le card da disegnare (una per gruppo) e l'accordion. Chiuse per scelta
  // dell'utente, quindi si RICORDA: un gruppo richiuso che si riapre a ogni
  // ricarica è un gruppo che non si può chiudere.
  const spaceCards = useSpaceCards();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsedGroups);
  const toggleGroup = useCallback((id: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveCollapsedGroups(next);
      return next;
    });
  }, []);

  // ── Fissati partition (render-side; the builder's sort stays untouched) ──
  // The pinned block lists EVERY pinned item — top-level rows AND project
  // children — ordered by pin order (pinnedItems index), NOT the
  // notification-first activity sort. A pinned project child ALSO keeps its
  // nested row (Finder-favorites semantics: the pin is a shortcut, the item
  // still lives in its place); before this, a pinned chat inside a COLLAPSED
  // project was completely invisible, which defeated the point of pinning.
  // Search still applies: an item filtered out by the query drops from the
  // block too.
  /** La chiave della tessera trascinata FUORI dai fissati, mentre il cursore è
   *  sulla lista. È solo l'anteprima: lo sfissaggio avviene al drop. */
  const [unpinPreview, setUnpinPreview] = useState<string | null>(null);
  useEffect(() => {
    // Il gesto è finito, comunque sia finito: rilasciato, annullato con Escape,
    // uscito dalla finestra. `dragend` bolla fino a window in tutti e tre i
    // casi, ed è l'unico segnale che non oscilla mentre il cursore si muove.
    const fine = () => setUnpinPreview(null);
    window.addEventListener('dragend', fine);
    return () => window.removeEventListener('dragend', fine);
  }, []);

  const pinnedBlock = useMemo(() => {
    if (pinnedItems.length === 0) return [];
    const byId = new Map<string, SidebarItem>();
    for (const item of filteredItems) {
      if (item.pinned) byId.set(item.id, item);
      for (const child of item.children ?? []) {
        if (child.pinned) byId.set(child.id, child);
      }
    }
    // La Board generale, quando è fissata, è una tessera come le altre. La riga
    // la costruiamo QUI e non nel builder di proposito: il builder emette le
    // utility dalle tab aperte, e la board ha già una riga dedicata sua — da lì
    // nascerebbero due «Board generale» nel momento in cui apri la tab. Fissata
    // vive nella griglia, non fissata nella sua riga in cima: mai in due posti.
    if (pinnedItems.includes(BOARD_ID)) {
      const q = searchQuery.trim().toLowerCase();
      if (q === '' || BOARD_LABEL.toLowerCase().includes(q)) {
        byId.set(BOARD_ID, {
          id: BOARD_ID,
          type: 'utility',
          name: BOARD_LABEL,
          icon: 'LayoutGrid',
          lastActivity: 0,
          notificationCount: boardTaskCount,
          archived: false,
          pinned: true,
        });
      }
    }
    return pinnedItems.flatMap(id => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  }, [filteredItems, pinnedItems, boardTaskCount, searchQuery]);
  const unpinnedItems = useMemo(
    () => filteredItems.filter(i => !i.pinned),
    [filteredItems]
  );

  // ── Appartenenza al gruppo ───────────────────────────────────────────────
  // Con i gruppi accesi ogni riga va nella card del SUO gruppo, e chi non è la
  // tab di nessuno resta fuori dalle card (senza etichette: è semplicemente
  // roba che non sta in un gruppo). Senza gruppi non si smista niente: la
  // sidebar resta la lista unica di sempre.
  //
  // Si smistano gli UNpinned: i fissati stanno nel loro blocco in cima, sopra
  // ogni gruppo — è la ragione per cui li hai fissati — e disegnarli anche
  // dentro la card sarebbe la stessa riga due volte.
  const { bySpace, loose } = useMemo(() => {
    if (!spaceScoped) return { bySpace: new Map<string, SidebarItem[]>(), loose: [] as SidebarItem[] };
    return groupSidebarItemsBySpace(unpinnedItems, paneSpaceById ?? new Map<string, string>());
  }, [unpinnedItems, spaceScoped, paneSpaceById]);

  // Vista per STATO: attende te / al lavoro / il resto. I Set arrivano dallo
  // store dei segnali — la stessa fonte che dipinge i fill delle righe, quindi la
  // sezione in cui una riga finisce e il suo colore non possono divergere.
  // NB: il selettore restituisce solo RIFERIMENTI già nello store. Costruire qui
  // un `new Set([...])` darebbe un riferimento nuovo a ogni chiamata e `useShallow`
  // lo leggerebbe come "cambiato" per sempre — re-render a ciclo continuo. L'unione
  // si fa dopo, in un useMemo.
  const sigForState = useSignalsStore(
    useShallow((s) => ({
      awaitingTopics: s.awaitingFeedbackTopics,
      awaitingTermIds: s.claudePhaseAwaitingTermIds,
      live: s.liveStreamTopics,
      hydrated: s.hydratedStreamTopics,
      workingTermIds: s.claudePhaseActiveTermIds,
    })),
  );
  const stateGroups = useMemo(() => {
    if (viewMode !== 'state') return null;
    // "Al lavoro" per una chat è uno stream vivo O idratato; per un terminale è la
    // fase attiva. Unione, come in `useAgentActivityCounts`: un canale muto non
    // deve nascondere lavoro vero.
    return groupSidebarItemsByState(unpinnedItems, {
      awaitingTopics: sigForState.awaitingTopics,
      awaitingTermIds: sigForState.awaitingTermIds,
      workingTopics: new Set<string>([...sigForState.live, ...sigForState.hydrated]),
      workingTermIds: sigForState.workingTermIds,
    });
  }, [unpinnedItems, viewMode, sigForState]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleArchive = useCallback(async (topicId: string, archive: boolean) => {
    await onArchiveTopic(topicId, archive);
  }, [onArchiveTopic]);

  // ── Render: single sidebar item ──────────────────────────────────────────

  /**
   * `depth` è il LIVELLO di annidamento, e va passato: ogni riga lo traduce in
   * `ROW_INSET + depth * SIDEBAR_INDENT_STEP`, che è la stessa aritmetica dei
   * figli di un progetto nell'albero e dei sotto-agenti di un terminale. Chi
   * disegna righe dentro un contenitore proprio (la fascia di una tessera
   * fissata) DEVE dichiararlo, o quelle righe escono a filo del bordo mentre le
   * stesse righe altrove sono rientrate — la tabulazione che salta.
   */
  const renderItem = (item: SidebarItem, depth = 0) => {
    switch (item.type) {
      case 'project':
        return renderProjectItem(item);
      case 'chat':
        return renderChatItem(item, depth);
      case 'terminal':
        return renderTerminalItem(item, depth);
      case 'browser':
        return renderBrowserItem(item, depth);
      case 'utility':
        return renderUtilityItem(item);
    }
  };

  // ── Utility item (Board generale, Statistics, …) ─────────────────────────
  // Tab-driven row like every other type: shows while the `__<type>__` tab is
  // open, focuses it on click. Opening goes through the same global event the
  // "+" menus use (usePanelLifecycle listens and calls handleOpenAsPage, which
  // is an idempotent open-or-focus).
  const renderUtilityItem = (item: SidebarItem) => {
    const Icon = UTILITY_ROW_ICONS[item.icon] ?? LayoutGrid;
    const utilType = item.id.slice(2, -2);
    const isFocused = focusedTopicId === item.id;
    return (
      <button
        key={item.id}
        type="button"
        role="treeitem"
        aria-selected={isFocused}
        data-testid={`sidebar-utility-${utilType}`}
        onClick={() => window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: utilType } }))}
        // La card di ogni altra riga, CHIAMATA invece che ricopiata: era una
        // seconda scrittura a mano della stessa cosa (`px-1.5` contro ROW_PX,
        // `rounded-md` contro `rounded-lg`, `12px` che è ROW_INSET × 2 scritto in
        // cifre), quindi divergeva dal contratto a ogni ritocco della card vera.
        className={`flex items-center gap-1.5 ${ROW_PX} ${ROW_H} select-none ${
          sidebarRowCard({ focused: isFocused })
        }`}
        style={{ width: `calc(100% - ${ROW_INSET * 2}px)` }}
      >
        {/* Glifo NEUTRO, la stessa decisione già presa per la riga della board
            («il verde faceva sembrare la board un tipo a parte»): nella sidebar
            il colore dice uno STATO — attenzione, selezione — non un'identità.
            Questo `text-emerald-400` era l'ultimo verde rimasto, e su una riga
            accanto alla board ormai grigia leggeva come «questa è speciale». */}
        <Icon size={13} className="flex-shrink-0 text-app-text-secondary" />
        <span className="text-[12px] flex-1 text-left truncate">{item.name}</span>
        {/* Was missing entirely: the row rendered no badge at all, so an agents
            pane could light up its TAB (pinned by tab-notifications.spec.ts
            TAB-BADGE-10/11) and stay silent here. Suppressed while focused, the
            same rule the chat row uses. */}
        {!isFocused && <NotificationBadge count={item.notificationCount} />}
      </button>
    );
  };

  // ── Chat item ────────────────────────────────────────────────────────────

  // Sidebar click decision ladder, step (a): a topic detached in ANOTHER window
  // focuses that OS window rather than reopening here. On false (window died /
  // on another machine) fall through to the normal open/focus path — which
  // resolves the remaining space/active/closed steps (b–d) inside usePanelLifecycle.
  const handleChatRowClick = useCallback(
    (topicId: string, detachedWindowLabel: string | undefined, e?: React.MouseEvent) => {
      if (detachedWindowLabel) {
        void tauriInvoke<boolean>('window_focus_label', { label: detachedWindowLabel })
          .then((focused) => {
            if (!focused) onTopicClick(topicId, e);
          })
          .catch(() => onTopicClick(topicId, e));
        return;
      }
      onTopicClick(topicId, e);
    },
    [onTopicClick],
  );

  const renderChatItem = (item: SidebarItem, depth = 0) => {
    const topic = item.topic!;
    const isOpen = openPanels.includes(topic.id);
    // Focused directly, OR the active inner chat of the focused project.
    const isFocused = focusedTopicId === topic.id
      || isActiveInnerChild(topic.projectPath, createPaneId('chat', topic.id));
    // Sub-agents this chat spawned as an orchestrator (MCP spawn_agent) render
    // nested one level deeper — same pattern as a parent terminal's sub-agents.
    const subAgents = item.subAgents || [];

    const row = (
      <TopicItem
        key={item.id}
        topic={topic}
        depth={depth}
        hasChildren={false}
        isExpanded={false}
        isOpen={isOpen}
        isFocused={isFocused}
        isPreview={previewPanelId === topic.id}
        /* isStreaming is now read from StreamingContext inside TopicItem —
           no need to drill it through. */
        notificationCount={item.notificationCount}
        onToggle={() => {}}
        onClick={(e) => handleChatRowClick(topic.id, item.detachedWindowLabel, e)}
        onDoubleClick={(e) => onTopicDoubleClick(topic.id, e)}
        onContextMenu={(e) => onTopicContextMenu(e, topic)}
        onArchive={handleArchive}
        onStopStreaming={stopSession ? () => {
          const isFirst = stopSession(topic.sessionKey);
          // Route through the same deferred wrapper the row's Archive button
          // uses (not a raw onArchiveTopic call) so both paths share one
          // contract; surface a failed archive instead of dropping it silently.
          if (isFirst) handleArchive(topic.id, true).catch(() => {});
        } : undefined}
        isArchived={item.archived}
        pinned={!!item.pinned}
        detachedWindowLabel={item.detachedWindowLabel}
        /* Niente `onTogglePin`: la riga chat non ha più un menu suo dove
           metterlo — il «...» apre il menu del tasto destro, che il «Fissa» ce
           l'ha già (glielo passa App). Continuare a passarla la teneva viva
           come prop dichiarata e destrutturata a vuoto in TopicItem. */
        hideIcon={depth > 0}
      />
    );
    if (subAgents.length === 0) return row;
    return (
      <div key={item.id}>
        {row}
        {subAgents.map(child => renderTerminalItem(child, depth + 1))}
      </div>
    );
  };

  // ── Terminal item ────────────────────────────────────────────────────────

  const renderTerminalItem = (item: SidebarItem, depth = 0) => {
    const ts = item.terminal!;
    const paneId = `terminal:${ts.id}`;
    // Highlight ONLY the focused (current) terminal: either it's the App-focused
    // pane, OR it's the active inner pane of the focused project (terminals open
    // INSIDE a project, so focusedPanelId stays the project pane — without this
    // only the folder would light). A merely-open-elsewhere terminal gets the
    // subtle "open" styling.
    const isFocused = focusedTopicId === paneId || isActiveInnerChild(item.projectPath, paneId);
    const isOpen = allOpenPaneIds.has(paneId);
    const subAgents = item.subAgents || [];

    const row = (
      <TerminalSidebarItem
        key={item.id}
        session={ts}
        isFocused={isFocused}
        isOpen={isOpen}
        notificationCount={item.notificationCount}
        isTouch={isTouch}
        depth={depth}
        pinned={!!item.pinned}
        lastActivity={item.lastActivity}
        onTerminalClick={onTerminalClick}
        onCloseTerminal={onCloseTerminal}
        onOpenAsProject={onOpenAsProject}
        onTogglePin={onTogglePin ? () => onTogglePin(paneId) : undefined}
      />
    );
    if (subAgents.length === 0) return row;
    // Sub-agents (orchestrator-spawned) render nested one level deeper.
    return (
      <div key={item.id}>
        {row}
        {subAgents.map(child => renderTerminalItem(child, depth + 1))}
      </div>
    );
  };

  // ── Browser item ─────────────────────────────────────────────────────────

  const renderBrowserItem = (item: SidebarItem, depth = 0) => {
    const bc = item.browser!;
    const paneId = `browser:${bc.id}`;
    // Focused directly, OR the active inner browser of the focused project —
    // mirrors the chat/terminal rows. Behavior-preserving today (the builder
    // doesn't tag browser items with a projectPath, so isActiveInnerChild is a
    // no-op), correct once browsers can nest inside a project window.
    const isFocused = focusedTopicId === paneId || isActiveInnerChild(item.projectPath, paneId);
    const isOpen = !isFocused && allOpenPaneIds.has(paneId);
    return (
      <BrowserSidebarItem
        key={item.id}
        bc={bc}
        itemName={item.name}
        depth={depth}
        isFocused={isFocused}
        isOpen={isOpen}
        pinned={!!item.pinned}
        onOpenBrowser={onOpenBrowser}
        onCloseBrowser={onCloseBrowser}
        onTogglePin={onTogglePin ? () => onTogglePin(paneId) : undefined}
      />
    );
  };

  // ── Project item (accordion) ─────────────────────────────────────────────

  const renderProjectItem = (item: SidebarItem) => {
    const pp = item.projectPath!;
    const isExpanded = expandedProjects.has(item.id);
    const projectPaneId = createPaneId('project', pp);
    const isProjectFocused = focusedTopicId === projectPaneId;
    const isProjectOpen = openPanels.includes(projectPaneId);
    const allArchived = item.archived;
    const children = item.children || [];
    const allChats = children.filter(c => c.type === 'chat').map(c => c.topic!);
    // The folder is selected whenever its project is the focused pane — exactly
    // like the project's tab in the tab bar. Its active inner child also lights
    // (below): now that selection is a flat fill (no ring/shadow), folder + child
    // read as one clean nested-selection block, not overlapping rows.
    const folderFilled = isProjectFocused;
    // Attention TIER rolled up from the project's children (amber 'input' beats
    // blue 'done'). Fill only shows on an UNfocused folder (focus clears it), so
    // the name/badge must switch to the on-fill treatment then — otherwise the
    // hardcoded muted name colour + default blue badge render grey-on-fill /
    // blue-on-blue, the exact illegibility this redesign removes.
    const projTier = projectAttentionTier(pp, topics, terminalSessions, awaitingTopics, awaitingTermIds, inputTopics, inputTermIds, seenSubjects);
    const projOnFill = !isProjectFocused && projTier !== null;

    return (
      <div key={item.id}>
        {/* Project header */}
        <LongPressRow
          // Col dito il menu del progetto non esisteva: il tasto destro ne apre
          // quattro voci — «Segna tutto come letto», «Fissa», «Muta notifiche»,
          // «Archivia» — e da telefono se ne raggiungeva UNA. Tenere premuto apre
          // ORA lo stesso menu del mouse (evento `contextmenu` sintetizzato,
          // stesso `onContextMenu` qui sotto): un menu solo, per costruzione.
          isTouch={isTouch}
          // `pl-1 pr-2` (not the shared `px-2`): the accordion chevron is the
          // leading control, and a full 8px left pad + the chevron button's own
          // centring pushed it ~12px in from the card edge — too much dead space
          // before the arrow. Tighten the LEFT only; the RIGHT keeps `pr-2`
          // (= ROW_PX) so the trailing loader/badge stay column-aligned with the
          // child rows.
          className={`group/proj flex items-center ${ROW_H} pl-1 pr-2 select-none ${
            // "Ho guardato un progetto" vuol dire: ho guardato ciò che stava
            // segnalando — guardarne l'INTESTAZIONE non è aver letto le chat che ci
            // stanno dentro. Quel pezzo ora sta dentro `projectAttentionTier`, che
            // salta i figli già visti: letta la chat, la riga resta spenta anche
            // dopo aver selezionato altro (prima tornava blu, perché la fase Claude
            // resta `awaiting-user` fino al turno dopo). `folderFilled` resta come
            // valvola per i figli che nessuna soglia può raggiungere.
            sidebarRowCard({ focused: folderFilled, attention: attentionFillFor(projTier, folderFilled) })
          }`}
          data-pinned={item.pinned ? 'true' : undefined}
          // La riga di un progetto non è mai stata trascinabile: si potevano
          // trascinare chat, terminali e browser, non il progetto — quindi non
          // c'era modo di portarlo in un gruppo o sui fissati, e l'unica strada
          // era il menu contestuale. Porta la chiave della PANE, che per un
          // progetto è il path CODIFICATO: chi riceve apre o sposta una pane, e
          // con la chiave della riga il drop cadrebbe su una pane inesistente.
          // Su touch il drag nativo si spegne: il lift di HTML5 contende lo
          // stesso gesto del «tieni premuto», e chi vince è il caso.
          draggable={!isTouch}
          onDragStart={(e) => {
            e.dataTransfer.setData(DND_TYPES.PANEL_ID, createPaneId('project', pp));
            rememberDraggedPane(createPaneId('project', pp));
            e.dataTransfer.effectAllowed = 'move';
            // Il fantasma è quello CONDIVISO (`dragGhost.ts`), non una terza
            // copia: erano tre pillole scritte a mano con tre ombre e tre
            // padding diversi, e le tre superfici che trascinano mostravano tre
            // cose leggermente diverse per lo stesso gesto.
            spawnDragGhost(e, { text: item.name, size: 'md' }, DRAG_GHOSTS);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            const unreadTopicIds = allChats.filter(t => (unreadData[t.id]?.unreadCount || 0) > 0).map(t => t.id);
            const muted = (loadSettings().mutedProjects ?? []).includes(pp);
            setProjectContextMenu({ x: e.clientX, y: e.clientY, projectPath: pp, projectName: item.name, allArchived, unreadTopicIds, pinned: !!item.pinned, muted });
          }}
        >
          <ProjectRowPendingOverlay projectPath={pp} />
          {/* Chevron is its own control — toggles the accordion ONLY (expand /
              collapse), never moves focus. Separating it from the name button
              means clicking the row to focus a project can't accidentally
              collapse it. */}
          <button
            onClick={(e) => { e.stopPropagation(); toggleProject(item.id); }}
            className="flex items-center justify-center w-5 h-full flex-shrink-0 text-app-text-secondary hover:text-app-text transition-colors"
            aria-label={isExpanded ? `Collapse ${item.name}` : `Expand ${item.name}`}
            aria-expanded={isExpanded}
          >
            <ChevronRight size={12} className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`} />
          </button>
          {/* Name button:
              - not selected → FOCUS the project + EXPAND it (show children).
              - already selected → a repeat click TOGGLES the accordion, so
                clicking the current project again closes it (and re-opens it).
              The chevron always toggles regardless of selection. */}
          <button
            onClick={() => {
              if (isProjectFocused) {
                // Already the focused project — repeat click collapses/expands.
                toggleProject(item.id);
              } else {
                if (onProjectClick) onProjectClick(pp);
                if (!isExpanded) toggleProject(item.id);
              }
            }}
            className={`flex items-center gap-2 h-full flex-1 min-w-0 text-left text-[13px] font-medium transition-colors ${
              projOnFill ? `${ON_FILL_TEXT} font-semibold` : isProjectFocused ? 'text-app-text' : allArchived ? 'text-app-text-muted' : 'text-app-text-secondary hover:text-app-text'
            }`}
            title={pp}
            aria-label={`${item.name} project`}
            data-testid={`project-toggle-${item.name}`}
          >
            {/* Real project icon when the folder ships a favicon / web-manifest
                / index.html <link rel=icon> (resolved by /api/projects/icon).
                Folders without one render nothing — zero footprint, no fake
                glyph, no monogram (decisione Attilio 2026-07-16). */}
            <ProjectFavicon path={pp} size={14} className="mr-0.5" />
            <span className="truncate flex-1">{item.name}</span>
          </button>
          <div className="flex items-center flex-shrink-0">
            {/* Window-position mini-map: where THIS project's window sits in the
                tiled top-level split (PanelGrid publishes it keyed by project
                path). Only present when more than one window is open — a single
                window has nothing to orient against. Lives on the sidebar row
                only (user preference), never on the top tab bar. */}
            <ProjectSplitMiniMap projectPath={pp} onFill={projOnFill} />
            {/* Pin glyph — trailing rail, before the loader/badge (same fixed
                Pin → … → NotificationBadge order as the chat rows). Inherits
                the on-fill treatment on attention fills, never a hardcoded
                colour. */}
            {item.pinned && (
              <span
                className={`flex-shrink-0 flex items-center ml-0.5 ${projOnFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary'}`}
                title={tr('sidebar.pinned')}
                aria-label={tr('sidebar.pinned')}
              >
                <Pin size={12} />
              </span>
            )}
            {/* Project loading indicator — same component the project tab uses
                (PaneTabBar): a spinner while any child is producing output.
                "Needs you" (Claude awaiting, finished turns) is NOT a separate
                dot anymore — it rolls up into the notification badge below, so
                the sidebar row and the project tab show one consistent count.
                `ml-0.5` (NOT `mr-1.5`): the trailing margin pushed this loader
                6px in from the row edge, so the PROJECT row's spinner sat left of
                the CHILD (terminal/browser) rows' spinners, which are flush. With
                no right margin every sidebar loader lands at the same trailing
                offset — the row's loaders line up in one column. */}
            {/* Last-update timestamp — the SAME trailing "agg. X fa" the chat,
                terminal and browser rows all show (relativeTime of the row's real
                last activity). The project row was the ONLY sidebar row without it,
                so a project's last update wasn't visible at a glance. `item.lastActivity`
                is the project's aggregate (max over its children, per buildSidebarItems).
                Hidden on hover to free room for the action buttons, like the badge below. */}
            <RelativeTime
              at={item.lastActivity}
              className={`flex-shrink-0 text-[11px] tabular-nums group-hover/proj:hidden mr-1 ${projOnFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary'}`}
            />
            <ProjectStreamingSpinner projectPath={pp} className="ml-0.5" />
            {/* Numeric status indicators (git changed-files / ahead-behind /
                running processes / open-chat count) were removed from the
                sidebar project header — they read as cryptic numbers. Only the
                notification badge (unread / "needs you" attention) stays. Git
                and process status live where they're actionable (git/terminal
                panes + the project tab). */}
            {item.notificationCount > 0 && (
              <NotificationBadge
                count={item.notificationCount}
                className={`ml-0.5 ${isTouch ? '' : 'group-hover/proj:hidden'}`}
                variant={projOnFill ? 'onFill' : 'default'}
                // Il numero del progetto è una SOMMA sui figli, e il figlio che
                // lo produce può non avere una riga sott'occhio (accordion
                // chiuso) né una tab che lo mostri (quella selezionata non porta
                // badge, per contratto). Il tooltip dice di chi è il numero.
                // Stessa frase del tooltip sulla tab di progetto.
                title={describeChildAttention(item.children)}
              />
            )}
            {/* Action buttons on hover */}
            {!isTouch && (
              <>
                {onArchiveProject && (
                  <ProjectArchiveButton
                    projectPath={pp}
                    allArchived={allArchived}
                    onArchive={onArchiveProject}
                  />
                )}
                {(onNewTopicInProject || onAddProjectPane) && (
                  <div className="relative hidden group-hover/proj:flex">
                    {/* Same canonical add-pane affordance as the top tab
                        bar's "+" — single component, single rendering
                        contract. Trigger button visibility is the only
                        thing the parent customises (hover-revealed here,
                        always-visible in the tab bar). */}
                    <PaneAddMenu
                      scope="project"
                      onNewChat={onNewTopicInProject ? () => onNewTopicInProject(pp) : undefined}
                      onAddPane={onAddProjectPane ? (type, subType) => onAddProjectPane(pp, type, subType) : undefined}
                      triggerTitle="Add to project"
                    />
                  </div>
                )}
              </>
            )}
            {/* Touch: il «+» della riga. NON è il menu contestuale del progetto —
                quello, con «Segna tutto come letto», «Fissa» e «Muta notifiche»,
                si apre tenendo premuta la riga (vedi `LongPressRow` sopra) ed è
                lo stesso del tasto destro. Qui ci sono le voci che sul desktop
                stanno dietro il «+» che compare al passaggio del mouse, cioè
                quelle che su touch non avrebbero altra strada. */}
            {isTouch && (onNewTopicInProject || onAddProjectPane || onArchiveProject) && (
              <TouchProjectAddMenu
                pp={pp}
                allArchived={allArchived}
                onNewTopicInProject={onNewTopicInProject}
                onAddProjectPane={onAddProjectPane}
                onArchiveProject={onArchiveProject}
              />
            )}
          </div>
        </LongPressRow>

        {/* Accordion children */}
        {isExpanded && children.length > 0 && (
          <div>
            {children.map(child => {
              if (child.type === 'chat') return renderChatItem(child, 2);
              if (child.type === 'terminal') return renderTerminalItem(child, 2);
              if (child.type === 'browser') return renderBrowserItem(child, 2);
              return null;
            })}
          </div>
        )}

        {/* Pinned active topic when collapsed */}
        {!isExpanded && (() => {
          const activeTopicId = projectActiveTopics?.[pp];
          if (!activeTopicId || (!isProjectOpen && !isProjectFocused)) return null;
          const activeChild = children.find(c => c.id === activeTopicId);
          if (!activeChild || activeChild.type !== 'chat') return null;
          return renderChatItem(activeChild, 2);
        })()}
      </div>
    );
  };

  // ── Collapsible section for grouped view (mirrors old sidebar design) ────

  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  const toggleSection = useCallback((section: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }, []);

  // Generic collapsible section — shared by the per-type groups AND the
  // Fissati pseudo-section. 'pinned' is a SECTION KEY only, never a
  // SidebarItemType (pinning is orthogonal to type; groupSidebarItems and
  // filterSidebarItems must never see it).
  const renderSection = (sectionKey: string, Icon: LucideIcon, label: string, items: SidebarItem[]) => {
    const isCollapsed = collapsedSections.has(sectionKey);
    const totalUnread = items.reduce((sum, item) => sum + item.notificationCount, 0);

    // Niente `border-t`: la card grammar dichiara di TOGLIERE le linee
    // divisorie, e questa era l'ultima rimasta — a separare proprio la cosa
    // (la sezione) che già si distingue per la sua intestazione.
    return (
      <div key={sectionKey} className="flex-shrink-0">
        {/* L'intestazione è una CARD come ogni altra riga: rientrata di 6px
            (ROW_INSET, via `mx-1.5`), angoli tondi, hover rientrato con lei.
            Prima l'hover era full-bleed da bordo a bordo mentre ogni riga sotto
            ce l'ha rientrato, e il testo partiva da `paddingLeft: 12` inline —
            due px più a sinistra dei 6+8 delle righe con card, cioè un
            disallineamento troppo piccolo per vedersi e abbastanza grande per
            far sembrare storta la colonna. */}
        <div className={`group flex items-center ${ROW_H} ${ROW_PX} ${sidebarRowCard({})}`}>
          <button
            onClick={() => toggleSection(sectionKey)}
            aria-expanded={!isCollapsed}
            aria-label={`sezione ${label}`}
            className="flex items-center gap-2 flex-1 min-w-0 h-full text-left"
          >
            <Icon size={14} className="text-app-text-secondary flex-shrink-0" />
            <span className="text-[13px] text-app-text">{label}</span>
            {items.length > 0 && (
              <span className="text-[11px] text-app-text-tertiary">{items.length}</span>
            )}
            <ChevronRight
              size={12}
              aria-hidden="true"
              className={`transition-transform duration-150 text-app-text-tertiary ${!isCollapsed ? 'rotate-90' : ''}`}
            />
          </button>
          {/* Nessun `pr-1`: il padding di destra ora è quello della card
              (ROW_PX), lo stesso che allinea in colonna badge e spinner di
              tutte le righe sotto. */}
          <div className="flex items-center gap-1">
            <NotificationBadge count={totalUnread} />
          </div>
        </div>
        {/* Section content */}
        {!isCollapsed && (
          <div>
            {items.map(item => renderItem(item))}
          </div>
        )}
      </div>
    );
  };

  // ── Il blocco dei Fissati, in UN posto solo ──────────────────────────────
  //
  // Prima i quattro modi di vista ripetevano ognuno intestazione +
  // `pinnedBlock.map(renderItem)`, con l'etichetta scritta due volte via i18n e
  // due volte a mano dentro `renderSection`. Ora è una griglia di tessere senza
  // etichetta, la stessa ovunque: cambiare vista non cambia più cosa sono i
  // fissati, cambia solo cosa c'è sotto.

  /** Ciò che solo qui si può sapere: la selezione, e il tier rolled-up di un
   *  progetto (chat e terminali se lo risolvono da soli nella tessera). */
  const pinnedMetaFor = (item: SidebarItem): PinnedTileMeta => {
    if (item.type === 'project' && item.projectPath) {
      const pp = item.projectPath;
      const focused = focusedTopicId === createPaneId('project', pp);
      const tier = projectAttentionTier(pp, topics, terminalSessions, awaitingTopics, awaitingTermIds, inputTopics, inputTermIds, seenSubjects);
      return { focused, attention: attentionFillFor(tier, focused) };
    }
    return { focused: focusedTopicId === item.id, attention: null };
  };

  /** Cliccare un fissato ha sempre voluto dire «portami lì»: la fascia è un di
   *  più, non un sostituto. Quindi il click porta là sopra comunque, e per un
   *  progetto apre anche le sue tab qui sotto. */
  const activatePinned = (item: SidebarItem) => {
    switch (item.type) {
      case 'project':
        if (item.projectPath) onProjectClick?.(item.projectPath);
        break;
      case 'chat':
        onTopicClick(item.id);
        break;
      case 'terminal': {
        const sid = getTerminalSessionFromPaneId(item.id);
        if (sid) onTerminalClick?.(sid, item.name);
        break;
      }
      case 'browser':
        if (item.browser) onOpenBrowser?.(item.browser.id);
        break;
      case 'utility':
        // La board porta prima la finestra dov'è la sua tab (è `onOpenBoard` a
        // saperlo); le altre utility passano dal bus che usano i menu «+».
        if (item.id === BOARD_ID && onOpenBoard) onOpenBoard();
        else window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: item.id.slice(2, -2) } }));
        break;
    }
  };

  /**
   * La lista, con dentro l'anteprima di ciò che sta per essere sfissato.
   *
   * La posizione NON è dove hai lasciato il cursore: la lista è ordinata (prima
   * chi ti aspetta, poi per attività), quindi il posto è già deciso e mostrarlo
   * sotto il dito sarebbe una bugia. Lo si calcola con la stessa lista che ci
   * sarà dopo — `filteredItems` senza i fissati, ma con QUESTO dentro — e la
   * riga compare esattamente lì.
   */
  const withUnpinPreview = (list: SidebarItem[]): React.ReactNode[] => {
    const out = list.map(item => renderItem(item));
    if (!unpinPreview) return out;
    const tessera = pinnedBlock.find(i => i.id === unpinPreview);
    if (!tessera) return out;
    const dopo = filteredItems.filter(i => !i.pinned || i.id === unpinPreview);
    const at = dopo.findIndex(i => i.id === unpinPreview);
    out.splice(Math.max(0, Math.min(at === -1 ? out.length : at, out.length)), 0, (
      <div key="unpin-preview" data-testid="unpin-preview" className="opacity-60 pointer-events-none">
        {renderItem(tessera)}
      </div>
    ));
    return out;
  };

  const renderPinnedTiles = () => (
    <PinnedTiles
      items={pinnedBlock}
      layout={pinnedLayout}
      onLayoutChange={next => onPinnedLayoutChange?.(next)}
      metaFor={pinnedMetaFor}
      onToggleItem={activatePinned}
      // Fissare una cosa lasciata cadere qui dentro. `isPinned` fa da guardia:
      // `togglePin` è un interruttore, e su una cosa già fissata questo drop la
      // TOGLIEREBBE dai fissati — il contrario di quello che il gesto dice.
      // Con una cella sotto il cursore serve l'operazione ATOMICA: fissare e
      // piazzare in due passi si annullano a vicenda (vedi `pinAt`).
      onPinItem={(key, at) => {
        if (pinnedIds.has(key)) return;
        if (at) onPinAt?.(key, at);
        else onTogglePin?.(key);
      }}
      // Il «+» della tessera: la STESSA `PaneAddMenu` della riga del progetto,
      // con gli stessi callback. Solo per i progetti — sono l'unica cosa
      // fissabile che contiene tab: un «+» su una chat fissata non avrebbe
      // niente da creare dentro. Su touch niente, come per la riga: lì il menu
      // arriva dalla pressione lunga.
      renderActions={item => {
        if (item.type !== 'project' || !item.projectPath) return null;
        if (isTouch || (!onNewTopicInProject && !onAddProjectPane)) return null;
        const pp = item.projectPath;
        return (
          <PaneAddMenu
            scope="project"
            onNewChat={onNewTopicInProject ? () => onNewTopicInProject(pp) : undefined}
            onAddPane={onAddProjectPane ? (type, subType) => onAddProjectPane(pp, type, subType) : undefined}
            triggerTitle="Aggiungi al progetto"
          />
        );
      }}
      // Serve a disegnare l'anteprima con la cosa VERA, e quindi deve cercare
      // fra TUTTE le righe, non fra i fissati: quella in volo, per definizione,
      // fissata non è ancora. Anche fra i figli di un progetto e fra i suoi
      // sotto-agenti, che sono righe come le altre ma non stanno al livello
      // superiore. E la board, che una riga nell'albero non ce l'ha.
      resolveItem={key => {
        if (key === BOARD_ID) {
          return {
            id: BOARD_ID, type: 'utility', name: BOARD_LABEL, icon: 'LayoutGrid',
            lastActivity: 0, notificationCount: boardTaskCount, archived: false,
          };
        }
        const stack = [...filteredItems];
        while (stack.length > 0) {
          const item = stack.pop()!;
          if (item.id === key) return item;
          if (item.children) stack.push(...item.children);
          if (item.subAgents) stack.push(...item.subAgents);
        }
        return null;
      }}
      // Il menu contestuale della tessera è quello della RIGA, per ogni tipo.
      // Dimenticarne uno vuol dire che quella cosa, una volta fissata, non si
      // può più togliere dai Fissati: la riga con «Rimuovi dai Fissati» non
      // esiste più, e la tessera sarebbe l'unico posto da cui farlo.
      onContextMenu={(item, e) => {
        if (item.type === 'project' && item.projectPath) {
          e.preventDefault();
          const pp = item.projectPath;
          const unreadTopicIds = (item.children ?? [])
            .filter(c => c.type === 'chat' && (unreadData[c.id]?.unreadCount || 0) > 0)
            .map(c => c.id);
          const muted = (loadSettings().mutedProjects ?? []).includes(pp);
          setProjectContextMenu({
            x: e.clientX, y: e.clientY, projectPath: pp, projectName: item.name,
            allArchived: item.archived, unreadTopicIds, pinned: true, muted,
          });
          return;
        }
        if (item.type === 'chat' && item.topic) {
          onTopicContextMenu(e, item.topic);
          return;
        }
        if (item.type === 'terminal' || item.type === 'browser' || item.type === 'utility') {
          // Terminali, browser e utility non hanno un menu di riga proprio: il
          // loro «Rimuovi dai Fissati» sta qui, ed è l'unica voce che serve
          // perché una tessera fissata torni una riga come le altre. Senza
          // questo, fissare la board sarebbe a senso unico.
          e.preventDefault();
          setPinOnlyMenu({ x: e.clientX, y: e.clientY, id: item.id, name: item.name });
        }
      }}
      // La fascia porta le TAB del progetto — chat, terminali, browser — con lo
      // stesso `renderItem` delle righe dell'albero: nessun renderer nuovo,
      // quindi nessun modo di divergere da come quelle righe si comportano.
      renderExpanded={item => {
        // La board non ha «tab figlie», e i suoi task NON si aprono qui sotto:
        // il riassunto per stato sta sulla riga, dove si legge senza gesti, e
        // la lista dei titoli sta nella board. Due liste degli stessi task in
        // due superfici possono dire cose diverse; una sola non può.
        // `null` ⇒ la tessera non si espande e il click porta alla board.
        if (item.id === BOARD_ID) return null;
        if (item.type !== 'project') return null;
        const children = item.children ?? [];
        // Zero tab aperte ⇒ NIENTE fascia, e quindi niente chevron sulla
        // tessera: una riga che dice «non c'è niente» è una riga in più per
        // dire un vuoto che si vedeva già dal fatto che non si apre nulla.
        //
        // Il prezzo è dichiarato: il segno «si apre» compare e sparisce col
        // primo e l'ultimo tab di quel progetto. È il compromesso scelto
        // (Attilio, 06/08) fra un'affordance sempre presente e una fascia che a
        // volte si apre sul vuoto.
        if (children.length === 0) return null;
        // Depth 1, non 0: dentro la fascia il progetto È il contenitore, e le
        // sue tab stanno un livello dentro — lo stesso passo che hanno
        // nell'albero e sotto un terminale orchestratore.
        return <div className="py-1">{children.map(child => renderItem(child, 1))}</div>;
      }}
    />
  );

  // ── Render ───────────────────────────────────────────────────────────────

  // La riga della board, disegnata una volta e piazzata dove appartiene: dentro
  // la card del suo gruppo se la sua tab è aperta, in cima se non lo è.
  // Fissata, la board NON ha una riga: vive come tessera nella griglia (vedi
  // `pinnedBlock`). La stessa cosa in due posti non è una scorciatoia, è un
  // doppione — la regola che vale già per le righe dentro le card dei gruppi.
  const boardRow = onOpenBoard && !pinnedIds.has(BOARD_ID) && (boardTaskCount > 0 || boardOpen) ? (
          <button
            key="board-row"
            type="button"
            onClick={() => { if (boardPress.consumeClick()) return; onOpenBoard(); }}
            data-testid="sidebar-board-generale"
            aria-selected={boardOpen}
            {...boardPress.handlers}
            data-pressing={boardPress.pressed || undefined}
            // Trascinabile come ogni altra riga, e porta il PANEL_ID della sua
            // pane: è così che la si fissa (lasciandola sui Fissati) e che la si
            // porta in un gruppo, senza passare da un menu. Su touch no: il lift
            // nativo di HTML5 contende il «tieni premuto».
            draggable={!isTouch}
            onDragStart={e => {
              e.dataTransfer.setData(DND_TYPES.PANEL_ID, BOARD_ID);
              rememberDraggedPane(BOARD_ID);
              e.dataTransfer.effectAllowed = 'copyMove';
            }}
            onContextMenu={e => {
              e.preventDefault();
              setPinOnlyMenu({ x: e.clientX, y: e.clientY, id: BOARD_ID, name: BOARD_LABEL });
            }}
            // La stessa card di ogni altra riga, e adesso CHIAMANDOLA: il
            // commento diceva già «la stessa card», ma le classi erano una copia
            // scritta a mano (`px-1.5` contro ROW_PX, `rounded-md` contro
            // `rounded-lg`), quindi la copia e l'originale potevano divergere —
            // e lo facevano.
            //
            // `marginBottom: 0` sovrascrive il `my-px` della card, e non è un
            // capriccio: lo spazio SOTTO appartiene a ciò che segue — il blocco
            // dei fissati porta i suoi 6px (TILE_GAP) — e sommare i due margini
            // fa 7px dove il ritmo ne vuole 6 (lo blocca `sidebar-pinned-tiles`
            // TILE-14).
            className={`flex items-center gap-1.5 ${ROW_PX} ${ROW_H} select-none ${
              sidebarRowCard({ focused: boardOpen })
            }`}
            style={{ width: `calc(100% - ${ROW_INSET * 2}px)`, marginBottom: 0 }}
          >
            {/* Glifo neutro come ogni altra riga: il verde faceva sembrare la
                board un tipo a parte, e nella sidebar il colore è riservato a
                uno STATO (attenzione, selezione), non a un'identità. Qui sotto
                il colore torna, ma per dire proprio uno stato: la colonna. */}
            <LayoutGrid size={13} className="flex-shrink-0 text-app-text-secondary" />
            <span className="text-[12px] font-medium flex-1 min-w-0 text-left truncate">{BOARD_LABEL}</span>
            {/* Quanti, e in quale colonna — sulla riga, senza aprire niente.
                Sostituisce sia il badge col totale (un numero solo non dice se
                stai aspettando tu o un agente) sia la fascia che si apriva. */}
            <BoardStatusCounts byStatus={boardByStatus} />
          </button>
  ) : null;

  return (
    <div role="tree" aria-label={tr('sidebar.tree')} className="flex flex-col h-full min-h-0">
      {/* paddingBlock (ROW_INSET − 1) + each card's my-px (1px) = ROW_INSET
          above the first row and below the last — the SAME 6px the cards keep
          laterally (mx-1.5) and the tab bar keeps around its tabs, so the
          sidebar's padding reads identical on every axis. */}
      <div
        className="flex-1 min-h-0 overflow-y-auto sidebar-scroll"
        style={{ paddingBlock: ROW_INSET - 1 }}
        // IL GESTO INVERSO: una tessera lasciata sulla LISTA torna una riga.
        //
        // Sta qui, sul contenitore che scorre, e non su ogni vista: le viste
        // sono tre (lista, per stato, a gruppi) e tre bersagli scritti a mano
        // divergono al primo che se ne aggiunge una quarta. Chi cade DENTRO il
        // blocco dei fissati non conta — lì il drop è un riordino, e servirlo
        // due volte vorrebbe dire riordinare e sfissare nello stesso gesto.
        onDragOver={e => {
          if (!(onUnpinToList ?? onTogglePin) || !e.dataTransfer.types.includes(DND_TYPES.PINNED_TILE)) return;
          // Sopra i fissati l'anteprima si SPEGNE, e lo decide questo stesso
          // evento: `dragover` è l'unico che arriva a ogni movimento e sa dove
          // sei davvero. Spegnerla su `dragleave` era la causa del tremolio —
          // vedi sotto.
          if ((e.target as Element | null)?.closest?.('[data-testid="sidebar-pinned-section"]')) {
            if (unpinPreview) setUnpinPreview(null);
            return;
          }
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const key = draggedPaneId();
          const riga = key ? pinKeyFromPaneId(key) : null;
          if (riga && riga !== unpinPreview) setUnpinPreview(riga);
        }}
        // NESSUN `onDragLeave` qui, ed è il punto.
        //
        // Il tremolio: inserire la riga d'anteprima allunga la lista, quindi
        // sotto il cursore finisce un altro elemento e parte un `dragleave`.
        // Con `relatedTarget` valido la guardia lo assorbiva, ma quel campo è
        // `null` ogni volta che si passa sopra a un elemento che il browser non
        // riporta — e allora l'anteprima spariva, la lista si accorciava, il
        // cursore tornava dov'era, `dragenter`, anteprima di nuovo: un ciclo a
        // ~60 colpi al secondo, che è esattamente lo «scatto».
        //
        // Lo spegnimento vive dove non può oscillare: `dragover` quando sei
        // sopra i fissati (qui sopra), `drop`, e il `dragend` globale — che il
        // browser emette SEMPRE, anche su Escape o su un drop fuori finestra.
        onDrop={e => {
          const wasPreviewing = unpinPreview;
          setUnpinPreview(null);
          if (!(onUnpinToList ?? onTogglePin) || !e.dataTransfer.types.includes(DND_TYPES.PINNED_TILE)) return;
          if ((e.target as Element | null)?.closest?.('[data-testid="sidebar-pinned-section"]')) return;
          e.preventDefault();
          const key = e.dataTransfer.getData(DND_TYPES.PINNED_TILE) || wasPreviewing;
          // `onUnpinToList`, non `onTogglePin`: quest'ultimo archivia una chat
          // con la tab chiusa, e qui vuol dire farla sparire dalla lista un
          // istante dopo averla trascinata dentro — e senza più modo di
          // riprenderla. Il ripiego resta per chi non passa la prop nuova.
          const sfissa = onUnpinToList ?? onTogglePin;
          if (key && sfissa && pinnedIds.has(key)) sfissa(key);
        }}
      >
        {/* Board generale — THE single sidebar row for the board, above the
            Fissati block. Shown when there is active (non-done) work across all
            projects OR while its tab is open, so an open board is never without
            a sidebar presence (the guarantee the generic utility row used to
            provide before it was suppressed as a duplicate — see
            buildSidebarItems §5b). Being the only row, it is tab-aware:
            aria-selected + a selected surface while open, exactly like the tab
            rows below. Position is fixed at the top either way, so opening the
            board never makes its row jump.

            Sta FERMA qui, sopra i fissati e sopra ogni gruppo, anche quando la
            sua tab vive dentro un gruppo: la board generale è di tutti i
            progetti, non di un gruppo, ed è il primo posto dove si guarda. Se
            la sua tab sta altrove, cliccarla porta prima la finestra là (vedi
            `onOpenBoard` in App). */}
        {boardRow}

        {spaceScoped ? (
          /* I GRUPPI, tutti insieme: ognuno è una card che tiene in mano le sue
             tab e si apre e si chiude per conto suo, come i progetti. Non si
             alternano — vedere cosa c'è nell'altro non costa lasciare questo.

             Dentro una card le righe stanno PIATTE, nell'ordine del builder
             (notifiche prima, poi attività): le viste per tipo e per stato
             restano al ramo senza gruppi. Sezionare due o tre righe per volta,
             card per card, moltiplicherebbe le intestazioni fino a coprire il
             contenuto — e il raggruppamento, qui, lo fa già il gruppo. */
          <>
            {/* I FISSATI stanno sopra ogni gruppo: è esattamente ciò che hai
                chiesto fissandoli — "questo lo voglio sempre a portata", quindi
                sopra anche al gruppo in cui vive. La riga sta qui e non anche
                dentro la sua card: la stessa riga due volte non è una
                scorciatoia, è un doppione. */}
            {pinnedBlock.length > 0 && (
              <>
                {renderPinnedTiles()}
                {/* Il filo rientra come TUTTO il resto della sidebar: 6px
                    (ROW_INSET), gli stessi delle card dei gruppi sotto e delle
                    tessere sopra. A 12px era l'unico elemento su una colonna
                    sua, e il blocco dei fissati sembrava debordare.
                    Anche il respiro è quel numero, sopra e sotto (`my-1.5`): è
                    lo stesso passo che separa la riga della board dalle tessere
                    e le righe di tessere fra loro, così i quattro spazi che
                    l'occhio legge in fila sono davvero uno. */}
                <div data-testid="pinned-divider" className="h-px bg-app-border mx-1.5 my-1.5" />
              </>
            )}
            <div data-testid="sidebar-groups">
            {spaceCards.map(card => {
              const rows = bySpace.get(card.id) ?? [];
              return (
                <SpaceGroupCard
                  key={card.id}
                  card={card}
                  expanded={!collapsedGroups.has(card.id)}
                  onToggle={() => toggleGroup(card.id)}
                >
                  {rows.map(item => renderItem(item))}
                  {rows.length === 0 && (
                    <div className="px-3 py-1 text-[11px] text-app-text-muted">Nessuna tab</div>
                  )}
                </SpaceGroupCard>
              );
            })}
            </div>
          </>
        ) : viewMode === 'timeline' ? (
          // Timeline: the Fissati block first (user pin order), then the flat
          // list sorted by activity. Pinned rows keep badges/attention fills —
          // they just don't jump position with the notification-first sort.
          <>
            {pinnedBlock.length > 0 && (
              <>
                {renderPinnedTiles()}
                {/* Hairline divider between the pinned block and the timeline
                    (same grammar as POPOVER_DIVIDER). */}
                {unpinnedItems.length > 0 && <div data-testid="pinned-divider" className="h-px bg-app-border mx-1.5 my-1.5" />}
              </>
            )}
            {withUnpinPreview(unpinnedItems)}
          </>
        ) : null}
        {/* Vista per STATO: le stesse sezioni collassabili, ma i bucket sono
            "di cosa devo occuparmi" invece del tipo di pane. L'ordine è la
            priorità di lettura: chi aspetta una tua risposta in cima, poi chi sta
            lavorando, poi il resto. Una sezione vuota non si disegna. */}
        {!spaceScoped && viewMode === 'state' && stateGroups && (
          <>
            {pinnedBlock.length > 0 && (
              <>
                {renderPinnedTiles()}
                {/* Stesso filo della vista a lista: i fissati si staccano da ciò
                    che c'è sotto allo stesso modo in ogni vista. */}
                {unpinnedItems.length > 0 && <div data-testid="pinned-divider" className="h-px bg-app-border mx-1.5 my-1.5" />}
              </>
            )}
            {/* «Il resto» ha senso solo come CONTRASTO: dice «tutto ciò che non
                aspetta te e non sta lavorando». Quando è l'unico bucket pieno
                non contrappone niente — è la lista, e intitolarla «Il resto»
                fa sembrare che ci sia dell'altro fuori. Succede di continuo:
                basta sciogliere i gruppi e ricadere in questa vista con nulla
                di attivo, e ti compare un'intestazione che sembra un gruppo.
                Zero chrome quando non c'è niente da distinguere, come per il
                gruppo unico. */}
            {(() => {
              const soloIlResto =
                stateGroups.awaiting.length === 0 && stateGroups.working.length === 0;
              if (soloIlResto) {
                return (
                  <div data-testid="sidebar-state-section-rest">
                    {withUnpinPreview(stateGroups.rest)}
                  </div>
                );
              }
              return STATE_SECTIONS.map(({ key, icon, label }) => {
                const items = stateGroups[key];
                if (items.length === 0) return null;
                return (
                  <div key={key} data-testid={`sidebar-state-section-${key}`}>
                    {renderSection(`state:${key}`, icon, `${label} (${items.length})`, items)}
                  </div>
                );
              });
            })()}
          </>
        )}

        {/* Ciò che non sta in nessun gruppo: nessuna etichetta, perché non è
            una categoria — è semplicemente roba che non è la tab di nessuno
            (un non letto, un "attende te", un fissato a tab chiusa). Aprirne
            una la fa entrare nel gruppo attivo, e da lì in poi vive lì. */}
        {spaceScoped && loose.length > 0 && (
          <div data-testid="sidebar-loose" className="mt-1">
            {withUnpinPreview(loose)}
          </div>
        )}

        {filteredItems.length === 0 && (
          <div className="px-4 py-8 text-center text-[12px] text-app-text-muted">
            {searchQuery ? 'No results' : 'No active items'}
          </div>
        )}
      </div>

      {/* Righe e tessere senza un menu proprio (terminale, browser, board): una
          voce sola, quella che porta dentro o fuori dai Fissati. Il verso lo
          decide lo stato attuale — la stessa voce fissa una riga e sfissa una
          tessera, e leggere «Rimuovi» su una cosa non fissata sarebbe una
          bugia. */}
      {pinOnlyMenu && (
        <ContextMenuPortal
          open
          x={pinOnlyMenu.x}
          y={pinOnlyMenu.y}
          onClose={() => setPinOnlyMenu(null)}
          minWidth={160}
        >
          {onTogglePin && (() => {
            const isPinned = pinnedIds.has(pinOnlyMenu.id);
            return (
              <button
                onClick={() => {
                  onTogglePin(pinOnlyMenu.id);
                  setPinOnlyMenu(null);
                }}
                className={POPOVER_ITEM}
                data-testid="pin-toggle-item"
              >
                {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
                <span>{isPinned ? 'Rimuovi dai Fissati' : 'Aggiungi ai Fissati'}</span>
              </button>
            );
          })()}
        </ContextMenuPortal>
      )}

      {/* Project context menu */}
      {projectContextMenu && (
        <ContextMenuPortal
          open
          x={projectContextMenu.x}
          y={projectContextMenu.y}
          onClose={() => setProjectContextMenu(null)}
          minWidth={160}
        >
          {projectContextMenu.unreadTopicIds.length > 0 && (
            <button
              onClick={() => {
                for (const id of projectContextMenu.unreadTopicIds) {
                  topicsApi.markRead(id).catch(() => {});
                }
                setProjectContextMenu(null);
              }}
              className={POPOVER_ITEM}
            >
              <CheckCheck size={14} />
              <span>{tr('sidebar.markAllRead')}</span>
            </button>
          )}
          {onTogglePin && (
            <button
              onClick={() => {
                // Pin key = the sidebar item id form (`project:<rawPath>`),
                // NOT the encodeURIComponent pane id.
                onTogglePin(`project:${projectContextMenu.projectPath}`);
                setProjectContextMenu(null);
              }}
              className={POPOVER_ITEM}
            >
              {projectContextMenu.pinned ? <PinOff size={14} /> : <Pin size={14} />}
              <span>{projectContextMenu.pinned ? 'Rimuovi dai Fissati' : 'Fissa'}</span>
            </button>
          )}
          {/* Mute an entire project: toggles its path in AppSettings.mutedProjects
              (persisted server-side, cross-client). Suppresses completion banners
              for every topic in the project; the badge still counts them. */}
          <button
            onClick={() => {
              const pp = projectContextMenu.projectPath;
              const s = loadSettings();
              const cur = s.mutedProjects ?? [];
              const next = projectContextMenu.muted ? cur.filter(p => p !== pp) : [...cur, pp];
              saveSettings({ ...s, mutedProjects: next });
              setProjectContextMenu(null);
            }}
            className={POPOVER_ITEM}
          >
            {projectContextMenu.muted ? <BellRing size={14} /> : <BellOff size={14} />}
            <span>{projectContextMenu.muted ? 'Riattiva notifiche' : 'Muta notifiche'}</span>
          </button>
          {onArchiveProject && (
            <button
              onClick={() => {
                onArchiveProject(projectContextMenu.projectPath, !projectContextMenu.allArchived);
                setProjectContextMenu(null);
              }}
              className={POPOVER_ITEM}
            >
              {projectContextMenu.allArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              <span>{projectContextMenu.allArchived ? 'Restore Project' : 'Archive Project'}</span>
            </button>
          )}
        </ContextMenuPortal>
      )}
    </div>
  );
}

// ── Terminal sidebar item ──────────────────────────────────────────────────────

interface TerminalSidebarItemProps {
  session: TerminalSessionInfo;
  /** Currently-viewed terminal → blue accent (mirrors chat rows). */
  isFocused: boolean;
  /** Open as a tab somewhere but not the focused one → subtle "open" styling. */
  isOpen: boolean;
  /** Unified attention count (finished claude-code turn) — rendered as the same
   *  NotificationBadge every other surface uses, instead of a one-off dot. */
  notificationCount?: number;
  isTouch: boolean;
  depth?: number;
  projectName?: string;
  /** Pinned ("Fissati") — renders the trailing Pin glyph and the row survives
   *  tab close (see buildSidebarItems pinnedIds escape for `terminal:<id>`). */
  pinned?: boolean;
  /** Real last-touched timestamp (createdAt, or the Claude session's own
   *  phaseUpdatedAt/updatedAt when more recent — see buildSidebarItems'
   *  terminalLastActivity). Rendered as a relative-time label so it's visible
   *  WHY this row sorts above/below another, mirroring BrowserSidebarItem. */
  lastActivity: number;
  onTerminalClick?: (sessionId: string, sessionName: string) => void;
  onCloseTerminal?: (sessionId: string) => void;
  onOpenAsProject?: (path: string) => void;
  /** Pin/unpin this terminal ("Fissa" / "Rimuovi dai Fissati") — surfaced in
   *  the right-click context menu and the touch overflow menu. */
  onTogglePin?: () => void;
}

function TerminalSidebarItem({ session: s, isFocused, isOpen, notificationCount = 0, isTouch, depth = 0, projectName, pinned, lastActivity, onTerminalClick, onCloseTerminal, onOpenAsProject, onTogglePin }: TerminalSidebarItemProps) {
  const tr = useT();
  // UN menu solo, da tutte e tre le porte: tasto destro, «tieni premuto», «...».
  // null = chiuso; posizionato sul cursore, agganciato al viewport come quello
  // del progetto.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // Il menu esiste se ha almeno una voce. Prima il cancello era il solo
  // `onTogglePin`, quindi senza quello il tasto destro non apriva NIENTE mentre
  // il «...» su touch mostrava lo stesso il «Close»: due porte con due
  // disponibilità diverse per lo stesso menu.
  const hasMenu = !!onTogglePin || !!onCloseTerminal || (!!onOpenAsProject && !projectName);
  // v3 sidebar↔topbar sync: also check `close-tab:terminal:<id>` so that
  // closing the terminal pane via the topbar X shows the countdown in
  // the sidebar terminal row too.
  const pendingClose = useTerminalPendingStatus(s.id);
  // Attention TIER — amber 'input' (permission gate) vs blue 'done' (turn
  // finished), o null. Il fill cade quando la riga è stata VISTA (soglia di
  // SEEN_DWELL_MS a finestra sveglia), non appena viene selezionata: stessa
  // regola della riga chat, in un posto solo (`attentionFillFor`).
  useSeenDwell(s.id, isFocused);
  const attentionTier = useTerminalAttentionFill(s.id);
  const onFill = attentionTier !== null;
  // Split schematic, same as chat rows (TopicItem) and projects. The standalone
  // terminal pane is published in SplitPositionContext under its pane-id
  // `terminal:<id>` (PanelGrid keys every open pane by paneId), so a topicless
  // terminal — which has no topic UUID key — still resolves its cell here.
  const splitPosition = useSplitPosition(`terminal:${s.id}`);

  return (
    // Tieni premuto = tasto destro, come ogni altra riga della sidebar. Era
    // l'ULTIMA rimasta senza: su touch il suo menu si raggiungeva solo dal
    // «...», che ne apriva una copia a mano. `LongPressRow` è lo stesso
    // componente della riga di progetto — mangia anche il clic-eco in cattura,
    // che qui serve perché l'`onClick` sta sul bottone DENTRO la riga.
    <LongPressRow
      isTouch={isTouch && hasMenu}
      // Same three-state model as chat (TopicItem) so selection means the SAME
      // thing on every sidebar row: the focused item gets the shared neutral
      // SELECTED_SURFACE (= the focused tab), merely-open is subtle, else quiet.
      // `select-none`: chi monta un long-press lo vuole, o iOS ci mette sopra il
      // proprio callout di selezione mentre tieni premuto.
      className={[
        `group/terminal flex items-center ${ROW_H} ${ROW_PX} select-none`,
        sidebarRowCard({ focused: isFocused, open: isOpen, attention: attentionTier }),
      ].filter(Boolean).join(' ')}
      style={{ marginLeft: ROW_INSET + depth * SIDEBAR_INDENT_STEP }}
      data-pinned={pinned ? 'true' : undefined}
      onContextMenu={hasMenu ? (e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); } : undefined}
    >
      {pendingClose && <PendingActionProgressOverlay status={pendingClose} />}
      <button
        onClick={() => { signalsActions.clearTerminalFinished(s.id); onTerminalClick?.(s.id, s.name); }}
        className="flex items-center gap-2 flex-1 min-w-0 h-full text-left"
        title={`${s.name} — ${s.cwd}`}
      >
        {s.type === 'claude-code'
          ? <ClaudeIcon size={13} className="flex-shrink-0 text-[#D97757]" />
          : s.type === 'codex'
            ? <CodexIcon size={13} className="flex-shrink-0" />
            : <TerminalSquare size={13} className="flex-shrink-0 text-app-text-tertiary" />}
        {/* Name + live "what it's doing" subline (self-hides when idle). */}
        {/* `gap-[3px]` invece di `mt-[3px]` sulla subline: vedi TopicItem —
            `truncate-tight` usa il margine verticale, e un `mt` sul figlio glielo
            porterebbe via. */}
        <span className="flex-1 min-w-0 flex flex-col justify-center gap-[3px]">
          <span className={`text-[12px] truncate-tight ${onFill ? 'font-semibold' : ''}`}>{s.name}</span>
          <SessionActivity subjectId={s.id} onFill={onFill} />
        </span>
        {projectName && (
          <span className={`text-[11px] truncate max-w-[80px] mr-1 ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary'}`} title={s.cwd}>
            {projectName}
          </span>
        )}
        {/* Connected-client count removed from the sidebar — it was almost
            always "1" (one viewer per session) and read as a cryptic grey
            number, same noise we already stripped from the project header
            (see the comment near the project row). The live socket count is
            still available server-side if a surface ever genuinely needs it. */}
        {/* Relative last-activity — same trailing timestamp BrowserSidebarItem
            shows, so it's visible AT A GLANCE why this row sorts above/below
            another (real last touch, not frozen createdAt). */}
        <RelativeTime
          at={lastActivity}
          className={`flex-shrink-0 text-[11px] tabular-nums group-hover/terminal:hidden mr-1 ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary'}`}
        />
        {/* Loading spinner + status pinned to the END of the row (after the cwd
            metadata) so "what's working" reads at the trailing edge, mirroring
            the tab bar. A finished turn surfaces as the notification badge, not
            a separate dot. */}
        <TerminalStreamingSpinner sessionId={s.id} className="ml-0.5" />
        <NotificationBadge count={notificationCount} className="ml-0.5" variant={onFill ? 'onFill' : 'default'} />
      </button>

      {/* Split schematic — same placement/treatment as the chat row's minimap. */}
      {splitPosition && (
        <SplitMiniMap
          rows={splitPosition.rows}
          rowHeights={splitPosition.rowHeights}
          active={splitPosition.active}
          className={`flex-shrink-0 mr-1.5 ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary'}`}
        />
      )}

      {/* Pinned ("Fissato") trailing glyph — mirrors the chat row's rail. */}
      {pinned && (
        <span
          className={`flex-shrink-0 flex items-center ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary'}`}
          title={tr('sidebar.pinned')}
          aria-label={tr('sidebar.pinned')}
        >
          <Pin size={12} />
        </span>
      )}

      {/* Inline "Open as project" icon removed — it competed with the
          close-button slot for hover attention and made the row noisy.
          The action is still reachable from the row's context menu — che su
          touch si apre tenendo premuto o dal «...» qui accanto, e col mouse col
          tasto destro: è LO STESSO menu. */}

      {(onCloseTerminal || (isTouch && hasMenu)) && (
        // The close affordance only takes layout space on hover (or when a
        // close is pending / on touch). At rest it's `hidden` → zero width, so
        // the spinner + badge inside the flex-1 button above sit FLUSH at the
        // row's trailing edge. Reserving it always (the old behaviour) pushed
        // the loading spinner ~28px in from the edge — the "spinner non in
        // fondo" bug. Same hover-reveal pattern the project row already uses.
        <span className={`flex-shrink-0 items-center justify-center relative mr-1 ${isTouch ? 'w-9 h-9 md:w-6 md:h-6' : 'w-6 h-6'} ${isTouch || pendingClose ? 'flex' : 'hidden group-hover/terminal:flex'}`}>
          {isTouch ? (
            hasMenu && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  // Nessun menu suo: sintetizza il `contextmenu` che la riga già
                  // ascolta, quindi apre il ContextMenuPortal qui sotto — lo
                  // stesso del tasto destro e della pressione lunga. Prima qui
                  // c'era un DropdownPortal con le stesse tre voci ricopiate a
                  // mano a `px-3 py-1.5`: righe da ~24px col dito, mentre le
                  // stesse voci col tasto destro (POPOVER_ITEM) ne fanno 44.
                  const el = e.currentTarget;
                  const r = el.getBoundingClientRect();
                  openContextMenuAt({ element: el, x: e.clientX || r.left, y: e.clientY || r.bottom });
                }}
                // `tap-expand-y`: l'area cresce solo in ALTEZZA (44px, larghezza
                // 100%), così non ruba pixel al glifo del pin e al badge che la
                // precedono nel binario. In larghezza si recupera dal box vero:
                // 36px (`w-9`) dentro la riga da 44 ci stanno; sopra i 768px la
                // riga torna a 34 e il box a 24, o la card lo ritaglia.
                className="tap-expand-y flex items-center justify-center w-full h-full rounded hover:bg-black/10 dark:hover:bg-white/10 transition-all text-app-text-tertiary hover:text-app-text"
                title={tr('sidebar.moreOptions')}
                aria-haspopup="menu"
                aria-label={`Azioni per ${s.name}`}
              >
                <MoreHorizontal size={12} />
              </button>
            )
          ) : pendingClose ? (
            <span className="flex items-center justify-center w-full h-full relative z-10">
              <PendingActionRing
                status={pendingClose}
                size={14}
                pendingTitle="Annulla chiusura"
                pendingAriaLabel={`Annulla chiusura ${s.name}`}
              />
            </span>
          ) : (
            <span className="hidden group-hover/terminal:flex items-center justify-center w-full h-full">
              <PendingActionRing
                status={null}
                size={14}
                // Su desktop il cancello esterno pretende già `onCloseTerminal`
                // (il ramo touch è l'unico che apre lo slot senza); il ternario
                // lo ridice solo perché TS non lo restringe attraverso l'`||`.
                onIdleClick={onCloseTerminal ? () => onCloseTerminal(s.id) : undefined}
                idleTitle="Chiudi terminale"
                idleAriaLabel={`Chiudi terminale ${s.name}`}
              />
            </span>
          )}
        </span>
      )}

      {/* IL MENU DELLA RIGA — uno solo, per tutte e tre le porte: tasto destro,
          «tieni premuto» (LongPressRow qui sopra) e il «...» su touch, che
          sintetizza lo stesso `contextmenu`. Usa i token condivisi
          (POPOVER_ITEM, 44px col dito) come il menu del progetto. */}
      {ctxMenu && (
          <ContextMenuPortal
            open
            x={ctxMenu.x}
            y={ctxMenu.y}
            onClose={() => setCtxMenu(null)}
            minWidth={200}
          >
            {onTogglePin && (
              <button
                role="menuitem"
                onClick={() => { onTogglePin(); setCtxMenu(null); }}
                className={POPOVER_ITEM}
              >
                {pinned ? <PinOff size={14} className="text-app-text-tertiary" /> : <Pin size={14} className="text-app-text-tertiary" />}
                {pinned ? 'Rimuovi dai Fissati' : 'Fissa'}
              </button>
            )}
            {onOpenAsProject && !projectName && (
              <button
                role="menuitem"
                onClick={() => { onOpenAsProject(s.cwd); setCtxMenu(null); }}
                className={POPOVER_ITEM}
              >
                <FolderOpen size={14} className="text-app-text-tertiary" />
                Open as project
              </button>
            )}
            {onCloseTerminal && (
              <button
                role="menuitem"
                onClick={() => { onCloseTerminal(s.id); setCtxMenu(null); }}
                className={POPOVER_ITEM}
              >
                <X size={14} className="text-app-text-tertiary" />
                Close
              </button>
            )}
          </ContextMenuPortal>
      )}
    </LongPressRow>
  );
}

// ── Il «+» della riga di progetto, su touch ────────────────────────────────────
//
// SI CHIAMA «Add» PERCHÉ È QUELLO, e il nome vecchio (`TouchProjectMenu`) era la
// causa del difetto: sembrava IL menu del progetto su touch, e chi lo guardava
// dava per scontato che ci fosse tutto. Invece il menu del progetto ha quattro
// voci — «Segna tutto come letto», «Fissa», «Muta notifiche», «Archivia» — e da
// qui se ne raggiungeva una sola, cioè proprio le cose che dal telefono si fanno
// di più erano irraggiungibili.
//
// Da oggi le due strade sono distinte e nessuna è un sottoinsieme muto
// dell'altra: il MENU del progetto si apre tenendo premuta la riga ed è lo
// stesso del tasto destro (`LongPressRow`); QUESTO è il gemello del «+» che sul
// desktop compare al passaggio del mouse — aggiungere una chat o una pane — più
// l'archiviazione, che sul desktop sta nel bottone accanto al «+».
//
// L'archiviazione è l'unica voce RIPETUTA: sta anche nel menu della riga
// («Archive Project»), quindi il vecchio «su touch non avrebbe altra porta» non
// è più vero da quando la pressione lunga apre quel menu. Resta come
// scorciatoia, non come unica strada, e resta IDENTICA — stesso token
// POPOVER_ITEM, stessa etichetta, stessa azione: un doppione che non può
// divergere non è il difetto che stiamo chiudendo (due menu con altezze e voci
// diverse lo era).

interface TouchProjectAddMenuProps {
  pp: string;
  allArchived: boolean;
  // Note: claudeSkipPermissions state is owned inside PaneAddMenuItems via
  // useClaudeSkipPermissions(); we don't thread it through here anymore.
  onNewTopicInProject?: (projectPath: string) => void;
  onAddProjectPane?: (projectPath: string, type: PaneType, subType?: string) => void;
  onArchiveProject?: (projectPath: string, archive: boolean) => Promise<boolean>;
}

function TouchProjectAddMenu({ pp, allArchived, onNewTopicInProject, onAddProjectPane, onArchiveProject }: TouchProjectAddMenuProps) {
  const tr = useT();
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  const hasAddItems = !!(onNewTopicInProject || onAddProjectPane);
  const hasProjectActions = !!onArchiveProject;

  return (
    <div className="relative">
      <button
        ref={overflowBtnRef}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        // Niente `bg-surface` (è il colore delle PANE, un gradino SOPRA il
        // chrome su cui questa riga sta: da lì il bottone sembrava incollato
        // sopra la sidebar invece che dentro la riga) e niente
        // `hover:bg-app-hover`, che è un opaco tarato su quella stessa
        // superficie. A riposo trasparente come ogni controllo della sidebar,
        // in rilievo con SIDEBAR_HOVER.
        //
        // `tap-expand-y`, non `tap-expand`: questo bottone chiude il binario in
        // coda alla riga di progetto, e un'area da 44 di LARGO si prendeva i
        // ~10px del badge e del timestamp che lo precedono. Cresce solo in
        // altezza (44, larghezza 100%); in largo si recupera dal box vero, 36px
        // (`w-9`) dentro la riga da 44. Sopra i 768px la riga torna a 34 e il
        // box a 24, o l'`overflow-hidden` della card lo taglia.
        className={`tap-expand-y flex-shrink-0 w-9 h-9 md:w-6 md:h-6 flex items-center justify-center rounded-md text-app-text-muted hover:text-app-text transition-colors ${SIDEBAR_HOVER}`}
        title={tr('sidebar.moreOptions')}
      >
        <MoreHorizontal size={14} />
      </button>
      <DropdownPortal open={open} anchorRef={overflowBtnRef} onClose={close}>
        {/* Add-pane rows: same shared component as the desktop "+" menu so a
            new pane type added to PANE_CONFIG appears here automatically. */}
        <PaneAddMenuItems
          scope="project"
          onNewChat={onNewTopicInProject ? () => onNewTopicInProject(pp) : undefined}
          onAddPane={onAddProjectPane ? (type, subType) => onAddProjectPane(pp, type, subType) : undefined}
          onClose={close}
        />
        {/* Divider before project-level actions — only when both halves render. */}
        {hasAddItems && hasProjectActions && <div className="h-px bg-app-border mx-2 my-1" />}
        {/* `POPOVER_ITEM`, non le sue classi ricopiate: erano la stessa stringa
            scritta a mano (meno il `text-left`), cioè il modo con cui questa
            voce e il resto dei menu tornano a divergere al primo ritocco del
            token. */}
        {onArchiveProject && (
          <button onClick={(e) => { e.stopPropagation(); onArchiveProject(pp, !allArchived); close(); }} className={POPOVER_ITEM}>
            {allArchived ? <ArchiveRestore size={14} className="flex-shrink-0" /> : <Archive size={14} className="flex-shrink-0" />}
            <span className="flex-1 text-left">{allArchived ? 'Restore Project' : 'Archive Project'}</span>
          </button>
        )}
      </DropdownPortal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Project archive button — extracted so we can call usePendingActionStatus
 * for the inline check + countdown ring (replaces the Archive icon during
 * the 3 s soft-archive window). Lives at module scope because hooks can't
 * be called inside the projects.map(...) render loop above. */

interface ProjectArchiveButtonProps {
  projectPath: string;
  allArchived: boolean;
  onArchive: (projectPath: string, archive: boolean) => Promise<boolean>;
}

function ProjectArchiveButton({ projectPath, allArchived, onArchive }: ProjectArchiveButtonProps) {
  const tr = useT();
  // Only the archive direction goes through the countdown — restoring is
  // immediate (consistent with TopicItem and the App-level wrappers).
  const status = usePendingActionStatus(allArchived ? null : `archive-project:${projectPath}`);

  // Pending: filled check (cancels on click).
  if (status) {
    return (
      <span className="hidden group-hover/proj:flex flex-shrink-0 w-6 h-6 items-center justify-center relative z-10">
        <PendingActionRing
          status={status}
          size={14}
          pendingTitle="Annulla archiviazione"
          pendingAriaLabel={`Annulla archiviazione progetto ${projectPath}`}
        />
      </span>
    );
  }

  // Idle, archived → restore icon (no countdown — restoration is safe).
  if (allArchived) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onArchive(projectPath, false); }}
        className="hidden group-hover/proj:flex flex-shrink-0 w-6 h-6 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary hover:text-app-text transition-colors"
        title={tr('sidebar.restoreProject')}
      >
        <ArchiveRestore size={12} />
      </button>
    );
  }

  // Idle, not archived → empty "todo" circle. Click queues the soft-archive.
  return (
    <span className="hidden group-hover/proj:flex flex-shrink-0 w-6 h-6 items-center justify-center relative z-10">
      <PendingActionRing
        status={null}
        size={14}
        onIdleClick={() => onArchive(projectPath, true)}
        idleTitle="Archivia progetto"
        idleAriaLabel={`Archivia progetto ${projectPath}`}
      />
    </span>
  );
}

/**
 * Sub-component used as a direct child of the project header row in
 * TopicTree (pos: relative on that row) so the progress fill aligns to
 * the row's bounds. Lives at module scope for the same hook-rule reason
 * as ProjectArchiveButton.
 */
function ProjectRowPendingOverlay({ projectPath }: { projectPath: string }) {
  const status = usePendingActionStatus(`archive-project:${projectPath}`);
  if (!status) return null;
  return <PendingActionProgressOverlay status={status} />;
}


/**
 * The project window's position mini-map for its sidebar row. Reads the
 * project path's cell in the published top-level split (undefined unless more
 * than one window is open), and renders the same proportional SplitMiniMap the
 * sidebar chat rows use, with this window's cell lit. Module-scope sub-component
 * because it calls a hook — can't run inside the projects render loop above.
 */
function ProjectSplitMiniMap({ projectPath, onFill }: { projectPath: string; onFill?: boolean }) {
  const pos = useSplitPosition(projectPath);
  if (!pos) return null;
  return (
    <SplitMiniMap
      rows={pos.rows}
      rowHeights={pos.rowHeights}
      active={pos.active}
      // currentColor-driven: on the attention fill inherit its high-contrast tone
      // instead of a fixed grey (the grey-on-blue bug), matching the chat row.
      className={`flex-shrink-0 mr-1.5 ${onFill ? ON_FILL_TEXT_SOFT : 'text-app-text-tertiary'}`}
    />
  );
}


/**
 * Browser sidebar item — extracted from the parent's `renderBrowserItem`
 * inline closure so we can call `usePendingActionStatus` per browser.
 * Otherwise hooks live inside a function called conditionally inside the
 * parent's render, which violates the rules of hooks across re-renders.
 */
interface BrowserSidebarItemProps {
  bc: BrowserContextInfo;
  itemName: string;
  depth: number;
  isFocused: boolean;
  isOpen: boolean;
  pinned?: boolean;
  onOpenBrowser?: (id: string) => void;
  onCloseBrowser?: (id: string) => void;
  onTogglePin?: () => void;
}

function BrowserSidebarItem({ bc, itemName, depth, isFocused, isOpen, pinned, onOpenBrowser, onCloseBrowser, onTogglePin }: BrowserSidebarItemProps) {
  const tr = useT();
  // v3 sidebar↔topbar sync: also check `close-tab:browser:<id>` so the
  // sidebar browser row shows the countdown when the close is initiated
  // from the topbar.
  const pendingClose = useBrowserPendingStatus(bc.id);
  // Desktop right-click menu — parity with the chat/terminal rows (which had one
  // while browser rows did not). Cursor-positioned, portaled via ContextMenuPortal.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const hasMenu = !!onTogglePin || !!onCloseBrowser;
  // La riga più scoperta di tutte: qui dentro `isTouch` non esisteva proprio,
  // quindi da iPhone un browser aperto non si chiudeva più dalla sidebar (lo
  // slot della X è rivelato dall'hover, e su touch l'hover non c'è) e le sue due
  // voci — «Fissa», «Chiudi browser» — vivevano solo sotto il tasto destro.
  const { isTouch } = useMobile();
  const press = useLongPress(openContextMenuAt, { enabled: isTouch && hasMenu });
  return (
    <div
      className={[
        // `select-none`: chi monta un long-press lo vuole, o iOS ci mette sopra
        // il proprio callout di selezione mentre tieni premuto.
        `group flex items-center ${ROW_H} cursor-pointer select-none text-[14px] md:text-[13px] ${ROW_PX}`,
        sidebarRowCard({ focused: isFocused, open: isOpen }),
      ].filter(Boolean).join(' ')}
      style={{ marginLeft: ROW_INSET + depth * SIDEBAR_INDENT_STEP }}
      data-pinned={pinned ? 'true' : undefined}
      {...press.handlers}
      data-pressing={press.pressed || undefined}
      onClick={() => { if (press.consumeClick()) return; onOpenBrowser?.(bc.id); }}
      onContextMenu={hasMenu ? (e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); } : undefined}
    >
      {pendingClose && <PendingActionProgressOverlay status={pendingClose} />}
      <Globe size={14} className="flex-shrink-0 mr-2 opacity-60" />
      <span className="flex-1 truncate" title={bc.url}>
        {itemName}
      </span>
      <RelativeTime
        at={bc.lastActivity}
        className="flex-shrink-0 text-[11px] text-app-text-tertiary tabular-nums group-hover:hidden mr-1"
      />
      {/* Loading spinner pinned to the row's trailing edge (after the
          last-activity timestamp), mirroring the tab + terminal rows. Same
          signal (useBrowserLoading) and component the browser TAB uses. No
          right margin so it sits flush when the close slot is hidden. */}
      <BrowserStreamingSpinner paneId={`browser:${bc.id}`} className="ml-0.5" />
      {/* Pin glyph — same "Fissato" indicator as chat / terminal / project rows.
          Placed as the trailing-most PERSISTENT element (after the timestamp +
          spinner, before the hover-only close slot) so it lands in the SAME
          column as the other rows' pins — putting it before the timestamp pushed
          it left and broke the alignment. Applies to both project-nested and
          top-level browser rows (same component). */}
      {pinned && (
        <span
          className="flex-shrink-0 flex items-center text-app-text-tertiary ml-1"
          title={tr('sidebar.pinned')}
          aria-label={tr('sidebar.pinned')}
        >
          <Pin size={12} />
        </span>
      )}
      {onCloseBrowser && (
        // Hover-only close slot (or visible while a close is pending) so the
        // spinner above sits FLUSH at the trailing edge at rest — reserving it
        // always pushed the spinner ~28px in from the edge.
        // SU TOUCH RESTA SEMPRE VISIBILE, come già fa la riga del terminale
        // accanto (`isTouch || pendingClose ? 'flex' : …`): senza hover la X
        // restava `hidden` per sempre e un browser aperto dalla sidebar non si
        // chiudeva più.
        <span className={`flex-shrink-0 w-6 h-6 items-center justify-center mr-1 relative z-10 ${isTouch || pendingClose ? 'flex' : 'hidden group-hover:flex'}`}>
          {pendingClose ? (
            <PendingActionRing
              status={pendingClose}
              size={14}
              pendingTitle="Annulla chiusura"
              pendingAriaLabel={`Annulla chiusura browser ${itemName}`}
            />
          ) : (
            <span className={`items-center justify-center w-full h-full ${isTouch ? 'flex' : 'hidden group-hover:flex'}`}>
              <PendingActionRing
                status={null}
                size={14}
                onIdleClick={() => onCloseBrowser(bc.id)}
                idleTitle="Chiudi browser"
                idleAriaLabel={`Chiudi browser ${itemName}`}
                // Il cerchio è 14px e l'area sensibile cresce solo in ALTEZZA
                // (`tap-expand-y`, 44px): con `tap-expand` i 44 di LARGO
                // sporgevano ~15px oltre il box e coprivano il glifo del pin
                // qui accanto, quindi toccare il pin CHIUDEVA il browser invece
                // di aprirlo. Larghezza: il bottone se la impone da sé via
                // `style` (size=14), quindi qui il bersaglio resta 14×44 —
                // stretto, ma suo.
                className="tap-expand-y"
              />
            </span>
          )}
        </span>
      )}
      {ctxMenu && (
        <ContextMenuPortal
          open
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          minWidth={200}
        >
          {onTogglePin && (
            <button
              role="menuitem"
              onClick={() => { onTogglePin(); setCtxMenu(null); }}
              className={POPOVER_ITEM}
            >
              {pinned ? <PinOff size={14} className="text-app-text-tertiary" /> : <Pin size={14} className="text-app-text-tertiary" />}
              {pinned ? 'Rimuovi dai Fissati' : 'Fissa'}
            </button>
          )}
          {onCloseBrowser && (
            <button
              role="menuitem"
              onClick={() => { onCloseBrowser(bc.id); setCtxMenu(null); }}
              className={POPOVER_ITEM}
            >
              <X size={14} className="text-app-text-tertiary" />
              Chiudi browser
            </button>
          )}
        </ContextMenuPortal>
      )}
    </div>
  );
}
