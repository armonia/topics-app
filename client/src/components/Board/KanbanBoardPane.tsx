/**
 * KanbanBoardPane — lean, Master-free task board (human surface).
 *
 * Rebuilt after the Master/Board subsystem was removed (42e92c1d): no Crown/lead,
 * no proposal cards, no autopilot. Five columns, drag between columns to change
 * status, a detail drawer with the comment thread, and a human review gate on the
 * Review column (approve → done / reject → in_progress). Talks only to the
 * project-scoped board API (client/src/lib/board.ts).
 */
import { useHeldDraft } from './useHeldDraft';
import { useCreatedFlash } from './useCreatedFlash';
import { useWorktreeStatus } from './useWorktreeStatus';
import { EMPTY_WRITES, useBoardDrag, useDragPreview } from './useBoardDrag';
import { DeliveryControl, LoadAdviceChip, MissionsMenu, WorktreeControl } from './BoardToolbarControls';
import { InlineFilters } from './InlineFilters';
import { useT } from '../../hooks/useT';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { Archive, ChevronRight, Music4, Settings } from 'lucide-react';
import type { Topic, WSMessage } from '../../types';
import { Menu } from '../Shared/Menu';
import { BrakeChip } from './BrakeChip';
import { useTaskModelCatalog } from '../../hooks/useTaskModelCatalog';
import { currentTaskTarget, reflectTaskOpen, reflectTaskClose, reflectTaskFocus, subscribePopstateTask } from '../../lib/openTaskLink';
import { useTaskDeepLink } from './useTaskDeepLink';
import { DEAD_TAB_MESSAGE } from '../../lib/tabLink';
import { useToast } from '../Shared/Toast';
import { usePaneStore } from '../../state/pane/store';
import { parseUtilityPanelType } from '../Layout/UtilityPanel';
import { useTaskSessionResolver } from '../../hooks/useTaskSession';
import { useBoardFeed } from '../../hooks/useBoardFeed';
import { canAbsorbBoardTaskFrame } from '../../lib/boardTasksStore';
import {
  boardApi, boardIdForPath, showsLandingDebt, TASK_STATUSES,
  STATUS_LABEL, taskDetailBump, WORKFLOW_PRESETS, columnOfTask,
  type BoardTask, type TaskStatus, type BoardSettings, type BoardWorkflowView,
} from '../../lib/board';
import { applyPendingWrites, groupByStatus, manualStatusTarget, type OrderScope } from '../../lib/boardOrder';
import { COLUMN_FLASH_MS, landedInColumn, statusSnapshot } from '../../lib/columnFlash';
import { useBoardMotion } from './useBoardMotion';
import { useDrawerPresence } from './useDrawerPresence';
import { useRowSnapHold } from './useRowSnapHold';
import { BoardSkeleton } from './BoardSkeleton';
import { DropNotice } from './DropNotice';
import {
  BOARD_GROUP_BY_STORAGE_KEY, BOARD_SHOW_DONE_STORAGE_KEY, COLUMNS_ROW_GRID, COLUMNS_ROW_LIST,
  readBoardGroupBy, readBoardShowDone, writeBoardPreference, type BoardGroupBy, type BoardLayout,
} from './boardGeometry';
import { laneDropId, type BoardLane } from './boardLanes';
import { BoardViewToggles, ProjectLanes } from './ProjectLanes';
import { useProjectLanes } from './useProjectLanes';
import { useCollapsedProjects } from './useCollapsedProjects';
import { DETAIL_STORAGE_KEY, countByProject, readDetailLevel } from './detailLevel';
import { DetailSlider } from './DetailSlider';
import { ProjectsSummary } from './ProjectsSummary';
import { useColumnClearance } from './columnClearance';
import { scrollDelta } from '../../lib/scrollDelta';
import { useBoardProjectLabels } from '../../lib/boardProjectsStore';
import { useCardBoardSettings } from '../../hooks/useCardBoardSettings';
import { CREATED_FLASH_MS, PRIORITY_DOT, TOOLBAR_CONTROL_H, TOOLBAR_ICON_W, type BoardFilters, type LiveUsage, type OpenTask } from './constants';
import { taskMatchesFilters } from './taskFilter';
import { boardCollision } from './format';
import { FloatingTaskComposer } from './FloatingTaskComposer';
import { Card, Column } from './Card';
import { taskActionWord } from './taskActionWords';
import { TaskDetail } from './TaskDetail';
import { OrchestratorDrawer } from './OrchestratorDrawer';
import { BoardSettingsPanel } from './BoardSettingsPanel';
import { ScheduledCardsControl } from './ScheduledCardsControl';
import { SpinnerFallback } from '../Shared/Spinner';
import { GlobalOnlySettingsPanel } from './BoardSettingsSections';
import type { Mission } from '../../lib/missions';
import { useDevInstall } from '../../hooks/useDevInstall';
import { registerFindFallback, useFindPaneId } from '../../state/findRegistry';

// Lazy: the Plan is opened from the global board only, it stays out of the first load.
const PlanView = lazy(async () => {
  const { PlanView: Body } = await import('./PlanView');
  return { default: Body };
});

/** The Plan's cards are not dragged: one stable empty sensor list for its DndContext. */
const NO_SENSORS: never[] = [];

interface Props {
  /** Absent in the global ('Board generale') pane — there is no single project. */
  projectPath?: string;
  /** Global cross-project board: locks to 'all' mode, no project column, no add. */
  global?: boolean;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  /**
   * Reads a session's history into the chat store. The drawer needs it for the
   * three moments the live wire cannot cover on its own: mount, waking up, and
   * the end of a turn (persisted blocks and tool rows only come from history).
   */
  loadHistory?: (sessionKey: string) => Promise<boolean>;
  /** Deep-link a task's bound agent tab into focus (wired to handleTopicClick). */
  onOpenTopic?: (topicId: string) => void;
  /**
   * THE COORDINATOR IS A WINDOW OF THIS BOARD, not another tab.
   *
   * The old entry point (`onOpenGlobalOrchestrator`) promoted the conversation
   * to a permanent pane: you left the Kanban to talk about the Kanban, and
   * getting back to the columns meant switching tabs. It now opens as a drawer
   * beside the columns — the same slot the task preview uses, same geometry,
   * same gesture to dismiss it.
   *
   * ONE prop with two halves rather than two separate props: without the
   * second one the button would open an empty drawer, and an invariant you can
   * break by forgetting a line is not an invariant. Only the global board host
   * supplies it; project boards never render the entry point.
   */
  orchestrator?: {
    /** Ensures the server-owned singleton and returns its Topic. */
    ensure: () => Promise<{ topicId: string; topic: Topic }>;
    /** Renders the coordinator chat INSIDE the board's drawer. */
    render: (args: { topic: Topic }) => React.ReactNode;
  };
  /**
   * Consegna una MISSIONE alla sessione laterale del progetto: apre la chat
   * accanto alla board e le mette il testo davanti. Restituisce il motivo per
   * cui non si è potuto fare, o `null` se è andata.
   *
   * Assente = niente missioni: la board generale non ha UN progetto di cui
   * parlare, e senza quello la sessione laterale non esiste.
   */
  onStartMission?: (mission: Mission) => string | null;
}

/* UNA sola porta alle impostazioni, ed e' il ⚙ a destra.
 *
 * Qui, accanto al titolo, viveva un secondo ingresso: un ▾ che apriva un menu
 * con l'interruttore globale e il tetto degli agent. Erano due tasti per la
 * stessa domanda («dove cambio le impostazioni?»), con due copie dello stato
 * dell'auto-dispatch: quello del menu se lo leggeva da solo, e restava indietro
 * quando l'altro pannello lo cambiava. Il pannello del ⚙ contiene gia' quel
 * blocco (`GlobalSettingsSection`: interruttore + `GlobalCapControl`) su ogni
 * board, anche quella generale, quindi togliendo il ▾ non sparisce niente. */

