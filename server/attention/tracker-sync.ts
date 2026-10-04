/**
 * WHAT THE SESSION TRACKER TELLS THE ATTENTION STORE (notifications-redesign,
 * design sections 2.2 and 5): the tasks a hook starts or ends, the wait the
 * phase shows, a terminal's turns, and the tasks a transcript line reports
 * finished. Kept apart from `lib/claude-session-tracker.ts`, which calls these
 * with the subject of the session it is applying.
 */
import type { ClaudeSessionState, HookPayload } from '../lib/claude-session-state';
import { applyTaskChanges, closeHold, openHold, processEnded, removeBackgroundTask, taskKind, turnEnded, turnStarted } from './store';
import { finishedTasksOfTranscriptLine, taskChangesOfHook } from './background-tasks';

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

/** The tasks a transcript line reports finished leave the subject's map. */
export function transcriptTasks(subject: string | null, line: string): void {
  if (!subject) return;
  try {
    for (const id of finishedTasksOfTranscriptLine(line, (taskId) => taskKind(subject, taskId))) removeBackgroundTask(subject, id);
  } catch (err) {
    console.warn('[claude-session-tracker] attention transcript failed', err);
  }
}