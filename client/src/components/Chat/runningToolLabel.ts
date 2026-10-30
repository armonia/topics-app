import type { ChatMessage } from '../../types';
import type { ToolCall } from '../../../../shared/types';

const MAX_TOOL_LABEL = 60;

function labelOf(tc: ToolCall): string {
  const a = tc.args ?? {};
  const pick = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  const detail = pick('command') || pick('description') || pick('file_path') || pick('path') || pick('pattern') || pick('url');
  const text = detail ? `${tc.name} ${detail.replace(/\s+/g, ' ').trim()}` : tc.name;
  return text.length > MAX_TOOL_LABEL ? `${text.slice(0, MAX_TOOL_LABEL - 1)}…` : text;
}

/** The tool a live turn is running right now, as a short label, or null. */
export function runningToolLabel(msg: Pick<ChatMessage, 'blocks' | 'toolCalls'>): string | null {
  const calls: ToolCall[] = [];
  for (const b of msg.blocks ?? []) if (b.kind === 'tool') calls.push(b.toolCall);
  if (calls.length === 0) calls.push(...(msg.toolCalls ?? []));
  for (let i = calls.length - 1; i >= 0; i--) {
    const s = calls[i].status;
    if (s === 'running' || s === 'pending') return labelOf(calls[i]);
  }
  return null;
}
