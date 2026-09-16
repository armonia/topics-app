/**
 * Who is holding the memory when the queue is held and it is not Topics.
 *
 * The table below is an EXTRACT of a real `/bin/ps -Ao pid=,ppid=,rss=,command=`
 * taken on this Mac on 16/09/2026, while seven cards sat held under the 6 GB
 * floor: the arguments are cut to keep it readable, the paths and the pids are
 * verbatim. It carries every shape the grouping has to survive - an Electron app
 * whose helpers live in their own nested `.app`, a WebKit XPC service that
 * belongs to OUR shell, an app with a space in its name, a `next-server` left
 * running, and our own tree reparented away from the server.
 *
 * @covers KANBAN-75
 */
import { describe, expect, test } from "bun:test";
import {
  appFamilyName,
  formatMemoryOwners,
  memoryOwners,
  memoryOwnersLogField,
  parsePsMemRows,
  type PsMemRow,
} from "./memory-owners";

const PS_REAL = `
  399     1 126320 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon
  981   808    752 /bin/bash /Users/zorahrel/Projects/topics-app/scripts/start-prod.sh
 2382     1  17120 node /Users/zorahrel/Projects/topics-app/server/pty-bridge.mjs --socket /tmp/topics-pty-bridge-9ec57b11.sock
 2779     1 245728 /Applications/Dia.app/Contents/MacOS/Dia
 3256  2779   4080 /Applications/Claude.app/Contents/Helpers/chrome-native-host chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/
 3554  2779 176544 /Applications/Dia.app/Contents/Frameworks/ArcCore.framework/Helpers/Browser Helper (Renderer).app/Contents/MacOS/Browser Helper (Renderer) --type=renderer
 5629   981 889968 /Users/zorahrel/.bun/bin/bun run /Users/zorahrel/Projects/topics-app/server.ts
10198     1 103648 /Applications/Spotify.app/Contents/MacOS/Spotify
10279 10198  69984 /Applications/Spotify.app/Contents/Frameworks/Spotify Helper (Renderer).app/Contents/MacOS/Spotify Helper (Renderer) --type=renderer
14838 14837 147488 /Users/zorahrel/Library/Application Support/Claude/claude-code/2.1.270/claude.app/Contents/MacOS/claude --output-format stream-json
23129  2779 870480 /Applications/Dia.app/Contents/Frameworks/ArcCore.framework/Helpers/Browser Helper (Renderer).app/Contents/MacOS/Browser Helper (Renderer) --type=renderer
24160     1   8192 npm exec next dev -p 3177
24226 24160   4576 node /Users/zorahrel/Projects/quadra/node_modules/.pnpm/next@15.5.23/node_modules/next/dist/bin/next dev
24276 24226  35328 next-server (v15.5.23)
26071 48914  49904 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer
31539 48914 2148480 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer
38515  2382 208000 /Users/zorahrel/.local/bin/claude --resume 3ddb9fb9 --dangerously-skip-permissions --append-system-prompt You are running inside Topics
39135 38515   3360 /Users/zorahrel/.bun/bin/bun run /Users/zorahrel/Projects/topics-app/server/mcp/topics-mcp-server.ts --base-url=https://127.0.0.1:3333
39946     1 105664 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent
41573     1 101520 /Applications/Wispr Flow.app/Contents/MacOS/Wispr Flow
48486     1  24864 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent
48914     1 130960 /Applications/Claude.app/Contents/MacOS/Claude
91121     1  53712 /Users/zorahrel/Applications/Topics.app/Contents/MacOS/app
`;

/** The three roots everything of ours grows from, as `server.ts` passes them. */
const OURS = ["/Users/zorahrel/Projects/topics-app", "/Topics.app/", "/Users/zorahrel/.topics/worktrees"];
const SERVER_PID = 5629;
/** `responsibility_get_pid_responsible_for_pid`, as this Mac answered: both WebContent belong to our shell. */
const RESPONSIBLE = new Map([[39946, 91121], [48486, 91121]]);
const rows = parsePsMemRows(PS_REAL);
type Opts = Parameters<typeof memoryOwners>[0];
const owners = (over: Partial<Opts> = {}): ReturnType<typeof memoryOwners> =>
  memoryOwners({ rows, selfPid: SERVER_PID, ourMarkers: OURS, ownerOf: (pid) => RESPONSIBLE.get(pid) ?? null, ...over });

describe("parsePsMemRows", () => {
  test("O1: pid, ppid, rss and a command with spaces in its path", () => {
    expect(rows.length).toBe(23);
    expect(rows.find((r) => r.pid === 41573)).toEqual({
      pid: 41573, ppid: 1, rssKB: 101_520, command: "/Applications/Wispr Flow.app/Contents/MacOS/Wispr Flow",
    } satisfies PsMemRow);
    // `next-server (v15.5.23)` has a trailing blank in the real output and no path at all.
    expect(rows.find((r) => r.pid === 24276)!.command).toBe("next-server (v15.5.23)");
    expect(parsePsMemRows("  PID  PPID   RSS COMMAND\nnonsense\n")).toEqual([]);
  });
});

