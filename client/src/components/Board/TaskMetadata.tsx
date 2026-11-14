import { useState } from 'react';
import { useT } from '../../hooks/useT';
import { AlertTriangle, ListTree, Timer, ChevronRight, Check, ChevronDown, Clock, Server, Sparkles, Tag, UserRound } from 'lucide-react';
import { Spinner } from '../Shared/Spinner';
import { boardApi, subtaskWorkChip, type TaskLabel, type BoardTask, STATUS_GLYPH_PX, STATUS_LABEL, subtaskQueueChip, subtaskOpenable, priorityAwaitingAgent, CLOSER_LABELS, KIND_LABELS } from '../../lib/board';
import { autoGrow, fmtMs, fmtTok, fmtUpdatedAt, descSummary, fmtCount } from './format';
import { Menu } from '../Shared/Menu';
import { StatusIcon, QueueReasonChip } from './atoms';
import { POPOVER_ITEM } from '@/lib/popoverStyles';
import { STATUS_CHIP } from '@/lib/statusVisual';
import { CardConsumption } from '../Processes/SessionConsumption';
import { SectionHeader } from './sectionAccordion';
import { ChatMarkdown } from '../ChatMarkdown';
import { TaskModelSelector } from '../Shared/ModelSelector/TaskModelSelector';
import { machineLabel } from '../../state/machinesStore';
import { COMPACT_MD_CLS, PRIORITY_DOT, PRIORITY_LABEL, PRIORITY_ORDER } from './constants';
import type { RefObject, Dispatch, SetStateAction } from 'react';
import type { Machine } from '../../types';
import type { Locale } from '../../lib/i18n';
import type { SubtaskWork } from '../../lib/board';

/**
 * One node of the subtask tree. Direct children arrive with the parent task;
 * deeper levels are fetched lazily on first expand (each task's `get` already
 * returns its children — no dedicated tree endpoint needed).
 */
