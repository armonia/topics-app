/**
 * A GENERIC EXPIRY FOR LOG FILES, because today none exists: `logsDir()`
 * (`server/services/daemon-state.ts`) is created at every boot and nothing
 * ever prunes what lands in it, and the launchd jobs under
 * `scripts/launchd/` append to their own `StandardOutPath` log forever. Either
 * one grows without a ceiling, the same failure `disk-budget.ts` measures for
 * the data folder as a whole.
 *
 * Pure on its inputs: given a list of files with their modification time, it
 * only says which are older than the configured cutoff. Nothing here touches
 * the filesystem — `scripts/disk-budget-check.ts` does the real listing and
 * the real deleting.
 */

export interface LogFileStat {
  /** Opaque to this module: a path, a name, whatever the caller wants back. */
  id: string;
  mtimeMs: number;
}

const DEFAULT_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `TOPICS_LOG_RETENTION_DAYS`, defaulting to 14. A non-numeric or non-positive
 * value falls back to the default rather than disabling the expiry — an empty
 * or malformed variable should not quietly turn into "keep forever".
 */
export function logRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.TOPICS_LOG_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
}

/** The ids of the files whose `mtimeMs` is older than `retentionDays` before `now`. */
export function expiredLogFiles(
  files: readonly LogFileStat[],
  now: number,
  retentionDays: number,
): string[] {
  const cutoff = now - retentionDays * DAY_MS;
  return files.filter((f) => f.mtimeMs < cutoff).map((f) => f.id);
}
