/**
 * The seen door: every "I have seen it" clears the chat's unread AND its
 * notification rows, whichever gesture it came from.
 *
 * Real migrations on a temp DB for the registry (the table under test is the
 * one that ships), an in-memory unread store and a recording broadcaster for
 * the rest: the door takes those as deps, exactly as the routes hand them.
 *
 * @covers NOTIF-ONE-01
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase, getDatabase } from "./db";
import { countUnseenNotifications, listNotifications, recordNotification } from "./db/notification-log";
import {
  markAllNotificationsSeen,
  markNotificationRowsSeen,
  markTopicSeen,
  topicIdOfGroupKey,
  type SubjectSeenDeps,
} from "./subject-seen";
import type { UnreadData } from "../shared/types";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "subject-seen-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  initDatabase(tmpRoot);
});

afterAll(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
  getDatabase().run("DELETE FROM notification_log");
});

type Frame = { type: string; topicId?: string; unreadCount?: number; unseen?: number; unseenKeys?: string[]; subjects?: string[]; allExcept?: string[] };

function harness(counts: Record<string, number>) {
  let store: UnreadData = Object.fromEntries(
    Object.entries(counts).map(([id, n]) => [id, { lastReadAt: "2026-09-25T00:00:00.000Z", unreadCount: n }]),
  );
  const frames: Frame[] = [];
  let saves = 0;
  const deps: SubjectSeenDeps = {
    loadUnread: () => structuredClone(store),
    saveUnread: (d) => { store = d; saves++; },
    broadcastToAll: (m) => { frames.push(m as unknown as Frame); },
  };
  return {
    deps,
    frames,
    saves: () => saves,
    unread: (id: string) => store[id]?.unreadCount ?? 0,
  };
}

function chatRow(topicId: string, key: string, at?: number) {
  return recordNotification(
    { kind: "chat-message", title: key, targetKind: "topic", targetId: topicId, dedupeKey: key },
    at,
  );
}

const unseenRowsOf = (topicId: string) =>
  listNotifications({ limit: 200 }).filter((r) => r.targetId === topicId && r.seenAt === null).length;

describe("topicIdOfGroupKey", () => {
  test("reads a chat's group key and nothing else", () => {
    expect(topicIdOfGroupKey("topic:abc")).toBe("abc");
    expect(topicIdOfGroupKey("terminal:abc")).toBeNull();
    expect(topicIdOfGroupKey("task:abc")).toBeNull();
    expect(topicIdOfGroupKey("topic:")).toBeNull();
  });
});

describe("the unseen snapshot (what the dock and the bell union with the live signals)", () => {
  test("names each unseen subject once: a group by its key, an ungrouped row by its id", async () => {
    const { unseenSnapshot } = await import("./db/notification-log");
    chatRow("a", "a1");
    chatRow("a", "a2");
    const loose = recordNotification({ kind: "other", title: "loose", dedupeKey: "loose1" });
    const snap = unseenSnapshot();
    expect(snap.unseenKeys.sort()).toEqual([loose!.id, "topic:a"].sort());
    expect(snap.unseen).toBe(countUnseenNotifications());
  });
});

describe("markTopicSeen (opening a chat)", () => {
  test("resets unread AND the chat's rows, and announces both", () => {
    const h = harness({ a: 39, b: 2 });
    chatRow("a", "a1");
    chatRow("b", "b1");
    const r = markTopicSeen(h.deps, "a");
    expect(r).toEqual({ unreadCleared: true, rowsSeen: 1 });
    expect(h.unread("a")).toBe(0);
    expect(h.unread("b")).toBe(2);
    expect(unseenRowsOf("a")).toBe(0);
    expect(unseenRowsOf("b")).toBe(1);
    expect(h.frames).toContainEqual({ type: "unread:updated", topicId: "a", unreadCount: 0 });
    expect(h.frames).toContainEqual({ type: "notification:seen", unseen: 1, unseenKeys: ["topic:b"], subjects: ["topic:a"] });
  });

  test("clears the rows even when the unread was already zero (the old early return did not)", () => {
    const h = harness({});
    chatRow("a", "a1");
    expect(markTopicSeen(h.deps, "a")).toEqual({ unreadCleared: false, rowsSeen: 1 });
    expect(countUnseenNotifications()).toBe(0);
  });

  test("a no-op writes nothing and wakes nobody", () => {
    const h = harness({ a: 0 });
    expect(markTopicSeen(h.deps, "a")).toEqual({ unreadCleared: false, rowsSeen: 0 });
    expect(h.saves()).toBe(0);
    expect(h.frames).toEqual([]);
  });
});

describe("markNotificationRowsSeen (a row clicked in the panel)", () => {
  test("a chat's row seen is the chat seen: its unread goes to zero with it", () => {
    const h = harness({ a: 5, b: 1 });
    const row = chatRow("a", "a1");
    chatRow("b", "b1");
    const b1 = "topic:b";
    const snapshot = markNotificationRowsSeen(h.deps, [row!.id]);
    expect(snapshot).toEqual({ unseen: 1, unseenKeys: [b1] });
    expect(h.unread("a")).toBe(0);
    expect(h.unread("b")).toBe(1);
    expect(h.frames).toContainEqual({ type: "unread:updated", topicId: "a", unreadCount: 0 });
    expect(h.frames).toContainEqual({ type: "notification:seen", unseen: 1, unseenKeys: [b1], subjects: ["topic:a"] });
  });

  test("a terminal row names its terminal, so every window can drop its finished mark", () => {
    const h = harness({ a: 5 });
    const row = recordNotification({ kind: "session", title: "done", dedupeKey: "t1", groupKey: "terminal:s1" });
    markNotificationRowsSeen(h.deps, [row!.id]);
    expect(h.unread("a")).toBe(5);
    expect(h.frames).toEqual([{ type: "notification:seen", unseen: 0, unseenKeys: [], subjects: ["terminal:s1"] }]);
  });
});

describe("markAllNotificationsSeen (opening the panel = mark all)", () => {
  test("clears every row AND every chat still counting unread, with or without a row", () => {
    // `stale` is today's live case: its rows were seen by the panel long ago,
    // its 22 unread messages kept counting on the dock.
    const h = harness({ a: 4, b: 1, stale: 22 });
    chatRow("a", "a1");
    const newest = chatRow("b", "b1");
    const snapshot = markAllNotificationsSeen(h.deps, newest!.createdAt);
    expect(snapshot).toEqual({ unseen: 0, unseenKeys: [] });
    expect(h.unread("a")).toBe(0);
    expect(h.unread("b")).toBe(0);
    expect(h.unread("stale")).toBe(0);
    expect(h.saves()).toBe(1);
    expect(h.frames.filter((f) => f.type === "unread:updated").map((f) => f.topicId).sort()).toEqual(["a", "b", "stale"]);
    expect(h.frames).toContainEqual({ type: "notification:seen", unseen: 0, unseenKeys: [], allExcept: [] });
  });

  test("spares a chat whose notification arrived AFTER the list was read", () => {
    const h = harness({ a: 4, late: 1 });
    const t0 = Date.now();
    const seenRow = chatRow("a", "a1", t0);
    chatRow("late", "late1", t0 + 5_000);
    markAllNotificationsSeen(h.deps, seenRow!.createdAt);
    expect(h.unread("a")).toBe(0);
    expect(h.unread("late")).toBe(1);
    expect(unseenRowsOf("late")).toBe(1);
    expect(h.frames).toContainEqual({ type: "notification:seen", unseen: 1, unseenKeys: ["topic:late"], allExcept: ["topic:late"] });
  });
});
