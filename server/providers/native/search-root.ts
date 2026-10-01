/**
 * Where a native search (`grep`, `glob`) may start: the folder the agent named,
 * with its links followed.
 *
 * WHY THE REAL PATH. `safePath` compares spellings, and a folder inside the
 * workspace can be a link to anywhere (`etc -> /etc`, `c ->
 * ~/Library/Containers`). A search follows the link, so the checks follow it
 * too: root, workspace and HOME are compared after `realpath`, and a walk then
 * builds every child from that real root plus `readdir` names, which is the one
 * spelling `lib/protected-app-data.ts` compares.
 */
import { realpathSync } from "node:fs";
import { homeDir } from "../../lib/broad-cwd";
import { isInsideDir } from "../../lib/path-containment";
import { isProtectedRoot } from "../../lib/protected-app-data";

export type SearchRoot =
  | { ok: true; root: string; home: string }
  | { ok: false; reason: string };

function real(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

export function resolveSearchRoot(workspace: string, root: string): SearchRoot {
  const r = real(root);
  if (!r) return { ok: false, reason: `no such folder: ${root}` };
  const ws = real(workspace) ?? workspace;
  const home = homeDir() ? (real(homeDir()) ?? homeDir()) : "";
  if (!isInsideDir(r, ws)) return { ok: false, reason: `outside the workspace once its links are followed: ${root}` };
  if (isProtectedRoot(r, ws, home)) return { ok: false, reason: `another app's private data, not searched: ${root}` };
  return { ok: true, root: r, home };
}
