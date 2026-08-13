#!/usr/bin/env bun
/**
 * A MACHINE-WIDE SLOT for the expensive commands, so the agent cap does not have
 * to stand in for one.
 *
 * WHAT WAS MEASURED. With 8 agents in flight the agents themselves summed to
 * 5.7% CPU: they sit waiting on the API and cost almost nothing. The load came
 * from their GATES — seven full `bun test` runs at once (653 files, ~9000
 * tests), plus eslint and three tsc, for 140% CPU in one instantaneous sample
 * and a 15-minute load average of 38 on a 12-core machine. Capping agents to
 * control that is aiming at the wrong number: it throttles the cheap thing and
 * leaves the expensive one unbounded.
 *
 * Seven concurrent full suites on twelve cores do not finish in the time one
 * takes. They each take about seven times longer, and the machine is unusable
 * meanwhile. Serialising them to a few at a time costs nothing in total work and
 * gives every single run back its normal duration.
 *
 * WHY A LOCK ON DISK, and not a queue inside the server. The callers do not
 * share a process: an agent runs `bun run test:unit` from its own worktree, the
 * board runs review checks from another, a person runs it in a terminal. The one
 * thing they do share is the filesystem, so that is where the counter lives.
 *
 * IT FAILS OPEN, ALWAYS. Every error path here runs the command anyway. A
 * throttle that can block a gate is worse than no throttle: it would turn a
 * bug in this file into a turn that never finishes. The wait is bounded too —
 * past the deadline it gives up waiting and runs, rather than holding a caller
 * forever behind a slot that never frees.
 *
 * Usage:  bun run scripts/slot.ts <label> -- <command...>
 * Env:    TOPICS_GATE_SLOTS  how many may run at once (default: cores/4, min 2)
 *         TOPICS_GATE_SLOTS=0 or CI  disables the throttle entirely
 */
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { mkdirSync, openSync, closeSync, writeSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Machine-wide by default. Overridable so the test can hold its own counter
 *  instead of fighting the real one — this file runs inside `test:unit`, which
 *  is itself holding a slot while the test executes. */
const SLOT_DIR = process.env.TOPICS_GATE_SLOT_DIR || "/tmp/topics-gate-slots";
/** Past this, waiting has cost more than the contention it was avoiding. */
const MAX_WAIT_MS = 10 * 60_000;
const POLL_MS = 700;

function slotCount(): number {
  const raw = process.env.TOPICS_GATE_SLOTS;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
  }
  // A full suite, a tsc and an eslint each happily take several cores. A quarter
  // of the machine per concurrent gate leaves room for the app, the server and
  // the person using them.
  if (process.env.CI) return 0;
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

/** Returns the release function, or null when it gave up and is running anyway. */
function acquire(slots: number, label: string): (() => void) | null {
  mkdirSync(SLOT_DIR, { recursive: true });
  const deadline = Date.now() + MAX_WAIT_MS;
  let announced = false;
  for (;;) {
    reapStale(SLOT_DIR);
    for (let i = 0; i < slots; i++) {
      const p = join(SLOT_DIR, `${i}.pid`);
      try {
        // 'wx' is the whole mutual exclusion: exclusive create is atomic, so two
        // callers racing for the same slot cannot both win it.
        const fd = openSync(p, "wx");
        writeSync(fd, String(process.pid));
        closeSync(fd);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try { unlinkSync(p); } catch { /* already reaped */ }
        };
      } catch { /* taken; try the next one */ }
    }
    if (Date.now() >= deadline) {
      console.error(`[slot] ${label}: ${Math.round(MAX_WAIT_MS / 60_000)} min of waiting, running anyway (unthrottled).`);
      return null;
    }
    if (!announced) {
      announced = true;
      console.error(`[slot] ${label}: all ${slots} gate slots are busy, waiting for one.`);
    }
    Bun.sleepSync(POLL_MS);
  }
}

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const label = sep > 0 ? argv.slice(0, sep).join(" ") : "gate";
const cmd = (sep >= 0 ? argv.slice(sep + 1) : argv).join(" ");
if (!cmd) {
  console.error("usage: bun run scripts/slot.ts <label> -- <command...>");
  process.exit(2);
}

const slots = slotCount();
let release: (() => void) | null = null;
if (slots > 0) {
  // Even acquiring must not be able to stop the command: any throw here means
  // the throttle is broken, and a broken throttle runs everything.
  try { release = acquire(slots, label); } catch (e) {
    console.error(`[slot] ${label}: throttle unavailable (${e instanceof Error ? e.message : e}), running unthrottled.`);
  }
}

// `-c`, NOT `-lc`. A login shell sources the user's profile, and this machine's
// profile exports a NODE_OPTIONS that eslint refuses to start under
// ("--disable-warning= is not allowed"). The wrapped command must run in the
// same bare environment `bun run` would have given it, or wrapping a gate
// changes its result — which is the one thing a throttle must never do.
const child = spawn("/bin/sh", ["-c", cmd], { stdio: "inherit" });
let done = false;
const finish = (code: number): never => {
  if (!done) { done = true; release?.(); }
  process.exit(code);
};
// The slot has to come back on a Ctrl-C or a reaper kill too, not only on a
// clean exit — otherwise one interrupted run leaks a slot until the next reap.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => { child.kill(sig); release?.(); });
}
process.on("exit", () => release?.());
child.on("error", (e) => { console.error(`[slot] ${label}: ${e.message}`); finish(1); });
child.on("exit", (code, signal) => finish(signal ? 1 : (code ?? 0)));
