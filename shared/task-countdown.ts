/**
 * The countdown of a card in progress and the exact weight of its session.
 *
 * Two pure functions, one reader each on the client. Neither invents a number:
 * with no history there is no estimate and the countdown is `null`, so nothing
 * is drawn. The estimate is learned from the cards this board already closed
 * (the agent time of the same project), never from a constant, and it is read
 * again at half, three quarters and the end of the figure (`revisedEstimate`).
 */

import { CONTEXT_CRITICAL_PERCENT, contextLevel, type ContextLevel } from "./context-thresholds";

/** Closed cards needed before the history says anything. */
export const MIN_ESTIMATE_SAMPLES = 5;

/** How many closed cards the history reads, the most recent first: the recent ones say more. */
export const HISTORY_CAP = 50;

/**
 * The share of closed cards that finished within the estimate at departure.
 * The median (0.5) was broken by one card in two by construction, and the tail
 * is long: on the 1.055 cards closed by 17/11 half ran past it and one in
 * twenty took more than 4.5 times as long. At 0.7 the estimate at departure
 * holds for 68% of them.
 */
export const DEPARTURE_SHARE = 0.7;

/**
 * At a checkpoint the new figure is this quantile of the closed cards that
 * were still at work at that point. A card still running at half its estimate
 * is not a typical card any more: what it is like is the cards that also
 * lasted that long, not all of them. Measured walk-forward on the same cards:
 * 0.8 keeps 70% of the revisions true (0.5 kept 47%) with one revision per
 * card at the median.
 */
export const REVISION_SHARE = 0.8;

/** Where in the estimate the card is checked: half way, three quarters, the end. */
export const CHECKPOINTS = [0.5, 0.75, 1] as const;
export type Checkpoint = (typeof CHECKPOINTS)[number];

/**
 * With too few closed cards past the checkpoint, the remaining time is taken
 * equal to the time already spent (Gott's delta-t argument: with nothing else
 * known, a job half way through its life is as likely to be past the middle
 * as before it). The end checkpoint never keeps less than this margin over the
 * time spent, so a card is never shown as due now.
 */
const END_MARGIN = 1.25;

export interface EstimateSample { agentMs: number }

/** What an estimate is read from: the figure at departure and the durations it came from, sorted ascending. */
export interface EstimateBasis {
  departureMs: number;
  historyMs: readonly number[];
}

/** Linear-interpolated quantile of a sorted list. */
function valueAt(sorted: readonly number[], p: number): number {
  const i = p * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
}

/** The estimate of the closed cards given (the most recent first), or `null` below the sample floor. */
export function estimateBasis(done: readonly EstimateSample[]): EstimateBasis | null {
  const xs = done.slice(0, HISTORY_CAP).map((d) => d.agentMs).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (xs.length < MIN_ESTIMATE_SAMPLES) return null;
  return { departureMs: valueAt(xs, DEPARTURE_SHARE), historyMs: xs };
}

export interface RevisedEstimate {
  totalMs: number;
  /** The checkpoint that raised the figure last, `null` while the departure figure holds. */
  revisedAt: Checkpoint | null;
}

/**
 * The estimate after the checkpoints the elapsed time has crossed. At each one
 * the question is «will it make it?»: the closed cards that were still at work
 * at that point say how long such a card lasts; if that is past the current
 * figure, the figure is raised and its own checkpoints start again from there.
 * A figure is never lowered. Pure in the elapsed time: the same input draws the
 * same figure on every surface and every render, with no state to keep.
 */
export function revisedEstimate(basis: EstimateBasis, elapsedMs: number): RevisedEstimate {
  let figure = basis.departureMs;
  let revisedAt: Checkpoint | null = null;
  let at = 0;
  // Each pass moves `at` forward and the end checkpoint grows the figure by at
  // least END_MARGIN, so the loop ends; the bound is a backstop only.
  for (let guard = 0; guard < 256; guard++) {
    const next = CHECKPOINTS.find((f) => f * figure > at);
    if (next === undefined || next * figure > elapsedMs) break;
    at = next * figure;
    const lasted = basis.historyMs.filter((x) => x > at);
    const projected = lasted.length >= MIN_ESTIMATE_SAMPLES ? valueAt(lasted, REVISION_SHARE) : 2 * at;
    const floor = next === 1 ? Math.round(at * END_MARGIN) : figure;
    const raised = Math.max(projected, floor);
    if (raised > figure) {
      figure = raised;
      revisedAt = next;
    }
  }
  return { totalMs: figure, revisedAt };
}

