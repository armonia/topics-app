/**
 * Whether a code block may offer Run, and for which reply (CHAT-RUN-01).
 *
 * A context and not a prop: `markdownComponents` (MessageContent.tsx) is a
 * module constant that `ChatMarkdown` memoizes on, and the file preview and
 * the editor import the same map. Only `MessageContent` provides it, and only
 * for a finished reply of the agent, to an owner, on a server with a shell:
 * everywhere else a code block finds null and stays as it was.
 */
import { createContext } from 'react';

export interface CommandRunTarget {
  sessionKey: string;
  messageId: string;
  /** Which text segment of the reply the block is in: a reply's timeline has many, each parsed on its own. */
  segment: number;
}

export const CommandRunContext = createContext<CommandRunTarget | null>(null);

/**
 * The key of a code block inside its reply: its text segment and its offset in
 * that segment's markdown, the position react-markdown gives every node.
 * Stable as long as the text does not change, and the client binds a run to a
 * block only if its command is still the block's text.
 */
export function commandBlockKey(segment: number, offset: number): number {
  return segment * 0x1000000 + offset;
}
