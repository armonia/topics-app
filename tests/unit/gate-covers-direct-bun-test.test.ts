/**
 * THE SEMAPHORE ALSO COVERS THE COMMAND TYPED BY HAND, not just the script.
 *
 * WHAT WAS MEASURED, 2026-08-27 at 02:40, with the board declaring a cap of one
 * agent: loadavg 52.9 on 12 cores, 90 node/bun processes, and TWO full `bun
 * test` runs alive together from the SAME worktree - 12 min 54 s and about 4
 * min old. Both had been launched as `bun test --timeout 30000 --reporter=junit
 * --reporter-outfile=/tmp/unit.xml ...`, i.e. the command that `test:unit`
 * wraps, without the wrapper. `scripts/slot.ts` was in place and had nothing to
 * do with it: the brake was in the SCRIPT, so the direct entrance had no brake
 * at all.
 *
 * WHY THE BENCH LOOKS LIKE THIS. The only honest question is "were the two runs
 * ALIVE AT THE SAME TIME", and two fixed sleeps answer it badly: under load one
 * run can start seconds after the other and miss it without any brake being
 * involved. The fixture rendezvouses instead (see its header), so a miss means
 * the semaphore, not the scheduler.
 *
 * IT IS SEEN RED. The second case runs exactly the same two commands with the
 * throttle switched off and demands the overlap: that is today's behaviour, the
 * defect the first case says is gone. If the preload stopped taking a slot, the
 * first case fails and the second still passes.
 * @covers SLOT-02
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const FIXTURE = "./tests/fixtures/gate-slot-witness.ts";
/** Long enough to absorb bun's startup under load, short enough for a suite. */
const RENDEZVOUS_MS = 4000;
/** How long each run holds after the rendezvous, so its window has a width. */
const DWELL_MS = 300;

let dir = "";
let witness = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gate-direct-"));
  witness = join(dir, "witness.log");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/**
 * The environment of a run that went through NO script.
 *
 * `TOPICS_GATE_HELD` is stripped on purpose: this suite is itself running
 * inside a slot taken by `test:unit`, and inheriting its cover would mean
 * measuring nothing. The slot directory is private for the same reason - the
 * bench must not fight the machine's real counter, nor hold it.
 */
function env(extra: Record<string, string>): Record<string, string> {
  const base = { ...(process.env as Record<string, string>) };
  delete base.TOPICS_GATE_HELD;
  return {
    ...base,
    TOPICS_GATE_SLOT_DIR: dir,
    TOPICS_GATE_WITNESS_WAIT: String(RENDEZVOUS_MS),
    TOPICS_GATE_WITNESS_DWELL: String(DWELL_MS),
    ...extra,
  };
}

/** A DIRECT `bun test`: the shape of the command that was measured. */
function direct(extra: Record<string, string>, args: string[] = [FIXTURE]) {
  return Bun.spawn(["bun", "test", ...args], {
    cwd: REPO_ROOT,
    env: env(extra),
    stdout: "pipe",
    stderr: "pipe",
  });
}

interface Window { pid: number; start: number; end: number }

function windows(): Window[] {
  const byPid = new Map<number, Partial<Window>>();
  for (const line of readFileSync(witness, "utf8").split("\n")) {
    const m = /^(start|end) (\d+) (\d+)$/.exec(line.trim());
    if (!m) continue;
    const pid = Number(m[2]);
    const w = byPid.get(pid) ?? { pid };
    if (m[1] === "start") w.start = Number(m[3]); else w.end = Number(m[3]);
    byPid.set(pid, w);
  }
  return [...byPid.values()].filter((w): w is Window => w.start != null && w.end != null);
}

