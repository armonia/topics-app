/**
 * THE SPEND BRAKE, and it is born OFF.
 *
 * Two caps, both zero on a fresh install, and zero means UNLIMITED: until
 * somebody writes a number, this module must cost nothing and change nothing.
 * The dispatcher behaves exactly as it behaved before.
 *
 * WHAT IT COSTS WITH THE CAPS OFF: one read of the '*' row per tick, the same
 * row the tick already reads for the concurrency cap. No sum over the spend
 * ledger, no extra read per card: the first thing every function below does is
 * turn around and leave.
 *
 * BRAKE, NOT CUT: the NEXT turn is refused. A turn killed halfway throws away
 * work already paid for, which is how a cap ends up costing more than the
 * problem it solves.
 *
 * FAIL OPEN: an exception, a number that cannot be read, spend that cannot be
 * priced all let the turn through. It closes only on a trustworthy number
 * above the cap. Erring towards the block stops good work over a measurement
 * error; erring towards the go costs one expensive card, which is exactly what
 * the counter makes visible.
 *
 * WHY IT IS ITS OWN MODULE rather than a block inside `task-dispatcher.ts`: the
 * dispatcher was already at its `check:bloat` ceiling, and this is the piece
 * that comes out whole. It is the brake plus the pricing of one session, and
 * nothing here needs the dispatcher's loop, its timers or its task rows: it
 * takes numbers and gives back a reason or a null.
 */
import { calculateCostWithCache, modelPrice } from "../usage/pricing";
import { costTokens } from "../../shared/token-cost";
import type { SessionUsage } from "./transcript-usage";

/** The two caps as the reserved '*' row carries them. Zero = unlimited. */
export interface SpendCaps { perTaskCents: number; perDayCents: number }

/** Everything the brake needs from the outside, and nothing more. */
export interface SpendBrakeDeps {
  /** The written caps. May throw: the brake catches and fails open. */
  getSpendCaps(): SpendCaps;
  /** Spend over the rolling 24h window, in cents. May throw. */
  spent24hCents(): number;
  /** The dispatcher's own log, so the two sentences land where the others do. */
  log(message: string): void;
}

/** Cents to dollars, the way it is written to a person. */
export function usd(cents: number): string {
  return `${(cents / 100).toFixed(2)} USD`;
}

/**
 * The per-CARD cap, cumulative: `true` when this card has gone through it.
 *
 * It reads the number the card already holds (`task.agentCostCents`, which came
 * with the row): with the cap off there is not even this read, because the
 * caller leaves first.
 */
export function overTaskSpendCap(spentCents: number | null | undefined, perTaskCents: number): boolean {
  if (perTaskCents <= 0) return false;
  const spent = spentCents ?? 0;
  if (!Number.isFinite(spent) || spent <= 0) return false;   // fail open
  return spent >= perTaskCents;
}

/** The sentence, written once: the tick brake and the resume brake share it. */
export function taskSpendMessage(spentCents: number | null | undefined, capCents: number): string {
  return (
    `Tetto di spesa per card raggiunto: ${usd(spentCents ?? 0)} su un tetto di ${usd(capCents)}. ` +
    `Il turno successivo non parte. Alza il tetto dalle impostazioni della board, oppure chiudi la card.`
  );
}

export interface SpendBrake {
  /** The written caps, or the off pair when the read falls over. */
  caps(): SpendCaps;
  /** The per-machine 24h brake as a reason, or `null`. */
  dayBlock(): string | null;
  /** The per-card brake as a reason, or `null`. */
  taskBlock(spentCents: number | null | undefined): string | null;
}

/**
 * One brake per dispatcher: it holds the single piece of state this needs, which
 * is whether the daily block has already been announced in the log.
 */
