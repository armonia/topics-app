import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { DANGER_TEXT } from '@/lib/popoverStyles';
import { useT } from '../../hooks/useT';
import { Spinner } from '../Shared/Spinner';
import { boardApi, boardDrafts, diffTotals, attemptHasWork, type DiffBundle, type DiffNote, type DiffPanelSource, type TaskAttempt } from '../../lib/board';
import { ChevronDown, GitCompare, Send } from 'lucide-react';
import { canOpenTaskSession, shouldExplainMissingSession } from '../../lib/taskSession';
import { Menu } from '../Shared/Menu';
import { useTaskSessionResolver } from '../../hooks/useTaskSession';
import { UnifiedDiff } from './UnifiedDiff';
import { formatReviewNotes } from './reviewNotes';
import { attemptStat } from './format';

/**
 * The drawer's changes panel: what THIS card changed.
 *
 * It always renders, for any card where the question makes sense
 * (`hasCodeQuestion`), and that is the contract change from before: while the
 * panel disappeared when there were no files, "the card produced no code" and
 * "I could not look" were the same emptiness, yet on a delivery in review they
 * are two opposite verdicts. Now the reason comes from the server in `code`
 * and is spelled out in plain words.
 *
 * The diff it renders is that of the card's OWN commits, and after the land it
 * comes from the merge on main: it survives worktree pruning, which is exactly
 * when a reviewer still wants to be able to read it.
 */
