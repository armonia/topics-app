/**
 * THE CLIENT'S ATTENTION STORE AND ITS TWO FUNCTIONS (notifications-redesign,
 * tasks.md 3.1): filled only by `attention:init` (replaces) and
 * `attention:updated` (applies), read through `attentionOf` and
 * `rollupAttention`. Plus the phase helpers that still name a session's
 * activity LABEL (they no longer decide whether anything lights up).
 *
 * @covers ATTN-01, ATTN-06, ATTN-07, ATTN-12, MUTE-01, PARITY-01
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { attentionActions, attentionOf, attentionOfRow, needsSeen, rollupAttention, sendAttentionSeen, sendAttentionSeenItems, useAttentionStore } from "./attention";
import { attentionTierForPhase, derivePhaseTerminals, deriveSessionActivity } from "./signals";
import type { AttentionSnapshot } from "../../../shared/attention";
import type { Topic, ClaudeSessionState } from "../types";

const topic = (id: string, over: Partial<Topic> = {}): Topic =>
  ({ id, name: id, ...over } as Topic);

const sess = (over: Partial<ClaudeSessionState> = {}): ClaudeSessionState => ({
  sessionKey: null, claudeSessionId: "c", phase: "running",
  phaseUpdatedAt: 1000, jsonlOffset: 0, rev: 1, createdAt: 1000, updatedAt: 1000, ...over,
});

function snap(subject: string, over: Partial<AttentionSnapshot> = {}): AttentionSnapshot {
  return {
    subject, state: "idle", reason: null, outcome: null, detail: null, since: "2026-10-03T10:00:00.000Z",
    epoch: 0, seenEpoch: 0, lit: false, unread: 0, turnUnseen: false, lastTurnAt: null, background: [], ...over,
  };
}
const rows = () => useAttentionStore.getState().rows;

beforeEach(() => attentionActions.reset());

describe("attentionOf: one subject", () => {
  test("a lit finished chat is 'done' with max(1, unread)", () => {
    expect(attentionOfRow(snap("topic:a", { state: "finished", outcome: "done", lit: true, epoch: 2 }))).toMatchObject({ tier: "done", lit: true, count: 1 });
    expect(attentionOfRow(snap("topic:a", { state: "finished", outcome: "done", lit: true, unread: 4 }))).toMatchObject({ count: 4 });
  });
  test("an error is 'error', a question 'needs-you' with its reason", () => {
    expect(attentionOfRow(snap("topic:a", { state: "finished", outcome: "error", lit: true })).tier).toBe("error");
    expect(attentionOfRow(snap("topic:a", { state: "needs-you", reason: "question", lit: true }))).toMatchObject({ tier: "needs-you", reason: "question", count: 1 });
  });
  test("a finished subject already seen draws nothing and has no number, whatever its unread", () => {
    expect(attentionOfRow(snap("topic:a", { state: "finished", outcome: "done", lit: false, unread: 3 }))).toMatchObject({ tier: null, lit: false, count: 0 });
  });
  test("working, a turn or a job left running, is a tier that never carries a number", () => {
    const bg = attentionOfRow(snap("topic:a", { state: "working", unread: 2, background: [{ id: "b", kind: "bash", label: "x", startedAt: "" }] }));
    expect(bg).toMatchObject({ tier: "working", lit: false, count: 0 });
    expect(bg.background.length).toBe(1);
    expect(attentionOfRow(snap("topic:a", { state: "working" }))).toMatchObject({ tier: "working", count: 0 });
  });
  test("no row is idle", () => {
    expect(attentionOf(new Map(), "topic:x")).toMatchObject({ tier: null, lit: false, count: 0, subject: "topic:x" });
  });
});

describe("rollupAttention: a set of subjects", () => {
  const v = (over: Partial<AttentionSnapshot>) => attentionOfRow(snap("topic:x", over));
  test("needs-you beats error beats done; the count is the lit children", () => {
    const done = v({ state: "finished", outcome: "done", lit: true });
    const error = v({ state: "finished", outcome: "error", lit: true });
    const ask = v({ state: "needs-you", reason: "permission", lit: true });
    const bg = v({ state: "working", background: [{ id: "b", kind: "bash", label: "x", startedAt: "" }] });
    expect(rollupAttention([done, bg])).toEqual({ tier: "done", count: 1 });
    expect(rollupAttention([done, error])).toEqual({ tier: "error", count: 2 });
    expect(rollupAttention([error, ask, done, bg])).toEqual({ tier: "needs-you", count: 3 });
    expect(rollupAttention([bg])).toEqual({ tier: null, count: 0 });
  });
});

describe("the store: init replaces, updated applies", () => {
  test("init replaces the whole store, keeping the identity of an unchanged row", () => {
    attentionActions.applyFrame({ type: "attention:init", rows: [snap("topic:a", { state: "working" }), snap("topic:b", { state: "working" })] });
    const a = rows().get("topic:a");
    attentionActions.applyFrame({ type: "attention:init", rows: [snap("topic:a", { state: "working" })] });
    expect([...rows().keys()]).toEqual(["topic:a"]);
    expect(rows().get("topic:a")).toBe(a);
    expect(useAttentionStore.getState().ready).toBe(true);
  });
  test("an update to idle with nothing to show removes the row", () => {
    attentionActions.applyFrame({ type: "attention:updated", row: snap("topic:a", { state: "working" }), live: true });
    attentionActions.applyFrame({ type: "attention:updated", row: snap("topic:a"), live: true });
    expect(rows().has("topic:a")).toBe(false);
  });
  test("an identical update leaves the store as it was (no render)", () => {
    attentionActions.applyFrame({ type: "attention:updated", row: snap("topic:a", { state: "working" }), live: true });
    const before = rows();
    attentionActions.applyFrame({ type: "attention:updated", row: snap("topic:a", { state: "working" }), live: true });
    expect(rows()).toBe(before);
  });
  test("other frames are not its business", () => {
    expect(attentionActions.applyFrame({ type: "message:new" })).toBe(false);
  });
});

describe("the seen of this window: optimistic, for one epoch", () => {
  const lit = (epoch: number, at: string, over: Partial<AttentionSnapshot> = {}) =>
    snap("topic:a", { state: "finished", outcome: "done", lit: true, epoch, lastTurnAt: at, turnUnseen: true, unread: 2, ...over });

  test("applied at once, kept over a late frame of the same epoch, released by the confirmation", () => {
    attentionActions.applyFrame({ type: "attention:updated", row: lit(3, "2026-10-03T10:00:00.000Z"), live: true });
    attentionActions.seeLocally("topic:a");
    expect(attentionOf(rows(), "topic:a")).toMatchObject({ lit: false, count: 0, unread: 0 });
    // A frame sent before the server applied the seen arrives late: still seen here.
    attentionActions.applyFrame({ type: "attention:updated", row: lit(3, "2026-10-03T10:00:00.000Z"), live: true });
    expect(attentionOf(rows(), "topic:a").lit).toBe(false);
    // The confirmation, then a NEW epoch: lit again.
    attentionActions.applyFrame({ type: "attention:updated", row: lit(3, "2026-10-03T10:00:00.000Z", { seenEpoch: 3, lit: false, turnUnseen: false, unread: 0 }), live: true });
    attentionActions.applyFrame({ type: "attention:updated", row: lit(4, "2026-10-03T10:09:00.000Z"), live: true });
    expect(attentionOf(rows(), "topic:a")).toMatchObject({ lit: true, epoch: 4 });
  });

  test("a needs-you seen stays lit: the look does not answer it", () => {
    attentionActions.applyFrame({ type: "attention:updated", row: snap("topic:q", { state: "needs-you", reason: "question", lit: true, epoch: 2 }), live: true });
    attentionActions.seeLocally("topic:q");
    expect(attentionOf(rows(), "topic:q")).toMatchObject({ lit: true, tier: "needs-you" });
    expect(needsSeen(attentionOf(rows(), "topic:q"))).toBe(false);
  });

  test("«Mark all seen» switches off only the epochs it was shown", () => {
    attentionActions.applyFrame({ type: "attention:init", rows: [lit(4, "2026-10-03T10:00:00.000Z"), snap("topic:b", { state: "finished", outcome: "done", lit: true, epoch: 1 })] });
    // The list showed epoch 4 of a; epoch 5 arrives before the click.
    attentionActions.applyFrame({ type: "attention:updated", row: lit(5, "2026-10-03T10:05:00.000Z"), live: true });
    sendAttentionSeenItems([{ subject: "topic:a", epoch: 4, turnAt: "2026-10-03T10:00:00.000Z" }, { subject: "topic:b", epoch: 1, turnAt: null }]);
    expect(attentionOf(rows(), "topic:a").lit).toBe(true);
    expect(attentionOf(rows(), "topic:b").lit).toBe(false);
  });
});

describe("a seen the server never got (ATTN-07: the snapshot replaces the store)", () => {
  const server = snap("topic:A", { state: "finished", outcome: "done", detail: "ok", epoch: 3, seenEpoch: 2, lit: true, unread: 1, turnUnseen: true, lastTurnAt: "2026-10-03T10:00:00.000Z" });
  const realFetch = globalThis.fetch;
  let posts = 0;
  beforeEach(() => {
    posts = 0;
    // The server is down (a restart, the laptop asleep): the POST never arrives.
    globalThis.fetch = (() => { posts++; return Promise.reject(new TypeError("Failed to fetch")); }) as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  test("the reconnect's attention:init lights the subject again, as on every other window, and the dwell would resend", async () => {
    attentionActions.applyFrame({ type: "attention:init", rows: [server] });
    attentionActions.seeLocally("topic:A");
    expect(attentionOf(rows(), "topic:A").lit).toBe(false);
    // The socket comes back before the failure is known: the snapshot alone corrects the window.
    attentionActions.applyFrame({ type: "attention:init", rows: [server] });
    const mine = attentionOf(rows(), "topic:A");
    expect(mine).toMatchObject({ lit: true, count: 1 });
    expect(needsSeen(mine)).toBe(true);
  });

  test("a failed POST of the seen gives back the server's row", async () => {
    attentionActions.applyFrame({ type: "attention:init", rows: [server] });
    sendAttentionSeen(["topic:A"]);
    expect(attentionOf(rows(), "topic:A").lit).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(posts).toBe(1);
    expect(attentionOf(rows(), "topic:A")).toMatchObject({ lit: true, count: 1 });
  });
});

describe("needsSeen: when the focused pane has something to tell the server", () => {
  test("a lit epoch not seen, unread messages, or a closed turn not seen (a job left running, T7)", () => {
    expect(needsSeen(attentionOfRow(snap("topic:a", { state: "finished", outcome: "done", lit: true, epoch: 1 })))).toBe(true);
    expect(needsSeen(attentionOfRow(snap("topic:a", { unread: 1 })))).toBe(true);
    expect(needsSeen(attentionOfRow(snap("topic:a", { state: "working", turnUnseen: true, background: [{ id: "b", kind: "bash", label: "x", startedAt: "" }] })))).toBe(true);
    expect(needsSeen(attentionOfRow(snap("topic:a", { state: "working" })))).toBe(false);
  });
});

describe("attentionTierForPhase", () => {
  test("awaiting-approval is the LOUD 'input' tier", () => {
    expect(attentionTierForPhase("awaiting-approval")).toBe("input");
  });
  test("awaiting-user and paused are the calm 'done' tier", () => {
    expect(attentionTierForPhase("awaiting-user")).toBe("done");
    expect(attentionTierForPhase("paused")).toBe("done");
  });
  test("working/error/idle phases have no tier (badge handles error)", () => {
    for (const p of ["running", "tool-running", "error", "completed", "dormant", "starting"] as const) {
      expect(attentionTierForPhase(p)).toBeNull();
    }
  });
});

describe("derivePhaseTerminals: the loading split (and the label tiers)", () => {
  const roster = [
    { id: "term-appr", type: "claude-code", claudeSessionId: "a" },
    { id: "term-user", type: "claude-code", claudeSessionId: "u" },
    { id: "term-run", type: "claude-code", claudeSessionId: "r" },
    { id: "shell", type: "shell", claudeSessionId: null },
  ];
  const byCsid = new Map([
    ["a", { phase: "awaiting-approval" as const }],
    ["u", { phase: "awaiting-user" as const }],
    ["r", { phase: "running" as const }],
  ]);

  test("splits awaiting into the amber input subset and leaves the rest blue", () => {
    const { active, awaiting, awaitingInput } = derivePhaseTerminals(roster, byCsid);
    expect(active).toEqual(new Set(["term-run"]));
    expect(awaiting).toEqual(new Set(["term-appr", "term-user"]));
    expect(awaitingInput).toEqual(new Set(["term-appr"])); // only the permission gate
  });
});

describe("deriveSessionActivity", () => {
  const topics = {
    work: topic("work", { sessionKey: "kw" }),
    appr: topic("appr", { sessionKey: "ka" }),
    idle: topic("idle", { sessionKey: "ki" }),
  };
  const sessions = new Map<string, ClaudeSessionState>([
    ["kw", sess({ sessionKey: "kw", phase: "tool-running", lastTool: { name: "Bash", startedAt: 2000 } })],
    ["ka", sess({ sessionKey: "ka", phase: "awaiting-approval", pendingApproval: { kind: "edit", prompt: "?", requestedAt: 1500 } })],
    ["ki", sess({ sessionKey: "ki", phase: "completed" })],
  ]);
  const activity = deriveSessionActivity(topics, [], sessions);

  test("a working session reports its tool and 'since'", () => {
    expect(activity.get("work")).toMatchObject({ working: true, tool: "Bash", since: 2000, tier: null });
  });
  test("an awaiting-approval session reports the 'input' tier + approval kind", () => {
    expect(activity.get("appr")).toMatchObject({ working: false, tier: "input", approvalKind: "edit" });
  });
  test("an idle/completed session produces NO entry (label stays hidden)", () => {
    expect(activity.has("idle")).toBe(false);
  });
});
