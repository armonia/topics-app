/**
 * The machine readout: ps and PowerShell lines, Windows CPU between two
 * readings, the sleep keeper's screen file, the cached reader.
 *
 * @covers HUBBR-21
 */
import { describe, expect, test } from "bun:test";
import {
  createMachineReadout, groupProcs, parsePsLines, parseScreenFile, parseWinProcLines, programName, winCpuBetween,
} from "./machine-readout";

/**
 * The screen file EXACTLY as wf-autosleep's Write-Stato writes it (copied from allow-italian: names the keeper's own function
 * the PC): `sospendeAlle` is `Epoch-Ms`, a NUMBER; a running job carries `da`
 * (ISO) and `secondi`; an outcome is ok | fallito | interrotto. The keys are allow-italian: the keeper's wire values
 * the keeper's own, in Italian.
 */
const SLEEPS_AT = Date.parse("2026-11-08T19:52:14+01:00");
const SCREEN = `\uFEFFwindow.STATO = {
    "versione":  1,
    "ora":  "2026-11-08T19:32:14+01:00",
    "sogliaMinuti":  20,
    "sospendeAlle":  ${SLEEPS_AT},
    "motivi":  [ "Il Mac è collegato al PC", "" ],
    "lavori":  [ { "progetto": "acme-web", "cosa": "test", "chi": "Mac", "da": "2026-11-08T19:30:00+01:00", "secondi": 134 } ],
    "esiti":  [
        { "progetto": "acme-web", "cosa": "test", "esito": "fallito", "secondi": 86, "fine": "2026-11-08T19:32:14+01:00" },
        { "progetto": "studio-x", "cosa": "build", "esito": "ok", "secondi": 78, "fine": "2026-11-08T19:32:02+01:00" },
        { "progetto": "studio-x", "cosa": "e2e", "esito": "interrotto", "secondi": 12, "fine": "2026-11-08T19:20:00+01:00" }
    ]
};`;

/** At rest: nothing keeps it awake, so the keeper names the time it will sleep, and lists nothing. */
const SCREEN_AT_REST = `\uFEFFwindow.STATO = {
    "versione":  1,
    "ora":  "2026-11-08T20:55:00+01:00",
    "sogliaMinuti":  20,
    "sospendeAlle":  1794168600000,
    "motivi":  [],
    "lavori":  [],
    "esiti":  []
};
`;

