/**
 * WHOSE PROCESSES ARE THESE, AND WHICH OF THEM WOULD STOP TOPICS.
 *
 * The fixture is the shape of this Mac, copied from `ps -axo
 * pid,ppid,pgid,time,command -ww` on 15-16/09/2026 (paths shortened, the same
 * relations): the server in group 981 with `start-prod.sh` and the watch
 * supervisor; a `claude` CLI whose MCP server, LSP and `caffeinate` sit in the
 * CLI's own group; its tool shells, each the leader of a group of its own; a
 * native runtime command that is a child of the SERVER, in the server's group;
 * and a Playwright tree whose WebKit XPC services hang off launchd.
 *
 * Every test here is red on the tree before this change for one reason: no agent
 * command was a freeze target at all, and nothing computed a guard set.
 *
 * @covers KANBAN-85
 */
import { describe, expect, test } from "bun:test";
import {
  allowedGroups,
  containsAgentCli,
  descendantPids,
  guardSet,
  parseCpuTime,
  parseProcessTable,
  toolRoots,
  type AgentSessionRef,
  type NativeCommandRef,
} from "./agent-tool-children";

const SNAPSHOT = `
    1     0     0  12:00.00 /sbin/launchd
  981     1   981   0:02.11 bash /Users/u/Projects/topics-app/scripts/start-prod.sh
 1733   981   981  40:12.33 bun run /Users/u/Projects/topics-app/server.ts
10557   981   981   0:00.90 /opt/homebrew/bin/fswatch -o /Users/u/Projects/topics-app/server
 2382     1  2382   3:21.00 /Users/u/Projects/topics-app/bin/pty-bridge --socket /tmp/topics-pty-bridge.sock
48914     1 48914   9:00.00 /Applications/Claude.app/Contents/MacOS/Claude
34260 48914 48914   0:01.00 /Applications/Claude.app/Contents/Helpers/disclaimer -- claude
38515 34260 48914  12:03.00 /Users/u/Library/App/claude-code/2.1.270/claude.app/Contents/MacOS/claude --resume=abc
39135 38515 48914   1:02.00 bun run /Users/u/Projects/topics-app/topics-mcp-server.ts
48960 38515 48914   0:31.00 node /opt/homebrew/bin/typescript-language-server --stdio
27576 38515 48914   0:00.10 /usr/bin/caffeinate -dims
51000 38515 51000   0:00.20 /bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'bun batteria.ts' < /dev/null && pwd -P
51004 51000 51000   4:10.00 bun batteria.ts
51010 51004 51000   0:01.00 bash /Users/u/Library/Caches/ms-playwright/webkit-2311/pw_run.sh --inspector-pipe --headless
51020 51010 51000   2:00.00 /Users/u/Library/Caches/ms-playwright/webkit-2311/Playwright.app/Contents/MacOS/Playwright --inspector-pipe --headless
52000 38515 52000   0:00.10 /bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'bun barra.ts && bun prova-3d.ts' < /dev/null && pwd -P
53000 38515 53000   0:00.05 /bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval '! ps aux | head' < /dev/null && pwd -P
54000 38515 54000   0:10.00 /bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval 'claude -p "sistema il test"' < /dev/null && pwd -P
54010 54000 54000   5:00.00 /Users/u/Library/App/claude-code/2.1.270/claude.app/Contents/MacOS/claude -p sistema il test
60123  1733   981   1:00.00 /bin/bash -lc bun run test:unit
51101     1 51101   3:00.00 /Users/u/Library/Caches/ms-playwright/webkit-2311/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent.Development
`;

const rows = parseProcessTable(SNAPSHOT);

const session = (over: Partial<AgentSessionRef> = {}): AgentSessionRef => ({
  sessionKey: "topic:3ddb9fb9",
  cliPid: 38515,
  topicId: "3ddb9fb9",
  terminalId: "term-1",
  taskId: null,
  backgroundBash: [{ command: "bun batteria.ts", startedAt: 1 }],
  foregroundBash: "bun barra.ts && bun prova-3d.ts",
  ...over,
});

const native: NativeCommandRef = {
  sessionKey: "topic:native", pid: 60123, command: "bun run test:unit",
  topicId: "native", terminalId: null, taskId: null,
};

