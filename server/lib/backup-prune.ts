/**
 * The impure half of the automatic database copy expiry
 * (`backup-retention.ts` decides, this moves files). Nothing is deleted
 * outright: an expired copy goes to a dated folder under `<home>/trash`, where
 * it stays `TRASH_DAYS` days before the folder is removed, so a copy that
 * holds conversations can still be taken back after a wrong call.
 *
 * `home` is the Topics home (`topicsHome()`), never `homedir()`: a test or a
 * second install points it elsewhere through `TOPICS_HOME`.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { backupKeepCount, expiredBackupEntries } from "./backup-retention";

/** Days an expired copy waits in the trash before it is really removed. */
export const TRASH_DAYS = 7;

const DAY_FOLDER = /^\d{8}$/;

function dayStamp(now: number): string {
  return new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
}

/** Refuses to expire anything while a kept automatic copy is empty: it could not be a fallback. */
function keptCopiesAreReadable(dir: string, expired: ReadonlySet<string>, names: readonly string[]): boolean {
  const kept = names.filter((n) => n.startsWith("topics-pre-") && n.endsWith(".db") && !expired.has(join(dir, n)));
  return kept.length > 0 && kept.every((n) => statSync(join(dir, n)).size > 0);
}

/**
 * Moves the automatic copies in `<home>/db-backups` beyond the newest
 * `TOPICS_BACKUP_KEEP` (and older than the policy's 7 days) to the trash.
 * Returns the original paths. Does nothing unless every kept copy is non-empty.
 */
export function pruneOldBackups(home: string, env: NodeJS.ProcessEnv, now: number = Date.now()): string[] {
  const dir = join(home, "db-backups");
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir);
  const entries = names.flatMap((name) => {
    try {
      return statSync(join(dir, name)).isFile() ? [{ id: join(dir, name), name }] : [];
    } catch {
      return [];
    }
  });
  const expired = expiredBackupEntries(entries, backupKeepCount(env), now);
  if (expired.length === 0 || !keptCopiesAreReadable(dir, new Set(expired), names)) return [];
  const trash = join(home, "trash", dayStamp(now));
  mkdirSync(trash, { recursive: true });
  const moved: string[] = [];
  for (const path of expired) {
    try {
      renameSync(path, join(trash, path.slice(dir.length + 1)));
      moved.push(path);
    } catch { /* best effort: a concurrent writer wins */ }
  }
  return moved;
}

/** Removes the day folders under `<home>/trash` older than `TRASH_DAYS`. Only folders this module creates (`YYYYMMDD`). */
export function purgeTrash(home: string, now: number = Date.now()): string[] {
  const root = join(home, "trash");
  if (!existsSync(root)) return [];
  const cutoff = dayStamp(now - TRASH_DAYS * 86_400_000);
  const purged: string[] = [];
  for (const name of readdirSync(root)) {
    if (!DAY_FOLDER.test(name) || name >= cutoff) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      purged.push(name);
    } catch { /* best effort */ }
  }
  return purged;
}
