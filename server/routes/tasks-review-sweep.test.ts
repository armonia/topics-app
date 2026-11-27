/**
 * `unmeasuredInReview` decides which review cards the sweep remeasures.
 *
 * A node delivery enters review with `checks_state` left at its column
 * default, `null` — never the string `"unknown"` the local gate writes once
 * it has actually looked and found nothing to report. The check only matched
 * the string, so eleven node deliveries sat in review with no verdict and no
 * retry, silently, forever (found 26/11).
 *
 * @covers LAND-05
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createReviewSweep, orderForSweep, sortForSweep } from "./tasks-review-sweep";
import { createTaskService, type TaskService } from "../services/tasks";
import { freshDb } from "./tasks-test-support";
import type { Task } from "../services/tasks";

const BASE = {
  id: "card-1", projectId: "p", deliveryCommit: "abc1234", deliveryBranch: "topics/x",
  checksCommit: null, humanAsk: null, landIntent: null,
} as unknown as Task;

function sweep(over: { nodeMeasures?: string[]; maxConcurrent?: number; runChecksGate?: Parameters<typeof createReviewSweep>[0]["runChecksGate"] } = {}) {
  const nodeMeasures = over.nodeMeasures ?? [];
  const { unmeasuredInReview, remeasureInReview, hasFreeSlot, isMeasuring, noteQueued, clearQueuedNote } = createReviewSweep({
    svc: { update: () => BASE, get: () => undefined, addComment: () => undefined } as unknown as Parameters<typeof createReviewSweep>[0]["svc"],
    db: { prepare: () => ({ run: () => undefined }) } as unknown as Parameters<typeof createReviewSweep>[0]["db"],
    broadcastToAll: () => undefined,
    // no worktree of its own: a node delivery, unless the test overrides it
    runChecksGate: over.runChecksGate ?? (async () => null),
    capturaConsegna: async () => false,
    nodeMeter: { measure: async (taskId: string) => { nodeMeasures.push(taskId); } },
    bounceRed: async () => false,
    afterDelivery: async () => undefined,
    bounceWithReason: () => true,
    maxConcurrent: over.maxConcurrent,
  });
  return { unmeasuredInReview, remeasureInReview, hasFreeSlot, isMeasuring, noteQueued, clearQueuedNote, nodeMeasures };
}

describe("unmeasuredInReview", () => {
  test("checks_state NULL (a node delivery that never ran once) is unmeasured, same as the string unknown", () => {
    const { unmeasuredInReview } = sweep();
    expect(unmeasuredInReview({ ...BASE, checksState: null })).toBe(true);
    expect(unmeasuredInReview({ ...BASE, checksState: "unknown" })).toBe(true);
  });

  test("a verdict about a stale commit is unmeasured, one about the delivered commit is not", () => {
    const { unmeasuredInReview } = sweep();
    expect(unmeasuredInReview({ ...BASE, checksState: "fail", checksCommit: "zzzzzzz" })).toBe(true);
    expect(unmeasuredInReview({ ...BASE, checksState: "pass", checksCommit: "abc1234" })).toBe(false);
  });

  test("no delivery, or a human already asked: never unmeasured", () => {
    const { unmeasuredInReview } = sweep();
    expect(unmeasuredInReview({ ...BASE, checksState: null, deliveryCommit: null })).toBe(false);
    expect(unmeasuredInReview({ ...BASE, checksState: null, humanAsk: "guarda tu" })).toBe(false);
  });
});

describe("remeasureInReview on a null-state node delivery", () => {
  test("the found case: a planted delivery with no verdict gets handed to the node meter", async () => {
    const { remeasureInReview, nodeMeasures } = sweep();
    await remeasureInReview({ ...BASE, checksState: null });
    expect(nodeMeasures).toEqual(["card-1"]);
  });
});

/**
 * @covers LAND-06 — a person who already said "land it" waits only on the
 * bar: that card is measured before cards nobody has looked at yet, even
 * when it is last in the list the board handed over.
 */
