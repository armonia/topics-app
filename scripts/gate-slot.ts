/**
 * THE LOCK PROTOCOL OF THE GATE SEMAPHORE, in one place.
 *
 * WHY IT WAS EXTRACTED. `scripts/slot.ts` wrapped the four expensive scripts,
 * and the brake lived in the SCRIPT: `bun run test:unit` passed the semaphore,
 * `bun test ./client/src ./server ...` typed by hand did not. Measured on
 * 2026-08-27 at 02:40 with the board declaring a cap of one agent: loadavg 52.9
 * on 12 cores, 90 node/bun processes, and TWO full `bun test` runs alive at
 * once from the SAME worktree, one 12 min 54 s old and the other about 4 min.
 * Neither had gone through a slot, because neither had gone through a script.
 *
 * So the counter has to be reachable from BELOW the scripts too: from inside
 * the test process itself (`tests/setup/bun-test-preload.ts`, which bun loads
 * for every `bun test` run in this repo). Two callers, one protocol, one
 * directory of lock files: this module.
 *
 * IT FAILS OPEN, ALWAYS, exactly like the wrapper that used to own it. Every
 * error path returns "no slot held" and lets the caller run. A throttle that
 * can block a gate is worse than no throttle: it would turn a bug in this file
 * into a turn that never finishes.
 *
 * Env: TOPICS_GATE_SLOTS      how many may run at once (default cores/4, min 2)
 *      TOPICS_GATE_SLOTS=0 or CI  disables the throttle entirely
 *      TOPICS_GATE_SLOT_DIR   where the lock files live (tests use their own)
 *      TOPICS_GATE_HELD       set by whoever already holds one, so a nested run
 *                             does not queue behind its own parent
 *      TOPICS_GATE_MAX_WAIT_MS  how long to queue before running unthrottled
 */
import { cpus } from "node:os";
import { createHash } from "node:crypto";
import { mkdirSync, openSync, closeSync, writeSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Machine-wide by default. Overridable so a test can hold its own counter
 * instead of fighting the real one - the tests of this file run inside
 * `test:unit`, which is itself holding a slot while they execute.
 */
export function slotDir(): string {
  return process.env.TOPICS_GATE_SLOT_DIR || "/tmp/topics-gate-slots"; // allow-shared-tmp: the counter IS machine-wide, that is its whole point
}

/**
 * The marker that says "this process tree is already inside a slot".
 *
 * Without it the semaphore would deadlock against itself the moment it moved
 * below the scripts: `bun run test:unit` takes a slot in the wrapper and then
 * the test process would ask for a second one, and with a single slot free the
 * suite would wait for a slot its own parent is holding.
 */
export const GATE_HELD_ENV = "TOPICS_GATE_HELD";

// The line `slot.ts` prints when it holds a slot, read by the board's check
// runner to restart its cap: see shared/slot-acquired.ts. Only the writing
// side is re-exported here; whoever READS the line (review-checks) imports it
// from shared/ directly, so re-exporting the prefix and the parser too would
// be three names nobody reaches through this module.
export { slotAcquiredLine } from "../shared/slot-acquired";

/**
 * Past this, waiting has cost more than the contention it was avoiding.
 * `TOPICS_GATE_MAX_WAIT_MS` moves it, which is also how a bench measures the
 * queue without sitting in it for ten minutes.
 */
function defaultMaxWaitMs(): number {
  const raw = process.env.TOPICS_GATE_MAX_WAIT_MS;
  if (raw == null || raw === "") return 10 * 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 10 * 60_000;
}
const POLL_MS = 700;

/** True when this process is already covered by a slot somebody else took. */
export function alreadyHeld(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[GATE_HELD_ENV];
  return v != null && v !== "" && v !== "0";
}

export function slotCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TOPICS_GATE_SLOTS;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
  }
  // A full suite, a tsc and an eslint each happily take several cores. A quarter
  // of the machine per concurrent gate leaves room for the app, the server and
  // the person using them.
  if (env.CI) return 0;
  return Math.max(2, Math.floor((cpus().length || 4) / 4));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** A slot whose holder is gone is free: a killed run must not park a slot forever. */
