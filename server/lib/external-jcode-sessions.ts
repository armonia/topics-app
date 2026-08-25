/**
 * The census of the **jcode** sessions, in the same shape as the Claude Code
 * ones.
 *
 * WHY A SECOND SCANNER AND NOT A BRANCH INSIDE THE FIRST
 * `external-claude-sessions.ts` walks `~/.claude/projects/<encoded-cwd>/
 * <id>.jsonl` and infers freshness from the last line written: a stream of
 * events, where «alive» means «somebody wrote to it just now». jcode keeps ONE
 * JSON file per session in `~/.jcode/sessions/`, rewritten at the end of a turn.
 *
 * The difference is not cosmetic: on the mtime, jcode always looks idle.
 * Measured on 08/23 — 1375 sessions on disk, ZERO with an mtime in the last 15
 * minutes, while seven processes were alive and one was grinding away. A
 * scanner that asked jcode the same question that works for Claude Code would
 * answer «nobody at work» every time.
 *
 * Here freshness is read where jcode really writes it: `status` and
 * `last_pid`. A pid that answers is a live session, and there is nothing to
 * guess.
 *
 * ADDING A THIRD PROVIDER
 * It takes a function that returns `ExternalClaudeSession[]`, and it has to be
 * added to the list in `scanAllExternalSessions`. That is the contract, not
 * this file: whoever comes next need not read how jcode works.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExternalClaudeSession } from "./external-claude-sessions";
import {
  DEFAULT_ACTIVE_MS,
  DEFAULT_WINDOW_MS,
  resolveOwningProject,
} from "./external-claude-sessions";

export interface ScanJcodeOptions {
  /** Where jcode keeps the sessions. Injectable for the tests. */
  sessionsDir?: string;
  /** Now, in epoch ms. Injectable for the tests. */
  now?: number;
  /** Past this age a session is `idle` even if the process is alive. */
  activeMs?: number;
  /**
   * Past this age the session does not show up at all.
   *
   * Without it, the census reports every conversation ever opened: measured,
   * 207 sessions of which 12 were touched in the last 24 hours. A number like
   * that does not answer «who is working now», it answers «how much have I
   * used jcode this year». Same window as Claude Code, so as not to have two
   * notions of «recent» in the same row.
   */
  windowMs?: number;
  /**
   * Does the process exist? Normally `process.kill(pid, 0)`, which sends no
   * signal at all and only serves to ask «are you still there?».
   *
   * Injectable because a test cannot depend on the pids of the machine that
   * runs it.
   */
  isAlive?: (pid: number) => boolean;
  /** How many sessions to read at most, from the most recent one. */
  limit?: number;
  /**
   * The known project roots, to say WHICH project a cwd belongs to.
   *
   * Without them, every jcode session stays without a project and disappears
   * from everything that reasons per project: the badge on the board and the
   * dispatcher's guard, which refuses to drop an agent where somebody is
   * already working. Measured on 08/23: 13 jcode sessions out of 13 were
   * orphans, including the ones opened inside `topics-app` itself.
   */
  candidatePaths?: string[];
  /** The board id of a root. */
  projectIdFor?: (path: string) => string;
}

function aliveByDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Two different errors, and confusing them makes live sessions vanish:
    // ESRCH says the process does not exist, EPERM that it exists but belongs
    // to another user. Verified in Node: `e.code` carries the distinction,
    // `process.errno` does not exist and always returned undefined.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** The git branch of a directory, if it is a checkout. Best effort: a cwd that
 *  is not a repository is not an error. */
function branchOf(cwd: string): string | null {
  try {
    const head = join(cwd, ".git", "HEAD");
    if (!existsSync(head)) return null;
    const raw = readFileSync(head, "utf8").trim();
    return raw.startsWith("ref: refs/heads/") ? raw.slice("ref: refs/heads/".length) : null;
  } catch {
    return null;
  }
}

/**
 * The jcode sessions, most recent first.
 *
 * A session is `active` when its `last_pid` answers AND it was touched within
 * `activeMs`. The pid alone is not enough: the jcode server is shared, so the
 * same pid shows up on many sessions and stays alive even when that
 * conversation has been over for hours.
 */
export function scanJcodeSessions(opts: ScanJcodeOptions = {}): ExternalClaudeSession[] {
  const dir = opts.sessionsDir ?? join(homedir(), ".jcode", "sessions");
  const now = opts.now ?? Date.now();
  const activeMs = opts.activeMs ?? DEFAULT_ACTIVE_MS;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const isAlive = opts.isAlive ?? aliveByDefault;
  const limit = opts.limit ?? 200;
  const candidatePaths = opts.candidatePaths ?? [];
  const projectIdFor = opts.projectIdFor ?? (() => "");

  if (!existsSync(dir)) return [];

  let files: Array<{ path: string; mtimeMs: number }>;
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const path = join(dir, f);
        try {
          return { path, mtimeMs: statSync(path).mtimeMs };
        } catch {
          return { path, mtimeMs: 0 };
        }
      })
      .filter((f) => f.mtimeMs > 0 && now - f.mtimeMs <= windowMs)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit);
  } catch {
    return [];
  }

  const out: ExternalClaudeSession[] = [];
  for (const f of files) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(readFileSync(f.path, "utf8")) as Record<string, unknown>;
    } catch {
      continue; // a half-written file is not a lost session
    }

    const cwd = typeof d.working_dir === "string" ? d.working_dir : null;
    if (!cwd) continue;

    const pid = typeof d.last_pid === "number" ? d.last_pid : null;
    const status = typeof d.status === "string" ? d.status.toLowerCase() : "";
    const age = now - f.mtimeMs;

    // Three conditions, all of them necessary: jcode says it is active, the
    // process answers, and there has been movement recently. Drop the third
    // one and every session ever opened with this server looks like it is at
    // work.
    const active = status === "active" && pid !== null && isAlive(pid) && age <= activeMs;

    const projectPath = resolveOwningProject(cwd, candidatePaths);

    out.push({
      sessionId: (typeof d.id === "string" ? d.id : f.path).replace(/^.*\//, "").replace(/\.json$/, ""),
      cwd,
      projectPath,
      projectId: projectPath ? projectIdFor(projectPath) : null,
      branch: branchOf(cwd),
      entrypoint: "jcode",
      lastActivityMs: f.mtimeMs,
      state: active ? "active" : "idle",
      transcriptPath: f.path,
    });
  }
  return out;
}
