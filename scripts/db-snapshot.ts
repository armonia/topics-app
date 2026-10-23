#!/usr/bin/env bun
/**
 * The database's daily snapshot: `VACUUM INTO` to a temporary file, zstd
 * compression, atomic rename into `<data dir>/backups/`.
 *
 * WHY. Before this script the only full backup was a copy made by hand on the
 * same disk, and the only periodic one saved the `ui_state` table alone
 * (server/services/ui-state-backup.ts). With `TOPICS_SERVER_WATCH=1`, creating
 * a migration runs its SQL against the live DB within seconds: without
 * yesterday's snapshot a wrong data migration has no way back.
 *
 * `VACUUM INTO` is consistent with the server up (WAL included, no free pages)
 * and does not block writers: see docs/backup-pre-migration-policy.md. A
 * snapshot is only proven by `scripts/backup-restore-check.ts`. After pruning,
 * the snapshot is also copied off this disk by `scripts/backup-offsite.ts`
 * (when `~/.topics/backup-offsite.json` names a destination).
 *
 * Retention: the last 14 days, plus 8 Mondays older than that window. Pruning
 * uses `trash`, never `rm`, and touches only files named like a snapshot
 * (`topics-YYYY-MM-DD.db.zst`).
 *
 *   bun run scripts/db-snapshot.ts   (DATA_DIR / TOPICS_DATA_DIR as the server reads them)
 */
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { basename, dirname, join, resolve } from "path";
import { resolveDataDir, stateDirTarget } from "../server/lib/data-dir";
import { copyOffsite, loadOffsiteConfig } from "./backup-offsite";

const KEEP_DAILY = 14;
const KEEP_WEEKLY = 8;
const SNAPSHOT_NAME = /^topics-(\d{4}-\d{2}-\d{2})\.db\.zst$/;

/** The same path `initDatabase` uses (server/utils.ts). */
export function liveDbPath(): string {
  const root = resolve(import.meta.dir, "..");
  return join(resolveDataDir(stateDirTarget(root)), "topics.db");
}

export const backupsDirOf = (dbPath: string): string => join(dirname(dbPath), "backups");

/** Snapshot names, newest first. */
export function listSnapshots(backupsDir: string): string[] {
  try {
    return readdirSync(backupsDir).filter((f) => SNAPSHOT_NAME.test(f)).sort().reverse();
  } catch {
    return [];
  }
}

export function snapshotDb(dbPath: string, backupsDir: string, now: Date = new Date()): string {
  mkdirSync(backupsDir, { recursive: true });
  const day = now.toLocaleDateString("sv-SE");
  const rawTmp = join(backupsDir, `.topics-${day}.db.tmp`);
  const packedTmp = join(backupsDir, `.topics-${day}.db.zst.tmp`);
  const target = join(backupsDir, `topics-${day}.db.zst`);
  rmSync(rawTmp, { force: true });
  // Without `create` a wrong path fails instead of snapshotting an empty DB.
  const db = new Database(dbPath, { readwrite: true, create: false });
  try {
    db.run("PRAGMA busy_timeout = 10000");
    db.run("VACUUM INTO ?", [rawTmp]);
  } finally {
    db.close();
  }
  writeFileSync(packedTmp, Bun.zstdCompressSync(readFileSync(rawTmp)));
  rmSync(rawTmp);
  renameSync(packedTmp, target);
  return target;
}

const isMonday = (name: string): boolean =>
  new Date(`${name.match(SNAPSHOT_NAME)![1]}T00:00:00Z`).getUTCDay() === 1;

/** What to keep: the daily window plus the Mondays that lie beyond it. */
export function pruneCandidates(names: string[]): string[] {
  const older = names.slice(KEEP_DAILY);
  const weekly = new Set(older.filter(isMonday).slice(0, KEEP_WEEKLY));
  return older.filter((n) => !weekly.has(n));
}

const trash = (path: string): void => {
  const r = spawnSync("trash", [path]);
  if (r.status !== 0) throw new Error(`trash ${path} exit ${r.status}`);
};

export function pruneSnapshots(backupsDir: string, remove: (path: string) => void = trash): string[] {
  const doomed = pruneCandidates(listSnapshots(backupsDir));
  for (const name of doomed) remove(join(backupsDir, name));
  return doomed;
}

if (import.meta.main) {
  const dbPath = liveDbPath();
  const dir = backupsDirOf(dbPath);
  const target = snapshotDb(dbPath, dir);
  const pruned = pruneSnapshots(dir);
  console.log(`[db-snapshot] ${target}${pruned.length ? `, pruned ${pruned.length}` : ""}`);
  // The local snapshot already succeeded: an off-disk failure is loud but
  // never fatal here, so the `&& backup-restore-check` that follows still
  // runs and reports red.
  try {
    const cfg = loadOffsiteConfig();
    if (!cfg) {
      console.log("[db-snapshot] no off-disk destination: the restore check will be red until ~/.topics/backup-offsite.json exists");
    } else {
      const receipt = copyOffsite(dir, basename(target), cfg);
      console.log(`[db-snapshot] off-disk copy ok (slot ${receipt.slot})`);
    }
  } catch (err) {
    console.error(`[db-snapshot] off-disk copy FAILED: ${(err as Error).message}`);
  }
}
