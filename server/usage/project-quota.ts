/**
 * WHAT A PROJECT HAS SPENT of the weekly Claude quota (limiti-consumo-progetto).
 *
 * Born from a measured miss: on 2026-11-17 an account rose from 0 to 90% of
 * the week in nine hours and nobody noticed, because `project-usage.ts`
 * (the existing per-project dashboard) only sums `messages`/`tasks`/
 * `usage_records` tokens and never looks at the native engine's 80% share of
 * the real spend, nor at Claude Code transcripts running outside Topics
 * entirely. This module answers a narrower, truer question: not "how many
 * tokens", but "how many points of the weekly quota", the same unit
 * `person-usage.ts` already reports per PERSON — reusing its four primitives
 * (`pointsPerHour`, `splitPoints`, `weighTokens`, `readTranscriptCalls`)
 * rather than writing a second copy of any of them.
 *
 * A call belongs to the PROJECT OF ITS FOLDER, not to whoever is chatting:
 *  - a native chat or native subagent: the folder is `topics.project_path` /
 *    `subagents.cwd`;
 *  - a Claude Code subagent Topics knows of: `subagents.cwd`, read through
 *    its transcript;
 *  - a Claude Code session opened OUTSIDE Topics (a terminal, another tool):
 *    its own transcript under `~/.claude/projects`, carrying its `cwd` on
 *    every line — scanned by FILE MTIME inside the window, skipping every
 *    session id the subagents table already accounts for, so nothing is
 *    counted twice;
 *  - a `usage_records` row: its own `project_path` column.
 *
 * A folder FOLDS onto its project: a worktree's `abs_path` resolves to its
 * project's `path` (`projects`/`worktrees` tables, exact match first, then the
 * longest `projects.path` prefix that contains it) before the id is computed,
 * so a card dispatched into `~/.topics/worktrees/topics-app/x` counts for
 * `topics-app`, never as a project of its own. A folder matching neither table
 * is still a project — `projectIdForPath` of the folder itself, exactly what
 * `project-usage.ts` and `tasks.project_id` already do — it just is not a
 * registered `projects` entity. "Outside projects" (`projectId: null`) is
 * reserved for calls with NO folder at all.
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectIdForPath } from "../../shared/board";
import { HOUR_MS, pointsPerHour, splitPoints, weighTokens, readTranscriptCalls, readHistory, usageHistoryFile, type TokenUsage } from "./person-usage";
import type { ProjectQuotaResult, ProjectQuotaRow } from "../../shared/usage-shapes";

/**
 * `strict`: a folder found by scanning `~/.claude/projects` (a session Topics
 * never opened itself) can be ANY directory on disk — a scratch folder, a
 * home directory, a sibling repo poked at once. It only counts as a project
 * when the `projects`/`worktrees` tables actually recognise it; otherwise it
 * is "outside projects", never a project invented from a random path.
 * A folder Topics itself recorded (`topics.project_path`, `subagents.cwd`,
 * `usage_records.project_path`) IS a project by construction — exactly what
 * `project-usage.ts` already assumes — so an unregistered one still becomes
 * its own project, keyed on its own path.
 */
interface ProjectCall { ts: number; weight: number; folder: string | null; strict?: boolean; points?: number }

interface FolderResolution { path: string; matched: boolean }

/** Longest-prefix folder → project path resolver, built once per call from `projects`/`worktrees`. */
export function buildFolderResolver(db: Database): (folder: string) => FolderResolution {
  const prefixes = db.query(
    `SELECT w.abs_path path, p.path project_path FROM worktrees w JOIN projects p ON p.id = w.project_id
     UNION ALL
     SELECT p.path path, p.path project_path FROM projects p`,
  ).all() as Array<{ path: string; project_path: string }>;
  // Longest path first so a worktree nested under another match never loses to a shorter one.
  prefixes.sort((a, b) => b.path.length - a.path.length);
  return (folder: string): FolderResolution => {
    const norm = folder.replace(/[\\/]+$/, "");
    for (const p of prefixes) {
      const pp = p.path.replace(/[\\/]+$/, "");
      if (norm === pp || norm.startsWith(pp + "/") || norm.startsWith(pp + "\\")) return { path: p.project_path, matched: true };
    }
    return { path: folder, matched: false };
  };
}

