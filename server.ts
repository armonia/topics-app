/**
 * The server's entry point: the process-level safety nets, then the boot as a chain
 * of stages.
 *
 * The boot used to be one 7,700-line top-level script sharing a single lexical scope.
 * It now lives in `server/boot/*`, one stage per concern, run here in the original
 * order. A stage receives everything the stages before it produced (`scope`, typed in
 * `server/boot/scope.ts`) and returns what the stages after it read. A binding that
 * must be read before its owner has run, or reassigned across stages, lives in
 * `server/boot/late.ts`. The HTTP/WebSocket front door is `server/routes/front-door.ts`.
 *
 * Order matters: each stage may depend on the side effects of the ones above it.
 */
import { acquireLock, LiveLockError, worktreeIsolationHome, worktreeIsolationEnv } from "./server/services/daemon-state";
import { readOwnerMarker } from "./server/services/worktree-owner";
import { homedir } from "os";
import { loadProcessRegistry } from "./server/routes/processes";
import { bootCore } from "./server/boot/core";
import { bootBrowser } from "./server/boot/browser";
import { bootTracker } from "./server/boot/tracker";
import { bootRoutersFirst } from "./server/boot/routers-first";
import { bootDispatchPrep } from "./server/boot/dispatch-prep";
import { bootHeadlessTurns } from "./server/boot/headless-turns";
import { bootDispatcher } from "./server/boot/dispatcher";
import { bootQuiescence } from "./server/boot/quiescence";
import { bootPreviewDelivery } from "./server/boot/preview-delivery";
import { bootTasksRouter } from "./server/boot/tasks-router";
import { bootRoutersSecond } from "./server/boot/routers-second";
import { bootHeartbeat } from "./server/boot/heartbeat";
import { bootTerminalsWs } from "./server/boot/terminals-ws";
import { bootBootSweeps } from "./server/boot/boot-sweeps";
import { bootHttp } from "./server/boot/http";
import { bootFront } from "./server/boot/front";
import { bootListen } from "./server/boot/listen";
import { bootStaleStreams } from "./server/boot/stale-streams";
import { bootGovernor } from "./server/boot/governor";
import { bootReattach } from "./server/boot/reattach";
import { bootDeliveryAudit } from "./server/boot/delivery-audit";
import { bootRelay } from "./server/boot/relay";
import { bootPostListen } from "./server/boot/post-listen";
import { bootTimersShutdown } from "./server/boot/timers-shutdown";
import { applyFencedReadOnly, isFencedWriteError } from "./server/db";


