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
import { DndContext, DragOverlay, closestCorners, useDraggable, useDroppable, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { Bot, Check, ChevronDown, ChevronRight, ExternalLink, Loader2, Maximize2, Minimize2, Plus, Trash2, X, ShieldCheck, ShieldX, Send, Settings, ArrowUpRight } from 'lucide-react';
import type { WSMessage } from '../../types';
import { Menu } from '../Shared/Menu';
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

  useEffect(() => {
    if (!hasProject) { setSettings(null); return; }
    let alive = true;
    boardApi.getSettings(projectId)
      .then((v) => { if (alive) setSettings(v); })
      .catch(() => { /* pill just stays hidden */ });
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
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg) => {
      const m = msg as { type?: string; projectId?: string; settings?: BoardSettings };
      if (m.type === 'task:created' || m.type === 'task:updated' || m.type === 'task:deleted') {
        if (mode === 'all' || m.projectId === undefined || m.projectId === projectId) refetch();
      }
      if (m.type === 'board:settings' && m.projectId === projectId && m.settings) setSettings(m.settings);
    });
  }, [onMessage, projectId, refetch, mode]);

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

  const moveTo = useCallback(async (task: BoardTask, status: TaskStatus) => {
    if (task.status === status) return;
    patchLocal(task.id, { status }); // optimistic
    // Route by the task's OWN projectId so this works identically in the global
    // ('all') board, where cards come from many projects.
    try { await boardApi.update(task.projectId, task.id, { status }); }
    catch (e) { setError(e instanceof Error ? e.message : 'update failed'); refetch(); }
  }, [patchLocal, refetch]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragStart = useCallback((e: DragStartEvent) => setActiveId(String(e.active.id)), []);
  const onDragEnd = useCallback((e: DragEndEvent) => {
    setActiveId(null);
    const status = e.over?.id as TaskStatus | undefined;
    const task = tasks.find((t) => t.id === e.active.id);
    if (status && task && TASK_STATUSES.includes(status)) moveTo(task, status);
  }, [tasks, moveTo]);
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
          {hasProject && settings && (
            <button
              onClick={() => setShowSettings(true)}
              data-testid="board-dispatch-pill"
              title={settings.autoDispatch
                ? 'Auto-dispatch attivo: un task spostato in Todo avvia un agent'
                : 'Auto-dispatch spento: i task in Todo NON partono da soli — clicca per attivarlo'}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
                settings.autoDispatch ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/10 text-neutral-400 hover:bg-white/15'
              }`}
            >
              <Bot className="h-3 w-3" /> {settings.autoDispatch ? 'agent: on' : 'agent: off'}
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
          onChanged={setSettings}
          onClose={() => setShowSettings(false)}
          onError={setError}
        />
      )}
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
        <div className="flex h-full gap-3 overflow-x-auto p-3">
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
        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <div className="w-64 rounded-md border border-white/20 bg-neutral-800 p-2.5 text-sm text-neutral-100 shadow-xl">
              <div className="flex items-start gap-2">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[activeTask.priority] ?? PRIORITY_DOT[2]}`} />
                <span className="flex-1 leading-snug">{activeTask.text}</span>
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
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
        {tasks.map((t) => (
          <Card key={t.id} task={t} onOpen={onOpen} showProject={showProject} onError={onError} onRefetch={onRefetch} onOpenTopic={onOpenTopic} parentTitle={t.parentTaskId ? titleById.get(t.parentTaskId) : undefined} />
        ))}
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
  // Visual drag is handled by the board-level DragOverlay, so the source card
  // stays in place (just dimmed) — no transform here (that clipped it inside the
  // column's overflow before).
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });

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
        setLastComment(comments[comments.length - 1] ?? null);
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
  const lastThreadComment = comments[comments.length - 1] ?? null;
  const pending = isAgentReview && lastThreadComment ? parseQuestionBlock(lastThreadComment.content) : null;

  const deliverAnswer = async (v: string): Promise<boolean> => {
    try {
      if (isAgentReview) {
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
    const v = draft.trim(); if (!v || sending) return;
    setSending(true);
    const ok = await deliverAnswer(v);
    if (ok) setDraft(''); // cleared on success only — a failed send keeps the text
    setSending(false);
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

  const doneCount = children.filter((c) => c.status === 'done').length;

  return (
    <div
      data-testid="task-detail-drawer"
      className={`absolute inset-y-0 right-0 z-20 flex flex-col border-l border-white/10 bg-neutral-900/95 shadow-2xl backdrop-blur ${wide ? 'w-[min(64rem,94%)]' : 'w-96'}`}
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
        <span className="flex shrink-0 items-center gap-1.5 text-xs uppercase tracking-wide text-neutral-400">
          {task ? <StatusIcon status={task.status} /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {task ? STATUS_LABEL[task.status] : 'Carico…'}
        </span>
        {task?.dispatchState && DISPATCH_CHIP[task.dispatchState] && (
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${DISPATCH_CHIP[task.dispatchState].cls}`}>
            {DISPATCH_CHIP[task.dispatchState].text}
          </span>
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
        <div className={`flex min-w-0 flex-col ${wide ? 'w-96 shrink-0 border-r border-white/10' : 'flex-1'}`}>
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
          {/* Thread — chat-shaped: my messages right, agent/system left. */}
          <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
            {comments.length === 0 && <p className="text-xs text-neutral-500">Nessun commento.</p>}
            {comments.map((c) => <CommentBubble key={c.id} comment={c} />)}
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
            <div className="flex items-end gap-2">
              <textarea
                value={draft} onChange={(e) => setDraft(e.target.value)} rows={1}
                placeholder={isAgentReview ? 'Rispondi all\'agent…' : 'Commenta…'}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                className="flex-1 resize-none rounded bg-white/5 px-2 py-1.5 text-sm text-neutral-100 outline-none"
              />
              <button
                onClick={send} disabled={sending || !draft.trim()}
                title={isAgentReview ? "Rispondi (l'agent riparte con la tua risposta)" : 'Commenta'}
                className={`rounded p-1.5 text-white disabled:opacity-50 ${isAgentReview ? 'bg-sky-500/80 hover:bg-sky-500' : 'bg-emerald-500/80 hover:bg-emerald-500'}`}
              >{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button>
            </div>
          </div>
        </div>
        {wide && <OutputPanel task={task} onOpenTopic={onOpenTopic} />}
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
function CommentBubble({ comment }: { comment: TaskComment }) {
  if (comment.author !== 'user') {
    const system = comment.author === 'system';
    return (
      <div className="pr-8" title={comment.author}>
        <div className={`text-sm ${system ? 'text-neutral-500' : 'text-neutral-200'}`}>
          <CommentBody content={comment.content} />
        </div>
        <p className="mt-0.5 text-[9px] text-neutral-600">{commentTime(comment.createdAt)}</p>
      </div>
    );
  }
  return (
    <div className="flex justify-end">
      <div className="max-w-[88%] rounded-lg bg-sky-500/15 px-2.5 py-1.5 text-sm">
        <CommentBody content={comment.content} />
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

function BoardSettingsPanel({ projectId, settings: s, onChanged, onClose, onError }: {
  projectId: string;
  /** Owned by the board (header pill) — this panel only renders and patches it. */
  settings: BoardSettings | null;
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

      <label className="flex cursor-pointer items-center justify-between">
        <span>Avvia un agent quando sposto un task in <b>Todo</b></span>
        <input type="checkbox" checked={s.autoDispatch} onChange={(e) => patch({ autoDispatch: e.target.checked })} className="h-3.5 w-3.5 accent-emerald-500" />
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

      {s.autoDispatch && (
        <p className="text-[11px] text-amber-300/80">Attivo: spostare un task in Todo avvierà un agent con permessi pieni.</p>
      )}
    </div>
  );
}
