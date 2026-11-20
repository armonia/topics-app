import type { ProviderUsage, StreamHandler, ToolArgs } from "./types";
import type { CodexProvider } from "./codex";

export interface RecordedHandler extends StreamHandler {
  text: { delta: string; full: string }[];
  tools: { type: "start" | "update" | "result"; id: string; payload: string | ToolArgs | undefined; error?: boolean }[];
  toolNames: { id: string; name: string }[];
  executing: string[];
  activity: string[];
  errors: string[];
  done: { usage?: ProviderUsage; result?: string }[];
  aborted: { usage?: ProviderUsage; result?: string }[];
  context: { tokens: number; model?: string; windowTokens?: number }[];
}

export function makeHandler(): RecordedHandler {
  const h = {
    text: [],
    tools: [],
    toolNames: [],
    executing: [],
    activity: [],
    errors: [],
    done: [],
    aborted: [],
    context: [],
  } as unknown as RecordedHandler;
  h.onContextSize = (tokens, model, windowTokens) => { h.context.push({ tokens, model, windowTokens }); };
  h.onTextDelta = (text, fullText) => { h.text.push({ delta: text, full: fullText }); };
  h.onToolStart = (id, name, args) => { h.toolNames.push({ id, name }); h.tools.push({ type: "start", id, payload: args }); };
  h.onToolExecStart = (id) => { h.executing.push(id); };
  h.onToolActivity = (id) => { h.activity.push(id); };
  h.onToolUpdate = (id, partial) => { h.tools.push({ type: "update", id, payload: partial }); };
  h.onToolResult = (id, result, error) => { h.tools.push({ type: "result", id, payload: result, ...(error ? { error } : {}) }); };
  h.onError = (err) => { h.errors.push(err); };
  h.onDone = (msg) => { h.done.push({ usage: msg?.usage, result: msg?.result }); };
  h.onAborted = (msg) => { h.aborted.push({ usage: msg?.usage, result: msg?.result }); };
  return h;
}

/**
 * Push an event through `routeCodexEvent` for a synthetic session. The
 * provider's session state needs to exist for tool tracking, so we seed it
 * via the same internal map. Using `as any` keeps the test focused on
 * behavior rather than re-exporting internals.
 */
export function pushEvent(
  provider: CodexProvider,
  sessionKey: string,
  event: Record<string, unknown>,
  handler: StreamHandler,
  fullText = "",
): string | null {
  const p = provider as unknown as {
    sessionState: Map<string, {
      aborted: boolean;
      usage?: ProviderUsage;
      startedAt: number;
      runningTools: Map<string, { toolCallId: string; partial: string }>;
    }>;
    routeCodexEvent: (sessionKey: string, event: Record<string, unknown>, handler: StreamHandler, fullText: string) => string | null;
  };
  if (!p.sessionState.has(sessionKey)) {
    p.sessionState.set(sessionKey, {
      aborted: false,
      startedAt: Date.now(),
      runningTools: new Map(),
    });
  }
  return p.routeCodexEvent(sessionKey, event, handler, fullText);
}