function reapStale(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".pid")) continue;
    const p = join(dir, name);
    try {
      const pid = Number(readFileSync(p, "utf8").trim());
      if (!Number.isFinite(pid) || !alive(pid)) unlinkSync(p);
    } catch { /* someone else reaped it first */ }
  }
}

/**
 * Takes a lock file by exclusive create, or returns null if it is taken by a
 * process that is still alive. `wx` is the whole mutual exclusion: exclusive
 * create is atomic, so two callers racing for the same name cannot both win.
 */
function takeFile(path: string): (() => void) | null {
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { unlinkSync(path); } catch { /* already reaped */ }
    };
  } catch { return null; }
}

interface AcquireOptions {
  /** How long to queue before giving up and running unthrottled. */
  maxWaitMs?: number;
  /** Where the wait notices go. Silent by default in a test process. */
  onWait?: (message: string) => void;
}

/**
 * Returns the release function, or null when it gave up and the caller should
 * run anyway (unthrottled). Never throws: see the header.
 */
export function acquireSlot(slots: number, label: string, opts: AcquireOptions = {}): (() => void) | null {
  const dir = slotDir();
  const maxWaitMs = opts.maxWaitMs ?? defaultMaxWaitMs();
  const notify = opts.onWait ?? ((m: string) => console.error(m));
  try {
    mkdirSync(dir, { recursive: true });
    const deadline = Date.now() + maxWaitMs;
    let announced = false;
    for (;;) {
      reapStale(dir);
      for (let i = 0; i < slots; i++) {
        const release = takeFile(join(dir, `${i}.pid`));
        if (release) return release;
      }
      if (Date.now() >= deadline) {
        notify(`[slot] ${label}: ${Math.round(maxWaitMs / 60_000)} min of waiting, running anyway (unthrottled).`);
        return null;
      }
      if (!announced) {
        announced = true;
        notify(`[slot] ${label}: all ${slots} gate slots are busy, waiting for one.`);
      }
      Bun.sleepSync(POLL_MS);
    }
  } catch (e) {
    notify(`[slot] ${label}: throttle unavailable (${e instanceof Error ? e.message : e}), running unthrottled.`);
    return null;
  }
}

/**
 * WHO IS WRITING THAT FILE, so two runs cannot report into the same one.
 *
 * The second half of the same measurement: both of those `bun test` runs were
 * writing `/tmp/unit.xml`, a path nothing in the repo had ever declared. The
 * later one overwrote the earlier one, so whoever read that file read a verdict
 * that could belong to another run - and a gate that promotes or fails a
 * delivery on somebody else's result is worse than a gate that is simply slow.
 *
 * The claim lives next to the slots, keyed by the ABSOLUTE output path, and it
 * is reaped by liveness like a slot: a claim left behind by a dead run is not a
 * claim. Returns the release function, or null when a LIVE process holds it.
 */
export function claimOutfile(absolutePath: string): (() => void) | null {
  const dir = slotDir();
  try {
    mkdirSync(dir, { recursive: true });
    const key = createHash("sha1").update(absolutePath).digest("hex").slice(0, 16);
    const p = join(dir, `out-${key}.pid`);
    const taken = takeFile(p);
    if (taken) return taken;
    // Taken: only a LIVE holder counts. Anything else - an unreadable file, a
    // pid that is gone - is rubbish from a dead run and gets cleared, because
    // refusing on rubbish is the one failure mode this must not have.
    let holder = 0;
    try { holder = Number(readFileSync(p, "utf8").trim()); } catch { holder = 0; }
    if (Number.isFinite(holder) && holder > 0 && alive(holder)) return null;
    try { unlinkSync(p); } catch { /* someone else cleared it first */ }
    return takeFile(p) ?? (() => {});
  } catch {
    // Fails open like the rest: if the claim cannot be written, nobody is
    // stopped. What must never happen is a broken claim file blocking a run.
    return () => {};
  }
}
