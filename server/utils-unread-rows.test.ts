/**
 * The unread counter is written one row at a time: a bump or a reset touches
 * the row it changes and nothing else. `saveUnread` rewrote the whole table
 * (every row deleted and inserted again) to change one counter.
 *
 * @covers UNREAD-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase } from "./db";
import { createAppContext } from "./utils";
import { bumpUnreadCount } from "./lib/unread-count";
import type { AppContext, Topic } from "./types";

// DATA_DIR is shared process state (see utils-topic-save.test.ts): restore it.
const DATA_DIR_BEFORE = process.env.DATA_DIR;
let tmpRoot: string;
let ctx: AppContext;

function topic(id: string): Topic {
  const now = new Date().toISOString();
  return {
    id, name: `Topic ${id}`, slug: `topic-${id}`, parentId: null, links: [],
    sessionKey: `topic:${id}`, color: "#aabbcc", icon: "chat",
    createdAt: now, updatedAt: now, archived: false,
  };
}

const ids = Array.from({ length: 50 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
const OLD = "2026-01-01T00:00:00.000Z";

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "unread-rows-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  mkdirSync(join(tmpRoot, "public"), { recursive: true });
  process.env.DATA_DIR = join(tmpRoot, "data");
  process.env.OPENCLAW_DIR = join(tmpRoot, "openclaw");
  ctx = createAppContext(tmpRoot);
  for (const id of ids) ctx.saveSingleTopic(topic(id));
  const put = ctx.db.prepare(`INSERT INTO unread (topic_id, last_read_at, unread_count) VALUES (?, ?, ?)`);
  for (const id of ids.slice(1)) put.run(id, OLD, 2);
});

afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  if (DATA_DIR_BEFORE === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = DATA_DIR_BEFORE;
});

/** Rows written by `fn`, from SQLite's own counter. */
function rowsWritten(fn: () => void): number {
  const read = () => (ctx.db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;
  const before = read();
  fn();
  return read() - before;
}

describe("unread, one row at a time", () => {
  test("a finished turn's bump writes ONE row and announces the new count", () => {
    const frames: unknown[] = [];
    const deps = { bumpUnread: ctx.bumpUnread, broadcastToAll: (m: unknown) => { frames.push(m); }, isArchived: () => false };
    expect(rowsWritten(() => bumpUnreadCount(deps as never, ids[1]))).toBe(1);
    expect(frames).toEqual([{ type: "unread:updated", topicId: ids[1], unreadCount: 3 }]);
    expect(ctx.loadUnread()[ids[1]]).toEqual({ lastReadAt: OLD, unreadCount: 3 });
  });

  test("a topic without a row gets one, at 1, stamped now", () => {
    expect(ctx.loadUnread()[ids[0]]).toBeUndefined();
    expect(ctx.bumpUnread(ids[0])).toBe(1);
    expect(ctx.bumpUnread(ids[0])).toBe(2);
    const row = ctx.loadUnread()[ids[0]];
    expect(row.unreadCount).toBe(2);
    expect(row.lastReadAt > OLD).toBe(true);
  });

  test("saveUnreadEntries writes the given rows and leaves the others alone", () => {
    const now = new Date().toISOString();
    const before = ctx.loadUnread();
    expect(rowsWritten(() => ctx.saveUnreadEntries({ [ids[2]]: { lastReadAt: now, unreadCount: 0 } }))).toBe(1);
    const after = ctx.loadUnread();
    expect(after[ids[2]]).toEqual({ lastReadAt: now, unreadCount: 0 });
    for (const id of ids) if (id !== ids[2]) expect(after[id]).toEqual(before[id]);
  });
});
