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
 * whose bar is green on the delivered commit it:
 *   1. sends back a commit already bounced once and delivered again unchanged
 *      (the red goes first), and a "already on main" claim origin/main does not bear out;
 *   2. reads the branch in a throwaway checkout of its own commit: does main
 *      still merge into it, and do the test files the delivery touched pass?
 *   3. asks a model other than the writer for the judgement of SENSE: does the
 *      diff do what the card asks, does it contradict a decision in the thread?
 *      The same reviewer answers the agent's technical questions.
 * A clearing verdict is written as a row of the card's bar, and the land is then
 * ASKED of `autoLandVerdict`: this module never lands by itself, so everything
 * that verdict knows (the whole bar on the commit, a person who spoke after the
 * review, a question in the thread, open steps, a dispatch error, live turns)
 * keeps holding. What a person must judge (a place `personPlace` names) is never
 * decided here. The rule is off by default (`scheduledReviewMinutes`, 0).
 *
 * Pure decisions and injected doors: the checkout, the test run and the model
 * are the router's, so the bar of this module is a test with no git.
 * `ai_review_reminded_at` is the stamp of the last pass, as the review
 * reminder already used it: a card is looked at again only after the interval.
 */
import { personPlace, sameCommit } from "./auto-land";
import { asksOnlyApproval, type PersonPath } from "../../shared/workflow";

export interface ScheduledReviewCard {
  id: string;
  projectId: string;
  status: string;
  humanAsk?: string | null;
  deliveryBranch: string | null;
  deliveryCommit: string | null;
  /** The bar's verdict and the commit it measured: only a commit the bar cleared is judged. */
  checksState: "running" | "pass" | "fail" | "unknown" | null;
  checksCommit: string | null;
  /** Last scheduled pass (ISO), `null` = never looked at. */
  lastPassAt: string | null;
  /** When the card entered review (ISO); a card younger than half the interval is left to the other doors. */
  reviewAt: string | null;
  /** The card was sent back while it delivered this very commit: the send-back asked for more work than the commit holds. */
  sentBackOnCommit?: boolean;
}

/** A failed test: the file always, the test name when the runner said it. */
export interface TestFailure { file: string; test?: string }

export type InspectionReport =
  /** The inspection could not be made (no repo, no checkout): the card is not judged. */
  | { kind: "unmeasured"; why: string }
  | { kind: "conflict"; files: string[] }
  | { kind: "red"; failures: TestFailure[] }
  | { kind: "green"; tested: string[] };

/**
 * The judgement of SENSE, by a model other than the one that wrote the delivery:
 * does the diff do what the card asks, and does it contradict a decision written
 * in the thread? A green bar proves the code is not broken, not that it is right
 * (25/11: a delivery counted cards in review as taking places from the nodes, the
 * opposite of the card's purpose, with every test green because they were written
 * on the same mistaken idea).
 */
export type SenseVerdict =
  | { kind: "ok"; note: string }
  | { kind: "reject"; why: string }
  /** A technical question the agent put to a person, answered by the reviewer. */
  | { kind: "answer"; text: string }
  /** What only a person can judge (spend, public, irreversible, real people, a UI to look at). */
  | { kind: "person"; why: string }
  | { kind: "unmeasured"; why: string };

export interface ScheduledReviewDeps {
  /** Paths of the delivery at `commit`; `null` = git could not say. */
  files(card: ScheduledReviewCard): Promise<string[] | null>;
  /** The board's own paths a person must look at. */
  personPaths(projectId: string): readonly PersonPath[];
  /** Checkout of `card.deliveryCommit`, merge-tree against main, the touched tests run. */
  inspect(card: ScheduledReviewCard, files: readonly string[]): Promise<InspectionReport>;
  /** Shas the card's last words call "already on main" that origin/main does not have; `null` = could not check. */
  falseMainClaims(card: ScheduledReviewCard): Promise<string[] | null>;
  /** Is the delivered commit already contained in origin/main? `null` = could not check. */
  onMain(card: ScheduledReviewCard): Promise<boolean | null>;
  /** Why this very commit was already sent back by a pass (an agent redelivering it unchanged), or `null`. */
  bouncedBefore(card: ScheduledReviewCard): string | null;
  /** The sense review: one model session for this one card. */
  sense(card: ScheduledReviewCard, files: readonly string[]): Promise<SenseVerdict>;
  turnIsLive(card: ScheduledReviewCard): boolean;
  /** Send the card back to its agent with `why`; `true` = it left review. */
  bounce(card: ScheduledReviewCard, why: string): boolean;
  /** Answer the agent's technical question and send the card back; `true` = it left review. */
  answer(card: ScheduledReviewCard, text: string): boolean;
  /** Write the verdict as a row of the card's bar, so the automatic land's verdict reads it. */
  clear(card: ScheduledReviewCard, note: string): void;
  /** Offer the card to the automatic land's own verdict; `true` = it said yes. */
  land(card: ScheduledReviewCard): Promise<boolean>;
  /** Close a card whose delivery is already on origin/main, with git's proof and no merge; `true` = it closed. */
  close(card: ScheduledReviewCard, proof: string): boolean;
  /** Write the stamp of this pass. */
  stamp(card: ScheduledReviewCard, atIso: string): void;
  /** One line for a card left alone for a reason somebody should see. */
  log?(line: string): void;
}

export type ScheduledReviewOutcome = "skipped" | "bounced" | "answered" | "landed" | "held" | "unmeasured" | "person";

const short = (commit: string) => commit.slice(0, 8);

