import { describe, expect, test } from "bun:test";
import { conflictedFiles, failedTestNames } from "./scheduled-review-inspect";
import { resolveWorkflowRules } from "../../shared/workflow";
import { reviewScheduled, scheduledReviewDue, type InspectionReport, type ScheduledReviewCard, type ScheduledReviewDeps } from "./scheduled-review";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const card = (over: Partial<ScheduledReviewCard> = {}): ScheduledReviewCard => ({
  id: "card-0001", projectId: "p", status: "review", humanAsk: null,
  deliveryBranch: "topics/x", deliveryCommit: "abcdef1234", lastPassAt: null, reviewAt: hoursAgo(3), ...over,
});

function harness(report: InspectionReport, files: string[] = ["server/a.ts", "server/a.test.ts"]) {
  const calls = { bounced: [] as string[], landed: [] as string[], stamped: 0 };
  const deps: ScheduledReviewDeps = {
    files: async () => files,
    personPaths: () => [],
    inspect: async () => report,
    turnIsLive: () => false,
    bounce: (_c, why) => { calls.bounced.push(why); return true; },
    land: (_c, commit) => { calls.landed.push(commit); },
    stamp: () => { calls.stamped += 1; },
  };
  return { deps, calls };
}

describe("scheduled review: the decision", () => {
  test("a technical card with a red test goes back to its agent, file and test named", async () => {
    const { deps, calls } = harness({ kind: "red", failures: [{ file: "server/a.test.ts", test: "adds two numbers" }] });
    expect(await reviewScheduled(card(), deps)).toBe("bounced");
    expect(calls.bounced[0]).toContain("server/a.test.ts");
    expect(calls.bounced[0]).toContain("adds two numbers");
    expect(calls.landed).toEqual([]);
  });

  test("a green technical card lands with no person in between", async () => {
    const { deps, calls } = harness({ kind: "green", tested: ["server/a.test.ts"] });
    expect(await reviewScheduled(card(), deps)).toBe("landed");
    expect(calls.landed).toEqual(["abcdef1234"]);
    expect(calls.bounced).toEqual([]);
  });

  test("a conflict with main goes back naming the file", async () => {
    const { deps, calls } = harness({ kind: "conflict", files: ["server/a.ts"] });
    expect(await reviewScheduled(card(), deps)).toBe("bounced");
    expect(calls.bounced[0]).toContain("server/a.ts");
  });

  test("a delivery touching what a person must see is left to that person", async () => {
    const { deps, calls } = harness({ kind: "green", tested: [] }, ["client/src/App.tsx"]);
    expect(await reviewScheduled(card(), deps)).toBe("person");
    expect(calls.landed).toEqual([]);
    expect(calls.bounced).toEqual([]);
  });

  test("an inspection that could not be made decides nothing and leaves no stamp", async () => {
    const { deps, calls } = harness({ kind: "unmeasured", why: "no checkout" });
    expect(await reviewScheduled(card(), deps)).toBe("unmeasured");
    expect(calls.stamped).toBe(0);
  });
});

describe("scheduled review: when a card is due", () => {
  test("off by default, and off means never", () => {
    expect(resolveWorkflowRules({}).scheduledReviewMinutes).toBe(0);
    expect(scheduledReviewDue(card(), NOW, 0)).toBe(false);
  });
  test("due once the interval has passed since the last pass", () => {
    expect(scheduledReviewDue(card({ lastPassAt: hoursAgo(3) }), NOW, 120)).toBe(true);
    expect(scheduledReviewDue(card({ lastPassAt: hoursAgo(1) }), NOW, 120)).toBe(false);
  });
  test("a card with a question for a person is never due", () => {
    expect(scheduledReviewDue(card({ humanAsk: "which layout?" }), NOW, 120)).toBe(false);
  });
  test("a card with no delivery of its own is never due", () => {
    expect(scheduledReviewDue(card({ deliveryCommit: null }), NOW, 120)).toBe(false);
  });
});

describe("scheduled review: reading the tools' output", () => {
  test("failed test names come from the (fail) lines", () => {
    expect(failedTestNames("(pass) ok [1ms]\n(fail) suite > adds [0.40ms]\n")).toEqual(["suite > adds"]);
  });
  test("conflicting files follow the tree line of merge-tree", () => {
    expect(conflictedFiles("deadbeef\nserver/a.ts\nserver/b.ts\n\nAuto-merging server/a.ts\n")).toEqual(["server/a.ts", "server/b.ts"]);
  });
});
