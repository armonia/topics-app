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
import type { PlanUsage, PlanUsageWindow, ProviderHold, UsageWindowKind } from "../../shared/provider-hold";
import { providerHoldKey } from "../../shared/provider-hold";
export type { PlanUsage, ProviderHold, UsageWindowKind };

/**
 * One hold per provider key ("claude", "codex", …): each hits its own wall on
 * its own plan, so a spent Codex month must not wait for, or be waited on by,
 * a spent Claude window. "claude" is what every caller that does not name a
 * key means — the native runtime and the resume sweep only ever talk about
 * the Claude account, so their calls stay unchanged by this being a map.
 */
const DEFAULT_KEY = "claude";
const holds = new Map<string, ProviderHold>();
/** Fires on the Claude hold only: it is the one the status-bar banner and the
 *  resume sweep were built to show. A held Codex is read by the dispatcher
 *  and the automatic classifier, not announced to open chats. */
const listeners = new Set<(hold: ProviderHold | null) => void>();
/** Where the memo is mirrored; null until the server names the file. */
let storePath: string | null = null;

function persist(): void {
  if (!storePath) return;
  try {
    if (holds.size > 0) {
      mkdirSync(dirname(storePath), { recursive: true });
      writeFileSync(storePath, JSON.stringify(Object.fromEntries(holds)));
    } else if (existsSync(storePath)) {
      unlinkSync(storePath);
    }
  } catch {
    // The mirror is a convenience across restarts, never a reason to fail the
    // hold itself: the in-memory memo stays authoritative for this process.
  }
}

function isValidHold(raw: unknown): raw is ProviderHold {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Partial<ProviderHold>;
  return typeof r.untilMs === "number" && typeof r.reason === "string"
    && (r.window === "five_hour" || r.window === "seven_day" || r.window === "usage_limit");
}

/**
 * Name the file the hold is mirrored in, and adopt whatever a previous
 * process left there if it has not ended yet. Returns the Claude hold
 * restored if there is one, else any other provider's, else null. An expired
 * entry is dropped, not adopted; the legacy single-hold file (no provider
 * keys, just the hold itself) is read as Claude's.
 */
export function configureProviderHoldStore(path: string, nowMs: number = Date.now()): ProviderHold | null {
  storePath = path;
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const entries: Array<[string, unknown]> = typeof (raw as { untilMs?: unknown }).untilMs === "number"
      ? [[DEFAULT_KEY, raw]]
      : Object.entries(raw);
    let reported: ProviderHold | null = null;
    let anyKept = false;
    for (const [key, value] of entries) {
      if (!isValidHold(value) || value.untilMs <= nowMs) continue;
      anyKept = true;
      const existing = holds.get(key);
      if (existing && existing.untilMs >= value.untilMs) continue;
      const hold: ProviderHold = {
        untilMs: value.untilMs, window: value.window, reason: value.reason,
        sinceMs: typeof value.sinceMs === "number" ? value.sinceMs : nowMs,
      };
      holds.set(key, hold);
      if (key === DEFAULT_KEY) {
        reported = hold;
        for (const cb of listeners) { try { cb(hold); } catch { /* a listener's failure is its own */ } }
      } else if (!reported) {
        reported = hold;
      }
    }
    if (!anyKept) { unlinkSync(path); return null; }
    persist();
    return reported;
  } catch {
    try { unlinkSync(path); } catch { /* nothing to remove */ }
    return null;
  }
}

/** Tests only: forget the file, so one test's mirror does not reach the next. */
export function resetProviderHoldStore(): void {
  storePath = null;
}

/** The hold in force at `nowMs` for this provider key, or null: an expired
 *  hold is forgotten. Defaults to "claude", the one every caller that
 *  predates multi-provider holds meant. */
export function providerHold(nowMs: number = Date.now(), key: string = DEFAULT_KEY): ProviderHold | null {
  const hold = holds.get(key);
  if (hold && hold.untilMs <= nowMs) { holds.delete(key); return null; }
  return hold ?? null;
}

/** Whether a runtime PROVIDER (not a hold key) is under a wall right now — the
 *  question the dispatcher and the automatic classifier actually ask, since
 *  they know provider ids like "claude-code" or "codex", not hold keys. */
export function isProviderHeld(provider: string, nowMs: number = Date.now()): boolean {
  const key = providerHoldKey(provider);
  return key != null && providerHold(nowMs, key) != null;
}