describe("orderForSweep", () => {
  test("a card with landIntent human and no verdict goes first, even last in the list", () => {
    const untouched = { ...BASE, id: "card-untouched", checksState: null, landIntent: null };
    const alreadyPass = { ...BASE, id: "card-pass", checksState: "pass", checksCommit: "abc1234", landIntent: null };
    const humanLand = { ...BASE, id: "card-human", checksState: null, landIntent: "human" };
    const ordered = orderForSweep([untouched, alreadyPass, humanLand] as unknown as Task[]);
    expect(ordered.map((t) => t.id)).toEqual(["card-human", "card-untouched", "card-pass"]);
  });

  test("two human-intent cards with no verdict keep their relative order", () => {
    const humanA = { ...BASE, id: "card-a", checksState: null, landIntent: "human" };
    const humanB = { ...BASE, id: "card-b", checksState: null, landIntent: "human" };
    const other = { ...BASE, id: "card-c", checksState: null, landIntent: null };
    const ordered = orderForSweep([other, humanA, humanB] as unknown as Task[]);
    expect(ordered.map((t) => t.id)).toEqual(["card-a", "card-b", "card-c"]);
  });
});

/**
 * @covers LAND-06 — the single `reviewMeasuring: string | null` flag used to
 * block every other card until the one measure in flight ended, even though
 * the checks gate underneath already allows more than one run.
 */
describe("hasFreeSlot / concurrent remeasures", () => {
  test("a measure that never resolves still leaves a slot for a second card, within the cap", async () => {
    let release: (() => void) | undefined;
    const stuck = new Promise<Awaited<ReturnType<Parameters<typeof createReviewSweep>[0]["runChecksGate"]>>>((resolve) => {
      release = () => resolve(null);
    });
    const { remeasureInReview, hasFreeSlot } = sweep({
      maxConcurrent: 2,
      runChecksGate: async () => stuck as ReturnType<Parameters<typeof createReviewSweep>[0]["runChecksGate"]>,
    });
    expect(hasFreeSlot()).toBe(true);
    const first = remeasureInReview({ ...BASE, id: "card-first", checksState: null });
    // The first measure is in flight (its runChecksGate promise never settled), yet a second slot is still open.
    expect(hasFreeSlot()).toBe(true);
    const second = remeasureInReview({ ...BASE, id: "card-second", checksState: null });
    expect(hasFreeSlot()).toBe(false); // both slots of the cap (2) are now taken
    release?.();
    await Promise.all([first, second]);
    expect(hasFreeSlot()).toBe(true);
  });
});

/**
 * @covers LAND-06 — the queue note for a card still waiting its turn, on the
 * real `createTaskService`: it must not rewrite itself (a changing number
 * used to drift with every sweep), and it must not survive past the point
 * the card stops being unmeasured. Found by a verifier running these against
 * a real database, which the mocked `svc` above could not catch (27/11).
 */
describe("noteQueued, on the real task service", () => {
  let db: Database; let svc: TaskService;
  beforeEach(() => { db = freshDb(); svc = createTaskService(db); });

  function reviewCard(text: string, createdAt: string, landIntent: "human" | null = null): Task {
    const t = svc.create({ projectId: "p1", text });
    db.prepare(
      "UPDATE tasks SET status = 'review', created_at = ?, updated_at = ?, delivery_branch = ?, delivery_commit = ?, checks_state = NULL, land_intent = ? WHERE id = ?",
    ).run(createdAt, createdAt, "topics/x", "abc1234", landIntent, t.id);
    return svc.get(t.id)!.task;
  }

  function sweepDeps(maxConcurrent = 1) {
    return createReviewSweep({
      svc, db, broadcastToAll: () => undefined,
      runChecksGate: async () => null, capturaConsegna: async () => false,
      nodeMeter: { measure: async () => undefined }, bounceRed: async () => false,
      afterDelivery: async () => undefined, bounceWithReason: () => true, maxConcurrent,
    });
  }

  test("the note is written once; a second and third call do not rewrite it or touch the card", () => {
    const card = reviewCard("card senza slot", "2026-01-01T00:00:00.000Z");
    const sweep = sweepDeps();
    sweep.noteQueued(card);
    const after1 = svc.get(card.id)!;
    expect(after1.comments.filter((c) => c.content === "In fila per la barra.")).toHaveLength(1);
    const updatedAt1 = after1.task.updatedAt;
    sweep.noteQueued(card);
    sweep.noteQueued(card);
    const after3 = svc.get(card.id)!;
    expect(after3.comments.filter((c) => c.content === "In fila per la barra.")).toHaveLength(1);
    expect(after3.task.updatedAt).toBe(updatedAt1); // no rewrite: the dedupe never saw a different body
  });

  test("once the measure starts, a previously-written queue note is cleared", () => {
    const card = reviewCard("card misurata", "2026-01-01T00:00:00.000Z");
    const sweep = sweepDeps();
    sweep.noteQueued(card);
    expect(svc.get(card.id)!.comments.some((c) => c.content === "In fila per la barra.")).toBe(true);
    sweep.clearQueuedNote(card.id);
    expect(svc.get(card.id)!.comments.some((c) => c.content === "In fila per la barra.")).toBe(false);
  });

  test("a card already holding its own slot is reported by isMeasuring, so the sweep never queues it twice", async () => {
    let release: (() => void) | undefined;
    const stuck = new Promise<null>((resolve) => { release = () => resolve(null); });
    const card = reviewCard("card in misura", "2026-01-01T00:00:00.000Z");
    const sweep = createReviewSweep({
      svc, db, broadcastToAll: () => undefined,
      runChecksGate: async () => stuck as never, capturaConsegna: async () => false,
      nodeMeter: { measure: async () => undefined }, bounceRed: async () => false,
      afterDelivery: async () => undefined, bounceWithReason: () => true, maxConcurrent: 1,
    });
    const inFlight = sweep.remeasureInReview({ ...card, checksState: null } as unknown as Task);
    expect(sweep.isMeasuring(card.id)).toBe(true);
    release?.();
    await inFlight;
    expect(sweep.isMeasuring(card.id)).toBe(false);
  });
});