describe("appFamilyName: the app, never the raw process name", () => {
  test("O2: a nested helper bundle answers with the OUTERMOST app", () => {
    expect(appFamilyName("/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer")).toBe("Claude");
    expect(appFamilyName("/Applications/Dia.app/Contents/Frameworks/ArcCore.framework/Helpers/Browser Helper (Renderer).app/Contents/MacOS/Browser Helper (Renderer)")).toBe("Dia");
    expect(appFamilyName("/Applications/Wispr Flow.app/Contents/MacOS/Wispr Flow")).toBe("Wispr Flow");
  });

  test("O3: no bundle - an XPC service, a retitled server, an interpreter and its script", () => {
    expect(appFamilyName("/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent")).toBe("WebContent");
    expect(appFamilyName("next-server (v15.5.23)")).toBe("next-server");
    expect(appFamilyName("/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon")).toBe("WindowServer");
    // `node` holds nothing: the script it runs is the thing a person would stop.
    expect(appFamilyName("node /Users/zorahrel/Projects/quadra/node_modules/.pnpm/next@15.5.23/node_modules/next/dist/bin/next dev")).toBe("next");
    expect(appFamilyName("node /Users/zorahrel/Projects/topics-app/server/pty-bridge.mjs --socket /tmp/x.sock")).toBe("pty-bridge");
    expect(appFamilyName("node --max-old-space-size=8192")).toBe("node");
  });
});

describe("memoryOwners: everything that is not Topics, heaviest first", () => {
  test("O4: the two apps the owner could quit, with one decimal", () => {
    // 2.148 + 0.130 + 0.050 + 0.004 GB of Claude, 0.870 + 0.246 + 0.177 of Dia.
    expect(owners()).toEqual([
      { name: "Claude", gb: expect.closeTo(2.33, 2), procs: 4 },
      { name: "Dia", gb: expect.closeTo(1.29, 2), procs: 3 },
    ]);
    expect(formatMemoryOwners(owners())).toBe("Fuori da Topics la memoria la tengono: Claude 2.3 GB, Dia 1.3 GB.");
    expect(memoryOwnersLogField(owners())).toBe("Claude:2.3,Dia:1.3");
  });

  test("O5: nothing of OURS is ever named - the server's tree, the marked paths, the shell, its WebContent", () => {
    const all = owners({ floorGB: 0, top: 50 });
    // Eight of the 23 rows are ours: the server (5629), the launchd script (981),
    // the pty bridge (2382, reparented to 1 and found by its path), the agent CLI
    // that hangs off it (38515), the MCP server under that (39135), the shell
    // (91121) and the two WebContent the shell is responsible for.
    expect(all.reduce((n, f) => n + f.procs, 0)).toBe(rows.length - 8);
    expect(all.map((f) => f.name)).not.toContain("bun");
    expect(all.map((f) => f.name)).not.toContain("bash");
    expect(all.map((f) => f.name)).not.toContain("Topics");
    // The heaviest single row in the whole table is our own server, 0.89 GB: no
    // family may carry it, and none may carry the agent CLI's 0.21 GB either.
    expect(all.every((f) => f.gb < 0.88 || f.name === "Claude" || f.name === "Dia")).toBe(true);
    // The two WebKit processes are our browser panes: without the responsible pid
    // they read as a foreign "WebContent" family, and the sentence would blame the
    // owner for memory Topics itself is holding.
    expect(all.map((f) => f.name)).not.toContain("WebContent");
    expect(owners({ floorGB: 0, top: 50, ownerOf: () => null }).map((f) => f.name)).toContain("WebContent");
  });

  test("O6: below the floor nothing is named, and never more than the top N", () => {
    const all = owners({ floorGB: 0, top: 50 });
    // `claude` lowercase is the CLI the Claude APP ships inside its own bundle,
    // and it is neither the app nor ours: a separate family is the honest answer.
    expect(all.map((f) => f.name)).toEqual(["Claude", "Dia", "Spotify", "claude", "WindowServer", "Wispr Flow", "next-server", "npm", "next"]);
    // Nobody quits an app to get 0.17 GB back on a machine whose floor is 6 GB.
    expect(owners().map((f) => f.name)).toEqual(["Claude", "Dia"]);
    expect(owners({ top: 3, floorGB: 0.1 }).map((f) => f.name)).toEqual(["Claude", "Dia", "Spotify"]);
    expect(formatMemoryOwners([])).toBeNull();
    expect(memoryOwnersLogField([])).toBe("-");
  });

  test("O7: a name with a space survives the sentence and is folded in the log field", () => {
    const flow = owners({ floorGB: 0.1, top: 50 }).find((f) => f.name === "Wispr Flow")!;
    expect(formatMemoryOwners([flow])).toBe("Fuori da Topics la memoria la tengono: Wispr Flow 0.1 GB.");
    expect(memoryOwnersLogField([flow])).toBe("Wispr_Flow:0.1");
  });

  test("O8: an unordered table still resolves the whole subtree", () => {
    const shuffled = [...rows].reverse();
    const round = (fs: ReturnType<typeof memoryOwners>) => fs.map((f) => ({ ...f, gb: +f.gb.toFixed(6) }));
    const inOrder = memoryOwners({ rows, selfPid: SERVER_PID, ourMarkers: OURS, floorGB: 0, top: 50 });
    const shuffledOut = memoryOwners({ rows: shuffled, selfPid: SERVER_PID, ourMarkers: OURS, floorGB: 0, top: 50 });
    expect(round(shuffledOut)).toEqual(round(inOrder));
  });
});
