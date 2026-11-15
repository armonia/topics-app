

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * A server→client message with no id: nothing comes back and nothing is waiting
 * for it. Used for `notifications/progress`, which is the ONLY thing that keeps
 * a long tool call alive — see `emitProgress`.
 */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export function send(msg: JsonRpcResponse | JsonRpcNotification): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

/**
 * Build a `notifications/progress` frame for a tool call the client asked to be
 * kept informed about (`params._meta.progressToken`).
 *
 * WHY this exists — the third clock over `ask_user_question`. The panel already
 * survives the socket (short poll legs) and the server's stale-stream sweeper
 * (the ask exemption). The one left was the MCP CLIENT's own patience: Claude
 * Code times a tool call out after 30 minutes of hearing NOTHING, and killed a
 * live question with "no response and no progress for 1800s". Its own wording is
 * the fix — the timer resets on progress. So every poll leg says "still here",
 * and the panel lives to the ask's real TTL instead of an unrelated 30-minute
 * cap.
 *
 * `total` is deliberately omitted: we are not 40% of the way to a human
 * answering. Indeterminate progress is the honest shape, and the spec allows it.
 */
export function progressNotification(
  progressToken: string | number,
  progress: number,
  message?: string,
): JsonRpcNotification {
  return {
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken, progress, ...(message ? { message } : {}) },
  };
}

/** The client's progress token for this request, if it asked for progress. */
export function progressTokenOf(params: Record<string, unknown> | undefined): string | number | undefined {
  const meta = (params as { _meta?: { progressToken?: unknown } } | undefined)?._meta;
  const token = meta?.progressToken;
  return typeof token === "string" || typeof token === "number" ? token : undefined;
}

export function error(id: number | string | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}
