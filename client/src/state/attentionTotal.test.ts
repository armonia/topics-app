/**
 * `chromeAttentionTotal`: the ONE number the OS chrome paints (Dock badge, tray
 * glyph, PWA badge) and the inbox's button. The contract worth pinning is the
 * PARITY of CHROME-COUNT-01 (tasks.md 3.4): for the same attention state, the
 * chrome total equals the sidebar rows that show a lit tier plus the number of
 * the general board's tab, and the expectation is computed from the very
 * helpers those surfaces call (`buildSidebarItems`, `boardAttention`), never
 * from a number typed by hand.
 *
 * @covers CHROME-COUNT-01, NOTIF-ONE-02, ATTN-08
 */
import { describe, test, expect } from "bun:test";
import { TRAY_CHAT_ROWS, chromeAttentionSubjects, chromeAttentionTotal, notificationsToWithdraw, subjectOfPushTag, trayChatItems } from "./attentionTotal";
import { boardAttention } from "./attentionRollups";
import { buildSidebarItems, type SidebarItem } from "../lib/buildSidebarItems";
import type { AttentionSnapshot } from "../../../shared/attention";
import type { Topic, TerminalSessionInfo } from "../types";

const topic = (id: string, over: Partial<Topic> = {}): Topic =>
  ({ id, name: id, sessionKey: `topic:${id}`, ...over } as Topic);

const term = (id: string): TerminalSessionInfo =>
  ({ id, name: `term ${id}`, createdAt: new Date(0).toISOString(), cwd: "/nowhere", command: "claude", clients: 1, type: "claude-code" });

function snap(subject: string, over: Partial<AttentionSnapshot> = {}): AttentionSnapshot {
  return {
    subject, state: "idle", reason: null, outcome: null, detail: null, since: "2026-10-03T10:00:00.000Z",
    epoch: 1, seenEpoch: 0, lit: false, unread: 0, turnUnseen: false, lastTurnAt: null, background: [], ...over,
  };
}
const done = (subject: string, over: Partial<AttentionSnapshot> = {}) => snap(subject, { state: "finished", outcome: "done", lit: true, ...over });
const ask = (subject: string, reason: AttentionSnapshot["reason"] = "question") => snap(subject, { state: "needs-you", reason, lit: true });
const rowsOf = (...rows: AttentionSnapshot[]) => new Map(rows.map((r) => [r.subject, r]));

/** Every sidebar row (children included) that shows a lit tier. */
function litRows(items: SidebarItem[]): number {
  let n = 0;
  for (const i of items) {
    if (i.type !== "project" && i.notificationCount > 0) n++;
    if (i.children) n += litRows(i.children);
  }
  return n;
}

const fixture = () => {
  const topics = {
    a: topic("a"), b: topic("b"), c: topic("c"), bg: topic("bg"), seen: topic("seen"),
    old: topic("old", { archived: true }),
  };
  const terminals = [term("s1"), term("s2")];
  const rows = rowsOf(
    done("topic:a", { unread: 5 }),
    ask("topic:b", "permission"),
    done("topic:c", { outcome: "error" }),
    snap("topic:bg", { state: "background", unread: 2, background: [{ id: "x", kind: "bash", label: "sleep", startedAt: "" }] }),
    snap("topic:seen", { state: "finished", outcome: "done", lit: false, epoch: 3, seenEpoch: 3, unread: 4 }),
    done("topic:old"),
    done("terminal:s1"),
    snap("terminal:s2", { state: "working" }),
    ask("task:r1", "review"),
    ask("task:p1", "parked"),
    ask("task:w1", "permission"),
  );
  return { topics, terminals, rows };
};

