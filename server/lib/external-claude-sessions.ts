/**
 * external-claude-sessions.ts — see the Claude sessions Topics did NOT start.
 *
 * Topics only knows the sessions it spawned itself (a topic's chat, a dispatched
 * agent, a terminal tab it registered). Anything the human runs by hand —
 * `claude` in iTerm on ~/Projects/dancerooms — is invisible to the app, so the
 * board shows a project with zero cards while three sessions are hammering it,
 * and the dispatcher happily sends an agent into a repo somebody is already
 * editing.
 *
 * The durable, always-present trace of EVERY session (ours or not) is its
 * transcript: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. So this
 * module reads that directory as a read-only census:
 *
 *   1. stat every `*.jsonl` — mtime IS "last activity", no parsing needed;
 *   2. for the recent ones, read the TAIL (last few KB) to recover the fields
 *      Claude Code stamps on each entry: `cwd`, `gitBranch`, `entrypoint`;
 *   3. drop everything Topics already owns (session id known to the tracker, or
 *      a cwd inside the Topics worktree root — dispatched agents live there);
 *   4. attribute what's left to a project by longest-prefix match on cwd.
 *
 * The parsing/attribution/classification is pure (and unit-tested); only
 * `scanExternalClaudeSessions` touches disk, through injectable fs hooks.
 */
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A Claude Code session running outside Topics' control. */
export interface ExternalClaudeSession {
  /** Claude Code session id (the transcript's filename). */
  sessionId: string;
  /** Working directory the session last reported. */
  cwd: string;
  /** Owning project root (longest-prefix candidate), or null when unattributed. */
  projectPath: string | null;
  /** Board id of `projectPath` (`projectIdForPath`), or null. */
  projectId: string | null;
  /** Git branch the session last reported, when known. */
  branch: string | null;
  /** `cli` = interactive terminal, `sdk-cli` = something driving the SDK. */
  entrypoint: string | null;
  /** Last activity (transcript mtime, epoch ms). */
  lastActivityMs: number;
  /** 'active' = touched within the active window; 'idle' = older but recent. */
  state: "active" | "idle";
  /** Absolute path of the transcript (debugging / drill-down). */
  transcriptPath: string;
}

/** Fields we recover from a transcript's tail. */
export interface TranscriptFacts {
  cwd: string | null;
  branch: string | null;
  entrypoint: string | null;
  /** True when the last informative entry is a sub-agent sidechain. */
  sidechain: boolean;
}

/** Default: a session touched within 15 min is working right now. */
export const DEFAULT_ACTIVE_MS = 15 * 60_000;
/** Default: don't even look at transcripts older than 8h. */
export const DEFAULT_WINDOW_MS = 8 * 60 * 60_000;
/** How much of the tail we read to recover cwd/branch/entrypoint. */
const TAIL_BYTES = 64 * 1024;

/**
 * Pure: recover cwd/branch/entrypoint from a chunk of transcript text.
 *
 * We scan from the END backwards — the LAST entry is the current truth (a
 * session can `cd`), and the tail is where the cheap read lands. Lines are
 * one JSON object each; the first fragment of a mid-file read is usually
 * truncated, so unparseable lines are simply skipped rather than fatal.
 */
export function parseTranscriptFacts(text: string): TranscriptFacts {
  const lines = text.split("\n");
  let cwd: string | null = null;
  let branch: string | null = null;
  let entrypoint: string | null = null;
  let sidechain = false;
  let sawCwd = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line || line[0] !== "{") continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== "object") continue;
    if (!sawCwd && typeof obj.cwd === "string" && obj.cwd.startsWith("/")) {
      cwd = obj.cwd;
      sawCwd = true;
      sidechain = obj.isSidechain === true;
      if (typeof obj.gitBranch === "string" && obj.gitBranch) branch = obj.gitBranch;
      if (typeof obj.entrypoint === "string" && obj.entrypoint) entrypoint = obj.entrypoint;
    }
    // cwd comes from the LAST entry (a session can `cd`); branch/entrypoint
    // aren't stamped on every entry, so keep walking back until we have both.
    if (sawCwd && branch && entrypoint) break;
    if (sawCwd) {
      if (!branch && typeof obj.gitBranch === "string" && obj.gitBranch) branch = obj.gitBranch;
      if (!entrypoint && typeof obj.entrypoint === "string" && obj.entrypoint) entrypoint = obj.entrypoint;
    }
  }
  return { cwd, branch, entrypoint, sidechain };
}

/**
 * Pure: the project a cwd belongs to — the LONGEST candidate path that is the
 * cwd itself or one of its ancestors. Longest wins so a monorepo package
 * doesn't get attributed to the repo root when both are registered.
 */
export function resolveOwningProject(cwd: string, candidatePaths: string[]): string | null {
  const target = cwd.replace(/\/+$/, "");
  let best: string | null = null;
  for (const raw of candidatePaths) {
    if (typeof raw !== "string" || !raw.startsWith("/")) continue;
    const p = raw.replace(/\/+$/, "");
    if (!p) continue;
    if (target !== p && !target.startsWith(p + "/")) continue;
    if (best === null || p.length > best.length) best = p;
  }
  return best;
}

