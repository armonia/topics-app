#!/usr/bin/env bun
/**
 * Converts the database to `auto_vacuum = INCREMENTAL`, once, with the server
 * stopped. Called by `scripts/start-prod.sh` before the supervisor loop.
 *
 * WHY. With `auto_vacuum = NONE` SQLite reuses free pages but never shortens
 * the file, so a multi-GB `data/topics.db` keeps every page it ever freed. In
 * INCREMENTAL mode the idle server gives them back a few at a time
 * (`server/lib/db-incremental-vacuum.ts`). A database born before that mode
 * existed only switches through a full `VACUUM`: the whole file rewritten under
 * the write lock, minutes on a file this size. Inside the running server that
 * would stall every turn; before the server starts there is nobody to stall.
 *
 * EVERY DOUBT SKIPS, AND THE SERVER STARTS ANYWAY. The caller ignores the exit
 * code. In order:
 *   - already INCREMENTAL (or FULL), or no database: nothing to do;
 *   - the failure marker exists: a VACUUM already failed here, and retrying it
 *     at every boot would cost minutes of downtime each time;
 *   - another process holds the database open (an orphaned server): the
 *     exclusive lock is taken with no wait, and failing it means skip;
 *   - free disk under 2x the database: the VACUUM writes a compacted copy and
 *     then the whole file again through the WAL. Measured before the backup
 *     and again after it, because on a filesystem that cannot clone the backup
 *     is a full copy that ate part of that room.
 * The VACUUM itself is atomic: if it throws, the database is the one before.
 *
 *   bun run scripts/enable-incremental-vacuum.ts   (DATA_DIR / TOPICS_DATA_DIR as the server reads them)
 */
import { Database } from "bun:sqlite";
import { constants, copyFileSync, existsSync, statSync, statfsSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { resolveDataDir, stateDirTarget } from "../server/lib/data-dir";

export const BACKUP_SUFFIX = ".pre-incremental-vacuum";
export const FAILED_MARKER_SUFFIX = ".incremental-vacuum-failed";

/** `PRAGMA auto_vacuum` values. */
const AUTO_VACUUM_NONE = 0;
const AUTO_VACUUM_INCREMENTAL = 2;

export interface EnableIncrementalVacuumOptions {
  dbPath: string;
  /** Bytes available to us on the filesystem holding `dir`. Injected in tests. */
  freeBytes?: (dir: string) => number;
  /** The mode switch and the VACUUM. Injected in tests to make it throw. */
  vacuum?: (db: Database) => void;
  log?: (line: string) => void;
}

export type EnableIncrementalVacuumOutcome =
  | { action: "converted"; backupPath: string; beforeBytes: number; afterBytes: number; ms: number }
  | { action: "skipped"; reason: string }
  | { action: "failed"; reason: string };

function diskFreeBytes(dir: string): number {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
}

function defaultVacuum(db: Database): void {
  db.run("PRAGMA auto_vacuum = INCREMENTAL");
  db.run("VACUUM");
}

/** Main file plus WAL: both are what a VACUUM has to rewrite. */
function databaseBytes(dbPath: string): number {
  const wal = `${dbPath}-wal`;
  return statSync(dbPath).size + (existsSync(wal) ? statSync(wal).size : 0);
}

function pragma(db: Database, name: string): number {
  // Finalized at once: a cached statement (`db.query`) outlives `close()`, and
  // so does the connection and its exclusive lock, until the process exits.
  const stmt = db.prepare(`PRAGMA ${name}`);
  try {
    return Object.values(stmt.get() as Record<string, number>)[0];
  } finally {
    stmt.finalize();
  }
}

export function enableIncrementalVacuum(opts: EnableIncrementalVacuumOptions): EnableIncrementalVacuumOutcome {
  const { dbPath } = opts;
  const freeBytes = opts.freeBytes ?? diskFreeBytes;
  const vacuum = opts.vacuum ?? defaultVacuum;
  const log = opts.log ?? ((line: string) => console.log(line));
  const marker = dbPath + FAILED_MARKER_SUFFIX;
  const backupPath = dbPath + BACKUP_SUFFIX;
  const skip = (reason: string): EnableIncrementalVacuumOutcome => {
    log(`[incremental-vacuum] skipped: ${reason}`);
    return { action: "skipped", reason };
  };

  if (!existsSync(dbPath)) return skip(`no database at ${dbPath}`);
  if (existsSync(marker)) return skip(`${marker} exists (a previous VACUUM failed); delete it to retry`);

  let db: Database | null = null;
  let backupWritten = false;
  try {
    db = new Database(dbPath);
    db.run("PRAGMA busy_timeout = 0");
    const mode = pragma(db, "auto_vacuum");
    if (mode !== AUTO_VACUUM_NONE) return skip(`auto_vacuum is already ${mode}`);

    // The lock is held from here to close: nobody can open the file under us.
    db.run("PRAGMA locking_mode = EXCLUSIVE");
    try {
      db.run("BEGIN EXCLUSIVE");
      db.run("COMMIT");
    } catch (err) {
      return skip(`database is open in another process (${(err as Error).message})`);
    }
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");

    const dir = dirname(dbPath);
    const needed = () => databaseBytes(dbPath) * 2;
    const tight = () => {
      const free = freeBytes(dir);
      return free < needed() ? `free disk ${free} B is under 2x the database (${needed()} B)` : null;
    };
    const beforeBackup = tight();
    if (beforeBackup) return skip(beforeBackup);

    // A clone on APFS: no extra room until the VACUUM rewrites the pages.
    copyFileSync(dbPath, backupPath, constants.COPYFILE_FICLONE);
    backupWritten = true;
    const afterBackup = tight();
    if (afterBackup) {
      unlinkSync(backupPath);
      backupWritten = false;
      return skip(`${afterBackup} after the backup`);
    }

    const beforeBytes = statSync(dbPath).size;
    const started = performance.now();
    try {
      vacuum(db);
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      const now = pragma(db, "auto_vacuum");
      if (now !== AUTO_VACUUM_INCREMENTAL) throw new Error(`auto_vacuum is ${now} after VACUUM`);
    } catch (err) {
      const reason = `VACUUM failed: ${(err as Error).message}`;
      writeFileSync(marker, `${new Date().toISOString()} ${reason}\n`);
      log(`[incremental-vacuum] ${reason}; database unchanged, backup at ${backupPath}, marker ${marker}`);
      return { action: "failed", reason };
    }
    const ms = Math.round(performance.now() - started);
    const afterBytes = statSync(dbPath).size;
    log(
      `[incremental-vacuum] converted in ${ms} ms: ${beforeBytes} B -> ${afterBytes} B. ` +
        `Backup of the old file at ${backupPath}; trash it once the server runs fine.`,
    );
    return { action: "converted", backupPath, beforeBytes, afterBytes, ms };
  } catch (err) {
    if (backupWritten) {
      try { unlinkSync(backupPath); } catch { /* the original is untouched either way */ }
    }
    const reason = (err as Error).message;
    log(`[incremental-vacuum] failed before the VACUUM: ${reason}`);
    return { action: "failed", reason };
  } finally {
    db?.close();
  }
}

if (import.meta.main) {
  // The same resolution as the server's `initDatabase` (server/utils.ts).
  const root = resolve(import.meta.dir, "..");
  const dbPath = join(resolveDataDir(stateDirTarget(root)), "topics.db");
  const outcome = enableIncrementalVacuum({ dbPath });
  process.exit(outcome.action === "failed" ? 1 : 0);
}
