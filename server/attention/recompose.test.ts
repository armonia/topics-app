/**
 * Every start of the server, the watcher's reloads included, recomposes the
 * state from what is saved in the row and what is re-read from where it lives,
 * with no epoch and no announce; reopening an archived chat relights nothing;
 * closing a finished terminal's pane sees it (ATTN-07, ATTN-13, T13, T18, T19).
 *
 * Real migrations on a temp DB: the store's rows live in `subject_attention`,
 * and "the server restarts" is the store dropping everything it holds in
 * memory and reading the table again.
 * @covers ATTN-07
 * @covers ATTN-13
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import { configureNotificationRegistry, __resetNotificationRegistry } from "../notification-registry";
import {
  configureAttentionStore,
  getAttention,
  recomposeAttentionOnBoot,
  resetAttentionStore,
  setCard,
  setClosed,
  turnEnded,
  turnStarted,
} from "./store";
import { paneTombstoned } from "./wire";

// The store is a process singleton: leave it as the next file expects it.
afterAll(() => resetAttentionStore());

let tmpRoot: string;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "attn-recompose-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const real = join(import.meta.dir, "..", "db", "migrations");
  for (const f of readdirSync(real)) if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(real, f), "utf-8"));
  initDatabase(tmpRoot);
  configureNotificationRegistry({ announce: () => {}, announceSeen: () => {}, isTopicArchived: () => false });
});
afterAll(() => { __resetNotificationRegistry(); try { closeDatabase(); } catch { /* closed */ } try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

const pushes: unknown[] = [];
const frames: Array<Record<string, any>> = [];
function configure() {
  configureAttentionStore({ sendPush: (p) => { pushes.push(p); }, broadcast: (f) => { frames.push(f as Record<string, any>); } });
}
beforeEach(() => {
  resetAttentionStore();
  getDatabase().run("DELETE FROM notification_log");
  getDatabase().run("DELETE FROM subject_attention");
  pushes.length = 0;
  frames.length = 0;
  configure();
});

const rowCount = () => (getDatabase().query("SELECT COUNT(*) AS c FROM notification_log").get() as { c: number }).c;
const unseenRows = (subject: string) =>
  (getDatabase().query("SELECT COUNT(*) AS c FROM notification_log WHERE group_key = ? AND seen_at IS NULL").get(subject) as { c: number }).c;

describe("a restart of the server", () => {
  it("keeps an unseen finished chat at epoch 7 and a card in review amber: same epochs, no row, no announce", () => {
    for (let i = 1; i <= 7; i++) { turnStarted("topic:seven"); turnEnded("topic:seven", { turnId: `m${i}`, outcome: "done" }); }
    setCard("task:rev", { status: "review", since: "2026-10-03T09:00:00.000Z" });
    expect(getAttention("topic:seven").epoch).toBe(7);
    expect(getAttention("task:rev").epoch).toBe(1);
    const rowsBefore = rowCount();

    // The server restarts: nothing in memory survives, the table does.
    resetAttentionStore();
    configure();
    frames.length = 0; pushes.length = 0;
    recomposeAttentionOnBoot({
      liveProcess: () => true,
      cards: () => [{ taskId: "rev", status: "review", since: "2026-10-03T09:00:00.000Z" }],
    });
    expect(getAttention("topic:seven")).toMatchObject({ state: "finished", outcome: "done", epoch: 7, lit: true });
    expect(getAttention("task:rev")).toMatchObject({ state: "needs-you", reason: "review", epoch: 1, lit: true });
    expect(rowCount()).toBe(rowsBefore);
    expect(pushes).toHaveLength(0);
    expect(frames.filter((f) => f.type === "attention:updated" && f.live === true)).toHaveLength(0);
    expect(frames.filter((f) => f.announce)).toHaveLength(0);
  });

  it("the first start with an empty table lights only what is true now", () => {
    resetAttentionStore();
    configure();
    recomposeAttentionOnBoot({ liveProcess: () => true, cards: () => [{ taskId: "rev2", status: "review", since: "2026-10-03T09:00:00.000Z" }] });
    expect(getAttention("task:rev2")).toMatchObject({ state: "needs-you", reason: "review", lit: true });
    expect(getAttention("topic:never-seen").state).toBe("idle");
    expect(rowCount()).toBe(0);
  });
});

describe("reopening and closing", () => {
  it("unarchiving a chat archived while finished gives idle, with no epoch and no row", () => {
    turnStarted("topic:reopen");
    turnEnded("topic:reopen", { turnId: "m1", outcome: "done" });
    setClosed("topic:reopen", { archived: true });
    const archived = getAttention("topic:reopen");
    expect(archived.state).toBe("idle");
    const rows = rowCount();
    setClosed("topic:reopen", { archived: false });
    expect(getAttention("topic:reopen")).toMatchObject({ state: "idle", epoch: archived.epoch, lit: false });
    expect(rowCount()).toBe(rows);
  });

  it("the tombstone of a finished terminal's pane gives idle, and its row is seen", () => {
    turnStarted("terminal:t9");
    turnEnded("terminal:t9", { turnId: "x1", outcome: "done" });
    expect(getAttention("terminal:t9").lit).toBe(true);
    expect(unseenRows("terminal:t9")).toBe(1);
    paneTombstoned("terminal:t9");
    expect(getAttention("terminal:t9")).toMatchObject({ state: "idle", lit: false });
    expect(unseenRows("terminal:t9")).toBe(0);
  });
});
