/**
 * AN ENVELOPE THE DISPATCHER WROTE IS NOT SOMETHING YOU SAID.
 *
 * A board turn starts by posting a generated text to the chat as a `user`
 * message: the kickoff ("You are the exclusive owner of task ..."), the resume
 * after a human comment, the nudge after an interrupted turn. `user` is the
 * only role a provider answers, so on the wire the row has to look like that.
 *
 * On screen it did too: a right-hand bubble with an "edit" button on hover,
 * three hundred lines of instructions the person never wrote and could rewrite.
 * The row now carries a `dispatched-envelope` block (written where the request
 * says `dispatched: true`), and this is what the renderer reads to draw one
 * collapsed line instead.
 *
 * COLLAPSED, NOT HIDDEN: the resume envelope quotes the human's own message
 * inside it, so the text stays one click away. Pure, so the rule has a test
 * that needs no DOM - same shape as `goalLoopRow.ts`, on purpose.
 */

import type { ContentBlock } from '../../types';

/** Was this row written by the dispatcher rather than typed by a person? */
export function isDispatchedEnvelope(blocks: ContentBlock[] | undefined | null): boolean {
  if (!blocks || blocks.length === 0) return false;
  return blocks.some((b) => b.kind === 'dispatched-envelope');
}

/**
 * WHICH CARD COMMENTS THIS ENVELOPE CARRIED, by id.
 *
 * A resume envelope quotes the comments somebody wrote while the agent was
 * busy. Naming them is what lets the card's conversation draw those words ONCE,
 * as the comments they are, instead of twice. Empty is the honest answer for a
 * kickoff, which delivers nothing, and for every envelope written before the
 * ids existed: absent means "no claim", never "nothing was carried".
 *
 * The delivery chip of KANBAN-74 reads exactly this, at every render, so no
 * process ever has to WRITE that a message was delivered.
 */
export function envelopeCommentIds(blocks: ContentBlock[] | undefined | null): string[] {
  if (!blocks || blocks.length === 0) return [];
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind !== 'dispatched-envelope') continue;
    for (const id of b.commentIds ?? []) if (typeof id === 'string' && id) out.push(id);
  }
  return out;
}
