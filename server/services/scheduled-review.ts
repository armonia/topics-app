/**
 * THE SCHEDULED REVIEW: technical cards in review are looked at by the clock,
 * not when a person happens to notice them.
 *
 * Measured on 25/11/2026: 19 cards in review, then 18 more within an hour and a
 * half. The technical ones (no question for a person, nothing a person must
 * see) waited until somebody asked, and meanwhile cards from the nodes held the
 * PC's slots. The automatic land (`auto-land.ts`) only moves a card that is
 * labelled invisible with a whole green bar; the red bounce
 * (`red-bounce.ts`) only moves a card whose bar already says red. A card with
 * no bar verdict at all sat between the two.
 *
 * This pass is the third door, on the same sweep (`sweepAutoLand`). For a card
 * that is due it reads the delivered branch in a throwaway checkout of its own
 * commit: does main still merge into it, and do the test files the delivery
 * touched pass? Then the move is the same two the board already makes:
 *   - something fails  -> back to the agent, naming the file (and the test);
 *   - everything holds -> the land, with a last look at the commit just before.
 * What a person must judge (a question, a place `personPlace` names) is never
 * decided here. The rule is off by default (`scheduledReviewMinutes`, 0).
 *
 * Pure decisions and one injected inspector: the checkout and the test run are
 * the router's doors, so the bar of this module is a test with no git.
 * `ai_review_reminded_at` is the stamp of the last pass, as the review
 * reminder already used it: a card is looked at again only after the interval.
 */
import { personPlace } from "./auto-land";
import type { PersonPath } from "../../shared/workflow";

export interface ScheduledReviewCard {
  id: string;
  projectId: string;
  status: string;
  humanAsk?: string | null;
  deliveryBranch: string | null;
  deliveryCommit: string | null;
  /** Last scheduled pass (ISO), `null` = never looked at. */
  lastPassAt: string | null;
  /** When the card entered review (ISO); a card younger than the interval is left to the other doors. */
  reviewAt: string | null;
}

/** A failed test: the file always, the test name when the runner said it. */
export interface TestFailure { file: string; test?: string }

export type InspectionReport =
  /** The inspection could not be made (no repo, no checkout): the card is not judged. */
  | { kind: "unmeasured"; why: string }
  | { kind: "conflict"; files: string[] }
  | { kind: "red"; failures: TestFailure[] }
  | { kind: "green"; tested: string[] };

export interface ScheduledReviewDeps {
  /** Paths of the delivery at `commit`; `null` = git could not say. */
  files(card: ScheduledReviewCard): Promise<string[] | null>;
  /** The board's own paths a person must look at. */
  personPaths(projectId: string): readonly PersonPath[];
  /** Checkout of `card.deliveryCommit`, merge-tree against main, the touched tests run. */
  inspect(card: ScheduledReviewCard, files: readonly string[]): Promise<InspectionReport>;
  turnIsLive(card: ScheduledReviewCard): boolean;
  /** Send the card back to its agent with `why`; `true` = it left review. */
  bounce(card: ScheduledReviewCard, why: string): boolean;
  /** Ask the land for `commit`; the land's own recheck stops it when the card moved. */
  land(card: ScheduledReviewCard, commit: string): void;
  /** Write the stamp of this pass. */
  stamp(card: ScheduledReviewCard, atIso: string): void;
  /** One line on the thread for a card left alone for a reason a person should see. */
  log?(line: string): void;
}

export type ScheduledReviewOutcome = "skipped" | "bounced" | "landed" | "unmeasured" | "person";

/** Is this card due for a pass at `nowMs`? Pure: age and stamp only. */
export function scheduledReviewDue(card: ScheduledReviewCard, nowMs: number, everyMinutes: number): boolean {
  if (everyMinutes <= 0 || card.status !== "review") return false;
  if (!card.deliveryBranch || !card.deliveryCommit) return false;
  if ((card.humanAsk ?? "").trim()) return false;
  const every = everyMinutes * 60_000;
  const since = (iso: string | null) => (iso ? nowMs - Date.parse(iso) : Number.POSITIVE_INFINITY);
  const sincePass = since(card.lastPassAt);
  if (Number.isFinite(sincePass) ? sincePass < every : false) return false;
  // A card that just arrived is still inside the agent's own delivery round.
  const sinceReview = since(card.reviewAt);
  return !(Number.isFinite(sinceReview) && sinceReview < every / 2);
}

/** What the agent reads when the pass sends its card back. */
export function scheduledReviewMessage(report: Extract<InspectionReport, { kind: "conflict" | "red" }>): string {
  if (report.kind === "conflict") {
    return `Il merge con main non è pulito: conflitto in ${report.files.slice(0, 5).join(", ")}. Porta main nel tuo ramo, risolvi e rimetti in review.`;
  }
  const named = report.failures.slice(0, 5).map((f) => (f.test ? `${f.file} (test: ${f.test})` : f.file));
  return `Ripasso a orario: i test toccati dalla consegna sono rossi in ${named.join("; ")}. Correggi il codice o il test nel tuo ramo e rimetti in review.`;
}

/** One card's pass. The caller has already checked `scheduledReviewDue`. */
export async function reviewScheduled(card: ScheduledReviewCard, deps: ScheduledReviewDeps, now: Date = new Date()): Promise<ScheduledReviewOutcome> {
  if (deps.turnIsLive(card)) return "skipped";
  const files = await deps.files(card).catch(() => null);
  if (files === null) return "unmeasured";
  const extra = deps.personPaths(card.projectId);
  const place = files.map((f) => personPlace(f, extra)).find((p) => p !== null);
  // The stamp keeps a card a person must see from being opened again every beat.
  if (place) { deps.stamp(card, now.toISOString()); return "person"; }
  const report = await deps.inspect(card, files).catch((e): InspectionReport => ({ kind: "unmeasured", why: String(e) }));
  if (report.kind === "unmeasured") { deps.log?.(`[scheduled-review] ${card.id.slice(0, 8)} non misurata: ${report.why}`); return "unmeasured"; }
  deps.stamp(card, now.toISOString());
  if (report.kind === "green") { deps.land(card, card.deliveryCommit!); return "landed"; }
  return deps.bounce(card, scheduledReviewMessage(report)) ? "bounced" : "skipped";
}
