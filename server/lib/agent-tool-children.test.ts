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
  encodeAsPsWould,
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
  foregroundBash: ["bun barra.ts && bun prova-3d.ts"],
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
    const bare = session({ backgroundBash: [], foregroundBash: [] });
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

/**
 * A QUOTE IN THE COMMAND IS THE COMMON CASE, NOT A CORNER ONE.
 *
 * The CLI writes the tool command inside `eval '<cmd>'`, and a single quote in
 * `<cmd>` can only survive by leaving the quoting and coming back: `'\''` or
 * `'"'"'`. Matching the record against the RAW `ps` text therefore fails for
 * every such command, and it fails asymmetrically - the foreground command with
 * a `--grep 'x'` in it goes unrecognised while a three-word background record
 * from an earlier turn still matches the same line and claims its pid. That pid
 * is then a freeze candidate, and a foreground command is the one thing that
 * must never be frozen: its CLI kills it on a clock that never stopped.
 */
describe("F1b: the `eval` quoting, on both sides of the comparison", () => {
  const QUOTED = `
38515 34260 48914  12:03.00 /Users/u/Library/App/claude-code/2.1.270/claude.app/Contents/MacOS/claude --resume=abc
55000 38515 55000   0:20.00 /bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'bun test --grep '\\''brina'\\''' < /dev/null && pwd -P
56000 38515 56000   0:20.00 /bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'bun test tests/e2e --grep '"'"'ghiaccio'"'"'' < /dev/null && pwd -P
`;
  const quotedRows = parseProcessTable(QUOTED);

  test("the foreground command with a quote in it is recognised, and a shorter background record does not steal it", () => {
    const s = session({
      backgroundBash: [{ command: "bun test", startedAt: 1 }],
      foregroundBash: ["bun test --grep 'brina'"],
    });
    const { roots, foreground } = toolRoots({ rows: quotedRows, sessions: [s], natives: [] });
    expect(foreground.map((f) => f.pid)).toContain(55000);
    expect(roots.map((r) => r.pid), "the command in flight is never a candidate").not.toContain(55000);
  });

  test("a background command with a quote in it is recognised instead of falling into `unrecognised`", () => {
    const s = session({
      backgroundBash: [{ command: "bun test tests/e2e --grep 'ghiaccio'", startedAt: 1 }],
      foregroundBash: [],
    });
    const { roots, unrecognised } = toolRoots({ rows: quotedRows, sessions: [s], natives: [] });
    expect(roots.map((r) => r.pid), "the lever was blind to exactly the heavy commands").toContain(56000);
    expect(roots.find((r) => r.pid === 56000)!.command).toBe("bun test tests/e2e --grep 'ghiaccio'");
    expect(unrecognised.map((u) => u.pid)).not.toContain(56000);
  });

  test("the longest match wins: a background record that explains more than the foreground one still takes the pid", () => {
    const s = session({
      backgroundBash: [{ command: "bun test tests/e2e --grep 'ghiaccio'", startedAt: 1 }],
      foregroundBash: ["bun"],
    });
    const { roots } = toolRoots({ rows: quotedRows, sessions: [s], natives: [] });
    expect(roots.map((r) => r.pid)).toContain(56000);
  });
});

/**
 * F1c: THE OTHER ALPHABET, the one `ps` itself writes in.
 *
 * The quoting of `eval '<cmd>'` was only half the gap. `ps` rewrites every byte
 * it cannot print, so a command with a newline in it (a heredoc, an `&&` on the
 * next line) never matched its own row: the record said a newline, the row said
 * the four characters `\012`, and `normalizeCommandLine` turned the record's
 * newline into a space. The pairs below were MEASURED on this Mac on 16/09/2026
 * by putting one byte class per child into argv and reading
 * `/bin/ps -axo command= -ww` back; the consequence is in the two `toolRoots`
 * tests: without the encoding a multi-line foreground command is a freeze
 * candidate, and a multi-line background command is invisible to the lever.
 */
