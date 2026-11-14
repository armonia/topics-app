import { useT } from '../../hooks/useT';
import { STATUS_CHIP } from '@/lib/statusVisual';
import { Spinner } from '../Shared/Spinner';
import { getMediaUrl } from '../../lib/api';
import { type BoardTask, showsLandingDebt, showsDeployProposal, hasCodeQuestion, systemDeliveryNote } from '../../lib/board';
import { type TaskBrowserGroupLayout } from './useTaskBrowserGroupLayout';
import { X, Globe, Paperclip, Camera, PackageCheck, GitMerge, Rocket, TriangleAlert, Download, WifiOff } from 'lucide-react';
import { SectionHeader } from './sectionAccordion';
import type { RefObject, Dispatch, SetStateAction } from 'react';
import { mediaPaneIdFor } from './constants';
import { LandingNotice } from './LandingNotice';
import { reviewDecisionButtons } from './taskActionWords';
import { TASK_ACTION_ICON } from './taskActionIcons';
import type { TaskActionWord } from './taskActionWords';
import type { LandingBand } from './landingBand';
import { ChecksSection } from './TaskChecks';
import { TaskChoiceRow } from './TaskChoiceRow';
import { TaskChangesSection, TaskAttemptsSection } from './TaskFiles';

/** Hostname of a URL for a compact tab label, or empty if it does not parse. */
function hostLabel(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Badge for the result of the probe on the output_url.
 *
 * Three states, three behaviors:
 *   live    - silent (the link works, no need to warn)
 *   dead    - red warning; the link does NOT appear (see useEffect below)
 *   unknown - silent (never probed, we do not know whether it works)
 *
 * Rendered only in review and only when there is an output_url.
 */
export function OutputUrlProbeNotice({ task }: { task: BoardTask }) {
  const tr = useT();
  if (!task.outputUrl || task.urlProbeStatus !== 'dead') return null;
  return (
    <div className={`flex items-start gap-1.5 rounded px-2 py-1.5 text-mini ${STATUS_CHIP.danger}`}>
      <WifiOff className="mt-px h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{tr('board.task.previewUnreachable')}</span>{' '}
        {tr('board.task.previewUnreachableDetail', { url: task.outputUrl })}
      </span>
    </div>
  );
}

/**
 * "The agent did not deliver this."
 *
 * The case to tell apart: the dispatcher moves a task to review whose turn
 * ended without the agent delivering it (attempts exhausted, or the model
 * refusing). The card and the drawer looked identical to a real delivery, and
 * the reviewer only found out by opening the diff that there was nothing to
 * see. It sits ABOVE the buttons because it changes the decision, not at the
 * bottom of the page like a note.
 */
export function SystemDeliveryNotice({ task }: { task: BoardTask }) {
  const tr = useT();
  if (task.deliveredBy !== 'system') return null;
  return (
    <div className={`flex items-start gap-1.5 rounded px-2 py-1.5 text-mini ${STATUS_CHIP.wait}`}>
      <PackageCheck className="mt-px h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{tr('board.task.movedToReviewBySystem')}</span>{' '}
        {systemDeliveryNote(task.deliveredReason, tr)}
      </span>
    </div>
  );
}

/**
 * The drawer's DECISION ZONE: Approve, Send back, Land.
 *
 * Green is a recommendation, and on a card nobody delivered it was the wrong
 * one: «Approva» (Approve) closed a task without noticing there was nothing
 * underneath (measured on 13/08 on c0849d9d). There green moves to
 * «Rimandalo avanti» (Send it forward), the only exit that moves the work
 * along, and the other two stay where they are, neutral and named for the
 * exceptions they are.
 *
 * Which button is green and what they are called is NOT decided here: it comes
 * from `reviewDecisionButtons`, the same function that feeds the quick-reply
 * de-duplicator. Written twice, the two lists diverge, and the twin that
 * REJECTS comes back next to the real button (comment 2eff6a44).
 */
export function ReviewDecisionRow({ task, busy, onAccept, onSendBack, onLand }: {
  task: BoardTask;
  busy: boolean;
  onAccept: () => void;
  onSendBack?: () => void;
  onLand: () => void;
}) {
  const tr = useT();
  const d = reviewDecisionButtons(task, tr);
  // Only one green, and the red of the checks tints it amber only when the
  // green IS «Approva» (Approve): on «Rimandalo avanti» (Send it forward) amber
  // would promise an exception that button does not make.
  const primaryCls = task.checksState === 'fail' && d.primary === 'accept'
    ? 'bg-amber-700 hover:bg-amber-800 text-white'
    : 'bg-emerald-700 hover:bg-emerald-800 text-white';
  const neutralCls = 'bg-black/10 dark:bg-white/10 text-app-text hover:bg-white/20';
  // THE GLYPHS COME FROM THE SINGLE TABLE, not from here. They used to be
  // `ShieldCheck` and `ShieldX`, the CHECKS shields: on the same screen the
  // green shield is already the «checks green» chip, so the button that closes
  // the card carried the sign of a different claim. Now the tick means "close"
  // and the arrow means "go back", identical to the choice row on the card.
  const AcceptIcon = TASK_ACTION_ICON['accept'];
  const SendBackIcon = TASK_ACTION_ICON['send-back'];
  const buttons = [
    {
      id: 'accept' as const, word: d.accept, testId: 'task-approve',
      icon: <AcceptIcon className="h-3.5 w-3.5" />, onClick: onAccept,
    },
    {
      id: 'send-back' as const, word: d.sendBack, testId: 'task-send-back',
      icon: <SendBackIcon className="h-3.5 w-3.5" />, onClick: onSendBack,
    },
  ];
  // Green goes first: it is where the thumb lands on its own, and that very
  // spot is what led to approving on the undelivered card.
  const ordered = d.primary === 'send-back' ? [buttons[1], buttons[0]] : buttons;
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {ordered.filter((b) => b.id !== 'send-back' || onSendBack).map((b) => {
          const isPrimary = b.id === d.primary;
          return (
            <button
              key={b.id}
              data-testid={b.testId}
              disabled={busy} onClick={b.onClick}
              title={b.word.title}
              className={`flex items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-compact leading-4 disabled:opacity-50 ${
                isPrimary ? `font-medium ${primaryCls}` : neutralCls
              }`}
            >{busy && isPrimary ? <Spinner size="sm" tone="current" /> : b.icon} {b.word.label}</button>
          );
        })}
      </div>
      {/* Explicit landing — accept + merge the branch on main (local, no push,
          build server-side). Separate from Approva by design: the merge no
          longer rides silently underneath an approve. Sky blue
          while it is a delivery: on a card nobody delivered it drops to
          neutral like Approva. */}
      {d.land && (
        <button
          disabled={busy} onClick={onLand}
          data-testid="task-land"
          title={d.land.title}
          className={`flex items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-compact leading-4 disabled:opacity-50 ${
            d.primary === 'accept' ? 'bg-sky-700 font-medium text-white hover:bg-sky-800' : neutralCls
          }`}
        ><GitMerge className="h-3.5 w-3.5" /> {d.land.label}</button>
      )}
    </>
  );
}

