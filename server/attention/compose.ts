/**
 * THE ONE SUM: a subject's inputs in, its attention state out
 * (notifications-redesign, design §3 and §4.1).
 *
 * Pure: no I/O, no clock. `store.ts` keeps the inputs and the epoch, and calls
 * this after every patch; the table tests in `compose.test.ts` pin the nine
 * rules and the transitions.
 */
import type { AttentionOutcome, AttentionReason, AttentionState, AttentionTaskMap } from "../../shared/attention";

/** A person in the middle: a question, a permission, a plan to approve. */
export interface AttentionHold {
  kind: "question" | "permission" | "plan";
  /** Identifies THIS wait: a new wait is a new epoch, the same one re-said is not. */
  id: string;
  text?: string | null;
  since: string;
}

/** The board card's state, when it waits on the person. */
export interface AttentionCard {
  status: "review" | "parked";
  since: string;
  detail?: string | null;
}

/** The last turn of the subject that left something to read. */
export interface AttentionLastTurn {
  id: string;
  outcome: AttentionOutcome;
  at: string;
  detail?: string | null;
}

export interface AttentionInputs {
  archived?: boolean;
  deleted?: boolean;
  /** A terminal whose tab or pane was closed. */
  closed?: boolean;
  /** The topic of a board agent: its card is the subject. */
  dispatched?: boolean;
  /** Open waits, by the source that opened them (`ask`, `permission`, `phase`, `plan`). */
  holds?: Record<string, AttentionHold>;
  card?: AttentionCard | null;
  turnOpen?: boolean;
  lastTurn?: AttentionLastTurn | null;
  /** How far the person has seen the subject's turns. */
  seenAt?: string | null;
  background?: AttentionTaskMap;
  /**
   * The last counting task just returned and no turn has opened yet: the
   * subject stays `background` for a few seconds, so the wake that carries the
   * report announces once instead of the turn before it (T6 against T7).
   */
  backgroundGrace?: boolean;
}

export interface AttentionComposition {
  state: AttentionState;
  reason: AttentionReason | null;
  outcome: AttentionOutcome | null;
  detail: string | null;
  /** The fact behind a lit state: a new cause is a new epoch, the same cause recomposed is not. */
  cause: string | null;
}

/** Tasks that keep the subject waiting: a recurring cron is a calendar, not a wait. */
export function countingTaskCount(background: AttentionTaskMap | undefined): number {
  if (!background) return 0;
  let n = 0;
  for (const t of Object.values(background)) if (!t.recurring) n++;
  return n;
}

/** The last turn closed after the person last looked. */
export function isTurnUnseen(lastTurn: AttentionLastTurn | null | undefined, seenAt: string | null | undefined): boolean {
  if (!lastTurn) return false;
  return !seenAt || lastTurn.at > seenAt;
}

/** The oldest open wait: whoever asked first is answered first, and its id stays the cause. */
function firstHold(holds: Record<string, AttentionHold> | undefined): AttentionHold | null {
  let first: AttentionHold | null = null;
  for (const h of Object.values(holds ?? {})) if (!first || h.since < first.since) first = h;
  return first;
}

const IDLE: AttentionComposition = { state: "idle", reason: null, outcome: null, detail: null, cause: null };

/**
 * The precedence of design §3, first rule that applies wins:
 *
 *   1. archived, deleted or closed      -> idle
 *   2. topic of a board agent           -> idle (the card is the subject)
 *   3. a wait open                      -> needs-you(question|permission|plan)
 *   4. card in review / parked          -> needs-you(review|parked)
 *   5. turn open                        -> working
 *   6. last turn error, not seen        -> finished(error)
 *   7. a task in flight that counts     -> background
 *   8. last turn done, not seen         -> finished(done)
 *   9. otherwise                        -> idle
 */
export function composeAttention(i: AttentionInputs): AttentionComposition {
  if (i.archived || i.deleted || i.closed) return IDLE;
  if (i.dispatched) return IDLE;
  const hold = firstHold(i.holds);
  if (hold) {
    return { state: "needs-you", reason: hold.kind, outcome: null, detail: hold.text ?? null, cause: `hold:${hold.kind}:${hold.id}` };
  }
  if (i.card) {
    return { state: "needs-you", reason: i.card.status, outcome: null, detail: i.card.detail ?? null, cause: `card:${i.card.status}:${i.card.since}` };
  }
  if (i.turnOpen) return { state: "working", reason: null, outcome: null, detail: null, cause: null };
  const unseen = isTurnUnseen(i.lastTurn, i.seenAt);
  if (i.lastTurn && unseen && i.lastTurn.outcome === "error") {
    return { state: "finished", reason: null, outcome: "error", detail: i.lastTurn.detail ?? null, cause: `turn:error:${i.lastTurn.id}` };
  }
  if (countingTaskCount(i.background) > 0 || i.backgroundGrace) {
    return { state: "background", reason: null, outcome: null, detail: null, cause: null };
  }
  if (i.lastTurn && unseen) {
    return { state: "finished", reason: null, outcome: "done", detail: i.lastTurn.detail ?? null, cause: `turn:done:${i.lastTurn.id}` };
  }
  return IDLE;
}

/** Lit: on every count, in the inbox, on the Dock. */
export function isLitComposition(c: Pick<AttentionComposition, "state">): boolean {
  return c.state === "needs-you" || c.state === "finished";
}
