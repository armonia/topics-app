/**
 * @covers KANBAN-78
 *
 * The CLI of a card is demoted; the CLI of a person's chat is not. Pure, with
 * the two readings injected: what matters is WHICH sessions get the demotion,
 * and that either sign alone is enough.
 */
import { describe, expect, test } from "bun:test";
import { demoteAgentCli, type AgentCliPriorityDeps } from "./agent-cli-priority";

function deps(over: Partial<AgentCliPriorityDeps> & { demoted?: number[] } = {}): AgentCliPriorityDeps & { demoted: number[] } {
  const demoted: number[] = over.demoted ?? [];
  return {
    isDispatched: over.isDispatched ?? (() => false),
    isAgentCwd: over.isAgentCwd ?? (() => false),
    demote: over.demote ?? ((pid) => { demoted.push(pid); }),
    demoted,
  };
}

describe("demoteAgentCli", () => {
  test("a session bound to a card is demoted, wherever it works", () => {
    const d = deps({ isDispatched: (k) => k === "topic:card1" });
    expect(demoteAgentCli("topic:card1", "/Users/tizio/Projects/repo", 4242, d)).toBe(true);
    expect(d.demoted).toEqual([4242]);
  });

  test("a session in an agent worktree is demoted even when no card claims it", () => {
    const d = deps({ isAgentCwd: (cwd) => cwd.includes("/.topics/worktrees/") });
    expect(demoteAgentCli("topic:x", "/Users/tizio/.topics/worktrees/repo/sandy-anchor", 77, d)).toBe(true);
    expect(d.demoted).toEqual([77]);
  });

  test("a person's chat in their own repo keeps its priority", () => {
    const d = deps();
    expect(demoteAgentCli("topic:mine", "/Users/tizio/Projects/repo", 99, d)).toBe(false);
    expect(d.demoted).toEqual([]);
  });

  test("no pid, no demotion: nothing to demote and nothing to throw", () => {
    const d = deps({ isDispatched: () => true });
    expect(demoteAgentCli("topic:card1", "/x", undefined, d)).toBe(false);
    expect(demoteAgentCli("topic:card1", "/x", 0, d)).toBe(false);
    expect(d.demoted).toEqual([]);
  });
});
