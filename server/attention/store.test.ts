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
  markAttentionSeen,
  noteUnreadChanged,
  openHold,
  recomposeAttentionOnBoot,
  resetAttentionStore,
  setBackgroundTasks,
  setCard,
  setSocketFocus,
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

// Owner, 05/10: sub-agent tabs were showing notifications; a child should not be
// "active" until the person interacts with it. The parent gets the result; the child
// stays dark until the person opens it, then it is a chat like any other.
describe("a sub-agent is quiet until the person opens it", () => {
  it("its finished turn lights nothing, rows nothing, pushes nothing; its work still shows", () => {
    configureAttentionStore({ isSubagent: (s) => s === "topic:child" || s === "terminal:child" });
    turnStarted("topic:child");
    expect(getAttention("topic:child").state).toBe("working");
    turnEnded("topic:child", { turnId: "m1", outcome: "done" });
    expect(getAttention("topic:child")).toMatchObject({ state: "idle", lit: false, epoch: 0 });
    turnStarted("terminal:child");
    turnEnded("terminal:child", { turnId: "t1", outcome: "error", detail: "x" });
    expect(getAttention("terminal:child").lit).toBe(false);
    expect(rows).toEqual([]);
    expect(pushes).toEqual([]);
    // A wait it opens still needs the person: nobody else can answer it.
    openHold("topic:child", "ask", { kind: "question", id: "q1", text: "Procedo?" });
    expect(getAttention("topic:child").state).toBe("needs-you");

    // Opened by the person: from now on its turns light like any chat's.
    markAttentionSeen([{ subject: "terminal:child", epoch: 0, turnAt: null }]);
    turnStarted("terminal:child");
    turnEnded("terminal:child", { turnId: "t2", outcome: "done" });
    expect(getAttention("terminal:child")).toMatchObject({ state: "finished", lit: true });
  });

  // Review of 05/10: a quiet child is never lit, so its `seen` never came and
  // the exception never fired. Putting it in front counts, and it is written
  // down, so a restart still knows.
  it("a child put in front of an awake window is engaged, on record, across a restart", () => {
    const engaged = new Set<string>();
    configureAttentionStore({
      isSubagent: (s) => s === "topic:child",
      engageSubagent: (s) => { engaged.add(s); },
      subagentEngaged: (s) => engaged.has(s),
    });
    setSocketFocus("sock-1", { subject: "topic:child", awake: false });
    expect(engaged.size).toBe(0);
    setSocketFocus("sock-1", { subject: "topic:child", awake: true });
    expect([...engaged]).toEqual(["topic:child"]);
    // Looked at, then left: its next turn lights like any chat's.
    setSocketFocus("sock-1", null);
    turnStarted("topic:child");
    turnEnded("topic:child", { turnId: "m1", outcome: "done" });
    expect(getAttention("topic:child").lit).toBe(true);

    resetAttentionStore();
    turnStarted("topic:child");
    turnEnded("topic:child", { turnId: "m2", outcome: "done" });
    expect(getAttention("topic:child").lit).toBe(true);
    configureAttentionStore({ isSubagent: () => false, engageSubagent: () => {}, subagentEngaged: () => false });
  });
});