/**
 * Pure: is this session Topics' own? Two independent signals, either is enough:
 *  - the session id is in the tracker's roster (topic chats, dispatched agents,
 *    registered terminal tabs);
 *  - the cwd sits inside the Topics worktree root — every dir under it was
 *    created BY Topics for a dispatched agent, so nothing there is "external"
 *    even if the roster lost the row (restart, reap).
 */
export function isTopicsOwnedSession(opts: {
  sessionId: string;
  cwd: string;
  knownSessionIds: ReadonlySet<string>;
  worktreeRoot: string;
}): boolean {
  if (opts.knownSessionIds.has(opts.sessionId)) return true;
  const root = opts.worktreeRoot.replace(/\/+$/, "");
  if (root && (opts.cwd === root || opts.cwd.startsWith(root + "/"))) return true;
  return false;
}

export interface ScanOptions {
  /** Root of the transcript store. Default `~/.claude/projects`. */
  projectsDir?: string;
  /** Session ids Topics already owns (tracker roster). */
  knownSessionIds: ReadonlySet<string>;
  /** Registered/known project roots, used to attribute a cwd. */
  candidatePaths: string[];
  /** Board id for a project path (injected to keep this module dependency-free). */
  projectIdFor: (path: string) => string;
  /** Root under which Topics creates agent worktrees. Default `~/.topics/worktrees`. */
  worktreeRoot?: string;
  /** Ignore transcripts older than this. Default 8h. */
  windowMs?: number;
  /** Touched more recently than this ⇒ `state: 'active'`. Default 15 min. */
  activeMs?: number;
  nowMs?: number;
  /** Test seams. */
  fs?: {
    readdir: (dir: string) => string[];
    stat: (path: string) => { mtimeMs: number; size: number } | null;
    readTail: (path: string, bytes: number) => string;
  };
}

const realFs = {
  readdir(dir: string): string[] {
    try { return readdirSync(dir); } catch { return []; }
  },
  stat(path: string): { mtimeMs: number; size: number } | null {
    try {
      const st = statSync(path);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch { return null; }
  },
  readTail(path: string, bytes: number): string {
    let fd: number | null = null;
    try {
      const st = statSync(path);
      const length = Math.min(bytes, st.size);
      if (length <= 0) return "";
      const buf = Buffer.alloc(length);
      fd = openSync(path, "r");
      readSync(fd, buf, 0, length, st.size - length);
      return buf.toString("utf-8");
    } catch {
      return "";
    } finally {
      if (fd != null) { try { closeSync(fd); } catch { /* ignore */ } }
    }
  },
};

/** Cache of parsed facts, keyed by transcript identity (path + mtime + size). */
const factsCache = new Map<string, TranscriptFacts>();
const FACTS_CACHE_MAX = 500;

/**
 * Scan the transcript store and return every session Topics does NOT own,
 * newest first. Best-effort throughout: an unreadable dir/file is skipped, a
 * transcript without a cwd is dropped (we can't attribute or guard on it).
 */
export function scanExternalClaudeSessions(opts: ScanOptions): ExternalClaudeSession[] {
  const fs = opts.fs ?? realFs;
  const projectsDir = opts.projectsDir ?? join(homedir(), ".claude", "projects");
  const worktreeRoot = opts.worktreeRoot ?? join(homedir(), ".topics", "worktrees");
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const activeMs = opts.activeMs ?? DEFAULT_ACTIVE_MS;
  const now = opts.nowMs ?? Date.now();
  const cutoff = now - windowMs;

  const out: ExternalClaudeSession[] = [];
  for (const entry of fs.readdir(projectsDir)) {
    const dir = join(projectsDir, entry);
    for (const file of fs.readdir(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const transcriptPath = join(dir, file);
      const st = fs.stat(transcriptPath);
      // mtime IS the last-activity signal: everything older than the window is
      // rejected here, before any read — that's what keeps a 100+ dir store cheap.
      if (!st || st.mtimeMs < cutoff || st.size <= 0) continue;
      const sessionId = file.slice(0, -".jsonl".length);
      if (!sessionId) continue;

      const cacheKey = `${transcriptPath}:${st.mtimeMs}:${st.size}`;
      let facts = factsCache.get(cacheKey);
      if (!facts) {
        facts = parseTranscriptFacts(fs.readTail(transcriptPath, TAIL_BYTES));
        if (factsCache.size >= FACTS_CACHE_MAX) factsCache.clear();
        factsCache.set(cacheKey, facts);
      }
      if (!facts.cwd) continue;
      // Sub-agent sidechains aren't sessions of their own — they belong to the
      // parent transcript, which we already count.
      if (facts.sidechain) continue;
      if (isTopicsOwnedSession({ sessionId, cwd: facts.cwd, knownSessionIds: opts.knownSessionIds, worktreeRoot })) continue;

      const projectPath = resolveOwningProject(facts.cwd, opts.candidatePaths);
      out.push({
        sessionId,
        cwd: facts.cwd,
        projectPath,
        projectId: projectPath ? opts.projectIdFor(projectPath) : null,
        branch: facts.branch,
        entrypoint: facts.entrypoint,
        lastActivityMs: st.mtimeMs,
        state: now - st.mtimeMs <= activeMs ? "active" : "idle",
        transcriptPath,
      });
    }
  }
  out.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return out;
}

/** Drop every cached parse (tests). */
export function clearExternalSessionCache(): void {
  factsCache.clear();
}
