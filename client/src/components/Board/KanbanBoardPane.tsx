/**
 * KanbanBoardPane — lean, Master-free task board (human surface).
 *
 * Rebuilt after the Master/Board subsystem was removed (42e92c1d): no Crown/lead,
 * no proposal cards, no autopilot. Five columns, drag between columns to change
 * status, a detail drawer with the comment thread, and a human review gate on the
 * Review column (approve → done / reject → in_progress). Talks only to the
 * project-scoped board API (client/src/lib/board.ts).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DndContext, DragOverlay, closestCorners, pointerWithin, useDroppable, PointerSensor, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Bot, Check, ChevronDown, ChevronRight, ClipboardList, ExternalLink, Loader2, Maximize2, Minimize2, Paperclip, Plus, Square, Trash2, X, ShieldCheck, ShieldX, Send, Settings, ArrowUpRight } from 'lucide-react';
import type { WSMessage } from '../../types';
import { Menu } from '../Shared/Menu';
import { ChatMarkdown } from '../ChatMarkdown';
import { getMediaUrl } from '../../lib/api';
import {
  boardApi, boardIdForPath, TASK_STATUSES, STATUS_LABEL, parseQuestionBlock,
  type BoardTask, type TaskStatus, type TaskComment, type BoardSettings, type BoardSettingsPatch,
  type BoardProjectRef,
} from '../../lib/board';

interface Props {
  /** Absent in the global ('Board generale') pane — there is no single project. */
  projectPath?: string;
  /** Global cross-project board: locks to 'all' mode, no project column, no add. */
  global?: boolean;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  /** Deep-link a task's bound agent tab into focus (wired to handleTopicClick). */
  onOpenTopic?: (topicId: string) => void;
}

const PRIORITY_DOT: Record<number, string> = {
  0: 'bg-neutral-400', 1: 'bg-sky-400', 2: 'bg-emerald-400', 3: 'bg-amber-400', 4: 'bg-rose-500',
};

const STATUS_ICON_COLOR: Record<TaskStatus, string> = {
  backlog: 'text-neutral-500',
  todo: 'text-neutral-300',
  in_progress: 'text-sky-400',
  review: 'text-rose-400',
  done: 'text-emerald-400',
};

/**
 * Linear-style status glyph — the segmented progress circle that became the
 * de-facto standard for issue states (dashed ring → empty ring → half pie →
 * ¾ pie → checked disc). One shape family, color + fill carry the state, so
 * the eye reads progress at a glance even at 12px.
 */
function StatusIcon({ status, className = 'h-3.5 w-3.5' }: { status: TaskStatus; className?: string }) {
  // Inner pie: a fat-stroked circle with pathLength=100 — dasharray N = N% of
  // the disc filled, rotated so the fill grows clockwise from 12 o'clock.
  const pie = (pct: number) => (
    <circle
      cx="7" cy="7" r="2.4" fill="none" stroke="currentColor" strokeWidth="4.8"
      pathLength={100} strokeDasharray={`${pct} 100`} transform="rotate(-90 7 7)"
    />
  );
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={`${className} shrink-0 ${STATUS_ICON_COLOR[status]}`}>
      {status === 'done' ? (
        <>
          <circle cx="7" cy="7" r="6.4" fill="currentColor" />
          <path d="M4.3 7.3l1.8 1.8 3.6-3.9" fill="none" stroke="#171717" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle
            cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.6"
            {...(status === 'backlog' ? { strokeDasharray: '2.4 2.6', strokeLinecap: 'round' as const } : {})}
          />
          {status === 'in_progress' && pie(50)}
          {status === 'review' && pie(75)}
        </>
      )}
    </svg>
  );
}

/**
 * Size a textarea to its content (and keep it sized while typing) so the
 * click-to-edit swap <p> ↔ <textarea> never shifts the layout: same font,
 * same padding, same height as the text it replaces.
 */
const autoGrow = (el: HTMLTextAreaElement | null) => {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
};

/**
 * Two-stage collision for a board that mixes BIG droppables (columns) with
 * SMALL ones (sortable cards). Bare closestCorners compares corner distances,
 * so an EMPTY column loses against a nearby card in the adjacent column — a
 * drop aimed at Todo kept resolving onto the In Progress card ("me lo fa
 * mettere solo in progress"). Pointer-first fixes it: whatever the pointer is
 * INSIDE wins (a card beats its own column for precise insertion; an empty
 * column area is the column); corner distance only breaks ties when the
 * pointer is outside every droppable (fast flicks).
 */
const boardCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  if (within.length) {
    const card = within.find((c) => !TASK_STATUSES.includes(String(c.id) as TaskStatus));
    return card ? [card] : within;
  }
  return closestCorners(args);
};

// Card chip for the dispatch lifecycle (server: tasks.dispatch_state).
const DISPATCH_CHIP: Record<string, { text: string; cls: string }> = {
  queued: { text: 'in coda', cls: 'bg-white/10 text-neutral-300' },
  starting: { text: 'avvio…', cls: 'bg-amber-500/15 text-amber-300' },
  working: { text: 'al lavoro', cls: 'bg-sky-500/15 text-sky-300' },
  // Both live in Review, but they ask different things of the human:
  // needs_input = the agent ASKED (answer required); delivered = clean
  // hand-off, the agent believes it's done (approve/reject).
  needs_input: { text: 'serve te', cls: 'bg-rose-500/15 text-rose-300' },
  delivered: { text: 'finito (AI)', cls: 'bg-emerald-500/15 text-emerald-300' },
};

