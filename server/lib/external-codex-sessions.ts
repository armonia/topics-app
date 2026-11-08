/**
 * The **Codex** sessions (the CLI inside ChatGPT.app), for the shared census.
 *
 * WHY A THIRD SCANNER
 * The provider registry was born on 08/23 to let jcode in. Codex was the test
 * case for that promise: measured on a real machine, three sessions touched in
 * the last 8 hours that no surface was counting. If adding a provider had not
 * been cheap, the registry would have been good for nothing.
 *
 * WHERE CODEX RESEMBLES CLAUDE CODE, AND WHERE IT DOES NOT
 * It resembles it in the writing: one JSON event per line, appended. Verified
 * before trusting it, because that is exactly the assumption jcode had
 * disproved: on every recent session the gap between the file's mtime and the
 * timestamp of the last event is 0.0s. So here the mtime **tells the truth**
 * and freshness is read from there, without chasing processes.
 *
 * It does not resemble it on two points that change the code:
 *
 *  1. **The files live in a tree by date** (`sessions/YYYY/MM/DD/`), not in a
 *     flat folder per project. We descend recursively and filter on the FILE's
 *     mtime: the folder's date, both as mtime and as name, does not say when
 *     that session last spoke. The detail is on `collectFiles`, because both
 *     prunings look obvious and were measured wrong.
 *
 *  2. **The cwd is at the head, the activity at the tail.** The `session_meta`
 *     is the file's first line and never repeats; reading only the tail — the
 *     way it is done with Claude Code — leaves every session without a
 *     project. We read a chunk of head to know WHERE it works and a chunk of
 *     tail to know WHETHER it works.
 *
 * WHEN A SESSION IS «AT WORK»
 * Codex marks the end of a turn with a `task_complete` event. A session whose
 * last event is that one has finished, however recent it may be: it stays
 * `idle` even if the file was written a second ago. Without this reading,
 * closing a turn and sitting still would count as «at work» for a quarter of
 * an hour — the opposite defect to jcode's, and just as much of a lie.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExternalClaudeSession } from "./external-claude-sessions";
import {
  DEFAULT_ACTIVE_MS,
  DEFAULT_WINDOW_MS,
  resolveOwningProject,
} from "./external-claude-sessions";

/**
 * The head: it must contain the whole `session_meta`, which is the first line.
 *
 * It is not a short line: it carries the session's base instructions with it
 * and measures ~19KB on disk. With a 16KB head the JSON arrived truncated, did
 * not parse, and EVERY Codex session vanished from the census without an
 * error: 64KB to stay roomy.
 */
const HEAD_BYTES = 64 * 1024;
/** The tail: enough to hold the last turn events. */
const TAIL_BYTES = 16 * 1024;

export interface ScanCodexOptions {
  /** Where Codex keeps the sessions. Injectable for the tests. */
  sessionsDir?: string;
  now?: number;
  /** Past this age a session is `idle`. */
  activeMs?: number;
  /** Past this age the session does not show up at all. */
  windowMs?: number;
  /** The sessions Topics already owns stay out. */
  knownSessionIds?: ReadonlySet<string>;
  /** Known project roots, to attribute the cwd. */
  candidatePaths?: string[];
  projectIdFor?: (path: string) => string;
  /** How many sessions at most, from the most recent one. */
  limit?: number;
  /** Test seam. */
  fs?: CodexFs;
}

export interface CodexFs {
  /** The names inside a directory, with the «is a directory» flag. */
  readdir: (dir: string) => Array<{ name: string; isDir: boolean }>;
  stat: (path: string) => { mtimeMs: number; size: number } | null;
  read: (path: string, bytes: number, from: "head" | "tail") => string;
}

const realFs: CodexFs = {
  readdir(dir) {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDir: e.isDirectory(),
      }));
    } catch {
      return [];
    }
  },
  stat(path) {
    try {
      const st = statSync(path);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  },
  read(path, bytes, from) {
    let fd: number | null = null;
    try {
      const st = statSync(path);
      const length = Math.min(bytes, st.size);
      if (length <= 0) return "";
      const buffer = Buffer.alloc(length);
      fd = openSync(path, "r");
      readSync(fd, buffer, 0, length, from === "head" ? 0 : st.size - length);
      return buffer.toString("utf-8");
    } catch {
      return "";
    } finally {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  },
};

/**
 * The transcript files under `dir`, wherever they are in the tree by date.
 *
 * We do NOT prune by the folder's date, neither by mtime nor by name, and
 * those are two lessons already paid for:
 *  - a directory's mtime does not move when a file inside it is rewritten, so
 *    the folder of a file touched 134 minutes ago looked 1900 minutes old;
 *  - the name lies in a different way: a session OPENED on the 21st and
 *    written today stays filed under `2026/08/21`. Measured: sessions written
 *    4 hours ago in folders from two days earlier.
 * We look at every file and filter on the file's mtime, which is the only
 * honest datum. Measured cost: ~11ms for 840 files, below the threshold of
 * anything that happens once a minute.
 */
function collectFiles(
  fs: CodexFs,
  dir: string,
  now: number,
  windowMs: number,
  depth: number,
  out: Array<{ path: string; mtimeMs: number }>,
): void {
  if (depth > 4) return;
  for (const entry of fs.readdir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDir) {
      collectFiles(fs, path, now, windowMs, depth + 1, out);
      continue;
    }
    if (!entry.name.endsWith(".jsonl")) continue;
    const st = fs.stat(path);
    if (!st || st.size <= 0) continue;
    if (now - st.mtimeMs > windowMs) continue;
    out.push({ path, mtimeMs: st.mtimeMs });
  }
}