describe("F1: only a command the CLI announced as background is a root", () => {
  test("the background shell is the one root; MCP, LSP and caffeinate are never candidates", () => {
    const { roots, foreground, unrecognised } = toolRoots({ rows, sessions: [session()], natives: [] });
    expect(roots.map((r) => r.pid)).toEqual([51000]);
    expect(roots[0]!.kind).toBe("claude-background");
    expect(roots[0]!.command).toBe("bun batteria.ts");
    const touched = [...roots.map((r) => r.pid), ...foreground.map((f) => f.pid), ...unrecognised.map((u) => u.pid)];
    for (const helper of [39135, 48960, 27576]) expect(touched).not.toContain(helper);
  });

  test("the foreground command in flight is named, and it is not a root", () => {
    const { roots, foreground } = toolRoots({ rows, sessions: [session()], natives: [] });
    expect(foreground.map((f) => f.pid)).toEqual([52000]);
    expect(roots.map((r) => r.pid)).not.toContain(52000);
  });

  test("a `claude -p` grandchild takes its whole tree out", () => {
    const withNested = session({ backgroundBash: [{ command: 'claude -p "sistema il test"', startedAt: 1 }] });
    const { roots } = toolRoots({ rows, sessions: [withNested], natives: [] });
    expect(roots.map((r) => r.pid)).toEqual([54000]);
    // The root is recognised, and the tree check is what refuses it.
    expect(containsAgentCli(rows, descendantPids(rows, 54000))).toBe(54010);
    expect(containsAgentCli(rows, descendantPids(rows, 51000))).toBeNull();
  });
});

describe("F2: anything not accounted for is logged, never signalled", () => {
  test("a command typed by a person in a claude pane is unrecognised", () => {
    const { roots, unrecognised } = toolRoots({ rows, sessions: [session()], natives: [] });
    expect(unrecognised.map((u) => u.pid)).toContain(53000);
    expect(roots.map((r) => r.pid)).not.toContain(53000);
  });

  test("a pane with no records at all yields no roots", () => {
    const bare = session({ backgroundBash: [], foregroundBash: null });
    const { roots, unrecognised } = toolRoots({ rows, sessions: [bare], natives: [] });
    expect(roots).toEqual([]);
    expect(unrecognised.length).toBeGreaterThan(0);
  });

  test("the native runtime's command is a root through its registration, not through a shape", () => {
    const { roots } = toolRoots({ rows, sessions: [], natives: [native] });
    expect(roots.map((r) => r.pid)).toEqual([60123]);
    expect(roots[0]!.kind).toBe("native");
  });
});

describe("F3: the guard set, and the groups a signal may reach", () => {
  const guard = guardSet(rows, { serverPid: 1733, sidecarPids: [2382], cliPids: [38515] });

  test("the server, its whole group, the sidecar, the CLI and its helpers are guarded", () => {
    for (const pid of [1, 1733, 981, 10557, 2382, 38515, 39135, 48960, 27576]) {
      expect(guard.has(pid), `pid ${pid} must be guarded`).toBe(true);
    }
  });

  test("the agent's own tool shells are not guarded", () => {
    for (const pid of [51000, 51004, 51010, 51020, 52000]) expect(guard.has(pid)).toBe(false);
  });

  test("a native tree gets NO group signal: its group is the server's", () => {
    const tree = descendantPids(rows, 60123);
    expect(allowedGroups(rows, tree, guard)).toEqual([]);
  });

  test("a background shell may be signalled as its own group", () => {
    const tree = descendantPids(rows, 51000);
    const groups = allowedGroups(rows, tree, guard);
    expect(groups.map((g) => g.pgid)).toEqual([51000]);
    expect(groups[0]!.members.sort()).toEqual([51000, 51004, 51010, 51020]);
  });
});

describe("the table itself", () => {
  test("cpu time parses in every shape ps prints", () => {
    expect(parseCpuTime("0:01.58")).toBeCloseTo(1.58, 2);
    expect(parseCpuTime("12:34.56")).toBeCloseTo(754.56, 2);
    expect(parseCpuTime("1-02:03:04")).toBe(86_400 + 2 * 3600 + 3 * 60 + 4);
    expect(parseCpuTime("nonsense")).toBe(0);
  });

  test("the descendant walk keeps the XPC services out: they hang off launchd", () => {
    expect(descendantPids(rows, 51000).has(51101)).toBe(false);
  });
});
