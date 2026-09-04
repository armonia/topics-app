// provider-hold.ts — ONE shared answer to "is the model provider worth calling
// right now?", for every clock in the server that would otherwise find out on
// its own, at its own price.
//
// Measured 2026-09-04: the Claude plan's five-hour window hit 100% at ~13:00Z
// with eight agents and the person's chats on one account. For the next three
// hours every turn - agent or chat - burned 27 retries over 27 minutes, ended
// on "API 429", was resumed, and burned them again; the dispatcher kept
// starting new cards into the same wall, and the resume sweep kept resending
// into it too. The wall had a published end (`resets_at`, 15:49Z) that nobody
// asked for.
//
// This module is the memo. The native runtime writes it when a 429 lines up
// with an exhausted usage window (`usage-window.ts`); the dispatcher's tick and
// the resume sweep read it and wait; a successful round clears it early. It is
// process-local on purpose: the account is one, the server is one.

// The shape is declared once, in shared/, because the client holds the same
// hold to draw the banner. Re-exported here so this module stays the door
// everything on the server already comes through.
export type { ProviderHold, UsageWindowKind } from "../../shared/provider-hold-types";
import type { ProviderHold, UsageWindowKind } from "../../shared/provider-hold-types";

let current: ProviderHold | null = null;
const listeners = new Set<(hold: ProviderHold | null) => void>();

/** The hold in force at `nowMs`, or null: an expired hold is forgotten. */
export function providerHold(nowMs: number = Date.now()): ProviderHold | null {
  if (current && current.untilMs <= nowMs) current = null;
  return current;
}

/**
 * Record a hold. A later end replaces an earlier one; a shorter one does not
 * shorten a hold already in force (two sessions reading the same window in a
 * different second must not flap the fleet).
 */
export function setProviderHold(hold: { untilMs: number; window: UsageWindowKind; reason: string }, nowMs: number = Date.now()): ProviderHold {
  const active = providerHold(nowMs);
  if (active && active.untilMs >= hold.untilMs) return active;
  current = { untilMs: hold.untilMs, window: hold.window, reason: hold.reason, sinceMs: nowMs };
  for (const cb of listeners) { try { cb(current); } catch { /* a listener's failure is its own */ } }
  return current;
}

/** The provider accepted a request: whatever the memo said, the wall is gone. */
export function clearProviderHold(): void {
  if (!current) return;
  current = null;
  for (const cb of listeners) { try { cb(null); } catch { /* idem */ } }
}

/** Called on every change, with the new hold or null when it is lifted. */
export function onProviderHold(cb: (hold: ProviderHold | null) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** "fino alle 22:49" for a hold, in the machine's local time. */
export function holdUntilLabel(hold: Pick<ProviderHold, "untilMs">): string {
  return new Date(hold.untilMs).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
}