/**
 * One rollout line, in the shape we need to read it.
 *
 * It is not Codex's schema: it is the subset this scanner looks at. Declaring
 * it instead of using `any` costs four lines and in exchange the compiler
 * catches whoever writes `payload.cwdd`.
 */
interface CodexLine {
  type?: string;
  payload?: {
    session_id?: unknown;
    id?: unknown;
    cwd?: unknown;
    originator?: unknown;
    type?: unknown;
  };
}

/** The first `session_meta` found in the file's head. */
function parseHead(text: string): { sessionId: string | null; cwd: string | null; originator: string | null } {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o: CodexLine | undefined;
    try {
      o = JSON.parse(t) as CodexLine;
    } catch {
      // The head truncates the last line: normal, we carry on.
      continue;
    }
    if (o?.type !== "session_meta") continue;
    const p = o.payload ?? {};
    return {
      sessionId: typeof p.session_id === "string" ? p.session_id : typeof p.id === "string" ? p.id : null,
      cwd: typeof p.cwd === "string" ? p.cwd : null,
      originator: typeof p.originator === "string" ? p.originator : null,
    };
  }
  return { sessionId: null, cwd: null, originator: null };
}

/**
 * Is the last turn over?
 *
 * We look at the last `event_msg` present in the tail: if it is
 * `task_complete`, Codex has finished answering. The lines that follow
 * (`response_item`, `world_state`) do not change the verdict.
 */
function tailSaysFinished(text: string): boolean {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (!t.startsWith("{")) continue;
    let o: CodexLine | undefined;
    try {
      o = JSON.parse(t) as CodexLine;
    } catch {
      continue;
    }
    if (o?.type !== "event_msg") continue;
    return o?.payload?.type === "task_complete";
  }
  return false;
}

/** The most recent cwd: `turn_context` restates it on every turn. */
function tailCwd(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (!t.startsWith("{")) continue;
    let o: CodexLine | undefined;
    try {
      o = JSON.parse(t) as CodexLine;
    } catch {
      continue;
    }
    if (o?.type === "turn_context" && typeof o?.payload?.cwd === "string") return o.payload.cwd;
  }
  return null;
}

export function scanCodexSessions(opts: ScanCodexOptions = {}): ExternalClaudeSession[] {
  const dir = opts.sessionsDir ?? join(homedir(), ".codex", "sessions");
  const now = opts.now ?? Date.now();
  const activeMs = opts.activeMs ?? DEFAULT_ACTIVE_MS;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const fs = opts.fs ?? realFs;
  const limit = opts.limit ?? 200;
  const known = opts.knownSessionIds ?? new Set<string>();
  const candidates = opts.candidatePaths ?? [];
  const projectIdFor = opts.projectIdFor ?? (() => "");

  const files: Array<{ path: string; mtimeMs: number }> = [];
  collectFiles(fs, dir, now, windowMs, 0, files);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const out: ExternalClaudeSession[] = [];
  for (const f of files.slice(0, limit)) {
    const head = parseHead(fs.read(f.path, HEAD_BYTES, "head"));
    // Without an id the session is not addressable: no invented rows.
    if (!head.sessionId) continue;
    if (known.has(head.sessionId)) continue;

    const tail = fs.read(f.path, TAIL_BYTES, "tail");
    const cwd = tailCwd(tail) ?? head.cwd ?? "";
    const projectPath = cwd ? resolveOwningProject(cwd, candidates) : null;

    const fresh = now - f.mtimeMs <= activeMs;
    const finished = tailSaysFinished(tail);

    out.push({
      sessionId: head.sessionId,
      cwd,
      projectPath,
      projectId: projectPath ? projectIdFor(projectPath) : null,
      branch: null,
      entrypoint: head.originator ?? "codex",
      lastActivityMs: f.mtimeMs,
      state: fresh && !finished ? "active" : "idle",
      transcriptPath: f.path,
    });
  }

  return out;
}