export function SubtaskNode({ projectId, node, depth, onOpenTask }: {
  projectId: string; node: BoardTask; depth: number; onOpenTask?: (taskId: string) => void;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState<BoardTask[] | null>(null);
  const hasKids = node.subtaskCount > 0;
  // A bare row has no click affordance; a row with something to say opens.
  // The full rule lives on `subtaskOpenable`.
  const openable = subtaskOpenable(node);
  // This row is where triage actually looks: the columns only show roots
  // (`rootsOnly`), so a step is NEVER a card, and the parent's tree is the
  // only place where it can be seen without searching for it by id.
  //
  // Asymmetric on purpose. `unattended` is rare and must be noticed: red
  // marker. `parent-turn` is the norm (243 steps closed this way in a day): a
  // chip on each one would be noise across the whole checklist, and redundant
  // too, since the parent working it is the drawer you are looking at. It stays
  // as a muted icon that responds to mouse hover.
  const work = subtaskWorkChip(node, tr);
  // The queue reason, but only when it is STALLED: `subtaskQueueChip` is where
  // the reason for the filter is written down.
  const stalled = subtaskQueueChip(node);
  const toggle = async () => {
    if (!open && kids === null) {
      // Only the children: this row draws the checklist and its chips, never a
      // comment. The whole body would carry the node's entire thread with it.
      try { setKids(await boardApi.getChildren(projectId, node.id)); }
      catch { setKids([]); }
    }
    setOpen((o) => !o);
  };
  return (
    <div>
      <div className="flex items-center gap-1 rounded px-1 py-1 hover:bg-white/5" style={{ paddingLeft: depth * 10 }}>
        {hasKids ? (
          <button onClick={toggle} className="shrink-0 text-app-text-muted hover:text-app-text-heading" title={open ? tr('common.collapse') : tr('common.expand')}>
            <ChevronRight className={`h-2.5 w-2.5 transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
        ) : null}
        <span title={STATUS_LABEL[node.status]} className="flex shrink-0">
          <StatusIcon status={node.status} />
        </span>
        {openable ? (
          <button
            onClick={() => onOpenTask?.(node.id)}
            data-testid={`subtask-open-${node.id}`}
            title={tr('board.task.openSubtaskCardTitle')}
            className={`min-w-0 flex-1 truncate text-left text-compact leading-4 ${node.status === 'done' ? 'text-app-text-muted line-through' : 'text-app-text'}`}
          >{node.text}</button>
        ) : (
          <span className={`min-w-0 flex-1 truncate text-compact leading-4 ${node.status === 'done' ? 'text-app-text-muted line-through' : 'text-app-text-secondary'}`}>{node.text}</span>
        )}
        {stalled ? (
          <span data-testid={`subtask-queue-reason-${node.id}`} className="flex min-w-0 shrink">
            <QueueReasonChip reason={stalled} />
          </span>
        ) : null}
        {work && (work.kind === 'unattended' ? (
          <span
            data-testid={`subtask-work-${node.id}`}
            data-kind="unattended"
            title={work.title}
            className={`flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-mini ${STATUS_CHIP.danger}`}
          ><AlertTriangle className="h-2.5 w-2.5 shrink-0" /> {work.label}</span>
        ) : (
          <span
            data-testid={`subtask-work-${node.id}`}
            data-kind="parent-turn"
            title={work.title}
            className="flex shrink-0 text-app-text-muted"
          ><UserRound className="h-2.5 w-2.5" /></span>
        ))}
        {hasKids && <span className="shrink-0 text-mini inline-flex items-center gap-0.5 text-app-text-muted"><ListTree size={STATUS_GLYPH_PX} className="shrink-0" />{node.subtaskDoneCount}/{node.subtaskCount}</span>}
      </div>
      {open && kids?.map((k) => (
        <SubtaskNode key={k.id} projectId={projectId} node={k} depth={depth + 1} onOpenTask={onOpenTask} />
      ))}
    </div>
  );
}

export function MetadataCard({ boardDispatchModel, busy, changeModel, changeNode, changePriority, changeTopicsRouting, drawerRouting, labelBtnRef, labelMenuOpen, machines, modelBtnRef, modelMenuOpen, modelTrigger, nodeBtnRef, nodeMenuOpen, nodePickerLocked, nodes, onOpenTask, prioBtnRef, prioMenuOpen, setLabelMenuOpen, setModelMenuOpen, setNodeMenuOpen, setPrioMenuOpen, shownEffort, task, toggleLabel, toggleStayLocal, tr, workAncestorId, workChip }: {
  boardDispatchModel: string | null;
  busy: boolean;
  changeModel: (model: string | null) => Promise<void>;
  changeNode: (machineId: string | null) => Promise<void>;
  changePriority: (p: number) => Promise<void>;
  changeTopicsRouting: (next: boolean) => Promise<void>;
  drawerRouting: boolean;
  labelBtnRef: RefObject<HTMLButtonElement | null>;
  labelMenuOpen: boolean;
  machines: Machine[] | null;
  modelBtnRef: RefObject<HTMLButtonElement | null>;
  modelMenuOpen: boolean;
  modelTrigger: { line: string; automatic: { who: string; hint: string; }; };
  nodeBtnRef: RefObject<HTMLButtonElement | null>;
  nodeMenuOpen: boolean;
  nodePickerLocked: boolean;
  nodes: Machine[];
  onOpenTask: ((taskId: string) => void) | undefined;
  prioBtnRef: RefObject<HTMLButtonElement | null>;
  prioMenuOpen: boolean;
  setLabelMenuOpen: Dispatch<SetStateAction<boolean>>;
  setModelMenuOpen: Dispatch<SetStateAction<boolean>>;
  setNodeMenuOpen: Dispatch<SetStateAction<boolean>>;
  setPrioMenuOpen: Dispatch<SetStateAction<boolean>>;
  shownEffort: string | null;
  task: BoardTask | null;
  toggleLabel: (l: TaskLabel) => Promise<void>;
  toggleStayLocal: () => Promise<void>;
  tr: (key: string, vars?: Record<string, string | number>) => string;
  workAncestorId: string | null;
  workChip: { kind: SubtaskWork['kind']; label: string; title: string; } | null;
}) {
  return (
    <div className="border-b border-app-border px-3 py-2">
        {/* Meta row — compact chips that wrap, card-style: priority,
            model · timer effort (ONE chip, like the card), plan-first,
            blocked-by + reuse. Editable selectors keep their portaled Menus. */}
        {task && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span
              className="flex items-center gap-1 text-mini text-app-text-muted"
              title={tr('task.lastUpdate', { when: new Date(task.updatedAt).toLocaleString('it-IT') })}
            ><Clock className="h-3 w-3 shrink-0" /> {fmtUpdatedAt(task.updatedAt)}</span>
            <button
              ref={prioBtnRef}
              onClick={() => task && setPrioMenuOpen(true)}
              data-testid="task-priority-chip"
              title={priorityAwaitingAgent(task)
                ? tr('task.priority.auto')
                : tr('task.priority.change')}
              className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-mini ${
                !priorityAwaitingAgent(task) && task.priority >= 3 ? 'bg-rose-500/15 text-rose-800 dark:text-rose-300 hover:bg-rose-500/25' : 'bg-black/5 dark:bg-white/5 text-app-text-secondary hover:bg-white/10'
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[task.priority] ?? PRIORITY_DOT[2]}`} />
              {priorityAwaitingAgent(task) ? tr('board.task.priorityAuto') : PRIORITY_LABEL[task.priority] ?? 'Media'}
              <ChevronDown className="h-3 w-3 shrink-0 text-app-text-faint" />
            </button>
            <Menu open={prioMenuOpen} anchorRef={prioBtnRef} onClose={() => setPrioMenuOpen(false)} minWidth={160} role="listbox">
              <p className="px-2.5 pb-1 pt-1.5 text-mini font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.priority')}</p>
              {PRIORITY_ORDER.map((p) => (
                <button
                  key={p} role="option" aria-selected={p === task?.priority}
                  disabled={busy}
                  onClick={() => changePriority(p)}
                  className={`${POPOVER_ITEM} disabled:opacity-40`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[p]}`} />
                  <span className="min-w-0 flex-1">{PRIORITY_LABEL[p]}</span>
                  {p === task?.priority && !(task && priorityAwaitingAgent(task)) && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                </button>
              ))}
            </Menu>
            {/* Labels: a human's manual correction. Here `invisibile` can be
                written (the agent cannot: the server rejects it), and once
                written by hand the derivation no longer overwrites it at the
                next delivery. */}
            <button
              ref={labelBtnRef}
              onClick={() => setLabelMenuOpen(true)}
              data-testid="task-labels-chip"
              title={task.labels.some((l) => l.label === 'invisibile')
                ? tr('task.close.invisible')
                : task.labels.some((l) => l.label === 'visibile')
                  ? tr('task.close.visible')
                  : task.labels.some((l) => l.label === 'decisione') // allow-italian: the label vocabulary IS the data, compared by value
                    ? tr('task.close.decision')
                    : tr('task.close.none')}
              className="flex min-w-0 items-center gap-1.5 rounded bg-black/10 dark:bg-white/10 px-1.5 py-0.5 text-mini text-app-text-secondary hover:bg-white/20"
            >
              <Tag className="h-3 w-3 shrink-0 text-app-text-muted" />
              <span className="truncate">{task.labels.length ? task.labels.map((l) => l.label).join(', ') : tr('board.task.labelsChip')}</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />
            </button>
            <Menu open={labelMenuOpen} anchorRef={labelBtnRef} onClose={() => setLabelMenuOpen(false)} minWidth={220} role="listbox">
              <p className="px-2.5 pb-1 pt-1.5 text-mini font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.filter.whoCloses')}</p>
              {CLOSER_LABELS.map((l) => (
                <button
                  key={l} role="option" aria-selected={task.labels.some((x) => x.label === l)}
                  disabled={busy} onClick={() => toggleLabel(l)}
                  className={`${POPOVER_ITEM} disabled:opacity-40`}
                >
                  <span className="min-w-0 flex-1">{l}</span>
                  {task.labels.some((x) => x.label === l) && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                </button>
              ))}
              <p className="px-2.5 pb-1 pt-1.5 text-mini font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.filter.kind')}</p>
              {KIND_LABELS.map((l) => (
                <button
                  key={l} role="option" aria-selected={task.labels.some((x) => x.label === l)}
                  disabled={busy} onClick={() => toggleLabel(l)}
                  className={`${POPOVER_ITEM} disabled:opacity-40`}
                >
                  <span className="min-w-0 flex-1">{l}</span>
                  {task.labels.some((x) => x.label === l) && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                </button>
              ))}
            </Menu>
            <button
              ref={modelBtnRef}
              onClick={() => { if (!task.assignedTopicId) setModelMenuOpen(true); }}
              aria-disabled={!!task.assignedTopicId}
              data-testid="task-model-chip"
              title={task.assignedTopicId ? tr('task.model.sessionFixed', { model: modelTrigger.line }) : (task.agentMs > 0 || task.agentTokens > 0)
                ? tr('task.model.stats', {
                    model: modelTrigger.line,
                    effort: task.effort ? tr('task.model.effortPart', { effort: task.effort }) : '',
                    time: fmtMs(task.agentMs),
                    tokens: task.agentTokens ? tr('task.model.tokensPart', { n: task.agentTokens.toLocaleString('it-IT') }) : '',
                    cache: task.agentCacheReadTokens > 0 ? tr('task.model.cachePart', { n: fmtTok(task.agentCacheReadTokens) }) : '',
                  })
                : `${modelTrigger.line}. ${tr('task.model.hint')}`}
              className="flex min-w-0 items-center gap-1.5 rounded bg-black/10 dark:bg-white/10 px-1.5 py-0.5 text-mini text-app-text-secondary hover:bg-white/20"
            >
              <Sparkles className="h-3 w-3 shrink-0 text-app-text-muted" />
              <span className="flex min-w-0 items-center gap-1"><span className="truncate">{modelTrigger.line}</span>{(task.agentMs > 0 || task.agentTokens > 0) && <span className="inline-flex shrink-0 items-center gap-1"> · <Timer size={STATUS_GLYPH_PX} className="shrink-0" />{fmtMs(task.agentMs)}{task.agentTokens > 0 ? ` · ${fmtTok(task.agentTokens)} tok` : ''}</span>}</span>
              {/* Unknown tier shows nothing here: "auto" lives only next to the input fields (card 067a1f5b). */}
              {shownEffort && <span data-testid="task-effort-badge" className="shrink-0 rounded bg-app-hover/60 px-1 text-mini font-semibold uppercase tracking-wide text-app-text-muted">{shownEffort}</span>}
              {!task.assignedTopicId && <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />}
            </button>
            <TaskModelSelector
              open={modelMenuOpen && !task.assignedTopicId}
              anchorRef={modelBtnRef}
              onClose={() => setModelMenuOpen(false)}
              testId="task-model-popover"
              ariaLabel={tr('board.task.agentModel')}
              variant="compact"
              value={task.model || null}
              boardValue={boardDispatchModel}
              onSelect={changeModel}
              disabled={busy}
              automatic={modelTrigger.automatic}
              topicsRouting={{
                enabled: drawerRouting,
                onToggle: changeTopicsRouting,
              }}
            />
            {/* WHERE it runs, next to WHAT it runs with: same register as the
                model chip, same `Menu` primitive. A node is not a preference of
                the agent, it is the machine that executes the turn. */}
            <button
              ref={nodeBtnRef}
              onClick={() => setNodeMenuOpen(true)}
              data-testid="task-node-chip"
              disabled={nodePickerLocked}
              title={nodePickerLocked ? tr('board.task.node.runningTitle') : tr('board.task.node.title')}
              className="flex min-w-0 items-center gap-1.5 rounded bg-black/10 dark:bg-white/10 px-1.5 py-0.5 text-mini text-app-text-secondary hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white/10"
            >
              <Server className="h-3 w-3 shrink-0 text-app-text-muted" />
              <span className="truncate">{task.machineId ? machineLabel(machines, task.machineId) : tr('board.task.node.chipLocal')}</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-app-text-muted" />
            </button>
            <Menu open={nodeMenuOpen} anchorRef={nodeBtnRef} onClose={() => setNodeMenuOpen(false)} minWidth={220} role="listbox">
              <p className="px-2.5 pb-1 pt-1.5 text-mini font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.node.heading')}</p>
              <button
                role="option" aria-selected={!task.machineId} disabled={busy}
                onClick={() => changeNode(null)}
                className={`${POPOVER_ITEM} disabled:opacity-40`}
              >
                <Server className="h-3.5 w-3.5 shrink-0 text-app-text-muted" />
                <span className="min-w-0 flex-1">{tr('board.task.node.local')}</span>
                {!task.machineId && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
              </button>
              {nodes.map((m) => (
                <button
                  key={m.id} role="option" aria-selected={m.id === task.machineId} disabled={busy}
                  onClick={() => changeNode(m.id)}
                  className={`${POPOVER_ITEM} disabled:opacity-40`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${m.status === 'online' ? 'bg-emerald-400' : 'bg-app-text-faint'}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  <span className="shrink-0 text-mini text-app-text-muted">
                    {m.status === 'online' ? tr('board.task.node.online') : tr('board.task.node.offline')}
                  </span>
                  {m.id === task.machineId && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                </button>
              ))}
              {nodes.length === 0 && (
                <p className="px-2.5 pb-1.5 pt-1 text-mini leading-snug text-app-text-muted">{tr('board.task.node.empty')}</p>
              )}
              <button
                role="menuitemcheckbox" aria-checked={!!task.stayLocal} disabled={busy}
                data-testid="task-stay-local"
                onClick={toggleStayLocal}
                title={tr('board.task.node.stayLocalTitle')}
                className={`${POPOVER_ITEM} border-t border-white/10 disabled:opacity-40`}
              >
                <span className="min-w-0 flex-1">{tr('board.task.node.stayLocal')}</span>
                {task.stayLocal && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
              </button>
            </Menu>
            {/* Who is working it stays in the row for the same reason the wait
                does: on a card in progress with no topic and no chip, this is
                the state that decides whether somebody has to step in. When an
                ancestor holds the turn the chip takes you there, because the
                next question is always "and who would that be?". */}
            {workChip && (workAncestorId && onOpenTask ? (
              <button
                onClick={() => onOpenTask(workAncestorId)}
                data-testid="task-subtask-work-chip"
                data-kind="parent-turn"
                title={tr('task.work.hint', { what: workChip.title })}
                className="flex min-w-0 items-center gap-1 rounded bg-black/10 dark:bg-white/10 px-1.5 py-0.5 text-mini text-app-text-muted hover:bg-white/20"
              >
                <UserRound className="h-3 w-3 shrink-0" />
                <span className="max-w-[14rem] truncate">{workChip.label}</span>
              </button>
            ) : (
              <span
                data-testid="task-subtask-work-chip"
                data-kind={workChip.kind}
                title={workChip.title}
                className={workChip.kind === 'unattended'
                  ? `flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-mini ${STATUS_CHIP.danger}`
                  : 'flex min-w-0 items-center gap-1 rounded bg-black/10 dark:bg-white/10 px-1.5 py-0.5 text-mini text-app-text-muted'}
              >
                {workChip.kind === 'unattended'
                  ? <AlertTriangle className="h-3 w-3 shrink-0" />
                  : <UserRound className="h-3 w-3 shrink-0" />}
                <span className="max-w-[14rem] truncate">{workChip.label}</span>
              </span>
            ))}
          </div>
        )}
    </div>
  );
}

export function DescriptionCard({ cancelKey, descDraft, descOpen, editingDesc, locale, saveDesc, setDescDraft, setEditingDesc, task, toggleDescOpen, tr }: {
  cancelKey: (e: React.KeyboardEvent) => void;
  descDraft: string;
  descOpen: boolean;
  editingDesc: boolean;
  locale: Locale;
  saveDesc: () => Promise<void>;
  setDescDraft: Dispatch<SetStateAction<string>>;
  setEditingDesc: Dispatch<SetStateAction<boolean>>;
  task: BoardTask | null;
  toggleDescOpen: () => void;
  tr: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <>
      {/* Description: accordion consistent with Subtasks/Changes: same
          container (px-3 py-2), same label (chevron + uppercase), body at
          mt-1.5. Equal space above and below the label (the container's py-2). */}
      <div className="shrink-0 border-b border-app-border px-3 py-2">
        {editingDesc ? (
          <textarea
            autoFocus value={descDraft} rows={1} ref={autoGrow}
            onChange={(e) => { setDescDraft(e.target.value); autoGrow(e.currentTarget); }}
            onBlur={saveDesc}
            onKeyDown={cancelKey}
            placeholder={tr('board.task.descPlaceholder')}
            className="block w-full resize-none overflow-hidden rounded bg-black/5 dark:bg-white/5 px-1.5 py-0.5 text-body-lg leading-5 text-app-text-heading outline-none"
          />
        ) : task?.description ? (
          <>
            {/* CLOSED ≠ EMPTY. The choice to collapse is remembered in
                localStorage and applies to EVERY card: once collapsed, a
                2,578-character description reads as "there is no useful
                description" (the finding on `d4fcce17`). The chevron is not
                evidence of content, so when collapsed the handle carries
                the MEASURE (how much text there is) and the first real line. */}
            <SectionHeader open={descOpen} onToggle={toggleDescOpen} label={tr('board.task.descLabel')} testId="task-section-desc" />
            {/* The measure sits OUTSIDE the button on purpose: the handle's
                accessible name stays exactly «Descrizione» (the Italian label
                for "Description"), which is how specs and voice navigation
                look it up. Here the number is what matters, because it is the
                number that says there is a plan below and not two lines. */}
            {!descOpen && (
              <p
                onClick={toggleDescOpen}
                title={tr('board.task.descExpandTitle')}
                className="mt-1 cursor-pointer truncate text-compact leading-5 text-app-text-secondary hover:text-app-text-heading"
                data-testid="task-desc-summary"
              >
                <span className="text-app-text-faint">{tr('board.task.descChars', { n: fmtCount(task.description.length, locale) })}</span>
                {descSummary(task.description) && <> · {descSummary(task.description)}</>}
              </p>
            )}
            {/* `reveal-in` on each section body: the drawer's folds open with
                the shared fade instead of landing in one frame. Opacity only:
                the brief scrolls as one column, and a height animation would
                drag every section below it for 150ms. */}
            {descOpen && (
              <div
                data-testid="task-desc-body"
                onClick={() => { setDescDraft(task.description ?? ''); setEditingDesc(true); }}
                title={tr('board.task.editDescTitle')}
                className={`reveal-in mt-1.5 cursor-text rounded px-1.5 py-0.5 text-body-lg leading-5 text-app-text-heading hover:bg-white/5 ${COMPACT_MD_CLS}`}
              ><ChatMarkdown components={{}}>{task.description}</ChatMarkdown></div>
            )}
          </>
        ) : (
          <button
            onClick={() => { setDescDraft(''); setEditingDesc(true); }}
            className="flex w-full items-center gap-1 text-mini font-semibold uppercase tracking-wide text-app-text-faint hover:text-app-text-secondary"
          >{tr('board.task.addDesc')}</button>
        )}
        {/* (The preview used to live HERE, a sibling of the description but
            outside its `descOpen` branch: collapsing the description did not
            hide it. It now has its own section at the top of the brief; "the
            delivery" is a slot, not a detail of the description.) */}

      </div>
    </>
  );
}

export function SubtasksCard({ addSubtask, addingSub, children, doneCount, onOpenTask, projectId, setSubDraft, subDraft, subtaskComposerOpen, subtasksOpen, toggleSubtasksOpen, tr }: {
  addSubtask: () => Promise<void>;
  addingSub: boolean;
  children: BoardTask[];
  doneCount: number;
  onOpenTask: ((taskId: string) => void) | undefined;
  projectId: string;
  setSubDraft: Dispatch<SetStateAction<string>>;
  subDraft: string;
  subtaskComposerOpen: boolean;
  subtasksOpen: boolean;
  toggleSubtasksOpen: () => void;
  tr: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <>
      {/* Subtask tree — collapsible; unlimited depth, lazy-expanded. The
          agent's steps live here too: dots flip green as it checks them off.
          Hidden entirely when there are no subtasks ("do not show if there
          are none"), added on demand from the ⋯ menu (subtaskComposerOpen).
          Pure accordion: the `max-h-[40%] overflow-y-auto` that used to be here
          was a stand-in for the missing scroll: a list of subtasks inside
          its own little window, inside a drawer that did not scroll. Now the
          brief scrolls. */}
      {(children.length > 0 || subtaskComposerOpen) && (
      <div className="border-b border-app-border px-3 py-2" data-testid="task-detail-subtasks">
        <SectionHeader
          open={subtasksOpen}
          onToggle={toggleSubtasksOpen}
          label={tr('board.task.subtasksLabel')}
          suffix={children.length > 0 ? ` · ${doneCount}/${children.length}` : undefined}
          testId="task-section-subtasks"
        />
        {subtasksOpen && (
          <div className="reveal-in mt-1.5">
            {children.map((c) => (
              <SubtaskNode key={c.id} projectId={projectId} node={c} depth={0} onOpenTask={onOpenTask} />
            ))}
            <div className="relative mt-1">
              <input
                value={subDraft} disabled={addingSub}
                autoFocus={subtaskComposerOpen && children.length === 0}
                onChange={(e) => setSubDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSubtask(); } }}
                placeholder={tr('board.task.addSubtaskPlaceholder')}
                className="w-full rounded bg-black/5 dark:bg-white/5 px-2 py-1 text-compact leading-4 text-app-text outline-none placeholder:text-app-placeholder disabled:opacity-60"
              />
              {addingSub && <Spinner size="sm" tone="current" className="absolute right-1.5 top-1.5 text-app-text-secondary" />}
            </div>
          </div>
        )}
      </div>
      )}
    </>
  );
}

export function TaskDetailsPanel({ addSubtask, addingSub, boardDispatchModel, busy, cancelKey, changeModel, changeNode, changePriority, changeTopicsRouting, children, descDraft, descOpen, detailsOpen, doneCount, drawerRouting, editingDesc, labelBtnRef, labelMenuOpen, locale, machines, modelBtnRef, modelMenuOpen, modelTrigger, nodeBtnRef, nodeMenuOpen, nodePickerLocked, nodes, onOpenTask, prioBtnRef, prioMenuOpen, projectId, saveDesc, setDescDraft, setEditingDesc, setLabelMenuOpen, setModelMenuOpen, setNodeMenuOpen, setPrioMenuOpen, setSubDraft, shownEffort, subDraft, subtaskComposerOpen, subtasksOpen, task, toggleDescOpen, toggleLabel, toggleStayLocal, toggleSubtasksOpen, tr, workAncestorId, workChip }: {
  addSubtask: () => Promise<void>;
  addingSub: boolean;
  boardDispatchModel: string | null;
  busy: boolean;
  cancelKey: (e: React.KeyboardEvent) => void;
  changeModel: (model: string | null) => Promise<void>;
  changeNode: (machineId: string | null) => Promise<void>;
  changePriority: (p: number) => Promise<void>;
  changeTopicsRouting: (next: boolean) => Promise<void>;
  children: BoardTask[];
  descDraft: string;
  descOpen: boolean;
  detailsOpen: boolean;
  doneCount: number;
  drawerRouting: boolean;
  editingDesc: boolean;
  labelBtnRef: RefObject<HTMLButtonElement | null>;
  labelMenuOpen: boolean;
  locale: Locale;
  machines: Machine[] | null;
  modelBtnRef: RefObject<HTMLButtonElement | null>;
  modelMenuOpen: boolean;
  modelTrigger: { line: string; automatic: { who: string; hint: string; }; };
  nodeBtnRef: RefObject<HTMLButtonElement | null>;
  nodeMenuOpen: boolean;
  nodePickerLocked: boolean;
  nodes: Machine[];
  onOpenTask: ((taskId: string) => void) | undefined;
  prioBtnRef: RefObject<HTMLButtonElement | null>;
  prioMenuOpen: boolean;
  projectId: string;
  saveDesc: () => Promise<void>;
  setDescDraft: Dispatch<SetStateAction<string>>;
  setEditingDesc: Dispatch<SetStateAction<boolean>>;
  setLabelMenuOpen: Dispatch<SetStateAction<boolean>>;
  setModelMenuOpen: Dispatch<SetStateAction<boolean>>;
  setNodeMenuOpen: Dispatch<SetStateAction<boolean>>;
  setPrioMenuOpen: Dispatch<SetStateAction<boolean>>;
  setSubDraft: Dispatch<SetStateAction<string>>;
  shownEffort: string | null;
  subDraft: string;
  subtaskComposerOpen: boolean;
  subtasksOpen: boolean;
  task: BoardTask | null;
  toggleDescOpen: () => void;
  toggleLabel: (l: TaskLabel) => Promise<void>;
  toggleStayLocal: () => Promise<void>;
  toggleSubtasksOpen: () => void;
  tr: (key: string, vars?: Record<string, string | number>) => string;
  workAncestorId: string | null;
  workChip: { kind: SubtaskWork['kind']; label: string; title: string; } | null;
}) {
  return (
detailsOpen && task ? (
    <div data-testid="task-brief-scroll" className="-mx-3 -mt-3 mb-3 border-b border-app-border">
      {/* What the running session costs (tokens, tokens per second, CPU, memory), read from the
          same answer as the load screen and the Processes view. Nothing while it is not running. */}
      {task.status === 'in_progress' && <div className="px-3 pt-3"><CardConsumption cardId={task.id} /></div>}
      <MetadataCard boardDispatchModel={boardDispatchModel} busy={busy} changeModel={changeModel} changeNode={changeNode}
        changePriority={changePriority} changeTopicsRouting={changeTopicsRouting} drawerRouting={drawerRouting} labelBtnRef={labelBtnRef}
        labelMenuOpen={labelMenuOpen} machines={machines} modelBtnRef={modelBtnRef} modelMenuOpen={modelMenuOpen} modelTrigger={modelTrigger}
        nodeBtnRef={nodeBtnRef} nodeMenuOpen={nodeMenuOpen} nodePickerLocked={nodePickerLocked} nodes={nodes} onOpenTask={onOpenTask}
        prioBtnRef={prioBtnRef} prioMenuOpen={prioMenuOpen} setLabelMenuOpen={setLabelMenuOpen} setModelMenuOpen={setModelMenuOpen}
        setNodeMenuOpen={setNodeMenuOpen} setPrioMenuOpen={setPrioMenuOpen} shownEffort={shownEffort} task={task} toggleLabel={toggleLabel}
        toggleStayLocal={toggleStayLocal} tr={tr} workAncestorId={workAncestorId} workChip={workChip} />
      <DescriptionCard cancelKey={cancelKey} descDraft={descDraft} descOpen={descOpen} editingDesc={editingDesc} locale={locale} saveDesc={saveDesc}
        setDescDraft={setDescDraft} setEditingDesc={setEditingDesc} task={task} toggleDescOpen={toggleDescOpen} tr={tr} />
      <SubtasksCard addSubtask={addSubtask} addingSub={addingSub} children={children} doneCount={doneCount} onOpenTask={onOpenTask}
        projectId={projectId} setSubDraft={setSubDraft} subDraft={subDraft} subtaskComposerOpen={subtaskComposerOpen} subtasksOpen={subtasksOpen}
        toggleSubtasksOpen={toggleSubtasksOpen} tr={tr} />
    </div>
  ) : null
  );
}
