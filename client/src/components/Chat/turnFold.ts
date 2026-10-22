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
 *  - media drawn in the work stays out of the fold: an image is a result, and
 *    so is a page the agent opened (CHAT-BROWSER-01);
 *  - so is a question the person already ANSWERED (or a plan they decided):
 *    the choice is a fact of the conversation, not machinery. The agent that
 *    asks mid-turn, works on and closes with a text is the common shape, and
 *    folded, the choice was out of sight again after a reload (04/10). The
 *    call is lifted out of its run alone; the rest of the run still folds;
 *  - a turn with no work, or with no answer, is not folded: there is nothing to
 *    hide, or nothing to show instead.
 *
 * Nothing is removed: the row opens onto exactly the same groups, in order.
 * Pure, so the rule has a test that needs no DOM.
 */
import type { ToolCall } from '../../types';
import { isAwaitingHuman } from '../../../../shared/types';
import { isActiveTool } from './toolGrouping';
import { COMPACTION_PREAMBLE } from '../../lib/compactionSummary';
import type { BrowserMarker } from './browserOpens';
import type { ViewOpen } from './viewOpens';

/** The groups `MessageContent` builds from a message's blocks. */
export type FoldableGroup =
  | { kind: 'tools'; startIdx: number; tools: ToolCall[] }
  | { kind: 'thinking'; idx: number; text: string }
  | { kind: 'text'; idx: number; text: string }
  | { kind: 'media'; idx: number; path: string; seq: number }
  | { kind: 'browser'; idx: number; marker: BrowserMarker }
  | { kind: 'view'; idx: number; tool: ToolCall; view: ViewOpen };

export interface TurnFold<G extends FoldableGroup> {
  /** Everything up to and including a compaction recap: never folded. */
  head: G[];
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
  // A COMPACTION INSIDE THE TURN IS A BOUNDARY, NOT WORK. The CLI writes its
  // recap as text in the middle of a turn that ran out of context; folded, the
  // recap and its «Context compacted» row vanished behind «N actions» (55 turns
  // of 55 on the prod DB, 24/09), and once the recap itself became the answer
  // in sight. Only the work AFTER the last recap folds; the recap and what came
  // before it stay as they were.
  let recapAt = -1;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g.kind === 'text' && g.text.includes(COMPACTION_PREAMBLE)) { recapAt = i; break; }
  }
  const head = groups.slice(0, recapAt + 1);
  const tail = groups.slice(recapAt + 1);
  let answerAt = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    const g = tail[i];
    if (g.kind === 'text' && g.text.trim().length > 0) { answerAt = i; break; }
  }
  if (answerAt <= 0) return null;
  // The answer is the LAST text; what follows it (a trailing tool, an image
  // the answer points at) is shown too, never folded behind the answer.
  const before = tail.slice(0, answerAt);
  for (const g of groups) {
    if (g.kind !== 'tools') continue;
    if (g.tools.some((tc) => isAwaitingHuman(tc.status) || isActiveTool(tc))) return null;
  }
  // The run is split around each answered call: the call stands alone among
  // what stays in sight, its neighbours go on folding. The key of a split run
  // is its start plus the offset inside it, which stays between that run's
  // first block and the next run's, so no two runs share one.
  const work: G[] = [];
  const kept: G[] = [];
  for (const g of before) {
    if (g.kind === 'media' || g.kind === 'browser' || g.kind === 'view') { kept.push(g); continue; }
    if (g.kind !== 'tools' || !g.tools.some(isAnswered)) { work.push(g); continue; }
    let run: ToolCall[] = [];
    let runStart = 0;
    g.tools.forEach((tc, i) => {
      if (!isAnswered(tc)) {
        if (run.length === 0) runStart = i;
        run.push(tc);
        return;
      }
      if (run.length > 0) work.push({ ...g, startIdx: g.startIdx + runStart, tools: run } as G);
      run = [];
      kept.push({ ...g, startIdx: g.startIdx + i, tools: [tc] } as G);
    });
    if (run.length > 0) work.push({ ...g, startIdx: g.startIdx + runStart, tools: run } as G);
  }
  const folded = work.flatMap((g) => (g.kind === 'tools' ? g.tools : []));
  if (folded.length < FOLD_MIN_TOOLS) return null;
  return { head, work, shown: [...kept, ...tail.slice(answerAt)], tools: folded };
}

/** A call that asked the person something and got the answer. */
const isAnswered = (tc: ToolCall): boolean => !!tc.userResponse;

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
