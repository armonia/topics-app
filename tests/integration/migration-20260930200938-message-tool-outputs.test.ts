/**
 * `20260930200938-message-tool-outputs.sql`: the table a closed row's tool
 * output moves to, and the cursor of the backfill that moves the old rows.
 * @covers SCHEMA-07
 *
 * The file itself, on the real schema (every migration before it) with rows
 * written the way the code before it wrote them: the tables appear empty,
 * running it twice neither duplicates nor resets the cursor, an output dies
 * with its message (the foreign key the server turns on), and the backfill
 * over those rows moves their output and gives every row back whole.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PROJECT_ROOT } from "./helpers";
import { initDatabase, closeDatabase } from "../../server/db";
import { encodeCol, decodeCol } from "../../shared/message-blob";
import { backfillToolOutputsTick, restoreFromStore } from "../../server/lib/tool-output-store";

const NAME = "20260930200938-message-tool-outputs.sql";
const MIGRATION_SQL = readFileSync(join(PROJECT_ROOT, "server/db/migrations", NAME), "utf-8");

let tmpRoot: string | null = null;
let savedDataDir: string | undefined;
afterEach(() => {
  try { closeDatabase(); } catch { /* already closed */ }
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
  if (savedDataDir !== undefined) process.env.DATA_DIR = savedDataDir;
  savedDataDir = undefined;
});

const output = (seed: string) => `${seed} :: a line of tool output\n`.repeat(200);

/** The rows as the code before this migration wrote them: whole, zstd above 512 bytes. */
const ROWS: Record<string, unknown[]> = {
  "m-1": [{ kind: "tool", toolCall: { id: "t1", name: "Bash", status: "success", args: { command: "ls" }, result: output("one"), detail: { type: "shell", command: "ls", output: output("one") } } }],
  "m-2": [{ kind: "text", text: "just prose" }],
  "m-3": [{ kind: "tool", toolCall: { id: "t3", name: "Read", status: "success", args: { file_path: "/x" }, detail: { type: "read", filePath: "/x", content: output("three") } } }, { kind: "text", text: "read it" }],
};

function dbBefore(): Database {
  // The DB is a process singleton: a handle left open by an earlier file in
  // the same run would be handed back instead of this fresh schema, and a
  // DATA_DIR an earlier file set would win over the folder below.
  closeDatabase();
  savedDataDir = process.env.DATA_DIR;
  delete process.env.DATA_DIR;
  tmpRoot = mkdtempSync(join(tmpdir(), "tool-outputs-migration-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(PROJECT_ROOT, "server", "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (f.endsWith(".sql") && f !== NAME) writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  const db = initDatabase(tmpRoot);
  const insert = db.prepare("INSERT INTO messages (id, session_key, role, content, blocks, timestamp, sort_order) VALUES (?, 's', 'assistant', '', ?, '2026-09-01', ?)");
  let order = 0;
  for (const [id, blocks] of Object.entries(ROWS)) insert.run(id, (encodeCol(JSON.stringify(blocks)) ?? null) as never, order++);
  return db;
}

const count = (db: Database, table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("migration 20260930200938: message_tool_outputs", () => {
  test("before it the tables do not exist", () => {
    const db = dbBefore();
    expect(() => db.query("SELECT * FROM message_tool_outputs").all()).toThrow();
    expect(() => db.query("SELECT * FROM message_tool_outputs_backfill").all()).toThrow();
  });

  test("after it the store is empty and the backfill starts from the beginning; twice changes nothing", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    expect(count(db, "message_tool_outputs")).toBe(0);
    expect(db.query("SELECT id, after_id, finished_at FROM message_tool_outputs_backfill").all()).toEqual([{ id: 1, after_id: "", finished_at: null }]);
    db.run("UPDATE message_tool_outputs_backfill SET after_id = 'm-2'");
    db.run(MIGRATION_SQL);
    // A second run must not rewind a backfill already under way.
    expect(db.query("SELECT after_id FROM message_tool_outputs_backfill").all()).toEqual([{ after_id: "m-2" }]);
  });

  test("the backfill over the old rows moves their output, and every row reads back whole", () => {
    const db = dbBefore();
    db.run(MIGRATION_SQL);
    while (!backfillToolOutputsTick(db, { maxRows: 1, maxMs: 1000 }).done) { /* one row per tick */ }
    expect(count(db, "message_tool_outputs")).toBe(2);
    for (const [id, blocks] of Object.entries(ROWS)) {
      const raw = (db.query("SELECT blocks FROM messages WHERE id = ?").get(id) as { blocks: unknown }).blocks;
      const parsed = JSON.parse(decodeCol(raw)!) as unknown[];
      restoreFromStore(db, id, parsed);
      expect(parsed).toEqual(blocks);
    }
    // The output of a row that left the table goes with it.
    db.run("DELETE FROM messages WHERE id = 'm-1'");
    expect(count(db, "message_tool_outputs")).toBe(1);
  });
});
