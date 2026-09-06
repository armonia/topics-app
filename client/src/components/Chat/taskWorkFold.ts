/**
 * A TASK CHAT IS READ TO DECIDE, NOT TO WATCH THE MACHINE WORK.
 *
 * The chat of a board task has a second reader that a normal conversation does
 * not have: whoever has to approve it. That person is looking for four things
 * only, and they are all words: what the agent says, what it asks, what it
 * delivers, and what the human already told it. Everything else in the
 * transcript is machinery that PROVES the work rather than explaining it, and
 * on a long task it is most of the page: tool runs, sub-agents, pre-review
 * checks, logs.
 *
 * So in a task session the machine work of a turn collapses into ONE closed
 * accordion with a summary line, and the words stay in plain sight. Nothing is
 * removed: the accordion opens onto exactly the rows that were there before.
 *
 * TWO BOUNDARIES, and they are what keeps this honest.
 *
 *  1. CHRONOLOGY IS NEVER REORDERED. Work is folded per contiguous stretch, so
 *     prose written in the middle of a turn stays where it was written. In the
 *     ordinary turn (a user message, a run of actions, an answer) that stretch
 *     is the whole turn and the accordion is one.
 *  2. WHAT NEEDS A HUMAN IS NEVER FOLDED. A question, a permission request and
 *     the work that is STILL RUNNING stay open: the first two are the reason
 *     the turn stopped, and the third is the one thing a person watches while
 *     it happens.
 *
 * Kept free of React so it unit-tests under bun:test.
 */

import type { ChatMessage, ToolCall } from '../../types';
import { isAwaitingHuman } from '../../../../shared/types';
import { blocksOf } from './coalesceToolRun';
import { resolveToolDetail } from './toolDetail';
import { isActiveTool, summarizeToolGroup, type ToolGroupSummary } from './toolGrouping';

/** One stretch of the transcript, once a turn is split by what it is FOR. */
export type TurnSegment =
  | { kind: 'salient'; message: ChatMessage }
  | { kind: 'work'; messages: ChatMessage[] };

/** Every tool call the message carries, in the order it ran. */
export function toolsOf(msg: ChatMessage): ToolCall[] {
  const fromBlocks = blocksOf(msg)
    .filter((b) => b.kind === 'tool')
    .map((b) => (b as { kind: 'tool'; toolCall: ToolCall }).toolCall);
  if (fromBlocks.length > 0) return fromBlocks;
  return msg.toolCalls ?? [];
}

/**
 * The message is MACHINE WORK: it proves the turn instead of speaking in it.
 *
 * Wordless assistant output that carries actions or reasoning, with every
 * action settled and none of them waiting on a person.
 */
export function isMachineWork(msg: ChatMessage): boolean {
  if (msg.role !== 'assistant') return false;
  // A live turn is watched, not folded: it is the one moment the actions are
  // the interesting part of the screen.
  if (msg.partial) return false;
  if ((msg.content ?? '').trim().length > 0) return false;
  if (msg.media && msg.media.length > 0) return false;
  const tools = toolsOf(msg);
  const hasReasoning = !!msg.thinking || blocksOf(msg).some((b) => b.kind === 'thinking');
  if (tools.length === 0 && !hasReasoning) return false;
  for (const tc of tools) {
    if (isAwaitingHuman(tc.status)) return false;
    if (isActiveTool(tc)) return false;
  }
  return true;
}

/**
 * Split a turn (or a whole transcript) into what is said and what was done.
 *
 * Consecutive work messages join one segment; anything salient closes it. The
 * order of the input is the order of the output, always.
 */
export function partitionTurn(messages: ChatMessage[]): TurnSegment[] {
  const segments: TurnSegment[] = [];
  for (const message of messages) {
    if (!isMachineWork(message)) {
      segments.push({ kind: 'salient', message });
      continue;
    }
    const last = segments[segments.length - 1];
    if (last && last.kind === 'work') last.messages.push(message);
    else segments.push({ kind: 'work', messages: [message] });
  }
  return segments;
}

export interface WorkSummary extends ToolGroupSummary {
  /** Files the stretch WROTE (edit/write), deduplicated in execution order.
   *  Reads are not touches: a file that was only looked at did not change. */
  files: string[];
  /** Sub-agents started in the stretch: they are work of their own size. */
  subAgents: number;
}

/** Paths a single call wrote, if it wrote any. */
function writtenPath(tc: ToolCall): string | undefined {
  const detail = resolveToolDetail(tc);
  if (detail.type === 'edit' || detail.type === 'write') return detail.filePath;
  return undefined;
}

/** The one line that has to be worth the fold: how many actions, how long,
 *  how many files, how many failures, how many sub-agents. */
export function summarizeWork(messages: ChatMessage[]): WorkSummary {
  const tools = messages.flatMap(toolsOf);
  const files: string[] = [];
  let subAgents = 0;
  for (const tc of tools) {
    const path = writtenPath(tc);
    if (path && !files.includes(path)) files.push(path);
    if (resolveToolDetail(tc).type === 'sub_agent') subAgents++;
  }
  return { ...summarizeToolGroup(tools), files, subAgents };
}

/** `src/a.ts` -> `a.ts`. The basename is what identifies a file in one line. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