export function DeliveryPanel({ browser, bump, busy, commentRef, decide, deliveryOpen, doLand, downloadsOpen, focusDiff, isAgentReview, load, mediaPaths, onChanged, onOpenTopic, openTaskPane, projectId, recapturePreview, recapturing, sendBack, sending, setError, setWorkspaceOpen, task, taskId, toggleDownloadsOpen, tr }: {
  browser: TaskBrowserGroupLayout;
  bump: string | undefined;
  busy: boolean;
  commentRef: RefObject<HTMLTextAreaElement | null>;
  decide: (decision: 'approve' | 'reject', opts?: { force?: boolean; }) => Promise<void>;
  deliveryOpen: boolean;
  doLand: () => Promise<void>;
  downloadsOpen: boolean;
  focusDiff: string | null;
  isAgentReview: boolean;
  load: () => Promise<void>;
  mediaPaths: string[];
  onChanged: () => void;
  onOpenTopic: ((topicId: string) => void) | undefined;
  openTaskPane: (paneId: string) => boolean;
  projectId: string;
  recapturePreview: () => Promise<void>;
  recapturing: boolean;
  sendBack: () => Promise<void>;
  sending: boolean;
  setError: Dispatch<SetStateAction<string | null>>;
  setWorkspaceOpen: Dispatch<SetStateAction<boolean>>;
  task: BoardTask | null;
  taskId: string;
  toggleDownloadsOpen: () => void;
  tr: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
deliveryOpen && task ? (
    <div data-testid="task-delivery-panel" className="-mx-3 -mt-3 mb-3 border-b border-app-border">
      <div className="space-y-2 px-3 py-3">
            {/* Lifecycle choices belong to delivery. Stop is owned by the composer. */}
            {task.status !== 'review' && (
              <TaskChoiceRow
                task={task} disabled={busy} exclude={['stop']} className="mb-2"
                onDone={() => { void load(); onChanged(); }}
                onError={setError} onNeedText={() => commentRef.current?.focus()}
              />
            )}
            {/* Review decisions stay next to the checks and delivery evidence. */}
            {task.status === 'review' && (
              <div className="mb-2 space-y-1.5">
                {/* The evidence sits ATTACHED to the decision: the gate rejects an
                    approve with red checks, and finding that out from a 409
                    after the click would mean having an error explain what could
                    have been seen up front. */}
                <OutputUrlProbeNotice task={task} />
                <SystemDeliveryNotice task={task} />
                <ChecksSection task={task} />
                {/* The wording and WHICH of the three is green come from the
                    card, not from here. On a review nobody delivered, green is
                    «Rimandalo avanti» (Send it forward) and the other two drop
                    to neutral. */}
                {/* `busy || sending`: since «Rimanda indietro» (Send back)
                    carries the text along, its long path raises `sending` and
                    not `busy`. Without the second flag, the three buttons stayed
                    pressable while the delivery had already started. */}
                <div data-testid="task-review-actions" className="flex flex-wrap items-center gap-1.5">
                <ReviewDecisionRow
                  task={task} busy={busy || sending}
                  onAccept={() => decide('approve', { force: task.checksState === 'fail' })}
                  onSendBack={() => void sendBack()}
                  onLand={doLand}
                />
                {/* The exits the three buttons above do NOT have: taking the task
                    over (the "I need it" choice) or archiving it.
                    Approva/Rimanda indietro/Landa (Approve/Send back/Land) are
                    already spelled out above, so they are excluded: a duplicate
                    is not an extra choice. */}
                <TaskChoiceRow
                  task={task} disabled={busy || sending} exclude={['land', 'send-back', 'accept', 'redo', 'stop']}
                  onDone={() => { void load(); onChanged(); }}
                  onError={setError} onNeedText={() => commentRef.current?.focus()}
                />
                </div>
                {/* «Ricattura evidenza» (Recapture evidence) is NO longer here: it
                    was a utility action on the preview, drawn as wide as a
                    decision and placed among the decisions, so at a glance it
                    weighed as much as they did. Now it sits attached to the
                    preview it redoes, at the top of the brief, even when there
                    is no preview, which is when it is really needed. */}
              </div>
            )}

      </div>
      <div className="px-3 pb-2">        {/* "File consegnati" (Delivered files): each artifact (screenshot/video/PDF)
            is polymorphic: clicking the name opens it as a TAB in the task
            workspace, the icon DOWNLOADS it. Replaces the idea of a separate
            "output": the result is tabs plus a downloadable list. */}
        {mediaPaths.length > 0 && (
          <div className="mt-3" data-testid="task-downloads">
            <SectionHeader
              open={downloadsOpen}
              onToggle={toggleDownloadsOpen}
              label={tr('board.task.deliveredFiles')}
              suffix={` · ${mediaPaths.length}`}
              testId="task-section-downloads"
            />
            {downloadsOpen && (
            <ul className="reveal-in mt-1.5 flex flex-col gap-1">
              {mediaPaths.map((p) => {
                const name = p.split('/').pop() || p;
                return (
                  <li key={p} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1.5 text-compact leading-4 text-app-text-heading">
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-app-text-muted" />
                    <button
                      type="button"
                      data-testid={p === task?.previewImage ? 'task-preview-open' : undefined}
                      onClick={() => openTaskPane(mediaPaneIdFor(p))}
                      title={tr('board.task.openAsTabTitle')}
                      className="min-w-0 flex-1 truncate text-left hover:text-white"
                    >{name}</button>
                    <a
                      href={getMediaUrl(p)}
                      download={name}
                      title={tr('board.task.downloadFileTitle')}
                      className="shrink-0 rounded p-1 text-app-text-secondary hover:bg-white/10 hover:text-white"
                    ><Download className="h-3.5 w-3.5" /></a>
                  </li>
                );
              })}
            </ul>
            )}
          </div>
        )}</div>
          {/* THE TWIN OPENER THAT COULD NEVER RENDER IS GONE.
              It was gated on `!mediaPaths.includes(task.previewImage)`, and
              `collectTaskMediaPaths` puts the preview FIRST in that list since
              2026-08-03 (050d9b766): the condition has been false ever since,
              for every task that has a preview. The live opener is the row in
              "File consegnati" just above, which carries the same testid and
              the same action — and `board-drawer-truth` spent that time looking
              for the dead one. What is left here is the band that speaks when
              there is NO preview (retired, or missing on an agent review), so
              its condition is now exactly that. */}
          {task && (task.previewRetiredAt || isAgentReview) && (
            <div className="border-b border-app-border px-3 py-2" data-testid="task-detail-preview">
              <div className="flex flex-wrap items-center gap-2">
                {isAgentReview && <button disabled={recapturing} onClick={recapturePreview}
                  title={tr('board.task.recapturePreviewTitle')} data-testid="task-recapture-preview"
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-compact leading-4 text-app-text-secondary hover:bg-white/10 disabled:opacity-40">
                  {recapturing ? <Spinner size="sm" tone="current" /> : <Camera className="h-3 w-3" />}{tr('board.task.recapturePreview')}
                </button>}
              </div>
              {!task.previewImage && task.previewRetiredAt && <p data-testid="task-preview-retired" className="mt-1.5 text-compact leading-4 text-app-text-muted">
                {tr('board.task.previewRetired')}{task.previewRetiredReason ? `: ${task.previewRetiredReason}` : ''}
              </p>}
              {!task.previewImage && !task.previewRetiredAt && <p data-testid="task-preview-missing" className="mt-1.5 text-compact leading-4 text-app-text-muted">
                {tr('board.task.previewMissing', { recapture: tr('board.task.recapturePreview') })}
              </p>}
            </div>
          )}
          {/* Closed-tab tray — ONLY the soft-closed browser tabs live here under
              the description so a closed tab stays reopenable and previewable
              (when closed). Live tabs (and the "+" to add one) belong to the
              GroupLayout's own PaneTabBar below — the single tab system. */}
          {browser.parkedTabs.length > 0 && (
            <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-app-border px-3 py-2 scrollbar-topbar" data-testid="task-browser-previews">
              {browser.parkedTabs.map((t) => {
                const label = t.title || hostLabel(t.url) || tr('board.task.newTab');
                return (
                  <div
                    key={t.contextId}
                    className="group/prev flex shrink-0 items-center rounded-md border border-app-border bg-white/[0.02] text-compact leading-4 text-app-text-muted"
                  >
                    <button
                      onClick={() => { setWorkspaceOpen(true); browser.reopenTab(t.contextId); }}
                      title={tr('board.task.reopenTabTitle')}
                      className="flex items-center gap-1.5 px-2 py-1"
                    >
                      <Globe className="h-3 w-3 shrink-0" />
                      <span className="max-w-[10rem] truncate">{label}</span>
                      <span className="text-mini uppercase tracking-wide text-app-text-faint">{tr('board.task.closedTab')}</span>
                    </button>
                    {/* The ONLY call site of `removeTab`, and it was hover-only:
                        with a finger the tray of closed tabs could only get
                        longer. `coarse:opacity-100` gives it back, and on a
                        coarse pointer the box grows to 24x24 (6+12+6).
                        `tap-expand-y`, not `tap-expand`: a 44px square centred
                        here would overhang the reopen button on its left and,
                        being later in the DOM, would win the overlap -- tapping
                        the end of the label would DELETE the tab instead of
                        reopening it. Vertical only costs the neighbour nothing
                        (see index.css). */}
                    <button
                      onClick={(e) => { e.stopPropagation(); browser.removeTab(t.contextId); }}
                      title={tr('board.task.removeTabTitle')}
                      aria-label={tr('board.task.removeTabTitle')}
                      data-testid="parked-tab-remove"
                      className="tap-expand-y mr-1 rounded p-0.5 text-app-text-muted opacity-0 hover:bg-white/10 hover:text-app-text group-hover/prev:opacity-100 focus-visible:opacity-100 coarse:p-1.5 coarse:opacity-100"
                    ><X className="h-3 w-3" /></button>
                  </div>
                );
              })}
            </div>
          )}
          {/* The "Changes" panel (worktree diff) lives HERE — above the body, OUT of the
              chat composer area (above the chat it was annoying). It renders
              NOTHING when there's no worktree / an empty diff (owns its own
              section chrome), so an unchanged task shows no "Changes" bar. */}
          {/* "Attempts" sits ABOVE "Changes" because until
              the winner is chosen the task's diff is that of attempt 1, which
              may not be the one that gets kept. First choose, then review. */}
          <TaskAttemptsSection projectId={projectId} taskId={taskId} bump={bump} onChanged={onChanged} onOpenTopic={onOpenTopic} />
          {hasCodeQuestion(task) && <TaskChangesSection projectId={projectId} taskId={taskId} bump={bump} onSent={onChanged} focusPath={focusDiff} />}
    </div>
  ) : null
  );
}

