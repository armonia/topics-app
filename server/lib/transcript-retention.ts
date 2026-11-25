/**
 * A GENERIC EXPIRY FOR AGENT SESSION TRANSCRIPTS: the `.jsonl` files under
 * `<app data>/agents/*\/sessions/` that the CLI providers (claude-code, codex,
 * …) write for every topic's engine session (`server/lib/subagent-watch.ts`
 * polls the same files to deliver sub-agent results).
 *
 * Only those folders: the rest of `agents/` is each agent's own workspace
 * (media, state, fixtures, browser profiles), user data this module never
 * touches. On 2026-11-22 the live `agents/` folder measured 26.89 GB, and on
 * 2026-11-25 28.95 GB with no `sessions` folder in it: that weight is the
 * workspaces, not transcripts. These files are not the canonical record of a
 * conversation — the message is already stored in `topics.db` by the server
 * itself — they are
 * the CLI's OWN resumption log, replayed only to detect a sub-agent's
 * completion event. Deleting them loses nothing a user can see in the app, so
 * pruning this folder is a different case from `media/` (this card is
 * scoped to never delete REFERENCED user data; see
 * `media-retention.ts` for why that one stays opt-in).
 *
 * Even so, this module never deletes: a `.jsonl` older than the configured
 * cutoff is GZIPPED IN PLACE instead. Nothing is lost — the compressed file
 * holds the same bytes, byte-for-byte recoverable — and JSONL (repeated keys,
 * long repeated whitespace) commonly compresses 5-10x. The impure half
 * that walks the real folders and does the gzip+unlink is
 * `scripts/disk-budget-check.ts`; this module stays pure so a test drives it
 * with a plain list instead of real files.
 */

export interface TranscriptFileStat {
  /** Opaque to this module: a path, a name, whatever the caller wants back. */
  id: string;
  mtimeMs: number;
  /** Already a `.jsonl.gz` (or any already-compressed form) — never recompressed. */
  compressed: boolean;
}

const DEFAULT_COMPRESS_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `TOPICS_TRANSCRIPT_COMPRESS_DAYS`, defaulting to 7. A non-numeric or
 * non-positive value falls back to the default, same rule as
 * `log-retention.ts`: a malformed variable must not silently turn into
 * "never compress".
 */
export function transcriptCompressDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.TOPICS_TRANSCRIPT_COMPRESS_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COMPRESS_DAYS;
}

/** The ids of the not-yet-compressed files whose `mtimeMs` is older than `compressDays` before `now`. */
export function filesToCompress(
  files: readonly TranscriptFileStat[],
  now: number,
  compressDays: number,
): string[] {
  const cutoff = now - compressDays * DAY_MS;
  return files.filter((f) => !f.compressed && f.mtimeMs < cutoff).map((f) => f.id);
}

/**
 * Reads a transcript `.jsonl` that may already have been compressed by this
 * module: tries the plain path first, then `<path>.gz` gunzipped. Two readers
 * depend on this (`server/utils.ts` legacy search, `server/routes/history.ts`
 * last-resort migration) — without it, a transcript compressed after this
 * module's cutoff would silently look deleted to both, losing search hits and
 * a one-time migration that never gets a second chance.
 */
export function readTranscriptJsonl(
  path: string,
  deps: { existsSync: (p: string) => boolean; readFileSync: (p: string) => Buffer; gunzipSync: (b: Buffer) => Buffer },
): string | null {
  if (deps.existsSync(path)) return deps.readFileSync(path).toString("utf-8");
  const gzPath = `${path}.gz`;
  if (deps.existsSync(gzPath)) return deps.gunzipSync(deps.readFileSync(gzPath)).toString("utf-8");
  return null;
}
