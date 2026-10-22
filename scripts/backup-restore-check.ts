#!/usr/bin/env bun
/**
 * The backup's bar: it exits 0 only if the most recent copy RESTORES.
 *
 * A snapshot nobody restored is not a backup. Here the most recent copy is
 * decompressed into a scratch directory, passes `PRAGMA integrity_check`, then
 * `initDatabase` runs on it and the registered migrations must reach the number
 * of files in `server/db/migrations/` (188 on 22/10/2026).
 *
 * And it must contain WORK. The migration count alone proves nothing about the
 * contents: `initDatabase` creates the schema and registers every migration on
 * ANY file, so a backup of an empty DB, or of a DB that is not this one, passed
 * the bar exactly like a good one. A backup with no topic and no message is not
 * this machine's backup.
 *
 * It also exits non-zero when the most recent copy is older than MAX_AGE_DAYS:
 * the real case was a last backup from 8 days before, and a job that has
 * stopped running must not stay green on the strength of an old copy.
 *
 *   bun run scripts/backup-restore-check.ts   (the snapshot's own data dir)
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { closeDatabase, initDatabase } from "../server/db";
import { backupsDirOf, liveDbPath, listSnapshots } from "./db-snapshot";

const MAX_AGE_DAYS = 2;
const REPO_ROOT = resolve(import.meta.dir, "..");

export interface RestoreVerdict {
  /** Migrations registered in the copy. */
  migrations: number;
  topics: number;
  messages: number;
}

/** Throws if the copy does not restore, or carries no work. */
export function restoreCheck(backupsDir: string, now: Date = new Date()): RestoreVerdict {
  const latest = listSnapshots(backupsDir)[0];
  if (!latest) throw new Error(`no snapshot in ${backupsDir}`);
  const ageDays = (now.getTime() - Date.parse(latest.slice(7, 17))) / 86_400_000;
  if (ageDays > MAX_AGE_DAYS) throw new Error(`${latest} is ${Math.floor(ageDays)} days old`);

  const scratch = mkdtempSync(join(tmpdir(), "topics-restore-check-"));
  const prevDataDir = process.env.DATA_DIR;
  try {
    const restored = join(scratch, "topics.db");
    writeFileSync(restored, Bun.zstdDecompressSync(readFileSync(join(backupsDir, latest))));

    const probe = new Database(restored, { readonly: true });
    try {
      const verdict = probe.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
      if (verdict.length !== 1 || verdict[0].integrity_check !== "ok") {
        throw new Error(`integrity_check: ${verdict.map((r) => r.integrity_check).slice(0, 3).join("; ")}`);
      }
    } finally {
      probe.close();
    }

    // DATA_DIR wins over every other root: the DB opened is the copy, never the live one.
    process.env.DATA_DIR = scratch;
    const db = initDatabase(REPO_ROOT);
    const applied = (db.query("SELECT count(*) AS n FROM schema_migrations").get() as { n: number }).n;
    const expected = readdirSync(join(REPO_ROOT, "server", "db", "migrations")).filter((f) => /^\d+-.+\.sql$/.test(f)).length;
    if (applied !== expected) throw new Error(`migrations registered ${applied}, expected ${expected}`);

    // The schema is there by construction: `initDatabase` creates it on any
    // file. What is being proven here is that the work is inside.
    const topics = (db.query("SELECT count(*) AS n FROM topics").get() as { n: number }).n;
    const messages = (db.query("SELECT count(*) AS n FROM messages").get() as { n: number }).n;
    if (topics === 0 || messages === 0) {
      throw new Error(`copy with no work in it: ${topics} topics, ${messages} messages`);
    }
    return { migrations: applied, topics, messages };
  } finally {
    closeDatabase();
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const v = restoreCheck(backupsDirOf(liveDbPath()));
    console.log(`[backup-restore-check] ok: integrity_check ok, ${v.migrations} migrations, ${v.topics} topics, ${v.messages} messages`);
  } catch (err) {
    console.error(`[backup-restore-check] RED: ${(err as Error).message}`);
    process.exit(1);
  }
}
