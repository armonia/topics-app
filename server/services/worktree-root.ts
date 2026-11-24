import { join } from "node:path";
import { topicsHome } from "./daemon-state";
import { resolveWorktreeRootSetting } from "./app-settings";
import { WORKTREE_ROOT_FOLDER } from "../../shared/worktree-settings";

/**
 * THE WORKTREE ROOT, and why it is not `homedir()`.
 *
 * It used to be `join(homedir(), ".topics", "worktrees")`, hard-wired. But
 * `TOPICS_HOME` exists so that a server can have a home of its own (the test
 * server uses it, and so does the isolation of a server started by mistake from
 * a dispatch worktree). With the root hard-wired that isolation held for the
 * database only: measured on 19/08/2026 in the real home, 55 folders belonging to
 * `e2e-naming-...`, `e2e-rename-...` and `e2e-archive-...` projects, checkouts
 * made by a test suite that believed itself confined, and cleaned by nobody
 * because no registry knew them.
 *
 * Deriving the root from `topicsHome()` makes the isolation a property instead of
 * something to remember twice.
 *
 * Since `worktree-standard` (T1) the root can also be chosen in Settings
 * (`app_settings.worktree_root`). The order is: env `TOPICS_WORKTREES_DIR` (the
 * explicit override, which isolates a test server) > the setting >
 * `<topicsHome>/worktrees`. An empty value at any step falls through to the next.
 *
 * `setting` is read from the database only when `env` is the live process
 * environment: an explicit env is a pure computation over strings (the tests of
 * this function rely on it) and must not start depending on whatever database an
 * earlier test left open.
 */
export function worktreeRootDir(
  env: NodeJS.ProcessEnv = process.env,
  setting: string | null | undefined = env === process.env ? resolveWorktreeRootSetting() : null,
): string {
  const fromSetting = setting != null && setting.trim() !== "" ? setting : null;
  return env.TOPICS_WORKTREES_DIR || fromSetting || join(topicsHome(env), WORKTREE_ROOT_FOLDER);
}

/**
 * The default root, ignoring the setting: where worktrees lived before the root
 * became configurable. A row created there stays ours after the setting moves
 * the root, because the row holds the absolute path.
 */
export function defaultWorktreeRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TOPICS_WORKTREES_DIR || join(topicsHome(env), WORKTREE_ROOT_FOLDER);
}

