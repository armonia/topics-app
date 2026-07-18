import { memo, useState, useEffect, useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowUpRight, ClipboardList, Lock, Plus, Send, ShieldCheck, ShieldX, Trash2 } from 'lucide-react';
import { ChatMarkdown } from '../ChatMarkdown';
import { ContextMenuPortal } from '../Shared/ContextMenuPortal';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { boardApi, STATUS_LABEL, parseQuestionBlock, isProjectlessId, type BoardTask, type TaskComment, type TaskStatus } from '../../lib/board';
import { stripMarkdown } from '../../lib/stripMarkdown';
import { PRIORITY_DOT, PRIORITY_LABEL, DISPATCH_CHIP, COMPACT_MD_CLS, type LiveUsage } from './constants';
import { fmtMs, fmtLive, fmtTok, fmtModel } from './format';
import { StatusIcon, DispatchChip } from './atoms';

// ── Column ────────────────────────────────────────────────────────────────
export function Column({ status, tasks, onOpen, onCreate, canCreate, showProject, onError, onRefetch, onOpenTopic, tasksById, projectPathById, liveById }: {
  status: TaskStatus; tasks: BoardTask[]; onOpen: (id: string) => void; onCreate: (text: string) => void;
  canCreate: boolean; showProject: boolean; onError: (e: string) => void; onRefetch: () => void;
  onOpenTopic?: (topicId: string) => void; tasksById: Map<string, BoardTask>; projectPathById: Map<string, string>;
  /** Live per-turn usage keyed by task id (ticking chip on working cards). */
  liveById: Map<string, LiveUsage>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const submit = () => { const v = text.trim(); if (v) { onCreate(v); } setText(''); setAdding(false); };
  // Stable identity across the board's 4s live-usage tick: SortableContext gets a
  // fresh array only when the task set actually changes, not every render.
  const itemIds = useMemo(() => tasks.map((t) => t.id), [tasks]);

  // Responsive columns. On phone/tablet (<lg) the board is a scroll-snap carousel:
  // every column is a fixed w-72 that fits a 320px viewport with a peek of its
  // neighbours on both sides, and `snap-center` makes each column glide to the
  // middle as its own "slide" when you swipe — so Review simply arrives as one of
  // the slides instead of being pinned on screen. On desktop (lg+) snapping is off,
  // columns sit in normal flow, and Review widens for its inline controls.
  const isReview = status === 'review';
  const snapCls = 'snap-center lg:snap-align-none';
  const widthCls = isReview ? 'w-72 lg:w-[32rem]' : 'w-72';
  const borderCls = isOver ? 'border-emerald-400/60' : 'border-white/10';
  const bgCls = isOver ? 'bg-emerald-400/5' : 'bg-white/5';

  return (
    <div ref={setNodeRef} data-testid={`kanban-column-${status}`} className={`flex ${widthCls} shrink-0 flex-col rounded-lg border ${snapCls} ${borderCls} ${bgCls}`}>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-300">
          <StatusIcon status={status} />
          {STATUS_LABEL[status]}
        </span>
        <span className="rounded bg-white/10 px-1.5 text-xs text-neutral-400">{tasks.length}</span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {tasks.map((t) => (
            <Card
              key={t.id} task={t} onOpen={onOpen} showProject={showProject} onError={onError} onRefetch={onRefetch} onOpenTopic={onOpenTopic}
              parentTitle={t.parentTaskId ? tasksById.get(t.parentTaskId)?.text : undefined}
              blocker={t.blockedByTaskId ? tasksById.get(t.blockedByTaskId) : undefined}
              projectPath={projectPathById.get(t.projectId)}
              live={liveById.get(t.id)}
            />
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
// Memoized: the board re-renders every 4s as the live-usage ticker rebuilds
// `liveById`. Without memo every card re-renders on each tick; with it only the
// cards whose `live` prop actually changed (the working ones) do. All handler
// props from the parent (onOpen/onError/onRefetch/onOpenTopic) are stable
// (useCallback / state setters), and task/blocker come from tasks-keyed memos,
// so the shallow prop compare holds for idle cards.
export const Card = memo(function Card({ task, onOpen, showProject, onError, onRefetch, onOpenTopic, parentTitle, blocker, projectPath, live }: {
  task: BoardTask; onOpen: (id: string) => void; showProject: boolean;
  onError: (e: string) => void; onRefetch: () => void; onOpenTopic?: (topicId: string) => void;
  /** Text of the parent task when this card is a subtask (context chip). */
  parentTitle?: string;
  /** The task this one is gated on, when still unresolved (blocked-by chip). */
  blocker?: BoardTask;
  /** Real filesystem path of task.projectId, for the favicon (cross-project board only). */
  projectPath?: string;
  /** Live per-turn usage while this task's agent works (ticking chip). */
  live?: LiveUsage;
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
  // Right-click menu (archive/select live here now — NOT as a trash icon that
  // crowds the card header). Cursor-positioned, portaled, viewport-clamped.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
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
  // Project-less = truly unassigned OR the catch-all board (which runs the task
  // standalone). Both render with NO chip — the "generale" label is noise.
  const unassigned = isProjectlessId(task.projectId);
  const projectLabel = task.projectId.replace(/-[^-]+$/, '');

  return (
    <div
      ref={setNodeRef} {...attributes} {...listeners}
      data-task-card={task.id}
      style={{ transform: isDragging ? undefined : CSS.Transform.toString(transform), transition }}
      onClick={() => onOpen(task.id)}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
      className={`group cursor-grab rounded-md border border-white/10 bg-neutral-800/60 p-2.5 text-sm text-neutral-100 shadow-sm hover:border-white/20 ${isDragging ? 'opacity-40' : ''}`}
    >
      {/* Project eyebrow: favicon + plain project name ABOVE the title (no chip),
          so a cross-project card reads "which project" first, then the title —
          the name isn't competing as a pill down in the meta row. */}
      {showProject && !unassigned && (
        <div className="mb-1 flex items-center gap-1 text-[11px] text-neutral-400">
          {projectPath && <ProjectFavicon path={projectPath} size={12} className="shrink-0" />}
          <span className="min-w-0 truncate font-medium">{projectLabel}</span>
        </div>
      )}
      {/* Header: title left, PRIMARY STATE pinned top-right — same slot on every
          card, so the eye finds "dov'è il task" without scanning the chip row.
          No delete icon here: archive/select live in the right-click menu. */}
      <div className="flex items-start gap-2">
        {/* min-w-0 lets the flex item shrink below its content's intrinsic
            width; break-words then wraps long unbreakable tokens (URL, path,
            hash, branch) instead of spilling the card past the column edge. */}
        <span className="min-w-0 flex-1 break-words leading-snug">{task.text}</span>
        {(task.dispatchState && DISPATCH_CHIP[task.dispatchState]) ? (
          <DispatchChip state={task.dispatchState} error={task.dispatchError} />
        ) : (!task.dispatchState && task.dispatchError) ? (
          <span className="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-[11px] text-rose-300" title={task.dispatchError}>fermato</span>
        ) : null}
      </div>
      {/* Meta: every informational chip stays VISIBLE, zoned below the title in a
          tidy row (attributi del task). State + archive live top-right, above. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {!task.priorityAuto && task.priority !== 2 && (
          <span
            title={`Priorità: ${PRIORITY_LABEL[task.priority] ?? task.priority}`}
            className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] ${
              task.priority >= 3 ? 'bg-rose-500/15 text-rose-300' : 'bg-white/10 text-neutral-400'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${PRIORITY_DOT[task.priority] ?? PRIORITY_DOT[2]}`} />
            {PRIORITY_LABEL[task.priority] ?? task.priority}
          </span>
        )}
        {/* (Model shown once, inside the time/effort chip below — never as a
            standalone chip. See the effort chip a few lines down.) */}
        {/* (Project identity moved to the eyebrow above the title — no chip here.) */}
        {blocker && blocker.status !== 'done' && (
          <span
            title={`In attesa di: ${blocker.text}`}
            className="flex max-w-[11rem] items-center gap-1 truncate rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-300"
          ><Lock className="h-3 w-3 shrink-0" /> <span className="truncate">in attesa di: {blocker.text}</span></span>
        )}
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
        {live && task.dispatchState === 'working' ? (
          <LiveEffortChip usage={live} />
        ) : (task.model || task.agentMs > 0 || task.agentTokens > 0) ? (
          // The model always lives here, in the time/effort chip — never as a
          // second standalone chip. Before the agent has logged any time we
          // show just the model; once it runs we prepend it to the ⏱ effort,
          // matching the live chip (`Opus · ⏱ 2m · 1.2k tok`).
          <span
            title={(task.agentMs > 0 || task.agentTokens > 0)
              ? `Effort dell'agent: ${fmtMs(task.agentMs)} di lavoro${task.agentTokens ? `, ${task.agentTokens.toLocaleString('it-IT')} token` : ''}${task.agentCacheReadTokens > 0 ? ` (+${fmtTok(task.agentCacheReadTokens)} cache read)` : ''} · modello ${fmtModel(task.model)}`
              : `Modello: ${fmtModel(task.model)}`}
            className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-neutral-400"
          >{fmtModel(task.model)}{(task.agentMs > 0 || task.agentTokens > 0) && ` · ⏱ ${fmtMs(task.agentMs)}${task.agentTokens > 0 ? ` · ${fmtTok(task.agentTokens)} tok` : ''}`}</span>
        ) : null}
        {task.assignedTo && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-neutral-300">@{task.assignedTo}</span>}
        {task.assignedTopicId && onOpenTopic && (
          <button
            onClick={(e) => { e.stopPropagation(); onOpenTopic(task.assignedTopicId!); }}
            className="flex items-center gap-0.5 rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-neutral-200 hover:bg-white/20"
            title="Apri la tab dell'agent"
          ><ArrowUpRight className="h-3 w-3" /> apri tab</button>
        )}
      </div>
      {task.status === 'review' && isAgentReview && (
        <div className="mt-2 space-y-1.5" onClick={(e) => e.stopPropagation()}>
          {/* The agent's last word, ALWAYS on the card — a formatted question
              with quick-reply buttons when it's a question block, plain text
              otherwise. Approving/rejecting blind was the bug. */}
          {pending ? (
            <p className="break-words text-xs leading-snug text-neutral-200">{stripMarkdown(pending.question)}</p>
          ) : lastComment ? (
            // Render the agent's last word as REAL markdown (bold/headings/lists
            // format instead of showing raw `**`/`#`). Shown in full — no clamp,
            // no fade. Tooltip = plain text.
            <div
              className={`text-xs leading-relaxed text-neutral-300 ${COMPACT_MD_CLS}`}
              title={`${lastComment.author}: ${stripMarkdown(lastComment.content)}`}
            >
              <ChatMarkdown components={{}}>{lastComment.content}</ChatMarkdown>
            </div>
          ) : null}
          {pending && pending.options.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {pending.options.map((opt, i) => (
                <button
                  key={i} disabled={busy}
                  onClick={() => answer(opt)}
                  className="rounded-md bg-white/10 px-2.5 py-1.5 text-xs text-neutral-100 hover:bg-white/20 disabled:opacity-50"
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
              className="min-w-0 flex-1 rounded-md bg-black/30 px-2.5 py-1.5 text-xs text-neutral-100 outline-none placeholder:text-neutral-500"
            />
            <button
              disabled={busy || !freeText.trim()} onClick={() => answer(freeText.trim())}
              title="Rispondi (l'agent riparte con la tua risposta)"
              className="flex items-center gap-1 rounded-md bg-sky-500/80 px-2.5 py-1.5 text-xs text-white hover:bg-sky-500 disabled:opacity-50"
            ><Send className="h-3.5 w-3.5" /></button>
            <button
              disabled={busy} onClick={() => review('approve')}
              title="Accetta e completa il task"
              className="flex items-center gap-1 rounded-md bg-emerald-500/80 px-2.5 py-1.5 text-xs text-white hover:bg-emerald-500 disabled:opacity-50"
            ><ShieldCheck className="h-3.5 w-3.5" /></button>
            <button
              disabled={busy} onClick={() => review('reject')}
              title="Rifiuta (l'agent riparte senza indicazioni)"
              className="flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/20 disabled:opacity-50"
            ><ShieldX className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      )}
      {task.status === 'review' && !isAgentReview && (
        <div className="mt-2 flex gap-1" onClick={(e) => e.stopPropagation()}>
          <button disabled={busy} onClick={() => review('approve')} className="flex items-center gap-1 rounded-md bg-emerald-500/80 px-2.5 py-1.5 text-xs text-white hover:bg-emerald-500 disabled:opacity-50">
            <ShieldCheck className="h-3.5 w-3.5" /> Approva
          </button>
          <button disabled={busy} onClick={() => review('reject')} className="flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-white/20 disabled:opacity-50">
            <ShieldX className="h-3.5 w-3.5" /> Rifiuta
          </button>
        </div>
      )}
      {ctxMenu && (
        <ContextMenuPortal open x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
          <button
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setCtxMenu(null); onOpen(task.id); }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10"
          ><ClipboardList className="h-3.5 w-3.5 text-neutral-400" /> Apri</button>
          {task.assignedTopicId && onOpenTopic && (
            <button
              role="menuitem"
              onClick={(e) => { e.stopPropagation(); setCtxMenu(null); onOpenTopic(task.assignedTopicId!); }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/10"
            ><ArrowUpRight className="h-3.5 w-3.5 text-neutral-400" /> Apri tab agent</button>
          )}
          <div className="my-1 border-t border-white/10" />
          <button
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setCtxMenu(null); archive(); }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-rose-300 hover:bg-rose-500/10"
          ><Trash2 className="h-3.5 w-3.5" /> Archivia</button>
        </ContextMenuPortal>
      )}
    </div>
  );
});

/**
 * Live effort chip shown while a turn runs: model · execution-time · tokens,
 * ticking every second. The time is EXECUTION-ONLY: `baseMs` is the agent_ms
 * accumulated over PRIOR turns and we add only (now − turnStartedAt) for the
 * current turn — never the idle/queued/asleep gaps between turns (the server
 * anchors turnStartedAt at the actual turn start). Falls back to the static
 * agent_ms/agent_tokens chip the instant the turn ends.
 */
export function LiveEffortChip({ usage }: { usage: LiveUsage }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // eslint-disable-next-line react-hooks/purity -- live effort chip: force-re-renders every 1s (interval above) and reads the clock each render on purpose
  const ms = usage.baseMs + Math.max(0, Date.now() - usage.turnStartedAt);
  return (
    <span
      title={`In esecuzione — modello ${fmtModel(usage.model)}, ${fmtLive(ms)} di lavoro${usage.liveTokens ? `, ${usage.liveTokens.toLocaleString('it-IT')} token` : ''} (aggiornamento live)`}
      className="flex items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] text-sky-300 tabular-nums"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
      {fmtModel(usage.model)} · ⏱ {fmtLive(ms)}{usage.liveTokens > 0 && ` · ${fmtTok(usage.liveTokens)} tok`}
    </span>
  );
}
