/**
 * Periodic ui_state backup — defence-in-depth against accidental wipes.
 *
 * The post-Phase-A→H tab reset incident showed that a single bad PUT can
 * permanently overwrite `ui_state.pane-store-v2.openChatTopicIds` server-
 * side. The proper fix is the renderer-side hydrate guard (see
 * `client/src/state/pane/middleware/syncServer.ts`); this module is the
 * second-line defence: an automatic snapshot of the entire ui_state table
 * to disk every N minutes, retained for the last K snapshots, so any
 * future accident can be rolled back manually with one query.
 *
 * Disk layout: `~/.topics/ui-state-backups/<ISO>.json`
 * Retention:   keep newest BACKUP_RETENTION files, older ones unlinked.
 *
 * The backup is atomic (`.tmp` → rename) and uses synchronous fs because
 * each tick is small (a few KB at most) and we don't want a partially-
 * written backup if the process crashes mid-write.
 */
import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  existsSync, mkdirSync, readdirSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";

const BACKUP_INTERVAL_MS = 5 * 60_000;   // every 5 minutes
const BACKUP_RETENTION = 24;             // 24 snapshots = ~2 hours of history

function backupsDir(): string {
  const home = process.env.TOPICS_HOME || join(homedir(), ".topics");
  return join(home, "ui-state-backups");
}

interface UiStateBackupRow {
  key: string;
  value: string;
  payload_version: number | null;
  server_seq: number | null;
  updated_at: string;
}

interface UiStateBackup {
  at: string;
  rows: UiStateBackupRow[];
}

function snapshotOnce(db: Database): void {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });

  const rows = db.query(
    `SELECT key, value, payload_version, server_seq, updated_at FROM ui_state`,
  ).all() as UiStateBackupRow[];

  // Empty table → still write the backup so the timestamp is recorded.
  const at = new Date().toISOString();
  const payload: UiStateBackup = { at, rows };

  const filename = `${at.replace(/[:.]/g, "-")}.json`;
  const finalPath = join(dir, filename);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
  renameSync(tmpPath, finalPath);

  // Retention sweep — keep newest BACKUP_RETENTION, drop older ones.
  try {
    const all = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime); // newest first
    for (const entry of all.slice(BACKUP_RETENTION)) {
      try { unlinkSync(join(dir, entry.f)); } catch { /* swallow */ }
    }
  } catch { /* dir read failed — non-fatal */ }
}

/**
 * Start the background ticker. Returns a `stop()` to clear the interval
 * — used by the graceful-shutdown handler in server.ts.
 *
 * The first tick runs ~5 minutes after start, NOT at boot, so a normal
 * server restart doesn't flood the disk with near-identical snapshots.
 */
export function startUiStateBackupTicker(db: Database): () => void {
  const timer = setInterval(() => {
    try { snapshotOnce(db); } catch (err) {
      console.warn("[UiStateBackup] snapshot failed:", err);
    }
  }, BACKUP_INTERVAL_MS);
  return () => clearInterval(timer);
}

/**
 * Snapshot once on demand — useful for tests and for the bootstrap path
 * (server.ts can call this once on startup to capture pre-restart state).
 */
export function snapshotUiStateNow(db: Database): void {
  snapshotOnce(db);
}

/**
 * List the available backups, newest first. Returns absolute paths.
 */
export function listUiStateBackups(): string[] {
  const dir = backupsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((e) => join(dir, e.f));
}
