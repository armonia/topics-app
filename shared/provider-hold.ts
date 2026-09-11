// The provider hold as it crosses the wire (`provider:hold`): the plan's usage
// window is spent and the server holds dispatch and resumes until `untilMs`.
// Declared once here; server/lib/provider-hold.ts and client/src/state/providerHold.ts
// re-export it (see tests/unit/no-type-mirrors.test.ts).

export type UsageWindowKind = 'five_hour' | 'seven_day' | 'usage_limit';

/** One of the plan's usage windows, as every reader of it says it. */
export interface PlanUsageWindow {
  /** Percent of the window already used, 0-100 (it can go past 100). */
  utilization: number;
  /** When the window resets (ms epoch), when the source says so. */
  resetsAtMs: number | null;
}

/**
 * How full the plan's two windows are, from whichever source spoke last.
 *
 * Two sources feed it and they speak different units: the CLI's
 * `rate_limit_event` gives a FRACTION and epoch SECONDS, the OAuth usage
 * endpoint gives PERCENT and an ISO instant. Both are converted at the door,
 * so downstream there is one vocabulary: percent and milliseconds.
 */
export interface PlanUsage {
  fiveHour: PlanUsageWindow | null;
  sevenDay: PlanUsageWindow | null;
  /** When this reading was taken (ms epoch). */
  observedAtMs: number;
}

/**
 * From here the status bar says the window out loud. Below it the number is
 * true but useless: nobody changes what they are doing at 12%.
 */
export const PLAN_USAGE_WARN_AT = 50;

/**
 * From here the dispatcher starts nothing new. It is BELOW the exhaustion line
 * (`EXHAUSTED_AT`, which fires the hold) on purpose: the last tenth of a window
 * is worth more to the person typing in a chat than to a card that can wait for
 * the reset, and a card started at 95% dies mid-turn anyway.
 */
export const PLAN_DISPATCH_HOLD_AT = 90;

export interface ProviderHold {
  /** When the provider is expected to accept requests again (ms epoch). */
  untilMs: number;
  /** Which of the plan's windows is spent: the client translates this.
   *  `usage_limit` is a flat plan cap with no five-hour/seven-day shape
   *  (Codex today: one published reset instant, nothing else). */
  window: UsageWindowKind;
  /** One line for logs and the chat, naming the spent window. */
  reason: string;
  /** When the hold was recorded (ms epoch). */
  sinceMs: number;
}

/**
 * Every provider hits its own wall on its own plan: the memo in
 * `server/lib/provider-hold.ts` is one map keyed by this. Claude's several
 * runtime aliases (native, the CLI, its team variant, jcode) share one plan
 * and so one key; anything not recognised carries no known hold (an API-only
 * provider, for instance).
 */
export function providerHoldKey(provider: string): 'claude' | 'codex' | null {
  if (provider === 'codex') return 'codex';
  if (provider === 'topics' || provider === 'claude-code' || provider === 'claude-code-team' || provider === 'jcode') return 'claude';
  return null;
}

/** The name a person reads for a hold key, in logs and queue reasons. */
export function providerHoldLabel(key: 'claude' | 'codex'): string {
  return key === 'codex' ? 'Codex' : 'Claude';
}
