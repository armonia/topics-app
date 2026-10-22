/**
 * The two sweeps that `[DB-SLOW]` named on the live server (15/10/2026) read
 * only the rows they need: the boot sweep through the partial index of the
 * half-written messages, the resume sweep through the timestamp index. Checked
 * on the real schema (all migrations) and on the SQL the code runs.
 *
 * The reads of `tasks` on a timer (dispatcher tick, wait sweep, status bar) go
 * through their partial indexes instead of the whole table.
 *
 * @covers DBSLOW-02
 * @covers DBSLOW-03
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, initDatabase } from "./db";
import { PARTIAL_SESSIONS_SQL } from "./lib/boot-partial-sweep";
import { LAST_RECENT_MESSAGES_SQL } from "./lib/ripresa-boot";
import {
  OLDEST_WORKING_BOARD_SQL,
  PARKED_IN_SERIES_SQL,
  QUEUED_ROOT_BOARDS_SQL,
  WORKING_TASKS_COUNT_SQL,
} from "./lib/task-timer-reads";

/** The resume query before 15/10/2026, verbatim: the reference for the rows. */
const LAST_MESSAGE_OF_EVERY_CHAT_SQL = `SELECT m.session_key AS sk, m.id AS id, m.role AS ruolo, m.blocks AS blocks, m.timestamp AS ts
         FROM messages m
         JOIN (SELECT session_key, MAX(rowid) AS r FROM messages GROUP BY session_key) u
           ON u.r = m.rowid
        WHERE m.timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours')`;

let tmpRoot: string;
let db: Database;

const plan = (sql: string): string[] =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail);

const bySession = (rows: unknown[]) =>
  (rows as Array<{ sk: string; id: string }>).map((r) => `${r.sk}:${r.id}`).sort();

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sweep-plans-test-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (f.endsWith(".sql")) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  db = initDatabase(tmpRoot);

  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const insert = db.prepare("INSERT INTO messages (id, session_key, role, timestamp, partial) VALUES (?, ?, 'user', ?, ?)");
  db.transaction(() => {
    // The live shape: thousands of old messages over hundreds of chats.
    for (let chat = 0; chat < 300; chat++) {
      for (let i = 0; i < 10; i++) insert.run(`old-${chat}-${i}`, `chat-${chat}`, daysAgo(30), 0);
    }
    insert.run("a-old", "recent-a", daysAgo(3), 0);
    insert.run("a-new", "recent-a", daysAgo(0.1), 0);
    insert.run("b-new", "recent-b", daysAgo(0.5), 0);
    // A recent row first, then an older one: its LAST row by rowid is old, so
    // the chat is out, as it was before.
    insert.run("c-recent", "old-last", daysAgo(0.2), 0);
    insert.run("c-older", "old-last", daysAgo(5), 0);
    insert.run("p-half", "partial-chat", daysAgo(40), 1);
  })();
});

afterAll(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("boot sweep", () => {
  test("finds the half-written chats through the partial index", () => {
    expect(plan(PARTIAL_SESSIONS_SQL).join(" / ")).toContain("idx_messages_partial");
    expect(db.query(PARTIAL_SESSIONS_SQL).all()).toEqual([{ sk: "partial-chat" }]);
  });
});

describe("resume sweep", () => {
  test("starts from the recent messages, never from every chat", () => {
    const steps = plan(LAST_RECENT_MESSAGES_SQL);
    expect(steps.join(" / ")).toContain("idx_messages_timestamp");
    expect(steps.filter((s) => /^SCAN (messages|m)\b/.test(s))).toEqual([]);
  });

  test("returns the same rows as the query it replaced", () => {
    const now = bySession(db.query(LAST_RECENT_MESSAGES_SQL).all());
    expect(now).toEqual(bySession(db.query(LAST_MESSAGE_OF_EVERY_CHAT_SQL).all()));
    expect(now).toEqual(["recent-a:a-new", "recent-b:b-new"]);
  });
});

describe("tasks reads on a timer", () => {
  test.each([
    ["dispatcher tick", QUEUED_ROOT_BOARDS_SQL, "idx_tasks_queued_roots"],
    ["working count", WORKING_TASKS_COUNT_SQL, "idx_tasks_working"],
    ["oldest working board", OLDEST_WORKING_BOARD_SQL, "idx_tasks_working"],
    ["wait sweep", PARKED_IN_SERIES_SQL, "idx_tasks_waiting"],
  ])("%s reads its partial index, not the table", (_name, sql, index) => {
    const steps = plan(sql);
    expect(steps.join(" / ")).toContain(index);
    expect(steps.filter((s) => /^SCAN (tasks|t)$/.test(s))).toEqual([]);
  });
});

