/**
 * `20260930131539-owed-answers.sql`: the index of the answers still owed to
 * the model, read by the boot instead of a walk of the rows.
 * @covers ASK-11
 *
 * The file itself, run against a synthetic database with a `messages` table:
 * the table appears empty (the older marks sit in compressed blobs, the boot
 * sweep indexes them), running it twice changes nothing, and the statements
 * `lib/owed-answers.ts` runs work on it: an answer is loaded back from its
 * row, oldest first, and an entry whose row no longer owes it is dropped.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./helpers";
import { encodeCol } from "../../shared/message-blob";
import { loadOwedAnswers, markAnswerNotOwed, markAnswerOwed } from "../../server/lib/owed-answers";

const MIGRATION_SQL = fs.readFileSync(path.join(PROJECT_ROOT, "server/db/migrations/20260930131539-owed-answers.sql"), "utf-8");
const QUESTION = "Which branch do we ship?";

function dbBefore(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, role TEXT NOT NULL, content TEXT, tool_calls BLOB, blocks BLOB, partial INTEGER DEFAULT 0, timestamp TEXT)`);
  return db;
}

/** A row carrying an answered question, as the route leaves it: compressed, with the relay's mark. */
function rowWithAnswer(db: Database, rowId: string, sessionKey: string, toolCallId: string, relay: "queued" | "sent"): void {
  const call = {
    id: toolCallId, name: "mcp__topics__ask_user_question", status: "success",
    args: { questions: [{ question: QUESTION, options: [{ label: "main" }, { label: "next" }] }] },
    userResponse: { kind: "questions", answers: { [QUESTION]: "next" }, submittedAt: "2026-08-20T10:00:00.000Z" },
    answerRelay: relay, pad: "x".repeat(1000),
  };
  db.prepare(`INSERT OR REPLACE INTO messages (id, session_key, role, content, tool_calls, blocks, timestamp) VALUES (?, ?, 'assistant', '', ?, ?, '2026-08-20')`).run(
    rowId, sessionKey,
    encodeCol(JSON.stringify([call])) as never,
    encodeCol(JSON.stringify([{ kind: "tool", toolCall: call }])) as never,
  );
}

const entries = (db: Database) => db.prepare("SELECT tool_call_id, session_key, row_id, created_at FROM owed_answers ORDER BY tool_call_id").all();

describe("migration 20260930131539: owed_answers", () => {
  test("before it the table does not exist", () => {
    const db = dbBefore();
    expect(() => db.prepare("SELECT * FROM owed_answers").all()).toThrow();
    db.close();
  });

  test("after it the table is empty, and running it twice changes nothing", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    markAnswerOwed(db, { toolCallId: "t1", sessionKey: "topic:a", rowId: "r1" }, 5);
    db.run(MIGRATION_SQL);
    expect(entries(db)).toEqual([{ tool_call_id: "t1", session_key: "topic:a", row_id: "r1", created_at: 5 }]);
    db.close();
  });

  test("an owed answer is rebuilt from its row, oldest first, whatever the row's age", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    rowWithAnswer(db, "r-new", "topic:a", "t-new", "queued");
    rowWithAnswer(db, "r-old", "topic:a", "t-old", "queued");
    markAnswerOwed(db, { toolCallId: "t-new", sessionKey: "topic:a", rowId: "r-new" }, 200);
    markAnswerOwed(db, { toolCallId: "t-old", sessionKey: "topic:a", rowId: "r-old" }, 100);
    // A second answer to the same panel keeps its place in the order.
    markAnswerOwed(db, { toolCallId: "t-old", sessionKey: "topic:a", rowId: "r-old" }, 300);
    const owed = loadOwedAnswers(db);
    expect(owed.map((o) => [o.toolCallId, o.rowId, o.sessionKey])).toEqual([["t-old", "r-old", "topic:a"], ["t-new", "r-new", "topic:a"]]);
    expect(owed[0]!.content).toContain(`> ${QUESTION}`);
    expect(owed[0]!.content).toContain("next");
    db.close();
  });

  test("a fork keeps the tool call id: the chat and its fork each owe their own answer", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    rowWithAnswer(db, "r-chat", "topic:chat", "t-same", "queued");
    rowWithAnswer(db, "r-fork", "topic:fork", "t-same", "queued");
    markAnswerOwed(db, { toolCallId: "t-same", sessionKey: "topic:chat", rowId: "r-chat" }, 100);
    markAnswerOwed(db, { toolCallId: "t-same", sessionKey: "topic:fork", rowId: "r-fork" }, 200);
    expect(loadOwedAnswers(db).map((o) => o.sessionKey)).toEqual(["topic:chat", "topic:fork"]);
    markAnswerNotOwed(db, "topic:fork", "t-same");
    expect(loadOwedAnswers(db).map((o) => o.sessionKey)).toEqual(["topic:chat"]);
    db.close();
  });

  test("a row whose blob cannot be read costs its answer a log line, not the boot, and stays in the index", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    rowWithAnswer(db, "r-ok", "topic:a", "t-ok", "queued");
    db.prepare(`INSERT INTO messages (id, session_key, role, content, tool_calls, timestamp) VALUES ('r-bad', 'topic:a', 'assistant', '', ?, '2026-08-20')`)
      .run(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4, 5]) as never);
    markAnswerOwed(db, { toolCallId: "t-bad", sessionKey: "topic:a", rowId: "r-bad" }, 100);
    markAnswerOwed(db, { toolCallId: "t-ok", sessionKey: "topic:a", rowId: "r-ok" }, 200);
    expect(loadOwedAnswers(db).map((o) => o.toolCallId)).toEqual(["t-ok"]);
    expect((entries(db) as Array<{ tool_call_id: string }>).map((e) => e.tool_call_id)).toEqual(["t-bad", "t-ok"]);
    db.close();
  });

  test("sent, the entry goes; a row gone or no longer queued drops its entry at the next load", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    rowWithAnswer(db, "r1", "topic:a", "t-sent", "queued");
    rowWithAnswer(db, "r2", "topic:a", "t-marked-sent", "sent");
    markAnswerOwed(db, { toolCallId: "t-sent", sessionKey: "topic:a", rowId: "r1" });
    markAnswerOwed(db, { toolCallId: "t-marked-sent", sessionKey: "topic:a", rowId: "r2" });
    markAnswerOwed(db, { toolCallId: "t-row-gone", sessionKey: "topic:a", rowId: "r-deleted" });
    markAnswerNotOwed(db, "topic:a", "t-sent");
    expect(loadOwedAnswers(db)).toEqual([]);
    expect(entries(db)).toEqual([]);
    db.close();
  });
});
