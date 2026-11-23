// The provider hold as it crosses the wire (`provider:hold`): the plan's usage
// window is spent and the server holds dispatch and resumes until `untilMs`.
// Declared once here; server/lib/provider-hold.ts and client/src/state/providerHold.ts
// re-export it (see tests/unit/no-type-mirrors.test.ts).

export type UsageWindowKind = 'five_hour' | 'seven_day' | 'usage_limit' | 'api-down';

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
   *  (Codex today: one published reset instant, nothing else). `api-down` is
   *  no window at all: the API stopped answering (`holdForApiDown`), and the
   *  status bar does not show it as a plan limit. */
  window: UsageWindowKind;
  /** One line for logs and the chat, naming the spent window. */
  reason: string;
  /** When the hold was recorded (ms epoch). */
  sinceMs: number;
}

/**
 * One provider whose cards the dispatcher keeps in Todo right now, as
 * `GET /api/dispatch/brakes` says it to the board's «Frenato» chip: a spent
 * window (the hold), or Claude's five-hour window past `PLAN_DISPATCH_HOLD_AT`.
 */
export interface DispatchBrake {
  provider: 'claude' | 'codex';
  window: UsageWindowKind;
  /** Percent of that window already used, when the plan reports it. */
  utilization: number | null;
  /** When the cards start again (ms epoch); null for an API outage, which names no end. */
  untilMs: number | null;
  /** True for Claude's early stop, Topics' own margin a person may lift; absent for a provider's wall. */
  liftable?: true;
}

/**
 * What the dispatcher does with the cards behind the walls, as
 * `GET /api/dispatch/brakes` says it: the Todo cards a wall keeps waiting (the
 * dispatcher's own verdict, card by card) and the cards each runtime has at
 * work, keyed `claude`, `codex`, or the runtime's own name (`muse`).
 */
export interface DispatchWork {
  held: Array<{ taskId: string; projectId: string; provider: 'claude' | 'codex' }>;
  working: Record<string, number>;
  /** The 24h spend cap when it stops the whole queue; absent or `null` = it does not. */
  spend?: DispatchSpendStop | null;
}

/**
 * The 24h spend cap stopping the queue, whatever the provider: on 23/11 the
 * board sat still for hours at 35.59 USD over a 30 USD cap and the chip said
 * nothing, because it named only the providers' walls.
 */
export interface DispatchSpendStop {
  spentCents: number;
  capCents: number;
  /** When the rolling 24h spend falls back under the cap if nothing new is spent; `null` = it cannot be said. */
  untilMs: number | null;
  /** The Todo cards it keeps waiting. */
  taskIds: string[];
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

/**
 * Whether a card's `dispatch_error` is the dispatcher's own "the provider's
 * plan is spent / near its limit" reason. The dispatcher writes it as
 * `<label>: <why>` (`task-dispatcher-hold.ts`, `taskPlanWait`), so the label
 * is the marker; a wait an agent declared has another prefix and never matches.
 */
export function isPlanWaitReason(error: string | null | undefined): boolean {
  if (!error) return false;
  return error.startsWith(`${providerHoldLabel('claude')}: `) || error.startsWith(`${providerHoldLabel('codex')}: `);
}

/**
 * The end an error declares for itself: `(resets_at: 2026-11-20T08:00:00Z)`, an ISO
 * instant in UTC. A provider, or a proxy standing in front of one, that stops a request
 * because the plan is spent can say WHEN it is worth asking again with that tail; the
 * reader needs to know nothing about who wrote it. Ms epoch, or null when the text
 * declares none.
 */
export function readDeclaredReset(text: string | null | undefined): number | null {
  const m = /resets_at:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(text ?? "");
  const at = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(at) ? at : null;
}
