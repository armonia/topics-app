/**
 * GENERIC EXPIRY FOR BACKUP FOLDERS (`db-backups`, `backups`): keep the
 * newest N copies, drop the rest. A SQLite copy is a `.db` plus optional
 * `-wal` / `-shm` siblings: they form ONE copy and go together.
 *
 * `TOPICS_BACKUP_KEEP` sets N (default 3). Zero or a negative value disables
 * pruning and keeps everything. Pure: the caller lists the entries and
 * deletes what this returns.
 */

export interface BackupEntryStat {
  /** Opaque to this module: a path, a name, whatever the caller wants back. */
  id: string;
  /** The entry's file or folder name, used to group a database with its siblings. */
  name: string;
  mtimeMs: number;
}

const DEFAULT_KEEP = 3;

export function backupKeepCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TOPICS_BACKUP_KEEP;
  if (raw === undefined || raw === "") return DEFAULT_KEEP;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : DEFAULT_KEEP;
}

function copyName(name: string): string {
  return name.replace(/-(wal|shm)$/, "");
}

/** The ids of the entries belonging to copies older than the newest `keep`. Empty when `keep` is not positive. */
export function expiredBackupEntries(entries: readonly BackupEntryStat[], keep: number): string[] {
  if (keep <= 0) return [];
  const copies = new Map<string, { newest: number; ids: string[] }>();
  for (const e of entries) {
    const key = copyName(e.name);
    const c = copies.get(key) ?? { newest: 0, ids: [] };
    c.newest = Math.max(c.newest, e.mtimeMs);
    c.ids.push(e.id);
    copies.set(key, c);
  }
  return [...copies.values()]
    .sort((a, b) => b.newest - a.newest)
    .slice(keep)
    .flatMap((c) => c.ids);
}
