/**
 * The sub-agent tool is called `Agent` now, not only `Task`.
 *
 * The CLI renamed the tool: the provider registered the sidechain parent (and
 * filled its `description`/`subagent_type`) only for `Task`. With `Agent` the
 * parent was born as an empty placeholder from the sidechain branch and the
 * real input never landed: measured on topic cd85be85, 45 sub-agent rows out
 * of 45 without a description.
 * @covers SUBAGENT-01
 */
import { describe, test, expect } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";
import { SidechainTracker, isSubAgentToolName } from "./claude/sidechain-tracker";

function streamEvent(event: Record<string, unknown>) {
  return { type: "stream_event", event };
}

function ppStub() {
  return {
    sidechain: new SidechainTracker(),
    activeToolCalls: new Set<string>(),
    pendingInputs: new Map(),
  } as Record<string, any>;
}

describe("sub-agent: Task and Agent are the same tool", () => {
  test("isSubAgentToolName recognises both names", () => {
    expect(isSubAgentToolName("Task")).toBe(true);
    expect(isSubAgentToolName("Agent")).toBe(true);
    expect(isSubAgentToolName("Bash")).toBe(false);
  });

  for (const name of ["Task", "Agent"]) {
    test(`${name}: the partial announce registers the parent and block stop fills its description`, () => {
      const provider = new ClaudeCodeProvider({ type: "claude-code" });
      const pp = ppStub();
      const partial = (ev: Record<string, unknown>) => (provider as any).handlePartialStreamEvent(pp, streamEvent(ev), null);
      partial({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_sub", name } });
      expect(pp.sidechain.has("toolu_sub")).toBe(true);
      partial({
        type: "content_block_delta", index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ description: "find the bugs", subagent_type: "Explore", prompt: "x" }) },
      });
      partial({ type: "content_block_stop", index: 0 });
      const snap = pp.sidechain.snapshot("toolu_sub");
      expect(snap?.description).toBe("find the bugs");
      expect(snap?.subAgentType).toBe("Explore");
    });
  }
});
