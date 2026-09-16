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
  OUR_APP_MARKERS,
  parsePsMemRows,
  rowGB,
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
    // `index` is a file name, not a program: the package above it is the answer.
    expect(appFamilyName("/opt/homebrew/opt/node/bin/node --max-old-space-size=8192 /opt/homebrew/lib/node_modules/openclaw/dist/index.js gateway --port 18789")).toBe("openclaw");
    expect(appFamilyName("bun run /Users/zorahrel/Projects/topics-app/server/index.ts")).toBe("server");
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

/**
 * THE SECOND EXTRACT, and it exists because the first one cannot see any of
 * this: `/bin/ps -Ao pid=,ppid=,rss=,command=` on this Mac on 16/09/2026 at
 * 15:20, pids, paths and resident sizes verbatim, with the answers
 * `responsibility_get_pid_responsible_for_pid` really gave beside them. It
 * carries the three shapes `PS_REAL` has none of:
 *
 *  - `Topics Host.app` (pid 808), the program of the `com.armonia.topics-server`
 *    LaunchAgent and the server's ANCESTOR, not its descendant;
 *  - two foreign processes macOS makes it responsible for (an `astro dev` of
 *    another repo's worktree and the `npm exec` above it) - 28 of them on the
 *    live machine;
 *  - a foreign process responsible to ANOTHER foreign process: `next-server`
 *    answers 19972, the OpenClaw gateway.
 *
 * Every family here is far under the 0.5 GB floor, so these tests read the list
 * with the floor off: what is on trial is the NAME each row is counted under,
 * and the floor would hide the whole table.
 *
 * @covers KANBAN-75
 */
const PS_HOST = `
  808     1   5104 /Users/zorahrel/Applications/Topics Host.app/Contents/MacOS/topics-host
  981   808    736 /bin/bash /Users/zorahrel/Projects/topics-app/scripts/start-prod.sh
 5629   981 151584 /Users/zorahrel/.bun/bin/bun run /Users/zorahrel/Projects/topics-app/server.ts
19972     1 247360 /opt/homebrew/opt/node/bin/node --max-old-space-size=8192 /opt/homebrew/lib/node_modules/openclaw/dist/index.js gateway --port 18789
24226 24160   4576 node /Users/zorahrel/Projects/quadra/node_modules/next/dist/bin/next dev
24276 24226  37584 next-server (v15.5.23)
41343     1   8096 npm exec astro dev --port 4444 --host 127.0.0.1 --force
41387 41343  19376 node /Users/zorahrel/Projects/armonia-agency/armonia-site/.claude/worktrees/mano-armonia/node_modules/.bin/astro dev --port 4444 --host 127.0.0.1 --force
45099 19972 189808 /Users/zorahrel/.local/bin/claude --disallowedTools ScheduleWakeup,CronCreate --strict-mcp-config
48914     1 122624 /Applications/Claude.app/Contents/MacOS/Claude
39946     1 105664 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent
91121     1  53712 /Users/zorahrel/Applications/Topics.app/Contents/MacOS/app
`;

describe("memoryOwners: the responsible pid names an XPC service and nothing else", () => {
  const hostRows = parsePsMemRows(PS_HOST);
  /** What the FFI answered, pid by pid, on the live machine. */
  const RESPONSIBLE_LIVE = new Map([[808, 808], [981, 808], [5629, 808], [24276, 19972], [41343, 808], [41387, 808], [39946, 91121]]);
  const hostOwners = (over: Partial<Opts> = {}) => memoryOwners({
    rows: hostRows,
    selfPid: 5629,
    ourMarkers: ["/Users/zorahrel/Projects/topics-app", ...OUR_APP_MARKERS],
    ownerOf: (pid) => RESPONSIBLE_LIVE.get(pid) ?? null,
    floorGB: 0, top: 50, ...over,
  });

  test("O9: the `astro dev` of another repo is named after ITSELF, and no family is called Topics Host", () => {
    const names = hostOwners().map((f) => f.name);
    // The row the sentence exists to name: 41387, responsible to pid 808.
    expect(names).toContain("astro");
    expect(hostOwners().find((f) => f.name === "astro")).toEqual({ name: "astro", gb: 19_376 / 1e6, procs: 1 });
    // `Topics Host.app` is OURS, so it is neither a family of its own nor the
    // name somebody else's memory gets counted under.
    expect(names).not.toContain("Topics Host");
    expect(names).not.toContain("topics-host");
    // And what is ours is still ours: the server, the launchd script, the shell
    // and the WebContent our shell is responsible for.
    expect(hostOwners().reduce((n, f) => n + f.procs, 0)).toBe(hostRows.length - 5);
  });

  test("O10: `next-server` keeps its own name, not the name of the bundle that launched it", () => {
    const names = hostOwners().map((f) => f.name);
    expect(names).toContain("next-server");
    // The gateway's own row is `.../openclaw/dist/index.js`: on the live machine
    // its responsible-pid answer pulled 24 unrelated processes into a family
    // called `index`, `next-server` among them.
    expect(names).not.toContain("index");
    // The gateway keeps a name a person can act on: `dist/index.js` is a file
    // name, `openclaw` is the program.
    expect(names).toContain("openclaw");
    expect(hostOwners().find((f) => f.name === "next-server")!.procs).toBe(1);
    // An XPC service still goes to whoever asked for it: 39946 is our shell's.
    expect(names).not.toContain("WebContent");
  });

  test("O11: a family is summed on the FOOTPRINT, and on resident size only where there is none", () => {
    // Measured 16/09 on the live Claude family: 7.01 GB resident, 10.88 GB of
    // `phys_footprint` over the same 33 pids. Activity Monitor shows the second.
    const withFootprint = hostRows.map((r) => (r.pid === 48914 ? { ...r, footprintKB: 190_000 } : r));
    expect(rowGB({ pid: 1, ppid: 0, rssKB: 122_624, footprintKB: 190_000, command: "x" })).toBeCloseTo(0.19, 6);
    expect(rowGB({ pid: 1, ppid: 0, rssKB: 122_624, command: "x" })).toBeCloseTo(0.122624, 6);
    expect(hostOwners({ rows: withFootprint }).find((f) => f.name === "Claude")!.gb).toBeCloseTo(0.19, 6);
    expect(hostOwners().find((f) => f.name === "Claude")!.gb).toBeCloseTo(0.122624, 6);
  });

  test("O12: two names that differ only by case are told apart in the sentence the owner reads", () => {
    // Live on 16/09: `Claude 6.8 GB` (the app) beside `claude 1.1 GB` (the CLI
    // the app ships, running outside it) - two entries, one readable word.
    const named = hostOwners({ floorGB: 0.1, top: 3 });
    expect(named.map((f) => f.name)).toEqual(["openclaw", "claude (comando)", "Claude"]);
    expect(formatMemoryOwners(named)).toBe("Fuori da Topics la memoria la tengono: openclaw 0.2 GB, claude (comando) 0.2 GB, Claude 0.1 GB.");
    // A name with no twin is left alone.
    expect(hostOwners().map((f) => f.name)).toContain("astro");
  });
});
