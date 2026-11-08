/**
 * The OpenAI wire, with nobody's key in it.
 *
 * Everything here used to be private to `OpenAIProvider`: the SSE reader and
 * the shape of a chat-completions request. It moved out the day a second
 * speaker of the same protocol appeared (a llama-server on a desk, a gateway on
 * a tailnet), because the alternative was a second copy of a stream parser that
 * took three bug reports to get right: fragmented UTF-8, a `data:` line split
 * across two chunks, tool arguments arriving one character at a time.
 *
 * Nothing in this module knows what an endpoint is, nor holds a credential: it
 * takes a body and a stream and gives back events.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Token counts as the API reports them, when it reports them at all. */
export interface WireUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatCompletionBodyInput {
  model: string;
  messages: { role: string; content: string }[];
  maxTokens: number;
  stream: boolean;
  /** Already in OpenAI function-calling shape. */
  tools?: unknown[];
  /** Ask the stream for a final usage event. Some gateways reject the field. */
  includeUsage?: boolean;
  /** Older servers only understand `max_tokens`. */
  legacyMaxTokensField?: boolean;
}

/** Assemble the request body both the built-in provider and configured
 *  endpoints send, so one field never drifts between the two. */
export function buildChatCompletionBody(input: ChatCompletionBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    [input.legacyMaxTokensField ? "max_tokens" : "max_completion_tokens"]: input.maxTokens,
  };
  if (input.stream) {
    body.stream = true;
    if (input.includeUsage) body.stream_options = { include_usage: true };
  }
  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools;
    body.tool_choice = "auto";
  }
  return body;
}

export interface SseCallbacks {
  onDelta: (text: string) => void;
  onToolStart?: (toolCallId: string, name: string, args: Record<string, unknown>) => void;
  onUsage?: (usage: WireUsage) => void;
}

/** How this transport words an upstream failure. The label is the service the
 *  user configured, so an error names the thing they can go and fix. */
export interface WireErrorVoice {
  invalidKey: string;
  rateLimited: string;
  generic: string;
  incomplete: string;
  truncated: string;
}

function usageFrom(event: Record<string, unknown>): WireUsage | undefined {
  const usage = asRecord(event.usage);
  if (!usage) return undefined;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  return prompt || completion ? { promptTokens: prompt, completionTokens: completion } : undefined;
}

/**
 * Read a chat-completions SSE stream to its end.
 *
 * Two properties this function exists to hold: a multi-byte character split
 * across two network chunks is delivered once and whole, and a tool call whose
 * arguments arrive in pieces is emitted once, complete, and only after the
 * choice says it finished.
 */
export async function consumeChatCompletionStream(
  body: ReadableStream<Uint8Array>,
  callbacks: SseCallbacks,
  voice: WireErrorVoice,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventData: string[] = [];
  let done = false;
  let finished = false;
  const toolCalls: Record<number, { id: string; name: string; args: string }> = {};
  const emittedTools = new Set<number>();

  const dispatch = () => {
    if (!eventData.length) return;
    const payload = eventData.join("\n");
    eventData = [];
    if (payload === "[DONE]") { done = true; return; }
    let decoded: unknown;
    try { decoded = JSON.parse(payload); }
    catch { throw new Error(voice.incomplete); }
    const event = asRecord(decoded);
    if (event?.error) {
      const error = asRecord(event.error);
      const code = error?.code ?? error?.type;
      throw new Error(
        code === "invalid_api_key" ? voice.invalidKey
          : code === "rate_limit_exceeded" || code === "insufficient_quota" ? voice.rateLimited
            : voice.generic,
      );
    }
    if (event) {
      const usage = usageFrom(event);
      if (usage && callbacks.onUsage) callbacks.onUsage(usage);
    }
    const choice = Array.isArray(event?.choices) ? asRecord(event.choices[0]) : undefined;
    const delta = asRecord(choice?.delta);
    for (const text of [delta?.content, delta?.refusal]) {
      if (typeof text === "string" && text.length > 0) callbacks.onDelta(text);
    }
    if (Array.isArray(delta?.tool_calls) && callbacks.onToolStart) {
      for (const value of delta.tool_calls) {
        const call = asRecord(value);
        if (!call || typeof call.index !== "number" || !Number.isInteger(call.index) || call.index < 0) continue;
        const current = toolCalls[call.index] ??= { id: "", name: "", args: "" };
        const fn = asRecord(call.function);
        if (typeof call.id === "string") current.id = call.id;
        if (typeof fn?.name === "string") current.name += fn.name;
        if (typeof fn?.arguments === "string") current.args += fn.arguments;
      }
    }
    if (typeof choice?.finish_reason === "string") {
      finished = true;
      if (choice.finish_reason === "tool_calls" && callbacks.onToolStart) {
        for (const [index, call] of Object.entries(toolCalls)) {
          const key = Number(index);
          if (emittedTools.has(key)) continue;
          let args: Record<string, unknown> | undefined;
          try { args = call.args ? asRecord(JSON.parse(call.args)) : {}; }
          catch { /* Report incomplete arguments instead of executing a broken call. */ }
          if (!call.id || !call.name || !args) throw new Error(voice.incomplete);
          emittedTools.add(key);
          callbacks.onToolStart(call.id, call.name, args);
        }
      }
    }
  };

  const line = (value: string) => {
    const text = value.endsWith("\r") ? value.slice(0, -1) : value;
    if (!text) dispatch();
    else if (text.startsWith("data:")) eventData.push(text.slice(5).replace(/^ /, ""));
  };

  try {
    while (!done) {
      const { done: ended, value } = await reader.read();
      if (ended) {
        buffer += decoder.decode();
        if (buffer) line(buffer);
        dispatch();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const entry of lines) {
        line(entry);
        if (done) break;
      }
    }
    if (!done && !finished) throw new Error(voice.truncated);
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/** The non-streaming answer, reduced to the two things callers read. */
export function readCompletionPayload(data: unknown): { content: string; usage?: WireUsage } {
  const record = asRecord(data);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const message = asRecord(asRecord(choices[0])?.message);
  const content = typeof message?.content === "string" ? message.content : "";
  return { content, usage: record ? usageFrom(record) : undefined };
}