/** `null` folder (no cwd at all) stays "outside projects"; a `strict` call also needs a REGISTERED match. */
function idOf(resolve: (folder: string) => FolderResolution, folder: string | null, strict: boolean): string | null {
  if (!folder) return null;
  const r = resolve(folder);
  if (strict && !r.matched) return null;
  return projectIdForPath(r.path);
}

/**
 * The project id a `cwd` folds onto, the same resolution `projectQuota` itself
 * uses (a worktree counts for its project). For a gate that only has a
 * folder and nothing else (`spawn_agent`): never `strict`, a `cwd` Topics
 * itself hands a sub-agent IS a project by construction, registered or not.
 */
export function projectIdOfFolder(db: Database, folder: string): string {
  return projectIdForPath(buildFolderResolver(db)(folder).path);
}

export interface CollectProjectCallsOptions {
  sinceMs: number;
  untilMs: number;
  /** Injected for tests: reads a Claude Code transcript's calls from a cwd + session id. */
  readTranscript?: typeof readTranscriptCalls;
  /** Injected for tests: every file under `~/.claude/projects`, `{path, mtimeMs}`. */
  listOutsideTranscripts?: () => Array<{ path: string; mtimeMs: number }>;
}

/** Every call in the window, each tagged with the folder it ran in (or `null`). */
export function collectProjectCalls(db: Database, o: CollectProjectCallsOptions): ProjectCall[] {
  const iso = (ms: number) => new Date(ms).toISOString();
  const readTranscript = o.readTranscript ?? readTranscriptCalls;
  const calls: ProjectCall[] = [];

  // Native engine: native chats and native subagents, by their own folder.
  const msgs = db.query(
    `SELECT m.timestamp ts, COALESCE(m.usage_prompt_tokens,0) p, COALESCE(m.usage_completion_tokens,0) o,
        COALESCE(m.cache_read_tokens,0) cr, COALESCE(m.cache_creation_tokens,0) cw,
        COALESCE(s.cwd, t.project_path) folder
     FROM messages m
     LEFT JOIN topics t ON t.session_key = m.session_key AND t.provider = 'topics'
     LEFT JOIN subagents s ON s.session_key = m.session_key AND s.runtime = 'topics'
     WHERE m.role = 'assistant' AND m.timestamp > ? AND m.timestamp <= ?
       AND (m.usage_prompt_tokens > 0 OR m.usage_completion_tokens > 0)
       AND (t.id IS NOT NULL OR s.id IS NOT NULL)`,
  ).all(iso(o.sinceMs), iso(o.untilMs)) as Array<{ ts: string; p: number; o: number; cr: number; cw: number; folder: string | null }>;
  for (const m of msgs) {
    const ts = Date.parse(m.ts);
    if (!Number.isFinite(ts)) continue;
    const weight = weighTokens({ input: Math.max(0, m.p - m.cr - m.cw), output: m.o, cacheWrite: m.cw, cacheRead: m.cr });
    calls.push({ ts, weight, folder: m.folder || null });
  }

  // Claude Code subagents Topics knows of: their transcript, folder = their own cwd.
  const subs = db.query("SELECT session_key sk, claude_session_id csid, cwd, runtime, created_at FROM subagents")
    .all() as Array<{ sk: string | null; csid: string | null; cwd: string; runtime: string | null; created_at: string }>;
  const knownClaudeCodeSessions = new Set<string>();
  for (const s of subs) {
    if (s.runtime === "topics" || !s.csid) continue;
    knownClaudeCodeSessions.add(s.csid);
    const born = Date.parse(s.created_at);
    if (!Number.isFinite(born) || born > o.untilMs || born < o.sinceMs - 7 * 24 * HOUR_MS) continue;
    for (const c of readTranscript(s.cwd, s.csid)) {
      if (c.ts <= o.sinceMs || c.ts > o.untilMs) continue;
      calls.push({ ts: c.ts, weight: weighTokens(c.usage), folder: s.cwd || null });
    }
  }

  // Claude Code sessions opened OUTSIDE Topics entirely: scan every transcript
  // file touched in the window, skip the ones already counted above.
  const list = o.listOutsideTranscripts ?? listOutsideTranscripts;
  for (const file of list()) {
    if (file.mtimeMs < o.sinceMs - 7 * 24 * HOUR_MS || file.mtimeMs > o.untilMs + HOUR_MS) continue;
    const sessionId = file.path.slice(file.path.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
    if (knownClaudeCodeSessions.has(sessionId)) continue;
    for (const c of readOutsideTranscript(file.path)) {
      if (c.ts <= o.sinceMs || c.ts > o.untilMs) continue;
      calls.push({ ts: c.ts, weight: weighTokens(c.usage), folder: c.cwd, strict: true });
    }
  }

  // usage_records: already carries its own project_path (20261118100000-usage-project-path.sql).
  const records = db.query(
    `SELECT u.timestamp ts, COALESCE(u.input_tokens,0) i, COALESCE(u.output_tokens,0) o,
        COALESCE(u.cache_read_tokens,0) cr, COALESCE(u.cache_creation_tokens,0) cw,
        COALESCE(NULLIF(u.project_path, ''), tp.project_path) folder
     FROM usage_records u
     LEFT JOIN topics tp ON tp.id = u.topic_id
     WHERE u.timestamp > ? AND u.timestamp <= ? AND u.measured = 1`,
  ).all(o.sinceMs, o.untilMs) as Array<{ ts: number; i: number; o: number; cr: number; cw: number; folder: string | null }>;
  for (const r of records) {
    const weight = weighTokens({ input: r.i, output: r.o, cacheWrite: r.cw, cacheRead: r.cr });
    calls.push({ ts: r.ts, weight, folder: r.folder || null });
  }

  return calls;
}

/** Every transcript file under `~/.claude/projects` (one level of project-dir nesting). */
function listOutsideTranscripts(): Array<{ path: string; mtimeMs: number }> {
  const root = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try { dirs = readdirSync(root); } catch { return []; }
  const out: Array<{ path: string; mtimeMs: number }> = [];
  for (const dir of dirs) {
    let files: string[];
    try { files = readdirSync(join(root, dir)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(root, dir, f);
      try { out.push({ path, mtimeMs: statSync(path).mtimeMs }); } catch { /* raced with a delete */ }
    }
  }
  return out;
}

/** One transcript's calls, with the `cwd` each line itself carries (a session's folder can move; the line is ground truth). */
function readOutsideTranscript(path: string): Array<{ ts: number; usage: TokenUsage; cwd: string | null }> {
  if (!existsSync(path)) return [];
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return []; }
  const seen = new Set<string>();
  const out: Array<{ ts: number; usage: TokenUsage; cwd: string | null }> = [];
  for (const line of raw.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let o: { type?: string; uuid?: string; timestamp?: string; cwd?: string; message?: { id?: string; usage?: Record<string, number | undefined> } };
    try { o = JSON.parse(line); } catch { continue; }
    const u = o?.message?.usage;
    if (o?.type !== "assistant" || !u) continue;
    const id = o.message?.id ?? o.uuid;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const ts = Date.parse(o.timestamp ?? "");
    if (!Number.isFinite(ts)) continue;
    out.push({
      ts, cwd: o.cwd || null,
      usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 },
    });
  }
  return out;
}

