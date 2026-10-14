/**
 * Which tool calls are generative views (GENUI-01), and what they show.
 *
 * Like `browserOpens.ts` for pages: a SUCCESSFUL `show_view` leaves the tool
 * run and is drawn as a block that stays in sight. A running call is still a
 * tool row (it may fail), and a failed one stays a row with its error, which
 * is what the agent read to retry. Pure, so the rule is tested without a DOM.
 */
import type { ToolCall } from '../../types';
import { viewIdFromResult, type ViewSpec } from '../../../../shared/views';
import { resolveToolDetail } from './toolDetail';

export interface ViewOpen {
  spec: ViewSpec;
  viewId?: string;
}

export function viewOf(tc: ToolCall): ViewOpen | null {
  if (tc.status !== 'success') return null;
  const detail = resolveToolDetail(tc);
  if (detail.type !== 'view') return null;
  // The id is in the result; a detail built at tool START does not have it.
  const viewId = detail.viewId ?? viewIdFromResult(tc.result);
  return { spec: detail.view, ...(viewId ? { viewId } : {}) };
}

const VIEW_TOOL = /(^|__)show_view$/;

/**
 * Whether a message draws a view. The assistant row shrinks to its content
 * (`MessageBubble`), and a view sizes itself to its CONTAINER: without a width
 * of its own the row collapsed to the width of the reply's prose and the cards
 * became a strip in a 330 px column on a desktop.
 */
export function messageHasView(
  blocks: ReadonlyArray<{ kind: string; toolCall?: ToolCall }> | undefined,
  toolCalls: readonly ToolCall[] | undefined,
): boolean {
  const calls = [...(blocks ?? []).flatMap((b) => (b.kind === 'tool' && b.toolCall ? [b.toolCall] : [])), ...(toolCalls ?? [])];
  return calls.some((tc) => VIEW_TOOL.test(tc.name) && tc.status === 'success');
}