export function KanbanBoardPane({ projectPath, global = false, onMessage, loadHistory, onOpenTopic, orchestrator, onStartMission }: Props) {
  const tr = useT();
  // ⌘F on the board puts the cursor in its filter, which is the board's own
  // search (FIND-02): the board registers no finder, only this.
  const findPaneId = useFindPaneId();
  useEffect(() => {
    if (!findPaneId) return;
    return registerFindFallback(findPaneId, () => {
      const input = document.querySelector<HTMLInputElement>(`[data-find-pane="${CSS.escape(findPaneId)}"] [data-testid="filter-token-input"]`);
      input?.focus();
      input?.select();
    });
  }, [findPaneId]);
  // A dead `/task/<id>` has to SAY SO, with the same words a dead `/tab/…`
  // permalink uses: two roads to one destination cannot answer differently. The
  // API of the provider is stable after mount (Toast.tsx keeps senders in their
  // own context), so it can sit in an effect's dependencies without re-running
  // the deep-link race on every toast shown.
  const toast = useToast();
  const projectId = useMemo(() => (projectPath ? boardIdForPath(projectPath) : ''), [projectPath]);
  // The project/all toggle only makes sense inside a project window. The global
  // pane has no project, so it locks to 'all'.
  const canToggle = !!projectPath && !global;
  // La scheda del task esiste sempre; la SESSIONE dell'agente no. Risolto una
  // volta qui e distribuito già deciso a card e drawer, così nessuno dei due
  // deve iscriversi all'indice dei topic. Vedi `lib/taskSession.ts`.
  const resolveSession = useTaskSessionResolver();
  // Per-board dispatch settings only exist for a single project (the global board
  // aggregates many), so the gear only shows inside a project window.
  const hasProject = !!projectPath && !global;
  // Le missioni sono una superficie interna: esistono solo in un'installazione
  // di sviluppo, e solo dentro un progetto (la board generale non ha UNA
  // sessione laterale di cui parlare).
  const devInstall = useDevInstall();
  const canRunMissions = hasProject && devInstall && !!onStartMission;
  // 'project' = this project only · 'all' = the global cross-project board.
  const [mode, setMode] = useState<'project' | 'all'>(canToggle ? 'project' : 'all');
  const [planVisible, setPlanVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // L'errore di UNA card sta sulla card, non nella barra qui sopra: quella vive
  // in cima al pannello, mentre la card che ha rifiutato il click può essere
  // dieci righe più giù in una colonna scrollata. Ne teniamo uno solo, l'ultimo:
  // due card non falliscono nello stesso istante, e un errore per card che non
  // scade mai diventerebbe arredamento.
  const [cardError, setCardError] = useState<{ taskId: string; message: string } | null>(null);
  const onCardError = useCallback((taskId: string, message: string | null) => {
    setCardError((prev) => (message ? { taskId, message } : prev?.taskId === taskId ? null : prev));
  }, []);
  // A move that did NOT land where it was aimed says so here. Not an error
  // (nothing failed) and not an app-wide toast (it belongs to the board it
  // happened on): a pill over the bottom of this board's columns (`DropNotice`),
  // which leaves by itself after a few seconds.
  //
  // It is also cleared when the NEXT gesture starts, not when the next one ends: a
  // drag that gets cancelled, or lands on a card that vanished under the
  // fingers, used to leave the previous drop's blue line on screen explaining a
  // move that was no longer the last one. And it is cleared again if the write
  // fails, because by then the line claims a destination the card never
  // reached, right next to the red error saying so.
  const [dropNotice, setDropNotice] = useState<string | null>(null);
  const clearDropNotice = useCallback(() => setDropNotice(null), []);
  // The drawer's task, and the deep-link target (from /task/<id> via
  // openTaskLink, or `topics:open-task`): the GLOBAL board owns it, that is
  // what the link opens. With it, the tab or diff file a targeted gesture
  // asked to put in front.
  const {
    selectedId, setSelectedId, pendingSelect, setPendingSelect, pendingPaneId, setPendingPaneId, promote,
  } = useTaskDeepLink(global);
  // THE COORDINATOR, while it is open: its Topic. It sits next to `selectedId`
  // because it answers the same question — what is in the drawer — and the two
  // are mutually exclusive: both are in-flow siblings of the columns, and
  // holding them open together would leave the board a slit, not a board.
  const [orchestratorTopic, setOrchestratorTopic] = useState<Topic | null>(null);
  const [openingOrchestrator, setOpeningOrchestrator] = useState(false);
  const openTask = useCallback<OpenTask>((id, focusPaneId) => {
    setSelectedId(id);
    setPendingPaneId(focusPaneId ?? null);
    setOrchestratorTopic(null);
  }, [setSelectedId, setPendingPaneId]);
  const closeOrchestrator = useCallback(() => { setOrchestratorTopic(null); }, []);
  const openOrchestrator = useCallback(async () => {
    if (!global || !orchestrator || openingOrchestrator) return;
    setOpeningOrchestrator(true);
    try {
      const { topic } = await orchestrator.ensure();
      setOrchestratorTopic(topic);
      setSelectedId(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : tr('board.orchestrator.openError'));
    } finally {
      setOpeningOrchestrator(false);
    }
  }, [global, orchestrator, openingOrchestrator, setSelectedId, tr]);
  // The escape hatch: the same conversation, promoted to a permanent tab. The
  // drawer is its home, not a cage — reading it full-width, or beside a
  // project, goes through here. The drawer closes on the way out, or the same
  // chat would be mounted twice in one window.
  const popOutOrchestrator = useCallback(() => {
    const topic = orchestratorTopic;
    if (!topic) return;
    setOrchestratorTopic(null);
    window.dispatchEvent(new CustomEvent('topics:open-topic', {
      detail: { topicId: topic.id, topic, mode: 'permanent' },
    }));
  }, [orchestratorTopic]);
  const columnsScrollRef = useRef<HTMLDivElement>(null);
  // The card in hand, if any. Declared here because the snap hold below reads
  // it: the finger that carries a card is not a finger scrolling the row.
  const [activeId, setActiveId] = useState<string | null>(null);
  // The carousel snap, held while the drawer resizes the row or a card is in
  // hand (see `useRowSnapHold`).
  const columnsSnap = useRowSnapHold(columnsScrollRef, activeId !== null);
  const holdColumnsSnap = columnsSnap.hold;
  // Mobile-only affordance: the toolbar strip below scrolls horizontally with
  // a hidden scrollbar, so without a visible cue the actions past the right
  // edge are only discoverable by swiping blind. Tracks live scroll position
  // to fade out once the strip reaches its end.
  const toolbarScrollRef = useRef<HTMLDivElement>(null);
  const [toolbarOverflowRight, setToolbarOverflowRight] = useState(false);
  // Provider model list for the board-default picker (settings panel). Same
  // hook the composer and the task drawer read, so the three cannot disagree.
  // Opening the drawer shrinks the columns viewport (flex sibling): the card
  // that was just clicked can end up outside it. Bring it back after layout
  // settles — rAF fires post-commit, when the row already has its new width.
  // Scroll the columns row's OWN scrollLeft directly (never
  // element.scrollIntoView(): its automatic ancestor-walk can escape this
  // (horizontal-only) concern onto an unrelated vertical/overflow-hidden
  // ancestor — that's what silently scrolled the whole drawer, header and
  // close button included, out of view on mobile).
  useEffect(() => {
    if (!selectedId) return;
    const raf = requestAnimationFrame(() => {
      const container = columnsScrollRef.current;
      const card = document.querySelector(`[data-task-card="${selectedId}"]`);
      if (!container || !card) return;
      const containerRect = container.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      if (cardRect.left < containerRect.left) {
        container.scrollBy({ left: cardRect.left - containerRect.left, behavior: 'smooth' });
      } else if (cardRect.right > containerRect.right) {
        container.scrollBy({ left: cardRect.right - containerRect.right, behavior: 'smooth' });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedId]);
  const [showSettings, setShowSettings] = useState(false);
  // ONE door to the settings panel, two handles on it: the gear in the toolbar
  // and the "Settings" line of the load gauge popover. What KANBAN-12 removed
  // was a second entrance holding its OWN copy of the auto-dispatch state; a
  // shared gesture on the shared state is the opposite of that.
  const toggleSettings = useCallback(() => setShowSettings((s) => !s), []);
  /** The ⚙, which the settings dropdown anchors to (KANBAN-75). */
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  // Per-board dispatch settings, owned HERE (not by the settings panel) so the
  // header can always answer "does moving a task to Todo start an agent?" —
  // the exact feedback that was missing when a task sat in Todo doing nothing.
  const [settings, setSettings] = useState<BoardSettings | null>(null);
  const models = useTaskModelCatalog(settings?.dispatchModel);
  // The START switch is GLOBAL (one for every board) — so the pill lives on
  // every header, including the global board, and clicking it IS the toggle.
  const [dispatchOn, setDispatchOn] = useState<boolean | null>(null);

  // Filters state + localStorage persistence (per board / per 'all' view).
  // The shape lives in `constants.ts` as `BoardFilters`: it used to be declared
  // twice in this file, which is the same shape in two places, i.e. two shapes
  // waiting to drift.
  const storageKey = `board:filters-${mode === 'all' ? 'all' : projectId}`;
  const [filters, setFilters] = useState<BoardFilters>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      // `labels` è arrivato dopo: un filtro salvato da una versione precedente
      // non ce l'ha, e senza il default `filters.labels.length` esploderebbe al
      // primo render su ogni board già usata.
      const parsed = stored ? JSON.parse(stored) : null;
      return { priority: [], assignedTo: [], text: '', projectId: [], labels: [], person: [], computer: [], initiator: [], runComputer: [], ...(parsed ?? {}) };
    } catch { return { priority: [], assignedTo: [], text: '', projectId: [], labels: [], person: [], computer: [], initiator: [], runComputer: [] }; }
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(filters)); } catch { /* private mode */ }
  }, [filters, storageKey]);

  useEffect(() => {
    let alive = true;
    boardApi.getGlobalDispatch()
      .then((v) => { if (alive) setDispatchOn(v); })
      .catch(() => { /* pill just stays hidden */ });
    return () => { alive = false; };
  }, []);

  const toggleDispatch = useCallback(async () => {
    if (dispatchOn === null) return;
    try { setDispatchOn(await boardApi.setGlobalDispatch(!dispatchOn)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'dispatch toggle failed'); }
  }, [dispatchOn]);

  useEffect(() => {
    if (!hasProject) { setSettings(null); return; }
    let alive = true;
    boardApi.getSettings(projectId)
      .then((v) => { if (alive) setSettings(v); })
      .catch(() => { /* panel just stays empty */ });
    return () => { alive = false; };
  }, [hasProject, projectId]);

  // THE BOARD'S COLUMNS (`shared/workflow.ts`). Until the answer arrives, and
  // on the global board (cards from many projects, each with its own
  // workflow), the five columns of before: a card is never lost, because every
  // workflow has a default column for each status.
  const [workflow, setWorkflow] = useState<BoardWorkflowView | null>(null);
  useEffect(() => {
    if (!hasProject) { setWorkflow(null); return; }
    let alive = true;
    boardApi.getWorkflow(projectId)
      .then((v) => { if (alive) setWorkflow(v); })
      .catch(() => { /* the default columns stay */ });
    return () => { alive = false; };
  }, [hasProject, projectId]);
  const boardColumns = workflow?.columns ?? WORKFLOW_PRESETS.default;

  // L'ARCHIVIO È UNA VISTA, non una colonna: stessa board, stesse colonne, ma
  // popolate da `?archived=1`. Sta nello stato della pane e non nei `filters`
  // perché non è un filtro sull'insieme già scaricato — è un'altra fetch, ed è
  // l'unico modo di rivedere una card archiviata (prima non ce n'era nessuno).
  // Solo su una board di progetto: il feed globale è `listAll`, che di archivio
  // non parla.
  const [showArchived, setShowArchived] = useState(false);
  // The alternative to the kanban: columns stacked vertically instead of side
  // by side, each as wide as the row up to a 48rem reading cap, centred, empty
  // ones skipped (see `Column`, `layout`
  // prop). A preference the person flips on and off between sessions, not a
  // property of the task — localStorage, not the server: no board needs to
  // know which view you're looking at it in.
  const [detail, setDetail] = useState(readDetailLevel);
  useEffect(() => {
    try { localStorage.setItem(DETAIL_STORAGE_KEY, detail); } catch { /* private mode, best effort */ }
  }, [detail]);
  // The summary level has no columns; the row below it keeps the grid shape.
  const boardLayout: BoardLayout = detail === 'list' ? 'list' : 'grid';
  // Per-viewer view choices, kept beside the layout: lanes per project, and the Done column.
  const [groupByPref, setGroupByPref] = useState<BoardGroupBy>(readBoardGroupBy);
  // The Done column is out of the way until asked for: a board of live work.
  const [showDone, setShowDone] = useState(readBoardShowDone);
  useEffect(() => { writeBoardPreference(BOARD_GROUP_BY_STORAGE_KEY, groupByPref); }, [groupByPref]);
  useEffect(() => { writeBoardPreference(BOARD_SHOW_DONE_STORAGE_KEY, String(showDone)); }, [showDone]);
  const { collapsed: collapsedProjects, toggle: toggleProjectCollapsed } = useCollapsedProjects();
  // Le righe non le legge più questa pane: le legge `useBoardFeed`, che in
  // modalità 'all' NON fetcha affatto (il feed globale ha già un proprietario,
  // `useGlobalBoard`) e in modalità progetto raffredda la raffica e scarta le
  // risposte superate. Vedi l'intestazione dell'hook per i numeri.
  const {
    tasks: feedTasks, loading, refetch, patchTask, beginDrag, endDrag, flushDeferredRead,
  } = useBoardFeed({ mode, projectId, showArchived, onError: setError });
  // The room under the last card, measured against the composer that floats
  // over the columns (KANBAN-MOBILE-04, see `columnClearance.ts`).
  useColumnClearance(columnsScrollRef, boardLayout, !loading);

  // LE SCRITTURE ANCORA IN VOLO, sopra qualunque lista atterri.
  //
  // La lettura parcheggiata durante il drag riparte solo quando la PATCH ha
  // risposto (vedi `dropTo`), ma non è l'unica lettura possibile: un evento WS
  // di un altro client, un ritorno di visibilità, o il proprietario del feed
  // globale che risponde a qualcun altro possono far atterrare una lista NEL
  // MEZZO della scrittura. Quella lista è vecchia di un drop, e senza questo
  // strato la card tornerebbe indietro fino alla lettura successiva.
  // Le voci si tolgono quando la PATCH ha finito: da lì in poi il server sa.
  const [pendingWrites, setPendingWrites] = useState<ReadonlyMap<string, Partial<BoardTask>>>(EMPTY_WRITES);
  const tasks = useMemo(() => applyPendingWrites(feedTasks, pendingWrites), [feedTasks, pendingWrites]);
  // Ghost card of what the composer is about to create (card 058ea722), held until the real one arrives.
  const { draft, setDraft, holdCreated } = useHeldDraft(tasks);

  const { justCreated, flashCreated, scrollTarget, setScrollTarget, keepClearRef, onCreatedHere } = useCreatedFlash(holdCreated, refetch);

  // Live updates. In 'all' mode any task event is relevant; in 'project' mode
  // only events for this project (or project-less broadcasts) trigger a refetch.
  // board:settings keeps the header pill honest when another client toggles it.
  //
  // Che il refetch sia una raffica sola, che la risposta superata non vinca e
  // che le righe restino ferme mentre una card è in mano lo garantisce
  // `useBoardFeed`: qui si dice solo QUANDO rileggere.
  // Live per-turn usage (model · execution-time · tokens) keyed by task id,
  // fed by `task:usage-live` and dropped when the turn ends. Drives the ticking
  // chip on working cards; the persisted agent_ms/agent_tokens take over after.
  const [liveUsage, setLiveUsage] = useState<Map<string, LiveUsage>>(new Map());
  // «Questo task aspetta TE», mentre il turno e' ancora vivo: un pannello di
  // domanda o un permesso aperti a meta' turno. Transitorio come liveUsage, e
  // per una ragione in piu': l'attesa vive nelle mappe in memoria del server, e
  // a server riavviato NON esiste piu'. Persisterla in dispatch_state la farebbe
  // sopravvivere a cio' che la sostiene — ed e' gia' costata un task congelato.
  const [awaitingHuman, setAwaitingHuman] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg) => {
      const m = msg as { type?: string; projectId?: string; settings?: BoardSettings; autoDispatch?: boolean; task?: BoardTask;
        taskId?: string; turnStartedAt?: number; baseMs?: number; liveTokens?: number; model?: string | null;
        triage?: boolean; waiting?: boolean; ended?: boolean;
        lastTool?: LiveUsage['lastTool']; retry?: LiveUsage['retry'] };
      if (m.type === 'task:created' || m.type === 'task:updated' || m.type === 'task:deleted') {
        // In 'all' mode the rows come from `boardTasksStore`, and a
        // `task:updated` the store can absorb is already the whole answer:
        // `useGlobalBoard` writes the frame's row in and wakes this pane with
        // it. Asking for a read here would land in the same coalescer and pay
        // the feed anyway, which is the traffic this skips.
        const absorbed = mode === 'all' && m.type === 'task:updated' && canAbsorbBoardTaskFrame(m.task);
        if (!absorbed && (mode === 'all' || m.projectId === undefined || m.projectId === projectId)) refetch();
        // Il lampo è il segnale «è nato un task», e non ha un autore
        // privilegiato: qui passano anche le creazioni remote (agent, MCP, un
        // altro device), che sono proprio quelle che altrimenti comparirebbero
        // in silenzio. L'eco della propria POST rientra da qui ed è innocua.
        if (m.type === 'task:created' && typeof m.task?.id === 'string'
          && (mode === 'all' || m.projectId === undefined || m.projectId === projectId)) {
          flashCreated(m.task.id);
        }
        // A turn that ended (or a task that left 'working') drops its live chip;
        // the refetched task then carries the final agent_ms/agent_tokens.
        if (m.task && m.task.dispatchState !== 'working') {
          setLiveUsage((prev) => { if (!prev.has(m.task!.id)) return prev; const n = new Map(prev); n.delete(m.task!.id); return n; });
        }
      }
      // Live per-turn preview from the dispatcher: model + tokens-so-far +
      // execution-time-so-far, ticked on the card while the agent works.
      if (m.type === 'task:usage-live' && typeof m.taskId === 'string'
        && (mode === 'all' || m.projectId === undefined || m.projectId === projectId)) {
        setLiveUsage((prev) => {
          const n = new Map(prev);
          // "The turn ended": drop the chip NOW. Waiting for a `task:updated`
          // whose chip is not `working` let the stopwatch run over a dead turn
          // the dispatcher retries, because on that branch the chip never
          // changes.
          if (m.ended === true) { if (!n.has(m.taskId!)) return prev; n.delete(m.taskId!); return n; }
          n.set(m.taskId!, {
            turnStartedAt: m.turnStartedAt ?? Date.now(), baseMs: m.baseMs ?? 0, liveTokens: m.liveTokens ?? 0,
            model: m.model ?? null, triage: m.triage === true,
            lastTool: m.lastTool ?? null, retry: m.retry ?? null,
          });
          return n;
        });
      }
      if (m.type === 'task:awaiting-human' && typeof m.taskId === 'string'
        && (mode === 'all' || m.projectId === undefined || m.projectId === projectId)) {
        setAwaitingHuman((prev) => {
          const has = prev.has(m.taskId!);
          if (m.waiting === has) return prev; // nessun cambio: niente re-render
          const n = new Set(prev);
          if (m.waiting) n.add(m.taskId!); else n.delete(m.taskId!);
          return n;
        });
      }
      if (m.type === 'board:settings' && m.projectId === projectId && m.settings) setSettings(m.settings);
      // Global switch flipped anywhere (any board, any client) → this pill too.
      // E anche le CARD: da quando ognuna porta la ragione per cui è ferma
      // (`queueReason`, risolta dal server), l'interruttore è un ingrediente di
      // quella frase. Senza il refetch le card resterebbero a «ferma · dispatch
      // spento» dopo che l'hai riacceso — nessuna riga di task è cambiata,
      // quindi nessun `task:updated` arriva a correggerle, e la board direbbe
      // una bugia proprio nell'istante in cui la guardi per vedere l'effetto.
      if (m.type === 'board:dispatch' && typeof m.autoDispatch === 'boolean') {
        setDispatchOn(m.autoDispatch);
        refetch();
      }
    });
  }, [onMessage, projectId, refetch, mode, flashCreated]);

  // Wake-up refresh: a window coming back from sleep/background has yesterday's
  // board (WS events happened while it slept) — and the live "ci sta mettendo"
  // Ticker recomputes from Date.now(), so a stale 'working' card reads hours of
  // agent work that never happened. Any return to visibility refetches.
  useEffect(() => {
    const onWake = () => { if (document.visibilityState === 'visible') refetch(); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [refetch]);

  // Task chiusi la cui consegna NON risulta su main (verdetto dell'audit
  // periodico). Deliberatamente NON filtrato dai filtri di header: è un allarme
  // sull'integrità della board, non una vista.
  const unlandedTasks = useMemo(
    () => tasks.filter(showsLandingDebt),
    [tasks],
  );

  const { worktreeCount, gcRunning, branchInv, gcResult, runGc } = useWorktreeStatus(projectPath, global);
  // `kanbanOrder` è una chiave PER BOARD: nella board generale i numeri vengono
  // da sequenze indipendenti e non si confrontano. Lo scope lo dice al
  // comparatore (e a `planDrop`, che lì non scrive posizioni).
  const orderScope: OrderScope = mode === 'all' ? 'cross-project' : 'board';

  const byStatus = useMemo(() => {
    const visible = tasks.filter((task) => taskMatchesFilters(task, filters));
    return groupByStatus(visible, orderScope);
  }, [tasks, filters, orderScope]);

  /**
   * LA FIRMA DELLE COLONNE, e serve al movimento.
   *
   * Il lampo dice DOVE guardare, ma non lega le due posizioni: una card che
   * cambia stato spariva da una colonna e riappariva in un'altra nello stesso
   * fotogramma. Adesso ci VIAGGIA, e le vicine le fanno spazio (vedi
   * `useBoardMotion` e `lib/boardFlight`).
   *
   * Questa stringa e' il segnale che qualcosa PUO' essersi mosso: chi c'e', in
   * che colonna, in che ordine. Non basta guardare `tasks`, perche' la board
   * ri-renderizza ogni 4 secondi per far girare i contatori delle card al
   * lavoro, e ogni giro costerebbe una misura di tutti i rettangoli.
   */
  // The cards of each workflow column: a status's cards split by their stage.
  const byColumn = useMemo(() => {
    const out = new Map<string, BoardTask[]>(boardColumns.map((c) => [c.id, []]));
    for (const s of TASK_STATUSES) {
      for (const t of byStatus[s]) {
        const col = columnOfTask(boardColumns, t);
        if (col) out.get(col.id)?.push(t);
      }
    }
    return out;
  }, [byStatus, boardColumns]);

  const motionKey = useMemo(
    () => TASK_STATUSES.map((s) => byStatus[s].map((t) => t.id).join(',')).join('|'),
    [byStatus],
  );
  // Le card che hanno appena cambiato COLONNA, e in quale sono arrivate: il
  // lampo prende il colore di quella colonna, quindi qui serve la destinazione,
  // non solo l'elenco. Si guarda `tasks` (la lista grezza), non `byStatus`: un
  // filtro attivo può nascondere la card, e il lampo non deve dipendere da cosa
  // si sta guardando — quando riappare l'ha già consumato, che è giusto, ma la
  // transizione resta registrata una volta sola.
  //
  // Vale per OGNI via di spostamento, perché nessuna passa di qui direttamente:
  // il trascinamento, l'approvazione dal drawer, un agente che consegna e un
  // altro device finiscono tutti nello stesso refetch. Il confronto è con lo
  // stato precedente (vedi `lib/columnFlash`), non con la freschezza di una data.
  const [justMoved, setJustMoved] = useState<Map<string, TaskStatus>>(() => new Map());
  const prevStatusRef = useRef<Map<string, TaskStatus> | null>(null);
  const flashTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const landed = landedInColumn(prevStatusRef.current, tasks);
    prevStatusRef.current = statusSnapshot(tasks);
    if (landed.size === 0) return;
    setJustMoved((prev) => {
      const next = new Map(prev);
      // Due passaggi in meno di 2,4 s (todo → in corso → review, un agente
      // veloce): vince l'ULTIMO, ed è giusto — il colore che si vede è quello
      // della colonna dove la card è adesso, non di quella da cui è ripartita.
      for (const [id, status] of landed) next.set(id, status);
      return next;
    });
    for (const [id] of landed) {
      clearTimeout(flashTimers.current.get(id));
      flashTimers.current.set(id, setTimeout(() => {
        flashTimers.current.delete(id);
        setJustMoved((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      }, COLUMN_FLASH_MS));
    }
  }, [tasks]);
  // Smontando la pane a lampo acceso i timer resterebbero appesi a chiamare un
  // setState su un componente che non c'è più.
  useEffect(() => {
    const timers = flashTimers.current;
    return () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); };
  }, []);

  // …e portare Done DOVE SI GUARDA. Il lampo da solo non bastava: nel layout
  // normale — sidebar più cinque colonne, con Review più larga delle altre —
  // Done sta oltre il bordo destro. Misurato: a 1600×900 il bordo destro della
  // card appena chiusa cadeva a 2195px, cioè quasi 600 fuori dalla finestra. La
  // card arrivava, lampeggiava e si spegneva senza che nessuno la vedesse.
  //
  // Si scorre la riga delle colonne per la sua PROPRIA `scrollLeft`, mai
  // `element.scrollIntoView()`: la sua risalita automatica degli antenati può
  // uscire da questa preoccupazione (orizzontale) e portarsi dietro un antenato
  // verticale — vedi la nota sull'effetto della selezione qui sopra.
  //
  // Solo per DONE, anche adesso che il lampo vale per ogni colonna: gli altri
  // passaggi li fa quasi sempre la mano di chi guarda (un drag finisce dove
  // l'occhio è già), mentre chiudere si fa da un bottone e la colonna in cui la
  // card atterra è dall'altra parte della board. Inseguire ogni transizione
  // vorrebbe dire strappare via la colonna che si sta leggendo a ogni evento di
  // un agente.
  useEffect(() => {
    if (![...justMoved.values()].includes('done')) return;
    // rAF: l'effetto parte nello stesso commit in cui la card entra in colonna,
    // e il rettangolo di Done va misurato a layout fatto.
    const raf = requestAnimationFrame(() => {
      const container = columnsScrollRef.current;
      const col = container?.querySelector('[data-testid="kanban-column-done"]');
      if (!container || !col) return;
      const cRect = container.getBoundingClientRect();
      const dRect = col.getBoundingClientRect();
      if (dRect.left >= cRect.left && dRect.right <= cRect.right) return; // già in vista
      container.scrollBy({ left: dRect.right - cRect.right, behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(raf);
  }, [justMoved]);

  // …e lo stesso all'altro capo: la card appena creata va PORTATA A SCHERMO.
  // Il lampo da solo non basta per la nascita ancora meno che per la chiusura —
  // un task nuovo prende `kanban_order = max + 1`, cioè atterra in FONDO alla
  // colonna, che su una colonna piena è già fuori dal corpo scrollabile; e se la
  // colonna di destinazione è a sua volta oltre il bordo della riga, la card
  // nasce, lampeggia e si spegne in un pezzo di DOM che nessuno sta guardando.
  //
  // DUE assi, DUE contenitori distinti, ed è il punto: la riga delle colonne
  // scorre in orizzontale, il corpo della colonna in verticale. `scrollIntoView`
  // li farebbe entrambi da sola — ma anche parecchi altri, risalendo gli
  // antenati fin dove non deve (vedi la nota sull'effetto della selezione).
  // Quindi ognuno per la sua `scrollBy`, con il delta calcolato da `scrollDelta`.
  //
  // In orizzontale si inquadra la COLONNA, non la card: sono `snap-center` e
  // portare a filo la sola card lascerebbe la colonna tagliata a metà. In
  // verticale la card, che è esattamente ciò che si vuole leggere.
  useEffect(() => {
    if (!scrollTarget) return;
    // La card entra nel DOM solo quando il refetch ha rimpiazzato `tasks`: fino
    // ad allora questo effetto non trova niente e riprova al giro dopo. Se un
    // filtro attivo la tiene fuori, non arriva nessun giro — ci pensa la
    // scadenza qui sotto a non lasciare un bersaglio appeso.
    if (!tasks.some((t) => t.id === scrollTarget)) return;
    // DUE frame, non uno. L'effetto parte nello stesso commit in cui la card
    // entra in colonna, e i rettangoli vanno letti a layout FATTO — ma il primo
    // frame non basta: la card esiste già e la colonna sta ancora assestando la
    // propria altezza (chip, anteprime, il resto del contenuto della card che
    // prende posto). Misurato lì, il rettangolo era ~55px più in alto del vero,
    // lo scorrimento partiva corto di altrettanto e la card si fermava dietro al
    // composer una volta su due — un rosso a intermittenza che non parlava del
    // meccanismo ma di QUANDO lo si era interrogato. Il secondo frame legge
    // numeri che non si muovono più, e lo scorrimento morbido parte una volta
    // sola dalla posizione giusta.
    let raf2 = 0;
    // Vive OLTRE questo effetto: la sorveglianza qui sotto continua dopo che
    // `setScrollTarget(null)` ha fatto ripulire l'effetto, quindi il suo
    // spegnimento sta in un ref e non nel cleanup del turno.
    const raf = requestAnimationFrame(() => { raf2 = requestAnimationFrame(() => {
      const row = columnsScrollRef.current;
      const card = row?.querySelector(`[data-task-card="${CSS.escape(scrollTarget)}"]`);
      setScrollTarget(null);
      if (!row || !card) return;
      const cardRect = card.getBoundingClientRect();
      const column = card.closest('[data-testid^="kanban-column-"]');
      if (column) {
        const rowRect = row.getBoundingClientRect();
        const colRect = column.getBoundingClientRect();
        const dx = scrollDelta({ start: rowRect.left, end: rowRect.right }, { start: colRect.left, end: colRect.right });
        if (dx !== 0) {
          // Quanto scorrere non è «il minimo per rientrare»: la riga è un
          // carosello `snap-x snap-mandatory`, e i suoi punti di riposo sono le
          // colonne CENTRATE. Chiedendo il minimo, lo snap corregge di sua
          // iniziativa verso il punto più vicino — che è la colonna ACCANTO — e
          // quella appena inquadrata torna fuori, tagliata dal lato da cui era
          // arrivata. Quindi si chiede direttamente una posizione che lo snap
          // accetta: la colonna al centro. `scrollDelta` qui decide SE muoversi,
          // non di quanto. Una colonna più larga della riga (Review in una pane
          // stretta) non ha un centro utile: lì vale il minimo, e lo snap si
          // rilassa da solo perché nessun punto di riposo la conterrebbe.
          const centered = (colRect.left + colRect.right - rowRect.left - rowRect.right) / 2;
          row.scrollBy({ left: colRect.width >= rowRect.width ? dx : centered, behavior: 'smooth' });
        }
      }
      const body = card.closest('[data-testid^="kanban-column-body-"]');
      if (body) {
        const bodyRect = body.getBoundingClientRect();
        // Il fondo UTILE della colonna non è il suo bordo inferiore. Il composer
        // («Descrivi un task per l'agent…») è un overlay ancorato in basso
        // sull'area della board, e la fascia che copre è esattamente dove un
        // task nuovo atterra: prende `kanban_order = max + 1`, quindi va in
        // fondo alla colonna. Fermarsi al bordo mette la card appena creata
        // DIETRO al riquadro in cui l'hai scritta — rettangolo giusto, e non la
        // vedi. È lo stesso motivo per cui il corpo colonna porta `pb-16`.
        //
        // Il composer si MISURA invece di ricopiarne l'altezza in una costante:
        // cresce col testo, si alza quando è a fuoco, e sparisce del tutto in
        // alcuni stati (`hidden`, drawer a tutto schermo sotto lg) — un numero
        // fisso sarebbe sbagliato in tutti e tre i casi. Nascosto ha un rect di
        // zeri, ed è l'unico caso da scartare: `height > 0`.
        //
        // NIENTE test di sovrapposizione orizzontale, per quanto sembri la cosa
        // giusta da fare. Qui siamo in un rAF che parte quando la card entra nel
        // DOM: lo scorrimento orizzontale è stato CHIESTO due righe sopra, ma è
        // morbido e non è ancora avvenuto, quindi la colonna sta ancora dov'era
        // — fuori schermo, che è tutto il motivo per cui la stiamo spostando.
        // Un `compRect.left < bodyRect.right` letto in quell'istante confronta
        // il composer con una posizione che sta per non esistere più e risponde
        // sempre «non si sovrappongono»: misurato, la card tornava esattamente a
        // `bordo - 8`, cioè dietro al composer. E la domanda è comunque oziosa,
        // perché la colonna la stiamo CENTRANDO — cioè portando esattamente
        // dove il composer, anche lui centrato, sta.
        const usableBottom = () => {
          const composer = document.querySelector('[data-testid="board-task-composer"]');
          const compRect = composer?.getBoundingClientRect();
          const covers = !!compRect && compRect.height > 0;
          return covers ? Math.min(body.getBoundingClientRect().bottom, compRect.top) : body.getBoundingClientRect().bottom;
        };
        // Un filo di margine: appoggiata al bordo la card è tecnicamente in
        // vista e sembra tagliata.
        const dy = scrollDelta({ start: bodyRect.top, end: usableBottom() }, { start: cardRect.top, end: cardRect.bottom }, 8);
        if (dy !== 0) body.scrollBy({ top: dy, behavior: 'smooth' });
        // …e poi si RESTA liberi, perché il composer che abbiamo appena misurato
        // non ha ancora l'altezza che avrà. Il gesto che crea la card è un invio
        // DAL composer: quello si svuota, la sua textarea torna a una riga e
        // subito dopo riprende il fuoco e si riapre (`min-h-[4.5rem]`, più il
        // mezzo passo di `-translate-y-2`) con una transizione di 200ms. I due
        // frame di attesa qui sopra cadono dentro quella transizione, non dopo:
        // misurato, il bordo superiore del composer passava da 625 a 578 — 47px
        // di fascia coperta in più — e la card, parcheggiata correttamente sopra
        // al 625 di allora, finiva dietro al riquadro in cui l'avevi scritta.
        // La corsa non c'entrava: `pb-36` lasciava ancora 91px di scorrimento
        // inutilizzato.
        //
        // Quindi la posizione non si decide una volta sola: si ricontrolla a
        // ogni cambio di misura di composer e card, finché dura il lampo. Solo
        // in DISCESA (`d > 0`): risalire vorrebbe dire riprendersi lo
        // scorrimento che intanto ha fatto chi guarda.
        const ro = new ResizeObserver(() => {
          const c = card.getBoundingClientRect();
          const d = scrollDelta({ start: body.getBoundingClientRect().top, end: usableBottom() }, { start: c.top, end: c.bottom }, 8);
          if (d > 0) body.scrollBy({ top: d, behavior: 'smooth' });
        });
        const composerEl = document.querySelector('[data-testid="board-task-composer"]');
        if (composerEl) ro.observe(composerEl);
        ro.observe(card);
        keepClearRef.current?.();
        let stop = 0 as unknown as ReturnType<typeof setTimeout>;
        keepClearRef.current = () => { clearTimeout(stop); ro.disconnect(); keepClearRef.current = null; };
        stop = setTimeout(() => keepClearRef.current?.(), CREATED_FLASH_MS);
      }
    }); });
    return () => { cancelAnimationFrame(raf); cancelAnimationFrame(raf2); };
  }, [scrollTarget, tasks]);
  // Un bersaglio che non atterra (filtro attivo, creazione in un'altra board)
  // non resta armato per sempre: scorrere mezzo minuto dopo sarebbe uno
  // strattone che non risponde a niente di quello che stai facendo ORA.
  useEffect(() => {
    if (!scrollTarget) return;
    const t = setTimeout(() => setScrollTarget(null), CREATED_FLASH_MS);
    return () => clearTimeout(t);
  }, [scrollTarget]);

  // Task lookup by id for the parent chip ("⤴ epic…"). Best effort: a parent
  // not in the current fetch just shows the generic label.
  //
  // Il chip «in attesa di» NON passa più di qui: il bloccante lo risolve il
  // server (`task.blockedBy`), perché questa lista è un progetto solo,
  // `rootsOnly`, non archiviati — e un bloccante fuori da quel taglio faceva
  // sparire il chip da una card che il dispatcher teneva ferma comunque.
  const tasksById = useMemo(() => {
    const m = new Map<string, BoardTask>();
    for (const t of tasks) m.set(t.id, t);
    return m;
  }, [tasks]);

  // Project path index, only needed in the cross-project board (per-card
  // favicon — task.projectId is a one-way hash, ProjectFavicon needs a path).
  // Dallo store CONDIVISO: card, filtro e composer devono vedere lo stesso
  // indice nello stesso istante, altrimenti l'icona compare su una superficie
  // e non sull'altra a seconda di chi ha fetchato prima.
  const projectIndex = useBoardProjectLabels(mode === 'all');
  const projectPathById = useMemo(
    () => new Map((projectIndex ?? []).map((p) => [p.projectId, p.path])),
    [projectIndex],
  );

  // ONE LANE PER PROJECT, only on the cross-project board (a project board has
  // one project, its lane would be the board itself). Split after the columns
  // (`splitIntoLanes`), so a lane keeps the board's order inside each column.
  const grouped = mode === 'all' && groupByPref === 'project';
  // The archive view keeps every column: what was closed is what it is there to show.
  const shownColumns = useMemo(() => (showDone || showArchived ? boardColumns : boardColumns.filter((c) => c.base !== 'done')), [boardColumns, showDone, showArchived]);
  const columnIds = useMemo(() => boardColumns.map((c) => c.id), [boardColumns]);
  const { lanes, draftPlacement, draftLane, laneNameById } = useProjectLanes({
    grouped, showArchived, draft, tasks, byColumn, columnIds, projectIndex,
  });

  // Il movimento della board si aggancia qui: misura le colonne quando la firma
  // cambia e anima chi si e' spostato. Mentre una card e' IN MANO non anima
  // niente (comanda dnd-kit, che sta gia' muovendo gli stessi nodi), e la card
  // appena lasciata la salta del tutto, perche' e' gia' arrivata dov'e' col
  // dito: vedi `skipFlight` in `onDragEnd`.
  const skipFlight = useBoardMotion(columnsScrollRef, motionKey, activeId === null);
  // Hide the floating "Descrivi un task" composer while the human is typing in
  // a field that SITS ON IT: a card's quick-reply / "Scrivi all'agent" box,
  // which opens low in a column, right under the composer.
  //
  // Il gate è ristretto alle COLONNE della board. Prima il listener era su
  // `window` e il predicato «un campo qualsiasi ha il fuoco»: mettere il cursore
  // nella chat di un'altra pane, in un terminale o in una ricerca faceva sparire
  // il composer di qua — un focus-out dalla board non sovrappone proprio niente.
  const [typingElsewhere, setTypingElsewhere] = useState(false);
  useEffect(() => {
    const sync = () => {
      const el = document.activeElement as HTMLElement | null;
      const isField = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
      // Solo i campi DENTRO il carosello delle colonne si sovrappongono al
      // composer. Il composer stesso e i menu portalati su <body> ne sono fuori
      // per costruzione, quindi non serve escluderli a mano.
      const inColumns = !!el && !!columnsScrollRef.current?.contains(el);
      setTypingElsewhere(isField && inColumns);
    };
    window.addEventListener('focusin', sync);
    window.addEventListener('focusout', sync);
    return () => { window.removeEventListener('focusin', sync); window.removeEventListener('focusout', sync); };
  }, []);
  const { sensors, onDragStart, onDragEnd } = useBoardDrag({
    tasks, byStatus, boardColumns, grouped, orderScope, setActiveId, setDropNotice, setPendingWrites,
    onCardError, patchTask, refetch, beginDrag, endDrag, flushDeferredRead, holdColumnsSnap, skipFlight,
  });
  const activeTask = activeId ? tasks.find((t) => t.id === activeId) ?? null : null;
  // The Plan draws the board's own card, compact: one card, two views (Plan + Kanban).
  const renderPlanCard = useCallback((taskId: string) => {
    const t = tasksById.get(taskId);
    if (!t) return null;
    return (
      <Card
        task={t} onOpen={openTask} showProject={false} onRefetch={refetch} onOpenTopic={onOpenTopic}
        error={cardError?.taskId === t.id ? cardError.message : null}
        onError={onCardError}
        sessionState={resolveSession(t.assignedTopicId)}
        paneBoardId={projectId}
        paneSettings={settings}
        projectPath={projectPathById.get(t.projectId)}
        live={liveUsage.get(t.id)}
        awaiting={awaitingHuman.has(t.id) || !!t.awaitingAnswer}
        density="compact"
      />
    );
  }, [tasksById, openTask, refetch, onOpenTopic, cardError, onCardError, resolveSession, projectId, settings, projectPathById, liveUsage, awaitingHuman]);
  // One workflow column, on the flat board or inside a project lane.
  const renderColumn = (
    { id: columnKey, base: status, label: columnLabel }: (typeof boardColumns)[number],
    columnTasks: BoardTask[],
    lane?: BoardLane,
  ) => (
    <Column
      key={lane ? laneDropId(columnKey, lane.projectId) : columnKey}
      dropId={lane ? laneDropId(columnKey, lane.projectId) : undefined}
      inLane={!!lane}
      status={status}
      columnId={columnKey === status ? undefined : columnKey}
      label={columnKey === status ? undefined : columnLabel}
      tasks={columnTasks}
      onOpen={openTask}
      onCreate={(text) => create(status, text)}
      canCreate={mode === 'project' && !showArchived}
      // In a lane the header already names the project: the eyebrow would repeat it on every card.
      showProject={mode === 'all' && !lane}
      layout={boardLayout}
      viewKey={`${mode === 'all' ? 'all' : projectId}:${showArchived ? 'archive' : 'live'}${lane ? `:${lane.projectId}` : ''}`}
      cardError={cardError}
      onCardError={onCardError}
      onRefetch={refetch}
      onOpenTopic={onOpenTopic}
      paneBoardId={projectId}
      paneSettings={settings}
      resolveSession={resolveSession}
      tasksById={tasksById}
      projectPathById={projectPathById}
      liveById={liveUsage}
      awaitingHuman={awaitingHuman}
      justMoved={justMoved}
      justCreated={justCreated}
      archived={showArchived}
      onOpenSettings={toggleSettings}
      draft={draft && draft.status === status && !showArchived && columnOfTask(boardColumns, { status })?.id === columnKey
        && (!lane || lane.projectId === draftLane) ? draft : undefined}
    />
  );

  const dragPreview = useDragPreview(activeTask, mode, projectIndex);
  const create = useCallback(async (status: TaskStatus, text: string) => {
    // A task can't be created directly in Done — land it in Todo instead.
    // In Progress is the same story for a different reason (`manualStatusTarget`):
    // a task being born has no agent by definition, so writing it straight into
    // In Progress creates it already stuck. This is the second of the three
    // doors, and it is the worst of them, because a card that was never
    // dispatched has nothing on it to explain why nobody picks it up.
    const aim = manualStatusTarget(status === 'done' ? 'todo' : status, null);
    // L'id arriva dalla POST, non dal broadcast: è quello che distingue «l'ho
    // creato io» da «è comparso», e solo il primo autorizza a muovere la board.
    try {
      const created = await boardApi.create(projectId, { text, status: aim.status });
      if (aim.redirectedFrom === 'in_progress') setDropNotice(tr('board.drop.inProgressRedirected'));
      onCreatedHere(created.id);
    } catch (e) { setError(e instanceof Error ? e.message : 'create failed'); }
  }, [projectId, onCreatedHere, tr]);

  // Il task che il drawer mostra quando l'id NON è nel feed. Il feed è
  // `rootsOnly` — le colonne mostrano le radici, gli step vivono nell'albero del
  // genitore — quindi un id di SOTTOTASK non ci sarà mai, e `tasks.find(...)` da
  // solo restituiva `undefined`: il click su uno step CHIUDEVA il drawer invece
  // di aprirlo, e un deep-link `/task/<id-di-sottotask>` restava appeso per
  // sempre. Lo risolve `boardApi.resolve`, la porta unica «da un id al suo task,
  // a qualunque profondità».
  const [outsider, setOutsider] = useState<BoardTask | null>(null);
  const selected = tasks.find((t) => t.id === selectedId)
    || (outsider && outsider.id === selectedId ? outsider : null);
  // The drawer's entrance and exit, and the carousel snap held across the width
  // change it causes (see `useDrawerPresence`). `drawerTask` is `selected`, or
  // the task still fading out after a close.
  const drawerHostRef = useRef<HTMLDivElement>(null);
  const { shown: drawerTask } = useDrawerPresence(selected, drawerHostRef, columnsSnap);

  // The drawer judges a card (its routing switch, the model the dispatcher
  // runs on Auto) with its own board's defaults. In the all-boards view that
  // board can be another than this pane's, whose settings are loaded above.
  const cardSettings = useCardBoardSettings(selected?.projectId, projectId, settings);

  // L'id che il drawer deve mostrare: la selezione, o il deep-link ancora in
  // volo. Uno solo dei due è valorizzato nel caso normale.
  const wantId = selectedId ?? pendingSelect;
  const inFeed = !!wantId && tasks.some((t) => t.id === wantId);

  // Promote a deep-link target to the selection once the task lands in the
  // loaded list (the global board loads every project's tasks, so it will).
  useEffect(() => {
    if (!pendingSelect) return;
    if (tasks.some((t) => t.id === pendingSelect)) promote(pendingSelect);
  }, [pendingSelect, promote, tasks]);

  // Un id fuori dal feed passa comunque: la porta unica lo risolve e il drawer
  // si apre. Rigira a ogni cambio di `tasks` — la board rifetcha su ogni evento
  // `task:*`, quindi è anche il battito che tiene fresco `updatedAt` (il `bump`
  // con cui il drawer ricarica il suo thread) per un task che nel feed non c'è.
  const resolvedRef = useRef<{ id: string; feed: readonly BoardTask[] } | null>(null);
  useEffect(() => {
    if (!wantId) { setOutsider(null); resolvedRef.current = null; return; }
    if (inFeed) return; // il feed ce l'ha: nessuna porta da aprire
    // Una sola richiesta per (id, feed): sciogliere il deep-link cambia
    // `pendingSelect`, e senza questo la rifarebbe subito a vuoto.
    if (resolvedRef.current?.id === wantId && resolvedRef.current.feed === tasks) return;
    resolvedRef.current = { id: wantId, feed: tasks };
    // Vero solo se stiamo sciogliendo un deep-link, non un click su uno step:
    // `topics:task-opened` rilascia l'intento di fuoco della board, e va emesso
    // per quello e basta.
    const deepLink = pendingSelect === wantId;
    let alive = true;
    boardApi.resolve(wantId)
      .then((t) => {
        if (!alive) return;
        if (t) {
          setOutsider(t);
          if (deepLink) promote(wantId);
          return;
        }
        // Quell'id non esiste: chiudere è l'unica risposta onesta — restare
        // appesi in attesa di un task che non arriverà è il guasto di prima.
        // E il vicolo cieco va DETTO: `topics:task-opened` non significa «il
        // drawer si è aperto», significa «la corsa del deep-link è finita».
        // Senza questa riga l'intento di fuoco restava armato e riportava la
        // finestra sulla board a ogni mutazione dello store, per tutta la
        // sessione.
        if (deepLink) {
          setPendingSelect(null);
          window.dispatchEvent(new CustomEvent('topics:task-opened'));
          // AND IT IS SAID. Until this card the dead end was mute: the drawer
          // did not open, `reflectTaskClose` wiped the path a heartbeat later,
          // and what had been asked for left no trace at all. `notify` was
          // wired for every other kind of permalink and never reached this
          // branch, because `case 'task'` of `openTabInApp` hands the route to
          // the board instead of resolving it itself.
          toast.warning(DEAD_TAB_MESSAGE);
        }
        setSelectedId((s) => (s === wantId ? null : s));
      })
      .catch(() => {
        resolvedRef.current = null; /* trasporto caduto: il prossimo refetch riprova */
        // Il refetch riproverà ad aprire il drawer, ma l'intento di fuoco no:
        // quello si rilascia comunque, perché una rete caduta non è una buona
        // ragione per tenere l'utente inchiodato alla board.
        if (deepLink) window.dispatchEvent(new CustomEvent('topics:task-opened'));
      });
    return () => { alive = false; };
    // `outsider` fuori dalle dipendenze di proposito: lo SCRIVE questo effetto.
  }, [wantId, inFeed, tasks, pendingSelect, setPendingSelect, setSelectedId, promote, toast]);

  // URL ⇄ drawer reflection (GLOBAL board only — `/task/<id>` points at the
  // global board, matching buildTaskLink). Opening a drawer pushes `/task/<id>`;
  // closing it returns to '/' — so every open drawer has a copyable,
  // refresh-survivable URL and Back closes it. While a deep-link is still
  // resolving (pendingSelect set, task not yet loaded) leave the URL alone so
  // the incoming path isn't wiped before the drawer opens.
  //
  // ONLY WHILE THE BOARD IS THE TAB ON SCREEN. Reported 2026-09-03: drawer open,
  // switch to a project tab, reload: back on the kanban. The `/task/<id>` had
  // stayed in the URL after the switch, and the boot read it as a deep-link.
  // So the focus of the global board pane is part of what the URL mirrors: on
  // losing it the path goes back to '/', on regaining it the open drawer is
  // written again — both by REPLACING the entry, because changing tab is not a
  // navigation Back should walk through. Focus is device-local, so a detached
  // window mirrors its own board, not another window's.
  const boardFocused = usePaneStore((s) => parseUtilityPanelType(s.focusedPaneId ?? '') === 'board');
  const wasBoardFocused = useRef(boardFocused);
  useEffect(() => {
    if (!global) return;
    const focusChanged = wasBoardFocused.current !== boardFocused;
    wasBoardFocused.current = boardFocused;
    if (!boardFocused) {
      if (currentTaskTarget()) reflectTaskFocus(null);
      return;
    }
    if (selected) {
      if (focusChanged) reflectTaskFocus({ taskId: selected.id }, selected.text);
      else reflectTaskOpen({ taskId: selected.id }, selected.text);
      return;
    }
    if (pendingSelect) return; // deep-link mid-flight — keep the URL
    reflectTaskClose();
    // Depend on selectedId (primitive), NOT the `selected` object: its reference
    // churns on every board refetch while the id is what actually gates the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [global, selectedId, pendingSelect, boardFocused]);

  // Back/forward drive the drawer from history: the value-equality guard in
  // reflect* means setting the selection here won't re-push a duplicate entry.
  useEffect(() => {
    if (!global) return;
    return subscribePopstateTask((target) => setSelectedId(target?.taskId ?? null));
  }, [global, setSelectedId]);

  useEffect(() => {
    const el = toolbarScrollRef.current;
    if (!el) return;
    const update = () => {
      setToolbarOverflowRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [tasks, filters, mode, unlandedTasks.length]);

  if (loading) {
    // The same skeleton the lazy chunk shows (`LazyPane kind="board"`): the
    // toolbar strip and the five columns at their real geometry, so the chunk
    // wait and the first read are one continuous shape, not a ring in an empty
    // pane followed by the whole board in one frame.
    return <BoardSkeleton layout={boardLayout} />;
  }

  return (
    // `reveal-in`: la board non compare di scatto al posto dell'anello. Il
    // nodo nasce quando `loading` si spegne, quindi la dissolvenza parte una
    // volta sola, al montaggio, e non a ogni ridisegno. Solo opacita': muovere
    // le colonne mentre appaiono le farebbe leggere come se stessero arrivando
    // da qualche parte, e non arrivano da nessuna parte.
    <div className="reveal-in relative flex h-full flex-col overflow-hidden" data-testid="kanban-board">
      {/* Header: a project/all toggle inside a project, a static label globally.
          On phone the toolbar is too dense to fit — it becomes a single
          horizontally-scrollable strip (no wrap, hidden scrollbar) so nothing is
          clipped; on desktop it sits inline with the trailing actions ml-auto'd.
          The fade+chevron below is the mobile-only affordance that the strip
          continues past the right edge — it tracks live scroll position and
          disappears once fully scrolled. */}
      {/* Nessun filetto sotto la barra: la board sotto e' gia' un'altra cosa
          (colonne su fondo diverso), e la riga in piu' disegnava un confine che
          si vedeva gia' da solo. Le strisce che compaiono sotto (errore,
          archivio, impostazioni) portano il proprio bordo quando servono. */}
      <div className="relative shrink-0">
      {/* `overflow-y-hidden`: a bar is fixed chrome and never scrolls vertically
          (KANBAN-MOBILE-01). `overflow-x: auto` alone turns the other axis into
          `auto` as well (CSS Overflow 3), so any child reaching past the 36px
          row - the 44px area `.tap-expand` projected around a 24px glyph under
          a finger - made the bar scroll up and down by 4px on a phone. */}
      <div ref={toolbarScrollRef} data-testid="board-toolbar" className="flex items-center gap-1 overflow-x-auto overflow-y-hidden px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 coarse:py-1 sm:px-3">
        {/* Inside a project the two buttons are a CHOICE, so they stay. On the
            general board there used to be a static label here saying which board
            this is: the tab that carries the pane already says it, in the same
            window, a centimetre away. A title that repeats its own tab is not
            information, it is width taken from the filters.

            The spend chip ($x.xx / 24h) stood next to it and is gone for the
            same reason it was easy to remove: it was a READING, not a control.
            The figure, the total, the unpriced share and the caps live together
            in the gear panel (`SpendCapControl`), which is also the only place
            where the number can be acted upon. */}
        {canToggle && (
          <>
            <button
              onClick={() => setMode('project')}
              className={`flex ${TOOLBAR_CONTROL_H} items-center rounded px-2 text-compact leading-4 ${mode === 'project' ? 'bg-white/15 text-app-text' : 'text-app-text-secondary hover:bg-white/5'}`}
            >{tr('board.toolbar.thisProject')}</button>
            <button
              onClick={() => setMode('all')}
              className={`flex ${TOOLBAR_CONTROL_H} items-center rounded px-2 text-compact leading-4 ${mode === 'all' ? 'bg-white/15 text-app-text' : 'text-app-text-secondary hover:bg-white/5'}`}
            >{tr('board.toolbar.allProjects')}</button>
          </>
        )}
        {mode === 'all' && <button type="button" data-testid="board-plan-toggle" aria-pressed={planVisible}
          onClick={() => setPlanVisible((v) => !v)}
          className={`flex ${TOOLBAR_CONTROL_H} items-center rounded px-2 text-compact leading-4 ${planVisible ? 'bg-white/15 text-app-text' : 'text-app-text-secondary hover:bg-white/5'}`}
        >{tr(planVisible ? 'plan.buttonBack' : 'plan.button')}</button>}
        <LoadAdviceChip />
        <WorktreeControl
          count={worktreeCount}
          branches={branchInv}
          gcRunning={gcRunning}
          gcResult={gcResult}
          onGc={runGc}
        />
        {/* `grow`: la barra dei filtri è anche il posto in cui vive lo spazio
            libero della riga. Quando ce n'è, i progetti ci diventano chip; se
            manca, la striscia resta a zero e restano nel menu — senza che i
            filtri veri perdano un pixel (vedi la nota dentro `InlineFilters`). */}
        <div className="ml-2 flex min-w-0 grow items-center">
          <InlineFilters filters={filters} onFiltersChange={setFilters} tasks={tasks} mode={mode} />
        </div>
        {/* THE ALTERNATIVE TO THE CLASSIC KANBAN, next to the search: one
            button that swaps side-by-side columns for stacked sections (see
            `boardLayout` above and `layout` on `Column`). Same spot, same
            style as the archive toggle below — not a second menu. */}
        <DetailSlider value={detail} onChange={setDetail} />
        <BoardViewToggles
          canGroup={mode === 'all'}
          groupBy={groupByPref} onGroupBy={setGroupByPref}
          showDone={showDone} onShowDone={setShowDone}
        />
        <div className="ml-auto flex items-center gap-2">
          {hasProject && mode === 'project' && <ScheduledCardsControl projectId={projectId} />}
          {/* THE COUNT IS GONE (asked on 29/08): in "all" mode the toggle two
              controls to the left already says which scope you are in, and the
              readout restated it in words next to a number nobody acts on. A
              board that has to tell you what it is showing is a board whose
              controls are not reading. */}
          {/* (Qui stava il chip delle sessioni Claude avviate a mano in un
              terminale, col suo «Continua qui» che le adottava in una topic.
              Tolto su richiesta di Attilio il 13/08: in barra era un numero che
              non chiedeva niente a chi lo leggeva, e il gesto che valeva era
              nascosto dentro il popover. Il censimento resta lato server: lo
              legge il dispatcher per avvertire quando si sta per landare su un
              repo dove qualcun altro sta lavorando.) */}
          {/* L'auto-dispatch (e il tetto) stanno nel pannello del ⚙: una sola porta. */}
          {canRunMissions && (
            <MissionsMenu onStart={(m) => setError(onStartMission!(m))} />
          )}
          {global && orchestrator && (
            <button
              type="button"
              data-testid="board-open-orchestrator"
              aria-pressed={!!orchestratorTopic}
              onClick={() => { if (orchestratorTopic) closeOrchestrator(); else void openOrchestrator(); }}
              disabled={openingOrchestrator}
              title={tr('board.orchestrator.openTitle')}
              aria-label={tr('board.orchestrator.open')}
              // The row's height like every other control (KANBAN-12): with
              // `py-0.5` it was 21px tall, and under a finger the 44px band its
              // `.tap-expand-y` projected ran over the layout toggle beside it.
              className={`flex ${TOOLBAR_CONTROL_H} items-center gap-1 rounded px-2 text-mini disabled:cursor-wait disabled:opacity-60 ${
                orchestratorTopic ? 'bg-white/15 text-app-text' : 'text-app-text-secondary hover:bg-white/10 hover:text-app-text'
              }`}
            >
              {/* THE NOTES, not the speech bubble. The bubble said "you can
                  type here", which in this app is true of every surface; the
                  notes say this is the one that CONDUCTS the others.
                  This button and the drawer header are the two places the glyph
                  is actually drawn: measured 2026-09-10, `Topic.icon` reaches no
                  other chrome in this app — the sidebar row and the tab strip
                  draw no per-topic glyph for a chat — so the coordinator's own
                  identity lives here, not in that field. */}
              <Music4 className="h-3 w-3 shrink-0" />
              <span>{openingOrchestrator ? tr('board.orchestrator.opening') : tr('board.orchestrator.open')}</span>
            </button>
          )}
          {/* UN controllo per i due gradini della consegna: «non su main» e «su
              main ma non pubblicato». Erano due bottoni adiacenti, e da fuori si
              leggevano come lo stesso allarme scritto due volte. */}
          <DeliveryControl unlanded={unlandedTasks} onOpen={setSelectedId} />
          {/* L'archivio, accanto alle impostazioni: un interruttore, come la
              lente degli archiviati in sidebar. Acceso = la board mostra ciò che
              è stato archiviato, e da lì lo si può riportare indietro. */}
          {hasProject && mode === 'project' && (
            <button
              data-testid="board-archived-toggle"
              aria-pressed={showArchived}
              onClick={() => setShowArchived((v) => !v)}
              className={`grid ${TOOLBAR_CONTROL_H} ${TOOLBAR_ICON_W} place-items-center rounded ${showArchived ? 'bg-white/15 text-primary' : 'text-app-text-secondary hover:bg-white/5'}`}
              title={showArchived ? tr('board.archive.hide') : tr('board.archive.show')}
            ><Archive className="h-3.5 w-3.5" /></button>
          )}
          {/* Beside the cap's gear: the providers whose cards wait in Todo (HUBBR-20). */}
          <span className="hidden sm:contents"><BrakeChip /></span>
          {/* On EVERY board, project or not. Without a project there are no
              per-board rows, but the machine-wide cap still applies here — and
              gating this button on `hasProject` is what left the general board
              with the ▾ as its only way to see the limit. */}
          <button
            ref={settingsBtnRef}
            onClick={toggleSettings}
            aria-expanded={showSettings}
            aria-haspopup="menu"
            className={`grid ${TOOLBAR_CONTROL_H} ${TOOLBAR_ICON_W} place-items-center rounded ${showSettings ? 'bg-white/15 text-app-text' : 'text-app-text-secondary hover:bg-white/5'}`}
            title={tr('board.toolbar.dispatchSettings')}
          ><Settings className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      {toolbarOverflowRight && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 flex w-8 items-center justify-end bg-gradient-to-l from-app-bg to-transparent sm:hidden"
          data-testid="toolbar-overflow-affordance"
        >
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-app-text-muted" />
        </div>
      )}
      </div>
      <div className="shrink-0 px-2 pb-1.5 empty:hidden sm:hidden"><BrakeChip band /></div>
      {error && <div className="shrink-0 bg-rose-500/10 px-3 py-1.5 text-compact leading-4 text-rose-300">{error}</div>}
      {/* La striscia dice DUE cose, e la seconda è quella che mancava: dove sta
          il gesto. Un archivio in cui si guarda soltanto è il punto da cui
          siamo partiti. */}
      {showArchived && mode === 'project' && (
        <div data-testid="board-archived-banner" className="flex shrink-0 items-center gap-2 bg-amber-400/10 px-3 py-1.5 text-compact leading-4 text-amber-200">
          <Archive className="h-3.5 w-3.5 shrink-0" />
          <span>{tr('board.archive.banner', { count: tasks.length, restore: taskActionWord('restore', tr).label })}</span>
          <button onClick={() => setShowArchived(false)} className="ml-auto rounded px-2 py-0.5 text-amber-100 hover:bg-white/10">{tr('board.archive.hide')}</button>
        </div>
      )}
      {/* THE SETTINGS ARE A DROPDOWN, anchored to the ⚙ (KANBAN-75), not a band
          under the bar. The band pushed every column down when it opened and
          drew the very line under the toolbar that KANBAN-12 removed; as a
          `Menu` it inherits what every other dropdown here has: flip/clamp to
          the viewport, Escape, outside-press close, one popover at a time,
          focus back on the ⚙, and the bottom sheet on the phone.
          `unmanagedFocus`: the body is a form (sliders, number fields, a
          textarea), so the arrow keys belong to the controls, not to a roving
          menu cursor. Still ONE door: this is the only thing `showSettings`
          opens, on every board, project or not. */}
      <Menu
        open={showSettings}
        anchorRef={settingsBtnRef}
        onClose={() => setShowSettings(false)}
        align="right"
        minWidth={650}
        unmanagedFocus
        ariaLabel={tr('board.settings.title')}
        testId="board-settings-menu"
      >
        {hasProject ? (
          <BoardSettingsPanel
            projectId={projectId}
            settings={settings}
            dispatchOn={dispatchOn}
            models={models}
            onToggleDispatch={toggleDispatch}
            onChanged={setSettings}
            onClose={() => setShowSettings(false)}
            onError={setError}
            tasks={tasks}
            onOpenTask={(id) => { setShowSettings(false); openTask(id); }}
            workflow={workflow}
            onWorkflowChanged={setWorkflow}
          />
        ) : (
          <GlobalOnlySettingsPanel
            dispatchOn={dispatchOn}
            onToggleDispatch={toggleDispatch}
            onClose={() => setShowSettings(false)}
            tasks={tasks}
            onOpenTask={(id) => { setShowSettings(false); openTask(id); }}
          />
        )}
      </Menu>
      {/* Board area + drawer share a flex row: an open (narrow) drawer SHRINKS
          the columns viewport instead of covering it, so every column stays
          reachable through the row's own horizontal scroll — nothing is ever
          "cut" behind the drawer. Wide mode opts back into absolute takeover
          (the drawer positions itself; out of flow, the board re-expands). */}
      <div ref={drawerHostRef} className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          {mode === 'all' && planVisible ? (
            <Suspense fallback={<SpinnerFallback fill />}>
              {/* A DndContext with no sensors: the board's card is a sortable,
                  and here nothing is dragged — the Plan moves cards with its
                  own «move to» control. */}
              <DndContext sensors={NO_SENSORS}>
                <PlanView onOpenTask={openTask} onOpenTopic={onOpenTopic} renderTaskCard={renderPlanCard} />
              </DndContext>
            </Suspense>
          ) : <>
          <DndContext sensors={sensors} collisionDetection={boardCollision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => { setActiveId(null); endDrag(); flushDeferredRead(); setDropNotice(null); }}>
            {/* NO `scroll-smooth` ON A PHONE, and that is the fix for "the
                columns jump instead of gliding" (card 1e015ad6).
                `scroll-behavior: smooth` on a scroll-snap container hands the
                post-swipe snap to the CSS scroll animation instead of leaving
                it to the browser's own fling: on a touch screen the peek of the
                neighbouring column arrived in one step. Nothing is lost by
                dropping it, because every programmatic scroll in this file
                already asks for `behavior: 'smooth'` on its own call, which is
                the only place a smooth scroll was ever wanted.

                IT STAYS ON THE WIDE VIEWPORT (`sm:`), and that is not symmetry:
                there the snap is not a carousel, it is a trap. dnd-kit scrolls
                this container while a card is being dragged towards its edge,
                and an INSTANT mandatory snap moves a whole column under a
                pointer that has not moved. Measured on 2026-09-08: a card
                dropped on In Progress landed in Review, three times out of
                three (BOARD-18), from the moment `scroll-smooth` left. The
                smoothing only slowed the jump down, and under reduced motion
                the scroll is instant again (Done, this time): the trap is now
                closed at its source, the snap is HELD while a card is in hand
                (`useRowSnapHold`, from `onDragStart`). `data-keeps-smooth-scroll`
                also keeps the smoothing under reduced motion, where the global
                rule in index.css turns every other smooth scroll into a jump. */}
            {/* List: one column scrolling vertically (sections capped at a
                48rem reading width, centred), no
                snap-carousel (there's nothing to peek at off to the side).
                The test id is the row's handle for the e2e: its snap classes
                come and go with `useRowSnapHold`, so they cannot name it. */}
            {detail === 'summary' ? (
              <ProjectsSummary
                rows={countByProject(boardColumns.map((c) => byColumn.get(c.id) ?? []))}
                columnLabels={boardColumns.map((c) => c.label ?? STATUS_LABEL[c.base])}
              />
            ) : (
            <div ref={columnsScrollRef} data-testid="kanban-columns-row" data-keeps-smooth-scroll="" className={boardLayout === 'list' || grouped
              ? COLUMNS_ROW_LIST
              : `${COLUMNS_ROW_GRID} ${columnsSnap.held ? '' : 'snap-x snap-mandatory'} sm:scroll-smooth`}>
              {grouped ? (
                <ProjectLanes
                  lanes={lanes} columns={shownColumns} layout={boardLayout}
                  nameById={laneNameById} pathById={projectPathById}
                  collapsed={collapsedProjects} onToggle={toggleProjectCollapsed}
                  draftAbove={draftPlacement?.kind === 'above' ? draft ?? undefined : undefined}
                  draftLane={draftLane}
                  renderColumn={renderColumn}
                />
              ) : shownColumns.map((column) => renderColumn(column, byColumn.get(column.id) ?? []))}
            </div>
            )}
            {/* Portal to <body>: the overlay is position:fixed, and a transformed
                ancestor (pane translateX, FLIP animations) would re-anchor fixed
                positioning to itself — the ghost card then renders far from the
                pointer. On body there is no transform above it, ever. */}
            {createPortal(
              <DragOverlay dropAnimation={null}>
                {activeTask && dragPreview ? (
                  // QUESTA È L'ANTEPRIMA DEL CONTRATTO (`lib/dragPreview`), e
                  // per questo porta `data-drag-preview`: chi legge il DOM, e i
                  // test, la trovano qui con lo stesso attributo che marca ogni
                  // altra superficie trascinabile dell'app.
                  //
                  // Il nodo però lo disegna dnd-kit, e la board NON chiama
                  // `startTouchDragPreview`. Per due ragioni, entrambe misurate.
                  // La prima: questo fantasma esiste già e segue il puntatore da
                  // solo, quindi una seconda scheda sotto lo stesso dito sarebbe
                  // il «si vede doppio» contro cui il contratto mette in
                  // guardia. La seconda: la board si trascina anche da TASTIERA
                  // (`PoliteKeyboardSensor`), e lì l'evento che apre il gesto è
                  // un `KeyboardEvent` senza `clientX`/`clientY`. Una scheda
                  // montata con quelle coordinate resterebbe piantata a 0,0
                  // mentre la card si muove altrove. È la stessa scelta già
                  // presa in `Sidebar/PinnedTile` e `Sidebar/PinnedTiles`:
                  // quando la superficie disegna già l'anteprima con la cosa
                  // VERA, quella vince sul nodo generico e il contratto si
                  // adotta marcandola.
                  //
                  // Cosa mostra, oltre al titolo: la colonna di partenza (più il
                  // progetto quando la board le tiene tutte insieme) e i badge
                  // di priorità ed etichette. Vedi il memo `dragPreview`.
                  <div
                    data-drag-preview=""
                    className="w-64 rounded-md border border-app-border bg-surface p-2.5 text-body-lg leading-5 text-app-text shadow-xl"
                  >
                    <div className="flex items-start gap-2">
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[activeTask.priority] ?? PRIORITY_DOT[2]}`} />
                      <div className="min-w-0 flex-1">
                        <div className="leading-snug">{activeTask.text}</div>
                        {dragPreview.subtitle && (
                          <div className="mt-1 truncate text-mini text-app-text-muted">{dragPreview.subtitle}</div>
                        )}
                        {dragPreview.badges.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1">
                            {dragPreview.badges.map((b) => (
                              <span key={b} className="rounded bg-white/10 px-1.5 py-0.5 text-mini text-app-text-secondary">{b}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}
              </DragOverlay>,
              document.body,
            )}
          </DndContext>
          </>}
          {/* New-task composer, anchored to the board AREA (centered on the
              visible columns). SEMPRE montato: quello che ci hai scritto dentro
              non deve evaporare perché hai guardato altrove o hai aperto un
              task. Si nasconde soltanto quando qualcosa gli sta davvero sopra —
              un campo aperto in una colonna, o (sotto lg) il drawer del task,
              che lì è un overlay a tutto schermo. Su desktop il drawer è un
              fratello in-flow accanto alle colonne: non lo copre, resta. */}
          <FloatingTaskComposer
            projectId={projectId}
            global={mode === 'all'}
            onCreated={onCreatedHere}
            onError={setError}
            hidden={typingElsewhere || (mode === 'all' && planVisible)}
            hiddenBelowLg={!!selected}
            onDraft={setDraft}
            paneSettings={settings}
          />
          {/* Over the bottom of the columns area, above the composer: see `DropNotice`. */}
          {dropNotice && <DropNotice text={dropNotice} onDone={clearDropNotice} />}
        </div>
        {orchestratorTopic && orchestrator && (
          <OrchestratorDrawer
            topic={orchestratorTopic}
            onClose={closeOrchestrator}
            onPopOut={popOutOrchestrator}
          >
            {orchestrator.render({ topic: orchestratorTopic })}
          </OrchestratorDrawer>
        )}
        {drawerTask && (
          <TaskDetail
            key={drawerTask.id} /* fresh edit/scroll state per task (drawer navigation) */
            projectId={drawerTask.projectId}
            taskId={drawerTask.id}
            initialStatus={drawerTask.status}
            initialTitle={drawerTask.text}
            bump={taskDetailBump(drawerTask)}
            onClose={() => setSelectedId(null)}
            onChanged={refetch}
            onOpenTask={openTask}
            onOpenTopic={onOpenTopic}
            onMessage={onMessage}
            loadHistory={loadHistory}
            sessionState={resolveSession(drawerTask.assignedTopicId)}
            focusPaneId={pendingPaneId ?? undefined}
            boardTopicsRoutingDefault={cardSettings?.dispatchTopicsRouting ?? null}
            boardDispatchModel={cardSettings?.dispatchModel ?? null}
            /* Apertura automatica nel workspace: SOLO dalla board globale, che
               è una superficie a sé. Dentro una finestra di progetto la board è
               una pane di quella stessa finestra, e promuovere lì il risultato
               vorrebbe dire togliere spazio al drawer che stai leggendo — e
               rifare lo split a ogni card. Il bottone «Apri nel workspace»
               resta comunque, in entrambi i casi. */
          />
        )}
      </div>
    </div>
  );
}
