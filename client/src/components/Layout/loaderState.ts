/**
 * The three states of the loader glyph (`StreamingIndicator`), the one rule
 * that picks among them and the arc each one draws. Its own module because a
 * component file that also exports a function breaks Vite's fast refresh.
 *
 *   - working:    the blue arc turns. A turn is answering; a message would queue.
 *   - waiting:    the amber arc stands still. The open turn waits for you.
 *   - background: the grey arc turns slowly. No turn is open, the chat is free,
 *                 and work its last turn left running goes on by itself.
 */
import { ON_FILL_TEXT_SOFT } from '../../lib/selectionStyles';

export type LoaderState = 'working' | 'waiting' | 'background';

/**
 * Which glyph a row, a tab or a folder draws, or null for none. On one surface
 * waiting > working > background: what asks for you first, then what answers.
 */
export function loaderStateFor({ loading, waiting, background }: {
  loading: boolean;
  waiting: boolean;
  background: boolean;
}): LoaderState | null {
  if (!loading && !background) return null;
  if (waiting) return 'waiting';
  return loading ? 'working' : 'background';
}

/**
 * The arc of each state. THE WAIT: the same arc, frozen and amber. A turn
 * parked on a question is open and NOT grinding, and a turning arc would credit
 * it with work it is not doing. The amber is the tint of the 'input' tier
 * (TIER_INPUT_BG in selectionStyles): where the fill says "your move", the glyph
 * says the same. Frozen is not off, so it breathes slowly.
 *
 * THE BACKGROUND: grey and slow. No turn is open, so it cannot be the blue of a
 * reply (that one says a message would queue), and nothing waits for you, so it
 * cannot be the amber. It still turns, because the work it stands for does.
 */
const ARC: Record<LoaderState, string> = {
  working: 'animate-orbit-spin text-[var(--primary)]',
  waiting: 'animate-orbit-breath text-amber-500',
  background: 'animate-orbit-slow text-app-text-tertiary',
};

/**
 * The arc's classes. ON AN ATTENTION FILL the grey arc takes the fill's own
 * soft ink, as the timestamp it replaces in the same slot does: a turn that
 * closes with work left running is exactly the one that lands on the blue
 * 'done' fill, where the tertiary grey is about 1.3:1 and the glyph vanishes.
 */
export function loaderArcClass(state: LoaderState, onFill = false): string {
  return onFill && state === 'background' ? `animate-orbit-slow ${ON_FILL_TEXT_SOFT}` : ARC[state];
}
