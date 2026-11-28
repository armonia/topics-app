/**
 * EXPIRY FOR THE AUTOMATIC DATABASE COPIES in `db-backups`: keep the newest N,
 * and only copies at least `minAgeDays` old are ever candidates. ONLY entries
 * named the way Topics writes them (`topics-pre-<hash>[-<hash>]-<date>[-<time>].db`)
 * are candidates; anything else (named copies made by hand before an
 * irreversible operation, lists, recovery folders) is never listed as expired.
 * `backups` is not pruned at all. A SQLite copy is a `.db` plus optional
 * `-wal` / `-shm` siblings: they form ONE copy and go together. Recency comes
 * from the date in the NAME, never from file mtimes (a `-shm` touched later
 * would make an old copy look recent).
 *
 * `TOPICS_BACKUP_KEEP` sets N (default 3). Zero or a negative value disables
 * pruning and keeps everything. Pure: the caller lists the entries and moves
 * what this returns to the trash.
 */

export interface BackupEntryStat {
  /** Opaque to this module: a path, a name, whatever the caller wants back. */
  id: string;
  /** The entry's file or folder name, used to group a database with its siblings. */
  name: string;
}

const DEFAULT_KEEP = 3;

export function backupKeepCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TOPICS_BACKUP_KEEP;
  if (raw === undefined || raw === "") return DEFAULT_KEEP;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : DEFAULT_KEEP;
}

/** `topics-pre-<hex hash>[-<hex hash>]-<date>[-<time>].db` and its `-wal` / `-shm` siblings. */
const AUTOMATIC_COPY = /^topics-pre-[0-9a-f]{7,40}(?:-[0-9a-f]{7,40})?-(\d{8})(?:-(\d{4,6}))?\.db(?:-wal|-shm)?$/;

/** Minimum age (days, from the date in the name) before an automatic copy may expire. Policy: 7 days. */
const BACKUP_MIN_AGE_DAYS = 7;

/** The copy's moment as `YYYYMMDDhhmmss` read from its name, or null when the name is not an automatic copy. */
function copyStamp(name: string): string | null {
  const m = AUTOMATIC_COPY.exec(name);
  return m ? m[1] + (m[2] ?? "").padEnd(6, "0") : null;
}

function copyName(name: string): string {
  return name.replace(/-(wal|shm)$/, "");
}

function stampMs(stamp: string): number {
  const n = (a: number, b: number) => Number(stamp.slice(a, b));
  return Date.UTC(n(0, 4), n(4, 6) - 1, n(6, 8), n(8, 10), n(10, 12), n(12, 14));
}

/** The ids of the automatic copies beyond the newest `keep` and older than `minAgeDays`. Empty when `keep` is not positive. */
export function expiredBackupEntries(
  entries: readonly BackupEntryStat[],
  keep: number,
  now: number = Date.now(),
  minAgeDays: number = BACKUP_MIN_AGE_DAYS,
): string[] {
  if (keep <= 0) return [];
  const copies = new Map<string, { stamp: string; ids: string[] }>();
  for (const e of entries) {
    const stamp = copyStamp(e.name);
    if (stamp === null) continue;
    const key = copyName(e.name);
    const c = copies.get(key) ?? { stamp, ids: [] };
    c.ids.push(e.id);
    copies.set(key, c);
  }
  const cutoff = now - minAgeDays * 86_400_000;
  return [...copies.values()]
    .sort((a, b) => b.stamp.localeCompare(a.stamp))
    .slice(keep)
    .filter((c) => stampMs(c.stamp) <= cutoff)
    .flatMap((c) => c.ids);
}