export function createSpendBrake(deps: SpendBrakeDeps): SpendBrake {
  function caps(): SpendCaps {
    try { return deps.getSpendCaps(); } catch { return { perTaskCents: 0, perDayCents: 0 }; }
  }

  /** The last daily block already announced in the log, so it is said once. */
  let lastSpendBlock = false;

  /**
   * The per-MACHINE cap over a rolling 24h window: a reason, or `null`.
   *
   * It lives beside `admissionBlock` and is consulted where that one is: the
   * worst measured day (2,569 USD) was made of many cards each below its own
   * cap, so the per-card cap would never have seen it go by.
   */
  function dayBlock(): string | null {
    const c = caps();
    if (c.perDayCents <= 0) { lastSpendBlock = false; return null; }
    try {
      const spent = deps.spent24hCents();
      if (spent < c.perDayCents) {
        if (lastSpendBlock) deps.log("coda ripartita: la spesa delle ultime 24 ore è rientrata sotto il tetto");
        lastSpendBlock = false;
        return null;
      }
      const reason = `spesa: ${usd(spent)} negli ultimi 24h su un tetto di ${usd(c.perDayCents)}`;
      if (!lastSpendBlock) deps.log(`coda ferma — ${reason}`);
      lastSpendBlock = true;
      return reason;
    } catch { return null; }   // fail open
  }

  /** The per-card brake as a REASON, for the door that wants one (the resume). */
  function taskBlock(spentCents: number | null | undefined): string | null {
    const c = caps();
    if (c.perTaskCents <= 0) return null;
    return overTaskSpendCap(spentCents, c.perTaskCents) ? taskSpendMessage(spentCents, c.perTaskCents) : null;
  }

  return { caps, dayBlock, taskBlock };
}

// ── THE PRICE OF ONE SESSION ────────────────────────────────────────────────
//
// THE CENTS travel on the same row as the tokens, not beside them in a
// structure of their own: the cost comes from the DELTA of every component
// against the anchor of THIS session (fresh, output, 5m write, 1h write,
// re-read) at the price list of the model that ran THERE. A fan-out opens
// sessions with different models: one multiplier per task would price the
// Sonnet attempt at the Opus rate.
export interface SessionLedger {
  offset: SessionUsage;
  tokens: number;
  cacheRead: number;
  /** This session's spend, in cents, monotone like the tokens. */
  costCents: number;
  /** Equivalent consumption that could NOT be priced (model with no price list). */
  unpricedCostTokens: number;
  /** The model running on this session. `null` = spend that cannot be priced. */
  model: string | null;
}

/**
 * HOW MUCH IT COST, in cents, from the component deltas against the anchor.
 *
 * Two outcomes and not one, and the difference is what makes the number
 * believable:
 *
 *  · model with a price list, and the cents rise, with the same floor as the
 *    tokens (a reading that regresses does not subtract, calling it twice does
 *    not count twice);
 *  · model with NO price list (or none at all), and the cents do not move one
 *    step: the equivalent consumption goes into `unpricedCostTokens`. Billing
 *    an unknown model at zero would make it indistinguishable from a free
 *    turn, and a cap that silently ignores a slice of the spend is a
 *    decorative cap, so that slice is SHOWN next to the number.
 *
 * The components are billed for what they are (`calculateCostWithCache`): a
 * cache re-read costs a tenth of a fresh token and in an agentic turn it is the
 * dominant share, so counting it at full price would inflate the bill about
 * tenfold.
 */
export function bookSessionCost(s: SessionLedger, reading: SessionUsage): void {
  const d = (now: number, then: number) => Math.max(0, now - then);
  const model = s.model;
  if (!model || !modelPrice(model)) {
    s.unpricedCostTokens = Math.max(
      s.unpricedCostTokens,
      costTokens({
        billable: d(reading.billableTokens, s.offset.billableTokens),
        cacheRead: d(reading.cacheReadTokens, s.offset.cacheReadTokens),
      }),
    );
    return;
  }
  // `cacheWrite1hTokens` is a SUBSET of `cacheWriteTokens`, while the two rates
  // of `calculateCostWithCache` want DISJOINT shares (1.25x at five minutes, 2x
  // at one hour): passing both whole would count the one-hour writes twice, and
  // on a real session those were 100% of the total.
  const write1h = d(reading.cacheWrite1hTokens, s.offset.cacheWrite1hTokens);
  const write = d(reading.cacheWriteTokens, s.offset.cacheWriteTokens);
  const dollars = calculateCostWithCache({
    model,
    freshInputTokens: d(reading.inputTokens, s.offset.inputTokens),
    outputTokens: d(reading.outputTokens, s.offset.outputTokens),
    cacheCreationTokens: Math.max(0, write - write1h),
    cacheCreation1hTokens: write1h,
    cacheReadTokens: d(reading.cacheReadTokens, s.offset.cacheReadTokens),
  });
  s.costCents = Math.max(s.costCents, Math.round(dollars * 100));
}