export function TaskChangesSection({ projectId, taskId, bump, onSent, focusPath }: {
  projectId: string; taskId: string; bump?: string | number;
  /** The notes went out as a comment: the thread has one more line. */
  onSent?: () => void;
  /** Opened from a row of the card chip: the dropdown opens by itself on
   *  THAT file, expanded and scrolled into view. */
  focusPath?: string | null;
}) {
  const tr = useT();
  const [open, setOpen] = useState(!!focusPath);
  // Another chip row on the SAME card reopens the dropdown on the new file.
  // Adjusted during render and not in an effect: it is a prop change, and a
  // setState inside an effect would cause a cascading render.
  const [seenFocus, setSeenFocus] = useState(focusPath);
  if (focusPath !== seenFocus) {
    setSeenFocus(focusPath);
    if (focusPath) setOpen(true);
  }
  const [state, setState] = useState<DiffBundle | 'error' | null>(null);
  const [notes, setNotes] = useState<DiffNote[]>([]);
  const [sendingNotes, setSendingNotes] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const notesLoaded = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // THE LAST REQUEST WINS, not the last response.
  //
  // `bump` fires on every task update and arrives in bursts while an agent
  // works; the diff of a big worktree is not instant. Two `taskDiff` calls in
  // flight together are normal, and without this counter the
  // changes panel showed whichever came back SECOND, so it could stay on a
  // diff older than the one the server had just computed, until another bump
  // happened to rescue it.
  //
  // A counter and not the usual `alive`: `alive` covers unmounting, not one
  // live request overtaking another.
  const diffReq = useRef(0);
  const fetchDiff = useCallback(() => {
    // The previous bundle is NOT cleared while reloading: `bump` fires on every
    // task update, and emptying it here made the panel vanish and reappear
    // under the hands of whoever was reading.
    const mine = ++diffReq.current;
    boardApi.taskDiff(projectId, taskId)
      .then((b) => { if (mine === diffReq.current) setState(b); })
      .catch(() => { if (mine === diffReq.current) setState('error'); });
  }, [projectId, taskId]);
  // Eager (not lazy): visibility depends on whether the worktree has changes, so
  // we must probe up-front. Re-runs when the task advances (bump), since the agent
  // may have committed more.
  useEffect(() => { fetchDiff(); }, [fetchDiff, bump]);
  const diffSource = useMemo<DiffPanelSource>(() => ({ kind: 'task', projectId, taskId }), [projectId, taskId]);
  // Review draft from the server: a note that is written but not yet sent is
  // work, and it survives reload and hot-reload like the comment draft.
  useEffect(() => {
    notesLoaded.current = false;
    let alive = true;
    boardDrafts.getReviewNotes(taskId).then((n) => {
      if (!alive) return;
      setNotes((cur) => (cur.length ? cur : n));
      notesLoaded.current = true;
      // With pending notes the section opens by itself: otherwise the only trace
      // of that work sits behind a closed bar.
      if (n.length) setOpen(true);
    }).catch(() => { notesLoaded.current = true; });
    return () => { alive = false; };
  }, [taskId]);
  useEffect(() => {
    if (notesLoaded.current) boardDrafts.putReviewNotes(taskId, notes);
  }, [notes, taskId]);

  const review = useMemo(() => ({
    notes,
    onAddNote: (n: Omit<DiffNote, 'id'>) =>
      setNotes((cur) => [...cur, { ...n, id: `${Date.now().toString(36)}-${cur.length}` }]),
    onRemoveNote: (id: string) => setNotes((cur) => cur.filter((n) => n.id !== id)),
  }), [notes]);

  // ONE comment for the whole review: on a task in review every comment does
  // reject-with-text and wakes the agent (server/routes/tasks.ts), so one note
  // at a time would waste one turn per note.
  const sendNotes = async () => {
    if (!notes.length || sendingNotes) return;
    setSendingNotes(true);
    setNotesError(null);
    try {
      await boardApi.comment(projectId, taskId, formatReviewNotes(notes, tr));
      setNotes([]);
      onSent?.();
    } catch (e) {
      // The notes are NOT cleared: they are hand-written work, and a send that
      // fails silently (bar stuck, no reason) is the best way to make people
      // give up and discard them out of exhaustion.
      setNotesError(e instanceof Error ? e.message : tr('board.task.changes.sendFailed'));
    } finally { setSendingNotes(false); }
  };

  const bundle = state && typeof state === 'object' ? state : null;
  const totals = bundle ? diffTotals(bundle.stat) : null;
  // The first pass has no answer yet: a bar that appears and vanishes says
  // less than nothing. From then on it always renders.
  if (!state) return null;
  const label = tr('board.task.changes');
  if (!bundle || !totals || totals.files === 0) {
    // The server's three answers, plus the case where the request itself failed.
    const why = state === 'error'
      ? tr('board.task.diffUnreadable')
      : bundle?.code === 'not_dispatched' ? tr('board.task.changes.notDispatched')
      : bundle?.code === 'unreadable' ? tr('board.task.changes.unreadable')
      : tr('board.task.changes.empty');
    // Nothing to look at: ONE muted line, not a handle that opens onto
    // emptiness. It stays written out though: "the card produced no code" and
    // "I could not look" are two opposite verdicts, and on a delivery in
    // review silence would confuse them.
    return (
      <div className="shrink-0 border-b border-app-border px-3 py-2">
        <span
          data-testid="task-changes-empty"
          // The reason can be wider than the chip: cut off on screen, whole
          // here below. A chip that truncates without a tooltip is information
          // that exists and cannot be read.
          title={`${label} · ${why}`}
          className="inline-flex max-w-full items-center gap-1.5 rounded bg-black/5 dark:bg-white/5 px-1.5 py-0.5 text-mini text-app-text-muted"
        >
          <GitCompare className="h-3 w-3 shrink-0" />
          <span className="shrink-0">{label}</span>
          <span className="min-w-0 truncate text-app-text-faint">· {why}</span>
        </span>
      </div>
    );
  }
  const fileCount = totals.files;
  const from = bundle.source === 'landed-merge' ? tr('board.task.changes.fromMerge')
    : bundle.source === 'delivery-commit' ? tr('board.task.changes.fromDelivery')
    : null;
  /**
   * ONE SMALL BUTTON, AND THE DIFF IN A DROPDOWN.
   *
   * It used to be an accordion in the brief's flow: when open, a thirty-file
   * diff pushed everything after it below the fold (the session, the decision
   * buttons) and you had to close it again to go back to deciding. A diff is
   * not a section of the sheet: it is something you CONSULT while deciding,
   * so it belongs on top, not inside.
   *
   * The chip carries the numbers even when closed: how many files, how big,
   * and whether you have pending notes. Those answer the question asked
   * before opening, and with the dropdown closed they remain the only trace
   * of hand-written work.
   */
  return (
    <div className="shrink-0 border-b border-app-border px-3 py-2">
      <button
        ref={triggerRef}
        onClick={() => setOpen((s) => !s)}
        data-testid="task-changes-trigger"
        title={tr('board.task.changes.openTitle')}
        className="flex max-w-full items-center gap-1.5 rounded bg-black/5 dark:bg-white/5 px-1.5 py-0.5 text-mini text-app-text-secondary hover:bg-white/10"
      >
        <GitCompare className="h-3 w-3 shrink-0" />
        <span className="shrink-0">{label}</span>
        <span className="shrink-0 text-app-text-faint">· {tr(fileCount === 1 ? 'board.task.changes.files.one' : 'board.task.changes.files.many', { n: fileCount })}</span>
        {/* The total goes at the TOP because it is the first question a reviewer
            asks ("how big is it?") and because it is the only complete number:
            the list can be truncated, this cannot. */}
        <span className="shrink-0 font-mono tabular-nums">
          <span className="text-emerald-400">+{totals.additions}</span> <span className="text-red-400">−{totals.deletions}</span>
        </span>
        {from && (
          <span className="min-w-0 truncate rounded bg-black/5 dark:bg-white/5 px-1 text-mini text-app-text-faint">{from}</span>
        )}
        {notes.length > 0 && (
          <span className="shrink-0 rounded bg-indigo-500/20 px-1 text-mini text-indigo-300">
            {tr('board.task.changes.pending', { n: notes.length })}
          </span>
        )}
        <ChevronDown className="h-3 w-3 shrink-0 text-app-text-faint" />
      </button>
      {/* `unmanagedFocus`: inside there is a diff with its per-file handles and
          the notes composer, and the arrow-key navigation of a command menu
          would fight with scrolling here. */}
      <Menu
        open={open}
        anchorRef={triggerRef}
        onClose={() => setOpen(false)}
        minWidth={520}
        unmanagedFocus
        testId="task-changes-panel"
        ariaLabel={label}
        className="w-[min(46rem,92vw)] max-h-[70vh] overflow-y-auto p-2"
      >
        <UnifiedDiff bundle={bundle} defaultOpenFirst review={review} focusPath={focusPath} source={diffSource} onStale={fetchDiff} />
        {notes.length > 0 && (
          <div className="mt-1.5 flex items-center gap-2 rounded border border-indigo-500/25 bg-indigo-500/5 px-2 py-1.5">
            <span className="min-w-0 flex-1 text-mini text-app-text-heading">
              {notesError
                ? <span className={DANGER_TEXT}>{tr('board.task.changes.sendFailedInline', { msg: notesError })}</span>
                : tr(notes.length === 1 ? 'board.task.changes.notes.one' : 'board.task.changes.notes.many', { n: notes.length })}
            </span>
            <button
              onClick={() => setNotes([])}
              disabled={sendingNotes}
              className="rounded px-2 py-0.5 text-mini text-app-text-secondary hover:text-app-text disabled:opacity-40"
            >
              {tr('board.task.changes.discard')}
            </button>
            <button
              onClick={sendNotes}
              disabled={sendingNotes}
              className="flex items-center gap-1 rounded bg-indigo-500/25 px-2 py-0.5 text-mini text-indigo-100 hover:bg-indigo-500/40 disabled:opacity-40"
            >
              {sendingNotes ? <Spinner size="sm" tone="current" /> : <Send className="h-3 w-3" />}
              {tr('board.task.changes.send')}
            </button>
          </div>
        )}
      </Menu>
    </div>
  );
}