describe("chromeAttentionTotal", () => {
  test("counts the lit SUBJECTS: chats, terminals and cards, an archived chat never", () => {
    const f = fixture();
    expect(chromeAttentionSubjects(f.rows, f.topics).map((s) => s.key).sort()).toEqual(
      ["task:p1", "task:r1", "task:w1", "terminal:s1", "topic:a", "topic:b", "topic:c"],
    );
  });

  test("a chat with many unread messages is ONE, not the message sum", () => {
    expect(chromeAttentionTotal(rowsOf(done("topic:a", { unread: 39 })), { a: topic("a") })).toBe(1);
  });

  test("work that runs on its own and a chat already seen count zero, whatever their unread", () => {
    const f = fixture();
    const subjects = chromeAttentionSubjects(f.rows, f.topics).map((s) => s.key);
    expect(subjects).not.toContain("topic:bg");
    expect(subjects).not.toContain("topic:seen");
    expect(subjects).not.toContain("terminal:s2");
  });

  test("PARITY: lit sidebar rows + the general board's tab = the chrome number", () => {
    const f = fixture();
    const items = buildSidebarItems({
      topics: f.topics, terminalSessions: f.terminals, showArchived: false, attention: f.rows,
      openPanels: ["a", "b", "c", "bg", "seen", "terminal:s1", "terminal:s2"],
    });
    const board = boardAttention(f.rows, [], null).count;
    expect(litRows(items) + board).toBe(chromeAttentionTotal(f.rows, f.topics));
  });

  test("PARITY holds with 'show archived' on: the archived row is listed and carries no number", () => {
    const f = fixture();
    const items = buildSidebarItems({ topics: f.topics, terminalSessions: f.terminals, showArchived: true, attention: f.rows, openPanels: ["terminal:s1"] });
    expect(items.find((i) => i.id === "old")?.notificationCount).toBe(0);
    expect(litRows(items) + boardAttention(f.rows, [], null).count).toBe(chromeAttentionTotal(f.rows, f.topics));
  });

  test("seeing a chat drops exactly its ONE and nothing else", () => {
    const f = fixture();
    const before = chromeAttentionTotal(f.rows, f.topics);
    const after = new Map(f.rows);
    after.set("topic:a", done("topic:a", { lit: false, seenEpoch: 1 }));
    expect(chromeAttentionTotal(after, f.topics)).toBe(before - 1);
  });

  test("nothing lit is 0, the cleared badge", () => {
    expect(chromeAttentionTotal(new Map(), {})).toBe(0);
  });
});

describe("trayChatItems: the tray lists the chats and terminals its number counts", () => {
  test("waiting for you first, then the most recent; terminals carry their prefix; cards ride the board groups", () => {
    const topics = { a: topic("a"), b: topic("b") };
    const rows = rowsOf(
      done("topic:a", { since: "2026-10-03T10:05:00.000Z" }),
      ask("topic:b"),
      done("terminal:s1", { since: "2026-10-03T10:09:00.000Z" }),
      ask("task:r1", "review"),
    );
    const items = trayChatItems(chromeAttentionSubjects(rows, topics), rows, topics, [term("s1")]);
    expect(items).toEqual([{ id: "b", title: "b" }, { id: "terminal:s1", title: "term s1" }, { id: "a", title: "a" }]);
  });

  test("the menu stays short", () => {
    const topics: Record<string, Topic> = {};
    const all: AttentionSnapshot[] = [];
    for (let i = 0; i < TRAY_CHAT_ROWS + 4; i++) { topics[`t${i}`] = topic(`t${i}`); all.push(done(`topic:t${i}`)); }
    const rows = rowsOf(...all);
    expect(trayChatItems(chromeAttentionSubjects(rows, topics), rows, topics, [])).toHaveLength(TRAY_CHAT_ROWS);
  });
});

describe("the phone's delivered notifications (tasks.md 3.8)", () => {
  test("a push tag names its subject, the new form and the old per-kind tags", () => {
    expect(subjectOfPushTag("topic:a")).toBe("topic:a");
    expect(subjectOfPushTag("terminal:s1")).toBe("terminal:s1");
    expect(subjectOfPushTag("chat-end-a")).toBe("topic:a");
    expect(subjectOfPushTag("chat-error-a")).toBe("topic:a");
    expect(subjectOfPushTag("chat-wait-a")).toBe("topic:a");
    expect(subjectOfPushTag("task-review-r1")).toBe("task:r1");
    expect(subjectOfPushTag("task-park-p1")).toBe("task:p1");
    expect(subjectOfPushTag("task-review-new")).toBeNull();
    expect(subjectOfPushTag("topics-notification")).toBeNull();
    expect(subjectOfPushTag(undefined)).toBeNull();
  });

  test("on attention:init the page withdraws the notifications whose subject is no longer lit, and only those", () => {
    const rows = rowsOf(done("topic:still"), ask("task:r1", "review"));
    const delivered = [
      { tag: "chat-end-read" }, { tag: "chat-end-still" }, { tag: "task-review-r1" },
      { tag: "task-park-requeued" }, { tag: "topics-notification" }, {},
    ];
    expect(notificationsToWithdraw(delivered, rows).map((n) => n.tag)).toEqual(["chat-end-read", "task-park-requeued"]);
  });
});
