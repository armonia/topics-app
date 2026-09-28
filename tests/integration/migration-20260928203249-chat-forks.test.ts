/**
 * `20260928203249-chat-forks.sql`: where a forked chat came from (card a298eb7b).
 * @covers CHAT-FORK-01
 *
 * The file itself, run against a synthetic database holding the `topics` table
 * of 001 and a chat: the table appears empty (nothing to backfill), no topic
 * moves, the statements `lib/chat-fork-store.ts` runs work on it, the runtime
 * is one of three, a branch's row goes with the branch, and the original can
 * go while the branch's row stays.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";
import { consumeFork, insertChatFork, readForkOrigin } from "../../server/lib/chat-fork-store";

const read = (name: string) => fs.readFileSync(path.join(PROJECT_ROOT, "server/db/migrations", name), "utf-8");
const MIGRATION_SQL = read("20260928203249-chat-forks.sql");

function dbBefore(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  for (const statement of read("001-initial.sql").split(/;\s*\n/)) {
    if (!/create\s+table\s+(if\s+not\s+exists\s+)?topics\b/i.test(statement)) continue;
    db.run(statement);
  }
  const topic = db.prepare("INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?, ?, ?, ?, '2026-09-28', '2026-09-28')");
  topic.run("parent", "Refactor login", "refactor-login", "topic:parent01");
  topic.run("branch", "Refactor login (ramo)", "refactor-login-ramo", "topic:branch01");
  return db;
}

const topics = (db: Database) => db.prepare("SELECT * FROM topics ORDER BY id").all();
const row = {
  sessionKey: "topic:branch01", parentTopicId: "parent", parentName: "Refactor login", forkPointMessageId: "copy-a1",
  runtime: "claude-cli" as const, parentRef: "P", parentAt: "U", branchRef: "C", createdAt: "2026-09-28",
};

describe("migration 20260928203249: chat_forks", () => {
  test("before it the table does not exist", () => {
    const db = dbBefore();
    expect(() => db.prepare("SELECT * FROM chat_forks").all()).toThrow();
    db.close();
  });

  test("after it the table is empty, no topic moved, and running it twice changes nothing", () => {
    const db = dbBefore();
    const before = topics(db);
    db.run(MIGRATION_SQL);
    db.run(MIGRATION_SQL);
    expect(db.prepare("SELECT * FROM chat_forks").all()).toEqual([]);
    expect(topics(db)).toEqual(before);
    db.close();
  });

  test("the store's statements work on it, and the fork is consumed by nulling parent_ref and parent_at only", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    insertChatFork(db, row);
    expect(readForkOrigin(db, "topic:branch01")).toEqual({ runtime: "claude-cli", parentRef: "P", parentAt: "U", branchRef: "C" });
    consumeFork(db, "topic:branch01");
    expect(readForkOrigin(db, "topic:branch01")).toEqual({ runtime: "claude-cli", parentRef: null, parentAt: null, branchRef: "C" });
    expect(readForkOrigin(db, "topic:parent01")).toBeNull();
    db.close();
  });

  test("the runtime is one of the three", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    expect(() => insertChatFork(db, { ...row, runtime: "openclaw" as never })).toThrow();
    db.close();
  });

  test("the row goes with its branch; the original can go and the row stays", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    insertChatFork(db, row);
    db.prepare("DELETE FROM topics WHERE id = 'parent'").run();
    expect(readForkOrigin(db, "topic:branch01")).not.toBeNull();
    db.prepare("DELETE FROM topics WHERE id = 'branch'").run();
    expect(db.prepare("SELECT * FROM chat_forks").all()).toEqual([]);
    db.close();
  });
});