/**
 * The attempts section: the fan-out comparison, and the place where the winner is chosen.
 *
 * Renders something ONLY when there is more than one attempt: a normally
 * dispatched task has no `task_attempts` rows and this section does not exist
 * for it.
 *
 * No score and no ordering "by merit": the diffstat sits next to each attempt
 * because it is a fact, not a vote. Putting "the smallest" or "the fastest" on
 * top would give a number the authority of a choice that is about merit. They
 * stay in launch order; the choice is a human click, and the honest way to
 * make it is to open the two diffs.
 */
export function TaskAttemptsSection({ projectId, taskId, bump, onChanged, onOpenTopic }: {
  projectId: string; taskId: string; bump?: string | number;
  onChanged: () => void;
  onOpenTopic?: (topicId: string) => void;
}) {
  const tr = useT();
  // Each attempt has ITS OWN session, so the resolver is needed per row here
  // and the task's `sessionState` is not enough. A single instance in the whole
  // drawer: no memoized list to wake up.
  const resolveSession = useTaskSessionResolver();
  const [attempts, setAttempts] = useState<TaskAttempt[]>([]);
  const [openDiff, setOpenDiff] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    boardApi.attempts(projectId, taskId)
      .then((a) => { if (alive) setAttempts(a); })
      .catch(() => { /* no attempts, no section */ });
    return () => { alive = false; };
  }, [projectId, taskId, bump]);

  const pick = async (attemptId: string) => {
    if (picking) return;
    setPicking(attemptId);
    setError(null);
    try {
      const res = await boardApi.selectAttempt(projectId, taskId, attemptId);
      setAttempts(res.attempts);
      setOpenDiff(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : tr('board.task.attempts.pickFailed'));
    } finally { setPicking(null); }
  };

  if (attempts.length < 2) return null;
  const decided = attempts.some((a) => a.state === 'selected');
  const running = attempts.filter((a) => a.state === 'running').length;

  return (
    <div className="shrink-0 border-b border-app-border px-3 py-2">
      <div className="flex items-center gap-1 text-mini font-semibold uppercase tracking-wide text-app-text-muted">
        {tr('board.task.attempts')} <span className="normal-case tracking-normal text-app-text-faint">· {tr('board.task.attempts.parallel', { n: attempts.length })}</span>
        {running > 0 && (
          <span className="ml-1 flex items-center gap-1 rounded bg-amber-500/15 px-1 text-mini normal-case tracking-normal text-amber-800 dark:text-amber-300">
            <Spinner size="xs" tone="current" /> {tr('board.task.attempts.running', { n: running })}
          </span>
        )}
      </div>
      {!decided && running === 0 && (
        <p className="mt-1 text-mini text-app-text-secondary">
          {tr('board.task.attempts.pickHint')}
        </p>
      )}
      {error && <p className={`mt-1 text-mini ${DANGER_TEXT}`}>{error}</p>}
      <div className="mt-1.5 space-y-1.5">
        {attempts.map((a) => {
          const won = a.state === 'selected';
          const dead = a.state === 'discarded';
          const work = attemptHasWork(a);
          return (
            <div
              key={a.id}
              data-testid={`task-attempt-${a.idx}`}
              className={`rounded border px-2 py-1.5 ${
                won ? 'border-emerald-500/40 bg-emerald-500/5' : dead ? 'border-app-border-subtle bg-white/[0.02] opacity-50' : 'border-app-border bg-white/[0.03]'
              }`}
            >
              <div className="flex items-center gap-1.5 text-mini">
                <span className="font-medium text-app-text">{tr('board.task.attempt.n', { n: a.idx })}</span>
                {won && <span className="rounded bg-emerald-500/25 px-1 text-mini text-emerald-200">{tr('board.task.attempt.selected')}</span>}
                {dead && <span className="rounded bg-black/10 dark:bg-white/10 px-1 text-mini text-app-text-secondary">{tr('board.task.attempt.discarded')}</span>}
                <span className="text-app-text-muted">{attemptStat(a, tr)}</span>
                {a.branch && <span className="truncate font-mono text-mini text-app-text-faint">{a.branch}</span>}
              </div>
              {a.summary && (
                <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap text-mini leading-snug text-app-text-heading">{a.summary}</p>
              )}
              <div className="mt-1 flex items-center gap-1.5">
                {work && (
                  <button
                    onClick={() => setOpenDiff((cur) => (cur === a.id ? null : a.id))}
                    className="rounded bg-black/5 dark:bg-white/5 px-1.5 py-0.5 text-mini text-app-text-heading hover:bg-white/10"
                  >{tr(openDiff === a.id ? 'board.task.attempt.closeDiff' : 'board.task.attempt.openDiff')}</button>
                )}
                {/* The "open the chat" label said less than what it does: it
                    is the SESSION of THIS attempt, and like any session it may be gone. */}
                {a.topicId && onOpenTopic && !dead && canOpenTaskSession(resolveSession(a.topicId)) && (
                  <button
                    onClick={() => onOpenTopic(a.topicId!)}
                    title={tr('board.task.openSessionTitle')}
                    className="rounded bg-black/5 dark:bg-white/5 px-1.5 py-0.5 text-mini text-app-text-heading hover:bg-white/10"
                  >{tr('board.task.openSession')}</button>
                )}
                {a.topicId && !dead && shouldExplainMissingSession(resolveSession(a.topicId)) && (
                  <span
                    title={tr('board.task.sessionGoneTitle')}
                    className="rounded bg-black/5 dark:bg-white/5 px-1.5 py-0.5 text-mini text-app-text-faint"
                  >{tr('board.task.sessionGone')}</span>
                )}
                {!decided && running === 0 && a.topicId && (
                  <button
                    onClick={() => pick(a.id)}
                    disabled={!!picking}
                    data-testid="task-attempt-pick"
                    title={work ? undefined : tr('board.task.attempt.emptyTitle')}
                    className="ml-auto flex items-center gap-1 rounded bg-emerald-500/80 px-2 py-0.5 text-mini font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
                  >
                    {picking === a.id && <Spinner size="sm" tone="current" />} {tr('board.task.attempt.pick')}
                  </button>
                )}
              </div>
              {openDiff === a.id && (
                <AttemptDiff key={`${projectId}:${taskId}:${a.id}`} projectId={projectId} taskId={taskId} attemptId={a.id} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The diff of ONE attempt, loaded only when it is opened (N diffs together
 *  would be N bundles in memory for a choice where you look at one at a time).
 *  Mounted with a `key` on the attempt: changing target REMOUNTS, so the state
 *  restarts from 'loading' without a setState inside the effect (which would
 *  be a cascading render, and the lint rightly rejects it). */
function AttemptDiff({ projectId, taskId, attemptId }: { projectId: string; taskId: string; attemptId: string }) {
  const tr = useT();
  const [state, setState] = useState<DiffBundle | 'loading' | 'error'>('loading');
  // Bumped when a byte read finds the bundle's revisions gone: the bundle is
  // read again, and the panel with it. The old one stays on screen meanwhile.
  const [reads, setReads] = useState(0);
  const reread = useCallback(() => setReads((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    boardApi.taskDiff(projectId, taskId, attemptId)
      .then((b) => { if (alive) setState(b); })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [projectId, taskId, attemptId, reads]);
  const source = useMemo<DiffPanelSource>(() => ({ kind: 'task', projectId, taskId, attemptId }), [projectId, taskId, attemptId]);
  if (state === 'loading') return <div className="mt-1.5 flex items-center gap-1 text-mini text-app-text-muted"><Spinner size="sm" tone="current" /> {tr('board.task.loadingDiff')}</div>;
  if (state === 'error') return <p className={`mt-1.5 text-mini ${DANGER_TEXT}`}>{tr('board.task.diffUnreadable')}</p>;
  // An attempt is read ONLY from its own worktree (durable refs speak about the
  // winner), so there are two codes here: "produced nothing" and
  // "not reconstructible", and they stay distinct even in a single line.
  if (state.stat.length === 0) {
    const why = state.code === 'no_changes' || !state.code
      ? tr('board.task.changes.empty')
      : tr('board.task.changes.unreadable');
    return <p className="mt-1.5 text-mini text-app-text-muted">{why}</p>;
  }
  return (
    // Pure accordion (see TaskChangesSection): the vh cap was a stand-in for
    // the scroll the drawer did not have.
    <div className="mt-1.5">
      <UnifiedDiff bundle={state} defaultOpenFirst source={source} onStale={reread} />
    </div>
  );
}
