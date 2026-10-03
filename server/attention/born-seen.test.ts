/**
 * An epoch born while its subject is in front of the person is born SEEN, on
 * the server, before any client can race it (ATTN-06, ATTN-11, defect D3).
 *
 * Today the push trigger writes the bell row of a clean chat end inside
 * `broadcastToAll`, unseen, even with no device subscribed; the window that
 * shows the chat answers later with its own `seen: true` row, which the dedup
 * drops. The chat in front counts on the bell and the Dock.
 *
 * Real migrations on a temp DB, as in `server/subject-seen.test.ts`.
 * @covers ATTN-06
 * @covers ATTN-11
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { configureNotificationRegistry, __resetNotificationRegistry } from "../notification-registry";
import { configureAttentionStore, forgetSocket, getAttention, resetAttentionStore, setSocketFocus, turnEnded, turnStarted } from "./store";

let tmpRoot: string;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "attn-born-seen-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const real = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(real)) if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(real, f), "utf-8"));
  initDatabase(tmpRoot);
  configureNotificationRegistry({ announce: () => {}, announceSeen: () => {}, isTopicArchived: () => false });
});
afterAll(() => { __resetNotificationRegistry(); try { closeDatabase(); } catch { /* closed */ } try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

const pushes: unknown[] = [];
beforeEach(() => {
  resetAttentionStore();
  getDatabase().run("DELETE FROM notification_log");
  pushes.length = 0;
  configureAttentionStore({ sendPush: (p) => { pushes.push(p); }, describe: () => ({ name: "Chat davanti" }) });
});

const rows = () => getDatabase().query("SELECT group_key, seen_at FROM notification_log").all() as Array<{ group_key: string; seen_at: string | null }>;
const devices = () => (getDatabase().query("SELECT COUNT(*) AS c FROM push_subscriptions").get() as { c: number }).c;

describe("a chat that finishes in front of the person", () => {
  it("is born seen with zero subscriptions and a socket awake on it: one seen row, no push, nothing lit", () => {
    expect(devices()).toBe(0);
    setSocketFocus("ws-a", { subject: "topic:front", awake: true });
    turnStarted("topic:front");
    turnEnded("topic:front", { turnId: "m1", outcome: "done" });
    expect(rows()).toEqual([{ group_key: "topic:front", seen_at: expect.any(String) }]);
    expect(pushes).toHaveLength(0);
    const a = getAttention("topic:front");
    expect(a.epoch).toBe(1);
    expect(a.seenEpoch).toBe(1);
    expect(a.lit).toBe(false);
  });

  it("with the window behind another app (socket not awake) it is born unseen: one unseen row, lit, one push decision", () => {
    setSocketFocus("ws-a", { subject: "topic:front", awake: false });
    turnStarted("topic:front");
    turnEnded("topic:front", { turnId: "m1", outcome: "done" });
    expect(rows()).toEqual([{ group_key: "topic:front", seen_at: null }]);
    expect(getAttention("topic:front").lit).toBe(true);
    expect(pushes).toHaveLength(1);
  });

  it("a GUEST socket awake on the chat does not make it born seen", () => {
    setSocketFocus("ws-guest", { subject: "topic:front", awake: true }, { guest: true });
    turnStarted("topic:front");
    turnEnded("topic:front", { turnId: "m1", outcome: "done" });
    expect(rows()).toEqual([{ group_key: "topic:front", seen_at: null }]);
    expect(getAttention("topic:front").lit).toBe(true);
  });

  it("a closed socket takes its focus with it", () => {
    setSocketFocus("ws-a", { subject: "topic:front", awake: true });
    forgetSocket("ws-a");
    turnStarted("topic:front");
    turnEnded("topic:front", { turnId: "m1", outcome: "done" });
    expect(getAttention("topic:front").lit).toBe(true);
  });
});
