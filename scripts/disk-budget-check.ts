#!/usr/bin/env bun
/**
 * MEASURES the real data folder against the real database and exits non-zero
 * when either the overall ratio or a per-folder cap is over budget — the
 * automatic half of G5 (`server/lib/disk-budget.ts` is the pure half it
 * calls into, the one the tests drive with numbers instead of a disk).
 *
 * Before measuring, it also fights the two known growers:
 *   - LOGS: any file older than `TOPICS_LOG_RETENTION_DAYS` (default 14)
 *     under `~/.topics/logs` is deleted (`server/lib/log-retention.ts`).
 *   - AGENT TRANSCRIPTS: the dominant grower on 2026-11-22 (26.89 GB) — every
 *     `.jsonl` under `<app data>/agents/*\/sessions` older than
 *     `TOPICS_TRANSCRIPT_COMPRESS_DAYS` (default 7) is gzipped IN PLACE, never
 *     deleted (`server/lib/transcript-retention.ts`).
 *   - MEDIA stays opt-in (`server/lib/media-retention.ts`): a file here can be
 *     referenced by a live message or task preview, and this script never
 *     opens the live database to check, so nothing is deleted unless an
 *     operator sets `TOPICS_MEDIA_RETENTION_DAYS` themselves.
 * So a report run daily actually fights the growth instead of only naming it.
 *
 * Usage:  bun run scripts/disk-budget-check.ts
 *         bun run scripts/disk-budget-check.ts --json
 *
 * Exit code: 0 within budget, 1 over budget.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAppDataDir, resolveDataDir, resolveStateDir, LIVE_REPO_ROOT } from "../server/lib/data-dir";
import { topicsHome } from "../server/services/daemon-state";
import { diskBudgetConfig, evaluateDiskBudget, type DiskBudgetFolder } from "../server/lib/disk-budget";
import { expiredLogFiles, logRetentionDays } from "../server/lib/log-retention";
import { filesToCompress, transcriptCompressDays, type TranscriptFileStat } from "../server/lib/transcript-retention";
import { expiredMediaFiles, mediaRetentionDays, type MediaFileStat } from "../server/lib/media-retention";

function du(path: string): number {
  try {
    const out = execFileSync("du", ["-sk", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return parseInt(out.split(/\s+/)[0] ?? "0", 10) * 1024;
  } catch {
    return 0;
  }
}

function human(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** Deletes files under `dir` whose mtime is older than the configured retention. Not recursive: a log directory is flat. */
function pruneExpiredLogs(dir: string, env: NodeJS.ProcessEnv): string[] {
  if (!existsSync(dir)) return [];
  const retentionDays = logRetentionDays(env);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files = entries.flatMap((name) => {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      return stat.isFile() ? [{ id: path, mtimeMs: stat.mtimeMs }] : [];
    } catch {
      return [];
    }
  });
  const expired = expiredLogFiles(files, Date.now(), retentionDays);
  for (const path of expired) {
    try { unlinkSync(path); } catch { /* best effort: a concurrent writer wins */ }
  }
  return expired;
}

/** Every regular file under `dir`, at any depth. Not following symlinks: `du` already counts their target where it lives. */
function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) return walkFiles(path);
      return stat.isFile() ? [path] : [];
    } catch {
      return [];
    }
  });
}

/** Gzips every `.jsonl` under `agentsRoot` older than the configured cutoff, in place: the original is removed only after its `.gz` is written. */
function compressExpiredTranscripts(agentsRoot: string, env: NodeJS.ProcessEnv): string[] {
  const files: TranscriptFileStat[] = walkFiles(agentsRoot)
    .filter((path) => path.endsWith(".jsonl") || path.endsWith(".jsonl.gz"))
    .map((path) => ({ id: path, mtimeMs: statSync(path).mtimeMs, compressed: path.endsWith(".gz") }));
  const compressDays = transcriptCompressDays(env);
  const toCompress = filesToCompress(files, Date.now(), compressDays);
  for (const path of toCompress) {
    try {
      const gz = gzipSync(readFileSync(path));
      writeFileSync(`${path}.gz`, gz);
      unlinkSync(path);
    } catch { /* best effort: a concurrent writer wins, nothing is removed without its .gz landing first */ }
  }
  return toCompress;
}

