/**
 * The idle-park sweep runs every 60 s. Its summary line ("Passata di parcheggio")
 * said the same thing on every tick: 8,490 identical lines in six days of the
 * production stdout, against ~263 real changes. The sweep now speaks when the
 * picture changes, plus a slow heartbeat so "it looked and nothing changed"
 * stays distinguishable from "it did not look".
 *
 * These tests drive the REAL sweep (`parkIdleClaudeSessions`) on the real
 * session map and read what it writes to `console.log`.
 *
 * Contract the fix has to keep:
 *  - the same summary is printed once, then again only after it changes or
 *    after the heartbeat interval (30 minutes, read from `Date.now()`);
 *  - an empty pass forgets the last line, so a refusal that comes back after
 *    a clean pass is printed again;
 *  - the 60 s timer of the router says "Macchina al soffitto" once on entry,
 *    not on every tick at the ceiling (2,218 lines in the same six days), says
 *    nothing on a tick whose pressure probe fails, and prints one exit line.
 * @covers TERM-04
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { join } from "node:path";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "./helpers";
import {
  _terminalSessionsForTests, createTerminalRouter, parkIdleClaudeSessions, setTerminalMemPressure, type TerminalSession,
} from "../../server/routes/terminal";
import type { AppContext } from "../../server/types";

const ROOT = testTmpDir("terminal-park-sweep-log");
const THRESHOLD_MS = 30 * 60_000;
const SWEEP_LINE = "Passata di parcheggio";

let ctx: AppContext;

beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  ctx = await createTestAppContext();
});
afterAll(async () => {
  await cleanupTestDataDir(ROOT);
});

const ids: string[] = [];
let logSpy: ReturnType<typeof spyOn<Console, "log">>;

// A shell is never resumable: the sweep refuses it for good, whatever the clock says.
function addShell(id: string): void {
  const createdAt = new Date().toISOString();
  const session: TerminalSession = {
    id, name: id, createdAt, cwd: ROOT, command: "zsh",
    cols: 80, rows: 24, type: "shell", skipPermissions: true, nameSource: "default",
  };
  _terminalSessionsForTests().set(id, session);
  ids.push(id);
}
function sweepLines(): string[] {
  return logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(SWEEP_LINE));
}

beforeEach(() => {
  // An empty pass first: it clears whatever a previous test left behind in the
  // sweep's memory, so each test starts from "nothing printed yet".
  parkIdleClaudeSessions(THRESHOLD_MS);
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  setSystemTime();
  for (const id of ids.splice(0)) _terminalSessionsForTests().delete(id);
});

test("an unchanged refusal is printed once, not on every tick", () => {
  addShell("sweep-log-a");
  for (let i = 0; i < 5; i++) parkIdleClaudeSessions(THRESHOLD_MS);
  expect(sweepLines()).toHaveLength(1);
});

test("a changed summary is printed again, and so is a return to the earlier one", () => {
  addShell("sweep-log-a");
  parkIdleClaudeSessions(THRESHOLD_MS);
  parkIdleClaudeSessions(THRESHOLD_MS);
  addShell("sweep-log-b");
  parkIdleClaudeSessions(THRESHOLD_MS);
  parkIdleClaudeSessions(THRESHOLD_MS);
  _terminalSessionsForTests().delete("sweep-log-b");
  parkIdleClaudeSessions(THRESHOLD_MS);
  parkIdleClaudeSessions(THRESHOLD_MS);
  const lines = sweepLines();
  expect(lines).toHaveLength(3);
  expect(lines[0]).toContain("1 non parcheggiate");
  expect(lines[1]).toContain("2 non parcheggiate");
  expect(lines[2]).toContain("1 non parcheggiate");
});

test("a pass with nothing to refuse makes the same refusal print again when it returns", () => {
  addShell("sweep-log-a");
  parkIdleClaudeSessions(THRESHOLD_MS);
  parkIdleClaudeSessions(THRESHOLD_MS);
  _terminalSessionsForTests().delete("sweep-log-a");
  parkIdleClaudeSessions(THRESHOLD_MS);
  addShell("sweep-log-c");
  parkIdleClaudeSessions(THRESHOLD_MS);
  parkIdleClaudeSessions(THRESHOLD_MS);
  expect(sweepLines()).toHaveLength(2);
});

test("the same summary is repeated as a heartbeat, but not before 30 minutes", () => {
  // The clock is frozen at each step (bun's setSystemTime does not tick), so
  // the edges are exact: still quiet at +29 min, repeated at +30 min. A shorter
  // heartbeat fails the first check, a longer one the second.
  const start = Date.now();
  setSystemTime(new Date(start));
  addShell("sweep-log-a");
  parkIdleClaudeSessions(THRESHOLD_MS);
  setSystemTime(new Date(start + 29 * 60_000));
  parkIdleClaudeSessions(THRESHOLD_MS);
  expect(sweepLines()).toHaveLength(1);
  setSystemTime(new Date(start + 30 * 60_000));
  parkIdleClaudeSessions(THRESHOLD_MS);
  expect(sweepLines()).toHaveLength(2);
});

test("the router's 60 s timer prints the ceiling once on entry and once on exit, not on every tick", async () => {
  // The timer exists only when the park threshold is configured, and it reads
  // the threshold when the router is created. The bridge stays off: this file
  // must never connect to, or spawn, a PTY bridge.
  const savedPark = process.env.TOPICS_TERMINAL_IDLE_PARK_MS;
  const savedNoBridge = process.env.TOPICS_DISABLE_PTY_BRIDGE;
  const realSetInterval = globalThis.setInterval;
  const parkTicks: { tick: () => void; timer: ReturnType<typeof setInterval> }[] = [];
  const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
    const timer = realSetInterval(fn, ms);
    if (ms === 60_000) parkTicks.push({ tick: fn, timer });
    return timer;
  }) as typeof setInterval);
  try {
    process.env.TOPICS_TERMINAL_IDLE_PARK_MS = String(THRESHOLD_MS);
    process.env.TOPICS_DISABLE_PTY_BRIDGE = "1";
    createTerminalRouter(ctx);
    intervalSpy.mockRestore();
    // The boot chain (reconcile, child sweep) runs on promises: let it finish
    // while the bridge is still disabled.
    await new Promise((r) => setTimeout(r, 50));
    expect(parkTicks).toHaveLength(1);
    const { tick } = parkTicks[0]!;
    const ceilingLines = () => logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("soffitto"));

    setTerminalMemPressure(() => ({ atCeiling: true }));
    for (let i = 0; i < 5; i++) tick();
    expect(ceilingLines()).toHaveLength(1);
    expect(ceilingLines()[0]).toContain("Macchina al soffitto");

    // A probe that throws is an unknown reading, not a way out.
    setTerminalMemPressure(() => { throw new Error("probe down"); });
    tick();
    expect(ceilingLines()).toHaveLength(1);

    setTerminalMemPressure(() => ({ atCeiling: false }));
    tick();
    tick();
    const lines = ceilingLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("rientrata dal soffitto");
  } finally {
    intervalSpy.mockRestore();
    for (const { timer } of parkTicks) clearInterval(timer);
    setTerminalMemPressure(null);
    if (savedPark === undefined) delete process.env.TOPICS_TERMINAL_IDLE_PARK_MS;
    else process.env.TOPICS_TERMINAL_IDLE_PARK_MS = savedPark;
    if (savedNoBridge === undefined) delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
    else process.env.TOPICS_DISABLE_PTY_BRIDGE = savedNoBridge;
  }
});
