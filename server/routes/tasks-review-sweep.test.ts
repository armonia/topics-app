/**
 * `unmeasuredInReview` is the gate that decides which review cards the sweep
 * remeasures. `checksState: null` used to be read as "nothing to do" — a
 * node delivery whose meter never started (a restart cut it, the checkout
 * was missing) sat there forever, since nothing else ever asked again.
 */
import { describe, test, expect } from "bun:test";
import { createReviewSweep } from "./tasks-review-sweep";
import type { Task } from "../services/tasks";

function card(patch: Partial<Task>): Task {
  return {
    id: "t1", deliveryCommit: "abc1234", deliveryBranch: "topics/x",
    humanAsk: null, checksState: null, checksCommit: null,
    ...patch,
  } as Task;
}

function sweep() {
  return createReviewSweep({
    svc: {} as never,
    broadcastToAll: () => {},
    runChecksGate: (() => Promise.resolve(null)) as never,
    capturaConsegna: (() => Promise.resolve()) as never,
    nodeMeter: { measure: async () => {} },
    bounceRed: (async () => false) as never,
    afterDelivery: (async () => {}) as never,
    bounceWithReason: (async () => false) as never,
  });
}

describe("unmeasuredInReview", () => {
  test("checksState null, with a commit and a branch of its own, is unmeasured", () => {
    const { unmeasuredInReview } = sweep();
    expect(unmeasuredInReview(card({ checksState: null }))).toBe(true);
  });

  test("checksState unknown stays unmeasured, as before", () => {
    const { unmeasuredInReview } = sweep();
    expect(unmeasuredInReview(card({ checksState: "unknown" }))).toBe(true);
  });

  test("no delivery commit or branch: never (a board without checks reads null forever, harmlessly)", () => {
    const { unmeasuredInReview } = sweep();
    expect(unmeasuredInReview(card({ checksState: null, deliveryCommit: null }))).toBe(false);
    expect(unmeasuredInReview(card({ checksState: null, deliveryBranch: null }))).toBe(false);
  });

  test("a human question already on the card: left alone", () => {
    const { unmeasuredInReview } = sweep();
    expect(unmeasuredInReview(card({ checksState: null, humanAsk: "serve una scelta" }))).toBe(false);
  });

  test("pass on the delivered commit: settled, not unmeasured", () => {
    const { unmeasuredInReview } = sweep();
    expect(unmeasuredInReview(card({ checksState: "pass", checksCommit: "abc1234" }))).toBe(false);
  });
});
