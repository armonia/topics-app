/** @covers USAGE-26 */
import { describe, expect, test } from "bun:test";
import { attachRemoteJobs, attributeProcesses, programOf, type AttrRow } from "./session-attribution";

/**
 * The table of a small Mac, built by hand:
 *
 *   1 launchd
 *   ├─ 100 server                       (root `server`)
 *   │   ├─ 101 bun test (script a card's native tool started) ── head of card:a (via native command)
 *   │   │   └─ 102 tsc
 *   │   └─ 103 dev server of a project  (unowned work)
 *   ├─ 200 pty-bridge                   (root `pty-bridge`)
 *   │   ├─ 210 claude  ── head of card:b
 *   │   │   ├─ 211 mcp-server
 *   │   │   └─ 212 claude (sub-agent)  ── head of card:b too (folded into the card)
 *   │   └─ 220 zsh     ── head of terminal:z
 *   └─ 300 ai-bridge                    (root `ai-bridge`)
 *       └─ 310 claude  ── head of chat:c
 */
const row = (pid: number, ppid: number, memKB: number, cpu: number | null, command: string): AttrRow => ({ pid, ppid, memKB, cpu, command });

const TABLE: AttrRow[] = [
  row(100, 1, 400_000, 4, "/usr/local/bin/bun run server.ts"),
  row(101, 100, 300_000, 50, "bun test server/lib"),
  row(102, 101, 100_000, 25, "node /x/tsc --noEmit"),
  row(103, 100, 700_000, 10, "node vite --port 5173"),
  row(200, 1, 60_000, 1, "/x/pty-bridge"),
  row(210, 200, 500_000, 20, "claude --model x"),
  row(211, 210, 80_000, 2, "/x/mcp-server --stdio"),
  row(212, 210, 450_000, 15, "claude --child"),
  row(220, 200, 20_000, 0, "-zsh"),
  row(300, 1, 90_000, 3, "/x/ai-bridge"),
  row(310, 300, 600_000, 30, "claude --chat"),
  row(999, 1, 5_000_000, 80, "/Applications/Some Other App.app/Contents/MacOS/Some Other App"),
];

const ROOTS = [
  { id: "server", pid: 100 },
  { id: "pty-bridge", pid: 200 },
  { id: "ai-bridge", pid: 300 },
];

const HEADS = [
  { unit: "card:a", pid: 101 },
  { unit: "card:b", pid: 210 },
  { unit: "card:b", pid: 212 },
  { unit: "terminal:z", pid: 220 },
  { unit: "chat:c", pid: 310 },
];
const UNITS = ["card:a", "card:b", "terminal:z", "chat:c"];

const attribute = (over: Partial<Parameters<typeof attributeProcesses>[0]> = {}) =>
  attributeProcesses({ rows: TABLE, roots: ROOTS, heads: HEADS, unowned: [103], units: UNITS, ...over });

