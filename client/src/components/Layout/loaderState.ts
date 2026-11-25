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
import { classifyToolAction, type AgentAction } from '../../../../shared/agent-action';
import type { LoaderActivity } from './squareLoader';

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
 * The ink of the two outcomes (green done, red error), or '' for every other
 * shape. It follows the shape the body is really playing (`LoaderBody.shape`),
 * never the one asked for: a change waits for the one before it to settle, and
 * a green sign on the old shape would say the work was over while it still
 * moved. Those are only ever drawn where a surface already shows that outcome.
 */
export function loaderOutcomeInkClass(shape: string | null | undefined): string {
  if (shape === 'done') return 'text-green-500';
  if (shape === 'error') return 'text-red-500';
  return '';
}

/**
 * THE MAP FROM WHAT AN AGENT DOES TO THE SHAPE THE LOADER PLAYS. The loader's
 * shapes are approved and final (`squareLoader`), and eleven actions fold onto
 * six of them: reading and the web are a search, writing and editing write,
 * running a command, driving a browser, delegating and any other tool are a
 * tool, and think, wait and error keep their own shape.
 *
 * This is the ONLY place that knows the fold. Every surface goes through
 * `loaderActivityForAction` or `loaderActivityForTool`, and the menu-bar tray
 * reads the same table at build time (`scripts/gen-tray-loader-frames.ts`
 * writes it into `tray_loader_frames.rs`), so changing a line here and
 * regenerating moves the app and the tray together.
 */
const LOADER_FOR_ACTION: Record<AgentAction, LoaderActivity> = {
  think: 'think',
  write: 'write',
  read: 'search',
  edit: 'write',
  run: 'tool',
  web: 'search',
  browse: 'tool',
  delegate: 'tool',
  tool: 'tool',
  wait: 'wait',
  error: 'error',
};

export function loaderActivityForAction(action: AgentAction | undefined): LoaderActivity | undefined {
  return action ? LOADER_FOR_ACTION[action] : undefined;
}

/**
 * The movement a running tool call plays: an adapter on `classifyToolAction`,
 * the one classifier of tool names (MCP-prefixed or not).
 */
export function loaderActivityForTool(name: string, opts?: { command?: boolean }): LoaderActivity {
  return LOADER_FOR_ACTION[classifyToolAction(name, opts)];
}