export interface CountdownInput {
  /** What the estimate is read from; `null` when nothing is known. */
  basis: EstimateBasis | null;
  /** Agent time spent so far, ms. */
  elapsedMs: number;
  /** Subtask progress of the card: done / total (0 total = no steps). */
  stepsDone?: number;
  stepsTotal?: number;
}

export interface Countdown {
  remainingMs: number;
  /** The figure now: the departure one, or the one a checkpoint raised it to (blended with the steps' pace). */
  totalMs: number;
  departureMs: number;
  /** The checkpoint that raised the figure last; `null` while the departure figure holds. */
  revisedAt: Checkpoint | null;
}

/**
 * Remaining time. The checkpoints re-estimate the card when it runs long;
 * once at least one step is done the pace of the steps corrects the figure:
 * total = elapsed * total / done, blended with it so a single fast step does
 * not collapse it. The figure is always past the time spent: the end
 * checkpoint raises it before it is reached.
 */
export function taskCountdown(i: CountdownInput): Countdown | null {
  if (!i.basis || !(i.basis.departureMs > 0)) return null;
  const elapsed = Math.max(0, i.elapsedMs);
  const revised = revisedEstimate(i.basis, elapsed);
  let total = revised.totalMs;
  const done = i.stepsDone ?? 0;
  const steps = i.stepsTotal ?? 0;
  if (steps > 0 && done > 0 && done < steps && elapsed > 0) {
    total = Math.round((total + (elapsed * steps) / done) / 2);
  }
  return { remainingMs: Math.max(0, total - elapsed), totalMs: total, departureMs: i.basis.departureMs, revisedAt: revised.revisedAt };
}

export interface SessionWeightInput {
  /** Context tokens of the last provider call, as the provider reported them. */
  usedTokens: number | null;
  windowTokens: number | null;
  /** Provider flagged the figure as an estimate: the UI must say so. */
  estimated?: boolean;
  billableTokens: number;
  cacheReadTokens: number;
  costCents: number;
  /** Sum of the same figures over the child sessions. */
  subAgents?: { count: number; billableTokens: number; costCents: number };
  /** Share of the window at which compaction is called for (0..1); defaults to the shared critical threshold. */
  compactAt?: number;
}

export interface SessionWeight {
  usedTokens: number | null;
  percent: number | null;
  /** Tokens left before compaction; `null` without a measured context. */
  untilCompactionTokens: number | null;
  /** The shared level of the measure (`context-thresholds`); `null` without a measured context. */
  level: ContextLevel | null;
  billableTokens: number;
  cacheReadTokens: number;
  costCents: number;
  estimated: boolean;
  childCount: number;
  /** Own billable tokens plus the children's. */
  totalBillableTokens: number;
  totalCostCents: number;
}

export function sessionWeight(i: SessionWeightInput): SessionWeight {
  const kids = i.subAgents ?? { count: 0, billableTokens: 0, costCents: 0 };
  const measured = i.usedTokens != null && i.windowTokens != null && i.windowTokens > 0;
  const percent = measured ? Math.min(100, Math.round(((i.usedTokens as number) / (i.windowTokens as number)) * 1000) / 10) : null;
  const limit = measured ? Math.round((i.windowTokens as number) * (i.compactAt ?? CONTEXT_CRITICAL_PERCENT / 100)) : null;
  return {
    usedTokens: i.usedTokens,
    percent,
    untilCompactionTokens: limit != null ? Math.max(0, limit - (i.usedTokens as number)) : null,
    level: percent != null ? contextLevel(percent, i.usedTokens as number) : null,
    billableTokens: i.billableTokens,
    cacheReadTokens: i.cacheReadTokens,
    costCents: i.costCents,
    estimated: !!i.estimated,
    childCount: kids.count,
    totalBillableTokens: i.billableTokens + kids.billableTokens,
    totalCostCents: i.costCents + kids.costCents,
  };
}

