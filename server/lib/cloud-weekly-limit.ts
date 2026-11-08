// cloud-weekly-limit.ts - the Claude cloud's own words for "the weekly limit is
// spent", read into the instant the plan opens again.
//
//   You've hit your weekly limit · resets Nov 4, 4am (UTC)
//
// The sentence is the only published end of that wall, like Codex's
// (`providers/codex/usage-limit.ts`). A zone other than UTC, or a date that does
// not parse, still counts as the wall (the run did no work) but gets a short
// fallback hold instead of a guessed instant.

const WEEKLY_LIMIT_MARKER = /you.ve hit your weekly limit/i;
const RESETS_AT = /resets\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?:,?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m))?\s*(?:\(([^)]*)\))?/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The key of this wall in the provider-hold memo. Its own key, not the Claude
 * one: the Mac's Claude Code keeps running while the cloud is spent, and only
 * the overflow (`cloudCredit`) reads this hold.
 */
export const CLOUD_HOLD_KEY = "claude-cloud";

/** How long the hold lasts when the message names no reset instant we can read. */
export const CLOUD_WEEKLY_LIMIT_FALLBACK_MS = 60 * 60_000;

export interface CloudWeeklyLimit {
  untilMs: number;
  reason: string;
}

/** The hold a message asks for, or `null` when it is not the weekly-limit wall. */
export function parseCloudWeeklyLimit(message: string, nowMs: number = Date.now()): CloudWeeklyLimit | null {
  if (typeof message !== "string" || !WEEKLY_LIMIT_MARKER.test(message)) return null;
  const reason = "Claude cloud weekly limit reached";
  const fallback = { untilMs: nowMs + CLOUD_WEEKLY_LIMIT_FALLBACK_MS, reason };
  const m = RESETS_AT.exec(message);
  if (!m) return fallback;
  const [, monthName, day, year, hour12, minute, meridiem, zone] = m;
  const month = MONTHS.indexOf(monthName!.slice(0, 3).toLowerCase());
  if (month < 0 || (zone && !/^\s*utc\s*$/i.test(zone))) return fallback;
  let hour = 0;
  if (hour12) hour = (Number(hour12) % 12) + (meridiem!.toLowerCase() === "pm" ? 12 : 0);
  const at = (y: number) => Date.UTC(y, month, Number(day), hour, minute ? Number(minute) : 0);
  const thisYear = new Date(nowMs).getUTCFullYear();
  let untilMs = at(year ? Number(year) : thisYear);
  if (!year && untilMs <= nowMs) untilMs = at(thisYear + 1);
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) return fallback;
  return { untilMs, reason };
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
