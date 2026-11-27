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
import { describe, expect, test } from "bun:test";
import { createReviewSweep, orderForSweep } from "./tasks-review-sweep";
import type { Task } from "../services/tasks";

const BASE = {
  id: "card-1", projectId: "p", deliveryCommit: "abc1234", deliveryBranch: "topics/x",
  checksCommit: null, humanAsk: null, landIntent: null,
} as unknown as Task;

function sweep(over: { nodeMeasures?: string[]; maxConcurrent?: number; runChecksGate?: Parameters<typeof createReviewSweep>[0]["runChecksGate"] } = {}) {
  const nodeMeasures = over.nodeMeasures ?? [];
  const { unmeasuredInReview, remeasureInReview, hasFreeSlot } = createReviewSweep({
    svc: { update: () => BASE, get: () => undefined, addComment: () => undefined } as unknown as Parameters<typeof createReviewSweep>[0]["svc"],
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
  return { unmeasuredInReview, remeasureInReview, hasFreeSlot, nodeMeasures };
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
