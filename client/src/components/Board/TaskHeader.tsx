import { AlertTriangle, RotateCcw, ArrowUpRight, ChevronRight, X, Bot, Check, ChevronDown, Copy, Globe, Lock, Maximize2, MessageSquare, Minimize2, MoreHorizontal, Plus, ShieldCheck } from 'lucide-react';
import { Spinner } from '../Shared/Spinner';
import { type TaskSessionState, canOpenTaskSession, shouldExplainMissingSession } from '../../lib/taskSession';
import { type BoardTask, type TaskStatus, type BoardProjectRef, STATUS_GLYPH_PX, STATUS_LABEL, TASK_STATUSES } from '../../lib/board';
import { autoGrow } from './format';
import { type TaskBrowserGroupLayout } from './useTaskBrowserGroupLayout';
import { Menu } from '../Shared/Menu';
import { ShareControl } from '../Share/ShareControl';
import { buildTaskLink } from '../../lib/openTaskLink';
import { StatusIcon, DispatchChip, QueueReasonChip } from './atoms';
import { DANGER_TEXT, POPOVER_DIVIDER, POPOVER_ITEM } from '@/lib/popoverStyles';
import { STATUS_CHIP } from '@/lib/statusVisual';
import { MorphText } from '../Shared/MorphText';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { showsStoppedChip } from './stoppedChip';
import { DISPATCH_CHIP } from './constants';
import { ProjectPickerBody } from './ProjectPicker';
import type { RefObject, Dispatch, SetStateAction } from 'react';

