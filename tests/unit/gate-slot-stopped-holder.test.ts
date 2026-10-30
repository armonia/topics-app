/**
 * A STOPPED HOLDER DOES NOT HOLD (card cda99908, findings 2 and 15).
 *
 * Both freezers of the server send SIGSTOP to whole trees, `slot.ts` included,
 * and `kill(pid, 0)` reads a stopped process as alive. Before the fix a frozen
 * `typecheck` kept its name file and its numbered slot: every other run of the
 * gate waited the full name deadline and then started "alongside", together.
 *
 * The holder here is the parent of the test process: alive, never signalled.
 * Whether it is stopped is what the fake probe says, so no real signal is sent.
 *
 * @covers SLOT-02
 */
import { describe, it, expect, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSlot, parsePsStates, psStates, reclaimAfterStop, stoppedByPs } from "../../scripts/gate-slot.ts";

let dir = "";
const fresh = (): string => {
  dir = mkdtempSync(join(tmpdir(), "topics-slot-stopped-"));
  process.env.TOPICS_GATE_SLOT_DIR = dir;
  return dir;
};

afterEach(() => {
  delete process.env.TOPICS_GATE_SLOT_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

// Same key as `nameLockPath` in the module: the file a holder of that name writes.
const nameFile = (d: string, label: string) =>
  join(d, `name-${createHash("sha1").update(label.trim().toLowerCase()).digest("hex").slice(0, 12)}.pid`);

const holder = process.ppid;
const WAIT_MS = 250;

describe("the gate slot, against a stopped holder", () => {
  it("a stopped holder of the name and of the only slot lets the next run in at once", () => {
    const d = fresh();
    writeFileSync(nameFile(d, "typecheck"), String(holder));
    writeFileSync(join(d, "0.pid"), String(holder));
    const heard: string[] = [];
    const started = Date.now();
    const release = acquireSlot(1, "typecheck", {
      maxWaitMs: WAIT_MS,
      onWait: (m) => heard.push(m),
      stopped: (pids) => new Set(pids.filter((p) => p === holder)),
    });
    expect(release).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(WAIT_MS);
    expect(heard).toEqual([]);
    expect(readFileSync(nameFile(d, "typecheck"), "utf8")).toBe(String(process.pid));
    expect(readFileSync(join(d, "0.pid"), "utf8")).toBe(String(process.pid));
    release!();
  });

  it("a running holder still holds: the next run waits, as before", () => {
    const d = fresh();
    writeFileSync(nameFile(d, "typecheck"), String(holder));
    const heard: string[] = [];
    const release = acquireSlot(1, "typecheck", { maxWaitMs: WAIT_MS, onWait: (m) => heard.push(m), stopped: () => new Set() });
    expect(heard.some((m) => m.includes("running alongside"))).toBe(true);
    expect(readFileSync(nameFile(d, "typecheck"), "utf8")).toBe(String(holder));
    release?.();
  });

  it("a release never removes a file another run has taken since", () => {
    const d = fresh();
    const release = acquireSlot(1, "lint", { maxWaitMs: WAIT_MS, stopped: () => new Set() });
    expect(release).not.toBeNull();
    // This run was frozen, reaped, and its place taken by the next one.
    writeFileSync(nameFile(d, "lint"), String(holder));
    writeFileSync(join(d, "0.pid"), String(holder));
    release!();
    expect(existsSync(nameFile(d, "lint"))).toBe(true);
    expect(existsSync(join(d, "0.pid"))).toBe(true);
  });

  it("several waiters behind the same stopped holder take its name one at a time", async () => {
    // Review of 30/10: every waiter read the stopped pid, ran its `ps`, then
    // unlinked - the file the previous waiter had just taken. Up to four at once.
    const d = fresh();
    writeFileSync(nameFile(d, "typecheck"), String(process.pid));
    const log = join(d, "runs.log");
    const module = join(import.meta.dir, "../../scripts/gate-slot.ts");
    // The probe answers like `ps` does: after a while, and "stopped" only for
    // the frozen holder. The run holds its place long enough to be overlapped.
    const worker = `
      import { acquireSlot } from ${JSON.stringify(module)};
      import { appendFileSync } from "node:fs";
      const release = acquireSlot(4, "typecheck", {
        maxWaitMs: 20000,
        stopped: (pids) => { Bun.sleepSync(60); return new Set(pids.filter((p) => p === ${process.pid})); },
      });
      appendFileSync(${JSON.stringify(log)}, "start " + Date.now() + "\\n");
      Bun.sleepSync(300);
      appendFileSync(${JSON.stringify(log)}, "end " + Date.now() + "\\n");
      release?.();
    `;
    const runs = Array.from({ length: 4 }, () => new Promise<void>((resolve) => {
      spawn(process.execPath, ["-e", worker], { stdio: "ignore", env: { ...process.env, TOPICS_GATE_SLOT_DIR: d } })
        .on("exit", () => resolve());
    }));
    await Promise.all(runs);
    const events = readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" "))
      .map(([kind, t]) => ({ kind, t: Number(t) })).sort((a, b) => a.t - b.t || (a.kind === "end" ? -1 : 1));
    let running = 0;
    let most = 0;
    for (const e of events) { running += e.kind === "start" ? 1 : -1; most = Math.max(most, running); }
    expect(events.filter((e) => e.kind === "start")).toHaveLength(4);
    expect(most).toBe(1);
  }, 30_000);
});

