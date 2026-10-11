/**
 * Archiving a chat switches its subject off and sees its rows, in the same
 * step, on the server; a turn that wakes it afterwards lights nothing
 * (ATTN-13, T13; defects ARCH-1, B3 and C).
 *
 * Today `archiveTopicFully` zeroes the unread and parks the session, but
 * leaves the chat's notification rows unseen: the subject keeps the bell and
 * the Dock at +1, with no gesture left to clear it but opening the panel.
 *
 * Real migrations on a temp DB, as in `server/subject-seen.test.ts`.
 * @covers ATTN-13
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { configureNotificationRegistry, __resetNotificationRegistry } from "../notification-registry";
import { archiveTopicFully } from "./archive-topic";
import { configureAttentionStore, getAttention, resetAttentionStore, turnEnded, turnStarted } from "../attention/store";
import type { Topic, UnreadData } from "../../shared/types";

// The store is a process singleton: leave it as the next file expects it.
afterAll(() => resetAttentionStore());

let tmpRoot: string;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "archive-attn-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(realMigDir)) if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  initDatabase(tmpRoot);
  configureNotificationRegistry({ isTopicArchived: () => false });
});
afterAll(() => { __resetNotificationRegistry(); try { closeDatabase(); } catch { /* closed */ } try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

const pushes: unknown[] = [];
beforeEach(() => {
  resetAttentionStore();
  getDatabase().run("DELETE FROM notification_log");
  // The store's table outlives a test like it outlives a restart: each case starts empty.
  getDatabase().run("DELETE FROM subject_attention");
  pushes.length = 0;
  configureAttentionStore({ sendPush: (p) => { pushes.push(p); } });
});

function archive(topic: Topic) {
  let unread: UnreadData = { [topic.id]: { lastReadAt: "2026-10-01T00:00:00.000Z", unreadCount: 1 } };
  return archiveTopicFully({
    getTopicById: () => topic,
    saveSingleTopic: () => {},
    loadUnread: () => unread,
    saveUnreadEntries: (e) => { unread = { ...unread, ...e }; },
    broadcastToAll: () => {},
    purgeFromUiState: () => ({ ok: true }),
    parkClaudeSession: () => {},
  }, topic.id);
}

const unseen = () => (getDatabase().query("SELECT COUNT(*) AS c FROM notification_log WHERE seen_at IS NULL").get() as { c: number }).c;

describe("archiving a finished chat nobody read", () => {
  it("leaves the subject idle and its rows seen", () => {
    turnStarted("topic:t1");
    turnEnded("topic:t1", { turnId: "m1", outcome: "done" });
    expect(getAttention("topic:t1").lit).toBe(true);
    expect(unseen()).toBe(1);

    const res = archive({ id: "t1", name: "Fix login", sessionKey: "topic:t1", archived: false } as unknown as Topic);
    expect(res.ok).toBe(true);
    const a = getAttention("topic:t1");
    expect(a.state).toBe("idle");
    expect(a.lit).toBe(false);
    expect(a.seenEpoch).toBe(a.epoch);
    expect(unseen()).toBe(0);
  });

  it("a turn that wakes the archived chat afterwards makes no epoch, no row and no push", () => {
    turnStarted("topic:t2");
    turnEnded("topic:t2", { turnId: "m1", outcome: "done" });
    archive({ id: "t2", name: "Background", sessionKey: "topic:t2", archived: false } as unknown as Topic);
    const before = getAttention("topic:t2").epoch;
    pushes.length = 0;

    turnStarted("topic:t2");
    turnEnded("topic:t2", { turnId: "m2", outcome: "done" });
    expect(getAttention("topic:t2").epoch).toBe(before);
    expect(getAttention("topic:t2").lit).toBe(false);
    expect(unseen()).toBe(0);
    expect(pushes).toHaveLength(0);
  });
});