export function IdentityCard({ blockedChip, blockerAnchorRef, blockerCandidates, blockerChipRef, blockerMenuOpen, boardTasks, cancelKey, currentProject, doCreateProject, doMove, doOpenProject, editingTitle, initialTitle, moveBlocked, onOpenTask, openBlockerMenu, openProjMenu, pickBlocker, projBusy, projChipRef, projMenuOpen, projectLabel, projects, reopened, saveTitle, setBlockerMenuOpen, setEditingTitle, setProjMenuOpen, setTitleDraft, task, titleDraft, tr }: {
  blockedChip: { label: string; title: string; } | null;
  blockerAnchorRef: RefObject<HTMLElement | null>;
  blockerCandidates: BoardTask[];
  blockerChipRef: RefObject<HTMLButtonElement | null>;
  blockerMenuOpen: boolean;
  boardTasks: BoardTask[] | null;
  cancelKey: (e: React.KeyboardEvent) => void;
  currentProject: BoardProjectRef | null;
  doCreateProject: (name: string) => Promise<void>;
  doMove: (p: BoardProjectRef) => Promise<void>;
  doOpenProject: () => void;
  editingTitle: boolean;
  initialTitle: string | undefined;
  moveBlocked: string | null;
  onOpenTask: ((taskId: string) => void) | undefined;
  openBlockerMenu: (anchor?: HTMLElement | null) => void;
  openProjMenu: () => void;
  pickBlocker: (id: string | null) => Promise<void>;
  projBusy: boolean;
  projChipRef: RefObject<HTMLButtonElement | null>;
  projMenuOpen: boolean;
  projectLabel: string;
  projects: BoardProjectRef[] | null;
  reopened: { label: string; title: string; detail: string; } | null;
  saveTitle: () => Promise<void>;
  setBlockerMenuOpen: Dispatch<SetStateAction<boolean>>;
  setEditingTitle: Dispatch<SetStateAction<boolean>>;
  setProjMenuOpen: Dispatch<SetStateAction<boolean>>;
  setTitleDraft: Dispatch<SetStateAction<string>>;
  task: BoardTask | null;
  titleDraft: string;
  tr: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
      <div className="border-b border-app-border px-3 py-3">
        {task?.parentTaskId && onOpenTask && (
          <button
            onClick={() => onOpenTask(task.parentTaskId!)}
            title={tr('board.task.openParentCardTitle')}
            className="mb-1.5 flex items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-mini text-violet-300 hover:bg-violet-500/25"
          >⤴ {tr('board.task.parentTask')}</button>
        )}
        {/* Project EYEBROW + PRIMARY STATE on one row — favicon + name on the
            left, the dispatch chip aligned right (card's top-right slot). The
            title below then gets the FULL width, no chip competing with it. */}
        {(task || initialTitle != null) && (
          <div className="mb-1 flex items-center gap-2">
            <button
              ref={projChipRef}
              onClick={openProjMenu}
              disabled={!task}
              data-testid="task-project-chip"
              title={tr('board.task.projectChipTitle', { label: projectLabel })}
              // 24 tall with the mouse (`tap-expand-y`, 3.5px over a 4px gap),
              // a REAL 44 box under a finger: projected, the 44 covered the top
              // 10px of the title below, and a tap there opened «Move to»
              // instead of editing the title (usability audit, steal check).
              className="tap-expand-y flex min-w-0 flex-1 items-center gap-1 text-mini text-app-text-secondary hover:text-app-text coarse:min-h-11"
            >
              <ProjectFavicon path={currentProject?.path ?? ''} size={14} className="shrink-0" fallback={<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />} />
              <span className="min-w-0 truncate font-medium">{projectLabel}</span>
              <ChevronDown className="h-3 w-3 shrink-0 text-app-text-faint" />
            </button>
            {reopened && (
              <details data-testid="task-reopened-notice" className="group relative shrink-0 text-mini text-app-text-muted">
                <summary className="cursor-pointer list-none rounded px-1.5 py-0.5 hover:bg-white/5 hover:text-app-text">
                  <span className="inline-flex items-center gap-1"><RotateCcw size={STATUS_GLYPH_PX} className="shrink-0" />{tr('board.task.reopened')}</span>
                </summary>
                <p className="absolute right-0 top-full z-20 mt-1 w-64 rounded border border-app-border bg-elevated p-2 text-app-text shadow-lg">{reopened.detail}</p>
              </details>
            )}
            {/* Same precedence as the card: the queue reason beats the state
                chip, and the two surfaces stay in step. */}
            {task?.queueReason ? (
              <QueueReasonChip reason={task.queueReason} />
            ) : (task?.dispatchState && DISPATCH_CHIP[task.dispatchState]) ? (
              <DispatchChip state={task.dispatchState} error={task.dispatchError} deliveredBy={task.deliveredBy} />
            ) : task && showsStoppedChip(task) ? (
              // Same rule as the card, one module: `stoppedChip.ts`.
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-mini ${STATUS_CHIP.danger}`} title={task.dispatchError ?? undefined}>{tr('board.task.stopped')}</span>
            ) : null}
          </div>
        )}
        <Menu
          open={projMenuOpen}
          anchorRef={projChipRef}
          onClose={() => setProjMenuOpen(false)}
          minWidth={230}
          unmanagedFocus
        >
          <ProjectPickerBody
            projects={projects}
            selectedId={task?.projectId}
            isDisabled={(p) => p.projectId === task?.projectId || !!moveBlocked}
            onPick={doMove}
            onCreate={doCreateProject}
            busy={projBusy}
            listLabel={tr('board.task.moveProjectTo')}
            headerNote={moveBlocked ? <p className="px-2.5 pb-1 text-mini leading-snug text-amber-800/90 dark:text-amber-300/90">{moveBlocked}</p> : undefined}
          />
          <div className={POPOVER_DIVIDER} />
          <button
            role="menuitem" disabled={!currentProject}
            onClick={doOpenProject}
            title={currentProject ? tr('board.task.openProjectWindow', { name: currentProject.name }) : tr('board.task.projectUnresolvable')}
            className={`${POPOVER_ITEM} disabled:opacity-40`}
          ><ArrowUpRight className="h-3.5 w-3.5" /> {tr('board.task.openProject')}</button>
        </Menu>
        {/* Title — FULL width (the dispatch state moved up to the project
            eyebrow row, so nothing competes with it here). */}
        {editingTitle ? (
          <textarea
            autoFocus value={titleDraft} rows={1} ref={autoGrow}
            onChange={(e) => { setTitleDraft(e.target.value); autoGrow(e.currentTarget); }}
            onBlur={saveTitle}
            onKeyDown={(e) => { cancelKey(e); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveTitle(); } }}
            className="-mx-1.5 block max-h-24 w-[calc(100%+0.75rem)] resize-none overflow-y-auto rounded bg-black/5 dark:bg-white/5 px-1.5 py-1 text-body-lg leading-5 text-app-text outline-none"
          />
        ) : (
          <p
            onClick={() => { if (task) { setTitleDraft(task.text); setEditingTitle(true); } }}
            title={tr('board.task.editTitleTitle')}
            className="-mx-1.5 line-clamp-2 cursor-text break-words rounded px-1.5 py-1 text-body-lg leading-5 text-app-text hover:bg-white/5"
          >{task ? <MorphText text={task.text} /> : initialTitle != null ? <MorphText text={initialTitle} /> : null}</p>
        )}
        {/* THE WAIT IS IDENTITY, NOT METADATA. It used to sit in the meta row,
            which now lives behind the collapsed "details" toggle: a blocked
            task opened in the drawer said nothing about waiting, and the
            blocker picker had no way in. A state you have to expand a section
            to discover is a state nobody reads, so the chip comes back next to
            the title, always mounted. Clicking it opens the same picker as the
            entry in the header menu, which anchors to whichever opened it. */}
        {task && (
          <>
            {blockedChip && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button
                  ref={blockerChipRef}
                  onClick={() => openBlockerMenu(blockerChipRef.current)}
                  data-testid="task-blocked-by-chip"
                  title={tr('task.blocked.hint', { what: blockedChip.title })}
                  className="flex min-w-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-mini text-amber-800 dark:text-amber-300 hover:bg-amber-500/25"
                >
                  <Lock className="h-3 w-3 shrink-0" />
                  <span className="max-w-[14rem] truncate">{blockedChip.label}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 text-amber-800/70 dark:text-amber-300/70" />
                </button>
              </div>
            )}
            <Menu open={blockerMenuOpen} anchorRef={blockerAnchorRef} onClose={() => setBlockerMenuOpen(false)} align="right" minWidth={220} role="listbox" unmanagedFocus testId="task-blocker-picker">
              <p className="px-2.5 pb-1 pt-1.5 text-mini font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.blockedBy')}</p>
              <button
                role="option" aria-selected={!task.blockedByTaskId}
                onClick={() => pickBlocker(null)}
                className={POPOVER_ITEM}
              >
                <span className="min-w-0 flex-1">{tr('common.none')}</span>
                {!task.blockedByTaskId && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
              </button>
              <div className="max-h-52 overflow-y-auto">
                {boardTasks === null ? (
                  <div className="flex items-center justify-center py-3"><Spinner size="md" tone="current" className="text-app-text-muted" /></div>
                ) : blockerCandidates.length === 0 ? (
                  <p className="px-2.5 py-2 text-compact leading-4 text-app-text-muted">{tr('board.task.noOtherTasks')}</p>
                ) : blockerCandidates.map((t) => (
                  <button
                    key={t.id} role="option" aria-selected={t.id === task.blockedByTaskId}
                    onClick={() => pickBlocker(t.id)}
                    className={POPOVER_ITEM}
                  >
                    <span className="min-w-0 flex-1 truncate">{t.text}</span>
                    {t.id === task.blockedByTaskId && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                  </button>
                ))}
              </div>
            </Menu>
          </>
        )}
      </div>
  );
}

export function TaskTabsBar({ browser, deliveryOpen, detailsOpen, detailsScrollRequestedRef, hasWorkspacePanes, setDeliveryOpen, setDetailsOpen, setWorkspaceOpen, stickRef, toggleWorkspaceOpen, tr, twoCol, workspaceOpen, workspacePaneCount }: {
  browser: TaskBrowserGroupLayout;
  deliveryOpen: boolean;
  detailsOpen: boolean;
  detailsScrollRequestedRef: RefObject<boolean>;
  hasWorkspacePanes: boolean;
  setDeliveryOpen: Dispatch<SetStateAction<boolean>>;
  setDetailsOpen: Dispatch<SetStateAction<boolean>>;
  setWorkspaceOpen: Dispatch<SetStateAction<boolean>>;
  stickRef: RefObject<boolean>;
  toggleWorkspaceOpen: () => void;
  tr: (key: string, vars?: Record<string, string | number>) => string;
  twoCol: boolean;
  workspaceOpen: boolean;
  workspacePaneCount: number;
}) {
  return (
<div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-app-border px-3 py-1.5">
        <button type="button" data-testid="task-conversation-toggle" aria-pressed={(!workspaceOpen || twoCol) && !detailsOpen && !deliveryOpen}
          onClick={() => { setWorkspaceOpen(false); setDetailsOpen(false); setDeliveryOpen(false); }}
          className={`rounded px-2 py-1 text-compact leading-4 coarse:min-h-11 ${!workspaceOpen && !detailsOpen && !deliveryOpen ? 'bg-app-hover text-app-text' : 'text-app-text-secondary hover:text-app-text'}`}>
          {tr('board.task.threadLabel')}
        </button>
        <button type="button" data-testid="task-details-toggle" aria-expanded={detailsOpen}
          onClick={() => {
            detailsScrollRequestedRef.current = !detailsOpen || workspaceOpen;
            setDetailsOpen((open) => workspaceOpen || !open);
            setDeliveryOpen(false);
            setWorkspaceOpen(false);
            stickRef.current = false;
          }}
          className="flex items-center gap-1 rounded px-2 py-1 text-compact leading-4 text-app-text-muted hover:bg-white/5 hover:text-app-text coarse:min-h-11">
          {detailsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {tr('board.task.detailsLabel')}
        </button>
        <button type="button" data-testid="task-delivery-toggle" aria-expanded={deliveryOpen}
          onClick={() => {
            detailsScrollRequestedRef.current = !deliveryOpen || workspaceOpen;
            setDeliveryOpen((open) => workspaceOpen || !open);
            setDetailsOpen(false);
            setWorkspaceOpen(false);
            stickRef.current = false;
          }}
          className="flex items-center gap-1 rounded px-2 py-1 text-compact leading-4 text-app-text-secondary hover:bg-app-hover hover:text-app-text coarse:min-h-11">
          {deliveryOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {tr('board.task.deliveryBand')}
        </button>
        <button type="button" data-testid="task-workspace-toggle" data-open={workspaceOpen ? '1' : '0'} aria-expanded={workspaceOpen}
          onClick={toggleWorkspaceOpen}
          className="ml-auto flex min-w-0 items-center gap-1 rounded px-2 py-1 text-compact leading-4 text-app-text-muted hover:bg-white/5 hover:text-app-text coarse:min-h-11">
          <span className="truncate">{tr('board.task.workspaceLabel')}</span>
          {hasWorkspacePanes && <span>{workspacePaneCount}</span>}
        </button>
        <button type="button" onClick={() => { setWorkspaceOpen(true); browser.addBrowserTab(); }}
          data-testid="task-workspace-add-tab" title={tr('board.task.openTab')} aria-label={tr('board.task.openTab')}
          // 24 with the mouse (`tap-expand`), a real 44 box under a finger: a
          // projected 44 around the 22px box covered the right 7px of the
          // workspace button beside it, and a tap there opened a new tab.
          className="tap-expand shrink-0 rounded p-1 text-app-text-secondary hover:bg-white/10 coarse:flex coarse:h-11 coarse:w-11 coarse:items-center coarse:justify-center"><Plus className="h-3.5 w-3.5" /></button>
      </div>
  );
}

export function TaskTopBar({ blockerChipRef, busy, changeStatus, chipStatus, copied, copyTask, loadFailedMessage, onClose, onOpenTopic, openBlockerMenu, openInWorkspace, optionsBtnRef, optionsMenuOpen, sessionState, setDeliveryOpen, setDetailsOpen, setOptionsMenuOpen, setStatusMenuOpen, setSubtaskComposerOpen, setSubtasksOpen, setWorkspaceOpen, statusBtnRef, statusMenuOpen, task, togglePlanFirst, toggleReuseContext, toggleWide, tr, wide, workspaceManifest }: {
  blockerChipRef: RefObject<HTMLButtonElement | null>;
  busy: boolean;
  changeStatus: (s: TaskStatus) => Promise<void>;
  chipStatus: TaskStatus | null;
  copied: string | null;
  copyTask: () => Promise<void>;
  loadFailedMessage: string | null;
  onClose: () => void;
  onOpenTopic: ((topicId: string) => void) | undefined;
  openBlockerMenu: (anchor?: HTMLElement | null) => void;
  openInWorkspace: () => void;
  optionsBtnRef: RefObject<HTMLButtonElement | null>;
  optionsMenuOpen: boolean;
  sessionState: TaskSessionState;
  setDeliveryOpen: Dispatch<SetStateAction<boolean>>;
  setDetailsOpen: Dispatch<SetStateAction<boolean>>;
  setOptionsMenuOpen: Dispatch<SetStateAction<boolean>>;
  setStatusMenuOpen: Dispatch<SetStateAction<boolean>>;
  setSubtaskComposerOpen: Dispatch<SetStateAction<boolean>>;
  setSubtasksOpen: (open: boolean) => void;
  setWorkspaceOpen: Dispatch<SetStateAction<boolean>>;
  statusBtnRef: RefObject<HTMLButtonElement | null>;
  statusMenuOpen: boolean;
  task: BoardTask | null;
  togglePlanFirst: () => Promise<void>;
  toggleReuseContext: () => Promise<void>;
  toggleWide: () => void;
  tr: (key: string, vars?: Record<string, string | number>) => string;
  wide: boolean;
  workspaceManifest: { url: string; contextId: string; }[];
}) {
  return (
<>
{/* Topbar = slim window-chrome row: the status selector on the left,
            window actions on the right. Everything else — project eyebrow,
            title + dispatch state, and the attribute chips — lives in the
            content block below, laid out exactly like the Kanban card. */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <button
          ref={statusBtnRef}
          onClick={() => task && setStatusMenuOpen(true)}
          data-testid="task-status-chip"
          title={tr('board.task.changeStatusTitle')}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-compact leading-4 text-app-text-heading hover:bg-white/10 coarse:min-h-11"
        >
          {/* A failed first read must not keep saying «Loading…»: the spinner is
              a promise, and here nothing is coming. */}
          {chipStatus ? <StatusIcon status={chipStatus} /> : loadFailedMessage ? <AlertTriangle className={`h-3.5 w-3.5 ${DANGER_TEXT}`} /> : <Spinner size="sm" tone="current" />}
          {chipStatus ? STATUS_LABEL[chipStatus] : loadFailedMessage ? tr('board.task.loadFailedChip') : tr('board.task.loading')}
          <ChevronDown className="h-3 w-3 text-app-text-faint" />
        </button>
        {/* Sharing sits next to the STATUS, not inside a menu: it is a
            property of the card just like the status, and hiding it in a
            submenu would have made invisible the one thing that makes the
            identity built below useful. */}
        {/* One place for "the link": the chain icon beside it is gone, and
            copying lives inside the sharing panel. */}
        {task && <ShareControl resourceType="task" resourceId={task.id} deepLink={() => buildTaskLink(task.id, task.text)} />}
        <Menu open={statusMenuOpen} anchorRef={statusBtnRef} onClose={() => setStatusMenuOpen(false)} minWidth={170} role="listbox">
          <p className="px-2.5 pb-1 pt-1.5 text-mini font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.moveTo')}</p>
          {TASK_STATUSES.map((s) => (
            <button
              key={s} role="option" aria-selected={s === task?.status}
              disabled={busy}
              onClick={() => changeStatus(s)}
              className={`${POPOVER_ITEM} disabled:opacity-40`}
            >
              <StatusIcon status={s} />
              <span className="min-w-0 flex-1">{STATUS_LABEL[s]}</span>
              {s === task?.status && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
            </button>
          ))}
        </Menu>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {task && (
            <button
              ref={optionsBtnRef}
              onClick={() => setOptionsMenuOpen((o) => !o)}
              data-testid="task-options-menu"
              title={tr('board.task.optionsTitle')}
              className="rounded p-1.5 text-app-text-secondary hover:bg-white/10 coarse:p-3.5"
            ><MoreHorizontal className="h-4 w-4" /></button>
          )}
          {task && (
            <Menu open={optionsMenuOpen} anchorRef={optionsBtnRef} onClose={() => setOptionsMenuOpen(false)} align="right" minWidth={240}>
              <p className="px-2.5 pb-1 pt-1.5 text-mini font-semibold uppercase tracking-wide text-app-text-muted">{tr('board.task.options')}</p>
              <button
                role="menuitem" disabled={busy} onClick={togglePlanFirst}
                title={tr('task.planFirst')}
                className={`${POPOVER_ITEM} disabled:opacity-40`}
              >
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" />
                <span className="min-w-0 flex-1">{tr('board.task.planFirst')}</span>
                {task.planFirst && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
              </button>
              <button
                role="menuitem" onClick={() => { setOptionsMenuOpen(false); openBlockerMenu(blockerChipRef.current); }}
                className={POPOVER_ITEM}
              >
                <Lock className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" />
                <span className="min-w-0 flex-1 truncate">{
                  task.blockedBy ? tr('board.task.blockedByText', { text: task.blockedBy.text })
                    : task.blockedByTaskId ? tr('board.task.blockedByUnknown')
                      : tr('board.task.blockedBy')
                }</span>
                <ChevronRight className="h-3 w-3 shrink-0 text-app-text-muted" />
              </button>
              {task.blockedByTaskId && (
                <button
                  role="menuitem" disabled={busy} onClick={toggleReuseContext}
                  title={tr('board.task.reuseBlockerTitle')}
                  className={`${POPOVER_ITEM} disabled:opacity-40`}
                >
                  <Bot className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" />
                  <span className="min-w-0 flex-1">{tr('board.task.reuseBlockerContext')}</span>
                  {task.reuseBlockerContext && <Check className="h-3 w-3 shrink-0 text-emerald-400" />}
                </button>
              )}
              <div className={POPOVER_DIVIDER} />
              <button
                role="menuitem" onClick={() => {
                  setOptionsMenuOpen(false);
                  setSubtasksOpen(true);
                  setSubtaskComposerOpen(true);
                  setDetailsOpen(true);
                  setDeliveryOpen(false);
                  setWorkspaceOpen(false);
                }}
                className={POPOVER_ITEM}
              ><Plus className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" /> {tr('board.task.addSubtask')}</button>
              <div className={POPOVER_DIVIDER} />
              {/* COPY THE TASK and OPEN IN PROJECT live HERE, not inline.
                  They were two icons among the seven in the header, and seven
                  icons without words are a riddle: neither of these two is used
                  while deciding on a card, so neither deserves a permanent
                  spot next to "close". In the menu they also get what an icon
                  lacked: their own written name. */}
              <button
                role="menuitem" onClick={() => { setOptionsMenuOpen(false); void copyTask(); }}
                data-testid="task-copy-text"
                title={tr('board.task.copyTextTitle')}
                className={POPOVER_ITEM}
              >
                {copied === 'task'
                  ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  : <Copy className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" />}
                <span className="min-w-0 flex-1">{copied === 'task' ? tr('board.task.copyTextDone') : tr('board.task.copyText')}</span>
              </button>
              {/* The TABS win over `outputUrl`: on a DISPATCHED task the
                  result is the tabs the agent opened with open_browser_pane
                  (possibly more than one, each with its own name), and
                  `outputUrl` (when present) is only the seed of the first. With
                  no live tabs the seed remains, so the manual flow loses
                  nothing. It is called "open the TASK" and not "open the
                  result": results are many and change while the agent works,
                  so the gesture promotes the task with whatever it has at
                  that moment. */}
              {workspaceManifest.length > 0 && (
                <button
                  role="menuitem" onClick={() => { setOptionsMenuOpen(false); openInWorkspace(); }}
                  data-testid="task-open-in-workspace"
                  title={tr('board.task.openInProjectTitle', { n: workspaceManifest.length })}
                  className={POPOVER_ITEM}
                >
                  <Globe className="h-3.5 w-3.5 shrink-0 text-app-text-secondary" />
                  <span className="min-w-0 flex-1">{tr('board.task.openInProject')}</span>
                  <span className="shrink-0 text-mini text-app-text-faint">{workspaceManifest.length}</span>
                </button>
              )}
            </Menu>
          )}
          {/* From the CARD to the SESSION. The drawer is not the agent's chat: it
              is the surface where decisions are made, and this is the only
              gesture that leads from one to the other. When the session is
              gone the button does not disappear: it stays, disabled, with the
              reason, because vanishing would suggest the task was never
              worked on. */}
          {onOpenTopic && canOpenTaskSession(sessionState) && task?.assignedTopicId && (
            <button
              onClick={() => onOpenTopic(task.assignedTopicId!)}
              data-testid="task-open-session-tab"
              title={tr('board.task.openSessionTitle')}
              aria-label={tr('board.task.openSession')}
              className="rounded p-1.5 text-app-text-secondary hover:bg-white/10 coarse:p-3.5"
            ><MessageSquare className="h-4 w-4" /></button>
          )}
          {shouldExplainMissingSession(sessionState) && (
            <span
              data-testid="task-session-gone"
              title={tr('board.task.sessionGoneTitle')}
              aria-label={tr('board.task.sessionGone')}
              className="rounded p-1.5 text-app-text-faint"
            ><MessageSquare className="h-4 w-4" /></span>
          )}
          {/* Expand/collapse only makes sense on the desktop side panel: on mobile
              the drawer is already full-screen, so the toggle is hidden (<lg). */}
          <button
            onClick={toggleWide}
            data-testid="task-detail-wide-toggle"
            aria-pressed={wide}
            title={wide ? tr('task.drawer.narrow') : tr('task.drawer.widen')}
            className="hidden rounded p-1.5 text-app-text-secondary hover:bg-white/10 lg:block"
          >{wide ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</button>
          <button aria-label={tr('board.task.closeDetail')} onClick={onClose} className="rounded p-1.5 text-app-text-secondary hover:bg-white/10 coarse:p-3.5"><X className="h-4 w-4" /></button>
        </div>
</>
  );
}