describe("machine readout parsers", () => {
  test("program names drop the folder and the .exe", () => {
    expect(programName("C:\\Program Files\\Microsoft VS Code\\Code.exe")).toBe("Code");
    expect(programName("/usr/local/bin/node")).toBe("node");
  });

  test("ps lines keep a command with spaces whole", () => {
    const rows = parsePsLines("  101  204800  12.5 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n  7 1024 0,0 node\nnoise\n");
    expect(rows).toEqual([
      { pid: 101, name: "Google Chrome", memMB: 200, cpuPct: 12.5, cpuSeconds: null },
      { pid: 7, name: "node", memMB: 1, cpuPct: 0, cpuSeconds: null },
    ]);
  });

  test("PowerShell lines: an empty CPU is not measured, not zero", () => {
    const rows = parseWinProcLines("node|42|12,5|104857600\r\nIdle|0||8192\r\nbroken line\r\n");
    expect(rows[0]).toEqual({ pid: 42, name: "node", memMB: 100, cpuPct: null, cpuSeconds: 12.5 });
    expect(rows[1].cpuSeconds).toBeNull();
    expect(rows).toHaveLength(2);
  });

  test("Windows CPU is the difference of two readings, in % of one core", () => {
    const cur = parseWinProcLines("node|42|15|1048576\nnew|43|3|1048576\nreused|44|1|1048576");
    const out = winCpuBetween(new Map([[42, 12], [44, 9]]), cur, 10);
    expect(out[0].cpuPct).toBe(30);
    expect(out[1].cpuPct).toBeNull(); // first seen
    expect(out[2].cpuPct).toBeNull(); // counter went back: another process on the same pid
  });

  test("groups by program, heaviest first, with the rest summed", () => {
    const rows = [
      { pid: 1, name: "node", memMB: 300, cpuPct: 10, cpuSeconds: null },
      { pid: 2, name: "Node", memMB: 200, cpuPct: null, cpuSeconds: null },
      { pid: 3, name: "chrome", memMB: 400, cpuPct: null, cpuSeconds: null },
      { pid: 4, name: "tiny", memMB: 5, cpuPct: 1, cpuSeconds: null },
    ];
    const g = groupProcs(rows, 2);
    expect(g.procs).toEqual([
      { name: "node", count: 2, memMB: 500, cpuPct: 10 },
      { name: "chrome", count: 1, memMB: 400, cpuPct: null },
    ]);
    expect(g.rest).toEqual({ count: 1, memMB: 5 });
  });

  test("the screen file: countdown, jobs and outcomes", () => {
    const s = parseScreenFile(SCREEN)!;
    expect(s.thresholdMin).toBe(20);
    expect(s.sleepsAt).toBe(SLEEPS_AT);
    expect(s.reasons).toEqual(["Il Mac è collegato al PC"]);
    expect(s.jobs).toEqual([{ project: "acme-web", what: "test", who: "Mac", since: Date.parse("2026-11-08T19:30:00+01:00") }]);
    expect(s.outcomes.map((o) => o.ok)).toEqual([false, true, null]);
    expect(s.outcomes.map((o) => o.interrupted)).toEqual([false, false, true]);
  });

  test("at rest the countdown is the keeper's epoch-ms number, not lost to a string-only parser", () => {
    const s = parseScreenFile(SCREEN_AT_REST)!;
    expect(s.sleepsAt).toBe(1794168600000);
    expect(s.reasons).toEqual([]);
    expect(s.jobs).toEqual([]);
  });

  test("a time in seconds or as a string is read too; a null is no time", () => {
    const at = (v: string) => parseScreenFile(`window.STATO = { "sospendeAlle": ${v} };`)?.sleepsAt;
    expect(at("1794168600")).toBe(1794168600000);
    expect(at('"2026-11-08T21:10:00+01:00"')).toBe(Date.parse("2026-11-08T21:10:00+01:00"));
    expect(at("null")).toBeNull();
  });

  test("a file that does not parse is no reading at all", () => {
    expect(parseScreenFile("window.STATO = {")).toBeNull();
    expect(parseScreenFile("[]")).toBeNull();
  });
});

describe("createMachineReadout", () => {
  test("Windows: the second reading has the CPU, and the cache serves within the ttl", async () => {
    let t = 1_000_000;
    let calls = 0;
    const lists = ["node|42|10|1048576", "node|42|12|1048576"];
    const read = createMachineReadout({
      platform: "win32", cores: () => 8, memTotalMB: () => 32768, now: () => t, ttlMs: 5_000,
      listProcesses: async () => lists[Math.min(calls++, 1)],
      readScreenFile: async () => SCREEN,
    });
    const first = await read();
    expect(first.procs[0].cpuPct).toBeNull();
    expect(first.memMetric).toBe("working-set");
    expect(first.screen?.thresholdMin).toBe(20);
    t += 1_000;
    expect(await read()).toBe(first);
    t += 9_000;
    const second = await read();
    expect(second.procs[0].cpuPct).toBe(20);
    expect(calls).toBe(2);
  });

  test("a broken process list still reads the screen file", async () => {
    const read = createMachineReadout({
      platform: "darwin", cores: () => 12, memTotalMB: () => null, now: () => 1,
      listProcesses: async () => { throw new Error("ps missing"); },
      readScreenFile: async () => SCREEN,
    });
    const r = await read();
    expect(r.procs).toEqual([]);
    expect(r.screen).not.toBeNull();
  });
});
