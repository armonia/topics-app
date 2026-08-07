import { memo, useState, useEffect, useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, ArrowUpRight, ClipboardList, Hourglass, Lock, MessageSquare, Plus, Send, ShieldCheck, ShieldX, Trash2 } from 'lucide-react';
import { ChatMarkdown } from '../ChatMarkdown';
import { ContextMenuPortal } from '../Shared/ContextMenuPortal';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { boardApi, STATUS_LABEL, isAgentWorking, parseQuestionBlock, isProjectlessId, systemDeliveryNote, SYSTEM_DELIVERY_CHIP, type BoardTask, type TaskComment, type TaskStatus } from '../../lib/board';
import { useConfirm } from '../../hooks/useConfirm';
import { PreviewMedia } from './PreviewMedia';
import { stripMarkdown } from '../../lib/stripMarkdown';
import { PRIORITY_DOT, PRIORITY_LABEL, DISPATCH_CHIP, COMPACT_MD_CLS, mediaPaneIdFor, type LiveUsage, type OpenTask } from './constants';
import { fmtMs, fmtLive, fmtTok, fmtModel, fmtUpdatedAt } from './format';
import { StatusIcon, DispatchChip, TaskIdChip } from './atoms';
import { POPOVER_DIVIDER, POPOVER_ITEM, POPOVER_ITEM_DANGER } from '@/lib/popoverStyles';

