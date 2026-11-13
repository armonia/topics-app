/**
 * WHERE AN ADOPTED SESSION LIVES: the project it belongs to, and the checkout
 * its CLI works in.
 *
 * A Claude Code session started elsewhere (Claude Desktop, a terminal) often
 * runs inside a linked git worktree of a project: `<repo>/.claude/worktrees/x`
 * for the desktop app, any `git worktree add` folder for a person. Adopting it
 * with `projectPath = <that folder>` made the worktree look like a project of
 * its own: a separate entry in the sidebar, an empty board, and the chat
 * outside the real repository it works on.
 *
 * The answer comes from the folder's `.git` FILE, which a linked worktree has
 * instead of a directory: `gitdir: <repo>/.git/worktrees/<name>`, and that
 * admin dir names the shared `.git` in `commondir`. The repository is the
 * parent of that shared `.git`. Read from disk, never guessed from the path
 * shape, so a folder that merely sits under `.claude/worktrees/` but is not a
 * registered worktree stays what it is.
 *
 * Pure apart from the injected reader, so it is tested without a real repo.
 */
import { dirname, isAbsolute, resolve } from "node:path";

export interface CheckoutFs {
  /** File contents, or null when absent/unreadable/not a file. */
  readFile(path: string): string | null;
  /** True when the path is an existing directory. */
  isDir(path: string): boolean;
}

export interface AdoptedCheckout {
  /** The project folder: the main repository for a linked worktree, else the cwd itself. */
  projectDir: string;
  /** The linked worktree the CLI works in, or null when the cwd is the project itself. */
  worktreeDir: string | null;
  /** The worktree's admin name under `.git/worktrees/`, when there is one. */
  worktreeName: string | null;
}

/**
 * Resolve `cwd` (where the session's CLI runs) into the project it belongs to
 * and, when it is a linked worktree, that worktree.
 *
 * Only the TOP of a worktree is recognised (`<cwd>/.git` is a file). A session
 * that did `cd server/` inside a worktree is filed under that subfolder: the
 * walk up would answer it too, but adoption takes the cwd the CLI stamped and
 * a subfolder there has never been seen, so the simple rule stays.
 */
export function resolveAdoptedCheckout(cwd: string, fs: CheckoutFs): AdoptedCheckout {
  const plain: AdoptedCheckout = { projectDir: cwd, worktreeDir: null, worktreeName: null };
  const dotGit = fs.readFile(resolve(cwd, ".git"));
  if (dotGit === null) return plain;
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(dotGit);
  if (!m) return plain;
  const adminDir = resolve(cwd, m[1]!);
  // `<repo>/.git/worktrees/<name>`: a submodule's `.git` file points at
  // `<repo>/.git/modules/<name>`, which is not a worktree and has no commondir.
  const commondir = fs.readFile(resolve(adminDir, "commondir"));
  if (commondir === null) return plain;
  const common = commondir.trim();
  if (!common) return plain;
  const sharedGit = isAbsolute(common) ? resolve(common) : resolve(adminDir, common);
  const projectDir = dirname(sharedGit);
  if (!fs.isDir(projectDir) || projectDir === cwd) return plain;
  const name = adminDir.split("/").pop() || null;
  return { projectDir, worktreeDir: cwd, worktreeName: name };
}
