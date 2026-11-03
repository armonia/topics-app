import { stripMarkdown } from './stripMarkdown';

/**
 * The one line a card in progress shows under its title: the last sentence the
 * agent wrote, flattened to plain text. Only the last sentence fits in a row;
 * the whole word stays in the thread and in the drawer.
 */
export function progressSentence(content: string): string {
  const flat = stripMarkdown(content).replace(/\s+/g, ' ').trim();
  const sentences = flat.split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences[sentences.length - 1] ?? '';
}
