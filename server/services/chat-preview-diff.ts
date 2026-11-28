// Does a chat's worktree touch interface files? Decides whether a live preview
// starts by itself at the end of a turn. Generic on purpose: extensions and
// folders common to any web project, nothing tied to one repo.
import { gitOut } from "./branch-status";

const INTERFACE_EXT = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|html|htm)$/i;
const INTERFACE_DIR = /(^|\/)(client|frontend|web|ui|public|static|landing)\/(src\/)?/i;
const NON_INTERFACE = /(^|\/)(tests?|__tests__|e2e|docs?|node_modules)\/|\.(test|spec)\.[a-z]+$|\.md$/i;

/** True when `path` looks like part of a user interface rather than server code, tests or docs. */
export function isInterfaceFile(path: string): boolean {
  const p = path.trim().replace(/\\/g, "/");
  if (!p || NON_INTERFACE.test(p)) return false;
  return INTERFACE_EXT.test(p) || (INTERFACE_DIR.test(p) && /\.(ts|js|json|svg|png|jpe?g|webp)$/i.test(p));
}

/** Files the worktree changed against the main branch (committed, staged, unstaged and new). */
export async function changedFilesOfWorktree(cwd: string, mainRef = "main"): Promise<string[]> {
  const base = (await gitOut(cwd, ["merge-base", mainRef, "HEAD"])).trim();
  const [diff, fresh] = await Promise.all([
    gitOut(cwd, ["diff", "--name-only", base || mainRef]),
    gitOut(cwd, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  return `${diff}\n${fresh}`.split("\n").map((l) => l.trim()).filter(Boolean);
}

export async function worktreeTouchesInterface(cwd: string, mainRef?: string): Promise<boolean> {
  return (await changedFilesOfWorktree(cwd, mainRef)).some(isInterfaceFile);
}
