/**
 * WHERE A SESSION'S AGENT WORKS: the folder its CLI is spawned in, and so the
 * folder its Bash runs in.
 *
 * Here and not in a provider because two kinds of caller need it: the
 * providers that spawn the CLI, and the routes that run something "where the
 * agent works" for a person (a command run from the chat, a terminal opened
 * from it). A route importing a provider would pull the whole CLI driver in.
 */
import { existsSync } from "fs";
import { getDatabase } from "../db";

/**
 * Resolve the OS working directory for a session's spawn, mirroring the
 * `ctx.resolveTopicCwd` precedence (a ready worktree's absPath, else the
 * topic's projectPath) directly from the DB — the provider module can't reach
 * the ctx closure. Returns null when the topic has no bound dir or the
 * resolved path is missing, so the caller falls back to defaultWorkspace/HOME.
 *
 * WHY this matters (2026-07-18): the CLI child spawns with THIS cwd, and the
 * agent's relative-path tools (Bash/Glob/Grep) resolve against it. We used to
 * spawn EVERY session in HOME and rely on the "You are working in <path>"
 * awareness block alone. For a plain interactive project chat that diverges:
 * asked to analyse the whole repository, the agent — sitting in HOME — ran
 * `find ~/Projects`, wandered into the WRONG repo, and piled up 60s no-data
 * timeouts (the "chat keeps freezing" report). Aligning the OS cwd with
 * resolveTopicCwd removes the divergence; for worktree-bound board agents the
 * cwd now equals the isolated worktree the awareness block already names.
 */
export function getTopicWorkspaceForSession(sessionKey: string): string | null {
  try {
    const row = getDatabase()
      .prepare(
        `SELECT t.project_path AS projectPath, w.abs_path AS wtAbs, w.status AS wtStatus
         FROM topics t LEFT JOIN worktrees w ON w.id = t.worktree_id
         WHERE t.session_key = ? LIMIT 1`,
      )
      .get(sessionKey) as { projectPath?: string | null; wtAbs?: string | null; wtStatus?: string | null } | undefined;
    if (!row) return null;
    // A ready worktree wins — same precedence as resolveTopicCwd, and it matches
    // the path the awareness block already tells the agent to work in.
    if (row.wtAbs && row.wtStatus === "ready" && existsSync(row.wtAbs)) return row.wtAbs;
    // Otherwise the project checkout. Expand a leading ~ like resolveProjectPath.
    let p = row.projectPath ?? "";
    if (!p) return null;
    if (p.startsWith("~")) {
      const home = process.env.HOME;
      if (!home) return null;
      p = p.replace(/^~/, home);
    }
    // Guard existence: spawning with a stale/missing cwd throws → fall back.
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * The folder the agent of a session works in: its worktree or project
 * (`getTopicWorkspaceForSession`), else the workspace the provider was
 * configured with, else the home. A chat with no project still has one: its
 * agent runs in the home, and so does what is run from it.
 */
export function agentWorkspaceForSession(sessionKey: string, configured: string | undefined = process.env.CLAUDE_CODE_WORKSPACE): string {
  return getTopicWorkspaceForSession(sessionKey) || configured || process.env.HOME || "/tmp";
}