describe("a run continued after a freeze", () => {
  const goneSoon = (): number => Bun.spawnSync(["true"]).pid;

  it("still holding its place, goes on untouched", () => {
    fresh();
    const hold = acquireSlot(1, "lint", { maxWaitMs: WAIT_MS, stopped: () => new Set() });
    const signals: string[] = [];
    expect(reclaimAfterStop(hold!, 1, "lint", (s) => signals.push(s))).toBe(hold);
    expect(signals).toEqual([]);
    hold!();
  });

  it("whose place was taken, stops its command until it holds one again", () => {
    const d = fresh();
    const hold = acquireSlot(1, "lint", { maxWaitMs: WAIT_MS, stopped: () => new Set() });
    // Frozen, reaped, and its name taken by a run that is still going.
    writeFileSync(nameFile(d, "lint"), String(holder));
    const signals: string[] = [];
    const started = Date.now();
    const again = reclaimAfterStop(hold!, 1, "lint", (s) => signals.push(`${s} ${Date.now() - started}`), {
      maxWaitMs: WAIT_MS,
      onWait: () => {},
      stopped: () => new Set(),
    });
    expect(signals.map((s) => s.split(" ")[0])).toEqual(["SIGSTOP", "SIGCONT"]);
    // The command stayed stopped for the whole wait behind the other run.
    expect(Number(signals[1]!.split(" ")[1])).toBeGreaterThanOrEqual(WAIT_MS);
    // The other run's name is not touched; this one had the free slot back.
    expect(readFileSync(nameFile(d, "lint"), "utf8")).toBe(String(holder));
    again?.();
  });

  it("whose place is free again, takes it back before its command goes on", () => {
    const d = fresh();
    const hold = acquireSlot(1, "lint", { maxWaitMs: WAIT_MS, stopped: () => new Set() });
    // The run that took the place has finished meanwhile without releasing.
    writeFileSync(nameFile(d, "lint"), String(goneSoon()));
    writeFileSync(join(d, "0.pid"), String(goneSoon()));
    const atContinue: string[] = [];
    const again = reclaimAfterStop(hold!, 1, "lint", (s) => {
      if (s === "SIGCONT") atContinue.push(readFileSync(nameFile(d, "lint"), "utf8"), readFileSync(join(d, "0.pid"), "utf8"));
    }, { maxWaitMs: WAIT_MS, stopped: () => new Set() });
    expect(again).not.toBeNull();
    expect(atContinue).toEqual([String(process.pid), String(process.pid)]);
    again!();
    expect(existsSync(nameFile(d, "lint"))).toBe(false);
  });
});

describe("the probe of stopped holders", () => {
  it("reads the state column of ps, a stopped one starting with T", () => {
    expect(parsePsStates("  412 T\n  413 Ss+\n 9001 T+\n\n")).toEqual(new Map([[412, "T"], [413, "Ss+"], [9001, "T+"]]));
  });

  it("asks the real ps, and a running process is not stopped", () => {
    // The production probe, run as such: no signal, only this test process.
    expect(psStates([process.pid]).get(process.pid)).toMatch(/^[RSD]/);
    expect(stoppedByPs([process.pid]).has(process.pid)).toBe(false);
  });
});
