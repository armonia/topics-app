/**
 * A FINISHED TURN SHOWS ITS ANSWER; THE WORK THAT LED THERE FOLDS INTO ONE ROW.
 *
 * Measured on 23/09 on the real DB: a closed turn is 59-93 rows (topic d6158ec6:
 * 59 rows before an answer of 128 characters), because the agent alternates a
 * short line of prose and one or two tools, so the runs stay under the grouping
 * threshold and the prose splits every group. The answer, the one thing the
 * reader came for, sits at the bottom of a wall. Claude Code folds a finished
 * turn (ctrl+o) and Codex shows «Explored» lines; here it stayed spread out.
 *
 * The rule, on the timeline of ONE finished message:
 *  - the ANSWER is the last text of the turn: it stays in plain sight;
 *  - everything BEFORE it (tools, reasoning, the running commentary between
 *    them) folds into one closed row that says how much happened;
 *  - nothing that needs a person folds: a question, a permission, a plan
 *    waiting for approval, a tool still running. If any is there, the turn is
 *    shown as it always was;
 *  - media drawn in the work stays out of the fold: an image is a result;
 *  - a turn with no work, or with no answer, is not folded: there is nothing to
 *    hide, or nothing to show instead.
 *
 * Nothing is removed: the row opens onto exactly the same groups, in order.
 * Pure, so the rule has a test that needs no DOM.
 */
import type { ToolCall } from '../../types';
import { isAwaitingHuman } from '../../../../shared/types';
import { isActiveTool } from './toolGrouping';

/** The groups `MessageContent` builds from a message's blocks. */
export type FoldableGroup =
  | { kind: 'tools'; startIdx: number; tools: ToolCall[] }
  | { kind: 'thinking'; idx: number; text: string }
  | { kind: 'text'; idx: number; text: string }
  | { kind: 'media'; idx: number; path: string; seq: number };

export interface TurnFold<G extends FoldableGroup> {
  /** The work before the answer, to render inside the closed row. */
  work: G[];
  /** The answer, and anything the fold must not swallow, in order. */
  shown: G[];
  /** The tool calls folded, for the summary line. */
  tools: ToolCall[];
}

/** Fewer than this many tool calls is not worth a row that hides them. */
export const FOLD_MIN_TOOLS = 2;

export function foldFinishedTurn<G extends FoldableGroup>(groups: readonly G[], partial: boolean | undefined): TurnFold<G> | null {
  if (partial) return null;
  let answerAt = -1;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g.kind === 'text' && g.text.trim().length > 0) { answerAt = i; break; }
  }
  if (answerAt <= 0) return null;
  // The answer is the LAST text; what follows it (a trailing tool, an image
  // the answer points at) is shown too, never folded behind the answer.
  const before = groups.slice(0, answerAt);
  const tools = before.flatMap((g) => (g.kind === 'tools' ? g.tools : []));
  for (const g of groups) {
    if (g.kind !== 'tools') continue;
    if (g.tools.some((tc) => isAwaitingHuman(tc.status) || isActiveTool(tc))) return null;
  }
  if (tools.length < FOLD_MIN_TOOLS) return null;
  const work = before.filter((g) => g.kind !== 'media');
  const keptMedia = before.filter((g) => g.kind === 'media');
  return { work, shown: [...keptMedia, ...groups.slice(answerAt)], tools };
}

/**
 * The turns this page watched stream. They stay spread out when they end:
 * folding at `stream:end` shrank the bubble by hundreds of pixels under the
 * reader and the pinned list jumped up (chat-scroll-at-rest, 3793 -> 3312).
 * They fold the next time the page is loaded, when they are history. Ids of
 * both the live placeholder and the durable row land here, a few per turn.
 */
const watchedLive = new Set<string>();
export function noteWatchedLive(messageId: string): void {
  watchedLive.add(messageId);
}
export function wasWatchedLive(messageId: string): boolean {
  return watchedLive.has(messageId);
}