export interface ProjectQuotaOptions {
  now?: number;
  historyFile?: string;
  readTranscript?: typeof readTranscriptCalls;
  listOutsideTranscripts?: () => Array<{ path: string; mtimeMs: number }>;
}

/** Points in the last 24h and last 7d, per project, from the quota history's hourly rise split by call weight. */
export function projectQuota(db: Database, o: ProjectQuotaOptions = {}): ProjectQuotaResult {
  const untilMs = o.now ?? Date.now();
  const sinceMs = untilMs - 7 * 24 * HOUR_MS;
  const since24hMs = untilMs - 24 * HOUR_MS;
  const resolve = buildFolderResolver(db);
  const calls = collectProjectCalls(db, { sinceMs, untilMs, readTranscript: o.readTranscript, listOutsideTranscripts: o.listOutsideTranscripts });
  const history = readHistory(o.historyFile ?? usageHistoryFile());
  const quotaHistory = !!history;
  if (history) splitPoints(calls, pointsPerHour(history, sinceMs, untilMs));

  const byId = new Map<string, { projectPath: string | null; w24: number; w7: number; p24: number; p7: number }>();
  for (const c of calls) {
    const id = idOf(resolve, c.folder, !!c.strict);
    const key = id ?? "\u0000outside";
    // The row's path is the PROJECT's own path (a worktree folds onto it), never the raw folder a call happened to run in.
    const path = c.folder ? resolve(c.folder).path : null;
    const e = byId.get(key) ?? { projectPath: id === null ? null : path, w24: 0, w7: 0, p24: 0, p7: 0 };
    e.w7 += c.weight; e.p7 += c.points ?? 0;
    if (c.ts > since24hMs) { e.w24 += c.weight; e.p24 += c.points ?? 0; }
    byId.set(key, e);
  }

  const rows: ProjectQuotaRow[] = [...byId].map(([key, e]) => ({
    projectId: key === "\u0000outside" ? null : key,
    projectPath: e.projectPath,
    points24h: quotaHistory ? round1(e.p24) : null,
    points7d: quotaHistory ? round1(e.p7) : null,
    weighted24h: Math.round(e.w24),
    weighted7d: Math.round(e.w7),
  })).sort((a, b) => (b.points7d ?? b.weighted7d) - (a.points7d ?? a.weighted7d));

  return { quotaHistory, projects: rows };
}

