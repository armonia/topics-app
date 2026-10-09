/**
 * WHAT THE SESSION TRACKER TELLS THE ATTENTION STORE (notifications-redesign,
 * design sections 2.2 and 5): the tasks a hook starts or ends, the wait the
 * phase shows, a terminal's turns, and the tasks a transcript line reports
 * finished. Kept apart from `lib/claude-session-tracker.ts`, which calls these
 * with the subject of the session it is applying.
 */
import type { ClaudeSessionState, HookPayload } from '../lib/claude-session-state';
import { applyTaskChanges, closeHold, countingTasks, finishBackgroundTasks, openHold, processEnded, turnEnded, turnStarted } from './store';
import { finishedTasksOfTranscriptLine, queuedTasksOfTranscriptLine, taskChangesOfHook, type FinishedTask } from './background-tasks';

/**
 * What a hook tells the attention store, besides the phase: the tasks it
 * starts or ends (both kinds of session), the wait the phase shows (both),
 * and, for a TERMINAL, the turn it opens or closes. A chat's turns are the
 * chat route's (`stream:start`/`stream:end`), never the hook's: two writers
 * of the same turn would make two epochs of it.
 */
export function hookTasks(subject: string | null, payload: HookPayload, t: number): void {
  if (!subject) return;
  try { applyTaskChanges(subject, taskChangesOfHook(payload, new Date(t).toISOString())); } catch (err) {
    console.warn('[claude-session-tracker] attention tasks failed', err);
  }
}

export function syncAttention(subject: string | null, prev: ClaudeSessionState, next: ClaudeSessionState, event: string | null, terminal: boolean, t: number): void {
  if (!subject) return;
  try {
    const waiting = next.phase === 'awaiting-approval' || next.phase === 'paused';
    if (waiting && next.pendingApproval) {
      const pa = next.pendingApproval;
      openHold(subject, 'phase', {
        kind: pa.kind === 'plan' ? 'plan' : pa.question ? 'question' : 'permission',
        id: `phase:${pa.requestedAt}`,
        text: pa.prompt,
        since: new Date(pa.requestedAt).toISOString(),
      });
    } else if (!waiting) {
      closeHold(subject, 'phase');
    }
    if (!terminal) return;
    if (event === 'UserPromptSubmit' || (event === null && next.phase === 'running' && prev.phase !== 'running' && !isTurnWorkPhaseOf(prev))) {
      // A terminal's one-shot cron fires as a turn the transcript does not
      // tell apart from any other: the first turn after the one that armed it
      // takes it (ATTN-03), or the subject would wait on it for ever.
      applyTaskChanges(subject, [{ op: 'remove-one-shot-crons' }]);
      turnStarted(subject);
    } else if (event === 'Stop') {
      turnEnded(subject, { turnId: `stop:${next.claudeSessionId}:${t}`, outcome: 'done', at: new Date(t).toISOString() });
    } else if (event === 'SessionEnd') {
      processEnded(subject, { cause: 'session-end', byPerson: true });
    } else if (isTurnWorkPhaseOf(prev) && TURN_AT_REST_PHASES.has(next.phase)) {
      // The turn went to rest with no Stop: Claude Code fires none on an Esc
      // interrupt, so the reaper's demotion of the silent turn is what ends
      // it. Left open, the terminal would read «working» until its next prompt.
      // Nothing to announce: the person stopped it, or nobody knows how it ended.
      turnEnded(subject, { outcome: null });
    }
  } catch (err) {
    console.warn('[claude-session-tracker] attention sync failed', err);
  }
}

/** Phases a turn rests at: not at work, and no wait on the person (`paused` is one). */
const TURN_AT_REST_PHASES: ReadonlySet<ClaudeSessionState['phase']> = new Set(['awaiting-user', 'dormant', 'completed', 'error']);

function isTurnWorkPhaseOf(s: ClaudeSessionState): boolean {
  return s.phase === 'running' || s.phase === 'tool-running' || s.phase === 'awaiting-approval';
}

/**
 * How long a notice the CLI queued and neither delivered nor let go keeps its
 * task in flight, from when its turn stopped. At rest the CLI delivers one
 * 31 ms after its enqueue at the median, 4.1 s at the 99th percentile, 3 of
 * 437 after more than a minute; 16 of about 1800 it neither delivers nor lets
 * go, and those must not hold the turn for good.
 */
export const NOTICE_WAKE_MS = 60_000;

/**
 * How long after a chat's CLI snapshot emptied its map a parked turn waits
 * before resting: the CLI queues the notice that wakes it ms after the
 * snapshot (fixture 2.1.282, lines 161-163), and the tail reads the
 * transcript every 1.5 s.
 */
export const EMPTIED_QUIET_MS = 5_000;

/** A notice the CLI queued: its task, when the CLI wrote it, and whether a reattach's catch-up read it. */
interface QueuedNotice { task: FinishedTask; at: number; late: boolean }

