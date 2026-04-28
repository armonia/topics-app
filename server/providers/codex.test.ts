/**
 * Slice 10 unit tests — Codex event parsing.
 *
 * Focus: the two pure helpers exported alongside `CodexProvider`. Spawning
 * the real CLI in tests would need an authenticated session and a
 * deterministic upstream, neither of which is achievable here. The helpers
 * are where the real complexity lives anyway (multi-shape usage payloads
 * and double-encoded error messages).
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
}

function makeHandler(): RecordedHandler {
  const h = {
    text: [],
    tools: [],
    errors: [],
    done: [],
    aborted: [],
  } as unknown as RecordedHandler;
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
