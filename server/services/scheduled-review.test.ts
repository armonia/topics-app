import { describe, expect, test } from "bun:test";
import { conflictedFiles, failedTestNames } from "./scheduled-review-inspect";
import { resolveWorkflowRules } from "../../shared/workflow";
import { autoLandVerdict, scheduledReviewCmd, type AutoLandCard } from "./auto-land";
import { claimedMainShas, parseSense, senseModelFor } from "./scheduled-review-sense";
import { reviewScheduled, scheduledReviewDue, type InspectionReport, type ScheduledReviewCard, type ScheduledReviewDeps, type SenseVerdict } from "./scheduled-review";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const card = (over: Partial<ScheduledReviewCard> = {}): ScheduledReviewCard => ({
  id: "card-0001", projectId: "p", status: "review", humanAsk: null,
  deliveryBranch: "topics/x", deliveryCommit: "abcdef1234", checksState: "pass", checksCommit: "abcdef1234",
  lastPassAt: null, reviewAt: hoursAgo(3), ...over,
});

function harness(report: InspectionReport, files: string[] = ["server/a.ts", "server/a.test.ts"], over: Partial<ScheduledReviewDeps> = {}) {
  const calls = { bounced: [] as string[], answered: [] as string[], cleared: [] as string[], landAsked: 0, stamped: 0 };
  const deps: ScheduledReviewDeps = {
    files: async () => files,
    personPaths: () => [],
    inspect: async () => report,
    falseMainClaims: async () => [],
    onMain: async () => false,
    bouncedBefore: () => null,
    sense: async (): Promise<SenseVerdict> => ({ kind: "ok", note: "does what the card asks" }),
    turnIsLive: () => false,
    bounce: (_c, why) => { calls.bounced.push(why); return true; },
    answer: (_c, text) => { calls.answered.push(text); return true; },
    clear: (_c, note) => { calls.cleared.push(note); },
    land: async () => { calls.landAsked += 1; return true; },
    stamp: () => { calls.stamped += 1; },
    ...over,
  };
  return { deps, calls };
}

describe("scheduled review: the decision", () => {
  test("a technical card with a red test goes back to its agent, file and test named", async () => {
    const { deps, calls } = harness({ kind: "red", failures: [{ file: "server/a.test.ts", test: "adds two numbers" }] });
    expect(await reviewScheduled(card(), deps)).toBe("bounced");
    expect(calls.bounced[0]).toContain("server/a.test.ts");
    expect(calls.bounced[0]).toContain("adds two numbers");
    expect(calls.landAsked).toBe(0);
  });

  test("a green card is cleared as a row of the bar, then the land is asked of the shared verdict", async () => {
    const { deps, calls } = harness({ kind: "green", tested: ["server/a.test.ts"] });
    expect(await reviewScheduled(card(), deps)).toBe("landed");
    expect(calls.cleared).toHaveLength(1);
    expect(calls.landAsked).toBe(1);
    expect(calls.bounced).toEqual([]);
  });

  test("when the shared verdict refuses, the pass says so and the card stays", async () => {
    const { deps } = harness({ kind: "green", tested: [] }, undefined, { land: async () => false });
    expect(await reviewScheduled(card(), deps)).toBe("held");
  });

  test("a conflict with main goes back naming the file", async () => {
    const { deps, calls } = harness({ kind: "conflict", files: ["server/a.ts"] });
    expect(await reviewScheduled(card(), deps)).toBe("bounced");
    expect(calls.bounced[0]).toContain("server/a.ts");
  });

  test("a delivery touching what a person must see is left to that person", async () => {
    const { deps, calls } = harness({ kind: "green", tested: [] }, ["client/src/App.tsx"]);
    expect(await reviewScheduled(card(), deps)).toBe("person");
    expect(calls.landAsked).toBe(0);
    expect(calls.bounced).toEqual([]);
  });

  test("an inspection that could not be made decides nothing and leaves no stamp", async () => {
    const { deps, calls } = harness({ kind: "unmeasured", why: "no checkout" });
    expect(await reviewScheduled(card(), deps)).toBe("unmeasured");
    expect(calls.stamped).toBe(0);
  });

  test("a bar still running, missing, or measured on another commit is not judged", async () => {
    const { deps, calls } = harness({ kind: "green", tested: [] });
    expect(await reviewScheduled(card({ checksState: "running" }), deps)).toBe("skipped");
    expect(await reviewScheduled(card({ checksState: null }), deps)).toBe("skipped");
    expect(await reviewScheduled(card({ checksCommit: "0000000999" }), deps)).toBe("skipped");
    expect(calls.landAsked).toBe(0);
  });
});

