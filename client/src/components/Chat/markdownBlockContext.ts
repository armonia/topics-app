import { createContext } from 'react';

/**
 * Where the markdown block being drawn sits in its message.
 *
 * A long message is drawn as several `<ReactMarkdown>` blocks (see
 * `lib/markdownBlocks.ts`), and each block is parsed on its own: the position a
 * code fence reports is relative to the block, while the key of its Run button
 * is the position in the whole message (CHAT-RUN-03).
 */
export interface MarkdownBlockPlace {
  /** Characters of the message that come before this block. */
  offset: number;
  /**
   * Offset, inside this block, of the code fence still being written, or null
   * when no code block here is open. Only the tail block of a streaming
   * message has one.
   */
  openFenceFrom: number | null;
}

export const WHOLE_MESSAGE: MarkdownBlockPlace = { offset: 0, openFenceFrom: null };

export const MarkdownBlockContext = createContext<MarkdownBlockPlace>(WHOLE_MESSAGE);
