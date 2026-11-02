/**
 * Text and tool commands reach the handler as the model writes them, with no
 * artificial delay and no lump per block (card cd66c3bd).
 * @covers CHAT-STREAM-01
 */
import { describe, test, expect } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";
import { SidechainTracker } from "./claude/sidechain-tracker";
import { PARTIAL_ARGS_EMIT_MS } from "./partial-tool-input";

const streamEvent = (event: Record<string, unknown>) => ({ type: "stream_event", event });
const textDelta = (text: string) => streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });

function setup() {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const pp = { sidechain: new SidechainTracker(), activeToolCalls: new Set<string>(), pendingInputs: new Map(), fullText: "" } as Record<string, any>;
  const deltas: string[] = [];
  const updates: Array<{ command: unknown; partial?: boolean }> = [];
  const handler = {
    onTextDelta: (t: string) => deltas.push(t),
    onToolStart: () => {},
    onToolActivity: () => {},
    onToolArgsUpdate: (_id: string, a: Record<string, unknown>, u?: { partial?: boolean }) => updates.push({ command: a.command, partial: u?.partial }),
  };
  return { provider, pp, deltas, updates, handler };
}

describe("text arrives as written", () => {
  test("each text_delta goes out at once, the snapshot adds only the rest", () => {
    const { provider, pp, deltas, handler } = setup();
    const p = provider as any;
    p.handlePartialStreamEvent(pp, textDelta("Hel"), handler);
    p.handlePartialStreamEvent(pp, textDelta("lo"), handler);
    expect(deltas).toEqual(["Hel", "lo"]);
    // the complete-block snapshot path: same slice logic as processEvent
    const streamed = pp.streamedText as string;
    const block = "Hello world";
    expect(block.startsWith(streamed)).toBe(true);
    expect(block.slice(streamed.length)).toBe(" world");
  });

  test("no delta is held back: nothing is scheduled, the handler runs synchronously", () => {
    const { provider, pp, deltas, handler } = setup();
    (provider as any).handlePartialStreamEvent(pp, textDelta("x"), handler);
    expect(deltas).toEqual(["x"]);
    expect(pp.fullText).toBe("x");
  });

  test("a replay or a command turn does not stream text", () => {
    const a = setup();
    a.pp.replaySilent = true;
    (a.provider as any).handlePartialStreamEvent(a.pp, textDelta("x"), a.handler);
    const b = setup();
    b.pp.commandTurn = "/x";
    (b.provider as any).handlePartialStreamEvent(b.pp, textDelta("x"), b.handler);
    expect(a.deltas).toEqual([]);
    expect(b.deltas).toEqual([]);
  });
});

describe("tool command streams", () => {
  test("the emit interval is at most one frame-ish (50 ms)", () => {
    expect(PARTIAL_ARGS_EMIT_MS).toBeLessThanOrEqual(50);
  });

  test("an unfinished command is surfaced as a partial update", () => {
    const { provider, pp, updates, handler } = setup();
    const send = (ev: Record<string, unknown>) => (provider as any).handlePartialStreamEvent(pp, streamEvent(ev), handler);
    send({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_b", name: "Bash" } });
    send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"cat > a.txt <<EOF\\nline 1' } });
    expect(updates.length).toBe(1);
    expect(updates[0].partial).toBe(true);
    expect(String(updates[0].command)).toContain("cat > a.txt");
  });
});