/** What the provider measured of a session's context, in the shape `sessionWeight` takes. */
export interface ContextMeasure {
  usedTokens: number;
  windowTokens: number;
  estimated: boolean;
}

/**
 * The measure out of a live-context payload (`GET /api/context/live`, the
 * `stream:context` frame), or `null` when the provider reported none: a zero
 * or a missing window is "not measured", never a 0% to draw.
 */
export function contextMeasure(
  c: { usage?: { used?: number | null; size?: number | null } | null; estimated?: boolean } | null | undefined,
): ContextMeasure | null {
  const used = c?.usage?.used;
  const size = c?.usage?.size;
  if (typeof used !== "number" || typeof size !== "number") return null;
  if (!(used > 0) || !(size > 0)) return null;
  return { usedTokens: used, windowTokens: size, estimated: !!c?.estimated };
}

/** One child session as the weight of its mother counts it. */
export interface ChildWeightRow { billableTokens: number; costCents: number }

/** The children block of `sessionWeight`: how many and what they spent. Rows with nothing measured still count as children. */
export function foldChildren(rows: readonly ChildWeightRow[]): { count: number; billableTokens: number; costCents: number } {
  let billableTokens = 0;
  let costCents = 0;
  for (const r of rows) {
    billableTokens += Math.max(0, r.billableTokens);
    costCents += Math.max(0, r.costCents);
  }
  return { count: rows.length, billableTokens, costCents };
}

/**
 * A card's own share of its counter. `tasks.agent_tokens` already carries the
 * children (the dispatcher's ledger reads them with the parent), so the own
 * part is what is left after taking them out: summing the children again on
 * top of the counter would count them twice.
 */
export function ownOfCounter(counter: number, childrenShare: number): number {
  return Math.max(0, counter - childrenShare);
}

/** The estimate per project, from its closed cards (the most recent first): what a card in progress starts from. */
export function estimatesByProject(tasks: Iterable<{ status: string; projectId: string; agentMs: number; completedAt?: string | null }>): Map<string, EstimateBasis> {
  const byProject = new Map<string, Array<EstimateSample & { at: number }>>();
  for (const t of tasks) {
    if (t.status !== "done" || !(t.agentMs > 0)) continue;
    const xs = byProject.get(t.projectId) ?? [];
    xs.push({ agentMs: t.agentMs, at: t.completedAt ? Date.parse(t.completedAt) || 0 : 0 });
    byProject.set(t.projectId, xs);
  }
  const out = new Map<string, EstimateBasis>();
  for (const [id, xs] of byProject) {
    const e = estimateBasis(xs.sort((a, b) => b.at - a.at));
    if (e) out.set(id, e);
  }
  return out;
}

export interface RunningCard {
  id: string;
  projectId: string;
  agentMs: number;
  subtaskDoneCount?: number;
  subtaskCount?: number;
}

export interface RunningSummary {
  /** Cards in progress. */
  count: number;
  /** The one that finishes first among those with a countdown; `null` when none has an estimate. */
  soonestLeftMs: number | null;
  /** How many ran long enough for a checkpoint to raise their estimate. */
  revised: number;
}

/**
 * What a list of cards in progress says as a whole: how many, how long until
 * the first one should be done, how many had their estimate raised. The
 * surfaces that show a count of work in progress (the sidebar row, the board
 * tab, the tray) read it, so they agree. A card with no estimate adds to the
 * count and to nothing else.
 */
export function summarizeRunning(cards: readonly RunningCard[], estimates: ReadonlyMap<string, EstimateBasis>): RunningSummary {
  let firstLeft: number | null = null;
  let revised = 0;
  for (const c of cards) {
    const countdown = taskCountdown({
      basis: estimates.get(c.projectId) ?? null,
      elapsedMs: c.agentMs,
      stepsDone: c.subtaskDoneCount,
      stepsTotal: c.subtaskCount,
    });
    if (!countdown) continue;
    if (countdown.revisedAt !== null) revised += 1;
    firstLeft = firstLeft === null ? countdown.remainingMs : Math.min(firstLeft, countdown.remainingMs);
  }
  return { count: cards.length, soonestLeftMs: firstLeft, revised };
}