/** Opt-in only: see `server/lib/media-retention.ts`. Disabled (returns `[]`) unless `TOPICS_MEDIA_RETENTION_DAYS` is set. */
function pruneExpiredMedia(mediaDir: string, env: NodeJS.ProcessEnv): string[] {
  const retentionDays = mediaRetentionDays(env);
  if (retentionDays <= 0) return [];
  const files: MediaFileStat[] = walkFiles(mediaDir).map((path) => ({ id: path, mtimeMs: statSync(path).mtimeMs }));
  const expired = expiredMediaFiles(files, Date.now(), retentionDays);
  for (const path of expired) {
    try { unlinkSync(path); } catch { /* best effort: a concurrent writer wins */ }
  }
  return expired;
}

const stateDir = resolveStateDir(LIVE_REPO_ROOT);
const dataDir = resolveDataDir(stateDir);
const appDataDir = resolveAppDataDir();
const home = topicsHome();

const dbBytes = ["topics.db", "topics.db-wal", "topics.db-shm"]
  .map((name) => join(dataDir, name))
  .filter(existsSync)
  .reduce((sum, p) => sum + du(p), 0);

// With no database the ratio is 0 and any weight beside it reads "within
// budget": that happens when run from a worktree, whose dataDir does not exist.
// Stop and say where it looked instead.
if (dbBytes === 0) {
  console.error(`disk-budget: no live database in ${dataDir}; run it from the live checkout or set DATA_DIR`);
  process.exit(2);
}

const prunedLogs = pruneExpiredLogs(join(home, "logs"), process.env);
const compressedTranscripts = compressExpiredTranscripts(join(appDataDir, "agents"), process.env);
const prunedMedia = pruneExpiredMedia(join(homedir(), ".topics", "media"), process.env);

/** Folders outside the database that the data folder actually grows with. */
const CANDIDATE_FOLDERS: [string, string][] = [
  ["agents", join(appDataDir, "agents")],
  ["workspace", join(appDataDir, "workspace")],
  ["chromium-sidecar", join(appDataDir, "chromium-sidecar")],
  ["logs", join(home, "logs")],
  ["media", join(homedir(), ".topics", "media")],
  ["backups", join(homedir(), ".topics", "backups")],
  ["db-backups", join(homedir(), ".topics", "db-backups")],
  ["ui-state-backups", join(homedir(), ".topics", "ui-state-backups")],
];

const folders: DiskBudgetFolder[] = CANDIDATE_FOLDERS
  .filter(([, path]) => existsSync(path))
  .map(([name, path]) => ({ name, bytes: du(path) }));

const config = diskBudgetConfig(process.env, folders.map((f) => f.name));
const result = evaluateDiskBudget(dbBytes, folders, config);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ...result, prunedLogs, compressedTranscripts, prunedMedia }));
} else {
  console.log(`database           ${human(result.dbBytes)}`);
  console.log(`outside database   ${human(result.outsideBytes)}  (ratio ${result.ratio.toFixed(2)}x, cap ${result.ratioCap}x)${result.ratioOverCap ? "  OVER BUDGET" : ""}`);
  for (const f of result.folders) {
    const cap = f.capBytes !== null ? `, cap ${human(f.capBytes)}` : "";
    console.log(`  ${f.name.padEnd(18)} ${human(f.bytes).padStart(9)}${cap}${f.overCap ? "  OVER CAP" : ""}`);
  }
  if (prunedLogs.length > 0) {
    console.log(`\npruned ${prunedLogs.length} log file(s) older than ${logRetentionDays(process.env)} days`);
  }
  if (compressedTranscripts.length > 0) {
    console.log(`compressed ${compressedTranscripts.length} agent transcript(s) older than ${transcriptCompressDays(process.env)} days`);
  }
  if (prunedMedia.length > 0) {
    console.log(`pruned ${prunedMedia.length} media file(s) older than ${mediaRetentionDays(process.env)} days (opt-in, TOPICS_MEDIA_RETENTION_DAYS set)`);
  }
  console.log(result.ok ? "\nwithin budget" : "\nOVER BUDGET");
}

process.exit(result.ok ? 0 : 1);
