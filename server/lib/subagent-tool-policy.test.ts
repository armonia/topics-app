import { describe, expect, test } from "bun:test";
import { toolAllowedByPolicy, type SubagentToolPolicy } from "./subagent-tool-policy";

describe("a native child never asks the human", () => {
  const open: SubagentToolPolicy = { allowed: null, noDelegation: false };
  test("ask_user_question is refused even with every tool allowed", () => {
    expect(toolAllowedByPolicy(open, "ask_user_question")).toBe(false);
    expect(toolAllowedByPolicy(open, "bash")).toBe(true);
  });
  test("a chat that is not a child keeps the tool", () => {
    expect(toolAllowedByPolicy(null, "ask_user_question")).toBe(true);
  });
  test("an explicit grant does not bring it back", () => {
    const granted: SubagentToolPolicy = { allowed: new Set(["ask_user_question"]), noDelegation: false };
    expect(toolAllowedByPolicy(granted, "ask_user_question")).toBe(false);
  });
});
