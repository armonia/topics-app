/**
 * The server-wide state a detached native turn changes from its own process.
 *
 * A turn in `turn-host.ts` runs the same agent loop as before, and that loop
 * writes to registries that live in module memory: the provider hold and the
 * plan usage (`lib/provider-hold.ts`), and the commands it runs
 * (`lib/native-command-registry.ts`). In the host those writes land in the
 * host's own copy, which nobody reads: the dispatcher kept starting cards into
 * a spent plan window, and the swap freezer could not see a single native
 * command. So the host journals each change and the server applies it here.
 *
 * Replays are the catch: after a restart the whole journal is read again, and
 * an old reading must not overwrite a newer one. Every event carries its time
 * and is applied only if nothing newer is already there.
 */

import {
  clearProviderHold,
  lastApiAnswerMs,
  liftApiDownHold,
  onPlanUsage,
  onProviderHold,
  planUsage,
  providerHold,
  recordPlanUsage,
  setProviderHold,
  type ProviderHold,
  type UsageWindowKind,
} from "../../lib/provider-hold";
import { registerNativeCommand } from "../../lib/native-command-registry";
import type { PlanUsage } from "../../../shared/provider-hold";
import { watchNativeCommands } from "./tools";
import type { JournalEvent } from "./turn-journal";

/** A control line the server sends to the host on stdin. */
export type HostControl =
  | { t: "abort"; cause: string }
  | { t: "freeze"; pid: number }
  | { t: "thaw"; pid: number; frozenMs: number };

/**
 * Host side: journal every change to the shared registries until the returned
 * function is called. `seed` is the server's hold at spawn, so a round that
 * goes through can lift it here (`releaseHoldIfFreed` only re-reads the
 * windows while a hold is in force) and the lift reaches the server.
 */
export function journalHostEffects(emit: (ev: JournalEvent) => void, seed: ProviderHold | null = null): () => void {
  if (seed && seed.untilMs > Date.now()) setProviderHold({ untilMs: seed.untilMs, window: seed.window, reason: seed.reason });
  // A lift names what it lifted: the host's copy can be stale (an api-down
  // seed while the server has since set a plan hold), and a bare "null" let
  // the host's outage lift drop the server's plan hold with no measure.
  let had = providerHold();
  const offHold = onProviderHold((h) => {
    const at = Date.now();
    if (h) emit({ e: "hold", at, hold: { untilMs: h.untilMs, window: h.window, reason: h.reason } });
    else if (had) emit({ e: "hold", at, hold: null, lifted: { window: had.window, untilMs: had.untilMs } });
    had = h;
  });
  const offUsage = onPlanUsage((u) => {
    if (u) emit({ e: "plan_usage", at: u.observedAtMs, u: { fiveHour: u.fiveHour, sevenDay: u.sevenDay } });
  });
  const offCommands = watchNativeCommands({
    started: (c) => emit({ e: "cmd_start", pid: c.pid, command: c.command, at: c.startedAt }),
    ended: (pid) => emit({ e: "cmd_end", pid }),
  });
  return () => { offHold(); offUsage(); offCommands(); };
}

/**
 * Server side: applies a turn's journaled effects. `control` reaches the host
 * (freeze and thaw of a command's own deadline). `close` forgets the commands
 * still registered: the host is gone, and its pids may be reused.
 */
export function applyTurnEffects(sessionKey: string, control: (msg: HostControl) => void): {
  apply: (ev: JournalEvent) => void;
  close: () => void;
} {
  const commands = new Map<number, () => void>();
  const apply = (ev: JournalEvent): void => {
    switch (ev.e) {
      case "hold": {
        const now = Date.now();
        const active = providerHold(now);
        if (ev.hold) {
          // Dated at the event, not at the reading: a replayed [set, lift]
          // must end lifted, and the lift is checked against `sinceMs`.
          if (ev.hold.untilMs > now) setProviderHold({ untilMs: ev.hold.untilMs, window: ev.hold.window as UsageWindowKind, reason: ev.hold.reason }, Math.min(ev.at, now));
        } else if (active && ev.lifted && active.window === ev.lifted.window && active.sinceMs <= ev.at) {
          clearProviderHold();
        }
        return;
      }
      case "plan_usage": {
        const seen = planUsage();
        if (seen && seen.observedAtMs > ev.at) return;
        recordPlanUsage(ev.u as Omit<PlanUsage, "observedAtMs">, ev.at);
        return;
      }
      case "api_ok": {
        // An outage hold set after this answer is about a later failure.
        const active = providerHold();
        if (active?.window === "api-down" && active.sinceMs > ev.at) return;
        // A replayed answer older than the last one seen would move the
        // outage clock back (`ripresa-boot` reads it).
        if (ev.at <= lastApiAnswerMs()) return;
        liftApiDownHold(ev.at);
        return;
      }
      case "cmd_start": {
        commands.get(ev.pid)?.();
        commands.set(ev.pid, registerNativeCommand({
          sessionKey,
          pid: ev.pid,
          command: ev.command,
          startedAt: ev.at,
          onFreeze: () => control({ t: "freeze", pid: ev.pid }),
          onThaw: (frozenMs) => control({ t: "thaw", pid: ev.pid, frozenMs }),
        }));
        return;
      }
      case "cmd_end": {
        commands.get(ev.pid)?.();
        commands.delete(ev.pid);
        return;
      }
      default:
        return;
    }
  };
  return {
    apply,
    close: () => {
      for (const forget of commands.values()) forget();
      commands.clear();
    },
  };
}
