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
  const { unmeasuredInReview, remeasureInReview, hasFreeSlot, isMeasuring } = createReviewSweep({
    svc: { update: () => BASE, get: () => undefined } as unknown as Parameters<typeof createReviewSweep>[0]["svc"],
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
  return { unmeasuredInReview, remeasureInReview, hasFreeSlot, isMeasuring, nodeMeasures };
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
 * when it is last in the list the board handed over, and even when
 * `svc.list`'s own `updated_at DESC` order disagrees.
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

  test("sorts by created_at internally: callers do not need their own sortForSweep call", () => {
    const newer = { ...BASE, id: "card-newer", createdAt: "2026-01-02T00:00:00.000Z", checksState: null, landIntent: null };
    const older = { ...BASE, id: "card-older", createdAt: "2026-01-01T00:00:00.000Z", checksState: null, landIntent: null };
    expect(orderForSweep([newer, older] as unknown as Task[]).map((t) => t.id)).toEqual(["card-older", "card-newer"]);
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

  test("a card already holding its own slot is reported by isMeasuring, so the sweep never queues it twice", async () => {
    let release: (() => void) | undefined;
    const stuck = new Promise<null>((resolve) => { release = () => resolve(null); });
    const { remeasureInReview, isMeasuring } = sweep({ maxConcurrent: 1, runChecksGate: async () => stuck as never });
    const inFlight = remeasureInReview({ ...BASE, id: "card-busy", checksState: null });
    expect(isMeasuring("card-busy")).toBe(true);
    release?.();
    await inFlight;
    expect(isMeasuring("card-busy")).toBe(false);
  });
});

/**
 * @covers LAND-07 — a card already measuring on the node lane must not also
 * hold a local gate slot, so a local card waiting behind it still gets to
 * start: the real defect was the local slot staying reserved for as long as
 * the node lane's own queue took (reviewer feedback 27/11, second round).
 */
describe("a node measure in flight does not block a local card from the real sweep", () => {
  test("with the cap at one, a node delivery's remeasure frees the slot in time for a local card behind it", async () => {
    let releaseNode: (() => void) | undefined;
    const nodeInFlight = new Promise<void>((resolve) => { releaseNode = resolve; });
    let releaseLocal: (() => void) | undefined;
    const localStuck = new Promise<Awaited<ReturnType<Parameters<typeof createReviewSweep>[0]["runChecksGate"]>>>((resolve) => {
      releaseLocal = () => resolve(null);
    });
    const reviewSweep = createReviewSweep({
      svc: { update: () => BASE, get: () => undefined } as unknown as Parameters<typeof createReviewSweep>[0]["svc"],
      broadcastToAll: () => undefined,
      // the node card's leg reports "no worktree" straight away; the local card's leg is the one left stuck
      runChecksGate: async (taskId: string) => (taskId === "card-node" ? null : (localStuck as never)),
      capturaConsegna: async () => false,
      nodeMeter: { measure: () => nodeInFlight },
      bounceRed: async () => false,
      afterDelivery: async () => undefined,
      bounceWithReason: () => true,
      maxConcurrent: 1,
    });
    const node = reviewSweep.remeasureInReview({ ...BASE, id: "card-node", checksState: null });
    // Give the node branch time to release its local slot before the node meter itself resolves.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(reviewSweep.hasFreeSlot()).toBe(true); // the local card behind it is not shut out
    const local = reviewSweep.remeasureInReview({ ...BASE, id: "card-local", checksState: null });
    expect(reviewSweep.hasFreeSlot()).toBe(false); // the local card now holds the one slot there is
    releaseLocal?.();
    releaseNode?.();
    await Promise.all([node, local]);
  });
});

describe("sortForSweep (arrival order, exported for callers that need it bare)", () => {
  test("orders by created_at, oldest first", () => {
    const newer = { ...BASE, id: "card-newer", createdAt: "2026-01-02T00:00:00.000Z" };
    const older = { ...BASE, id: "card-older", createdAt: "2026-01-01T00:00:00.000Z" };
    expect(sortForSweep([newer, older] as unknown as Task[]).map((t) => t.id)).toEqual(["card-older", "card-newer"]);
  });
});

/**
 * @covers LAND-06 — on the real `createTaskService`, `orderForSweep` must keep
 * the queue stable across rounds even when something else on the card (a
 * comment, a label) bumps `svc.list`'s own `updated_at DESC` order. The
 * reviewer's note is gone (27/11, second round): it was the only thing left
 * that could move `updated_at` on a card still waiting its turn, so there is
 * nothing in this sweep itself that drifts the order any more — this test
 * covers an unrelated write (a plain comment) landing on a queued card.
 */
describe("orderForSweep keeps the queue order stable on the real task service", () => {
  let db: Database; let svc: TaskService;
  beforeEach(() => { db = freshDb(); svc = createTaskService(db); });

  function reviewCard(text: string, createdAt: string, landIntent: "human" | null = null): Task {
    const t = svc.create({ projectId: "p1", text });
    db.prepare(
      "UPDATE tasks SET status = 'review', created_at = ?, updated_at = ?, delivery_branch = ?, delivery_commit = ?, checks_state = NULL, land_intent = ? WHERE id = ?",
    ).run(createdAt, createdAt, "topics/x", "abc1234", landIntent, t.id);
    return svc.get(t.id)!.task;
  }

  const reviewRows = (svcRef: TaskService) => svcRef.list({ scope: "all", status: "review", rootsOnly: true });

  test("an unrelated comment on a queued card bumps svc.list's own order, but orderForSweep's order holds", () => {
    // A (oldest, arrives first), B, then C (newest, landIntent=human): the
    // bar already prioritises C, so the drift this reproduces is between A
    // and B, the two that only ever wait.
    const a = reviewCard("card A", "2026-01-01T00:00:00.000Z");
    const b = reviewCard("card B", "2026-01-01T00:00:01.000Z");
    const c = reviewCard("card C", "2026-01-01T00:00:02.000Z", "human");

    const round1 = orderForSweep(reviewRows(svc)).map((t) => t.id);
    expect(round1).toEqual([c.id, a.id, b.id]); // human first, then arrival order

    // Something unrelated writes on A while it still waits (any comment bumps `updated_at`).
    svc.addComment({ taskId: a.id, author: "system", kind: "service", content: "qualcos'altro" });
    const rawRound2 = reviewRows(svc).map((t) => t.id);
    expect(rawRound2[0]).toBe(a.id); // `updated_at DESC`: A's own write moved it to the front of the raw list

    const round2 = orderForSweep(reviewRows(svc)).map((t) => t.id);
    expect(round2).toEqual(round1); // created_at never moved: orderForSweep's order holds regardless
  });
});

describe("remeasure count survives a restart", () => {
  test("a sweep recreated on the same card and commit resumes at 2/3, not 1/3", async () => {
    const records = new Map<string, { commit: string; at: number; tries: number }>();
    const remeasureStore = { get: (id: string) => records.get(id), set: (id: string, rec: { commit: string; at: number; tries: number }) => { records.set(id, rec); } };
    const build = () => createReviewSweep({
      svc: { update: () => BASE, get: () => undefined } as unknown as Parameters<typeof createReviewSweep>[0]["svc"],
      broadcastToAll: () => undefined,
      runChecksGate: async () => null,
      capturaConsegna: async () => false,
      nodeMeter: { measure: async () => undefined },
      bounceRed: async () => false,
      afterDelivery: async () => undefined,
      bounceWithReason: () => true,
      remeasureStore,
    });
    const logs: string[] = [];
    const original = console.warn;
    console.warn = (line: string) => { logs.push(String(line)); };
    try {
      await build().remeasureInReview({ ...BASE, checksState: null });
      // the pause is a clock matter: age the record so the restarted sweep may run again
      records.set(BASE.id, { ...records.get(BASE.id)!, at: 0 });
      await build().remeasureInReview({ ...BASE, checksState: null });
    } finally { console.warn = original; }
    expect(logs.some((l) => l.includes("(1/3)"))).toBe(true);
    expect(logs.some((l) => l.includes("(2/3)"))).toBe(true);
  });
});
