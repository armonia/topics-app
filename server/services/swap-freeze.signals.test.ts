/**
 * REAL PROCESSES, REAL SIGNALS: the only place the whole thing is true or false.
 *
 * Every other test here injects the signal. This one spawns the shape that
 * matters - a parent that must KEEP RUNNING (the stand-in for the server, whose
 * process group the command shares, exactly as the native runtime's `bash`
 * shares group 981), a command tree that must stop, and a counter file per
 * process so "stopped" is measured by work not done rather than by a signal
 * having been sent.
 *
 * It also kills the freezer mid-flight and replays the ledger, which is the
 * scenario that gives a stopped tree nobody can continue.
 *
 * Only children this test spawned are ever signalled.
 *
 * @covers KANBAN-85
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSwapFreezer } from "./swap-freeze";
import { createSwapFreezeLedger, thawLedgerAtBoot, fileLedgerIo } from "./swap-freeze-ledger";
import { readProcessStates, readProcessTable, readStartTimes } from "../lib/process-snapshot";
import type { NativeCommandRef } from "../lib/agent-tool-children";

const dirs: string[] = [];
const spawned: number[] = [];

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    // Continue before killing: a stopped process holds a SIGTERM.
    try { process.kill(pid, "SIGCONT"); } catch { /* gone */ }
    try { process.kill(-pid, "SIGCONT"); } catch { /* no group */ }
    try { process.kill(-pid, "SIGKILL"); } catch { /* no group */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The counter a process writes while it runs: its length IS the work it did. */
const ticks = (path: string): number => (existsSync(path) ? readFileSync(path, "utf8").length : 0);

async function until<T>(what: string, read: () => T | Promise<T>, ok: (v: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const from = Date.now();
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() - from > timeoutMs) throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(v)})`);
    await Bun.sleep(50);
  }
}

/**
 * A parent in a group of its own (the stand-in for the server) and, inside that
 * same group, the command tree that may be frozen.
 */
function spawnHarness(): { dir: string; parentPid: number; rootPid: number } {
  const dir = mkdtempSync(join(tmpdir(), "swap-freeze-signals-"));
  dirs.push(dir);
  const script = join(dir, "harness.ts");
  writeFileSync(script, `
import { appendFileSync } from "fs";
import { spawn } from "child_process";
const dir = ${JSON.stringify(dir)};
// The command tree: a shell with a child of its own, neither detached, so both
// live in THIS process's group - the shape of the native runtime's bash tool.
// The loops BURN CPU on purpose: the freezer refuses to stop an idle tree, and
// a test that lowered that floor would be testing a different product.
const spin = (out: string) => \`while :; do i=0; while [ $i -lt 4000 ]; do i=$((i+1)); done; printf z >> \${out}; done\`;
const child = spawn("/bin/sh", ["-c", \`\${spin(dir + "/root")} & /bin/sh -c '\${spin(dir + "/leaf")}' & wait\`], { stdio: "ignore" });
appendFileSync(dir + "/rootpid", String(child.pid) + "\\n");
setInterval(() => { appendFileSync(dir + "/heartbeat", "h"); }, 50);
`);
  const proc = Bun.spawn(["bun", script], { stdio: ["ignore", "ignore", "ignore"], env: { ...process.env }, detached: true } as Parameters<typeof Bun.spawn>[1]);
  spawned.push(proc.pid);
  return { dir, parentPid: proc.pid, rootPid: 0 };
}

function freezerFor(i: { dir: string; parentPid: number; rootPid: number; ledgerPath: string; logs: string[] }) {
  const ledger = createSwapFreezeLedger(fileLedgerIo(i.ledgerPath, (l) => i.logs.push(l)));
  const natives: NativeCommandRef[] = [{
    sessionKey: "topic:signals", pid: i.rootPid, command: "sh -c loop",
    topicId: "signals", terminalId: null, taskId: null,
  }];
  const freezer = createSwapFreezer({
    processTable: readProcessTable,
    // Anything over the floor: this test is about the signals, not the choice.
    footprintKB: () => 2 * 1e9 / 1024,
    residentKB: () => 1e9 / 1024,
    lstartOf: readStartTimes,
    statOf: readProcessStates,
    signal: (pid, sig) => { process.kill(pid, sig); },
    sessions: () => [],
    natives: () => natives,
    guardRoles: () => ({ serverPid: i.parentPid, sidecarPids: [], cliPids: [] }),
    xpcServicePids: async () => [],
    outsidePeers: async () => [],
    ledger,
    log: (line) => i.logs.push(line),
  });
  return { freezer, ledger };
}

const SUSTAINED = { sustained: true, pagesReadBackPerS: 33.6, debtGBPerMin: 8.8, swapPct: null, coveredMs: 120_000 };
const NO_ROOM = { measurable: true, latestGB: 4, heldGB: 4, coveredMs: 120_000 };
const BRAKE = { interrupted: false, skipped: "noHeavyRun" };

