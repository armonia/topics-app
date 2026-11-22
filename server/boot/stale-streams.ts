/**
 * The pass that rescues streams that went silent.
 */
import { swapFrozenMsSince } from "../lib/swap-freeze-hold";
import { sweepStaleStreams, rescueByOwner, staleTickMs, onStaleTickChange, type SilenceMark } from "../lib/stale-stream-sweep";
import { finalizeStaleRowWhenFree } from "../lib/closed-outside";
import { sweepStaleChecksLights as sweepStaleChecksLightsOf } from "../services/checks-lights";
import { resolveSessionOwner, childAliveForSweep } from "../providers";
import { cancelled } from "../providers/stop-reason";
import type { AbortReason } from "../providers/types";
import { recordTurnEnd } from "../providers/turn-end-registry";
import { cancelAsk } from "../lib/ask-user-bridge";
import { humanHoldAgeMs } from "../lib/human-hold";
import type { AfterListen } from "./scope";
import { late } from "./late";

/** @internal called by the server.ts boot, which knip --production does not credit */
export function bootStaleStreams(scope: AfterListen) {
  const { activeStreams, broadcastToAll, ctx, db, dispatcherSvc, getMessageById, isChecksHold, nudgeResumeSweep, turnLedger } = scope;
  // Stale stream cleanup
  const STALE_STREAM_CHECK_INTERVAL_MS = 30_000;

  const STALE_STREAM_TIMEOUT_MS = 3 * 60 * 1000;

  // One RESYNC per silent stream, not one reprieve. The sweeper's 3-min silence
  // has two causes: a dead turn, and a turn we stopped HEARING (a broker
  // attachment lost to a socket reconnect / a spawn acked without an attach — the
  // child keeps working and the store keeps filling, we just get nothing).
  // Declaring the second one dead is how a live turn ended as "nessuna attività
  // per 3 minuti" while it was still running. So when the provider vouches the
  // child is ALIVE we spend one round asking it to re-attach.
  // This set records only that the ATTEMPT was spent. It is NOT a countdown to
  // finalization: while `isTurnProcessAlive` keeps saying yes the sweeper keeps
  // extending (see `staleStreamVerdict`). Bounding the reprieve is what killed
  // 12-min builds and auto-compacts. The entry is dropped as soon as the stream
  // leaves the map.
  const staleStreamRescued = new Set<string>();

  const staleStreamSilence = new Map<string, SilenceMark>();

  function runStaleStreamPass(): void {
    // IL GIRO STA IN `stale-stream-sweep.ts`. Il verdetto puro era gia' uscito da
    // qui per essere provabile, ma il cablaggio no: il caso che conta — un figlio
    // VIVO al secondo tick muto, cioe' il turno che NON va finalizzato — vive
    // tutto nel cablaggio, e un test ci arrivava solo aspettando sette minuti
    // contro un server vero. Con le dipendenze iniettate due tick costano un
    // millisecondo.
    // THE PROBE GOES TO WHOEVER OWNS THE SESSION, not to claude-code.
    //
    // `tryGetProvider("claude-code")` stood here, and it is the defect that on
    // 2026-08-28 killed a live turn (topic:0299ac2d, inside a three-minute bash).
    // For a NATIVE session that provider reads its own `processes` map, does not
    // find it, and answers `false` instead of staying quiet: `staleStreamVerdict`
    // discards anything that is not `true`, so for every native turn "rescue" and
    // "extend" were unreachable and three minutes of silence were enough to close
    // it. The dispatcher had already been fixed with `resolveTurnAlive` (see
    // above); the sweeper, ten lines further down, had not.
    const sweepOutcomes = sweepStaleStreams({
      now: () => Date.now(),
      timeoutMs: STALE_STREAM_TIMEOUT_MS,
      activeStreams,
      rescued: staleStreamRescued,
      silence: staleStreamSilence,
      getMessageById,
      humanHoldAgeMs,
      childAlive: (sk) => childAliveForSweep(sk),
      // The delivery's own wait: the same predicate the stall detector reads, so
      // `update_task(status='review')` queued behind the checks is never "hung".
      waitingOnOurChecks: (sk) => isChecksHold(sk),
      // And the time we held one of its commands STOPped comes off the tool's own
      // clock, so a freeze can never turn a live tool into a "hung" one.
      frozenMsSince: (sk, since) => swapFrozenMsSince(sk, since),
      resyncStream: (sk) => {
        // The rescue went to claude-code too: for somebody else's turn it was a
        // mute no-op, a recovery attempt that attempted nothing. Now it goes to
        // the owner and its outcome is read (`rescueByOwner`).
        void rescueByOwner(sk, resolveSessionOwner(sk), (msg) => console.warn(msg));
      },
      cancelAsk,
      updateStreamActivity: (sk) => ctx.updateStreamActivity(sk),
      getTopicId: (sk) => ctx.getTopicBySessionKey(sk)?.id,
      // The same door as the two watchdogs in routes/chat.ts, and to the OWNER
      // of the session: for a native turn `abort` is the only thing that reaches
      // the loop running inside this process.
      abortProvider: (sk) => {
        const owner = resolveSessionOwner(sk) as
          | { abort?: (sk: string, runId: string | undefined, reason: AbortReason) => Promise<void>; unregisterStreamHandler?: (sk: string) => void }
          | null;
        owner?.abort?.(sk, undefined, "watchdog")
          ?.catch((err) => console.warn(`[StaleStream] provider abort failed for ${sk}:`, err));
        owner?.unregisterStreamHandler?.(sk);
      },
      endStream: (sk) => ctx.endStream(sk),
      broadcast: (msg) => broadcastToAll(msg as Parameters<typeof broadcastToAll>[0]),
      finalizeMessage: (args) => finalizeStaleRowWhenFree(db, args),
      recordTurnEnd: (sk) => recordTurnEnd(sk, cancelled("watchdog", "stale stream sweep")),
      warn: (msg) => console.warn(msg),
      info: (msg) => console.log(msg),
    });
    // A cut just happened, and its notice says "riprende da solo entro pochi
    // minuti": the resume sweep must not wait for its five-minute tick.
    if ([...sweepOutcomes.values()].includes("finalized")) nudgeResumeSweep();
    // A lingering entry the sweep dropped without `endStream`: the ledger follows the map.
    for (const sk of sweepOutcomes.keys()) turnLedger.set(sk, "route", activeStreams.has(sk));
    sweepStaleChecksLights();
  }

  function armStaleStreamTimer(): void {
    clearTimeout(late.staleStreamTimer);
    late.staleStreamTimer = setTimeout(() => {
      try {
        runStaleStreamPass();
      } finally {
        armStaleStreamTimer();
      }
    }, staleTickMs(STALE_STREAM_CHECK_INTERVAL_MS));
  }

  onStaleTickChange(armStaleStreamTimer);

  armStaleStreamTimer();


  /** The periodic half of the light's honesty (`services/checks-lights.ts`): the
   *  boot sweep is blind to a round that died with the process still up. */
  function sweepStaleChecksLights(): void {
    sweepStaleChecksLightsOf({
      clearStale: (isLive) => dispatcherSvc.clearStaleChecksRuns(isLive),
      isRunning: late.checksGateIsRunning,
      announce: (id) => {
        const task = dispatcherSvc.get(id)?.task;
        if (task) broadcastToAll({ type: "task:updated", projectId: task.projectId, task });
      },
      resume: (id) => late.resumeHeldDelivery?.(id),
      warn: (line) => console.warn(line),
    });
  }

}
