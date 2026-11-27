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
import { createReviewSweep } from "./tasks-review-sweep";
import type { Task } from "../services/tasks";

const BASE = {
  id: "card-1", projectId: "p", deliveryCommit: "abc1234", deliveryBranch: "topics/x",
  checksCommit: null, humanAsk: null,
} as unknown as Task;

function sweep(over: { nodeMeasures?: string[] } = {}) {
  const nodeMeasures = over.nodeMeasures ?? [];
  const { unmeasuredInReview, remeasureInReview } = createReviewSweep({
    svc: { update: () => BASE, get: () => undefined } as unknown as Parameters<typeof createReviewSweep>[0]["svc"],
    broadcastToAll: () => undefined,
    runChecksGate: async () => null, // no worktree of its own: a node delivery
    capturaConsegna: async () => false,
    nodeMeter: { measure: async (taskId: string) => { nodeMeasures.push(taskId); } },
    bounceRed: async () => false,
    afterDelivery: async () => undefined,
    bounceWithReason: () => true,
  });
  return { unmeasuredInReview, remeasureInReview, nodeMeasures };
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
