/** @covers SUBAGENT-08, SUBAGENT-09, SUBAGENT-11, SUBAGENT-17, SUBAGENT-18 */
import { describe, expect, test } from "bun:test";
import { engineModelOf, nativeChildPlace, nativeTurnOutcome } from "./native-subagents";
import { engineToolsOfProfile, toolAllowedByPolicy } from "./subagent-tool-policy";

describe("how a child chat's turn ended, as a result (SUBAGENT-11)", () => {
  test("an end_turn with words is completed", () => {
    expect(nativeTurnOutcome({ end: { end: "end_turn" }, text: " found 3 ", stopped: false }))
      .toEqual({ status: "completed", partial: false, text: "found 3" });
  });

  test("the parent's stop is stopped-by-parent, a person's Stop on the child is a plain stop", () => {
    expect(nativeTurnOutcome({ end: { end: "cancelled" }, text: "half", stopped: true }).reason).toEqual({ code: "stopped-by-parent" });
    expect(nativeTurnOutcome({ end: { end: "cancelled" }, text: "half", stopped: false })).toEqual({ status: "stopped", partial: true, text: "half" });
  });

  test("an error end is failed, with the end and its detail", () => {
    expect(nativeTurnOutcome({ end: { end: "error", detail: "overloaded" }, text: "", stopped: false }))
      .toEqual({ status: "failed", partial: true, text: "", reason: { code: "api-error", detail: "error: overloaded" } });
  });

  test("a route that refused the turn is failed, whatever else is known", () => {
    expect(nativeTurnOutcome({ end: { end: "end_turn" }, text: "old", routeError: "the chat route answered 503", stopped: false }).status).toBe("failed");
  });

  test("no end on record: words left are a result, none is a cut turn", () => {
    expect(nativeTurnOutcome({ end: null, text: "ok", stopped: false }).status).toBe("completed");
    expect(nativeTurnOutcome({ end: null, text: "", stopped: false })).toMatchObject({ status: "failed", reason: { code: "exited-mid-turn" } });
  });
});

describe("where a native child stands (SUBAGENT-17)", () => {
  const known = (p: string) => p === "/p/known";
  test("a chat parent hands down its project and worktree, or no project at all", () => {
    expect(nativeChildPlace({ explicitCwd: null, parentTopic: { projectPath: "/p/a", worktreeId: "wt1" }, parentCwd: null, knownProject: known }))
      .toEqual({ ok: true, projectPath: "/p/a", worktreeId: "wt1" });
    expect(nativeChildPlace({ explicitCwd: null, parentTopic: {}, parentCwd: null, knownProject: known }))
      .toEqual({ ok: true, projectPath: null, worktreeId: null });
  });

  test("a cwd Topics does not know as a project is not a native child's home", () => {
    expect(nativeChildPlace({ explicitCwd: "/Users/x/.ssh", parentTopic: { projectPath: "/p/a" }, parentCwd: null, knownProject: known }).ok).toBe(false);
    expect(nativeChildPlace({ explicitCwd: "/p/known", parentTopic: null, parentCwd: null, knownProject: known })).toMatchObject({ ok: true, projectPath: "/p/known" });
  });

  test("a terminal parent's directory counts only when it is a known project", () => {
    expect(nativeChildPlace({ explicitCwd: null, parentTopic: null, parentCwd: "/p/known", knownProject: known })).toMatchObject({ ok: true, projectPath: "/p/known" });
    expect(nativeChildPlace({ explicitCwd: null, parentTopic: null, parentCwd: "/tmp", knownProject: known }).ok).toBe(false);
  });
});

describe("the model and the tools, in the engine's names (SUBAGENT-08, 09)", () => {
  test("the aliases the tool accepts become ids the engine serves", () => {
    expect(engineModelOf("sonnet")).toBe("claude-sonnet-5-5");
    expect(engineModelOf("opus[1m]")).toBe("claude-opus-5-5[1m]");
    expect(engineModelOf("haiku")).toBe("claude-haiku-4-5-20251001");
    expect(engineModelOf("claude-sonnet-5-5[1m]")).toBe("claude-sonnet-5-5[1m]");
    expect(engineModelOf(null)).toBeNull();
  });

  test("a profile's tools line, translated; nothing listed is no restriction", () => {
    expect(engineToolsOfProfile(["Read", "Bash", "WebSearch", "mcp__topics__move_task", "mcp__exa__search"]))
      .toEqual(["read_file", "bash", "move_task", "mcp__exa__search"]);
    expect(engineToolsOfProfile(["Task"])).toContain("spawn_agent");
    expect(engineToolsOfProfile(null)).toBeNull();
  });

  test("the policy: a profile list restricts, the depth cap removes delegation, no policy allows all", () => {
    expect(toolAllowedByPolicy(null, "spawn_agent")).toBe(true);
    expect(toolAllowedByPolicy({ allowed: null, noDelegation: true }, "spawn_agent")).toBe(false);
    expect(toolAllowedByPolicy({ allowed: null, noDelegation: true }, "bash")).toBe(true);
    expect(toolAllowedByPolicy({ allowed: new Set(["read_file"]), noDelegation: false }, "bash")).toBe(false);
  });
});