describe("F1c: the escapes `ps` prints, on the record side of the comparison", () => {
  test("every byte class reads the way `/bin/ps` wrote it", () => {
    const measured: [string, string][] = [
      ["\t", "\\011"],
      ["\n", "\\012"],
      ["\x01", "^A"],
      ["\x0b", "^K"],
      ["\x1b", "^["],
      ["\x7f", "^?"],
      ["\\", "\\"],
      ["^", "^"],
      ["ò", "M-CM-2"],
      ["€", "M-bM^BM-,"],
      [" ", "M-B\\240"],
      ["", "M-BM^A"],
      ["", "M-BM^_"],
      ["plain ascii", "plain ascii"],
    ];
    for (const [raw, printed] of measured) expect(encodeAsPsWould(raw), JSON.stringify(raw)).toBe(printed);
  });

  const ESCAPED = `
38515 34260 48914  12:03.00 /Users/u/Library/App/claude-code/2.1.270/claude.app/Contents/MacOS/claude --resume=abc
57000 38515 57000   0:20.00 /bin/zsh -c source /Users/u/.claude/snapshot.sh && eval 'cd /repo\\012bun test server/services/swap-freeze.test.ts' < /dev/null && pwd -P
58000 38515 58000   0:20.00 /bin/zsh -c source /Users/u/.claude/snapshot.sh && eval 'cd /repo\\012bun run build:all' < /dev/null && pwd -P
59000 38515 59000   0:20.00 /bin/zsh -c source /Users/u/.claude/snapshot.sh && eval 'bun scripts/verifica-perM-CM-2.ts' < /dev/null && pwd -P
`;
  const escapedRows = parseProcessTable(ESCAPED);

  test("a multi-line foreground command is recognised, and a stale background record does not claim its pid", () => {
    const s = session({
      backgroundBash: [{ command: "bun test", startedAt: 1 }],
      foregroundBash: ["cd /repo\nbun test server/services/swap-freeze.test.ts"],
    });
    const { roots, foreground } = toolRoots({ rows: escapedRows, sessions: [s], natives: [] });
    expect(foreground.map((f) => f.pid)).toContain(57000);
    expect(roots.map((r) => r.pid), "the command in flight is never a candidate").not.toContain(57000);
  });

  test("a multi-line background command is a root instead of falling into `unrecognised`", () => {
    const s = session({
      backgroundBash: [{ command: "cd /repo\nbun run build:all", startedAt: 1 }],
      foregroundBash: [],
    });
    const { roots, unrecognised } = toolRoots({ rows: escapedRows, sessions: [s], natives: [] });
    expect(roots.map((r) => r.pid), "the lever was blind to exactly the heavy scripts").toContain(58000);
    expect(unrecognised.map((u) => u.pid)).not.toContain(58000);
    expect(roots.find((r) => r.pid === 58000)!.command, "what is shown is the command, not its escapes").toBe("cd /repo bun run build:all");
  });

  test("a command with an accent in it is recognised too: `ps` writes the byte, not the letter", () => {
    const s = session({
      backgroundBash: [{ command: "bun scripts/verifica-però.ts", startedAt: 1 }],
      foregroundBash: [],
    });
    const { roots } = toolRoots({ rows: escapedRows, sessions: [s], natives: [] });
    expect(roots.map((r) => r.pid)).toContain(59000);
  });

  test("a tab in the record does not become a space either", () => {
    const rows_ = parseProcessTable(`
38515 34260 48914  12:03.00 /Users/u/claude --resume=abc
57500 38515 57500   0:20.00 /bin/zsh -c source /x.sh && eval 'bun test\\011--coverage' < /dev/null && pwd -P
`);
    const s = session({ backgroundBash: [], foregroundBash: ["bun test\t--coverage"] });
    const { foreground, roots } = toolRoots({ rows: rows_, sessions: [s], natives: [] });
    expect(foreground.map((f) => f.pid)).toContain(57500);
    expect(roots).toEqual([]);
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
