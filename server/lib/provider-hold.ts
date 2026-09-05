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
// process-local in memory (the account is one, the server is one) and, once
// `configureProviderHoldStore` is called, mirrored on disk: a hot reload in
// the middle of a spent window used to forget the memo, and the next process
// started its cards and its resume sweep straight into the same wall, paying
// the 27 retries again before it learnt what the one before it already knew.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProviderHold, UsageWindowKind } from "../../shared/provider-hold";
export type { ProviderHold, UsageWindowKind };

let current: ProviderHold | null = null;
const listeners = new Set<(hold: ProviderHold | null) => void>();
/** Where the memo is mirrored; null until the server names the file. */
let storePath: string | null = null;

function persist(): void {
  if (!storePath) return;
  try {
    if (current) {
      mkdirSync(dirname(storePath), { recursive: true });
      writeFileSync(storePath, JSON.stringify(current));
    } else if (existsSync(storePath)) {
      unlinkSync(storePath);
    }
  } catch {
    // The mirror is a convenience across restarts, never a reason to fail the
    // hold itself: the in-memory memo stays authoritative for this process.
  }
}

/**
 * Name the file the hold is mirrored in, and adopt whatever a previous
 * process left there if it has not ended yet. Returns the hold restored, or
 * null. An expired file is removed, not adopted.
 */
export function configureProviderHoldStore(path: string, nowMs: number = Date.now()): ProviderHold | null {
  storePath = path;
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ProviderHold>;
    if (typeof raw.untilMs !== "number" || typeof raw.reason !== "string" || (raw.window !== "five_hour" && raw.window !== "seven_day")) {
      unlinkSync(path);
      return null;
    }
    if (raw.untilMs <= nowMs) { unlinkSync(path); return null; }
    if (!current || current.untilMs < raw.untilMs) {
      current = { untilMs: raw.untilMs, window: raw.window, reason: raw.reason, sinceMs: typeof raw.sinceMs === "number" ? raw.sinceMs : nowMs };
      for (const cb of listeners) { try { cb(current); } catch { /* a listener's failure is its own */ } }
    }
    return current;
  } catch {
    try { unlinkSync(path); } catch { /* nothing to remove */ }
    return null;
  }
}

/** Tests only: forget the file, so one test's mirror does not reach the next. */
export function resetProviderHoldStore(): void {
  storePath = null;
}

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
  persist();
  for (const cb of listeners) { try { cb(current); } catch { /* a listener's failure is its own */ } }
  return current;
}

/** The provider accepted a request: whatever the memo said, the wall is gone. */
export function clearProviderHold(): void {
  if (!current) return;
  current = null;
  persist();
  for (const cb of listeners) { try { cb(null); } catch { /* idem */ } }
}

/** Called on every change, with the new hold or null when it is lifted. */
export function onProviderHold(cb: (hold: ProviderHold | null) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The hour a hold ends, as HH:MM in the machine's local time, for logs and notices. */
export function holdUntilLabel(hold: Pick<ProviderHold, "untilMs">): string {
  return new Date(hold.untilMs).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
}
