/**
 * external-sessions.ts — the live census of Claude sessions Topics didn't start.
 *
 * Thin stateful wrapper around `lib/external-claude-sessions` (the pure scan):
 *  - a TTL cache, so the census route and dispatcher guard share one scan
 *    instead of re-walking ~/.claude/projects on every read;
 *  - `activeAt(path)`, the predicate the dispatcher guard asks before sending
 *    an agent into a directory.
 *
 * Everything is best-effort: a failed scan keeps the previous census rather
 * than blanking the board or (worse) telling the dispatcher "nobody's there".
 */
import { isAbsolute } from "node:path";
import { isInsideDir } from "../lib/path-containment";
import { scanAllExternalSessions } from "../lib/external-sessions-registry";
import {
  scanExternalClaudeSessions,
  DEFAULT_ACTIVE_MS,
  DEFAULT_WINDOW_MS,
  type ExternalClaudeSession,
} from "../lib/external-claude-sessions";

/** Per-project rollup returned by the census route. */
export interface ExternalSessionProjectSummary {
  projectId: string;
  projectPath: string;
  /** Sessions in the window (active + idle). */
  total: number;
  /** Sessions working right now. */
  active: number;
  /** Most recent activity across the project's sessions (epoch ms). */
  lastActivityMs: number;
}

export interface ExternalSessionsService {
  /** The census, newest first (cached for `ttlMs`). */
  list(opts?: { force?: boolean }): ExternalClaudeSession[];
  /** Per-project rollup, keyed by board projectId. */
  byProject(): ExternalSessionProjectSummary[];
  /**
   * ACTIVE sessions whose cwd is at or under `path` — the dispatcher's guard.
   * Idle ones are excluded on purpose: a transcript untouched for an hour is
   * not somebody currently editing that repo, and blocking on it would strand
   * the board forever after any bare session the human forgot to close.
   */
  activeAt(path: string): ExternalClaudeSession[];
}

export interface ExternalSessionsDeps {
  /** Session ids Topics owns (the ClaudeSessionTracker roster). */
  knownSessionIds: () => Iterable<string>;
  /** Known project roots used to attribute a cwd. */
  candidatePaths: () => string[];
  /** Board id for a project path. */
  projectIdFor: (path: string) => string;
  /** Cache TTL. Default 10s — cheap enough for the guard, calm for the board. */
  ttlMs?: number;
  /** Overrides forwarded to the scan (tests). */
  projectsDir?: string;
  worktreeRoot?: string;
  windowMs?: number;
  activeMs?: number;
  now?: () => number;
  /** Test seam: replace the disk scan entirely. */
  scan?: typeof scanExternalClaudeSessions;
  log?: (msg: string, err?: unknown) => void;
}

function isUnder(cwd: string, path: string): boolean {
  return !!path && !!cwd && isInsideDir(cwd, path);
}

export function createExternalSessionsService(deps: ExternalSessionsDeps): ExternalSessionsService {
  const ttlMs = deps.ttlMs ?? 10_000;
  const now = deps.now ?? Date.now;
  // Every provider, not just Claude Code: the registry queries each one and
  // merges their sessions. This used to hold only the Claude Code scanner, and
  // jcode sessions showed up nowhere at all.
  const scan = deps.scan ?? ((opts) => scanAllExternalSessions({ ...opts, log }));
  const log = deps.log ?? ((m: string, e?: unknown) => (e ? console.error("[external-sessions] " + m, e) : undefined));

  let cache: ExternalClaudeSession[] = [];
  let cachedAt = 0;

  function list(opts?: { force?: boolean }): ExternalClaudeSession[] {
    const t = now();
    if (!opts?.force && cachedAt !== 0 && t - cachedAt < ttlMs) return cache;
    try {
      cache = scan({
        knownSessionIds: new Set(deps.knownSessionIds()),
        candidatePaths: deps.candidatePaths(),
        projectIdFor: deps.projectIdFor,
        projectsDir: deps.projectsDir,
        worktreeRoot: deps.worktreeRoot,
        windowMs: deps.windowMs ?? DEFAULT_WINDOW_MS,
        activeMs: deps.activeMs ?? DEFAULT_ACTIVE_MS,
        nowMs: t,
      });
      cachedAt = t;
    } catch (err) {
      // Keep the previous census: a transient fs error must never be read as
      // "the repo is free" by the dispatcher guard.
      log("scan failed, keeping previous census", err);
    }
    return cache;
  }

  function byProject(): ExternalSessionProjectSummary[] {
    const acc = new Map<string, ExternalSessionProjectSummary>();
    for (const s of list()) {
      if (!s.projectId || !s.projectPath) continue;
      const cur = acc.get(s.projectId);
      if (!cur) {
        acc.set(s.projectId, {
          projectId: s.projectId,
          projectPath: s.projectPath,
          total: 1,
          active: s.state === "active" ? 1 : 0,
          lastActivityMs: s.lastActivityMs,
        });
        continue;
      }
      cur.total += 1;
      if (s.state === "active") cur.active += 1;
      if (s.lastActivityMs > cur.lastActivityMs) cur.lastActivityMs = s.lastActivityMs;
    }
    return [...acc.values()].sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  }

  function activeAt(path: string): ExternalClaudeSession[] {
    if (typeof path !== "string" || !isAbsolute(path)) return [];
    return list().filter((s) => s.state === "active" && isUnder(s.cwd, path));
  }

  return {
    list,
    byProject,
    activeAt,
  };
}
