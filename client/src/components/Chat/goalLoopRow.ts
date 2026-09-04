/**
 * A turn asked for by the GOAL is not a turn asked for by the person.
 *
 * When a goal is still open at the end of a turn, the server sends the chat a
 * short continuation message (server/services/goal-loop.ts). That row has to
 * have `role: 'user'` - it is the only role a provider answers - and without a
 * marker the transcript would show the human saying "Objective still open:
 * ... continue", which they never typed. Reading a conversation back and
 * finding words you did not write is worse than the loop not existing.
 *
 * So the row carries a block, and this is what the renderer reads to draw one
 * compact line instead of a bubble. Pure, so the rule has a test that does not
 * need a DOM.
 */

import type { ContentBlock } from '../../types';

export type GoalLoopRow =
  /** The server bought another turn: the number is the consecutive attempt. */
  | { kind: 'nudge'; attempt: number }
  /** The loop stopped by itself, and says which brake fired. */
  | { kind: 'stop'; reason: 'capped' | 'stalled' };

/** The goal-loop line this message is, or null if it is an ordinary message. */
export function goalLoopRowOf(blocks: ContentBlock[] | undefined | null): GoalLoopRow | null {
  if (!blocks || blocks.length === 0) return null;
  for (const b of blocks) {
    if (b.kind === 'goal-nudge') return { kind: 'nudge', attempt: b.attempt };
    if (b.kind === 'goal-stop') return { kind: 'stop', reason: b.reason };
  }
  return null;
}
