/** @covers SUBAGENT-23 */
import { describe, expect, test } from "bun:test";
import { toolAllowedByPolicy } from "./subagent-tool-policy";

describe("native sub-agent tool policy", () => {
  test("a child never sees ask_user_question, even when its profile grants it", () => {
    const granted = { allowed: new Set(["ask_user_question", "bash"]), noDelegation: false };
    expect(toolAllowedByPolicy(granted, "ask_user_question")).toBe(false);
    expect(toolAllowedByPolicy(granted, "mcp__topics__ask_user_question")).toBe(false);
    expect(toolAllowedByPolicy({ allowed: null, noDelegation: false }, "ask_user_question")).toBe(false);
    expect(toolAllowedByPolicy(granted, "bash")).toBe(true);
  });

  test("a chat that is not a child keeps the question tool", () => {
    expect(toolAllowedByPolicy(null, "ask_user_question")).toBe(true);
  });
});
