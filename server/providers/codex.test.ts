/**
 * Slice 10 unit tests — Codex event parsing.
 *
 * Focus: the two pure helpers exported alongside `CodexProvider`. Spawning
 * the real CLI in tests would need an authenticated session and a
 * deterministic upstream, neither of which is achievable here. The helpers
 * are where the real complexity lives anyway (multi-shape usage payloads
 * and double-encoded error messages).
  * @covers CODEX-01
 */

import { describe, expect, test } from "bun:test";
import { CodexProvider, extractCodexErrorMessage, extractCodexUsage } from "./codex";
import type { ProviderUsage, StreamHandler, ToolArgs } from "./types";

interface RecordedHandler extends StreamHandler {
  text: { delta: string; full: string }[];
  tools: { type: "start" | "update" | "result"; id: string; payload: string | ToolArgs | undefined }[];
  errors: string[];
  done: { usage?: ProviderUsage; result?: string }[];
  aborted: { usage?: ProviderUsage; result?: string }[];
  context: { tokens: number; model?: string; windowTokens?: number }[];
}

function makeHandler(): RecordedHandler {
  const h = {
    text: [],
    tools: [],
    errors: [],
    done: [],
    aborted: [],
    context: [],
  } as unknown as RecordedHandler;
  h.onContextSize = (tokens, model, windowTokens) => { h.context.push({ tokens, model, windowTokens }); };
  h.onTextDelta = (text, fullText) => { h.text.push({ delta: text, full: fullText }); };
  h.onToolStart = (id, _name, args) => { h.tools.push({ type: "start", id, payload: args }); };
  h.onToolUpdate = (id, partial) => { h.tools.push({ type: "update", id, payload: partial }); };
  h.onToolResult = (id, result) => { h.tools.push({ type: "result", id, payload: result }); };
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
function pushEvent(
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

describe("extractCodexUsage", () => {
  test("returns null when no usage fields are present", () => {
    expect(extractCodexUsage({})).toBeNull();
    expect(extractCodexUsage({ usage: null })).toBeNull();
    expect(extractCodexUsage({ usage: { foo: 1 } })).toBeNull();
  });

  test("normalizes the snake_case CLI shape", () => {
    const u = extractCodexUsage({
      type: "turn.completed",
      usage: {
        input_tokens: 120,
        output_tokens: 480,
        reasoning_tokens: 32,
        cache_read_input_tokens: 64,
      },
    });
    expect(u).toEqual({
      inputTokens: 120,
      outputTokens: 480,
      reasoningTokens: 32,
      cacheRead: 64,
    });
  });

  test("accepts the CLI 0.131 field names (reasoning_output_tokens / cached_input_tokens)", () => {
    // Real payload from `codex exec --json` on codex-cli 0.131.0-alpha.9.
    const u = extractCodexUsage({
      type: "turn.completed",
      usage: {
        input_tokens: 14521,
        cached_input_tokens: 7552,
        output_tokens: 27,
        reasoning_output_tokens: 19,
      },
    });
    expect(u).toEqual({
      inputTokens: 14521,
      outputTokens: 27,
      reasoningTokens: 19,
      cacheRead: 7552,
    });
  });

  test("falls back to camelCase / OpenAI-style aliases", () => {
    expect(extractCodexUsage({ usage: { prompt_tokens: 10, completion_tokens: 22 } })).toEqual({
      inputTokens: 10,
      outputTokens: 22,
    });
    expect(extractCodexUsage({ usage: { inputTokens: 10, outputTokens: 22, cacheCreation: 5 } })).toEqual({
      inputTokens: 10,
      outputTokens: 22,
      cacheCreation: 5,
    });
  });

  test("looks under response.usage and item.usage when top-level is missing", () => {
    expect(extractCodexUsage({ response: { usage: { input_tokens: 7, output_tokens: 9 } } })).toEqual({
      inputTokens: 7,
      outputTokens: 9,
    });
    expect(extractCodexUsage({ item: { usage: { prompt_tokens: 3, completion_tokens: 4 } } })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
    });
  });

  test("rejects negative or non-finite token counts", () => {
    expect(extractCodexUsage({ usage: { input_tokens: -1, output_tokens: 5 } })).toEqual({
      outputTokens: 5,
    });
    expect(extractCodexUsage({ usage: { input_tokens: NaN } })).toBeNull();
  });
});

describe("extractCodexErrorMessage", () => {
  test("returns a default when no message fields are present", () => {
    expect(extractCodexErrorMessage({})).toBe("Codex error");
  });

  test("prefers error.message over message", () => {
    expect(extractCodexErrorMessage({ error: { message: "rate limited" }, message: "fallback" }))
      .toBe("rate limited");
  });

  test("decodes a single layer of JSON-encoded error", () => {
    const inner = JSON.stringify({ error: { message: "unauthorized" } });
    expect(extractCodexErrorMessage({ error: { message: inner } })).toBe("unauthorized");
  });

  test("decodes two layers of JSON-encoded error", () => {
    const innermost = JSON.stringify({ error: { message: "context too long" } });
    const wrapped = JSON.stringify({ message: innermost });
    expect(extractCodexErrorMessage({ error: { message: wrapped } })).toBe("context too long");
  });

  test("stops decoding when it hits a non-JSON string", () => {
    expect(extractCodexErrorMessage({ error: { message: "plain failure" } })).toBe("plain failure");
  });

  test("stops decoding when JSON has no message-like field", () => {
    const meaningless = JSON.stringify({ foo: 1, bar: 2 });
    expect(extractCodexErrorMessage({ error: { message: meaningless } })).toBe(meaningless);
  });

  test("handles non-string message by JSON-stringifying once", () => {
    expect(extractCodexErrorMessage({ error: { message: { code: 500 } } })).toBe('{"code":500}');
  });

  test("falls back to event.message when error.message is missing", () => {
    expect(extractCodexErrorMessage({ message: "top-level only" })).toBe("top-level only");
  });
});

describe("routeCodexEvent — text + tool wiring", () => {
  test("item.completed agent_message surfaces text via onTextDelta and returns it", () => {
    const provider = new CodexProvider({ type: "codex" });
    const h = makeHandler();
    const surfaced = pushEvent(provider, "s1", {
      type: "item.completed",
      item: { type: "agent_message", text: "Hello world" },
    }, h);
    expect(surfaced).toBe("Hello world");
    expect(h.text).toEqual([{ delta: "Hello world", full: "Hello world" }]);
  });

  test("item.started + item.updated + item.completed for command_execution emit start/update/result with running output preserved", () => {
    const provider = new CodexProvider({ type: "codex" });
    const h = makeHandler();
    pushEvent(provider, "s1", {
      type: "item.started",
      item: { type: "command_execution", id: "cmd-1", name: "Bash", command: "ls", arguments: { dir: "." } },
    }, h);
    pushEvent(provider, "s1", {
      type: "item.updated",
      item: { type: "command_execution", id: "cmd-1", aggregated_output: "file1.txt\n" },
    }, h);
    pushEvent(provider, "s1", {
      type: "item.updated",
      item: { type: "command_execution", id: "cmd-1", aggregated_output: "file1.txt\nfile2.txt\n" },
    }, h);
    pushEvent(provider, "s1", {
      type: "item.completed",
      item: { type: "command_execution", id: "cmd-1" }, // no `output` — should fall back to last partial
    }, h);

    expect(h.tools).toEqual([
      { type: "start", id: "cmd-1", payload: { dir: "." } },
      { type: "update", id: "cmd-1", payload: "file1.txt\n" },
      { type: "update", id: "cmd-1", payload: "file1.txt\nfile2.txt\n" },
      { type: "result", id: "cmd-1", payload: "file1.txt\nfile2.txt\n" },
    ]);
  });

  test("flat exec_command_output_delta accumulates partial output by command_id", () => {
    const provider = new CodexProvider({ type: "codex" });
    const h = makeHandler();
    pushEvent(provider, "s1", {
      type: "tool_call",
      id: "cmd-2",
      name: "Bash",
      arguments: { cmd: "echo hi" },
    }, h);
    pushEvent(provider, "s1", {
      type: "exec_command_output_delta",
      command_id: "cmd-2",
      data: "hi",
    }, h);
    pushEvent(provider, "s1", {
      type: "exec_command_output_delta",
      command_id: "cmd-2",
      data: "\n",
    }, h);
    pushEvent(provider, "s1", {
      type: "tool_result",
      id: "cmd-2",
      output: "hi\n",
    }, h);

    expect(h.tools.map((e) => e.type)).toEqual(["start", "update", "update", "result"]);
    // Updates carry the cumulative buffer.
    expect(h.tools[1].payload).toBe("hi");
    expect(h.tools[2].payload).toBe("hi\n");
    expect(h.tools[3].payload).toBe("hi\n");
  });

  test("turn.completed stashes usage on the session state", () => {
    const provider = new CodexProvider({ type: "codex" });
    const h = makeHandler();
    pushEvent(provider, "s1", {
      type: "turn.completed",
      usage: { input_tokens: 50, output_tokens: 200 },
    }, h);
    const state = (provider as unknown as { sessionState: Map<string, { usage?: ProviderUsage }> })
      .sessionState.get("s1");
    expect(state?.usage).toEqual({ inputTokens: 50, outputTokens: 200 });
  });

  test("turn.failed routes through extractCodexErrorMessage and calls onError", () => {
    const provider = new CodexProvider({ type: "codex" });
    const h = makeHandler();
    pushEvent(provider, "s1", {
      type: "turn.failed",
      error: { message: JSON.stringify({ error: { message: "context too long" } }) },
    }, h);
    expect(h.errors).toEqual(["context too long"]);
  });

  test("unknown event types are ignored", () => {
    const provider = new CodexProvider({ type: "codex" });
    const h = makeHandler();
    const out = pushEvent(provider, "s1", { type: "future.unknown.event", foo: 42 }, h);
    expect(out).toBeNull();
    expect(h.text).toHaveLength(0);
    expect(h.tools).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
  });
});

/**
 * 3.1 — il ring del contesto vale anche per un provider non-Claude.
 *
 * Fino a qui Codex i token li aveva in mano (footer di fine turno) e il
 * cerchietto restava vuoto per tutta la sessione: un payload standard che
 * riempie un provider solo non è uno standard.
 */
describe("token_count → onContextSize (contesto vivo, 3.1)", () => {
  const tokenCount = (over?: Record<string, unknown>) => ({
    type: "token_count",
    info: {
      total_token_usage: { input_tokens: 900_000, cached_input_tokens: 100_000, output_tokens: 50_000 },
      last_token_usage: { input_tokens: 8_000, cached_input_tokens: 128_000, output_tokens: 300 },
      model_context_window: 272_000,
      ...over,
    },
  });

  test("legge last_token_usage, MAI il totale del turno", () => {
    const provider = new CodexProvider({ type: "codex" });
    const h = makeHandler();
    pushEvent(provider, "s1", tokenCount(), h);
    // 8_000 + 128_000 di cache. Il totale (1M) è la somma di tutte le
    // chiamate del turno: leggerlo qui dichiarerebbe un contesto esploso.
    expect(h.context).toEqual([{ tokens: 136_000, model: undefined, windowTokens: 272_000 }]);
  });

  test("l'output non entra nel contesto", () => {
    const provider = new CodexProvider({ type: "codex" });
    const h = makeHandler();
    pushEvent(provider, "s1", tokenCount({
      last_token_usage: { input_tokens: 1_000, output_tokens: 999_000 },
    }), h);
    expect(h.context[0]!.tokens).toBe(1_000);
  });

  test("senza finestra dichiarata passa undefined: il denominatore lo sceglie chi costruisce l'update", () => {
    const provider = new CodexProvider({ type: "codex" });
    const h = makeHandler();
    pushEvent(provider, "s1", tokenCount({ model_context_window: undefined }), h);
    expect(h.context[0]!.windowTokens).toBeUndefined();
    expect(h.context[0]!.tokens).toBe(136_000);
  });

  test("etichetta il ring col modello del turno, quando è esplicito", () => {
    const provider = new CodexProvider({ type: "codex" });
    const h = makeHandler();
    const p = provider as unknown as { sessionState: Map<string, Record<string, unknown>> };
    pushEvent(provider, "s1", { type: "future.noop" }, h); // semina lo stato
    p.sessionState.get("s1")!.model = "gpt-5-codex";
    pushEvent(provider, "s1", tokenCount(), h);
    expect(h.context[0]!.model).toBe("gpt-5-codex");
  });

  test("un token_count senza last_token_usage non emette niente", () => {
    const provider = new CodexProvider({ type: "codex" });
    const h = makeHandler();
    pushEvent(provider, "s1", { type: "token_count", info: { model_context_window: 272_000 } }, h);
    pushEvent(provider, "s1", { type: "token_count" }, h);
    expect(h.context).toHaveLength(0);
  });

  test("un last_token_usage a zero non accende un ring vuoto", () => {
    const provider = new CodexProvider({ type: "codex" });
    const h = makeHandler();
    pushEvent(provider, "s1", tokenCount({
      last_token_usage: { input_tokens: 0, output_tokens: 12 },
    }), h);
    expect(h.context).toHaveLength(0);
  });

  test("accetta anche le varianti camelCase del wrapper", () => {
    const provider = new CodexProvider({ type: "codex" });
    const h = makeHandler();
    pushEvent(provider, "s1", {
      type: "token_count",
      info: {
        lastTokenUsage: { inputTokens: 2_000, cacheRead: 1_000 },
        modelContextWindow: 400_000,
      },
    }, h);
    expect(h.context).toEqual([{ tokens: 3_000, model: undefined, windowTokens: 400_000 }]);
  });

  test("turn.completed NON accende il ring: la sua usage è un aggregato di turno", () => {
    const provider = new CodexProvider({ type: "codex" });
    const h = makeHandler();
    pushEvent(provider, "s1", {
      type: "turn.completed",
      usage: { input_tokens: 900_000, output_tokens: 1_000 },
    }, h);
    expect(h.context).toHaveLength(0);
  });
});
