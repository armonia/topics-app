/**
 * A real Claude CLI 2.1.316 stream, recorded and stripped of session data, run
 * through handleStreamEvent: the text arrives delta by delta and the final
 * assistant snapshot never repeats it; a tool command written quickly is sent
 * at most once per PARTIAL_ARGS_EMIT_MS (card cd66c3bd).
 * @covers CHAT-LIVE-TEXT-01
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeProvider } from "./claude-code";
import { SidechainTracker } from "./claude/sidechain-tracker";
import { PARTIAL_ARGS_EMIT_MS } from "./partial-tool-input";

const FIXTURE = join(import.meta.dir, "claude-code-wire.fixture.ndjson");
const noop = () => {};

function makeProvider() {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const pp: Record<string, unknown> = {
    proc: { stdin: { write: () => true, end: noop }, kill: noop, on: noop, stdout: { on: noop }, stderr: { on: noop } },
    readline: { on: noop, close: noop },
    io: { writeStdin: () => true, signal: noop, kill: noop },
    ready: Promise.resolve(),
    sessionKey: "topic:wire",
    consumedOffset: 0,
    stderrBuf: "",
    spawnMeta: { claudeSessionId: "s", isNewSession: false },
    createdAt: Date.now(),
    lastActivity: Date.now(),
    alive: true,
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
  (provider as unknown as { processes: Map<string, unknown> }).processes.set("topic:wire", pp);
  const feed = (event: unknown) =>
    (provider as unknown as { handleStreamEvent: (p: unknown, e: unknown) => void }).handleStreamEvent(pp, event);
  return { pp, feed };
}

function handler(over: Record<string, unknown>) {
  return {
    onTextDelta: noop,
    onToolStart: noop,
    onToolActivity: noop,
    onToolArgsUpdate: noop,
    onToolResult: noop,
    onDone: noop,
    onError: noop,
    ...over,
  };
}

describe("real CLI stream through handleStreamEvent", () => {
  test("text is streamed delta by delta and the snapshot never doubles it", () => {
    const { pp, feed } = makeProvider();
    const got: string[] = [];
    pp.streamHandler = handler({ onTextDelta: (t: string) => got.push(t) });
    let deltas = 0;
    const blocks: string[] = [];
    for (const line of readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean)) {
      const o = JSON.parse(line);
      if (o.type === "stream_event" && o.event?.delta?.type === "text_delta") deltas++;
      if (o.type === "assistant") for (const b of o.message.content) if (b.type === "text") blocks.push(b.text);
      feed(o);
    }
    expect(deltas).toBeGreaterThan(1);
    expect(got.length).toBe(deltas);
    expect(got.join("")).toBe(blocks.join(""));
  });
});

describe("tool command throttle", () => {
  test("a command written in many small pieces is sent at most once per interval", async () => {
    const { pp, feed } = makeProvider();
    const times: number[] = [];
    pp.streamHandler = handler({ onToolArgsUpdate: () => times.push(Date.now()) });
    const se = (event: unknown) => ({ type: "stream_event", event });
    feed(se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_w", name: "Bash", input: {} } }));
    const json = '{"command":"cat > f <<EOF\\n' + "x".repeat(4000);
    let pieces = 0;
    for (let i = 0; i < json.length; i += 40) {
      feed(se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(i, i + 40) } }));
      pieces++;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(times.length).toBeGreaterThan(1);
    expect(times.length).toBeLessThan(pieces / 2);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    // a few ms of timer slack on a loaded machine
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(PARTIAL_ARGS_EMIT_MS - 5);
  }, 30000);
});