export function DeliveryBanners({ busy, deploying, doDeploy, doLand, landWord, landingBanda, notice, setNotice, task, tr }: {
  busy: boolean;
  deploying: boolean;
  doDeploy: () => Promise<void>;
  doLand: () => Promise<void>;
  landWord: TaskActionWord;
  landingBanda: LandingBand | null;
  notice: string | null;
  setNotice: Dispatch<SetStateAction<string | null>>;
  task: BoardTask | null;
  tr: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
<>
{/* The error is NOT here: it lives at the bottom, in the decision zone, stuck
          to the buttons that produce it. This band is left to `notice`, which is
          a warning about the task and not the verdict of a click. */}
      {notice && (
        <div
          data-testid="task-detail-notice"
          className="flex shrink-0 items-start justify-between gap-2 border-b border-sky-500/20 bg-sky-500/10 px-3 py-1.5 text-mini text-sky-300"
        >
          <span>{notice}</span>
          <button aria-label={tr('board.task.closeError')} onClick={() => setNotice(null)} className="tap-expand shrink-0 rounded p-0.5 hover:bg-white/10 coarse:p-1.5"><X className="h-3 w-3" /></button>
        </div>
      )}
      {/* Land QUEUED, not yet happened. It sits above the "not on
          main" band because in this window that band tells the truth but not
          the whole truth: the code is not on main AND someone is already
          working on it.
          The wording (and the case that was missing here: a REJECTED `settled`,
          which without reading `outcome` looked identical to a success) lives
          in `LandingNotice`, together with the card's one. */}
      {landingBanda && <LandingNotice band={landingBanda} testId="task-detail-landing" />}
      {/* Verdict of the landing audit: a closed task whose work is not on
          main. It lives HERE, at the top of the drawer, and not only as a
          comment in the thread: a comment gets lost, the band does not.
          And it carries ITS OWN action. It used to say «landa il branch» (land
          the branch) and there was nothing to press: the «Landa su main» (Land
          on main) button lived only in the review zone, a state the task had
          already left behind. A band that names an unreachable remedy assigns
          a chore instead of offering a way out, and that is why eight cards
          stayed like this for weeks. */}
      {task && showsLandingDebt(task) && (
        <div data-testid="task-not-landed-banner" className={`flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-red-500/20 px-3 py-1.5 text-mini ${STATUS_CHIP.danger}`}>
          <span className="min-w-0">
            <TriangleAlert className="w-4 h-4 inline-block align-[-2px]" aria-hidden="true" /> {tr('task.landing.closedBut')} <strong>{tr('board.task.notOnMain')}</strong>{tr('task.landing.commitIs')}
            {task.deliveryCommit ? <> <code className="rounded bg-black/30 px-1">{task.deliveryCommit.slice(0, 8)}</code></> : null}
            {task.deliveryBranch ? <> ({tr('task.landing.branch')} <code className="rounded bg-black/30 px-1">{task.deliveryBranch}</code>)</> : null}
            {' '}{tr('task.landing.notInMain')}
          </span>
          <button
            data-testid="task-not-landed-land"
            disabled={busy} onClick={doLand}
            title={landWord.title}
            // No text color of its own: it inherits the band's `STATUS_CHIP.danger`,
            // the pairing already proven on this tint in both themes. A lighter
            // ink vanished on the light theme: the affordance comes from the
            // border and the background.
            className="flex shrink-0 items-center gap-1 rounded border border-red-400/40 bg-red-500/20 px-2 py-0.5 font-medium hover:bg-red-500/30 disabled:opacity-50"
          ><GitMerge className="h-3 w-3" /> {landWord.label}</button>
        </div>
      )}
      {/* Deploy PROPOSED at approve (board setting `deployCommand`): a comment
          already told the story in the thread, this banner is the durable
          reminder + the button — same treatment as the "not on main" band
          above, for the same reason (a comment scrolls away, this does not). */}
      {task && showsDeployProposal(task) && (
        <div data-testid="task-deploy-proposed-banner" className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-sky-500/20 bg-sky-500/10 px-3 py-1.5 text-mini text-sky-300">
          <span className="min-w-0"><Rocket className="w-4 h-4 shrink-0" aria-hidden="true" /> {tr('board.task.deployProposed')}</span>
          <button
            data-testid="task-deploy-now"
            disabled={deploying} onClick={doDeploy}
            className="flex shrink-0 items-center gap-1 rounded border border-sky-400/40 bg-sky-500/20 px-2 py-0.5 font-medium hover:bg-sky-500/30 disabled:opacity-50"
          >{deploying ? <Spinner size="sm" tone="current" /> : <GitMerge className="h-3 w-3" />} {tr('board.task.deployNow')}</button>
        </div>
      )}
      {task?.deployState === 'running' && (
        <div data-testid="task-deploy-running-banner" className="flex shrink-0 items-center gap-1.5 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-mini text-amber-800 dark:text-amber-300">
          <Spinner size="sm" tone="current" /> {tr('board.task.deployRunning')}
        </div>
      )}
</>
  );
}