// ── Column ────────────────────────────────────────────────────────────────
export function Column({ status, tasks, onOpen, onCreate, canCreate, showProject, onError, onRefetch, onOpenTopic, tasksById, projectPathById, liveById }: {
  status: TaskStatus; tasks: BoardTask[]; onOpen: OpenTask; onCreate: (text: string) => void;
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

  // Responsive columns. The board is a scroll-snap carousel at EVERY breakpoint:
  // each column `snap-center`s to the middle as its own "slide", so whenever the
  // columns overflow the viewport (a phone, or a narrow desktop pane / open drawer)
  // scrolling glides column-by-column and always frames a useful one — instead of
  // stopping half-way between two. When everything already fits (wide desktop),
  // there is no overflow so snapping is inert. Columns are a fixed w-72 with a peek
  // of their neighbours on both sides; Review is wider (its own, roomier slide).
  const isReview = status === 'review';
  const snapCls = 'snap-center';
  // Review is the approval surface — give it more room than the working columns
  // on every viewport (wider slide on mobile, 32rem on desktop).
  const widthCls = isReview ? 'w-[22rem] lg:w-[32rem]' : 'w-72';
  const borderCls = isOver ? 'border-emerald-400/60' : 'border-app-border';
  const bgCls = isOver ? 'bg-emerald-400/5' : 'bg-white/5';

  return (
    <div ref={setNodeRef} data-testid={`kanban-column-${status}`} className={`flex ${widthCls} shrink-0 flex-col rounded-lg border ${snapCls} ${borderCls} ${bgCls}`}>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-app-text-heading">
          <StatusIcon status={status} />
          {STATUS_LABEL[status]}
        </span>
        <span className="rounded bg-white/10 px-1.5 text-xs text-app-text-secondary">{tasks.length}</span>
      </div>
      {/* Bottom clearance lives on the scroll body (not the outer board padding)
          so the column FRAME reaches the bottom of the pane, while a full column's
          last card can still scroll clear of the floating "Descrivi un task" box.
          On a short column it is invisible slack below the already-empty area. */}
      {/* scrollbar-standard keeps the app's standard thin hover scrollbar as the
          single indicator and zeroes the legacy ::-webkit-scrollbar, so the
          native bar no longer renders ON TOP of it (the "double bar" on hover). */}
      <div data-testid={`kanban-column-body-${status}`} className="flex-1 space-y-2 overflow-y-auto px-2 pb-16 scrollbar-standard">
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
          <div className="rounded-md border border-app-border bg-white/5 p-2">
            <textarea
              autoFocus value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === 'Escape') { setText(''); setAdding(false); } }}
              className="w-full resize-none bg-transparent text-sm text-app-text outline-none" rows={2} placeholder="Task…"
            />
            <div className="mt-1 flex justify-end gap-1">
              <button onClick={() => { setText(''); setAdding(false); }} className="rounded px-2 py-0.5 text-xs text-app-text-secondary hover:bg-white/10">Annulla</button>
              <button onClick={submit} className="rounded bg-emerald-500/80 px-2 py-0.5 text-xs text-white hover:bg-emerald-500">Aggiungi</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-xs text-app-text-secondary hover:bg-white/5">
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
  task: BoardTask; onOpen: OpenTask; showProject: boolean;
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

  // Review context, lazily loaded from the task detail (one GET, two uses):
  // for an agent-driven task the LAST comment — a quick-reply with option
  // buttons when it's a question block, plain text otherwise (the human must
  // never be asked Approva/Rifiuta blind); for ANY review card with steps the
  // direct CHILDREN, expanded on the card as the delivery checklist. Subtasks
  // never ride the board feed (rootsOnly), so the card fetches them itself.
  const [lastComment, setLastComment] = useState<TaskComment | null>(null);
  const [children, setChildren] = useState<BoardTask[]>([]);
  const [freeText, setFreeText] = useState('');
  const [busy, setBusy] = useState(false);
  // Right-click menu (archive/select live here now — NOT as a trash icon that
  // crowds the card header). Cursor-positioned, portaled, viewport-clamped.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const confirm = useConfirm();
  const isAgentReview = task.status === 'review' && !!task.assignedTopicId;
  const wantDetail = isAgentReview || (task.status === 'review' && task.subtaskCount > 0);
  useEffect(() => {
    if (!wantDetail) { setLastComment(null); setChildren([]); return; }
    let alive = true;
    boardApi.get(task.projectId, task.id)
      .then(({ comments, children: kids }) => {
        if (!alive) return;
        // Status events are history rows, not the agent's word — skip them.
        const speech = comments.filter((c) => c.kind !== 'status');
        setLastComment(isAgentReview ? speech[speech.length - 1] ?? null : null);
        setChildren(kids ?? []);
      })
      .catch(() => { if (alive) { setLastComment(null); setChildren([]); } });
    return () => { alive = false; };
    // Re-check when the task changes (a re-kick bumps updatedAt).
  }, [wantDetail, isAgentReview, task.projectId, task.id, task.updatedAt]);
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
    // Archiviare un task con l'agent al lavoro gli taglia il turno (il server lo
    // stacca prima di archiviare, altrimenti resterebbe a girare per nessuno).
    // Il turno non torna indietro, quindi si chiede — ma solo quando c'è
    // davvero un agent da fermare: su una card ferma la domanda sarebbe rumore.
    if (isAgentWorking(task.dispatchState)) {
      const ok = await confirm({
        title: 'Archiviare un task in corso?',
        confirmLabel: 'Archivia e ferma',
        body: <p>Su questo task c&apos;è un agent al lavoro: archiviandolo il suo turno viene interrotto e non riprende.</p>,
      });
      if (!ok) return;
    }
    try { await boardApi.archive(task.projectId, task.id); onRefetch(); }
    catch (e) { onError(e instanceof Error ? e.message : 'archive failed'); }
  };
  // Steer a WORKING agent: a comment on an in_progress task is buffered by the
  // dispatcher and handed over at the next turn (Claude-Code style). Same
  // /comments endpoint as the drawer composer — the server routes it to resume().
  const steer = async (text: string) => {
    const v = text.trim();
    if (busy || !v) return;
    setBusy(true);
    try { await boardApi.comment(task.projectId, task.id, v); setFreeText(''); onRefetch(); }
    catch (e) { onError(e instanceof Error ? e.message : 'steer failed'); }
    finally { setBusy(false); }
  };
  // Human-readable project label = the dirName prefix before the id hash.
  // Project-less = truly unassigned OR the catch-all board (which runs the task
  // standalone). Both render with NO chip — the "generale" label is noise.
  const unassigned = isProjectlessId(task.projectId);
  const projectLabel = task.projectId.replace(/-[^-]+$/, '');
  // A task in review is the APPROVAL surface, never the "steer a working agent"
  // surface — so it's never busy here even if a stale dispatch_state='working'
  // lingers. Without this gate a review task with dispatch_state='working'
  // renders BOTH the steer input and the review feedback input (two boxes).
  const agentBusy = task.status !== 'review' && isAgentWorking(task.dispatchState);
  // Agent cluster in the card's top-right slot: dispatch state + model/effort +
  // "apri tab" all live up there — the body below stays pure content.
  const hasOpenTab = !!(task.assignedTopicId && onOpenTopic);
  // Always shown: the eyebrow row carries the click-to-copy task id on every card
  // (plus project/state/model/tab when present).
  const showTopRow = true;
  const showPriority = !task.priorityAuto && task.priority !== 2;
  // Review expands the subtask checklist on the card; elsewhere the count chip suffices.
  const checklist = task.status === 'review' ? children : [];
  // "done" that never reached main — the 19/07 loss, made visible. Only on done:
  // a task in review is legitimately not landed yet, flagging it would be noise.
  const notLanded = task.status === 'done' && task.landingState === 'unlanded';
  // Solo il ROSSO va sulla card: un verde è la norma e riempirebbe la colonna di
  // spunte che nessuno legge, mentre il rosso è la ragione per non aprire il task.
  const checksRed = task.checksState === 'fail';
  // Solo in Review: lì la domanda è "cosa guardo?", e la risposta cambia se
  // nessun agent ha detto "fatto". Su una card done sarebbe archeologia (il
  // drawer la conserva comunque).
  const systemDelivered = task.status === 'review' && task.deliveredBy === 'system';
  const hasMetaRow = !!((blocker && blocker.status !== 'done') || task.parentTaskId || task.userCommentCount > 0 || task.planFirst || task.assignedTo || notLanded || checksRed || systemDelivered);

  return (
    <div
      ref={setNodeRef} {...attributes} {...listeners}
      data-task-card={task.id}
      style={{ transform: isDragging ? undefined : CSS.Transform.toString(transform), transition }}
      onClick={() => onOpen(task.id)}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
      className={`group cursor-grab rounded-md border border-app-border bg-surface p-2.5 text-sm text-app-text shadow-sm hover:border-app-border-light ${isDragging ? 'opacity-40' : ''}`}
    >
      {/* Top row: project eyebrow (cross-project) on the LEFT; the AGENT
          cluster in the top-right SLOT — dispatch state, model/effort, "apri
          tab". Everything about "who's on this and where" lives up here, so
          the body below is pure content. flex-wrap + justify-end: on a narrow
          card extra chips drop to a second right-aligned line instead of
          crushing the eyebrow. */}
      {showTopRow && (
        <div className="mb-1 flex flex-wrap items-center justify-end gap-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1 text-xs md:text-[11px] text-app-text-secondary">
            {showProject && !unassigned && (
              <>
                {projectPath && <ProjectFavicon path={projectPath} size={12} className="shrink-0" />}
                <span className="min-w-0 truncate font-medium">{projectLabel}</span>
              </>
            )}
            <TaskIdChip id={task.id} />
          </div>
          {/* The live chip's pulse dot already says "working": while it ticks,
              the 'al lavoro' state chip is redundant — one chip, not two. */}
          {(live && task.dispatchState === 'working') ? null : (task.dispatchState && DISPATCH_CHIP[task.dispatchState]) ? (
            <DispatchChip state={task.dispatchState} error={task.dispatchError} />
          ) : (!task.dispatchState && task.dispatchError) ? (
            <span className="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-rose-300" title={task.dispatchError}>fermato</span>
          ) : null}
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
              className="shrink-0 whitespace-nowrap rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-secondary"
            >{fmtModel(task.model)}{(task.agentMs > 0 || task.agentTokens > 0) && ` · ⏱ ${fmtMs(task.agentMs)}${task.agentTokens > 0 ? ` · ${fmtTok(task.agentTokens)}` : ''}`}</span>
          ) : null}
          {hasOpenTab && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpenTopic!(task.assignedTopicId!); }}
              className="shrink-0 rounded bg-white/10 p-1 text-app-text hover:bg-white/20"
              title="Apri la tab dell'agent"
            ><ArrowUpRight className="h-3 w-3" /></button>
          )}
        </div>
      )}
      {/* Anteprima della consegna: screenshot (previewImage, allowlist media)
          reso come thumbnail sopra il titolo — la review parte guardando la
          cosa. Il click passa alla card (apre il drawer). object-top: di un
          full-page si vede la testata, non un centro anonimo. */}
      {task.previewImage && (
        <PreviewMedia
          path={task.previewImage}
          variant="card"
          // Il click nudo sulla card apre il drawer sul Thread; questo apre lo
          // stesso task con l'anteprima GIÀ in primo piano come tab.
          onOpenTab={() => onOpen(task.id, mediaPaneIdFor(task.previewImage!))}
        />
      )}
      {/* Title — full width; the priority rides INLINE before the text (only
          when hand-set and non-default), so urgency reads in the same glance
          as the title instead of down in a chip row. */}
      <span className="block break-words leading-snug">
        {showPriority && (
          <span
            title={`Priorità: ${PRIORITY_LABEL[task.priority] ?? task.priority}`}
            className={`mr-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 align-middle text-xs md:text-[10px] ${
              task.priority >= 3 ? 'bg-rose-500/15 text-rose-300' : 'bg-white/10 text-app-text-secondary'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${PRIORITY_DOT[task.priority] ?? PRIORITY_DOT[2]}`} />
            {PRIORITY_LABEL[task.priority] ?? task.priority}
          </span>
        )}
        {task.text}
      </span>
      {/* Subtasks, straight under the title. In Review the checklist EXPANDS —
          the human is judging a delivery and the steps are the evidence: max 5
          rows, the rest behind "Vedi tutti" (opens the drawer tree). The other
          columns keep the compact done/total chip. */}
      {checklist.length > 0 ? (
        <div className="mt-1 space-y-0.5" onClick={(e) => e.stopPropagation()}>
          {checklist.slice(0, 5).map((s) => (
            <button
              key={s.id}
              onClick={() => onOpen(s.id)}
              title={`${STATUS_LABEL[s.status]} — apri il sottotask`}
              className="flex w-full items-center gap-1.5 rounded px-0.5 text-left hover:bg-white/5"
            >
              <StatusIcon status={s.status} className="h-3 w-3" />
              <span className={`min-w-0 flex-1 truncate text-xs ${s.status === 'done' ? 'text-app-text-muted line-through' : 'text-app-text-heading'}`}>{s.text}</span>
            </button>
          ))}
          {checklist.length > 5 && (
            <button
              onClick={() => onOpen(task.id)}
              className="px-0.5 text-xs md:text-[11px] text-app-text-secondary hover:text-app-text"
            >+{checklist.length - 5}… Vedi tutti</button>
          )}
        </div>
      ) : task.subtaskCount > 0 ? (
        <div className="mt-1">
          <span
            title={`${task.subtaskDoneCount}/${task.subtaskCount} sottotask completati`}
            className="rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-heading"
          >↳ {task.subtaskDoneCount}/{task.subtaskCount}</span>
        </div>
      ) : null}
      {/* Description preview — plain text, clamped (the full markdown lives in
          the drawer). The update time closes the body — but on an agent review
          card the agent's LAST COMMENT is the true tail, so the date renders
          after that (inside the review block) instead of here. */}
      {task.description && (
        <p className="mt-1 line-clamp-2 break-words text-xs leading-snug text-app-text-secondary">{stripMarkdown(task.description)}</p>
      )}
      {!isAgentReview && (
        <div
          className="mt-1 text-xs md:text-[10px] text-app-text-muted"
          title={`Ultimo aggiornamento: ${new Date(task.updatedAt).toLocaleString('it-IT')}`}
        >{fmtUpdatedAt(task.updatedAt)}</div>
      )}
      {/* Relational chips (blocker / parent / thread / plan / assignee): the
          row renders only when at least one is present. */}
      {hasMetaRow && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {blocker && blocker.status !== 'done' && (
            <span
              title={`In attesa di: ${blocker.text}`}
              className="flex max-w-[11rem] items-center gap-1 truncate rounded bg-amber-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-amber-300"
            ><Lock className="h-3 w-3 shrink-0" /> <span className="truncate">in attesa di: {blocker.text}</span></span>
          )}
          {task.parentTaskId && (
            <button
              onClick={(e) => { e.stopPropagation(); onOpen(task.parentTaskId!); }}
              title={parentTitle ? `Sottotask di: ${parentTitle}` : 'Apri il task padre'}
              className="max-w-[9rem] truncate rounded bg-violet-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-violet-300 hover:bg-violet-500/25"
            >⤴ {parentTitle ?? 'padre'}</button>
          )}
          {task.userCommentCount > 0 && (
            <span
              title={`${task.userCommentCount} ${task.userCommentCount === 1 ? 'tuo messaggio' : 'tuoi messaggi'} nel thread (esclusa l'AI)`}
              className="flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-heading"
            ><MessageSquare className="h-3 w-3 shrink-0" /> {task.userCommentCount}</span>
          )}
          {systemDelivered && (
            <span
              title={systemDeliveryNote(task.deliveredReason)}
              className="flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs md:text-[11px] text-amber-300"
            ><Hourglass className="h-3 w-3 shrink-0" /> {task.deliveredReason ? SYSTEM_DELIVERY_CHIP[task.deliveredReason] : 'non consegnato'}</span>
          )}
          {notLanded && (
            <span
              title={`Il lavoro consegnato (${task.deliveryCommit?.slice(0, 8) ?? '?'}${task.deliveryBranch ? ` su ${task.deliveryBranch}` : ''}) NON risulta su main. Landa il branch prima che venga potato.`}
              className="flex items-center gap-1 rounded bg-rose-500/20 px-1.5 py-0.5 text-xs md:text-[11px] text-rose-300"
            ><AlertTriangle className="h-3 w-3 shrink-0" /> non su main</span>
          )}
          {checksRed && (
            <span
              title={`Checks pre-review ROSSI: ${(task.checks ?? []).filter((c) => !c.ok).map((c) => c.cmd).join(', ') || 'un comando è fallito'}`}
              className="flex items-center gap-1 rounded bg-rose-500/20 px-1.5 py-0.5 text-xs md:text-[11px] text-rose-300"
            ><AlertTriangle className="h-3 w-3 shrink-0" /> checks rossi</span>
          )}
          {task.planFirst && (
            <span
              title="L'agent consegna prima un piano da approvare"
              className="rounded bg-violet-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-violet-300"
            >piano</span>
          )}
          {task.assignedTo && <span className="rounded bg-white/10 px-1.5 py-0.5 text-xs md:text-[11px] text-app-text-heading">@{task.assignedTo}</span>}
        </div>
      )}
      {/* Steer a WORKING agent right from the card ("anche da kanban"): the
          message is buffered and handed to the agent at the next turn. */}
      {agentBusy && (
        <div className="mt-2 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <input
            value={freeText} disabled={busy}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && freeText.trim()) { e.preventDefault(); steer(freeText); } }}
            placeholder="Scrivi all'agent…"
            className="min-w-0 flex-1 rounded-md bg-black/30 px-2.5 py-1.5 text-xs text-app-text outline-none placeholder:text-app-placeholder"
          />
          <button
            disabled={busy || !freeText.trim()} onClick={() => steer(freeText)}
            title="Invia all'agent — lo riceve al prossimo turno (come Claude Code)"
            className="flex shrink-0 items-center gap-1 rounded-md bg-sky-500/80 px-2.5 py-1.5 text-xs text-white hover:bg-sky-500 disabled:opacity-50"
          ><Send className="h-3.5 w-3.5" /></button>
        </div>
      )}
      {task.status === 'review' && isAgentReview && (
        <div className="mt-2 space-y-1.5" onClick={(e) => e.stopPropagation()}>
          {/* The agent's last word, ALWAYS on the card — a formatted question
              with quick-reply buttons when it's a question block, plain text
              otherwise. Approving/rejecting blind was the bug. */}
          {pending ? (
            <p className="break-words text-xs leading-snug text-app-text">{stripMarkdown(pending.question)}</p>
          ) : lastComment ? (
            // Render the agent's last word as REAL markdown (bold/headings/lists
            // format instead of showing raw `**`/`#`). Shown in full — no clamp,
            // no fade. Tooltip = plain text.
            <div
              className={`text-xs leading-relaxed text-app-text-heading ${COMPACT_MD_CLS}`}
              title={`${lastComment.author}: ${stripMarkdown(lastComment.content)}`}
            >
              <ChatMarkdown components={{}}>{lastComment.content}</ChatMarkdown>
            </div>
          ) : null}
          {/* Update time trails the agent's last word (the card body's true tail). */}
          <div
            className="text-xs md:text-[10px] text-app-text-muted"
            title={`Ultimo aggiornamento: ${new Date(task.updatedAt).toLocaleString('it-IT')}`}
          >{fmtUpdatedAt(task.updatedAt)}</div>
          {pending && pending.options.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {pending.options.map((opt, i) => (
                <button
                  key={i} disabled={busy}
                  onClick={() => answer(opt)}
                  className="rounded-md bg-white/10 px-2.5 py-1.5 text-xs text-app-text hover:bg-white/20 disabled:opacity-50"
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
              className="min-w-0 flex-1 rounded-md bg-black/30 px-2.5 py-1.5 text-xs text-app-text outline-none placeholder:text-app-placeholder"
            />
            <button
              disabled={busy || !freeText.trim()} onClick={() => answer(freeText.trim())}
              title="Rispondi (l'agent riparte con la tua risposta)"
              className="flex items-center gap-1 rounded-md bg-sky-500/80 px-2.5 py-1.5 text-xs text-white hover:bg-sky-500 disabled:opacity-50"
            ><Send className="h-3.5 w-3.5" /></button>
            <button
              disabled={busy} onClick={() => review('approve', freeText.trim() || undefined)}
              title={freeText.trim() ? 'Accetta e completa il task — il testo scritto finisce nel thread' : 'Accetta e completa il task'}
              className="flex items-center gap-1 rounded-md bg-emerald-500/80 px-2.5 py-1.5 text-xs text-white hover:bg-emerald-500 disabled:opacity-50"
            ><ShieldCheck className="h-3.5 w-3.5" /></button>
            <button
              disabled={busy} onClick={() => review('reject', freeText.trim() || undefined)}
              title={freeText.trim() ? "Rifiuta — l'agent riparte col testo scritto come indicazione" : "Rifiuta (l'agent riparte senza indicazioni — scrivi nel campo per dargliene)"}
              className="flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1.5 text-xs text-app-text hover:bg-white/20 disabled:opacity-50"
            ><ShieldX className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      )}
      {task.status === 'review' && !isAgentReview && (
        <div className="mt-2 flex gap-1" onClick={(e) => e.stopPropagation()}>
          <button disabled={busy} onClick={() => review('approve')} className="flex items-center gap-1 rounded-md bg-emerald-500/80 px-2.5 py-1.5 text-xs text-white hover:bg-emerald-500 disabled:opacity-50">
            <ShieldCheck className="h-3.5 w-3.5" /> Approva
          </button>
          <button disabled={busy} onClick={() => review('reject')} className="flex items-center gap-1 rounded-md bg-white/10 px-2.5 py-1.5 text-xs text-app-text hover:bg-white/20 disabled:opacity-50">
            <ShieldX className="h-3.5 w-3.5" /> Rifiuta
          </button>
        </div>
      )}
      {ctxMenu && (
        <ContextMenuPortal open x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
          <button
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setCtxMenu(null); onOpen(task.id); }}
            className={POPOVER_ITEM}
          ><ClipboardList className="h-3.5 w-3.5 text-app-text-secondary" /> Apri</button>
          {task.assignedTopicId && onOpenTopic && (
            <button
              role="menuitem"
              onClick={(e) => { e.stopPropagation(); setCtxMenu(null); onOpenTopic(task.assignedTopicId!); }}
              className={POPOVER_ITEM}
            ><ArrowUpRight className="h-3.5 w-3.5 text-app-text-secondary" /> Apri tab agent</button>
          )}
          <div className={POPOVER_DIVIDER} />
          <button
            role="menuitem"
            onClick={(e) => { e.stopPropagation(); setCtxMenu(null); archive(); }}
            className={POPOVER_ITEM_DANGER}
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
      className="flex items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-xs md:text-[11px] text-sky-300 tabular-nums"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
      {fmtModel(usage.model)} · ⏱ {fmtLive(ms)}{usage.liveTokens > 0 && ` · ${fmtTok(usage.liveTokens)}`}
    </span>
  );
}