describe("scheduled review: judgement of sense and history (25/11)", () => {
  test("green tests but a diff that does the opposite of the card: sent back with the reviewer's reason, never cleared", async () => {
    const { deps, calls } = harness({ kind: "green", tested: ["server/a.test.ts"] }, undefined, {
      sense: async () => ({ kind: "reject", why: "countOnMachine counts cards in review: they take places from the nodes, the contrary of the card" }),
    });
    expect(await reviewScheduled(card(), deps)).toBe("bounced");
    expect(calls.bounced[0]).toContain("countOnMachine");
    expect(calls.cleared).toEqual([]);
    expect(calls.landAsked).toBe(0);
  });

  test("a reviewer that could not answer clears nothing and stamps nothing", async () => {
    const { deps, calls } = harness({ kind: "green", tested: [] }, undefined, { sense: async () => ({ kind: "unmeasured", why: "timeout" }) });
    expect(await reviewScheduled(card(), deps)).toBe("unmeasured");
    expect(calls.cleared).toEqual([]);
    expect(calls.stamped).toBe(0);
  });

  test("an 'already on main' the remote does not bear out goes back naming the sha", async () => {
    const { deps, calls } = harness({ kind: "green", tested: [] }, undefined, { falseMainClaims: async () => ["3142302"] });
    expect(await reviewScheduled(card(), deps)).toBe("bounced");
    expect(calls.bounced[0]).toContain("3142302");
    expect(calls.cleared).toEqual([]);
  });

  test("the same commit delivered again after a red goes back with the red first", async () => {
    const { deps, calls } = harness({ kind: "green", tested: [] }, undefined, { bouncedBefore: () => "gates:fast rosso su untraced-tests." });
    expect(await reviewScheduled(card(), deps)).toBe("bounced");
    expect(calls.bounced[0]).toContain("gates:fast rosso su untraced-tests");
    expect(calls.bounced[0]).toContain("stesso commit");
  });

  test("a premise already true on main closes with git's proof instead of being dispatched", async () => {
    const { deps, calls } = harness({ kind: "green", tested: [] }, undefined, { onMain: async () => true });
    expect(await reviewScheduled(card(), deps)).toBe("landed");
    expect(calls.cleared[0]).toContain("origin/main");
  });

  test("a technical question of the agent is answered by the reviewer, not left to a person", async () => {
    const { deps, calls } = harness({ kind: "green", tested: [] }, undefined, { sense: async () => ({ kind: "answer", text: "use the existing helper" }) });
    expect(await reviewScheduled(card({ humanAsk: "should I reuse the helper or write a new one?" }), deps)).toBe("answered");
    expect(calls.answered).toEqual(["use the existing helper"]);
  });

  test("a question the reviewer calls a person's keeps the card with that person", async () => {
    const { deps, calls } = harness({ kind: "green", tested: [] }, undefined, { sense: async () => ({ kind: "person", why: "it spends money" }) });
    expect(await reviewScheduled(card({ humanAsk: "buy the plan?" }), deps)).toBe("person");
    expect(calls.landAsked).toBe(0);
  });

  test("a verdict ok over a question that is not only an approval never lands", async () => {
    const { deps, calls } = harness({ kind: "green", tested: [] });
    expect(await reviewScheduled(card({ humanAsk: "which layout do you prefer?" }), deps)).toBe("person");
    expect(calls.cleared).toEqual([]);
  });

  test("the reviewer's JSON is read, anything else is unmeasured and never ok", () => {
    expect(parseSense('{"verdict":"ok","note":"fine"}')).toEqual({ kind: "ok", note: "fine" });
    expect(parseSense(JSON.stringify({ result: '```json\n{"verdict":"reject","why":"x"}\n```' }))).toEqual({ kind: "reject", why: "x" });
    expect(parseSense("I think it is fine").kind).toBe("unmeasured");
    expect(parseSense('{"verdict":"reject"}').kind).toBe("unmeasured");
  });

  test("shas next to an already-on-main claim are found, and the reviewer differs from the writer", () => {
    expect(claimedMainShas("Fatto. Il commit 31423024 è già su main. Altro 1234567 no.")).toEqual(["31423024"]);
    expect(senseModelFor("claude-haiku-5-5")).not.toBe("claude-haiku-5-5");
    expect(senseModelFor("claude-opus-5-5")).toBe("claude-haiku-5-5");
  });
});

describe("scheduled review: the shared land verdict reads the review's row", () => {
  const green = { status: "review", labels: [{ label: "invisibile" }], checksState: "pass", checksCommit: "abcdef1234", deliveryBranch: "b", deliveryCommit: "abcdef1234", checks: [{ ok: true, cmd: "bun test" }] } as AutoLandCard;
  const board = { autoMerge: true, declaredChecks: 1, scheduledReview: true };
  const row = { ok: true, cmd: scheduledReviewCmd("abcdef1234") };

  test("with the rule on, an invisible card with a green bar does not land without the review's row", () => {
    expect(autoLandVerdict(green, board, [])).toMatchObject({ ok: false });
    expect(autoLandVerdict(green, { ...board, scheduledReview: false }, [])).toEqual({ ok: true });
  });
  test("the row clears the commit it names and no other; it is not one of the declared commands", () => {
    expect(autoLandVerdict({ ...green, checks: [...green.checks!, row] }, board, [])).toEqual({ ok: true });
    expect(autoLandVerdict({ ...green, checks: [...green.checks!, { ok: true, cmd: scheduledReviewCmd("1111111111") }] }, board, [])).toMatchObject({ ok: false });
    expect(autoLandVerdict({ ...green, checks: [row] }, board, [])).toMatchObject({ ok: false });
  });
  test("a technical card needs no label once reviewed, a visible one never lands alone", () => {
    const plain = { ...green, labels: [], checks: [...green.checks!, row] } as AutoLandCard;
    expect(autoLandVerdict(plain, board, [])).toEqual({ ok: true });
    expect(autoLandVerdict({ ...plain, labels: [{ label: "visibile" }] }, board, [])).toMatchObject({ ok: false });
  });
  test("a person who wrote after the review, or a dispatch error, still stops it", () => {
    const ok = { ...green, reviewAt: "2026-11-25T10:00:00Z", checks: [...green.checks!, row] } as AutoLandCard;
    expect(autoLandVerdict(ok, board, [{ author: "user", content: "no", createdAt: "2026-11-25T11:00:00Z" }])).toMatchObject({ ok: false });
    expect(autoLandVerdict({ ...ok, dispatchError: "quota" }, board, [])).toMatchObject({ ok: false });
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
