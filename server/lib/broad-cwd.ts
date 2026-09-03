import { realpathSync } from "node:fs";
import { resolve } from "node:path";

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
export function isBroadCwd(cwd: string, home: string = process.env.HOME || ""): boolean {
  if (!cwd || cwd === "/" || cwd === home) return true;
  return home.length > 1 && home.startsWith(cwd + "/");
}

/**
 * May a paired device open a terminal in `cwd`?
 *
 * Two shapes are accepted, and a third is refused:
 * - the broad default (HOME, its ancestors, `/`): harmless, because
 *   `isBroadCwd` keeps it out of every allowlist that reads cwds back;
 * - a directory inside a project the server already knows (`inProject` is
 *   `resolveProjectPath`, the same boundary the file routes enforce);
 * - anything else: `~/.ssh` is neither broad nor a project, and accepting it
 *   would let the terminal route feed the allowlist the file routes trust.
 *
 * `~` expands to HOME first, as `resolveProjectPath` does, so a client sending
 * `~` is treated exactly like one sending the home path.
 */
export function isClientCwdAccepted(
  cwd: string,
  inProject: (path: string) => string | null,
  home: string = process.env.HOME || "",
): boolean {
  const expanded = cwd.startsWith("~") && home ? cwd.replace(/^~/, home) : cwd;
  let real = resolve(expanded);
  try { real = realpathSync(real); } catch { /* not on disk yet: judged on the resolved path */ }
  let realHome = home;
  try { if (home) realHome = realpathSync(home); } catch { /* keep the env value */ }
  if (isBroadCwd(real, realHome)) return true;
  return inProject(cwd) !== null;
}
