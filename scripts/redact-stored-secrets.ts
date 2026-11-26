#!/usr/bin/env bun
/**
 * One-off cleanup for SEC-02: masks the secrets already stored in tool
 * arguments and tool output (`messages.tool_calls`, `messages.blocks` and the
 * split bodies in `message_tool_outputs`), with the same rules the writers use.
 *
 * Dry run by default. `--apply` FIRST copies the database and its `-wal`/`-shm`
 * next to it (`<db>.pre-redact-<timestamp>[-wal|-shm]`), and refuses to write if
 * a copy is missing. Rerunnable: a masked value matches no rule again.
 *
 *   bun run scripts/redact-stored-secrets.ts [--apply] [--db PATH]
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decodeCol, encodeCol } from "../shared/message-blob";
import { redactDeep } from "../server/lib/secret-redaction";

export interface RedactionCounts { toolCalls: number; blocks: number; toolOutputs: number; changedMeanwhile: number }

/**
 * Re-encodes a column the way its writer does (`encodeCol` for messages, zstd for
 * the split bodies) and writes it only if the row still holds what was read: the
 * server keeps writing while this runs, and a turn saved after the read must not
 * be rolled back to the masked old copy. Returns false when the row had moved on
 * (a rerun picks it up).
 */
export function rewriteIfUnchanged(db: Database, t: { table: string; col: string; key: string; compress: boolean }, key: string, read: unknown, text: string): boolean {
  const value = t.compress ? Bun.zstdCompressSync(Buffer.from(text, "utf8"), { level: 3 }) : encodeCol(text);
  return db.prepare(`UPDATE ${t.table} SET ${t.col} = ? WHERE ${t.key} = ? AND ${t.col} IS ?`).run(value as never, key, read as never).changes === 1;
}

/** Masks the stored secrets in `db`; with `apply` false it only counts the rows it would change. */
export function redactStoredSecrets(db: Database, apply: boolean): RedactionCounts {
  const counts: RedactionCounts = { toolCalls: 0, blocks: 0, toolOutputs: 0, changedMeanwhile: 0 };
  const targets = [
    { table: "messages", col: "tool_calls", key: "id", count: "toolCalls", compress: false },
    { table: "messages", col: "blocks", key: "id", count: "blocks", compress: false },
    { table: "message_tool_outputs", col: "body", key: "message_id", count: "toolOutputs", compress: true },
  ] as const;
  for (const t of targets) {
    const rows = db.query(`SELECT ${t.key} AS k, ${t.col} AS v FROM ${t.table} WHERE ${t.col} IS NOT NULL`).all() as { k: string; v: unknown }[];
    for (const { k, v } of rows) {
      const text = decodeCol(v);
      if (!text) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { continue; }
      const masked = redactDeep(parsed);
      if (masked === parsed) continue;
      if (apply && !rewriteIfUnchanged(db, t, k, v, JSON.stringify(masked))) { counts.changedMeanwhile++; continue; }
      counts[t.count]++;
    }
  }
  return counts;
}

/** Copies the database and its sidecars; throws if one that exists was not copied. */
export function backupDatabase(dbPath: string, stamp: string): string[] {
  const made: string[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    if (!existsSync(dbPath + suffix)) {
      if (suffix === "") throw new Error(`database not found: ${dbPath}`);
      continue;
    }
    const to = `${dbPath}.pre-redact-${stamp}${suffix}`;
    copyFileSync(dbPath + suffix, to);
    if (!existsSync(to)) throw new Error(`backup missing: ${to}`);
    made.push(to);
  }
  return made;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const at = args.indexOf("--db");
  const dbPath = at >= 0 ? args[at + 1] : join(process.env.DATA_DIR ?? join(import.meta.dir, "..", "data"), "topics.db");
  if (apply) console.log("backup:", backupDatabase(dbPath, new Date().toISOString().replace(/[:.]/g, "-")).join(", "));
  const db = new Database(dbPath);
  console.log(apply ? "masked:" : "would mask:", redactStoredSecrets(db, apply));
  db.close();
}
