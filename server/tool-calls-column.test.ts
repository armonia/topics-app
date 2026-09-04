/**
 * `tool_calls` is not written twice: with `blocks` on the row, the column
 * stays empty and the tool calls are read back from the timeline.
 *
 * Measured on the live database: `tool_calls` weighs 149.2 MB, of which 144.4
 * MB sits on rows that ALSO carry `blocks`, and on the 40 heaviest rows every
 * toolCall of the column exists identical inside the blocks. The wire already
 * dropped it for that exact reason (`leanMessageForWire`); the disk did not.
 *
 * What these tests pin is the other half, the one that makes it lossless:
 *   - a row WITH blocks keeps no copy, and still answers with its tool calls;
 *   - a row WITHOUT blocks keeps the column, which there is the only source
 *     (4.8 MB over 5,332 rows on that same database);
 *   - Regenerate, the only server reader of `msg.toolCalls`, still sees the
 *     evidence of the turn it is replacing;
 *   - the migration cleans the rows already on disk, and only those.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { closeDatabase } from "./db";
import { createAppContext } from "./utils";
import type { AppContext, ContentBlock, Topic, ToolCall } from "./types";

/* DATA_DIR is shared environment: restored, not deleted. */
const DATA_DIR_BEFORE = process.env.DATA_DIR;

let tmpRoot: string;
let ctx: AppContext;

const SK = "topic:toolcol01";

function seedTopic() {
  const now = new Date().toISOString();
  const topic: Topic = {
    id: "toolcol1-aaaa-bbbb-cccc-000000000001",
    name: "Tool column",
    slug: "tool-column",
    parentId: null,
    links: [],
    sessionKey: SK,
    color: "#aabbcc",
    icon: "chat",
    createdAt: now,
    updatedAt: now,
    archived: false,
  };
  ctx.saveSingleTopic(topic);
}

function tool(id: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name: "Bash", args: { command: "echo hi" }, status: "success", result: "hi\n", ...over };
}

/** What the column literally holds for a message, straight from SQLite. */
function rawColumn(id: string): string | null {
  const row = ctx.db.prepare(`SELECT tool_calls FROM messages WHERE id = ?`).get(id) as { tool_calls: unknown } | undefined;
  const value = row?.tool_calls;
  if (value == null) return null;
  return typeof value === "string" ? value : "<blob>";
}

function isEmptyColumn(value: string | null): boolean {
  return value === null || value === "" || value === "[]" || value === "null";
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "tool-calls-column-"));
  const migDir = join(tmpRoot, "server", "db", "migrations");
  mkdirSync(migDir, { recursive: true });
  const realMigDir = join(import.meta.dir, "db", "migrations");
  for (const f of readdirSync(realMigDir)) {
    if (!f.endsWith(".sql")) continue;
    writeFileSync(join(migDir, f), readFileSync(join(realMigDir, f), "utf-8"));
  }
  mkdirSync(join(tmpRoot, "public"), { recursive: true });
  process.env.DATA_DIR = join(tmpRoot, "data");
  process.env.OPENCLAW_DIR = join(tmpRoot, "openclaw");
  ctx = createAppContext(tmpRoot);
  seedTopic();
});

