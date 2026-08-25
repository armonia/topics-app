/**
 * `StreamHandler.onContextSize` — the per-call context measurement.
 *
 * Why it exists: the post-compaction size used to be read off the final
 * `result` usage, which the CLI reports as an AGGREGATE over every model call
 * in the turn. On the long turns that actually trigger a compaction that sum
 * dwarfs the real context, so the "context compacted" divider rendered things
 * like "167k → 11.2M token" — the context appearing to EXPLODE at the exact
 * moment it was cut down. Each `assistant` event instead carries the usage of
 * the ONE call that produced it, so `input + cache_read + cache_creation` there
 * is the honest size of the prompt the model just saw.
 * @covers USAGE-06
 */

import { describe, expect, test } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";
import { SidechainTracker } from "./claude/sidechain-tracker";

function makeProviderWithStubProcess(sessionKey: string) {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const pp: any = {
    proc: { stdin: { write() { return true; }, end() {} }, kill() {}, on() {}, stdout: { on() {} }, stderr: { on() {} } },
    readline: { on() {}, close() {} },
    io: { writeStdin: () => {}, signal: () => {}, kill: () => {} },
    ready: Promise.resolve(),
    sessionKey,
    consumedOffset: 0,
    stderrBuf: "",
    spawnMeta: { claudeSessionId: "test-session", isNewSession: false },
    createdAt: Date.now(),
    lastActivity: Date.now(),
    alive: true,
    streamHandler: null,
    pendingResolve: null,
    pendingReject: null,
    fullText: "",
    activeToolCalls: new Set(),
    inactivityTimer: null,
    lifetimeTimer: null,
    heartbeatInterval: null,
    subAgentEmit: new Map(),
    lastEventAt: Date.now(),
    needsHistoryReplay: false,
    sidechain: new SidechainTracker(),
    pendingInputs: new Map(),
  };
  (provider as any).processes.set(sessionKey, pp);
  return { provider, pp };
}

function makeHandler() {
  const sizes: number[] = [];
  return {
    sizes,
    handler: {
      onTextDelta: () => {},
      onToolStart: () => {},
      onToolResult: () => {},
      onContextSize: (n: number) => sizes.push(n),
      onDone: () => {},
      onError: () => {},
    },
  };
}

const emit = (provider: unknown, pp: unknown, event: unknown) =>
  (provider as any).handleStreamEvent(pp, event);

describe("claude-code · onContextSize", () => {
  test("assistant usage → input + cache_read + cache_creation (one call's prompt)", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:ctx1");
    const { handler, sizes } = makeHandler();
    pp.streamHandler = handler;

    // Shape taken verbatim from a real transcript's assistant row.
    emit(provider, pp, {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 1595,
          cache_read_input_tokens: 46718,
          output_tokens: 590,
        },
      },
    });

    expect(sizes).toEqual([48315]);
  });

  test("sub-agent (sidechain) calls are excluded — they carry their OWN context", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:ctx2");
    const { handler, sizes } = makeHandler();
    pp.streamHandler = handler;

    emit(provider, pp, {
      type: "assistant",
      parent_tool_use_id: "toolu_parent",
      message: {
        content: [{ type: "text", text: "child work" }],
        usage: { input_tokens: 10, cache_read_input_tokens: 5000, output_tokens: 3 },
      },
    });

    expect(sizes).toEqual([]);
  });

  test("no usage on the event → nothing reported (never guess a size)", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:ctx3");
    const { handler, sizes } = makeHandler();
    pp.streamHandler = handler;

    emit(provider, pp, { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });

    expect(sizes).toEqual([]);
  });

  test("each call reports separately — the caller latches the first one after a boundary", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:ctx4");
    const { handler, sizes } = makeHandler();
    pp.streamHandler = handler;

    const call = (read: number) => emit(provider, pp, {
      type: "assistant",
      message: { content: [{ type: "text", text: "." }], usage: { input_tokens: 1, cache_read_input_tokens: read } },
    });
    call(12_000);
    call(18_000);

    expect(sizes).toEqual([12_001, 18_001]);
  });
});
