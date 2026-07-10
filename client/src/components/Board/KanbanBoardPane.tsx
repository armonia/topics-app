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
import { Loader2, Plus, Trash2, X, ShieldCheck, ShieldX, Send } from 'lucide-react';
import type { WSMessage } from '../../types';
import {
  boardApi, boardIdForPath, TASK_STATUSES, STATUS_LABEL,
  type BoardTask, type TaskStatus, type TaskComment,
} from '../../lib/board';

interface Props {
  /** Absent in the global ('Board generale') pane — there is no single project. */
  projectPath?: string;
  /** Global cross-project board: locks to 'all' mode, no project column, no add. */
  global?: boolean;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

const PRIORITY_DOT: Record<number, string> = {
  0: 'bg-neutral-400', 1: 'bg-sky-400', 2: 'bg-emerald-400', 3: 'bg-amber-400', 4: 'bg-rose-500',
};

export function KanbanBoardPane({ projectPath, global = false, onMessage }: Props) {
  const projectId = useMemo(() => (projectPath ? boardIdForPath(projectPath) : ''), [projectPath]);
  // The project/all toggle only makes sense inside a project window. The global
  // pane has no project, so it locks to 'all'.
  const canToggle = !!projectPath && !global;
  // 'project' = this project only · 'all' = the global cross-project board.
  const [mode, setMode] = useState<'project' | 'all'>(canToggle ? 'project' : 'all');
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg) => {
      const m = msg as { type?: string; projectId?: string };
      if (m.type === 'task:created' || m.type === 'task:updated' || m.type === 'task:deleted') {
        if (mode === 'all' || m.projectId === undefined || m.projectId === projectId) refetch();
      }
    });
  }, [onMessage, projectId, refetch, mode]);

  const byStatus = useMemo(() => {
    const m: Record<TaskStatus, BoardTask[]> = { backlog: [], todo: [], in_progress: [], review: [], done: [] };
    for (const t of tasks) (m[t.status] ??= []).push(t);
    for (const s of TASK_STATUSES) m[s].sort((a, b) => a.kanbanOrder - b.kanbanOrder);
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
    <div className="relative flex h-full flex-col overflow-hidden">
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
        {mode === 'all' && <span className="ml-auto text-[11px] text-neutral-500">{tasks.length} task · tutti i progetti</span>}
      </div>
      {error && <div className="shrink-0 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300">{error}</div>}
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
        />
      )}
    </div>
  );
}

// ── Column ────────────────────────────────────────────────────────────────
function Column({ status, tasks, onOpen, onCreate, canCreate, showProject, onError, onRefetch }: {
  status: TaskStatus; tasks: BoardTask[]; onOpen: (id: string) => void; onCreate: (text: string) => void;
  canCreate: boolean; showProject: boolean; onError: (e: string) => void; onRefetch: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const submit = () => { const v = text.trim(); if (v) { onCreate(v); } setText(''); setAdding(false); };

  return (
    <div ref={setNodeRef} className={`flex w-72 shrink-0 flex-col rounded-lg border ${isOver ? 'border-emerald-400/60 bg-emerald-400/5' : 'border-white/10 bg-white/5'}`}>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-300">{STATUS_LABEL[status]}</span>
        <span className="rounded bg-white/10 px-1.5 text-xs text-neutral-400">{tasks.length}</span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        {tasks.map((t) => (
          <Card key={t.id} task={t} onOpen={onOpen} showProject={showProject} onError={onError} onRefetch={onRefetch} />
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
function Card({ task, onOpen, showProject, onError, onRefetch }: {
  task: BoardTask; onOpen: (id: string) => void; showProject: boolean;
  onError: (e: string) => void; onRefetch: () => void;
}) {
  // Visual drag is handled by the board-level DragOverlay, so the source card
  // stays in place (just dimmed) — no transform here (that clipped it inside the
  // column's overflow before).
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });

  // Route mutations by the task's own projectId (works in the global board too).
  const review = async (decision: 'approve' | 'reject') => {
    try { await boardApi.review(task.projectId, task.id, decision); onRefetch(); }
    catch (e) { onError(e instanceof Error ? e.message : 'review failed'); }
  };
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
        {task.assignedTo && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-neutral-300">@{task.assignedTo}</span>}
      </div>
      {task.status === 'review' && (
        <div className="mt-2 flex gap-1 pl-4">
          <button onClick={(e) => { e.stopPropagation(); review('approve'); }} className="flex items-center gap-1 rounded bg-emerald-500/80 px-2 py-0.5 text-[11px] text-white hover:bg-emerald-500">
            <ShieldCheck className="h-3 w-3" /> Approva
          </button>
          <button onClick={(e) => { e.stopPropagation(); review('reject'); }} className="flex items-center gap-1 rounded bg-white/10 px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-white/20">
            <ShieldX className="h-3 w-3" /> Rifiuta
          </button>
        </div>
      )}
    </div>
  );
}

// ── Detail drawer (with comment thread) ─────────────────────────────────────
function TaskDetail({ projectId, taskId, onClose, onChanged }: {
  projectId: string; taskId: string; onClose: () => void; onChanged: () => void;
}) {
  const [task, setTask] = useState<BoardTask | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const { task, comments } = await boardApi.get(projectId, taskId);
      setTask(task); setComments(comments);
    } catch { /* closed or gone */ }
  }, [projectId, taskId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount: setState lands after the await, not synchronously
  useEffect(() => { load(); }, [load]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [comments.length]);

  const send = async () => {
    const v = draft.trim(); if (!v) return;
    setDraft('');
    try { await boardApi.comment(projectId, taskId, v); await load(); onChanged(); }
    catch { /* surfaced elsewhere */ }
  };

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-96 flex-col border-l border-white/10 bg-neutral-900/95 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-xs uppercase tracking-wide text-neutral-400">{task ? STATUS_LABEL[task.status] : ''}</span>
        <button onClick={onClose} className="rounded p-1 text-neutral-400 hover:bg-white/10"><X className="h-4 w-4" /></button>
      </div>
      <div className="border-b border-white/10 px-3 py-3">
        <p className="text-sm text-neutral-100">{task?.text}</p>
        {task?.description && <p className="mt-1 text-xs text-neutral-400">{task.description}</p>}
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {comments.length === 0 && <p className="text-xs text-neutral-500">Nessun commento.</p>}
        {comments.map((c) => (
          <div key={c.id} className="text-sm">
            <span className="text-[11px] font-semibold text-neutral-400">{c.author}</span>
            <p className="mt-0.5 whitespace-pre-wrap text-neutral-100">{c.content}</p>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="flex items-end gap-2 border-t border-white/10 p-2">
        <textarea
          value={draft} onChange={(e) => setDraft(e.target.value)} rows={1} placeholder="Commenta…"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          className="flex-1 resize-none rounded bg-white/5 px-2 py-1.5 text-sm text-neutral-100 outline-none"
        />
        <button onClick={send} className="rounded bg-emerald-500/80 p-1.5 text-white hover:bg-emerald-500"><Send className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
