// usage-limit.ts - the Claude Code CLI's own words for "the plan's usage limit
// is spent", read into the instant the plan opens again.
//
//   You've hit your limit · resets 3pm (Europe/Rome)
//   You've hit your session limit · resets Nov 4, 4am (UTC)
//
// Without this, a chat or agent turn that met the wall ended as a plain
// provider error and waited for a person to type "resume". Read as a
// `rate-limit` end plus a hold until the reset, the resume sweep sends the turn
// again by itself once the plan is back (same device as Codex's
// `providers/codex/usage-limit.ts`).

const LIMIT_MARKER = /you.ve hit your (?:[a-z0-9-]+ ){0,3}limit/i;
const RESETS_AT = /resets\s+(?:([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*(?:\(([^)]*)\))?/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** How long the hold lasts when the message names no reset instant we can read. */
export const CLAUDE_USAGE_LIMIT_FALLBACK_MS = 30 * 60_000;

export interface ClaudeUsageLimit {
  untilMs: number;
  reason: string;
}

/** Offset of `zone` from UTC at `atMs`, in ms; null when the zone is unknown. */
function zoneOffsetMs(zone: string, atMs: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(new Date(atMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(atMs / 1000) * 1000;
  } catch {
    return null;
  }
}

/** The instant at which `zone`'s wall clock reads the given fields. */
function zonedInstant(zone: string, y: number, mo: number, d: number, h: number, mi: number): number | null {
  const naive = Date.UTC(y, mo, d, h, mi);
  const first = zoneOffsetMs(zone, naive);
  if (first == null) return null;
  const second = zoneOffsetMs(zone, naive - first) ?? first;
  return naive - second;
}

/** The hold a message asks for, or `null` when it is not the usage-limit wall. */
export function parseClaudeUsageLimit(message: string, nowMs: number = Date.now()): ClaudeUsageLimit | null {
  if (typeof message !== "string" || !LIMIT_MARKER.test(message)) return null;
  const reason = "Claude plan usage limit reached";
  const fallback = { untilMs: nowMs + CLAUDE_USAGE_LIMIT_FALLBACK_MS, reason };
  const m = RESETS_AT.exec(message);
  if (!m) return fallback;
  const [, monthName, day, hour12, minute, meridiem, zoneRaw] = m;
  const zone = zoneRaw?.trim() || "UTC";
  const hour = (Number(hour12) % 12) + (meridiem!.toLowerCase() === "pm" ? 12 : 0);
  const minutes = minute ? Number(minute) : 0;
  const zoneName = /^utc$/i.test(zone) ? "UTC" : zone;
  const local = new Date(nowMs + (zoneOffsetMs(zoneName, nowMs) ?? 0));
  const y = local.getUTCFullYear();
  let untilMs: number | null;
  if (monthName) {
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    if (month < 0) return fallback;
    untilMs = zonedInstant(zoneName, y, month, Number(day), hour, minutes);
    if (untilMs != null && untilMs <= nowMs) untilMs = zonedInstant(zoneName, y + 1, month, Number(day), hour, minutes);
  } else {
    untilMs = zonedInstant(zoneName, y, local.getUTCMonth(), local.getUTCDate(), hour, minutes);
    if (untilMs != null && untilMs <= nowMs) untilMs = zonedInstant(zoneName, y, local.getUTCMonth(), local.getUTCDate() + 1, hour, minutes);
  }
  if (untilMs == null || !Number.isFinite(untilMs) || untilMs <= nowMs) return fallback;
  return { untilMs, reason };
}
