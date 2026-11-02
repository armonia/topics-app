/**
 * The command of a tool is written into its row while the partial_json
 * arrives, not once it is complete.
 * @covers CHAT-REVEAL-02
 */
import { describe, test, expect } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";
import { SidechainTracker } from "./claude/sidechain-tracker";

const streamEvent = (event: Record<string, unknown>) => ({ type: "stream_event", event });

describe("partial tool command", () => {
  test("an unfinished command string is surfaced as a partial update", () => {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    const pp = { sidechain: new SidechainTracker(), activeToolCalls: new Set<string>(), pendingInputs: new Map() } as Record<string, any>;
    const updates: Array<{ args: Record<string, unknown>; partial?: boolean }> = [];
    const handler = {
      onToolStart: () => {},
      onToolActivity: () => {},
      onToolArgsUpdate: (_id: string, args: Record<string, unknown>, update?: { partial?: boolean }) => updates.push({ args, partial: update?.partial }),
    };
    const send = (ev: Record<string, unknown>) => (provider as any).handlePartialStreamEvent(pp, streamEvent(ev), handler);
    send({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_b", name: "Bash" } });
    send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"cat > a.txt <<EOF\\nline 1' } });
    expect(updates.length).toBe(1);
    expect(updates[0].partial).toBe(true);
    expect(String(updates[0].args.command)).toContain("cat > a.txt");
  });
});