describe("F14: the tree really stops, its parent really does not, and a crash cannot strand it", () => {
  test("freeze stops every pid of the tree and leaves the parent running; thaw resumes them", async () => {
    const h = spawnHarness();
    const rootPid = Number((await until("the command tree to start", () => (existsSync(join(h.dir, "rootpid")) ? readFileSync(join(h.dir, "rootpid"), "utf8") : ""), (t) => t.trim().length > 0)).trim());
    spawned.push(rootPid);
    await until("the tree to be working", () => ticks(join(h.dir, "leaf")), (n) => n > 0);

    const logs: string[] = [];
    const ledgerPath = join(h.dir, "ledger.json");
    const { freezer } = freezerFor({ ...h, rootPid, ledgerPath, logs });
    // Two beats: the first has no CPU base, so the rate is measured.
    await freezer.tick({ swap: SUSTAINED, held: NO_ROOM, brake: BRAKE });
    await Bun.sleep(1200);
    await freezer.tick({ swap: SUSTAINED, held: NO_ROOM, brake: BRAKE });

    expect(freezer.views(), logs.join("\n")).toHaveLength(1);
    const table = await readProcessTable();
    expect(table, "ps answered with a process table").not.toBeNull();
    const treePids = table!.filter((r) => r.pid === rootPid || r.ppid === rootPid).map((r) => r.pid);
    const states = await until(
      "every pid of the tree to read T",
      () => readProcessStates(treePids),
      (map) => map !== null && map.size === treePids.length && [...map.values()].every((s) => s.startsWith("T")),
    );
    for (const [pid, stat] of states!) expect(stat.startsWith("T"), `pid ${pid} reads ${stat}`).toBe(true);

    const rootBefore = ticks(join(h.dir, "root"));
    const leafBefore = ticks(join(h.dir, "leaf"));
    const heartbeatBefore = ticks(join(h.dir, "heartbeat"));
    await Bun.sleep(1000);
    expect(ticks(join(h.dir, "root")), "a stopped process does no work").toBe(rootBefore);
    expect(ticks(join(h.dir, "leaf"))).toBe(leafBefore);
    // THE ONE THAT MUST NOT STOP: it shares the tree's process group.
    expect(ticks(join(h.dir, "heartbeat")), "the parent in the same group kept running").toBeGreaterThan(heartbeatBefore);

    await freezer.thawAll("room");
    await until("the tree to resume", () => ticks(join(h.dir, "leaf")), (n) => n > leafBefore);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).active).toEqual([]);
  }, 60_000);

  test("a freezer killed mid-freeze leaves a ledger the next boot can act on", async () => {
    const h = spawnHarness();
    const rootPid = Number((await until("the command tree to start", () => (existsSync(join(h.dir, "rootpid")) ? readFileSync(join(h.dir, "rootpid"), "utf8") : ""), (t) => t.trim().length > 0)).trim());
    spawned.push(rootPid);
    await until("the tree to be working", () => ticks(join(h.dir, "leaf")), (n) => n > 0);

    const logs: string[] = [];
    const ledgerPath = join(h.dir, "ledger.json");
    const { freezer } = freezerFor({ ...h, rootPid, ledgerPath, logs });
    await freezer.tick({ swap: SUSTAINED, held: NO_ROOM, brake: BRAKE });
    await Bun.sleep(1200);
    await freezer.tick({ swap: SUSTAINED, held: NO_ROOM, brake: BRAKE });
    expect(freezer.views(), logs.join("\n")).toHaveLength(1);
    const leafWhileFrozen = ticks(join(h.dir, "leaf"));

    // The server is SIGKILLed: the freezer object simply goes away, exactly as
    // it does under `launchctl kickstart -k`. Nothing continues the tree.
    const bootLedger = createSwapFreezeLedger(fileLedgerIo(ledgerPath, (l) => logs.push(l)));
    expect(bootLedger.snapshot().active, "the pids were on disk before their SIGSTOP").toHaveLength(1);
    await thawLedgerAtBoot({
      ledger: bootLedger,
      lstartOf: readStartTimes,
      signal: (pid, sig) => { process.kill(pid, sig); },
      log: (l) => logs.push(l),
    });
    await until("the tree continued by the boot thaw", () => ticks(join(h.dir, "leaf")), (n) => n > leafWhileFrozen);
    expect(bootLedger.snapshot().active).toEqual([]);
  }, 60_000);

  test("a recorded identity that no longer matches is left alone, and said out loud", async () => {
    const h = spawnHarness();
    const rootPid = Number((await until("the command tree to start", () => (existsSync(join(h.dir, "rootpid")) ? readFileSync(join(h.dir, "rootpid"), "utf8") : ""), (t) => t.trim().length > 0)).trim());
    spawned.push(rootPid);
    const logs: string[] = [];
    const ledgerPath = join(h.dir, "ledger.json");
    writeFileSync(ledgerPath, JSON.stringify({
      v: 1,
      active: [{
        treeId: "t1", sessionKey: "topic:signals", frozenAt: Date.now(),
        root: { pid: rootPid, lstart: "a time that never was" },
        batches: [{ groups: [], pids: [{ pid: rootPid, lstart: "a time that never was" }] }],
      }],
      counts: [],
    }));
    const ledger = createSwapFreezeLedger(fileLedgerIo(ledgerPath, (l) => logs.push(l)));
    const out = await thawLedgerAtBoot({
      ledger,
      lstartOf: readStartTimes,
      signal: (pid, sig) => { process.kill(pid, sig); },
      log: (l) => logs.push(l),
    });
    expect(out.continued, "a recycled pid is somebody else's process").toBe(0);
    expect(out.skipped).toBe(1);
    expect(logs.join("\n")).toContain("skipped: recycled");
  }, 30_000);
});
