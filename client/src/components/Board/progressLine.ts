import { stripMarkdown } from '../../lib/stripMarkdown';
import { RESERVED_AUTHORS } from '../../../../shared/comment-author';

/** The card's progress row is ONE line: the first non-empty line of the agent's
 *  last word, as plain text. The full word stays in the tooltip and the thread. */
export function progressLine(content: string): string {
  return stripMarkdown(content).split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
}

/** A machine note (system, dispatcher, verifier) is never the card's progress:
 *  it is folded under a disclosure toggle. The user is not a machine, and neither is the agent. */
export function isSystemNote(author: string | null | undefined): boolean {
  return !!author && author !== 'user' && (RESERVED_AUTHORS as readonly string[]).includes(author);
}
