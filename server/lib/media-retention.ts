/**
 * A GENERIC, OPT-IN EXPIRY FOR `media/`: screenshots, browser downloads and
 * clips attached to chat messages and task previews.
 *
 * WHY OPT-IN AND NOT ON BY DEFAULT, unlike `log-retention.ts` and
 * `transcript-retention.ts`. A file under `media/` is routinely REFERENCED
 * from a live row — a message's `MEDIA:<path>` line, a task's
 * `preview_image` — and this check (`scripts/disk-budget-check.ts`)
 * deliberately never opens the live database (this card is scoped to never
 * touch it), so it has no way to tell a still-referenced file from
 * an orphaned one. Deleting an unverified file here risks exactly what the
 * card rules out: user data gone with no copy. So the default keeps every
 * file, and deletion only runs once an operator sets
 * `TOPICS_MEDIA_RETENTION_DAYS` themselves, after they have their own answer
 * for "is anything still pointing at this".
 */

export interface MediaFileStat {
  /** Opaque to this module: a path, a name, whatever the caller wants back. */
  id: string;
  mtimeMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `TOPICS_MEDIA_RETENTION_DAYS`, defaulting to 0 — disabled. Any non-positive or unset value keeps everything. */
export function mediaRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.TOPICS_MEDIA_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** The ids of the files whose `mtimeMs` is older than `retentionDays`. Always empty when `retentionDays` is 0 (disabled). */
export function expiredMediaFiles(
  files: readonly MediaFileStat[],
  now: number,
  retentionDays: number,
): string[] {
  if (retentionDays <= 0) return [];
  const cutoff = now - retentionDays * DAY_MS;
  return files.filter((f) => f.mtimeMs < cutoff).map((f) => f.id);
}
