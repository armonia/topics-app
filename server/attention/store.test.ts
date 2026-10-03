/**
 * The store: the epoch is tied to the CAUSE (design section 4.1), the seen is
 * written as `seen_epoch` and `seen_at`, the frame goes out when the state,
 * the seen, the unread, the unseen turn or the tasks change, and the snapshot
 * of a new socket holds every subject that is not idle.
 * @covers ATTN-01
 * @covers ATTN-07
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  attentionInitFrame,
  configureAttentionStore,
  getAttention,
  litSubjectCount,
  noteUnreadChanged,
  openHold,
  recomposeAttentionOnBoot,
  resetAttentionStore,
  setCard,
  turnEnded,
  turnStarted,
} from "./store";

afterAll(() => resetAttentionStore());

const frames: Array<Record<string, any>> = [];
const rows: string[] = [];
const pushes: Array<Record<string, unknown>> = [];
let unread = 0;
function configure() {
  configureAttentionStore({
    db: () => null,
    broadcast: (f) => { frames.push(f as Record<string, any>); },
    recordRow: (i) => { rows.push(i.kind); return null; },
    sendPush: (p) => { pushes.push({ ...p }); },
    unreadOf: () => unread,
  });
}
beforeEach(() => {
  resetAttentionStore();
  frames.length = 0; rows.length = 0; pushes.length = 0; unread = 0;
  configure();
});

describe("the epoch is tied to the cause", () => {
  it("grows by one for a new cause, and a new announce comes with it", () => {
    turnStarted("topic:a");
    turnEnded("topic:a", { turnId: "m1", outcome: "done" });
    expect(getAttention("topic:a").epoch).toBe(1);
    const updated = frames.filter((f) => f.type === "attention:updated" && f.announce);
    expect(updated).toHaveLength(1);
    expect(updated[0].announce.tag).toBe("topic:a");
    expect(updated[0].live).toBe(true);
    expect(rows).toEqual(["chat-message"]);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].badge).toBe(1);
  });

  it("the same cause recomposed makes no epoch, no row and no push", () => {
    openHold("topic:b", "ask", { kind: "question", id: "ask:1" });
    openHold("topic:b", "ask", { kind: "question", id: "ask:1" });
    openHold("topic:b", "phase", { kind: "question", id: "phase:9" });
    expect(getAttention("topic:b").epoch).toBe(1);
    expect(rows).toHaveLength(1);
    setCard("task:c", { status: "review", since: "2026-10-03T09:00:00.000Z" });
    setCard("task:c", { status: "review", since: "2026-10-03T09:30:00.000Z" });
    expect(getAttention("task:c").epoch).toBe(1);
  });

  it("a new wait after an answer is a new epoch", () => {
    turnStarted("topic:d");
    openHold("topic:d", "ask", { kind: "question", id: "ask:1" });
    openHold("topic:d", "ask", { kind: "question", id: "ask:2" });
    expect(getAttention("topic:d").epoch).toBe(2);
  });

  it("an unchanged recomposition sends no frame; a change of the unread alone does", () => {
    turnStarted("topic:e");
    turnEnded("topic:e", { turnId: "m1", outcome: "done" });
    frames.length = 0;
    noteUnreadChanged("e");
    expect(frames).toHaveLength(0);
    unread = 3;
    noteUnreadChanged("e");
    expect(frames).toHaveLength(1);
    expect(frames[0].row.unread).toBe(3);
  });
});

describe("the snapshot of a new socket", () => {
  it("holds every subject that is not idle, finished ones included, and nothing idle", () => {
    turnStarted("topic:work");
    turnStarted("topic:done"); turnEnded("topic:done", { turnId: "m1", outcome: "done" });
    turnStarted("topic:bg"); turnEnded("topic:bg", { turnId: "m1", outcome: "done", background: { b: { kind: "bash", label: "x", startedAt: "2026-10-03T09:00:00.000Z" } } });
    turnStarted("topic:quiet"); turnEnded("topic:quiet", {});
    const init = attentionInitFrame() as unknown as { type: string; rows: Array<{ subject: string; state: string }> };
    expect(init.type).toBe("attention:init");
    expect(init.rows.map((r) => `${r.subject}=${r.state}`).sort()).toEqual(["topic:bg=background", "topic:done=finished", "topic:work=working"]);
    expect(litSubjectCount()).toBe(1);
  });

  it("a recomposition at boot is live: false and announces nothing", () => {
    turnStarted("topic:f"); turnEnded("topic:f", { turnId: "m1", outcome: "done" });
    resetAttentionStore({ keepRows: true });
    configure();
    frames.length = 0; pushes.length = 0; rows.length = 0;
    recomposeAttentionOnBoot({ liveProcess: () => true });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.live === false && !f.announce)).toBe(true);
    expect(getAttention("topic:f")).toMatchObject({ state: "finished", epoch: 1, lit: true });
    expect(pushes).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });
});
