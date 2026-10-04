/**
 * A STALE BACKGROUND RECORD DOES NOT HAND A PROCESS TO THE FREEZER.
 *
 * The `PreToolUse` hook is async: the CLI starts a command as the hook fires,
 * and the server hears of it when the POST arrives. A line the agent once ran
 * in the background and now runs again in the FOREGROUND is, until its own
 * `PreToolUse` lands, named only by the old background record, and the freezer
 * would take it for that command. The record was made long before the process
 * started, and that is what gives it away. The rule is pinned in
 * `agent-tool-children.test.ts`; this file pins that the freezer applies it.
 *
 * @covers CCS-03
 */
import { expect, test } from "bun:test";
import { createSwapFreezer } from "./swap-freeze";
import { createSwapFreezeLedger } from "./swap-freeze-ledger";
import { encodeAsPsWould, type AgentSessionRef, type PsRow } from "../lib/agent-tool-children";

// 9 Oct 2025 08:53:20 UTC.
const T0 = 1_760_000_000_000;
const SERVER = 1733;
const CLI = 38515;
const ROOT = 51000;
const COMMAND = "bun batteria.ts";

/** `ps -o lstart=` as macOS prints it, local time. */
function psLstart(ms: number): string {
  const d = new Date(ms);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  const two = (n: number) => String(n).padStart(2, "0");
  return `${day} ${month} ${String(d.getDate()).padStart(2, " ")} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
}

/** Two beats of a sustained swap episode over one heavy shell of the CLI started at `startedAt`. */
async function freezeBeats(startedAt: number): Promise<{ stops: number[]; logs: string[] }> {
  let clock = T0 + 60_000;
  const rows: PsRow[] = [
    { pid: SERVER, ppid: 1, pgid: SERVER, cpuSeconds: 0, command: "bun run server.ts" },
    { pid: CLI, ppid: 1, pgid: CLI, cpuSeconds: 0, command: "/Applications/claude.app/Contents/MacOS/claude" },
    { pid: ROOT, ppid: CLI, pgid: ROOT, cpuSeconds: 0, command: `/bin/zsh -c eval '${encodeAsPsWould(COMMAND)}' < /dev/null` },
    { pid: ROOT + 4, ppid: ROOT, pgid: ROOT, cpuSeconds: 0, command: COMMAND },
  ];
  const table = (): PsRow[] => rows.map((r) => (r.pid === ROOT + 4 ? { ...r, cpuSeconds: (clock - T0) / 1000 } : r));
  const session: AgentSessionRef = {
    sessionKey: "topic:a", cliPid: CLI, topicId: "a", terminalId: null, taskId: null,
    backgroundBash: [{ command: COMMAND, startedAt: T0 }], foregroundBash: [],
  };
  let ledgerText: string | null = null;
  const stops: number[] = [];
  const logs: string[] = [];
  const freezer = createSwapFreezer({
    now: () => clock,
    processTable: async () => table(),
    footprintKB: (pid) => (pid === ROOT + 4 ? 2.1e9 / 1024 : 0),
    residentKB: (pid) => (pid === ROOT + 4 ? 1.4e9 / 1024 : 0),
    lstartOf: async (pids) => new Map(pids.map((p) => [p, psLstart(p === ROOT || p === ROOT + 4 ? startedAt : T0 - 86_400_000)])),
    statOf: async (pids) => new Map(pids.map((p) => [p, stops.includes(p) ? "T" : "S"])),
    signal: (pid, sig) => { if (sig === "SIGSTOP") stops.push(Math.abs(pid)); },
    sessions: () => [session],
    natives: () => [],
    guardRoles: () => ({ serverPid: SERVER, sidecarPids: [], cliPids: [CLI] }),
    xpcServicePids: async () => [],
    outsidePeers: async () => [],
    ledger: createSwapFreezeLedger({ read: () => ledgerText, write: (t) => { ledgerText = t; }, log: (l) => logs.push(l) }),
    log: (line) => logs.push(line),
  });
  const beat = () => freezer.tick({
    swap: { sustained: true, pagesReadBackPerS: 33.6, debtGBPerMin: 8.8, swapPct: null, coveredMs: 120_000 },
    held: { measurable: true, latestGB: 4, heldGB: 4, coveredMs: 120_000 },
    brake: { interrupted: false, skipped: "noHeavyRun" },
  });
  await beat();
  clock += 10_000;
  await beat();
  return { stops, logs };
}

test("the same line started 10 minutes after the background record is never frozen, and the log says why", async () => {
  const { stops, logs } = await freezeBeats(T0 + 600_000);
  expect(stops, "a foreground command is killed by its CLI on a clock that never stopped").toEqual([]);
  expect(logs.join("\n")).toContain("started after its background record");
});

test("a process started just before its record arrived (the async hook) is the command it announced", async () => {
  const { stops } = await freezeBeats(T0 - 2_000);
  expect(stops).toContain(ROOT);
});
