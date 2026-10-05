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
  setBackgroundTasks,
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

  it("the row a new epoch wrote travels in its frame, and a row the log refused does not", () => {
    // The inbox's «History» tab grows from `history`, the frame that replaced
    // `notification:new` (tasks.md 6.2).
    let written = 0;
    configureAttentionStore({
      recordRow: (i) => {
        written += 1;
        // The second write is the log's dedup saying no.
        return written === 1 ? { id: "n-1", createdAt: "2026-10-05T10:00:00.000Z", kind: i.kind, title: i.title, body: i.body ?? "",
          targetKind: i.targetKind ?? null, targetId: i.targetId ?? null, targetUrl: null, source: i.source ?? "push", groupKey: i.groupKey ?? null, seenAt: null } : null;
      },
    });
    turnStarted("topic:h");
    turnEnded("topic:h", { turnId: "m1", outcome: "done" });
    const first = frames.filter((f) => f.type === "attention:updated" && f.history);
    expect(first.map((f) => [f.row.subject, f.history.id, f.history.kind])).toEqual([["topic:h", "n-1", "chat-message"]]);
    expect(first[0].announce?.tag).toBe("topic:h");
    turnStarted("topic:h");
    turnEnded("topic:h", { turnId: "m2", outcome: "done" });
    expect(written).toBe(2);
    expect(frames.filter((f) => f.type === "attention:updated" && f.history)).toHaveLength(1);
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

  it("a task that changes kind or name sends a frame: the line names a Monitor once the CLI recognises it", () => {
    // The CLI lists a Monitor as a Bash first and recognises it a moment later
    // (chat-monitor-visible): the same id, another kind.
    turnStarted("topic:m");
    const startedAt = "2026-10-03T09:00:00.000Z";
    setBackgroundTasks("topic:m", { b1: { kind: "bash", label: "JOB", startedAt } });
    frames.length = 0;
    setBackgroundTasks("topic:m", { b1: { kind: "monitor", label: "JOB", startedAt } });
    expect(frames).toHaveLength(1);
    expect(frames[0].row.background[0].kind).toBe("monitor");
    setBackgroundTasks("topic:m", { b1: { kind: "monitor", label: "JOB renamed", startedAt } });
    expect(frames).toHaveLength(2);
    setBackgroundTasks("topic:m", { b1: { kind: "monitor", label: "JOB renamed", startedAt } });
    expect(frames).toHaveLength(2);
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
    expect(init.rows.map((r) => `${r.subject}=${r.state}`).sort()).toEqual(["topic:bg=working", "topic:done=finished", "topic:work=working"]);
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

describe("a row saved before the job left running became `working`", () => {
  it("loads as `working`: no client is ever sent the retired `background`", async () => {
    const { Database } = await import("bun:sqlite");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const db = new Database(":memory:");
    db.run(readFileSync(join(import.meta.dir, "../db/migrations/20261003214001-subject-attention.sql"), "utf8"));
    db.run(
      "INSERT INTO subject_attention (subject, state, since, background, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["topic:old", "background", "2026-10-03T21:40:00.000Z", JSON.stringify({ b1: { kind: "bash", label: "sleep 40", startedAt: "2026-10-03T21:39:00.000Z" } }), "2026-10-03T21:40:00.000Z"],
    );
    configureAttentionStore({ db: () => db, broadcast: () => {}, recordRow: () => null, sendPush: () => {}, unreadOf: () => 0 });
    try {
      const init = attentionInitFrame() as unknown as { rows: Array<{ subject: string; state: string }> };
      expect(init.rows.map((r) => `${r.subject}=${r.state}`)).toEqual(["topic:old=working"]);
    } finally {
      resetAttentionStore();
      db.close();
    }
  });
});
