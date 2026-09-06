/**
 * @covers KANBAN-78
 *
 * The argv wrapper and the "is this an agent's PTY" question, both pure. The
 * demotion of a live pid is a `renice`/`taskpolicy` spawn and is not driven
 * here: what matters is that the two doors say the same thing on every
 * platform, and that the owner's own shell is never demoted.
 */
import { describe, expect, test } from "bun:test";
import { AGENT_NICE, isAgentWorkspace, lowPriorityArgv } from "./low-priority";

describe("lowPriorityArgv", () => {
  test("macOS: QoS clamp first, then nice, then the command untouched", () => {
    expect(lowPriorityArgv(["/bin/sh", "-lc", "bun run typecheck"], "darwin")).toEqual([
      "taskpolicy", "-c", "utility", "nice", "-n", String(AGENT_NICE), "/bin/sh", "-lc", "bun run typecheck",
    ]);
  });

  test("Linux: nice only, the command untouched", () => {
    expect(lowPriorityArgv(["bash", "-c", "ls"], "linux")).toEqual(["nice", "-n", String(AGENT_NICE), "bash", "-c", "ls"]);
  });

  test("Windows: the argv as it was, a copy", () => {
    const argv = ["cmd", "/c", "dir"];
    const out = lowPriorityArgv(argv, "win32");
    expect(out).toEqual(argv);
    expect(out).not.toBe(argv);
  });
});

describe("isAgentWorkspace", () => {
  const HOME = "/Users/tizio";

  test("a sub-agent is an agent, wherever it works", () => {
    expect(isAgentWorkspace("/Users/tizio/Projects/topics-app", "topic:abc", HOME)).toBe(true);
  });

  test("a dispatch worktree and a Claude Code worktree are agents", () => {
    expect(isAgentWorkspace("/Users/tizio/.topics/worktrees/topics-app/sandy-anchor", undefined, HOME)).toBe(true);
    expect(isAgentWorkspace("/Users/tizio/Projects/topics-app/.claude/worktrees/agent-1", undefined, HOME)).toBe(true);
  });

  test("the owner's shell in the repo keeps its priority; a lookalike folder does not count", () => {
    expect(isAgentWorkspace("/Users/tizio/Projects/topics-app", undefined, HOME)).toBe(false);
    expect(isAgentWorkspace("/Users/tizio/.topics/worktrees-backup/x", undefined, HOME)).toBe(false);
    expect(isAgentWorkspace("/Users/tizio/Projects/topics-app/.claude/worktrees-old/x", undefined, HOME)).toBe(false);
  });
});