function overlap(a: Window, b: Window): number {
  return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

describe("two `bun test` typed by hand", () => {
  it("do not run at the same time: the slot is taken from inside the run", async () => {
    const runs = [
      direct({ TOPICS_GATE_SLOTS: "1", TOPICS_GATE_WITNESS: witness }),
      direct({ TOPICS_GATE_SLOTS: "1", TOPICS_GATE_WITNESS: witness }),
    ];
    const codes = await Promise.all(runs.map((p) => p.exited));
    expect(codes).toEqual([0, 0]);

    const w = windows();
    expect(w.length, "both runs must have left their window in the witness").toBe(2);
    expect(
      overlap(w[0], w[1]),
      "the two runs were alive together: the direct command walked past the semaphore",
    ).toBeLessThanOrEqual(0);
  }, 120_000);

  it("and with the throttle off they DO overlap: the bench is not empty", async () => {
    const runs = [
      direct({ TOPICS_GATE_SLOTS: "0", TOPICS_GATE_WITNESS: witness }),
      direct({ TOPICS_GATE_SLOTS: "0", TOPICS_GATE_WITNESS: witness }),
    ];
    await Promise.all(runs.map((p) => p.exited));

    const w = windows();
    expect(w.length).toBe(2);
    // Half the dwell, not a bare zero: two unthrottled runs recognise each
    // other in under a millisecond, so a bare `> 0` is a coin toss on the
    // clock's granularity. It failed on exactly that, first run of this bench.
    expect(
      overlap(w[0], w[1]),
      "with no throttle the two runs must meet, or this bench proves nothing about the case above",
    ).toBeGreaterThan(DWELL_MS / 2);
  }, 120_000);
});

describe("the cover of whoever already holds a slot", () => {
  /** Holds every slot with a pid that is alive: this very process. */
  function fillTheOnlySlot(): void {
    Bun.write(join(dir, "0.pid"), String(process.pid));
  }

  it("a run under `bun run test:unit` does not queue behind its own parent", async () => {
    fillTheOnlySlot();
    const started = Date.now();
    const p = direct({
      TOPICS_GATE_SLOTS: "1",
      TOPICS_GATE_HELD: "test:unit",
      TOPICS_GATE_MAX_WAIT_MS: "60000",
    });
    expect(await p.exited).toBe(0);
    // Without the cover this would sit in the queue for the whole wait: the
    // slot it is waiting for is held by the process that launched it.
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 120_000);

  it("without the cover it waits, and then runs anyway rather than blocking a gate", async () => {
    fillTheOnlySlot();
    const started = Date.now();
    const p = direct({ TOPICS_GATE_SLOTS: "1", TOPICS_GATE_MAX_WAIT_MS: "1500" });
    expect(await p.exited, "the semaphore must never refuse to run a command").toBe(0);
    expect(Date.now() - started, "it did not even try to queue").toBeGreaterThanOrEqual(1500);
  }, 120_000);
});

describe("two runs on one junit file", () => {
  it("the second is refused instead of overwriting the first's verdict", async () => {
    const outfile = join(dir, "unit.xml");
    // The throttle is OFF on purpose: serialising them would hide the
    // collision, and the point here is what happens when they DO meet.
    const first = direct({
      TOPICS_GATE_SLOTS: "0",
      TOPICS_GATE_WITNESS: witness,
    }, [`--reporter=junit`, `--reporter-outfile=${outfile}`, FIXTURE]);

    // Deterministic instead of a sleep: wait until the first run has claimed
    // the path, which is the state the second one has to collide with.
    const claimed = Date.now() + 30_000;
    while (Date.now() < claimed && !readdirSync(dir).some((n) => n.startsWith("out-"))) {
      await Bun.sleep(50);
    }
    expect(readdirSync(dir).some((n) => n.startsWith("out-")), "the first run never claimed its output file").toBe(true);

    const second = direct({
      TOPICS_GATE_SLOTS: "0",
    }, [`--reporter=junit`, `--reporter-outfile=${outfile}`, FIXTURE]);
    const secondCode = await second.exited;
    const secondErr = await new Response(second.stderr).text();
    expect(await first.exited).toBe(0);

    expect(secondCode, "the second run wrote into the first one's report and called it its own").toBe(125);
    expect(secondErr).toContain("another live run is already writing");
    expect(readFileSync(outfile, "utf8"), "the report must be the first run's, whole").toContain("testsuite");
  }, 120_000);
});