export interface ProjectPointsWindowRow { projectId: string | null; projectPath: string | null; points: number | null; weighted: number }

/**
 * Every project's points across one ARBITRARY window — `[sinceMs, untilMs]`
 * as a single bucket, not the live dashboard's fixed "last 24h / last 7d"
 * split. For replaying a specific past incident (`scripts/project-quota-check.ts`),
 * where `projectQuota`'s own windows, anchored to "now", cannot express it.
 */
export function projectPointsInWindow(db: Database, sinceMs: number, untilMs: number, o: Omit<ProjectQuotaOptions, "now"> = {}): { quotaHistory: boolean; projects: ProjectPointsWindowRow[] } {
  const resolve = buildFolderResolver(db);
  const calls = collectProjectCalls(db, { sinceMs, untilMs, readTranscript: o.readTranscript, listOutsideTranscripts: o.listOutsideTranscripts });
  const history = readHistory(o.historyFile ?? usageHistoryFile());
  const quotaHistory = !!history;
  if (history) splitPoints(calls, pointsPerHour(history, sinceMs, untilMs));

  const byId = new Map<string, { projectPath: string | null; w: number; p: number }>();
  for (const c of calls) {
    const id = idOf(resolve, c.folder, !!c.strict);
    const key = id ?? "\u0000outside";
    const path = c.folder ? resolve(c.folder).path : null;
    const e = byId.get(key) ?? { projectPath: id === null ? null : path, w: 0, p: 0 };
    e.w += c.weight; e.p += c.points ?? 0;
    byId.set(key, e);
  }
  const rows: ProjectPointsWindowRow[] = [...byId].map(([key, e]) => ({
    projectId: key === "\u0000outside" ? null : key,
    projectPath: e.projectPath,
    points: quotaHistory ? round1(e.p) : null,
    weighted: Math.round(e.w),
  })).sort((a, b) => (b.points ?? b.weighted) - (a.points ?? a.weighted));
  return { quotaHistory, projects: rows };
}

function round1(x: number): number { return Math.round(x * 10) / 10; }
