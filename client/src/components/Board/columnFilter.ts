/**
 * What the task column keeps and what goes under «Details».
 *
 * The column is words only: the person, the agent, the questions. Everything
 * the dispatcher or the machine wrote (status changes, service notes, review
 * notes, envelopes, command ends, goal-loop lines, stop and background
 * notices) is chronicle. Pure, so each kind of row has its own unit test.
 */
import type { TimelineItem } from './taskTimeline';
import type { ChatMessage } from '../../types';

export interface ChronicleDeps {
  /** The fold rule of the thread's bookkeeping (service notes). */
  isService: (item: TimelineItem) => boolean;
  /** Does this comment body carry a question block? Those stay in the column. */
  hasQuestion: (content: string) => boolean;
}

const CHRONICLE_BLOCKS = new Set(['process-exit', 'goal-nudge', 'goal-stop', 'machine-stop', 'background-notice']);

const isChronicleMessage = (msg: Pick<ChatMessage, 'blocks'>): boolean =>
  (msg.blocks ?? []).some((b) => CHRONICLE_BLOCKS.has(b.kind));

export function isChronicleRow(item: TimelineItem, deps: ChronicleDeps): boolean {
  if (item.source === 'comment') {
    return item.kind === 'status'
      || item.kind === 'review-note'
      || deps.isService(item)
      || (item.comment.author === 'system' && item.comment.kind === 'comment' && !deps.hasQuestion(item.comment.content));
  }
  return !!item.envelope || isChronicleMessage(item.msg);
}

/**
 * The session row whose running tool the status line may show: the newest
 * session row, and only when it is the agent's. A newer user row means a new
 * turn, and the tool a previous turn left `running` must not be shown again.
 */
export function liveToolRow(timeline: readonly TimelineItem[]): Extract<TimelineItem, { source: 'session' }> | null {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const t = timeline[i];
    if (t.source !== 'session' || t.envelope) continue;
    return t.msg.role === 'assistant' ? t : null;
  }
  return null;
}