export function KanbanBoardPane({ projectPath, global = false, onMessage, onOpenTopic }: Props) {
  const projectId = useMemo(() => (projectPath ? boardIdForPath(projectPath) : ''), [projectPath]);
  // The project/all toggle only makes sense inside a project window. The global
  // pane has no project, so it locks to 'all'.
  const canToggle = !!projectPath && !global;
  // Per-board dispatch settings only exist for a single project (the global board
  // aggregates many), so the gear only shows inside a project window.
  const hasProject = !!projectPath && !global;
  // 'project' = this project only · 'all' = the global cross-project board.
  const [mode, setMode] = useState<'project' | 'all'>(canToggle ? 'project' : 'all');
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // Per-board dispatch settings, owned HERE (not by the settings panel) so the
  // header can always answer "does moving a task to Todo start an agent?" —
  // the exact feedback that was missing when a task sat in Todo doing nothing.
  const [settings, setSettings] = useState<BoardSettings | null>(null);
  // The START switch is GLOBAL (one for every board) — so the pill lives on
  // every header, including the global board, and clicking it IS the toggle.
  const [dispatchOn, setDispatchOn] = useState<boolean | null>(null);

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

  const refetch = useCallback(async () => {
    try {
      setTasks(mode === 'all' ? await boardApi.listAll() : await boardApi.list(projectId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load board');
    } finally {
      setLoading(false);
    }
  }, [projectId, mode]);

  useEffect(() => { setLoading(true); refetch(); }, [refetch]);

  // Live updates. In 'all' mode any task event is relevant; in 'project' mode
  // only events for this project (or project-less broadcasts) trigger a refetch.
  // board:settings keeps the header pill honest when another client toggles it.
  //
  // While a card is being DRAGGED the refetch is deferred: replacing `tasks`
  // mid-drag re-renders the columns under the pointer (chip flips, status
  // events, other clients) and the drag stutters or drops — the queued refetch
  // flushes at drag end.
  const draggingRef = useRef(false);
  const pendingRefetch = useRef(false);
  const safeRefetch = useCallback(() => {
    if (draggingRef.current) { pendingRefetch.current = true; return; }
    refetch();
  }, [refetch]);
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg) => {
      const m = msg as { type?: string; projectId?: string; settings?: BoardSettings; autoDispatch?: boolean };
      if (m.type === 'task:created' || m.type === 'task:updated' || m.type === 'task:deleted') {
        if (mode === 'all' || m.projectId === undefined || m.projectId === projectId) safeRefetch();
      }
      if (m.type === 'board:settings' && m.projectId === projectId && m.settings) setSettings(m.settings);
      // Global switch flipped anywhere (any board, any client) → this pill too.
      if (m.type === 'board:dispatch' && typeof m.autoDispatch === 'boolean') setDispatchOn(m.autoDispatch);
    });
  }, [onMessage, projectId, safeRefetch, mode]);

  const byStatus = useMemo(() => {
    const m: Record<TaskStatus, BoardTask[]> = { backlog: [], todo: [], in_progress: [], review: [], done: [] };
    for (const t of tasks) (m[t.status] ??= []).push(t);
    for (const s of TASK_STATUSES) m[s].sort((a, b) => a.kanbanOrder - b.kanbanOrder);
    return m;
  }, [tasks]);

  // Parent-title lookup for subtask cards ("⤴ epic…" context chip). Best-effort:
  // a parent whose card isn't in the current fetch (e.g. filtered) just shows no chip.
  const titleById = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tasks) m.set(t.id, t.text);
    return m;
  }, [tasks]);

  const patchLocal = useCallback((id: string, patch: Partial<BoardTask>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  /** Persist a drop: status and/or position, optimistically. Routed by the
   *  task's OWN projectId so it works identically in the global board. */
  const dropTo = useCallback(async (task: BoardTask, patch: { status?: TaskStatus; kanbanOrder?: number }) => {
    patchLocal(task.id, patch); // optimistic
    try { await boardApi.update(task.projectId, task.id, patch); }
    catch (e) { setError(e instanceof Error ? e.message : 'update failed'); refetch(); }
  }, [patchLocal, refetch]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const flushDrag = useCallback(() => {
    draggingRef.current = false;
    if (pendingRefetch.current) { pendingRefetch.current = false; refetch(); }
  }, [refetch]);
  const onDragStart = useCallback((e: DragStartEvent) => {
    draggingRef.current = true;
    setActiveId(String(e.active.id));
  }, []);
  // Fractional insertion key between two neighbours (SQLite NUMERIC affinity
  // keeps the float): no renumbering, one PATCH per drop.
  const between = (prev: number | undefined, next: number | undefined): number =>
    prev === undefined && next === undefined ? 1
    : prev === undefined ? next! - 1
    : next === undefined ? prev + 1
    : (prev + next) / 2;
  const onDragEnd = useCallback((e: DragEndEvent) => {
    setActiveId(null);
    flushDrag();
    const task = tasks.find((t) => t.id === e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!task || !overId || overId === task.id) return;
    // Dropped on a COLUMN (its empty area) → append; on a CARD → take its place.
    const overTask = TASK_STATUSES.includes(overId as TaskStatus) ? undefined : tasks.find((t) => t.id === overId);
    const status = overTask ? overTask.status : (overId as TaskStatus);
    if (!TASK_STATUSES.includes(status)) return;
    const col = byStatus[status].filter((t) => t.id !== task.id); // already kanbanOrder-sorted
    let idx = overTask ? col.findIndex((t) => t.id === overTask.id) : col.length;
    if (idx < 0) idx = col.length;
    // Same-column move DOWN past the over card = land after it (its old slot).
    if (overTask && task.status === status && task.kanbanOrder < overTask.kanbanOrder) idx += 1;
    const kanbanOrder = between(col[idx - 1]?.kanbanOrder, col[idx]?.kanbanOrder);
    if (task.status === status && kanbanOrder === task.kanbanOrder) return;
    dropTo(task, task.status === status ? { kanbanOrder } : { status, kanbanOrder });
  }, [tasks, byStatus, dropTo, flushDrag]);
  const activeTask = activeId ? tasks.find((t) => t.id === activeId) ?? null : null;

  const create = useCallback(async (status: TaskStatus, text: string) => {
    // A task can't be created directly in Done — land it in Todo instead.
    const target: TaskStatus = status === 'done' ? 'todo' : status;
    try { await boardApi.create(projectId, { text, status: target }); refetch(); }
    catch (e) { setError(e instanceof Error ? e.message : 'create failed'); }
  }, [projectId, refetch]);

  const selected = tasks.find((t) => t.id === selectedId) || null;

  if (loading) {
    return <div className="flex h-full items-center justify-center text-neutral-400"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden" data-testid="kanban-board">
      {/* Header: a project/all toggle inside a project, a static label globally. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-white/10 px-3 py-1.5">
        {canToggle ? (
          <>
            <button
              onClick={() => setMode('project')}
              className={`rounded px-2 py-0.5 text-xs ${mode === 'project' ? 'bg-white/15 text-neutral-100' : 'text-neutral-400 hover:bg-white/5'}`}
            >Questo progetto</button>
            <button
              onClick={() => setMode('all')}
              className={`rounded px-2 py-0.5 text-xs ${mode === 'all' ? 'bg-white/15 text-neutral-100' : 'text-neutral-400 hover:bg-white/5'}`}
            >Tutti i progetti</button>
          </>
        ) : (
          <span className="text-xs font-semibold text-neutral-200">Board generale</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {mode === 'all' && <span className="text-[11px] text-neutral-500">{tasks.length} task · tutti i progetti</span>}
          {dispatchOn !== null && (
            <button
              onClick={toggleDispatch}
              data-testid="board-dispatch-pill"
              title={dispatchOn
                ? 'Auto-dispatch attivo (globale): un task in Todo avvia un agent, su qualsiasi board — clicca per spegnere'
                : 'Auto-dispatch spento (globale): i task in Todo NON partono da soli — clicca per attivarlo'}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                dispatchOn ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25' : 'bg-white/10 text-neutral-400 hover:bg-white/15'
              }`}
            >
              <Bot className="h-3 w-3" /> {dispatchOn ? 'agent: on' : 'agent: off'}
            </button>
          )}
          {hasProject && (
            <button
              onClick={() => setShowSettings((s) => !s)}
              className={`rounded p-1 ${showSettings ? 'bg-white/15 text-neutral-100' : 'text-neutral-400 hover:bg-white/5'}`}
              title="Impostazioni auto-dispatch"
            ><Settings className="h-3.5 w-3.5" /></button>
          )}
        </div>
      </div>
      {error && <div className="shrink-0 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300">{error}</div>}
      {showSettings && hasProject && (
        <BoardSettingsPanel
          projectId={projectId}
          settings={settings}
          dispatchOn={dispatchOn}
          onToggleDispatch={toggleDispatch}
          onChanged={setSettings}
          onClose={() => setShowSettings(false)}
          onError={setError}
        />
      )}
      <DndContext sensors={sensors} collisionDetection={boardCollision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => { setActiveId(null); flushDrag(); }}>
        <div className="flex h-full gap-3 overflow-x-auto p-3 pb-20">
          {TASK_STATUSES.map((status) => (
            <Column
              key={status}
              status={status}
              tasks={byStatus[status]}
              onOpen={setSelectedId}
              onCreate={(text) => create(status, text)}
              canCreate={mode === 'project'}
              showProject={mode === 'all'}
              onError={setError}
              onRefetch={refetch}
              onOpenTopic={onOpenTopic}
              titleById={titleById}
            />
          ))}
        </div>
        {/* Portal to <body>: the overlay is position:fixed, and a transformed
            ancestor (pane translateX, FLIP animations) would re-anchor fixed
            positioning to itself — the ghost card then renders far from the
            pointer. On body there is no transform above it, ever. */}
        {createPortal(
          <DragOverlay dropAnimation={null}>
            {activeTask ? (
              <div className="w-64 rounded-md border border-white/20 bg-neutral-800 p-2.5 text-sm text-neutral-100 shadow-xl">
                <div className="flex items-start gap-2">
                  <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[activeTask.priority] ?? PRIORITY_DOT[2]}`} />
                  <span className="flex-1 leading-snug">{activeTask.text}</span>
                </div>
              </div>
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
      <FloatingTaskComposer
        projectId={projectId}
        global={mode === 'all'}
        onCreated={refetch}
        onError={setError}
      />
      {selected && (
        <TaskDetail
          key={selected.id} /* fresh edit/scroll state per task (drawer navigation) */
          projectId={selected.projectId}
          taskId={selected.id}
          bump={selected.updatedAt}
          onClose={() => setSelectedId(null)}
          onChanged={refetch}
          onOpenTask={setSelectedId}
          onOpenTopic={onOpenTopic}
        />
      )}
    </div>
  );
}

// ── Floating task composer ──────────────────────────────────────────────────
/**
 * The "dai questo all'agent" entry point: a floating input at the bottom of
 * the board. Collapsed it's a slim pill; on focus it RISES slightly and
 * expands (plan-first toggle, project select in the global board, submit) —
 * and eases back on blur. The task is born in Todo (the dispatch signal);
 * title = first line, full text goes to the description, and the dispatched
 * agent polishes the wording (kickoff rule) — no model to pick, ever.
 */
function FloatingTaskComposer({ projectId, global, onCreated, onError }: {
  projectId: string;
  /** Cross-project mode: no implicit board — the project picker chip appears. */
  global: boolean;
  onCreated: () => void;
  onError: (e: string) => void;
}) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [planFirst, setPlanFirst] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [projects, setProjects] = useState<BoardProjectRef[] | null>(null);
  const [targetProject, setTargetProject] = useState<string>(() => {
    try { return localStorage.getItem('board:composerProject') ?? ''; } catch { return ''; }
  });
  // Project picker — the SAME Menu-primitive selector the task-detail header
  // uses (portal, flip-above, keyboard nav), not a bare native <select>.
  const [projOpen, setProjOpen] = useState(false);
  const [creatingProj, setCreatingProj] = useState(false);
  const [newProjName, setNewProjName] = useState('');
  const [projBusy, setProjBusy] = useState(false);
  const projBtnRef = useRef<HTMLButtonElement>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // The Menu portals to <body>, so focus leaves the wrapper while it's open —
  // keep the composer expanded anyway.
  const expanded = focused || projOpen || text.trim().length > 0;

  const loadProjects = () => {
    if (projects === null) boardApi.projects().then(setProjects).catch(() => setProjects([]));
  };
  const onFocus = () => {
    setFocused(true);
    if (global) loadProjects();
  };
  // Collapse only when focus truly LEFT the composer (not moving between its
  // own controls) — otherwise clicking "Plan first" would blur-shrink it.
  const onBlurCapture = (e: React.FocusEvent) => {
    if (projOpen) return;
    if (wrapRef.current && e.relatedTarget instanceof Node && wrapRef.current.contains(e.relatedTarget)) return;
    setFocused(false);
  };
  // WebKit: buttons do NOT take focus on click (relatedTarget = null), so the
  // blur check above can't recognise "still inside" and the pill collapsed
  // under the click (project chip, plan-first). Kill the focus steal at the
  // source: pointerdown on the composer's buttons keeps the textarea focused —
  // no blur, nothing to recover. Clicks still fire; the portaled Menu (and the
  // textarea itself) are untouched.
  const onPointerDownCapture = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) e.preventDefault();
  };

  const target = global ? targetProject : projectId;
  const targetRef = projects?.find((p) => p.projectId === targetProject) ?? null;
  // Readable before the index loads: the stored id minus its hash suffix.
  const targetLabel = targetRef?.name ?? (targetProject ? targetProject.replace(/-[^-]+$/, '') : '');

  const pickProject = (id: string) => {
    setTargetProject(id);
    try { localStorage.setItem('board:composerProject', id); } catch { /* private mode */ }
    setProjOpen(false);
    setCreatingProj(false);
  };
  const doCreateProject = async () => {
    const name = newProjName.trim();
    if (!name || projBusy) return;
    setProjBusy(true);
    try {
      const created = await boardApi.createProject(name);
      setProjects((prev) => (prev ? [...prev, created].sort((a, b) => a.name.localeCompare(b.name)) : [created]));
      setNewProjName('');
      pickProject(created.projectId);
    } catch (e) { onError(e instanceof Error ? e.message : 'create project failed'); }
    finally { setProjBusy(false); }
  };

  const submit = async () => {
    const raw = text.trim();
    if (!raw || submitting) return;
    if (!target) { onError('Scegli il progetto del task.'); setProjOpen(true); loadProjects(); return; }
    const lines = raw.split('\n');
    const firstLine = lines[0].trim();
    const title = firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;
    // Description = the text AFTER the first line — the drawer must not show
    // the title glued again right under itself. A truncated first line keeps
    // the full text so nothing is lost.
    const rest = lines.slice(1).join('\n').trim();
    const description = firstLine.length > 80 ? raw : rest || null;
    setSubmitting(true);
    try {
      await boardApi.create(target, { text: title, description, status: 'todo', planFirst });
      setText('');
      setPlanFirst(false);
      if (taRef.current) taRef.current.style.height = 'auto';
      onCreated();
    } catch (e) { onError(e instanceof Error ? e.message : 'create failed'); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-10 flex justify-center px-4">
      <div
        ref={wrapRef}
        onFocusCapture={onFocus}
        onBlurCapture={onBlurCapture}
        onPointerDownCapture={onPointerDownCapture}
        data-testid="board-task-composer"
        className={`pointer-events-auto w-full max-w-xl rounded-2xl border bg-neutral-900/95 shadow-2xl shadow-black/50 backdrop-blur transition-all duration-200 ease-out ${
          expanded ? '-translate-y-2 border-white/20' : 'translate-y-0 border-white/10'
        }`}
      >
        <textarea
          value={text} rows={1}
          ref={(el) => { taRef.current = el; autoGrow(el); }}
          onChange={(e) => { setText(e.target.value); autoGrow(e.currentTarget); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder="Descrivi un task per l'agent…"
          className="block max-h-40 w-full resize-none overflow-y-auto bg-transparent px-3.5 py-3 text-sm leading-5 text-neutral-100 outline-none placeholder:text-neutral-500"
        />
        <div className={`flex items-center gap-2 overflow-hidden px-2.5 transition-all duration-200 ease-out ${expanded ? 'max-h-12 pb-2 opacity-100' : 'max-h-0 pb-0 opacity-0'}`}>
          {global && (
            <>
              <button
                ref={projBtnRef}
                onClick={() => { setProjOpen(true); loadProjects(); }}
                data-testid="composer-project-chip"
                title={targetLabel ? `Progetto: ${targetLabel}` : 'Scegli il progetto del task'}
                className="flex min-w-0 max-w-[13rem] items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 text-xs text-neutral-200 hover:bg-white/10"
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${targetProject ? 'bg-emerald-400' : 'bg-neutral-600'}`} />
                <span className="truncate">{targetLabel || 'Progetto…'}</span>
                <ChevronDown className="h-3 w-3 shrink-0 text-neutral-500" />
              </button>
              <Menu
                open={projOpen}
                anchorRef={projBtnRef}
                onClose={() => { setProjOpen(false); setCreatingProj(false); }}
                minWidth={230}
                role="listbox"
              >
                <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Progetto del task</p>
                <div className="max-h-60 overflow-y-auto">
                  {projects === null ? (
                    <div className="flex items-center justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-neutral-500" /></div>
                  ) : projects.length === 0 ? (
                    <p className="px-2.5 py-2 text-xs text-neutral-500">Nessun progetto trovato.</p>
                  ) : projects.map((p) => (
                    <button
                      key={p.projectId} role="option" aria-selected={p.projectId === targetProject}
                      onClick={() => pickProject(p.projectId)}
                      title={p.path}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10"
                    >
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      {p.projectId === targetProject && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                    </button>
                  ))}
                </div>
                <div className="my-1 border-t border-white/10" />
                {creatingProj ? (
                  <div className="flex items-center gap-1 px-2.5 py-1.5">
                    <input
                      autoFocus value={newProjName} disabled={projBusy}
                      onChange={(e) => setNewProjName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); doCreateProject(); }
                        if (e.key === 'Escape') { setCreatingProj(false); setNewProjName(''); }
                      }}
                      placeholder="nome-progetto"
                      className="min-w-0 flex-1 rounded bg-white/5 px-1.5 py-1 text-xs text-neutral-100 outline-none placeholder:text-neutral-600"
                    />
                    {projBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" />
                    ) : (
                      <button
                        onClick={doCreateProject} disabled={!newProjName.trim()}
                        className="rounded bg-emerald-500/80 px-1.5 py-1 text-[11px] text-white hover:bg-emerald-500 disabled:opacity-50"
                      >Crea</button>
                    )}
                  </div>
                ) : (
                  <button
                    role="option" aria-selected={false}
                    onClick={() => setCreatingProj(true)}
                    title="Crea un nuovo progetto nel workspace e usalo per questo task"
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10"
                  ><Plus className="h-3.5 w-3.5" /> Nuovo progetto…</button>
                )}
              </Menu>
            </>
          )}
          <button
            onClick={() => setPlanFirst((v) => !v)}
            title="L'agent consegna prima un piano da approvare, implementa dopo il tuo ok"
            className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
              planFirst ? 'bg-violet-500/25 text-violet-200' : 'bg-white/5 text-neutral-400 hover:bg-white/10'
            }`}
          ><ClipboardList className="h-3 w-3" /> Plan first</button>
          <span className="ml-auto hidden shrink-0 text-[10px] text-neutral-600 sm:block">parte da Todo · modello automatico</span>
          <button
            onClick={submit} disabled={!text.trim() || submitting}
            title="Crea il task (l'agent parte da Todo)"
            className="shrink-0 rounded-lg bg-emerald-500/80 p-1.5 text-white hover:bg-emerald-500 disabled:opacity-40"
          >{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button>
        </div>
      </div>
    </div>
  );
}

// ── Column ────────────────────────────────────────────────────────────────
function Column({ status, tasks, onOpen, onCreate, canCreate, showProject, onError, onRefetch, onOpenTopic, titleById }: {
  status: TaskStatus; tasks: BoardTask[]; onOpen: (id: string) => void; onCreate: (text: string) => void;
  canCreate: boolean; showProject: boolean; onError: (e: string) => void; onRefetch: () => void;
  onOpenTopic?: (topicId: string) => void; titleById: Map<string, string>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const submit = () => { const v = text.trim(); if (v) { onCreate(v); } setText(''); setAdding(false); };

  return (
    <div ref={setNodeRef} data-testid={`kanban-column-${status}`} className={`flex w-72 shrink-0 flex-col rounded-lg border ${isOver ? 'border-emerald-400/60 bg-emerald-400/5' : 'border-white/10 bg-white/5'}`}>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-300">
          <StatusIcon status={status} />
          {STATUS_LABEL[status]}
        </span>
        <span className="rounded bg-white/10 px-1.5 text-xs text-neutral-400">{tasks.length}</span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((t) => (
            <Card key={t.id} task={t} onOpen={onOpen} showProject={showProject} onError={onError} onRefetch={onRefetch} onOpenTopic={onOpenTopic} parentTitle={t.parentTaskId ? titleById.get(t.parentTaskId) : undefined} />
          ))}
        </SortableContext>
        {!canCreate ? null : adding ? (
          <div className="rounded-md border border-white/10 bg-white/5 p-2">
            <textarea
              autoFocus value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === 'Escape') { setText(''); setAdding(false); } }}
              className="w-full resize-none bg-transparent text-sm text-neutral-100 outline-none" rows={2} placeholder="Task…"
            />
            <div className="mt-1 flex justify-end gap-1">
              <button onClick={() => { setText(''); setAdding(false); }} className="rounded px-2 py-0.5 text-xs text-neutral-400 hover:bg-white/10">Annulla</button>
              <button onClick={submit} className="rounded bg-emerald-500/80 px-2 py-0.5 text-xs text-white hover:bg-emerald-500">Aggiungi</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-xs text-neutral-400 hover:bg-white/5">
            <Plus className="h-3.5 w-3.5" /> Aggiungi
          </button>
        )}
      </div>
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────
function Card({ task, onOpen, showProject, onError, onRefetch, onOpenTopic, parentTitle }: {
  task: BoardTask; onOpen: (id: string) => void; showProject: boolean;
  onError: (e: string) => void; onRefetch: () => void; onOpenTopic?: (topicId: string) => void;
  /** Text of the parent task when this card is a subtask (context chip). */
  parentTitle?: string;
}) {
  // Sortable: the source card is dimmed (the DragOverlay carries the visual)
  // but its NEIGHBOURS get the reflow transform — the list opens a gap under
  // the pointer, so dropping "between two cards" reads as such. The ACTIVE
  // card must NOT get its transform (that one follows the pointer): applied,
  // the dim source card flew across the board alongside the overlay and the
  // drop targeting went with it.
  const { attributes, listeners, setNodeRef, isDragging, transform, transition } = useSortable({ id: task.id });

  // "Serve te" context: for an agent-driven task in review, lazily load the
  // thread and surface the LAST comment on the card — as a quick-reply with
  // option buttons when it's a question block, as plain text otherwise. The
  // human must never be asked Approva/Rifiuta blind: the agent's last word is
  // always on the card (the thread stays in the drawer).
  const [lastComment, setLastComment] = useState<TaskComment | null>(null);
  const [freeText, setFreeText] = useState('');
  const [busy, setBusy] = useState(false);
  const isAgentReview = task.status === 'review' && !!task.assignedTopicId;
  useEffect(() => {
    if (!isAgentReview) { setLastComment(null); return; }
    let alive = true;
    boardApi.get(task.projectId, task.id)
      .then(({ comments }) => {
        if (!alive) return;
        // Status events are history rows, not the agent's word — skip them.
        const speech = comments.filter((c) => c.kind !== 'status');
        setLastComment(speech[speech.length - 1] ?? null);
      })
      .catch(() => { if (alive) setLastComment(null); });
    return () => { alive = false; };
    // Re-check when the task changes (a re-kick bumps updatedAt).
  }, [isAgentReview, task.projectId, task.id, task.updatedAt]);
  const pending = lastComment ? parseQuestionBlock(lastComment.content) : null;

  // Route mutations by the task's own projectId (works in the global board too).
  const review = async (decision: 'approve' | 'reject', comment?: string) => {
    if (busy) return;
    setBusy(true);
    try { await boardApi.review(task.projectId, task.id, decision, comment); setLastComment(null); setFreeText(''); onRefetch(); }
    catch (e) { onError(e instanceof Error ? e.message : 'review failed'); }
    finally { setBusy(false); }
  };
  // Answering a question re-kicks the same agent tab (server routes reject →
  // dispatcher.resume), so the answer is a reject carrying the human's choice.
  const answer = (text: string) => review('reject', text);
  const archive = async () => {
    try { await boardApi.archive(task.projectId, task.id); onRefetch(); }
    catch (e) { onError(e instanceof Error ? e.message : 'archive failed'); }
  };
  // Human-readable project label = the dirName prefix before the id hash.
  const projectLabel = task.projectId.replace(/-[^-]+$/, '');

  return (
    <div
      ref={setNodeRef} {...attributes} {...listeners}
      style={{ transform: isDragging ? undefined : CSS.Transform.toString(transform), transition }}
      onClick={() => onOpen(task.id)}
      className={`group cursor-grab rounded-md border border-white/10 bg-neutral-800/60 p-2.5 text-sm text-neutral-100 shadow-sm hover:border-white/20 ${isDragging ? 'opacity-40' : ''}`}
    >
      <div className="flex items-start gap-2">
        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[task.priority] ?? PRIORITY_DOT[2]}`} />
        <span className="flex-1 leading-snug">{task.text}</span>
        <button onClick={(e) => { e.stopPropagation(); archive(); }} className="opacity-0 transition group-hover:opacity-100" title="Archivia">
          <Trash2 className="h-3.5 w-3.5 text-neutral-500 hover:text-rose-400" />
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-4">
        {showProject && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-300">{projectLabel}</span>}
        {task.parentTaskId && (
          <button
            onClick={(e) => { e.stopPropagation(); onOpen(task.parentTaskId!); }}
            title={parentTitle ? `Sottotask di: ${parentTitle}` : 'Apri il task padre'}
            className="max-w-[9rem] truncate rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-300 hover:bg-violet-500/25"
          >⤴ {parentTitle ?? 'padre'}</button>
        )}
        {task.subtaskCount > 0 && (
          <span
            title={`${task.subtaskDoneCount}/${task.subtaskCount} sottotask completati`}
            className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-neutral-300"
          >↳ {task.subtaskDoneCount}/{task.subtaskCount}</span>
        )}
        {task.planFirst && (
          <span
            title="L'agent consegna prima un piano da approvare"
            className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-300"
          >piano</span>
        )}
        {(task.agentMs > 0 || task.agentTokens > 0) && (
          <span
            title={`Effort dell'agent: ${fmtMs(task.agentMs)} di lavoro${task.agentTokens ? `, ${task.agentTokens.toLocaleString('it-IT')} token` : ''}`}
            className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-neutral-400"
          >⏱ {fmtMs(task.agentMs)}{task.agentTokens > 0 && ` · ${fmtTok(task.agentTokens)} tok`}</span>
        )}
        {task.assignedTo && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-neutral-300">@{task.assignedTo}</span>}
        {task.dispatchState && DISPATCH_CHIP[task.dispatchState] && (
          <span className={`rounded px-1.5 py-0.5 text-[11px] ${DISPATCH_CHIP[task.dispatchState].cls}`}>
            {DISPATCH_CHIP[task.dispatchState].text}
          </span>
        )}
        {!task.dispatchState && task.dispatchError && (
          <span
            className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[11px] text-rose-300"
            title={task.dispatchError}
          >fermato</span>
        )}
        {task.assignedTopicId && onOpenTopic && (
          <button
            onClick={(e) => { e.stopPropagation(); onOpenTopic(task.assignedTopicId!); }}
            className="flex items-center gap-0.5 rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-neutral-200 hover:bg-white/20"
            title="Apri la tab dell'agent"
          ><ArrowUpRight className="h-3 w-3" /> apri tab</button>
        )}
      </div>
      {task.status === 'review' && isAgentReview && (
        <div className="mt-2 space-y-1.5 pl-4" onClick={(e) => e.stopPropagation()}>
          {/* The agent's last word, ALWAYS on the card — a formatted question
              with quick-reply buttons when it's a question block, plain text
              otherwise. Approving/rejecting blind was the bug. */}
          {pending ? (
            <p className="text-[11px] leading-snug text-rose-200">{pending.question}</p>
          ) : lastComment ? (
            <p className="line-clamp-3 text-[11px] leading-snug text-neutral-300" title={`${lastComment.author}: ${lastComment.content}`}>
              {/* No author prefix: for dispatched agents it's the topic name =
                  the task title — noise dressed up as a username. */}
              {lastComment.author !== 'user' && <Bot className="mr-1 inline h-3 w-3 align-[-2px] text-neutral-400" />}
              {lastComment.content}
            </p>
          ) : null}
          {pending && pending.options.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {pending.options.map((opt, i) => (
                <button
                  key={i} disabled={busy}
                  onClick={() => answer(opt)}
                  className="rounded bg-white/10 px-2 py-0.5 text-[11px] text-neutral-100 hover:bg-white/20 disabled:opacity-50"
                >{opt}</button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1">
            <input
              value={freeText} disabled={busy}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && freeText.trim()) { e.preventDefault(); answer(freeText.trim()); } }}
              placeholder="Rispondi…"
              className="min-w-0 flex-1 rounded bg-black/30 px-2 py-1 text-[11px] text-neutral-100 outline-none placeholder:text-neutral-500"
            />
            <button
              disabled={busy || !freeText.trim()} onClick={() => answer(freeText.trim())}
              title="Rispondi (l'agent riparte con la tua risposta)"
              className="flex items-center gap-1 rounded bg-sky-500/80 px-2 py-1 text-[11px] text-white hover:bg-sky-500 disabled:opacity-50"
            ><Send className="h-3 w-3" /></button>
            <button
              disabled={busy} onClick={() => review('approve')}
              title="Accetta e completa il task"
              className="flex items-center gap-1 rounded bg-emerald-500/80 px-2 py-1 text-[11px] text-white hover:bg-emerald-500 disabled:opacity-50"
            ><ShieldCheck className="h-3 w-3" /></button>
            <button
              disabled={busy} onClick={() => review('reject')}
              title="Rifiuta (l'agent riparte senza indicazioni)"
              className="flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-[11px] text-neutral-200 hover:bg-white/20 disabled:opacity-50"
            ><ShieldX className="h-3 w-3" /></button>
          </div>
        </div>
      )}
      {task.status === 'review' && !isAgentReview && (
        <div className="mt-2 flex gap-1 pl-4" onClick={(e) => e.stopPropagation()}>
          <button disabled={busy} onClick={() => review('approve')} className="flex items-center gap-1 rounded bg-emerald-500/80 px-2 py-0.5 text-[11px] text-white hover:bg-emerald-500 disabled:opacity-50">
            <ShieldCheck className="h-3 w-3" /> Approva
          </button>
          <button disabled={busy} onClick={() => review('reject')} className="flex items-center gap-1 rounded bg-white/10 px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-white/20 disabled:opacity-50">
            <ShieldX className="h-3 w-3" /> Rifiuta
          </button>
        </div>
      )}
    </div>
  );
}

// ── Detail: drawer by default, expandable review surface ────────────────────
function TaskDetail({ projectId, taskId, bump, onClose, onChanged, onOpenTask, onOpenTopic }: {
  projectId: string; taskId: string; onClose: () => void; onChanged: () => void;
  /**
   * Change signal (the task's updatedAt from the board's live list): any WS
   * task:updated — a step flipping, a new comment — re-fetches the open detail,
   * so the drawer follows the agent in real time instead of freezing at mount.
   */
  bump?: string;
  /** Navigate the drawer to another task (subtask ↔ parent). */
  onOpenTask?: (taskId: string) => void;
  /** Deep-link the agent's chat tab (output panel fallback). */
  onOpenTopic?: (topicId: string) => void;
}) {
  const [task, setTask] = useState<BoardTask | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [children, setChildren] = useState<BoardTask[]>([]);
  const [draft, setDraft] = useState('');
  const [subDraft, setSubDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [addingSub, setAddingSub] = useState(false);
  // Inline title/description editing (works for subtasks too — the drawer IS
  // the edit surface at every depth). Esc cancels via the ref so the blur-save
  // that follows becomes a no-op.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');
  const editCancelled = useRef(false);
  // Action errors surfaced HERE, in the detail — the board's error bar sits
  // behind the drawer. The 409 open_subtasks on Approva is the load-bearing
  // case: swallowing it made the click look dead.
  const [error, setError] = useState<string | null>(null);
  const showError = (e: unknown) => {
    const raw = e instanceof Error ? e.message : String(e);
    setError(/open subtasks/i.test(raw)
      ? 'Ci sono sottotask aperti: completali o archiviali prima di chiudere il task.'
      : raw);
  };
  // Narrow (default) keeps the board visible behind the drawer; wide turns the
  // detail into a full review surface — subtask tree + thread on the left, the
  // task's output (dev server, page, report) on the right. Sticky per client.
  const [wide, setWide] = useState(() => { try { return localStorage.getItem('board:taskDetailWide') === '1'; } catch { return false; } });
  const toggleWide = () => setWide((w) => {
    const next = !w;
    try { localStorage.setItem('board:taskDetailWide', next ? '1' : '0'); } catch { /* private mode */ }
    return next;
  });
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const { task, comments, children } = await boardApi.get(projectId, taskId);
      setTask(task); setComments(comments); setChildren(children ?? []);
    } catch { /* closed or gone */ }
  }, [projectId, taskId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: setState lands after the await, not synchronously
  useEffect(() => { load(); }, [load, bump]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [comments.length]);

  // A human comment on an agent-delivered review IS the answer — same
  // semantics as the card's quick-reply: reject carries the text and resumes
  // the SAME agent tab (server: reviewDecision → comment + in_progress +
  // dispatcher.resume). A plain comment here would sit unread while the chip
  // says "serve te". Non-agent tasks (or any other status) keep plain comments.
  const isAgentReview = !!task && task.status === 'review' && !!task.assignedTopicId;
  // Pending question = the agent's last word is a question block: its options
  // render as quick-reply buttons right above the composer (same zone as the
  // review actions), mirroring the card.
  // kind='status' rows are transition history, never "the agent's last word".
  const speech = comments.filter((c) => c.kind !== 'status');
  const lastThreadComment = speech[speech.length - 1] ?? null;
  const pending = isAgentReview && lastThreadComment ? parseQuestionBlock(lastThreadComment.content) : null;

  const deliverAnswer = async (v: string, media?: string[]): Promise<boolean> => {
    try {
      if (media && media.length > 0) {
        // Attachments ride the comments endpoint (media isn't a review-decision
        // field); when the task is in agent review the server auto-resumes the
        // agent with the text AND the file paths (boundRootOf path).
        await boardApi.comment(projectId, taskId, v || '(allegato)', { media });
      } else if (isAgentReview) {
        // Race fallback: if the task left review meanwhile, still save the text
        // as a plain comment instead of losing it.
        try { await boardApi.review(projectId, taskId, 'reject', v); }
        catch { await boardApi.comment(projectId, taskId, v); }
      } else {
        await boardApi.comment(projectId, taskId, v);
      }
      setError(null);
      await load(); onChanged();
      return true;
    } catch (e) { showError(e); return false; }
  };
  const send = async () => {
    const v = draft.trim(); if ((!v && attachments.length === 0) || sending) return;
    setSending(true);
    const ok = await deliverAnswer(v, attachments.map((a) => a.path));
    if (ok) { setDraft(''); setAttachments([]); } // cleared on success only
    setSending(false);
  };

  // Attachments: same pipeline as the native chat — POST /api/upload (multipart)
  // → absolute path, rendered via /api/media. Staged here until send.
  const [attachments, setAttachments] = useState<Array<{ path: string; name: string; isImage: boolean }>>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadFiles = async (files: FileList | File[]) => {
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, 8 - attachments.length)) {
        const fd = new FormData();
        fd.append('file', file);
        const r = await fetch('/api/upload', { method: 'POST', body: fd });
        const d = await r.json().catch(() => null) as { path?: string; error?: string } | null;
        if (!r.ok || !d?.path) throw new Error(d?.error || 'upload fallito');
        setAttachments((prev) => [...prev, { path: d.path!, name: file.name, isImage: file.type.startsWith('image/') }]);
      }
      setError(null);
    } catch (e) { showError(e); }
    finally { setUploading(false); }
  };
  const answerOption = async (opt: string) => {
    if (sending) return;
    setSending(true);
    await deliverAnswer(opt);
    setSending(false);
  };

  // Approve/reject from the detail itself — the review surface must not force a
  // round-trip back to the card. Same endpoint, same semantics.
  const decide = async (decision: 'approve' | 'reject') => {
    if (busy) return;
    setBusy(true);
    try { await boardApi.review(projectId, taskId, decision); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  };

  // Quick-add a nested subtask. Born in backlog (intake), like agent creates —
  // dragging it to Todo is the explicit "vai" gesture.
  const addSubtask = async () => {
    const v = subDraft.trim(); if (!v || addingSub) return;
    setAddingSub(true);
    try {
      await boardApi.create(projectId, { text: v, status: 'backlog', parentTaskId: taskId });
      setSubDraft('');
      setError(null);
      await load(); onChanged();
    } catch (e) { showError(e); }
    finally { setAddingSub(false); }
  };

  const saveTitle = async () => {
    setEditingTitle(false);
    if (editCancelled.current) { editCancelled.current = false; return; }
    const v = titleDraft.trim();
    if (!task || !v || v === task.text) return;
    try { await boardApi.update(projectId, taskId, { text: v }); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
  };
  const saveDesc = async () => {
    setEditingDesc(false);
    if (editCancelled.current) { editCancelled.current = false; return; }
    if (!task) return;
    const v = descDraft.trim();
    if (v === (task.description ?? '')) return;
    try { await boardApi.update(projectId, taskId, { description: v || null }); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
  };
  const cancelKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { editCancelled.current = true; (e.target as HTMLElement).blur(); }
  };

  // Status selector (header chip): the drawer can move the task directly —
  // same PATCH the column drag uses, same server guards (open_subtasks…).
  const statusBtnRef = useRef<HTMLButtonElement>(null);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const changeStatus = async (s: TaskStatus) => {
    setStatusMenuOpen(false);
    if (!task || s === task.status || busy) return;
    setBusy(true);
    try { await boardApi.update(projectId, taskId, { status: s }); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  };

  // Project selector (header chip): move the task to another board, open the
  // current project's window, or scaffold a new workspace project. The list is
  // the server-resolvable board index — fetched lazily on first open.
  const projChipRef = useRef<HTMLButtonElement>(null);
  const [projMenuOpen, setProjMenuOpen] = useState(false);
  const [projects, setProjects] = useState<BoardProjectRef[] | null>(null);
  const [creatingProj, setCreatingProj] = useState(false);
  const [newProjName, setNewProjName] = useState('');
  const [projBusy, setProjBusy] = useState(false);

  const openProjMenu = () => {
    setProjMenuOpen(true);
    if (projects === null) boardApi.projects().then(setProjects).catch(() => setProjects([]));
  };
  const currentProject = projects?.find((p) => p.projectId === task?.projectId) ?? null;
  const projectLabel = currentProject?.name ?? (task ? task.projectId.replace(/-[^-]+$/, '') : '');
  const moveBlocked = !task ? null
    : task.parentTaskId ? 'I sottotask si spostano col loro task padre.'
    : task.assignedTopicId || ['queued', 'starting', 'working'].includes(task.dispatchState ?? '')
      ? "C'è un agent attivo sul task: chiudi prima il giro."
      : null;

  const doMove = async (p: BoardProjectRef) => {
    if (projBusy || !task) return;
    setProjBusy(true);
    try {
      await boardApi.move(task.projectId, taskId, p.projectId);
      setError(null); setProjMenuOpen(false); onChanged();
    } catch (e) { showError(e); }
    finally { setProjBusy(false); }
  };
  const doOpenProject = () => {
    if (!currentProject) return;
    window.dispatchEvent(new CustomEvent('topics:open-project', { detail: { projectPath: currentProject.path } }));
    setProjMenuOpen(false);
  };
  const doCreateProject = async () => {
    const name = newProjName.trim();
    if (!name || projBusy || !task) return;
    setProjBusy(true);
    try {
      const created = await boardApi.createProject(name);
      setProjects((prev) => (prev ? [...prev, created].sort((a, b) => a.name.localeCompare(b.name)) : prev));
      await boardApi.move(task.projectId, taskId, created.projectId);
      setError(null); setNewProjName(''); setCreatingProj(false); setProjMenuOpen(false);
      onChanged();
    } catch (e) { showError(e); }
    finally { setProjBusy(false); }
  };

  const stopAgent = async () => {
    if (busy) return;
    setBusy(true);
    try { await boardApi.stop(projectId, taskId); setError(null); await load(); onChanged(); }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  };

  // The agent's session (same thread the chat tab shows, read-only), sliced
  // BETWEEN the comments: each reply gets, right above it, the piece of
  // reasoning that produced it. Loaded whenever the task has an agent bound
  // (the slices need timestamps to place themselves); reloads on live bump.
  const [sessionMsgs, setSessionMsgs] = useState<SessionMsg[] | null>(null);
  const sessionKey = task?.assignedTopicId ? `topic:${task.assignedTopicId.slice(0, 8)}` : null;
  const loadSession = useCallback(async () => {
    if (!sessionKey) return;
    try {
      const r = await fetch(`/api/history/${encodeURIComponent(sessionKey)}?limit=200`);
      const d = await r.json().catch(() => null) as { messages?: Array<{ role?: string; content?: string; timestamp?: string; thinking?: string }> } | null;
      const msgs = (Array.isArray(d?.messages) ? d.messages : [])
        // Keep thinking-only partials too: mid-stream the newest message may
        // have reasoning but no prose yet — that IS the live preview.
        .filter((m) => (typeof m?.content === 'string' && m.content.trim()) || (typeof m?.thinking === 'string' && m.thinking.trim()))
        .map((m) => ({ role: m.role ?? 'assistant', content: m.content ?? '', timestamp: m.timestamp ?? '', thinking: m.thinking }));
      setSessionMsgs(msgs);
    } catch { setSessionMsgs([]); }
  }, [sessionKey]);
  useEffect(() => { if (sessionKey) void loadSession(); }, [sessionKey, loadSession, bump]);

  // Live agent state (needed below): typing indicator + stream preview + stop.
  const agentBusy = !!task && ['queued', 'starting', 'working'].includes(task.dispatchState ?? '');

  // While a turn runs, poll the history (it overlays the LIVE stream content)
  // so the drawer shows what the agent is thinking/writing right now.
  useEffect(() => {
    if (!agentBusy || !sessionKey) return;
    const t = setInterval(() => { void loadSession(); }, 3000);
    return () => clearInterval(t);
  }, [agentBusy, sessionKey, loadSession]);

  // Tail of the newest agent message (reasoning first): the "come sta andando"
  // glance without opening anything.
  const streamPreview = useMemo(() => {
    if (!agentBusy || !sessionMsgs?.length) return null;
    const last = [...sessionMsgs].reverse().find((m) => m.role !== 'user');
    if (!last) return null;
    const text = (last.thinking?.trim() || last.content.trim()).replace(/\s+/g, ' ');
    return text ? text.slice(-280) : null;
  }, [agentBusy, sessionMsgs]);

  // Session messages that fall strictly between two thread boundaries (ISO
  // string compare — both sides are UTC toISOString). null = open-ended.
  const sliceBetween = useCallback((from: string | null, to: string | null): SessionMsg[] => {
    if (!sessionMsgs) return [];
    return sessionMsgs.filter((m) =>
      m.timestamp && (!from || m.timestamp > from) && (!to || m.timestamp <= to));
  }, [sessionMsgs]);

  const doneCount = children.filter((c) => c.status === 'done').length;

  return (
    <div
      data-testid="task-detail-drawer"
      className={`absolute inset-y-0 right-0 z-20 flex flex-col border-l border-white/10 bg-neutral-900/95 shadow-2xl backdrop-blur ${wide ? 'w-[min(64rem,94%)]' : 'w-96'}`}
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
        <button
          ref={statusBtnRef}
          onClick={() => task && setStatusMenuOpen(true)}
          data-testid="task-status-chip"
          title="Cambia lo stato del task"
          className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs uppercase tracking-wide text-neutral-400 hover:bg-white/10"
        >
          {task ? <StatusIcon status={task.status} /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {task ? STATUS_LABEL[task.status] : 'Carico…'}
          <ChevronDown className="h-3 w-3 text-neutral-600" />
        </button>
        <Menu open={statusMenuOpen} anchorRef={statusBtnRef} onClose={() => setStatusMenuOpen(false)} minWidth={170} role="listbox">
          <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Sposta in…</p>
          {TASK_STATUSES.map((s) => (
            <button
              key={s} role="option" aria-selected={s === task?.status}
              disabled={busy}
              onClick={() => changeStatus(s)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10 disabled:opacity-40"
            >
              <StatusIcon status={s} className="h-3.5 w-3.5" />
              <span className="min-w-0 flex-1">{STATUS_LABEL[s]}</span>
              {s === task?.status && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
            </button>
          ))}
        </Menu>
        {task?.dispatchState && DISPATCH_CHIP[task.dispatchState] && (
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${DISPATCH_CHIP[task.dispatchState].cls}`}>
            {DISPATCH_CHIP[task.dispatchState].text}
          </span>
        )}
        {task && (task.agentMs > 0 || task.agentTokens > 0) && (
          <span
            className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-neutral-400"
            title={`Effort dell'agent su questo task: ${fmtMs(task.agentMs)} di lavoro${task.agentTokens ? `, ${task.agentTokens.toLocaleString('it-IT')} token` : ''}`}
            data-testid="task-agent-effort"
          >⏱ {fmtMs(task.agentMs)}{task.agentTokens > 0 && ` · ${fmtTok(task.agentTokens)} tok`}</span>
        )}
        {task && (
          <button
            ref={projChipRef}
            onClick={openProjMenu}
            data-testid="task-project-chip"
            title={`Progetto: ${projectLabel} — sposta, apri o creane uno nuovo`}
            className="ml-auto flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 text-xs text-neutral-200 hover:bg-white/10"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
            <span className="truncate">{projectLabel}</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-neutral-500" />
          </button>
        )}
        <Menu
          open={projMenuOpen}
          anchorRef={projChipRef}
          onClose={() => { setProjMenuOpen(false); setCreatingProj(false); }}
          minWidth={230}
        >
          <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Sposta su…</p>
          {moveBlocked && <p className="px-2.5 pb-1 text-[10px] leading-snug text-amber-300/90">{moveBlocked}</p>}
          <div className="max-h-60 overflow-y-auto">
            {projects === null ? (
              <div className="flex items-center justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-neutral-500" /></div>
            ) : projects.length === 0 ? (
              <p className="px-2.5 py-2 text-xs text-neutral-500">Nessun progetto trovato.</p>
            ) : projects.map((p) => {
              const current = p.projectId === task?.projectId;
              return (
                <button
                  key={p.projectId} role="menuitem"
                  disabled={current || !!moveBlocked || projBusy}
                  onClick={() => doMove(p)}
                  title={p.path}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10 disabled:opacity-40"
                >
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {current && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                </button>
              );
            })}
          </div>
          <div className="my-1 border-t border-white/10" />
          <button
            role="menuitem" disabled={!currentProject}
            onClick={doOpenProject}
            title={currentProject ? `Apri la finestra di ${currentProject.name}` : 'Percorso del progetto non risolvibile'}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10 disabled:opacity-40"
          ><ArrowUpRight className="h-3.5 w-3.5" /> Apri progetto</button>
          {creatingProj ? (
            <div className="flex items-center gap-1 px-2.5 py-1.5">
              <input
                autoFocus value={newProjName} disabled={projBusy}
                onChange={(e) => setNewProjName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); doCreateProject(); }
                  if (e.key === 'Escape') { setCreatingProj(false); setNewProjName(''); }
                }}
                placeholder="nome-progetto"
                className="min-w-0 flex-1 rounded bg-white/5 px-1.5 py-1 text-xs text-neutral-100 outline-none placeholder:text-neutral-600"
              />
              {projBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-neutral-400" />
              ) : (
                <button
                  onClick={doCreateProject} disabled={!newProjName.trim()}
                  className="rounded bg-emerald-500/80 px-1.5 py-1 text-[11px] text-white hover:bg-emerald-500 disabled:opacity-50"
                >Crea</button>
              )}
            </div>
          ) : (
            <button
              role="menuitem" disabled={!!moveBlocked || projBusy}
              onClick={() => setCreatingProj(true)}
              title={moveBlocked ?? 'Crea un nuovo progetto nel workspace e sposta qui il task'}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10 disabled:opacity-40"
            ><Plus className="h-3.5 w-3.5" /> Nuovo progetto…</button>
          )}
        </Menu>
        <div className="flex shrink-0 items-center gap-0.5">
          {task?.assignedTopicId && onOpenTopic && (
            <button
              onClick={() => onOpenTopic(task.assignedTopicId!)}
              data-testid="task-open-session-tab"
              title="Apri la tab dell'agent (chiuderla NON ferma la sessione)"
              className="rounded p-1 text-neutral-400 hover:bg-white/10"
            ><ArrowUpRight className="h-3.5 w-3.5" /></button>
          )}
          {task?.outputUrl && (
            <a
              href={task.outputUrl} target="_blank" rel="noreferrer"
              title="Apri l'output in una nuova finestra"
              className="rounded p-1 text-neutral-400 hover:bg-white/10"
            ><ExternalLink className="h-3.5 w-3.5" /></a>
          )}
          <button
            onClick={toggleWide}
            title={wide ? 'Riduci a drawer (vedi la board)' : 'Espandi la superficie di review'}
            className="rounded p-1 text-neutral-400 hover:bg-white/10"
          >{wide ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</button>
          <button onClick={onClose} className="rounded p-1 text-neutral-400 hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>
      </div>
      {error && (
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-300">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="shrink-0 rounded p-0.5 hover:bg-white/10"><X className="h-3 w-3" /></button>
        </div>
      )}
      {!task ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-neutral-500" />
        </div>
      ) : (
      <div className="flex min-h-0 flex-1">
        {/* Left column: meta + subtask tree + chat thread. In wide mode it keeps
            the drawer width and the output panel takes the remaining space. */}
        <div className={`flex min-w-0 flex-col ${wide && task?.outputUrl ? 'w-96 shrink-0 border-r border-white/10' : 'flex-1'}`}>
          <div className="border-b border-white/10 px-3 py-3">
            {task?.parentTaskId && onOpenTask && (
              <button
                onClick={() => onOpenTask(task.parentTaskId!)}
                className="mb-1.5 flex items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-300 hover:bg-violet-500/25"
              >⤴ Task padre</button>
            )}
            {editingTitle ? (
              <textarea
                autoFocus value={titleDraft} rows={1} ref={autoGrow}
                onChange={(e) => { setTitleDraft(e.target.value); autoGrow(e.currentTarget); }}
                onBlur={saveTitle}
                onKeyDown={(e) => { cancelKey(e); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveTitle(); } }}
                className="-mx-1.5 block w-[calc(100%+0.75rem)] resize-none overflow-hidden rounded bg-white/5 px-1.5 py-1 text-sm leading-5 text-neutral-100 outline-none"
              />
            ) : (
              <p
                onClick={() => { if (task) { setTitleDraft(task.text); setEditingTitle(true); } }}
                title="Clicca per modificare il titolo"
                className="-mx-1.5 cursor-text rounded px-1.5 py-1 text-sm leading-5 text-neutral-100 hover:bg-white/5"
              >{task?.text}</p>
            )}
            {editingDesc ? (
              <textarea
                autoFocus value={descDraft} rows={1} ref={autoGrow}
                onChange={(e) => { setDescDraft(e.target.value); autoGrow(e.currentTarget); }}
                onBlur={saveDesc}
                onKeyDown={cancelKey}
                placeholder="Descrizione…"
                className="-mx-1.5 mt-1 block w-[calc(100%+0.75rem)] resize-none overflow-hidden rounded bg-white/5 px-1.5 py-0.5 text-xs leading-4 text-neutral-300 outline-none"
              />
            ) : task?.description ? (
              <p
                onClick={() => { setDescDraft(task.description ?? ''); setEditingDesc(true); }}
                title="Clicca per modificare la descrizione"
                className="-mx-1.5 mt-1 cursor-text whitespace-pre-wrap rounded px-1.5 py-0.5 text-xs leading-4 text-neutral-400 hover:bg-white/5"
              >{task.description}</p>
            ) : (
              <button
                onClick={() => { setDescDraft(''); setEditingDesc(true); }}
                className="mt-1 text-[11px] text-neutral-600 hover:text-neutral-400"
              >+ descrizione…</button>
            )}
            {!wide && task?.outputUrl && (
              <button
                onClick={toggleWide}
                title="Mostra l'output nel pannello di review"
                className="mt-1.5 flex w-full items-center gap-1 rounded bg-sky-500/10 px-1.5 py-1 text-left text-[11px] text-sky-300 hover:bg-sky-500/20"
              ><ArrowUpRight className="h-3 w-3 shrink-0" /><span className="truncate">{task.outputUrl}</span></button>
            )}
          </div>
          {/* Subtask tree — unlimited depth, lazy-expanded. The agent's steps
              live here too: dots flip green as it checks them off. */}
          <div className="max-h-[40%] overflow-y-auto border-b border-white/10 px-3 py-2" data-testid="task-detail-subtasks">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              Sottotask{children.length > 0 ? ` · ${doneCount}/${children.length}` : ''}
            </p>
            {children.map((c) => (
              <SubtaskNode key={c.id} projectId={projectId} node={c} depth={0} onOpenTask={onOpenTask} />
            ))}
            <div className="relative mt-1">
              <input
                value={subDraft} disabled={addingSub}
                onChange={(e) => setSubDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSubtask(); } }}
                placeholder="+ sottotask…"
                className="w-full rounded bg-white/5 px-2 py-1 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 disabled:opacity-60"
              />
              {addingSub && <Loader2 className="absolute right-1.5 top-1.5 h-3 w-3 animate-spin text-neutral-400" />}
            </div>
          </div>
          {/* Thread — chat-shaped: my messages right, agent/system left. Each
              reply carries, right ABOVE it, the slice of agent session that
              produced it (collapsed reasoning, chat-style). */}
          <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
            {comments.length === 0 && !task.assignedTopicId && <p className="text-xs text-neutral-500">Nessun commento.</p>}
            {comments.map((c, i) => (
              <div key={c.id} className="space-y-2">
                {task.assignedTopicId && (
                  <SessionSlice msgs={sliceBetween(comments[i - 1]?.createdAt ?? null, c.createdAt)} />
                )}
                {c.kind === 'status' ? <StatusEventRow comment={c} /> : <CommentBubble comment={c} />}
              </div>
            ))}
            {/* Turn still running (or ended after the last comment): its
                reasoning-so-far hangs at the tail, before the indicator. */}
            {task.assignedTopicId && (
              <SessionSlice
                msgs={sliceBetween(comments[comments.length - 1]?.createdAt ?? null, null)}
                label={agentBusy ? 'Ragionamento in corso' : undefined}
              />
            )}
            {agentBusy && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 rounded-lg bg-white/5 px-2.5 py-2">
                    {[0, 150, 300].map((d) => (
                      <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-400/80" style={{ animationDelay: `${d}ms` }} />
                    ))}
                    <span className="ml-1.5 text-[11px] text-neutral-400">
                      {task.dispatchState === 'queued' ? 'in coda…' : task.dispatchState === 'starting' ? 'avvio agent…' : 'agent al lavoro…'}
                      {task.inProgressAt && task.dispatchState === 'working' && (
                        <span className="text-neutral-500"> <Ticker since={task.inProgressAt} /></span>
                      )}
                    </span>
                  </div>
                  <button
                    disabled={busy} onClick={stopAgent}
                    title="Ferma l'agent (il task torna in Backlog con il motivo)"
                    className="flex items-center gap-1 rounded bg-rose-500/15 px-2 py-1.5 text-[11px] text-rose-300 hover:bg-rose-500/25 disabled:opacity-50"
                  >{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3 fill-current" />} Ferma</button>
                </div>
                {/* Live glance at what's streaming RIGHT NOW (tail of the
                    newest reasoning/output, refreshed every 3s) — the full
                    piece lives in the "Ragionamento in corso" slice above. */}
                {streamPreview && (
                  <p
                    data-testid="task-stream-preview"
                    className="line-clamp-2 pl-1 text-[11px] italic leading-snug text-neutral-500"
                    title="Anteprima live dell'ultimo ragionamento in streaming"
                  >…{streamPreview}</p>
                )}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <div className="border-t border-white/10 p-2">
            {/* Review zone — decisions live HERE, where the agent's questions
                land (end of the thread), not up in the header. */}
            {task.status === 'review' && (
              <div className="mb-2 space-y-1.5">
                {pending && pending.options.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {pending.options.map((opt, i) => (
                      <button
                        key={i} disabled={sending}
                        onClick={() => answerOption(opt)}
                        className="rounded bg-white/10 px-2 py-1 text-xs text-neutral-100 hover:bg-white/20 disabled:opacity-50"
                      >{opt}</button>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <button
                    disabled={busy} onClick={() => decide('approve')}
                    title="Accetta e completa il task"
                    className="flex flex-1 items-center justify-center gap-1.5 rounded bg-emerald-500/80 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} Approva</button>
                  <button
                    disabled={busy} onClick={() => decide('reject')}
                    title={isAgentReview ? "Rifiuta (l'agent riparte senza indicazioni)" : 'Rifiuta'}
                    className="flex items-center gap-1.5 rounded bg-white/10 px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/20 disabled:opacity-50"
                  ><ShieldX className="h-3.5 w-3.5" /> Rifiuta</button>
                </div>
              </div>
            )}
            {attachments.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {attachments.map((a) => (
                  <span key={a.path} className="group/att relative">
                    {a.isImage ? (
                      <img src={getMediaUrl(a.path)} alt={a.name} title={a.name} className="h-12 w-12 rounded object-cover" />
                    ) : (
                      <span className="flex max-w-[10rem] items-center gap-1 rounded bg-white/10 px-1.5 py-1 text-[11px] text-neutral-300">
                        <Paperclip className="h-3 w-3 shrink-0" /><span className="truncate">{a.name}</span>
                      </span>
                    )}
                    <button
                      onClick={() => setAttachments((prev) => prev.filter((p) => p.path !== a.path))}
                      title="Rimuovi allegato"
                      className="absolute -right-1.5 -top-1.5 hidden rounded-full bg-neutral-700 p-0.5 text-neutral-200 group-hover/att:block"
                    ><X className="h-2.5 w-2.5" /></button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-end gap-1.5">
              <input
                ref={fileInputRef} type="file" multiple className="hidden"
                onChange={(e) => { if (e.target.files?.length) void uploadFiles(e.target.files); e.target.value = ''; }}
              />
              <button
                onClick={() => fileInputRef.current?.click()} disabled={uploading || attachments.length >= 8}
                title="Allega file (o incolla un'immagine nel campo)"
                className="rounded p-1.5 text-neutral-400 hover:bg-white/10 disabled:opacity-40"
              >{uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}</button>
              <textarea
                value={draft} onChange={(e) => setDraft(e.target.value)} rows={1}
                placeholder={isAgentReview ? 'Rispondi all\'agent…' : 'Commenta…'}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                onPaste={(e) => {
                  const imgs = Array.from(e.clipboardData?.items ?? [])
                    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
                    .map((i) => i.getAsFile()).filter((f): f is File => !!f);
                  if (imgs.length) { e.preventDefault(); void uploadFiles(imgs); }
                }}
                className="flex-1 resize-none rounded bg-white/5 px-2 py-1.5 text-sm text-neutral-100 outline-none"
              />
              <button
                onClick={send} disabled={sending || (!draft.trim() && attachments.length === 0)}
                title={isAgentReview ? "Rispondi (l'agent riparte con la tua risposta)" : 'Commenta'}
                className={`rounded p-1.5 text-white disabled:opacity-50 ${isAgentReview ? 'bg-sky-500/80 hover:bg-sky-500' : 'bg-emerald-500/80 hover:bg-emerald-500'}`}
              >{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button>
            </div>
          </div>
        </div>
        {/* Output panel only when there IS an output — never an empty frame. */}
        {wide && task?.outputUrl && <OutputPanel task={task} onOpenTopic={onOpenTopic} />}
      </div>
      )}
    </div>
  );
}

/**
 * One node of the subtask tree. Direct children arrive with the parent task;
 * deeper levels are fetched lazily on first expand (each task's `get` already
 * returns its children — no dedicated tree endpoint needed).
 */
function SubtaskNode({ projectId, node, depth, onOpenTask }: {
  projectId: string; node: BoardTask; depth: number; onOpenTask?: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<BoardTask[] | null>(null);
  const hasKids = node.subtaskCount > 0;
  const toggle = async () => {
    if (!open && kids === null) {
      try { const { children } = await boardApi.get(projectId, node.id); setKids(children ?? []); }
      catch { setKids([]); }
    }
    setOpen((o) => !o);
  };
  return (
    <div>
      <div className="flex items-center gap-1.5 rounded px-1 py-1 hover:bg-white/5" style={{ paddingLeft: 4 + depth * 14 }}>
        {hasKids ? (
          <button onClick={toggle} className="shrink-0 text-neutral-500 hover:text-neutral-300" title={open ? 'Chiudi' : 'Espandi'}>
            <ChevronRight className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span title={STATUS_LABEL[node.status]} className="flex shrink-0">
          <StatusIcon status={node.status} className="h-3 w-3" />
        </span>
        <button
          onClick={() => onOpenTask?.(node.id)}
          className={`min-w-0 flex-1 truncate text-left text-xs ${node.status === 'done' ? 'text-neutral-500 line-through' : 'text-neutral-200'}`}
        >{node.text}</button>
        {hasKids && <span className="shrink-0 text-[10px] text-neutral-500">↳ {node.subtaskDoneCount}/{node.subtaskCount}</span>}
      </div>
      {open && kids?.map((k) => (
        <SubtaskNode key={k.id} projectId={projectId} node={k} depth={depth + 1} onOpenTask={onOpenTask} />
      ))}
    </div>
  );
}

/**
 * Right side of the wide review surface: the task's attached output (an http(s)
 * URL the agent set via `update_task(output_url=…)` — dev server, rendered
 * page, report) in a sandboxed iframe. Without one, a sober empty state with
 * the agent-tab deep-link as the next best review surface.
 */
function OutputPanel({ task, onOpenTopic }: { task: BoardTask | null; onOpenTopic?: (topicId: string) => void }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col bg-neutral-950/40" data-testid="task-output-panel">
      {task?.outputUrl ? (
        <>
          <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
            <span className="truncate text-[11px] text-neutral-400" title={task.outputUrl}>{task.outputUrl}</span>
            <a
              href={task.outputUrl} target="_blank" rel="noreferrer"
              className="ml-auto shrink-0 rounded p-1 text-neutral-400 hover:bg-white/10"
              title="Apri in una nuova finestra"
            ><ExternalLink className="h-3.5 w-3.5" /></a>
          </div>
          <OutputFrame key={task.outputUrl} url={task.outputUrl} />
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-sm text-neutral-400">Nessun output collegato.</p>
          <p className="max-w-xs text-xs text-neutral-500">
            L'agent può allegare un URL (dev server, pagina, report) al task: comparirà qui, pronto per la review.
          </p>
          {task?.assignedTopicId && onOpenTopic && (
            <button
              onClick={() => onOpenTopic(task.assignedTopicId!)}
              className="mt-1 flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs text-neutral-200 hover:bg-white/20"
            ><ArrowUpRight className="h-3.5 w-3.5" /> Apri la tab dell'agent</button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The sandboxed output iframe with a loading veil (keyed by URL from the
 * caller, so a URL change remounts and the spinner shows again).
 *
 * Sandbox WITHOUT allow-same-origin: combined with allow-scripts it would void
 * the sandbox entirely (a frame pointed at THIS app's origin could reach
 * parent.document). Opaque origin keeps agent-set URLs inert; pages needing
 * their own storage open externally.
 */
function OutputFrame({ url }: { url: string }) {
  const [loading, setLoading] = useState(true);
  return (
    <div className="relative min-h-0 flex-1">
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-neutral-950/40">
          <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
        </div>
      )}
      <iframe
        src={url}
        title="Output del task"
        sandbox="allow-scripts allow-forms"
        onLoad={() => setLoading(false)}
        className="h-full w-full border-0 bg-white"
      />
    </div>
  );
}

/**
 * Attachments of a thread message: images inline (click = full size), other
 * files as name chips. Served through the allowlist-gated /api/media, exactly
 * like chat message media.
 */
function MediaStrip({ media }: { media?: string[] }) {
  if (!media || media.length === 0) return null;
  const isImg = (p: string) => /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(p);
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {media.map((p) => isImg(p) ? (
        <a key={p} href={getMediaUrl(p)} target="_blank" rel="noreferrer" title={p.split('/').pop()}>
          <img src={getMediaUrl(p)} alt="" loading="lazy" className="max-h-40 max-w-full rounded-md object-contain" />
        </a>
      ) : (
        <a
          key={p} href={getMediaUrl(p)} target="_blank" rel="noreferrer"
          className="flex max-w-[12rem] items-center gap-1 rounded bg-white/10 px-1.5 py-1 text-[11px] text-neutral-300 hover:bg-white/20"
        ><Paperclip className="h-3 w-3 shrink-0" /><span className="truncate">{p.split('/').pop()}</span></a>
      ))}
    </div>
  );
}

/** Compact chat timestamp: HH:MM today, dd/MM HH:MM otherwise. */
function commentTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })} ${hm}`;
}

/**
 * One thread message. Only the HUMAN's messages are chat bubbles (right,
 * accent tint); agent and system output is bare text on the left — no card, no
 * author title (for dispatched agents the raw author is the topic name = the
 * task title, so any label would read like a bogus username; it survives only
 * in the tooltip). System notes are dimmed.
 */
/** One session message with its placement timestamp (from /api/history). */
interface SessionMsg { role: string; content: string; timestamp: string; thinking?: string }

/**
 * A status transition in the timeline: "chi l'ha spostato e quando", rendered
 * as a thin event row between the speech bubbles (content = "from→to",
 * author = the actor — user, agent name, or dispatcher).
 */
function StatusEventRow({ comment }: { comment: TaskComment }) {
  const to = comment.content.split('→')[1] as TaskStatus | undefined;
  const valid = !!to && TASK_STATUSES.includes(to);
  const at = new Date(comment.createdAt);
  return (
    <div
      className="flex items-center gap-1.5 px-1 text-[11px] text-neutral-500"
      title={`${comment.content} · ${at.toLocaleString('it-IT')}`}
      data-testid="task-status-event"
    >
      {valid ? <StatusIcon status={to} className="h-3 w-3" /> : <span className="h-1 w-1 shrink-0 rounded-full bg-neutral-600" />}
      <span className="min-w-0 truncate">
        <span className="text-neutral-400">{comment.author}</span> → {valid ? STATUS_LABEL[to] : comment.content}
      </span>
      <span className="ml-auto shrink-0 text-neutral-600">{at.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span>
    </div>
  );
}

/** Compact duration: 42s · 7m · 1h12m. */
const fmtMs = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
};

/** Compact token count: 850 · 12.3k · 1.2M. */
const fmtTok = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** Live "ci sta mettendo" ticker for the current run (anchored server-side). */
function Ticker({ since }: { since: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = Date.now() - Date.parse(since);
  return <>{Number.isFinite(ms) && ms > 0 ? fmtMs(ms) : '0s'}</>;
}

/**
 * The slice of agent session between two thread comments — the "reasoning"
 * that produced the reply below it. Collapsed to a thin toggle by default
 * (chat-style thinking block); expands inline, read-only, same markdown
 * renderer as the chat. Renders nothing when the interval holds no messages.
 */
function SessionSlice({ msgs, label }: { msgs: SessionMsg[]; label?: string }) {
  const [open, setOpen] = useState(false);
  if (msgs.length === 0) return null;
  return (
    <div className="rounded-md border border-white/5 bg-white/[0.02]">
      <button
        onClick={() => setOpen((o) => !o)}
        title={open ? 'Comprimi il ragionamento' : 'Mostra cosa ha fatto la sessione in questo passaggio'}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-neutral-500 hover:text-neutral-300"
      >
        <Bot className="h-3 w-3 shrink-0" />
        <span>{label ?? 'Ragionamento'} · {msgs.length} passagg{msgs.length === 1 ? 'io' : 'i'}</span>
        <ChevronDown className={`ml-auto h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="max-h-72 space-y-2 overflow-y-auto border-t border-white/5 bg-black/20 px-2.5 py-2">
          {msgs.map((m, i) => (
            <div key={i} className="flex gap-1.5 text-xs leading-relaxed">
              <span className={`shrink-0 font-semibold ${m.role === 'user' ? 'text-sky-400' : 'text-neutral-500'}`}>
                {m.role === 'user' ? '›' : '⏺'}
              </span>
              <div className="min-w-0 flex-1 text-neutral-300 [&_code]:text-[11px] [&_p]:my-0.5 [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-black/40 [&_pre]:p-2 [&_ul]:my-0.5 [&_ul]:pl-4">
                <ChatMarkdown components={{}}>{m.content}</ChatMarkdown>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CommentBubble({ comment }: { comment: TaskComment }) {
  if (comment.author !== 'user') {
    const system = comment.author === 'system';
    return (
      <div className="pr-8" title={comment.author}>
        <div className={`text-sm ${system ? 'text-neutral-500' : 'text-neutral-200'}`}>
          <CommentBody content={comment.content} />
        </div>
        <MediaStrip media={comment.media} />
        <p className="mt-0.5 text-[9px] text-neutral-600">{commentTime(comment.createdAt)}</p>
      </div>
    );
  }
  return (
    <div className="flex justify-end">
      <div className="max-w-[88%] rounded-lg bg-sky-500/15 px-2.5 py-1.5 text-sm">
        <CommentBody content={comment.content} />
        <MediaStrip media={comment.media} />
        <p className="mt-0.5 text-right text-[9px] text-neutral-500">{commentTime(comment.createdAt)}</p>
      </div>
    </div>
  );
}

/**
 * Comment body (inside a chat bubble). A question block renders as a styled
 * decision request (question + option bullets) instead of raw ``` fences; any
 * text around the block is kept. Quick-reply buttons live on the card; in the
 * drawer the composer is the answer path (reject-with-text → agent resumes).
 */
function CommentBody({ content }: { content: string }) {
  const q = parseQuestionBlock(content);
  if (!q) return <p className="mt-0.5 whitespace-pre-wrap text-neutral-100">{content}</p>;
  const outside = content.replace(/```question[\s\S]*?```/, '').trim();
  return (
    <div className="mt-0.5 space-y-1">
      {outside && <p className="whitespace-pre-wrap text-neutral-100">{outside}</p>}
      <div className="rounded border border-rose-500/25 bg-rose-500/5 px-2 py-1.5">
        <p className="text-[13px] leading-snug text-rose-200">{q.question}</p>
        {q.options.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {q.options.map((opt, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[12px] text-neutral-200">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-rose-300/70" />{opt}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Board settings (auto-dispatch config) ───────────────────────────────────
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function BoardSettingsPanel({ projectId, settings: s, dispatchOn, onToggleDispatch, onChanged, onClose, onError }: {
  projectId: string;
  /** Owned by the board (per-project config) — this panel only renders and patches it. */
  settings: BoardSettings | null;
  /** The GLOBAL start switch — owned by the board header (same value as the pill). */
  dispatchOn: boolean | null;
  onToggleDispatch: () => void;
  onChanged: (s: BoardSettings) => void;
  onClose: () => void;
  onError: (e: string) => void;
}) {
  const patch = async (p: BoardSettingsPatch) => {
    try { onChanged(await boardApi.updateSettings(projectId, p)); }
    catch (e) { onError(e instanceof Error ? e.message : 'settings save failed'); }
  };

  if (!s) return null;
  return (
    <div className="shrink-0 space-y-2 border-b border-white/10 bg-neutral-900/60 px-3 py-2.5 text-xs text-neutral-300">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-neutral-200">Auto-dispatch</span>
        <button onClick={onClose} className="rounded p-0.5 text-neutral-400 hover:bg-white/10"><X className="h-3.5 w-3.5" /></button>
      </div>

      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span>Avvia un agent quando un task entra in <b>Todo</b> <span className="text-neutral-500">— interruttore globale, vale per tutte le board</span></span>
        <input type="checkbox" checked={!!dispatchOn} onChange={onToggleDispatch} className="h-3.5 w-3.5 shrink-0 accent-emerald-500" />
      </label>

      <label className="flex items-center justify-between">
        <span>Agent in parallelo (cap)</span>
        <input
          type="number" min={1} max={10} value={s.maxAgents}
          onChange={(e) => patch({ maxAgents: Number(e.target.value) })}
          className="w-14 rounded bg-white/5 px-1.5 py-0.5 text-right text-neutral-100 outline-none"
        />
      </label>

      <div className="flex items-center justify-between gap-2">
        <span>Effort</span>
        <div className="flex gap-0.5">
          {EFFORTS.map((ef) => (
            <button
              key={ef} onClick={() => patch({ dispatchEffort: ef })}
              className={`rounded px-1.5 py-0.5 ${s.dispatchEffort === ef ? 'bg-emerald-500/80 text-white' : 'bg-white/5 text-neutral-400 hover:bg-white/10'}`}
            >{ef}</button>
          ))}
        </div>
      </div>

      <label className="flex cursor-pointer items-center justify-between">
        <span>Isola ogni agent in un git worktree</span>
        <input type="checkbox" checked={s.dispatchUseWorktree} onChange={(e) => patch({ dispatchUseWorktree: e.target.checked })} className="h-3.5 w-3.5 accent-emerald-500" />
      </label>

      {dispatchOn && (
        <p className="text-[11px] text-amber-300/80">Attivo: spostare un task in Todo avvierà un agent con permessi pieni.</p>
      )}
    </div>
  );
}
