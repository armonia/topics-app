import { stripMarkdown } from '../../lib/stripMarkdown';
import type { LiveTool } from './constants';

/**
 * The one line a card in progress prints under its title, and nothing more.
 *
 * It is the step of the tool that is running (`name · input`), or else the
 * first line of the agent's last word. Never the whole text: the full word is
 * in the thread. A retry wait or a card that is not working prints no step,
 * and the machine's note never becomes the line: it stays folded under the show toggle.
 */
export function cardProgressLine({ lastTool, retry, working, showsQuestion, bodyText }: {
  lastTool: LiveTool | null | undefined;
  retry: unknown;
  working: boolean;
  showsQuestion: boolean;
  /** The agent's word the body shows, already past the machine-note check. */
  bodyText: string | null | undefined;
}): string {
  if (lastTool && !retry && working) {
    return `${lastTool.name}${lastTool.input ? ` · ${lastTool.input}` : ''}`;
  }
  if (showsQuestion && bodyText) {
    return (stripMarkdown(bodyText).split('\n').find((l) => l.trim()) ?? '').trim();
  }
  return '';
}
