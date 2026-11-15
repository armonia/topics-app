/**
 * The countdown of a card in progress and the exact weight of its session.
 *
 * Two pure functions, one reader each on the client. Neither invents a number:
 * with no history there is no estimate and the countdown is `null`, so nothing
 * is drawn. The estimate is learned from the cards this board already closed
 * (the median agent time of the same project), never from a constant.
 */

import { CONTEXT_CRITICAL_PERCENT, contextLevel, type ContextLevel } from "./context-thresholds";

/** Closed cards needed before the history says anything. */
export const MIN_ESTIMATE_SAMPLES = 5;

export interface EstimateSample { agentMs: number }

/** Median agent time of finished cards, or `null` below the sample floor. */
export function estimateFromHistory(done: readonly EstimateSample[]): number | null {
  const xs = done.map((d) => d.agentMs).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (xs.length < MIN_ESTIMATE_SAMPLES) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

export interface CountdownInput {
  /** Estimate at departure, ms; `null` when nothing is known. */
  estimateMs: number | null;
  /** Agent time spent so far, ms. */
  elapsedMs: number;
  /** Subtask progress of the card: done / total (0 total = no steps). */
  stepsDone?: number;
  stepsTotal?: number;
}

export type Countdown =
  | { kind: 'left'; remainingMs: number }
  | { kind: 'over'; overMs: number };

/**
 * Remaining time. Once at least one step is done the pace of the steps
 * corrects the departure estimate: total = elapsed * total / done, blended
 * with the history so a single fast step does not collapse the figure.
 */
export function taskCountdown(i: CountdownInput): Countdown | null {
  if (i.estimateMs == null || !(i.estimateMs > 0)) return null;
  const elapsed = Math.max(0, i.elapsedMs);
  let total = i.estimateMs;
  const done = i.stepsDone ?? 0;
  const steps = i.stepsTotal ?? 0;
  if (steps > 0 && done > 0 && done < steps && elapsed > 0) {
    total = Math.round((i.estimateMs + (elapsed * steps) / done) / 2);
  }
  const left = total - elapsed;
  return left >= 0 ? { kind: 'left', remainingMs: left } : { kind: 'over', overMs: -left };
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

/** Sums the provider's per-message usage rows of a transcript, one count per message id. */
export function sumTranscriptUsage(rows: readonly { id: string; input: number; output: number; cacheWrite: number; cacheRead: number }[]) {
  const seen = new Set<string>();
  let billable = 0;
  let cacheRead = 0;
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    billable += r.input + r.output + r.cacheWrite;
    cacheRead += r.cacheRead;
  }
  return { billable, cacheRead };
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

/** Median agent time per project, from the closed cards: the estimate a card in progress starts from. */
export function estimatesByProject(tasks: Iterable<{ status: string; projectId: string; agentMs: number }>): Map<string, number> {
  const byProject = new Map<string, EstimateSample[]>();
  for (const t of tasks) {
    if (t.status !== "done" || !(t.agentMs > 0)) continue;
    const xs = byProject.get(t.projectId) ?? [];
    xs.push(t);
    byProject.set(t.projectId, xs);
  }
  const out = new Map<string, number>();
  for (const [id, xs] of byProject) {
    const e = estimateFromHistory(xs);
    if (e != null) out.set(id, e);
  }
  return out;
}