/**
 * The task ends a session's transcript reports, per subject (MONITOR-04,
 * ATTN-03). A notice the CLI only queues (`enqueue`) keeps its task in flight
 * until its fate, the row that delivers it or the queue's `remove`
 * (`background-tasks.ts`), or until `NOTICE_WAKE_MS` after its turn stopped
 * with neither. One a reattach's catch-up queued is of before the restart
 * wherever its fate is read, and announces nothing (`finishBackgroundTasks`).
 * In memory: after a restart a terminal's catch-up reads its notices again, a
 * chat's are lost. `drained`: the subject's parked turn lost its last counting
 * task to a line, the clock, or a chat's whole-map rewrite that emptied it
 * once quiet for `EMPTIED_QUIET_MS` with no notice of its transcript still
 * queued, since it parked (`settleWatching`). Kept per subject, not per read:
 * a sweep whose commit a hook overtook reads its lines again, and finds their
 * tasks gone.
 */
export function createTranscriptEnds() {
  const queued = new Map<string, Map<string, QueuedNotice>>();
  const drained = new Set<string>();
  const emptiedAt = new Map<string, number>();
  const finish = (subject: string, tasks: readonly FinishedTask[], late: boolean) => {
    if (!tasks.length) return;
    const before = countingTasks(subject);
    finishBackgroundTasks(subject, tasks.flatMap((f) => (f.toolUseId ? [f.id, f.toolUseId] : [f.id])), { late });
    if (before > 0 && countingTasks(subject) === 0) drained.add(subject);
  };
  const settle = (subject: string, tasks: readonly FinishedTask[]) => {
    const notices = queued.get(subject);
    for (const f of tasks) notices?.delete(f.id);
    if (notices && !notices.size) queued.delete(subject);
  };
  return {
    /**
     * A transcript line the CLI wrote at `at`: the notices it queues are kept,
     * the first read winning (a line read live stays live when a catch-up reads
     * it again), and the tasks it delivers or lets go leave the map. `late`: a
     * reattach's catch-up.
     */
    read(subject: string, line: string, at: number, late = false): void {
      try {
        const notices = queued.get(subject) ?? new Map<string, QueuedNotice>();
        for (const task of queuedTasksOfTranscriptLine(line)) if (!notices.has(task.id)) notices.set(task.id, { task, at, late });
        if (notices.size) queued.set(subject, notices);
        const finished = finishedTasksOfTranscriptLine(line);
        const ofBefore = finished.filter((f) => late || notices.get(f.id)?.late);
        finish(subject, ofBefore, true);
        finish(subject, finished.filter((f) => !ofBefore.includes(f)), false);
        settle(subject, finished);
      } catch (err) {
        console.warn('[claude-session-tracker] attention transcript failed', err);
      }
    },
    /**
     * The notices `s` still holds `NOTICE_WAKE_MS` after its turn stopped,
     * neither delivered nor let go, leave the map. Never while a turn runs: the
     * CLI absorbs a notice as late as the turn's next tool call. One a catch-up
     * queued counts from when it was written, its turn's end being of before.
     */
    expire(subject: string, s: ClaudeSessionState, t: number): void {
      const notices = queued.get(subject);
      if (!notices || s.phase === 'running' || s.phase === 'tool-running' || s.phase === 'awaiting-approval' || s.phase === 'paused') return;
      const expired = [...notices.values()].filter((n) => t - (n.late ? n.at : Math.max(n.at, s.phaseUpdatedAt)) >= NOTICE_WAKE_MS);
      settle(subject, expired.map((n) => n.task));
      try {
        finish(subject, expired.filter((n) => n.late).map((n) => n.task), true);
        finish(subject, expired.filter((n) => !n.late).map((n) => n.task), false);
      } catch (err) {
        console.warn('[claude-session-tracker] attention tasks failed', err);
      }
    },
    /**
     * A chat's whole-map rewrite took out the last counting task at `at`: the
     * parked turn rests once quiet, unless a notice wakes it first.
     */
    emptied: (subject: string, at: number): void => { emptiedAt.set(subject, at); },
    /**
     * A row that opens a turn (a prompt, a delivered notice), written at `at`:
     * an emptying before it no longer means nothing is left to wake the turn,
     * even while the sweep that read it has not committed yet. An older row,
     * read late, leaves it.
     */
    opened: (subject: string, at: number): void => {
      const was = emptiedAt.get(subject);
      if (was !== undefined && at > was) emptiedAt.delete(subject);
    },
    drained: (subject: string, t: number): boolean => {
      if (drained.has(subject)) return true;
      const at = emptiedAt.get(subject);
      return at !== undefined && t - at >= EMPTIED_QUIET_MS && !queued.get(subject)?.size;
    },
    /** A turn that parks starts over: only the ends read from here on let it rest. */
    parked: (subject: string): void => { drained.delete(subject); emptiedAt.delete(subject); },
  };
}