afterAll(() => {
  try { closeDatabase(); } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  if (DATA_DIR_BEFORE === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = DATA_DIR_BEFORE;
});

describe("the column is not the second copy", () => {
  test("a message saved with blocks keeps no copy, and answers with its tool calls anyway", () => {
    const tc = tool("save-1");
    const blocks: ContentBlock[] = [{ kind: "tool", toolCall: tc }];
    ctx.saveLocalMessages(SK, [
      { id: "msg-with-blocks", role: "assistant", content: "", timestamp: new Date().toISOString(), toolCalls: [tc], blocks },
    ]);

    expect(isEmptyColumn(rawColumn("msg-with-blocks"))).toBe(true);
    const loaded = ctx.loadActiveThread(SK);
    expect(loaded[0]?.toolCalls?.length).toBe(1);
    expect(loaded[0]?.toolCalls?.[0]?.id).toBe("save-1");
    expect(loaded[0]?.toolCalls?.[0]?.result).toBe("hi\n");
  });

  test("without blocks the column stays: there it is the only source there is", () => {
    const tc = tool("save-2");
    ctx.saveLocalMessages(SK, [
      { id: "msg-no-blocks", role: "assistant", content: "", timestamp: new Date().toISOString(), toolCalls: [tc] },
    ]);

    expect(isEmptyColumn(rawColumn("msg-no-blocks"))).toBe(false);
    expect(ctx.loadActiveThread(SK)[0]?.toolCalls?.[0]?.id).toBe("save-2");
  });

  test("during a turn: once the blocks are on the row, the tool events stop rewriting the column", () => {
    ctx.saveLocalMessages(SK, []);
    const msg = ctx.createPartialMessage(SK, "assistant");
    const blocks: ContentBlock[] = [];

    for (const id of ["a", "b", "c"]) {
      const tc = tool(id, { status: "running", result: undefined });
      blocks.push({ kind: "tool", toolCall: tc });
      ctx.addToolCallToLastMessage(SK, tc);
      ctx.updateLastMessage(SK, { blocks });
      ctx.updateToolCallResult(SK, id, `out ${id}`);
      blocks[blocks.length - 1] = { kind: "tool", toolCall: { ...tc, status: "success", result: `out ${id}` } };
      ctx.updateLastMessage(SK, { blocks });
    }

    expect(isEmptyColumn(rawColumn(msg.id))).toBe(true);
    const loaded = ctx.getMessageById(msg.id)!;
    expect(loaded.toolCalls?.map(t => t.id)).toEqual(["a", "b", "c"]);
    expect(loaded.toolCalls?.[2]?.result).toBe("out c");
  });

  test("Regenerate still sees the evidence of the turn it replaces", () => {
    // routes/edit.ts reads `msg.toolCalls` off `getMessageById` and hands it to
    // the new turn as the evidence of the old one. It is the only server
    // reader of that field, so it is the one that would have gone blind.
    const tc = tool("evidence-1", { name: "Read", result: "the file" });
    ctx.saveLocalMessages(SK, [
      { id: "msg-evidence", role: "assistant", content: "", timestamp: new Date().toISOString(), toolCalls: [tc], blocks: [{ kind: "tool", toolCall: tc }] },
    ]);

    const evidence = ctx.getMessageById("msg-evidence")?.toolCalls;
    expect(evidence?.length).toBe(1);
    expect(evidence?.[0]?.name).toBe("Read");
    expect(evidence?.[0]?.result).toBe("the file");
  });
});

describe("the migration on the rows already on disk", () => {
  test("clears the duplicate and only the duplicate", () => {
    const sql = readFileSync(join(import.meta.dir, "db", "migrations", "20260904100839-tool-calls-duplicati-nei-blocchi.sql"), "utf-8");
    const db = new Database(":memory:");
    db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, tool_calls TEXT, blocks TEXT)`);
    const insert = db.prepare(`INSERT INTO messages (id, tool_calls, blocks) VALUES (?, ?, ?)`);
    insert.run("duplicate", '[{"id":"t1"}]', '[{"kind":"tool","toolCall":{"id":"t1"}}]');
    insert.run("only-source", '[{"id":"t2"}]', null);
    insert.run("empty-blocks", '[{"id":"t3"}]', "[]");
    insert.run("compressed-blocks", '[{"id":"t4"}]', "");
    db.run(sql);

    const columnOf = (id: string) => (db.prepare(`SELECT tool_calls FROM messages WHERE id = ?`).get(id) as { tool_calls: string | null }).tool_calls;
    expect(columnOf("duplicate")).toBeNull();
    expect(columnOf("only-source")).toBe('[{"id":"t2"}]');
    expect(columnOf("empty-blocks")).toBe('[{"id":"t3"}]');
    expect(columnOf("compressed-blocks")).toBe('[{"id":"t4"}]');
    db.close();
  });
});
