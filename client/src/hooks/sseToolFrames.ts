// The tool frames of the window's own reply (SSE), read into the same ToolCall
// the WS frames build in every other window (CHAT-TOOL-10).
//
// The window that sent the message reads only its SSE while the reply is open:
// it drops the session's `stream:tool_call` / `stream:tool_result` WS frames
// (`senderAlsoSees.ts`). It used to keep only the id, the name, the args and
// the status, so its row had no clock while running, no duration once over and
// a red X with no reason, while a second window watching the same turn showed
// all three. The server now writes the same fields on both transports, and this
// is where the SSE side reads them.

import type { ToolCall } from '../types';

/** One entry of `delta.tool_calls`, as `server/routes/chat.ts` writes it. */
export interface SseToolCallDelta {
  id?: string;
  function?: { name?: string; arguments?: string };
  contentOffset?: number;
  status?: ToolCall['status'];
  startedAt?: number;
  detail?: ToolCall['detail'];
}

/** `delta.tool_result`, as `server/routes/chat.ts` writes it. */
export interface SseToolResultDelta {
  id?: string;
  status?: ToolCall['status'];
  result?: string;
  error?: string;
  detail?: ToolCall['detail'];
  endedAt?: number;
}

/** The row a `tool_calls` entry announces, or null when it names no tool. */
export function toolCallFromSse(tc: SseToolCallDelta, newId: () => string): ToolCall | null {
  const name = tc.function?.name;
  if (!name) return null;
  return {
    id: tc.id || newId(),
    name,
    args: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
    status: tc.status ?? 'running',
    contentOffset: tc.contentOffset,
    ...(typeof tc.startedAt === 'number' ? { startedAt: tc.startedAt } : {}),
    ...(tc.detail ? { detail: tc.detail } : {}),
  };
}

/** The row once its `tool_result` arrived: a new object, so `React.memo` sees the change. Same rules as the WS `stream:tool_result`. */
export function withSseToolResult(old: ToolCall, r: SseToolResultDelta): ToolCall {
  return {
    ...old,
    status: r.status || 'success',
    result: r.result,
    error: r.error ?? old.error,
    detail: r.detail ?? old.detail,
    endedAt: typeof r.endedAt === 'number' ? r.endedAt : old.endedAt,
  };
}
