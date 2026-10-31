/**
 * The two states of the loader glyph (`StreamingIndicator`), the one rule
 * that picks between them and the arc each one draws. Its own module because a
 * component file that also exports a function breaks Vite's fast refresh.
 *
 *   - working: the blue arc turns. Work is in progress: a turn answering, or
 *              a job a closed turn left running (the chat is still free).
 *   - waiting: the amber arc stands still. The open turn waits for you.
 *
 * There was a third, grey and slow, for the job a closed turn left running.
 * Since 2026-10-04 that is work in progress like any other: one ring.
 */
import { ON_FILL_TEXT_SOFT } from '../../lib/selectionStyles';

export type LoaderState = 'working' | 'waiting';

/**
 * Which glyph a row, a tab or a folder draws, or null for none. What asks for
 * you first, then what works.
 */
export function loaderStateFor({ inProgress, waiting }: {
  inProgress: boolean;
  waiting: boolean;
}): LoaderState | null {
  if (!inProgress) return null;
  return waiting ? 'waiting' : 'working';
}

/**
 * The arc of each state. THE WAIT: the same arc, frozen and amber. A turn
 * parked on a question is open and NOT grinding, and a turning arc would credit
 * it with work it is not doing. The amber is the tint of the 'input' tier
 * (TIER_INPUT_BG in selectionStyles): where the fill says "your move", the glyph
 * says the same. The wait movement pulses its ring slowly.
 */
const ARC: Record<LoaderState, string> = {
  working: 'text-[var(--primary)]',
  waiting: 'text-amber-500',
};

/**
 * The arc's classes. ON AN ATTENTION FILL the working arc takes the fill's own
 * soft ink, as the timestamp it replaces in the same slot does: a folder whose
 * child finished (blue fill) while another one works would otherwise draw a
 * blue arc on blue, about 1.3:1, and the glyph vanishes.
 */
export function loaderArcClass(state: LoaderState, onFill = false): string {
  return onFill && state === 'working' ? ON_FILL_TEXT_SOFT : ARC[state];
}

/**
 * The ink of a loader: the state's arc, except for the two outcomes, which
 * carry their own colour (green done, red error). Those are only ever drawn
 * where a surface already shows that outcome.
 */
export function loaderInkClass(state: LoaderState, onFill = false, activity?: string): string {
  if (activity === 'done') return 'text-green-500';
  if (activity === 'error') return 'text-red-500';
  return loaderArcClass(state, onFill);
}

/**
 * The movement a running tool call plays: looking things up, writing files, or
 * the generic tool movement. Matches on the bare tool name, MCP-prefixed or not.
 */
export function loaderActivityForTool(name: string): 'search' | 'write' | 'tool' {
  const bare = (name.split('__').pop() ?? name).toLowerCase();
  if (bare === 'grep' || bare === 'glob' || bare === 'websearch' || bare === 'web_search') return 'search';
  if (bare === 'edit' || bare === 'write' || bare === 'multiedit' || bare === 'notebookedit') return 'write';
  return 'tool';
}