// The checkout's HEAD when this process started. Read once: the scripts that
// move the checkout compare it with what they asked for.
const BOOT_COMMIT: string | null = (() => {
  try {
    const out = Bun.spawnSync(["git", "-C", import.meta.dir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    const sha = out.stdout.toString().trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch { return null; }
})();


// ─── Early signal handlers (registered BEFORE any await in init) ───────────
// The full gracefulShutdown is only wired at the very bottom of this file,
// AFTER init completes — init includes top-level awaits (TLS probe, broker
// list) that can take seconds. A SIGTERM landing in that window previously
// hit the default disposition and killed the process with code 143, skipping
// every shutdown path (observed with start-prod's hot-reload watcher firing a
// second batch onto a freshly relaunched server). During init nothing is
// owned yet (no provider children attached, no clients), so a clean exit(0)
// is the correct response; once init finishes, `onTermSignal` is repointed
// to gracefulShutdown below.
let onTermSignal: (signal: string) => void = (signal) => {
  console.log(`[Shutdown] ${signal} received during init — exiting cleanly (nothing owned yet)`);
  process.exit(0);
};

process.on("SIGTERM", () => onTermSignal("SIGTERM"));

process.on("SIGINT", () => onTermSignal("SIGINT"));


// ─── The last net: an I/O error must not take the server down ──────────────
//
// WHAT HAPPENED WITHOUT THIS. 2026-09-17, CI run 35269750073 job 105366102078:
// the test server died with exit code 1 on `error: write EPIPE ... at failWrite
// (node:net:60:30)`, one line after `[AI Bridge] socket closed`. Playwright
// reported it as 68 failed and 235 never run, and those reds were charged to
// the card under review. A crash wearing a red suite's costume costs the rerun
// AND a wrong diagnosis.
//
// The specific hole was closed at the source (`lib/ai-bridge-client.ts` now
// listens on its readline, PR #93), and that fix is the right one: a known
// failure gets handled where it happens, not swallowed globally. This handler
// is for the ones NOT known yet. The server holds PTYs, provider children and
// live sessions; dying because a socket hung up throws all of that away over an
// event that has nothing to do with the work in flight.
//
// WHY IT RE-THROWS ANYTHING THAT IS NOT I/O, and this is the part that makes it
// a net rather than a blindfold. A `TypeError` or a failed assertion is a BUG:
// swallowing it would leave the process alive in a state nobody designed, and
// the next symptom would surface somewhere unrelated, hours later. Only the
// error codes that mean "the other end went away" are absorbed, because for
// those the correct behaviour is exactly what the reconnect paths already do.
//
// It is deliberately NOT a general safety net for unhandled rejections: those
// stay untouched, since a rejected promise is almost always a logic error and
// this file already learned once that a too-wide guard is worse than none.
const SURVIVABLE_IO = new Set(["EPIPE", "ECONNRESET", "ECONNABORTED", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);

// A write refused by a primary switch's read-only fence (server/db.ts) is the
// fence doing its job, not a bug: a timer that writes without catching must
// not take the fenced server down in the middle of the upload. Every other
// unhandled rejection still ends the process, as it does without a listener.
function logFencedWrite(err: unknown): void {
  console.warn(`[primary] a write was refused by the switch fence: ${err instanceof Error ? err.message : String(err)}`);
}
process.on("unhandledRejection", (reason: unknown) => {
  if (isFencedWriteError(reason)) { logFencedWrite(reason); return; }
  console.error("[Shutdown] unhandled promise rejection:", reason);
  process.exit(1);
});

process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (isFencedWriteError(err)) { logFencedWrite(err); return; }
  const code = err?.code ?? "";
  if (!SURVIVABLE_IO.has(code)) {
    // Not ours to absorb: restore the default disposition and let it kill the
    // process with the original stack, instead of a second-hand report of it.
    console.error("[Shutdown] uncaught exception that is not a socket hang-up - rethrowing:", err);
    throw err;
  }
  console.error(
    `[Shutdown] uncaught ${code} absorbed (${err.syscall ?? "unknown syscall"}): ` +
      `a peer hung up on a socket nobody was listening to. The server stays up; ` +
      `if this repeats, the fix belongs where that socket is created, not here.`,
  );
});


// Solid singleton: a server booted from a DISPATCH WORKTREE (e.g. an agent that
// ran `bun run server.ts` inside its isolation checkout under ~/.topics/worktrees)
// must NOT hijack production. Sharing the ~/.topics daemon lock + the prod port
// let a worktree server (with its own empty DB) win the race and starve the real
// server into a crash-loop — the "board vuota / kanban rotto" failure. Redirect
// such a server onto a worktree-local TOPICS_HOME + an ephemeral port BEFORE the
// context reads PORT and before acquireLock reads TOPICS_HOME. Opt out with
// TOPICS_ALLOW_WORKTREE_PROD=1 (deliberately running prod from a worktree).
if (!process.env.TOPICS_ALLOW_WORKTREE_PROD) {
  const isoHome = worktreeIsolationHome(import.meta.dir, homedir(), readOwnerMarker(import.meta.dir) !== null);
  if (isoHome) {
    // La decisione sta in `services/daemon-state.ts` (`worktreeIsolationEnv`),
    // dove un test la raggiunge: qui viveva dentro `server.ts` ed era rimasta
    // INCOMPLETA — spostava casa e porta principale e lasciava la porta del
    // tunnel, che ha preso giu' la produzione il 18/08.
    const patch = worktreeIsolationEnv(process.env, isoHome);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete process.env[k]; else process.env[k] = v;
    }
    console.log(
      `[Daemon] worktree server isolated → TOPICS_HOME=${process.env.TOPICS_HOME}, ` +
      `PORT=${process.env.PORT === "0" ? "ephemeral" : process.env.PORT}, ` +
      `tunnel ${process.env.TOPICS_TUNNEL_PORT ? process.env.TOPICS_TUNNEL_PORT : "off"} (won't touch production)`,
    );
  }
}


// ─── Phase B · Daemon lifecycle (DAEMON-01) ────────────────────────────────
// Take the singleton lock HERE: before the database, the PTY and AI bridges,
// the session reattach and the partial sweep. A losing boot must exit having
// touched nothing. The lock used to sit just above Bun.serve, which made the
// comment ("concurrent boots exit fast") false: a second `bun run server.ts`
// in the same working directory opened data/topics.db, ran migrations and the
// ui_state repairs, joined both bridges, reattached live sessions, parked the
// idle ones and swept the partial rows, and only then found the lock and
// exited. It happened on 2026-09-13 at 03:38 against the production home and
// ended clean by luck, not by design. The only thing allowed above this line
// is the worktree isolation, because it decides WHICH home the lock lives in.
// The state file is still written after Bun.serve returns the actual port
// (PORT=0 resolves the port only then).
try {
  acquireLock();
} catch (err) {
  if (err instanceof LiveLockError) {
    console.error(`[Daemon] ${err.message}`);
    console.error(`[Daemon] If the other process is dead, delete ~/.topics/daemon-process.lock manually.`);
    process.exit(1);
  }
  throw err;
}


// Il vecchio token del gateway non serve più a niente: se un launchd o una
// shell lo esporta ancora, esce da process.env prima che un figlio lo erediti.
delete process.env.GATEWAY_TOKEN;


// The process registry of the previous life: re-adopt what still runs, close
// what ended while the server was down. It used to load at import, which ran
// it before the lock above, so a losing boot rewrote `.state/scripts.json`.
loadProcessRegistry();

// ─── Boot stages ──────────────────────────────────────────────────────────────
// Each stage is one module under server/boot/. It receives what the stages before it returned and
// returns what the stages after it read; the order below IS the order the code ran in as one file.
const base = { rootDir: import.meta.dir, BOOT_COMMIT };
const afterCore = { ...base, ...(bootCore(base)) };
const afterBrowser = { ...afterCore, ...(await bootBrowser(afterCore)) };
const afterTracker = { ...afterBrowser, ...(bootTracker(afterBrowser)) };
const afterRouters1 = { ...afterTracker, ...(bootRoutersFirst(afterTracker)) };
const afterDispatchPrep = { ...afterRouters1, ...(bootDispatchPrep(afterRouters1)) };
const afterHeadlessTurns = { ...afterDispatchPrep, ...(bootHeadlessTurns(afterDispatchPrep)) };
const afterDispatcher = { ...afterHeadlessTurns, ...(bootDispatcher(afterHeadlessTurns)) };
const afterQuiescence = { ...afterDispatcher, ...(bootQuiescence(afterDispatcher)) };
const afterPreviewDelivery = { ...afterQuiescence, ...(bootPreviewDelivery(afterQuiescence)) };
const afterTasksRouter = { ...afterPreviewDelivery, ...(bootTasksRouter(afterPreviewDelivery)) };
const afterRouters2 = { ...afterTasksRouter, ...(bootRoutersSecond(afterTasksRouter)) };
const afterHeartbeat = { ...afterRouters2, ...(await bootHeartbeat(afterRouters2)) };
const afterTerminalsWs = { ...afterHeartbeat, ...(bootTerminalsWs(afterHeartbeat)) };
const afterBootSweeps = { ...afterTerminalsWs, ...(await bootBootSweeps(afterTerminalsWs)) };
const afterHttp = { ...afterBootSweeps, ...(await bootHttp(afterBootSweeps)) };
const afterFront = { ...afterHttp, ...(bootFront(afterHttp)) };
const afterListen = { ...afterFront, ...(await bootListen(afterFront)) };
bootStaleStreams(afterListen);
const afterGovernor = { ...afterListen, ...(bootGovernor(afterListen)) };
const afterReattach = { ...afterGovernor, ...(bootReattach(afterGovernor)) };
const afterDeliveryAudit = { ...afterReattach, ...(bootDeliveryAudit(afterReattach)) };
const afterRelay = { ...afterDeliveryAudit, ...(await bootRelay(afterDeliveryAudit)) };
bootPostListen(afterRelay);
const afterTimersShutdown = { ...afterRelay, ...(bootTimersShutdown(afterRelay)) };
// A server that handed the primary over: its DB turns read-only now that the boot has run (server/db.ts).
applyFencedReadOnly();



// Init is complete: repoint the early-registered signal listeners (top of
// file) from the exit-clean stub to the real teardown.
onTermSignal = (signal) => { void afterTimersShutdown.gracefulShutdown(signal); };