/** Is this card due for a pass at `nowMs`? Pure: age and stamp only. */
export function scheduledReviewDue(card: ScheduledReviewCard, nowMs: number, everyMinutes: number): boolean {
  if (everyMinutes <= 0 || card.status !== "review") return false;
  if (!card.deliveryBranch || !card.deliveryCommit) return false;
  const every = everyMinutes * 60_000;
  const since = (iso: string | null) => (iso ? nowMs - Date.parse(iso) : Number.POSITIVE_INFINITY);
  const sincePass = since(card.lastPassAt);
  if (Number.isFinite(sincePass) ? sincePass < every : false) return false;
  // A card that just arrived is still inside the agent's own delivery round.
  const sinceReview = since(card.reviewAt);
  return !(Number.isFinite(sinceReview) && sinceReview < every / 2);
}

/** What the agent reads when the pass sends its card back; the commit is named so a redelivery of it is recognised. */
export function scheduledReviewMessage(commit: string, report: Extract<InspectionReport, { kind: "conflict" | "red" }>): string {
  const head = `Ripasso a orario su \`${short(commit)}\`:`;
  if (report.kind === "conflict") {
    return `${head} il merge con main non è pulito, conflitto in ${report.files.slice(0, 5).join(", ")}. Porta main nel tuo ramo, risolvi e rimetti in review.`;
  }
  const named = report.failures.slice(0, 5).map((f) => (f.test ? `${f.file} (test: ${f.test})` : f.file));
  return `${head} i test toccati dalla consegna sono rossi in ${named.join("; ")}. Correggi il codice o il test nel tuo ramo e rimetti in review.`;
}

/** The same commit delivered again after a red: the red goes first, and the message says nothing changed. */
export function redeliveryMessage(commit: string, earlier: string): string {
  return `Ripasso a orario su \`${short(commit)}\`: è lo stesso commit già rimandato, senza modifiche. Il rosso resta: ${earlier} Cambia il codice, non rimettere in review lo stesso commit.`;
}

/** One card's pass. The caller has already checked `scheduledReviewDue`. */
export async function reviewScheduled(card: ScheduledReviewCard, deps: ScheduledReviewDeps, now: Date = new Date()): Promise<ScheduledReviewOutcome> {
  const commit = card.deliveryCommit;
  if (!commit) return "skipped";
  // Only a commit the bar already cleared is judged: a running, missing or red bar belongs to the other doors.
  if (card.checksState !== "pass" || !sameCommit(card.checksCommit, commit)) return "skipped";
  if (deps.turnIsLive(card)) return "skipped";
  // Every pass is stamped before it starts, whatever it ends in: an unmeasured card, a held land or a person's card
  // is looked at again after the interval, never at the next beat (a pass runs git and tests).
  deps.stamp(card, now.toISOString());
  const files = await deps.files(card).catch(() => null);
  if (files === null) return "unmeasured";
  const extra = deps.personPaths(card.projectId);
  const place = files.map((f) => personPlace(f, extra)).find((p) => p !== null);
  if (place) return "person";

  const earlier = deps.bouncedBefore(card);
  if (earlier) { return deps.bounce(card, redeliveryMessage(commit, earlier)) ? "bounced" : "skipped"; }

  const claims = await deps.falseMainClaims(card).catch(() => null);
  if (claims && claims.length > 0) {
    const why = `Ripasso a orario su \`${short(commit)}\`: dici che ${claims.slice(0, 5).join(", ")} è già su main, ma origin/main non ha quel commit. Consegna il lavoro invece di dichiararlo fatto.`;
    return deps.bounce(card, why) ? "bounced" : "skipped";
  }

  // `null` is "could not tell", never "no": the card then goes through the ordinary review below.
  const onMain = await deps.onMain(card).catch(() => null);
  // A card sent back on this very commit asked for more work than the commit holds: being on main does not close it.
  if (onMain === true && !card.sentBackOnCommit) {
    const ask = (card.humanAsk ?? "").trim();
    if (ask && !asksOnlyApproval(ask)) return "person";
    deps.clear(card, "il commit consegnato è già contenuto in origin/main (git merge-base --is-ancestor)");
    return deps.close(card, `\`${short(commit)}\` è già contenuto in origin/main (git merge-base --is-ancestor): niente da fondere`) ? "landed" : "held";
  }

  const report = await deps.inspect(card, files).catch((e): InspectionReport => ({ kind: "unmeasured", why: String(e) }));
  if (report.kind === "unmeasured") { deps.log?.(`[scheduled-review] ${card.id.slice(0, 8)} non misurata: ${report.why}`); return "unmeasured"; }
  if (report.kind !== "green") { return deps.bounce(card, scheduledReviewMessage(commit, report)) ? "bounced" : "skipped"; }

  const sense = await deps.sense(card, files).catch((e): SenseVerdict => ({ kind: "unmeasured", why: String(e) }));
  if (sense.kind === "unmeasured") { deps.log?.(`[scheduled-review] ${card.id.slice(0, 8)} senso non misurato: ${sense.why}`); return "unmeasured"; }
  if (sense.kind === "person") { deps.log?.(`[scheduled-review] ${card.id.slice(0, 8)} a una persona: ${sense.why}`); return "person"; }
  if (sense.kind === "reject") return deps.bounce(card, `Ripasso a orario su \`${short(commit)}\`: ${sense.why}`) ? "bounced" : "skipped";
  if (sense.kind === "answer") return deps.answer(card, sense.text) ? "answered" : "skipped";
  // A question the reviewer did not answer stays with the person who was asked.
  const ask = (card.humanAsk ?? "").trim();
  if (ask && !asksOnlyApproval(ask)) return "person";
  deps.clear(card, sense.note);
  return (await deps.land(card)) ? "landed" : "held";
}
