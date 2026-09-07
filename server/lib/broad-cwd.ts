import { realpathSync } from "node:fs";
import { parse, resolve } from "node:path";
import { homedir } from "node:os";
import { isInsideDir } from "./path-containment";

/**
 * A cwd that is too broad to stand for a project.
 *
 * HOME, any ancestor of HOME and `/` are where a shell lands when nobody chose
 * a directory for it: `POST /api/terminal/sessions` without `cwd` defaults to
 * HOME, and that is fine for a PTY. It is NOT fine anywhere the cwd is read
 * back as "a project this server knows":
 *
 * - `server/routes/processes.ts` attributes listening ports to sessions by
 *   cwd, and a session in HOME would claim every process under home;
 * - `server/services/known-project-dirs.ts` turns every terminal cwd into a
 *   root of the file-route allowlist, and a root at HOME made
 *   `/preview/Users/<me>/.ssh/known_hosts` answer 200 (measured 2026-09-03).
 *
 * One rule, shared by both, so the HOME default written by the terminal route
 * is excluded by the same predicate wherever it is consumed.
 */
export function isBroadCwd(cwd: string, home: string = homeDir()): boolean {
  if (!cwd || isVolumeRoot(cwd) || cwd === home) return true;
  // "Ancestor of HOME" is containment, not a string prefix: written with a
  // hardcoded slash it answered NO to every ancestor on Windows, where the
  // separator is a backslash, and the broad default stopped being excluded.
  return home.length > 1 && isInsideDir(home, cwd);
}

/** HOME, with the platform's own answer when the variable is not set (Windows). */
export function homeDir(): string {
  return process.env.HOME || homedir();
}

/** `/` on POSIX, `C:\` on Windows: the one directory that is never a project. */
function isVolumeRoot(p: string): boolean {
  const abs = resolve(p);
  return abs === parse(abs).root;
}

/**
 * May a paired device name `path` as a project directory?
 *
 * Two shapes are accepted, and a third is refused:
 * - the broad default (HOME, its ancestors, `/`): harmless, because
 *   `isBroadCwd` keeps it out of every allowlist that reads these paths back;
 * - a directory inside a project the server already knows (`inProject` is
 *   `resolveProjectPath`, the same boundary the file routes enforce);
 * - anything else: `~/.ssh` is neither broad nor a project, and accepting it
 *   would let the caller feed the allowlist the file routes trust.
 *
 * `~` expands to HOME first, as `resolveProjectPath` does, so a client sending
 * `~` is treated exactly like one sending the home path.
 *
 * It was written for the terminal cwd (source 4 of the allowlist) and it is
 * named after the path, not after that route, because the other three
 * client-writable sources reach the same allowlist by other doors: a project
 * created via `POST /api/projects`, a `topic.projectPath`, a `project:` token
 * inside a `ui_state` value. The predicate is the same; who asks is not.
 */
export function isClientProjectPathAccepted(
  cwd: string,
  inProject: (path: string) => string | null,
  home: string = homeDir(),
): boolean {
  const expanded = cwd.startsWith("~") && home ? cwd.replace(/^~/, home) : cwd;
  let real = resolve(expanded);
  try { real = realpathSync(real); } catch { /* not on disk yet: judged on the resolved path */ }
  let realHome = home;
  try { if (home) realHome = realpathSync(home); } catch { /* keep the env value */ }
  if (isBroadCwd(real, realHome)) return true;
  return inProject(cwd) !== null;
}