describe("attributeProcesses", () => {
  test("a process goes to the nearest session head above it, tools and children included", () => {
    const a = attribute();
    const cardA = a.units.get("card:a")!;
    // bun test (300_000) + tsc below it (100_000), both the card's.
    expect(cardA.ownKB).toBe(400_000);
    expect(cardA.ownProcesses).toBe(2);
    expect(cardA.ownCpu).toBe(75);
    // The coordinator and its sub-agent are the same card; the MCP server below the CLI is its own too.
    const cardB = a.units.get("card:b")!;
    expect(cardB.ownKB).toBe(500_000 + 80_000 + 450_000);
    expect(cardB.procs.map((p) => p.name)).toEqual(["claude", "mcp-server"]);
    expect(cardB.procs[0]).toMatchObject({ name: "claude", count: 2, memKB: 950_000 });
  });

  test("the server's own process is split in equal slices between every live session", () => {
    const a = attribute();
    // 100 (server, 400_000) is the only process in the server bucket: 103 is unowned work, 101 is a head.
    for (const key of UNITS) {
      const s = a.units.get(key)!.shares.find((x) => x.root === "server")!;
      expect(s).toMatchObject({ totalKB: 400_000, of: 4, kb: 100_000 });
      expect(s.cpu).toBe(1);
    }
  });

  test("a bridge is shared only by the sessions under it: SHARED between two, whole for one", () => {
    const a = attribute();
    // pty-bridge (60_000): used by card:b and terminal:z -> 1/2 each.
    for (const key of ["card:b", "terminal:z"]) {
      expect(a.units.get(key)!.shares.find((x) => x.root === "pty-bridge")).toMatchObject({ totalKB: 60_000, of: 2, kb: 30_000 });
    }
    // The AI bridge (90_000) has one user.
    expect(a.units.get("chat:c")!.shares.find((x) => x.root === "ai-bridge")).toMatchObject({ of: 1, kb: 90_000 });
    // And a session does not pay for a bridge it does not sit under.
    expect(a.units.get("card:a")!.shares.map((x) => x.root)).toEqual(["server"]);
    expect(a.units.get("chat:c")!.shares.map((x) => x.root).sort()).toEqual(["ai-bridge", "server"]);
  });

  test("no double count: what the sessions are billed plus the remainder is exactly what was scanned", () => {
    const a = attribute();
    // 999 is not Topics': never scanned. Everything else lands in exactly one place.
    const topics = TABLE.filter((r) => r.pid !== 999).reduce((s, r) => s + r.memKB, 0);
    expect(a.scannedKB).toBe(topics);
    expect(a.billedKB + a.unattributed.kb).toBeCloseTo(topics, 6);
    // The dev server (700_000) is nobody's and is reported apart, not shared out.
    expect(a.unattributed).toMatchObject({ kb: 700_000, processes: 1, cpu: 10 });
    let perUnit = 0;
    for (const u of a.units.values()) perUnit += u.ownKB + u.shares.reduce((s, x) => s + x.kb, 0);
    expect(perUnit).toBeCloseTo(a.billedKB, 6);
  });

  test("a head registered under two units keeps the first, so a pid is never billed twice", () => {
    const a = attribute({ heads: [...HEADS, { unit: "chat:c", pid: 101 }] });
    expect(a.units.get("card:a")!.ownKB).toBe(400_000);
    expect(a.units.get("chat:c")!.ownKB).toBe(600_000);
  });

  test("a root nobody uses is unattributed, not handed to a session that does not touch it", () => {
    const a = attribute({ heads: HEADS.filter((h) => h.unit !== "chat:c"), units: UNITS.filter((u) => u !== "chat:c") });
    // The AI bridge (90_000) and the CLI of the chat that is gone (600_000, no head now): both fall to the bucket of their root.
    expect(a.unattributed.kb).toBe(700_000 + 90_000 + 600_000);
    expect(a.billedKB + a.unattributed.kb).toBeCloseTo(a.scannedKB, 6);
  });

  test("an orphaned process is found through the kernel's responsible pid when the parent chain is cut", () => {
    // 211 reparented to launchd: ppid 1, but the kernel says the CLI 210 is responsible for it.
    const rows = TABLE.map((r) => (r.pid === 211 ? { ...r, ppid: 1 } : r));
    const without = attributeProcesses({ rows, roots: ROOTS, heads: HEADS, unowned: [103], units: UNITS });
    expect(without.units.get("card:b")!.ownKB).toBe(500_000 + 450_000);
    const withKernel = attributeProcesses({ rows, roots: ROOTS, heads: HEADS, unowned: [103], units: UNITS, responsibleOf: (pid) => (pid === 211 ? 210 : null) });
    expect(withKernel.units.get("card:b")!.ownKB).toBe(500_000 + 80_000 + 450_000);
  });

  test("a CPU nobody measured stays null, it is not a zero", () => {
    const rows = TABLE.map((r) => (r.pid === 310 ? { ...r, cpu: null } : r));
    const a = attributeProcesses({ rows, roots: ROOTS, heads: HEADS, unowned: [103], units: UNITS });
    expect(a.units.get("chat:c")!.ownCpu).toBeNull();
    expect(a.units.get("card:a")!.ownCpu).toBe(75);
  });

  test("a cycle in the table does not hang the walk", () => {
    const rows = [row(10, 11, 1, 0, "a"), row(11, 10, 1, 0, "b")];
    const a = attributeProcesses({ rows, roots: [], heads: [], units: [] });
    expect(a.scannedKB).toBe(0);
  });
});

describe("programOf", () => {
  test("an app bundle keeps its name, a plain command is its basename", () => {
    expect(programOf("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless")).toBe("Google Chrome");
    expect(programOf("/usr/local/bin/node /x/y.js")).toBe("node");
    expect(programOf("-zsh")).toBe("-zsh");
  });
});

describe("attachRemoteJobs", () => {
  const byProject = new Map<string, string[]>([["acme-web", ["card:a"]], ["studio-x", ["card:b", "chat:c"]]]);

  test("one job on one session takes that job's whole part of the machine's sent-work load", () => {
    const r = attachRemoteJobs([{ what: "test", project: "acme-web", who: "Mac", since: 1 }], { memMB: 3000, cpuPct: 400 }, byProject);
    expect(r.bySession.get("card:a")).toEqual([{ job: { what: "test", project: "acme-web", who: "Mac", since: 1 }, of: 1, memMB: 3000, cpuPct: 400 }]);
    expect(r.unmatched).toEqual([]);
  });

  test("two jobs divide the load, and two sessions of one project divide that job's part", () => {
    const jobs = [
      { what: "test", project: "acme-web", who: null, since: null },
      { what: "build", project: "studio-x", who: null, since: null },
    ];
    const r = attachRemoteJobs(jobs, { memMB: 2000, cpuPct: 200 }, byProject);
    expect(r.bySession.get("card:a")![0]).toMatchObject({ of: 1, memMB: 1000, cpuPct: 100 });
    expect(r.bySession.get("card:b")![0]).toMatchObject({ of: 2, memMB: 500, cpuPct: 50 });
    expect(r.bySession.get("chat:c")![0]).toMatchObject({ of: 2, memMB: 500, cpuPct: 50 });
    // The slices add back to the load that was measured: nothing billed twice.
    const total = [...r.bySession.values()].flat().reduce((s, x) => s + (x.memMB ?? 0), 0);
    expect(total).toBe(2000);
  });

  test("a job of a project no live session carries is reported apart", () => {
    const r = attachRemoteJobs([{ what: "test", project: "gone", who: null, since: null }, { what: "x", project: null, who: null, since: null }], { memMB: 1, cpuPct: 1 }, byProject);
    expect(r.bySession.size).toBe(0);
    expect(r.unmatched).toHaveLength(2);
  });

  test("an unmeasured machine load stays null on the slice", () => {
    const r = attachRemoteJobs([{ what: "t", project: "acme-web", who: null, since: null }], { memMB: null, cpuPct: null }, byProject);
    expect(r.bySession.get("card:a")![0]).toMatchObject({ memMB: null, cpuPct: null });
  });
});
