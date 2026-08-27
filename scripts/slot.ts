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
 * IT ALSO BOUNDS THE RUN. Misurato il 2026-08-14 su questa macchina: tre alberi
 * `bun test` vivi da 12, 18 e 22 ore, con 4, 7 e 9 minuti di CPU in tutto — cioè
 * fermi, non lenti, ognuno con il suo stdout su un socket senza più nessuno
 * dall'altra parte. Un cancello appeso non fallisce e non finisce: non dà mai un
 * verde né un rosso, tiene il suo slot finché non lo si reap-a a mano, e ha
 * tenuto ~700 MB per un giorno. Il limite di wall-clock lo trasforma in quello
 * che è, un rosso: SIGTERM all'intero gruppo di processi, grazia, poi SIGKILL, e
 * uscita 124 come `timeout(1)`. Non fallisce mai APERTO come il resto del file —
 * qui aprire vorrebbe dire lasciar passare esattamente il caso che si sta
 * misurando.
 *
 * Usage:  bun run scripts/slot.ts <label> -- <command...>
 * Env:    TOPICS_GATE_SLOTS  how many may run at once (default: cores/4, min 2)
 *         TOPICS_GATE_SLOTS=0 or CI  disables the throttle entirely
 *         TOPICS_GATE_MAX_RUN_MS  wall-clock cap (default 60 min; 0 disables)
 *         TOPICS_GATE_KILL_GRACE_MS  SIGTERM → SIGKILL window (default 10s)
 */
import { spawn } from "node:child_process";
import { acquireSlot, slotCount, GATE_HELD_ENV } from "./gate-slot.ts";

/**
 * THE LOCK PROTOCOL LIVES IN `gate-slot.ts`, not here any more: the same
 * counter is now taken from inside the test process too (see
 * `tests/setup/bun-test-preload.ts`), because a brake that only exists in the
 * script is a brake a hand-typed `bun test` walks straight past.
 */

/** The clock starts AFTER the slot: queueing is not the command's time.
 *  An hour is many times the whole suite under contention, and a fraction of
 *  the 12 hours of the youngest of the hung trees that motivated the cap. */
const MAX_RUN_MS = envMs("TOPICS_GATE_MAX_RUN_MS", 60 * 60_000);
/** How long a command is given to die of its own accord (flush, cleanup). */
const KILL_GRACE_MS = envMs("TOPICS_GATE_KILL_GRACE_MS", 10_000);
/** The convention of `timeout(1)`, so whoever reads the code recognises it. */
const TIMEOUT_EXIT_CODE = 124;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
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
if (slots > 0) release = acquireSlot(slots, label);

// `-c`, NOT `-lc`. A login shell sources the user's profile, and this machine's
// profile exports a NODE_OPTIONS that eslint refuses to start under
// ("--disable-warning= is not allowed"). The wrapped command must run in the
// same bare environment `bun run` would have given it, or wrapping a gate
// changes its result — which is the one thing a throttle must never do.
// `detached` per avere un GRUPPO di processi tutto suo. Un `bun test` appeso non
// è mai un processo solo: è la shell, il runner e ciò che il runner ha spawnato.
// Uccidere il solo pid della shell lascia in piedi proprio i figli che tengono
// la memoria — e quelli erano il difetto. Con il gruppo, `kill(-pid)` li prende
// tutti in un colpo.
// The slot this process is holding covers everything it launches: the marker
// stops the preload inside a `bun test` child from queueing for a SECOND slot
// behind its own parent, which with one free slot would be a deadlock.
const child = spawn("/bin/sh", ["-c", cmd], {
  stdio: "inherit",
  detached: true,
  env: { ...process.env, [GATE_HELD_ENV]: label || "gate" },
});
let done = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let timedOut = false;

/** Il gruppo intero, con il singolo processo come ripiego se il pid non c'è. */
function signalTree(sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid == null) return;
  try { process.kill(-pid, sig); } catch { try { child.kill(sig); } catch { /* già morto */ } }
}

const finish = (code: number): never => {
  if (!done) { done = true; if (timer) clearTimeout(timer); release?.(); }
  process.exit(code);
};
// The slot has to come back on a Ctrl-C or a reaper kill too, not only on a
// clean exit — otherwise one interrupted run leaks a slot until the next reap.
// `detached` mette il comando fuori dal process group del terminale, quindi il
// Ctrl-C arriva solo qui: inoltrarlo al gruppo non è cortesia, è l'unico modo
// che ha di ricevere il segnale.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => { signalTree(sig); release?.(); });
}
process.on("exit", () => release?.());

if (MAX_RUN_MS > 0) {
  timer = setTimeout(() => {
    timedOut = true;
    console.error(
      `[slot] ${label}: ${Math.round(MAX_RUN_MS / 60_000)} min di wall-clock senza finire — abbatto il comando (uscita ${TIMEOUT_EXIT_CODE}).`,
    );
    signalTree("SIGTERM");
    // Chi ignora SIGTERM è esattamente chi è appeso: la seconda mossa non è
    // negoziabile, e non deve tenere sveglio il processo se il comando cede prima.
    setTimeout(() => signalTree("SIGKILL"), KILL_GRACE_MS).unref();
  }, MAX_RUN_MS);
  timer.unref();
}

child.on("error", (e) => { console.error(`[slot] ${label}: ${e.message}`); finish(1); });
child.on("exit", (code, signal) => finish(timedOut ? TIMEOUT_EXIT_CODE : signal ? 1 : (code ?? 0)));
