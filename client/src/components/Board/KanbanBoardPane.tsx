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
import { Bot, Loader2, Plus, Trash2, X, ShieldCheck, ShieldX, Send, Settings, ArrowUpRight } from 'lucide-react';
import type { WSMessage } from '../../types';
import {
  boardApi, boardIdForPath, TASK_STATUSES, STATUS_LABEL, parseQuestionBlock,
  type BoardTask, type TaskStatus, type TaskComment, type BoardSettings, type BoardSettingsPatch,
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

// Card chip for the dispatch lifecycle (server: tasks.dispatch_state).
const DISPATCH_CHIP: Record<string, { text: string; cls: string }> = {
  queued: { text: 'in coda', cls: 'bg-white/10 text-neutral-300' },
  starting: { text: 'avvio…', cls: 'bg-amber-500/15 text-amber-300' },
  working: { text: 'al lavoro', cls: 'bg-sky-500/15 text-sky-300' },
  needs_input: { text: 'serve te', cls: 'bg-rose-500/15 text-rose-300' },
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
          projectId={selected.projectId}
          taskId={selected.id}
          onClose={() => setSelectedId(null)}
          onChanged={refetch}
          onOpenTask={setSelectedId}
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
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-300">{status === 'review' ? 'Serve te' : STATUS_LABEL[status]}</span>
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
            <p className="line-clamp-3 text-[11px] leading-snug text-neutral-300" title={lastComment.content}>
              <span className="font-semibold text-neutral-400">{lastComment.author}: </span>
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

// ── Detail drawer (with comment thread) ─────────────────────────────────────
function TaskDetail({ projectId, taskId, onClose, onChanged, onOpenTask }: {
  projectId: string; taskId: string; onClose: () => void; onChanged: () => void;
  /** Navigate the drawer to another task (subtask ↔ parent). */
  onOpenTask?: (taskId: string) => void;
}) {
  const [task, setTask] = useState<BoardTask | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [children, setChildren] = useState<BoardTask[]>([]);
  const [draft, setDraft] = useState('');
  const [subDraft, setSubDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const { task, comments, children } = await boardApi.get(projectId, taskId);
      setTask(task); setComments(comments); setChildren(children ?? []);
    } catch { /* closed or gone */ }
  }, [projectId, taskId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: setState lands after the await, not synchronously
  useEffect(() => { load(); }, [load]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [comments.length]);

  // A human comment on an agent-delivered review IS the answer — same
  // semantics as the card's quick-reply: reject carries the text and resumes
  // the SAME agent tab (server: reviewDecision → comment + in_progress +
  // dispatcher.resume). A plain comment here would sit unread while the chip
  // says "serve te". Non-agent tasks (or any other status) keep plain comments.
  const isAgentReview = !!task && task.status === 'review' && !!task.assignedTopicId;
  const send = async () => {
    const v = draft.trim(); if (!v) return;
    setDraft('');
    try {
      if (isAgentReview) {
        // Race fallback: if the task left review meanwhile, still save the text
        // as a plain comment instead of losing it.
        try { await boardApi.review(projectId, taskId, 'reject', v); }
        catch { await boardApi.comment(projectId, taskId, v); }
      } else {
        await boardApi.comment(projectId, taskId, v);
      }
      await load(); onChanged();
    } catch { /* surfaced elsewhere */ }
  };

  // Quick-add a nested subtask. Born in backlog (intake), like agent creates —
  // dragging it to Todo is the explicit "vai" gesture.
  const addSubtask = async () => {
    const v = subDraft.trim(); if (!v) return;
    setSubDraft('');
    try { await boardApi.create(projectId, { text: v, status: 'backlog', parentTaskId: taskId }); await load(); onChanged(); }
    catch { /* surfaced elsewhere */ }
  };

  return (
    <div data-testid="task-detail-drawer" className="absolute inset-y-0 right-0 z-20 flex w-96 flex-col border-l border-white/10 bg-neutral-900/95 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-xs uppercase tracking-wide text-neutral-400">{task ? STATUS_LABEL[task.status] : ''}</span>
        <button onClick={onClose} className="rounded p-1 text-neutral-400 hover:bg-white/10"><X className="h-4 w-4" /></button>
      </div>
      <div className="border-b border-white/10 px-3 py-3">
        {task?.parentTaskId && onOpenTask && (
          <button
            onClick={() => onOpenTask(task.parentTaskId!)}
            className="mb-1.5 flex items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-300 hover:bg-violet-500/25"
          >⤴ Task padre</button>
        )}
        <p className="text-sm text-neutral-100">{task?.text}</p>
        {task?.description && <p className="mt-1 text-xs text-neutral-400">{task.description}</p>}
      </div>
      {/* Subtasks — nested work, unlimited depth. Click navigates the drawer. */}
      <div className="border-b border-white/10 px-3 py-2" data-testid="task-detail-subtasks">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          Sottotask{children.length > 0 ? ` · ${children.filter((c) => c.status === 'done').length}/${children.length}` : ''}
        </p>
        {children.map((c) => (
          <button
            key={c.id}
            onClick={() => onOpenTask?.(c.id)}
            className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-white/5"
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.status === 'done' ? 'bg-emerald-400' : c.status === 'in_progress' || c.status === 'review' ? 'bg-sky-400' : 'bg-neutral-500'}`} />
            <span className={`min-w-0 flex-1 truncate text-xs ${c.status === 'done' ? 'text-neutral-500 line-through' : 'text-neutral-200'}`}>{c.text}</span>
            <span className="shrink-0 text-[10px] uppercase text-neutral-500">{STATUS_LABEL[c.status]}</span>
            {c.subtaskCount > 0 && <span className="shrink-0 text-[10px] text-neutral-500">↳ {c.subtaskDoneCount}/{c.subtaskCount}</span>}
          </button>
        ))}
        <input
          value={subDraft}
          onChange={(e) => setSubDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSubtask(); } }}
          placeholder="+ sottotask…"
          className="mt-1 w-full rounded bg-white/5 px-2 py-1 text-xs text-neutral-100 outline-none placeholder:text-neutral-600"
        />
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {comments.length === 0 && <p className="text-xs text-neutral-500">Nessun commento.</p>}
        {comments.map((c) => (
          <div key={c.id} className="text-sm">
            <span className="text-[11px] font-semibold text-neutral-400">{c.author}</span>
            <CommentBody content={c.content} />
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-white/10 p-2">
        {isAgentReview && (
          <p className="mb-1 px-0.5 text-[10px] text-sky-300/80">
            Il task è in review: la tua risposta fa ripartire l'agent (torna In Progress).
          </p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={draft} onChange={(e) => setDraft(e.target.value)} rows={1}
            placeholder={isAgentReview ? 'Rispondi all\'agent…' : 'Commenta…'}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            className="flex-1 resize-none rounded bg-white/5 px-2 py-1.5 text-sm text-neutral-100 outline-none"
          />
          <button
            onClick={send}
            title={isAgentReview ? "Rispondi (l'agent riparte con la tua risposta)" : 'Commenta'}
            className={`rounded p-1.5 text-white ${isAgentReview ? 'bg-sky-500/80 hover:bg-sky-500' : 'bg-emerald-500/80 hover:bg-emerald-500'}`}
          ><Send className="h-4 w-4" /></button>
        </div>
      </div>
    </div>
  );
}

/**
 * Comment body for the detail drawer. A question block renders as a styled
 * decision request (question + option bullets) instead of raw ``` fences; any
 * text around the block is kept. Answering stays on the card's quick-reply —
 * the drawer is the reading surface.
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
