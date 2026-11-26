/**
 * The one-off cleanup of SEC-02, on a synthetic database: it masks what the
 * rules name, leaves clean rows byte for byte, and the backup exists before
 * anything is written.
 *
 * @covers SEC-02
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCol, encodeCol } from "../shared/message-blob";
import { backupDatabase, redactStoredSecrets, rewriteIfUnchanged } from "./redact-stored-secrets";

function synthetic(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, tool_calls, blocks)");
  db.run("CREATE TABLE message_tool_outputs (message_id TEXT PRIMARY KEY, body BLOB)");
  const dirty = JSON.stringify([{ id: "a", args: { command: "sshpass -p 'S3gr3t0!' ssh root@host" } }]);
  const clean = JSON.stringify([{ id: "b", args: { command: "git log -p" } }]);
  db.prepare("INSERT INTO messages VALUES (?, ?, ?)").run("dirty", encodeCol(dirty) as never, encodeCol(dirty) as never);
  db.prepare("INSERT INTO messages VALUES (?, ?, ?)").run("clean", encodeCol(clean) as never, null);
  const body = JSON.stringify({ a: { output: "Authorization: Bearer abc123" } });
  db.prepare("INSERT INTO message_tool_outputs VALUES (?, ?)").run("dirty", Bun.zstdCompressSync(Buffer.from(body)) as never);
  return db;
}

describe("redactStoredSecrets", () => {
  test("a dry run counts and writes nothing", () => {
    const db = synthetic();
    expect(redactStoredSecrets(db, false)).toEqual({ toolCalls: 1, blocks: 1, toolOutputs: 1, changedMeanwhile: 0 });
    const row = db.query("SELECT tool_calls v FROM messages WHERE id='dirty'").get() as { v: unknown };
    expect(decodeCol(row.v)).toContain("S3gr3t0!");
  });

  test("apply masks the dirty rows, leaves the clean one, and a second run finds nothing", () => {
    const db = synthetic();
    redactStoredSecrets(db, true);
    const dirty = db.query("SELECT tool_calls v, blocks b FROM messages WHERE id='dirty'").get() as { v: unknown; b: unknown };
    expect(decodeCol(dirty.v)).toContain("sshpass -p '[oscurato]' ssh root@host");
    expect(decodeCol(dirty.b)).not.toContain("S3gr3t0!");
    const out = db.query("SELECT body v FROM message_tool_outputs").get() as { v: unknown };
    expect(decodeCol(out.v)).toContain("Bearer [oscurato]");
    const clean = db.query("SELECT tool_calls v FROM messages WHERE id='clean'").get() as { v: unknown };
    expect(decodeCol(clean.v)).toContain("git log -p");
    expect(redactStoredSecrets(db, true)).toEqual({ toolCalls: 0, blocks: 0, toolOutputs: 0, changedMeanwhile: 0 });
  });

  test("a row the server rewrote after the read is left as the server wrote it", () => {
    const db = synthetic();
    const read = (db.query("SELECT tool_calls v FROM messages WHERE id='dirty'").get() as { v: unknown }).v;
    const newer = encodeCol(JSON.stringify([{ id: "a", args: { command: "ls" } }, { id: "c", args: { command: "pwd" } }]));
    db.prepare("UPDATE messages SET tool_calls = ? WHERE id = 'dirty'").run(newer as never);
    const target = { table: "messages", col: "tool_calls", key: "id", compress: false };
    expect(rewriteIfUnchanged(db, target, "dirty", read, "[]")).toBe(false);
    expect(decodeCol((db.query("SELECT tool_calls v FROM messages WHERE id='dirty'").get() as { v: unknown }).v)).toContain("pwd");
    expect(rewriteIfUnchanged(db, target, "dirty", newer, "[]")).toBe(true);
  });
});

describe("backupDatabase", () => {
  test("copies the db and its -wal, and refuses a missing db", () => {
    const dir = mkdtempSync(join(tmpdir(), "redact-backup-"));
    try {
      const db = join(dir, "topics.db");
      writeFileSync(db, "x");
      writeFileSync(db + "-wal", "y");
      const made = backupDatabase(db, "T");
      expect(made.length).toBe(2);
      expect(made.every(existsSync)).toBe(true);
      expect(() => backupDatabase(join(dir, "nope.db"), "T")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