/**
 * Record a hold for `hold.provider` (default "claude"). A later end replaces
 * an earlier one; a shorter one does not shorten a hold already in force (two
 * sessions reading the same window in a different second must not flap the
 * fleet) — independently per provider.
 */
export function setProviderHold(hold: { untilMs: number; window: UsageWindowKind; reason: string; provider?: string }, nowMs: number = Date.now()): ProviderHold {
  const key = hold.provider ?? DEFAULT_KEY;
  const active = providerHold(nowMs, key);
  if (active && active.untilMs >= hold.untilMs) return active;
  const next: ProviderHold = { untilMs: hold.untilMs, window: hold.window, reason: hold.reason, sinceMs: nowMs };
  holds.set(key, next);
  persist();
  if (key === DEFAULT_KEY) {
    for (const cb of listeners) { try { cb(next); } catch { /* a listener's failure is its own */ } }
  }
  return next;
}

/** The provider accepted a request: whatever the memo said, the wall for
 *  `provider` (default "claude") is gone. */
export function clearProviderHold(provider: string = DEFAULT_KEY): void {
  if (!holds.has(provider)) return;
  holds.delete(provider);
  persist();
  if (provider === DEFAULT_KEY) {
    for (const cb of listeners) { try { cb(null); } catch { /* idem */ } }
  }
}

/** Called on every change to the Claude hold, with the new hold or null when
 *  it is lifted (see the `listeners` comment above for why only Claude's). */
export function onProviderHold(cb: (hold: ProviderHold | null) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// ─────────────────────────────────────────────────────────────────────────
// HOW FULL THE WINDOW IS, which is a different question from "is it spent".
//
// The hold answers "the wall is here, wait until this time". This answers "how
// close is the wall", and it is the question a subscription plan actually
// poses: the constraint is not the dollar, it is the five-hour window. The CLI
// publishes it on every turn (`rate_limit_event`) and the usage endpoint
// publishes it whenever the retry loop already asks; both write here, so the
// status bar and the dispatcher read one number instead of two.
//
// Not persisted, unlike the hold: a reading is re-observed within minutes of
// any turn, and a stale percentage on disk would brake a fleet on a window that
// has since reset.

let usage: PlanUsage | null = null;
const usageListeners = new Set<(usage: PlanUsage | null) => void>();

/** A window past its own reset is not a reading any more: it drops out. */
function live(w: PlanUsageWindow | null, nowMs: number): PlanUsageWindow | null {
  if (!w) return null;
  if (w.resetsAtMs != null && w.resetsAtMs <= nowMs) return null;
  return w;
}

/** The reading in force at `nowMs`, or null once both windows have reset. */
export function planUsage(nowMs: number = Date.now()): PlanUsage | null {
  if (!usage) return null;
  const fiveHour = live(usage.fiveHour, nowMs);
  const sevenDay = live(usage.sevenDay, nowMs);
  if (!fiveHour && !sevenDay) { usage = null; return null; }
  if (fiveHour === usage.fiveHour && sevenDay === usage.sevenDay) return usage;
  usage = { fiveHour, sevenDay, observedAtMs: usage.observedAtMs };
  return usage;
}

/**
 * Record a reading. The newest wins, whatever it says: unlike the hold there is
 * no "longer wall wins" here, because a window that reset genuinely goes back
 * to nearly empty and a memo that only ever climbs would brake forever.
 */
export function recordPlanUsage(next: Omit<PlanUsage, "observedAtMs">, nowMs: number = Date.now()): PlanUsage {
  usage = { fiveHour: next.fiveHour, sevenDay: next.sevenDay, observedAtMs: nowMs };
  for (const cb of usageListeners) { try { cb(usage); } catch { /* a listener's failure is its own */ } }
  return usage;
}

/** Called on every recorded reading. */
export function onPlanUsage(cb: (usage: PlanUsage | null) => void): () => void {
  usageListeners.add(cb);
  return () => { usageListeners.delete(cb); };
}

/** Tests only: the memo is process-global, so one file's reading would reach the next. */
export function clearPlanUsage(): void {
  if (!usage) return;
  usage = null;
  for (const cb of usageListeners) { try { cb(null); } catch { /* idem */ } }
}

/** The hour a hold ends, as HH:MM in the machine's local time, for logs and notices. */
export function holdUntilLabel(hold: Pick<ProviderHold, "untilMs">): string {
  return new Date(hold.untilMs).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
}
