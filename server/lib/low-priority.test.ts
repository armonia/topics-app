/**
 * @covers KANBAN-78
 *
 * The argv wrapper and the "is this an agent's PTY" question, both pure. The
 * demotion of a live pid is a `renice`/`taskpolicy` spawn and is not driven
 * here: what matters is that the two doors say the same thing on every
 * platform, and that the owner's own shell is never demoted.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { AGENT_NICE, browserShouldBeBackground, isAgentWorkspace, lowPriorityArgv, setBackground, setBackgroundTree } from "./low-priority";

describe("lowPriorityArgv", () => {
  const all = { nice: true, taskpolicy: true };

  test("macOS: QoS clamp first, then nice, then the command untouched — by absolute path", () => {
    expect(lowPriorityArgv(["/bin/sh", "-lc", "bun run typecheck"], "darwin", all)).toEqual([
      "/usr/sbin/taskpolicy", "-c", "utility", "/usr/bin/nice", "-n", String(AGENT_NICE), "/bin/sh", "-lc", "bun run typecheck",
    ]);
  });

  test("Linux: nice only, the command untouched", () => {
    expect(lowPriorityArgv(["bash", "-c", "ls"], "linux", all)).toEqual(["/usr/bin/nice", "-n", String(AGENT_NICE), "bash", "-c", "ls"]);
  });

  test("a knob that is not on this machine is skipped, never searched for", () => {
    // The server's PATH under launchd has no /usr/sbin: a bare `taskpolicy`
    // made every check spawn fail on 2026-09-06. Missing = the plain argv.
    expect(lowPriorityArgv(["/bin/sh", "-lc", "x"], "darwin", { nice: true, taskpolicy: false }))
      .toEqual(["/usr/bin/nice", "-n", String(AGENT_NICE), "/bin/sh", "-lc", "x"]);
    expect(lowPriorityArgv(["/bin/sh", "-lc", "x"], "darwin", { nice: false, taskpolicy: false })).toEqual(["/bin/sh", "-lc", "x"]);
  });

  test("Windows: the argv as it was, a copy", () => {
    const argv = ["cmd", "/c", "dir"];
    const out = lowPriorityArgv(argv, "win32", all);
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

describe("setBackground", () => {
  const all = { nice: true, taskpolicy: true };
  const calls: { cmd: string; args: string[] }[] = [];
  const run = (cmd: string, args: string[]) => { calls.push({ cmd, args }); };
  beforeEach(() => { calls.length = 0; });

  test("macOS: the QoS toggle, both ways, by absolute path", () => {
    setBackground(4242, true, "darwin", all, run);
    expect(calls).toEqual([{ cmd: "/usr/sbin/taskpolicy", args: ["-b", "-p", "4242"] }]);
    calls.length = 0;
    setBackground(4242, false, "darwin", all, run);
    expect(calls).toEqual([{ cmd: "/usr/sbin/taskpolicy", args: ["-B", "-p", "4242"] }]);
  });

  test("macOS without the binary: nothing is spawned", () => {
    setBackground(4242, true, "darwin", { nice: true, taskpolicy: false }, run);
    expect(calls).toEqual([]);
  });

  test("Linux: a one-way renice, and no un-demotion (a process cannot raise itself back)", () => {
    setBackground(7, true, "linux", all, run);
    expect(calls).toEqual([{ cmd: "/usr/bin/renice", args: ["-n", String(AGENT_NICE), "-p", "7"] }]);
    calls.length = 0;
    setBackground(7, false, "linux", all, run);
    expect(calls).toEqual([]);
  });

  test("Windows and a nonsense pid: no-op", () => {
    setBackground(7, true, "win32", all, run);
    setBackground(0, true, "darwin", all, run);
    setBackground(-3, true, "darwin", all, run);
    expect(calls).toEqual([]);
  });
});

describe("setBackgroundTree", () => {
  test("the whole tree, because a live child does NOT inherit the toggle", async () => {
    // Measured on this machine: `taskpolicy -b -p <parent>` moved the parent to
    // PRI 4 and left both already-running children at PRI 20. Chromium's
    // renderers are separate processes, so the toggle has to walk down.
    const children = new Map<number, number[]>([[1, [2, 3]], [3, [4]]]);
    const applied: { pid: number; on: boolean }[] = [];
    const touched = await setBackgroundTree(1, true, {
      listChildren: async (pid) => children.get(pid) ?? [],
      apply: (pid, on) => { applied.push({ pid, on }); },
    });
    expect(touched).toEqual([1, 2, 3, 4]);
    expect(applied).toEqual([1, 2, 3, 4].map((pid) => ({ pid, on: true })));
  });

  test("a cycle in the reported tree cannot loop forever", async () => {
    const touched = await setBackgroundTree(1, false, {
      listChildren: async (pid) => (pid === 1 ? [2] : [1]),
      apply: () => {},
    });
    expect(touched).toEqual([1, 2]);
  });
});

describe("browserShouldBeBackground", () => {
  const test_ = {
    isDispatched: (key: string) => key.startsWith("card:"),
    isAgentCwd: (cwd: string) => cwd.startsWith("/home/x/.topics/worktrees/"),
  };
  const agentContext = { contextId: "a", sessionKey: "card:1" };
  const worktreeContext = { contextId: "b", workspace: "/home/x/.topics/worktrees/topics-app/blue-moon" };
  const personContext = { contextId: "c", sessionKey: "topic:mine", workspace: "/home/x/Projects/topics-app" };

  test("no context at all: nothing is waiting on it, background", () => {
    expect(browserShouldBeBackground([], test_)).toBe(true);
  });

  test("only agents: background", () => {
    expect(browserShouldBeBackground([agentContext, worktreeContext], test_)).toBe(true);
  });

  test("agents plus one person: foreground for everybody, the browser is shared", () => {
    expect(browserShouldBeBackground([agentContext, worktreeContext, personContext], test_)).toBe(false);
  });

  test("an agent context somebody is watching is a person's", () => {
    expect(browserShouldBeBackground([{ ...agentContext, watchers: 1 }], test_)).toBe(false);
    expect(browserShouldBeBackground([{ ...agentContext, watchers: 0 }], test_)).toBe(true);
  });

  test("an owner nobody can name is treated as a person's", () => {
    expect(browserShouldBeBackground([{ contextId: "term-9" }], test_)).toBe(false);
  });
});
