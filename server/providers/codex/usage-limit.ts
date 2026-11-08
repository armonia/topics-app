// usage-limit.ts — the Codex CLI's own words for "the plan's usage limit is
// spent", turned into the second writer of the shared memo
// (`server/lib/provider-hold.ts`) that the native Claude runtime's
// `usage-window.ts` already writes for its own plan.
//
// Codex publishes no usage endpoint the way Claude's OAuth session does: the
// only published end of the wall is the sentence inside the error itself —
//
//   You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage
//   to purchase more credits or try again at Sep 15th, 2026 11:30 PM.
//
// — so this module reads THAT sentence instead of an endpoint. The sentence
// carries no timezone, so it is read as UTC on purpose: `Date.parse` on a
// free-text month name is locale/timezone-dependent (it disagreed with itself
// between a lone run and the full suite, on the SAME string), and a wrong but
// consistent reading is safer than one that moves with the machine running
// the test. Misreading the sentence must never manufacture a hold nobody
// asked for: every early return here means "not this wall" or "could not
// read its date", both `null`, never a guessed instant.

const USAGE_LIMIT_MARKER = /you.ve hit your usage limit/i;
const TRY_AGAIN_AT =
  /try again at\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})\s*([AP]M))?/i;

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

export interface CodexUsageLimit {
  untilMs: number;
  reason: string;
}

/**
 * The reset instant out of a Codex error message, or null when the message is
 * not the usage-limit wall, or its date does not parse into the future.
 */
export function parseCodexUsageLimit(message: string, nowMs: number = Date.now()): CodexUsageLimit | null {
  if (typeof message !== "string" || !USAGE_LIMIT_MARKER.test(message)) return null;
  const match = TRY_AGAIN_AT.exec(message);
  if (!match) return null;
  const [, monthName, day, year, hour12, minute, meridiem] = match;
  const monthIndex = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
  if (monthIndex < 0) return null;
  let hourUtc = 0;
  if (hour12) {
    const h = Number(hour12) % 12;
    hourUtc = meridiem.toUpperCase() === "PM" ? h + 12 : h;
  }
  const untilMs = Date.UTC(Number(year), monthIndex, Number(day), hourUtc, minute ? Number(minute) : 0);
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) return null;
  return { untilMs, reason: "Codex plan usage limit reached" };
}
