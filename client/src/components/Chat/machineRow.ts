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

const MACHINE_KINDS = new Set(['goal-nudge', 'goal-stop', 'dispatched-envelope', 'machine-stop']);

export function isMachineRow(blocks: readonly ContentBlock[] | undefined | null): boolean {
  if (!blocks || blocks.length === 0) return false;
  return blocks.some((b) => MACHINE_KINDS.has(b.kind));
}

export type MachineStopCause = Extract<ContentBlock, { kind: 'machine-stop' }>['cause'];

/**
 * The cause of a turn the machine stopped before it said anything, or null.
 * The row carries nothing else (`server/lib/machine-stop-notice.ts`): it exists
 * so the chat does not end on an unanswered message that the client would
 * offer to resend.
 */
export function machineStopOf(blocks: readonly ContentBlock[] | undefined | null): MachineStopCause | null {
  const b = blocks?.find((x) => x.kind === 'machine-stop');
  return b && b.kind === 'machine-stop' ? b.cause : null;
}
