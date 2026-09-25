/**
 * Is this row one the MACHINE wrote, not the person or the model?
 *
 * The goal loop's continuation (`goal-nudge`), its stop notice (`goal-stop`)
 * and the board's envelope (`dispatched-envelope`) are rows of the transcript
 * because a provider only answers a `user` turn, but none of them is
 * something anybody said. The chat draws them as a service line
 * (`MessageBubble`), and the same rule has to hold wherever else a row is
 * read as "the last thing said", the sidebar preview first: «Objective still
 * open: ...» under the name of a chat is the machine talking over the person.
 */
import type { ContentBlock } from '../../types';

const MACHINE_KINDS = new Set(['goal-nudge', 'goal-stop', 'dispatched-envelope']);

export function isMachineRow(blocks: readonly ContentBlock[] | undefined | null): boolean {
  if (!blocks || blocks.length === 0) return false;
  return blocks.some((b) => MACHINE_KINDS.has(b.kind));
}