/**
 * @covers LAND-06 — the queue's order must survive the side effect of its own
 * note. `svc.list({scope:"all"})` sorts by `updated_at DESC`, and the FIRST
 * write of a queue note (never deduped, since nothing was there before) bumps
 * that column: on real timestamps, whichever card gets queued LAST in a round
 * becomes the NEWEST by `updated_at` and jumps to the front of that order on
 * the next round. `sortForSweep` (by `created_at`, which nothing here moves)
 * is what keeps the queue's order from drifting under its own notes.
 */
describe("sortForSweep keeps the queue order from drifting under its own notes", () => {
  let db: Database; let svc: TaskService;
  beforeEach(() => { db = freshDb(); svc = createTaskService(db); });

  function reviewCard(text: string, createdAt: string, landIntent: "human" | null = null): Task {
    const t = svc.create({ projectId: "p1", text });
    db.prepare(
      "UPDATE tasks SET status = 'review', created_at = ?, updated_at = ?, delivery_branch = ?, delivery_commit = ?, checks_state = NULL, land_intent = ? WHERE id = ?",
    ).run(createdAt, createdAt, "topics/x", "abc1234", landIntent, t.id);
    return svc.get(t.id)!.task;
  }

  function sweepDeps() {
    return createReviewSweep({
      svc, db, broadcastToAll: () => undefined,
      runChecksGate: async () => null, capturaConsegna: async () => false,
      nodeMeter: { measure: async () => undefined }, bounceRed: async () => false,
      afterDelivery: async () => undefined, bounceWithReason: () => true, maxConcurrent: 1,
    });
  }

  const reviewRows = (svcRef: TaskService) => svcRef.list({ scope: "all", status: "review", rootsOnly: true });

  test("fixed order (sortForSweep) stays the same across rounds; raw svc.list order does not", () => {
    // A (oldest, arrives first), B, then C (newest, landIntent=human): the
    // bar already prioritises C, so the drift this reproduces is between A
    // and B, the two that only ever queue.
    const a = reviewCard("card A", "2026-01-01T00:00:00.000Z");
    const b = reviewCard("card B", "2026-01-01T00:00:01.000Z");
    const c = reviewCard("card C", "2026-01-01T00:00:02.000Z", "human");
    const reviewSweep = sweepDeps();

    const fixedRound1 = orderForSweep(sortForSweep(reviewRows(svc))).map((t) => t.id);
    const rawRound1 = orderForSweep(reviewRows(svc)).map((t) => t.id);
    expect(fixedRound1).toEqual([c.id, a.id, b.id]); // human first, then arrival order
    expect(rawRound1).toEqual([c.id, b.id, a.id]); // `updated_at DESC` is reverse-chronological: the rest is already backwards

    // Round 1 of the real sweep: C holds the only slot, A queues — the note's
    // first write is never deduped, so it bumps A's `updated_at` to "now",
    // far past every fixture date above.
    reviewSweep.noteQueued(a);

    const fixedRound2 = orderForSweep(sortForSweep(reviewRows(svc))).map((t) => t.id);
    const rawRound2 = orderForSweep(reviewRows(svc)).map((t) => t.id);
    expect(fixedRound2).toEqual(fixedRound1); // created_at never moved: the fixed order holds
    expect(rawRound2).not.toEqual(rawRound1); // A's own queue note moved it ahead of B under `updated_at DESC`
  });
});
