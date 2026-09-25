/**
 * Is this row one the MACHINE wrote, not the person or the model?
 *
 * The goal loop's continuation (`goal-nudge`), its stop notice (`goal-stop`),
 * the line about a chat's background work (`background-notice`)
 * and the board's envelope (`dispatched-envelope`) are rows of the transcript
 * because a provider only answers a `user` turn, but none of them is
 * something anybody said. The chat draws them as a service line
 * (`MessageBubble`), and the same rule has to hold wherever else a row is
 * read as "the last thing said", the sidebar preview first: «Objective still
 * open: ...» under the name of a chat is the machine talking over the person.
 */
import type { ContentBlock } from '../../types';
import type { MachineStopCause } from '../../../../shared/types';
export type { MachineStopCause } from '../../../../shared/types';

const MACHINE_KINDS = new Set(['goal-nudge', 'goal-stop', 'dispatched-envelope', 'machine-stop', 'background-notice']);

export function isMachineRow(blocks: readonly ContentBlock[] | undefined | null): boolean {
  if (!blocks || blocks.length === 0) return false;
  return blocks.some((b) => MACHINE_KINDS.has(b.kind));
}


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

export type BackgroundNoticeBlock = Extract<ContentBlock, { kind: 'background-notice' }>;

/** The background notice this row is, or null (server/lib/background-notice.ts). */
export function backgroundNoticeOf(blocks: readonly ContentBlock[] | undefined | null): BackgroundNoticeBlock | null {
  const b = blocks?.find((x) => x.kind === 'background-notice');
  return b && b.kind === 'background-notice' ? b : null;
}

/**
 * The chat's last word, past the background notices after it. A notice is a
 * service line written after a stop or a config change: read as the last
 * message it hid the cut turn under it, so neither «Retry» nor the interrupted
 * turn's banner came (second review of 25/09).
 */
export function lastConversationMessage<M extends { blocks?: ContentBlock[] | null }>(messages: readonly M[]): M | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!backgroundNoticeOf(messages[i].blocks)) return messages[i];
  }
  return undefined;
}
