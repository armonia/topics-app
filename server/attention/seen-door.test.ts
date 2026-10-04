/**
 * ONE door for "I have seen it": `POST /api/attention/seen` with
 * `{ subject, epoch, turnAt }` (ATTN-06, NOTIF-ONE-01; defects E and B4).
 *
 * Today seeing a terminal with no history row tells no other window
 * (`markTargetSeenAndAnnounce` announces only when it cleared a row), and the
 * seen lives in each window's memory, so a reload relights every chat.
 *
 * The contract: the door always announces; an epoch protects what came after
 * it, a `turnAt` protects the turn after it; a guest's seen is dropped; and a
 * chat looked at while in background has its turn seen, so the end of the
 * wait (T7) decides `idle` instead of `finished(done)`.
 * @covers ATTN-06
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  configureAttentionStore,
  getAttention,
  markAttentionSeen,
  resetAttentionStore,
  setBackgroundTasks,
  turnEnded,
  turnStarted,
} from "./store";
import { createAttentionRouter } from "../routes/attention";

const frames: Array<Record<string, any>> = [];
beforeEach(() => {
  resetAttentionStore();
  frames.length = 0;
  configureAttentionStore({
    db: () => null,
    broadcast: (f) => { frames.push(f as Record<string, any>); },
    recordRow: () => null,
    sendPush: () => {},
    graceMs: 20,
  });
});
afterEach(() => resetAttentionStore());

function finishTurn(subject: string, turnId: string) {
  turnStarted(subject);
  turnEnded(subject, { turnId, outcome: "done" });
}

describe("the seen door", () => {
  it("announces even when the subject has no history row", async () => {
    finishTurn("terminal:sess-1", "t1");
    frames.length = 0;
    const router = createAttentionRouter({ json: (b: unknown, status = 200) => new Response(JSON.stringify(b), { status }), readJSON: async (r: Request) => r.json() } as never);
    const a = getAttention("terminal:sess-1");
    const url = new URL("http://topics.test/api/attention/seen");
    const resp = await router(new Request(url, { method: "POST", body: JSON.stringify({ items: [{ subject: "terminal:sess-1", epoch: a.epoch, turnAt: a.lastTurnAt }] }) }), url, "/api/attention/seen", "POST");
    expect(resp?.status).toBe(200);
    expect(getAttention("terminal:sess-1").lit).toBe(false);
    expect(frames.filter((f) => f.type === "attention:updated" && f.row.subject === "terminal:sess-1")).toHaveLength(1);

    // The same seen again changes nothing, and still announces.
    frames.length = 0;
    markAttentionSeen([{ subject: "terminal:sess-1", epoch: a.epoch, turnAt: a.lastTurnAt }]);
    expect(frames.filter((f) => f.type === "attention:updated")).toHaveLength(1);
  });

  it("a seen for epoch 4 does not switch off epoch 5", () => {
    for (let i = 1; i <= 4; i++) finishTurn("topic:c", `m${i}`);
    const four = getAttention("topic:c");
    expect(four.epoch).toBe(4);
    finishTurn("topic:c", "m5");
    expect(getAttention("topic:c").epoch).toBe(5);
    markAttentionSeen([{ subject: "topic:c", epoch: four.epoch, turnAt: four.lastTurnAt }]);
    const after = getAttention("topic:c");
    expect(after.seenEpoch).toBe(4);
    expect(after.lit).toBe(true);
    expect(after.state).toBe("finished");
  });

  it("an old turnAt does not cover the turn after it", () => {
    finishTurn("topic:d", "m1");
    const old = getAttention("topic:d");
    setBackgroundTasks("topic:d", { b1: { kind: "bash", label: "make", startedAt: new Date().toISOString() } });
    turnStarted("topic:d");
    turnEnded("topic:d", { turnId: "m2", outcome: "done", at: new Date(Date.now() + 1000).toISOString() });
    expect(getAttention("topic:d").state).toBe("working");
    markAttentionSeen([{ subject: "topic:d", epoch: old.epoch, turnAt: old.lastTurnAt }]);
    expect(getAttention("topic:d").turnUnseen).toBe(true);
  });

  it("a guest's seen is dropped", () => {
    finishTurn("topic:e", "m1");
    const a = getAttention("topic:e");
    markAttentionSeen([{ subject: "topic:e", epoch: a.epoch, turnAt: a.lastTurnAt }], { guest: true });
    expect(getAttention("topic:e").lit).toBe(true);
    expect(getAttention("topic:e").seenEpoch).toBe(0);
  });

  it("seen while in background: when the last task returns and no turn opens, T7 gives idle", async () => {
    turnStarted("topic:f");
    turnEnded("topic:f", { turnId: "m1", outcome: "done", background: { a1: { kind: "agent", label: "verify", startedAt: new Date().toISOString() } } });
    const bg = getAttention("topic:f");
    expect(bg.state).toBe("working");
    expect(bg.turnUnseen).toBe(true);
    markAttentionSeen([{ subject: "topic:f", epoch: bg.epoch, turnAt: bg.lastTurnAt }]);
    expect(getAttention("topic:f").turnUnseen).toBe(false);
    setBackgroundTasks("topic:f", {});
    await Bun.sleep(60);
    expect(getAttention("topic:f").state).toBe("idle");
    expect(getAttention("topic:f").epoch).toBe(0);
  });

  it("not seen while in background: T7 gives finished(done), one epoch", async () => {
    turnStarted("topic:g");
    turnEnded("topic:g", { turnId: "m1", outcome: "done", background: { a1: { kind: "agent", label: "verify", startedAt: new Date().toISOString() } } });
    setBackgroundTasks("topic:g", {});
    // Within the grace a turn may still open: nothing yet.
    expect(getAttention("topic:g").state).toBe("working");
    await Bun.sleep(60);
    expect(getAttention("topic:g")).toMatchObject({ state: "finished", outcome: "done", epoch: 1, lit: true });
  });
});
