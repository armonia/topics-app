/**
 * Where a native search (`grep`, `glob`) may start: the folder the agent named,
 * with its links followed.
 *
 * WHY THE LINKS ARE FOLLOWED. `safePath` compares spellings, and a folder inside
 * the workspace can be a link to anywhere (`etc -> /etc`, `c ->
 * ~/Library/Containers`). A search follows the link, so the checks follow it
 * too, and a walk then builds every child from the resolved root plus `readdir`
 * names, which is the one spelling `lib/protected-app-data.ts` compares.
 *
 * WHY NOT `realpath`. Bun's `realpathSync` OPENS its target on macOS (a folder
 * at mode 000 fails with EACCES where `lstat` does not), and opening a folder
 * inside another app's container is what raises the "Topics Host would like to
 * access data from other apps" prompt. So the path is resolved one component at
 * a time with `lstat` and `readlink`, and every prefix is checked against the
 * protected areas BEFORE it is touched: a refused root is refused without a
 * single file-system call inside it, which also means a missing and an existing
 * container answer the same.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { join, parse, relative, resolve, sep } from "node:path";
import { homeDir } from "../../lib/broad-cwd";
import { isInsideDir } from "../../lib/path-containment";
import { isProtectedRoot } from "../../lib/protected-app-data";

export type SearchRoot =
  | { ok: true; root: string; home: string }
  | { ok: false; reason: string; missing?: true };

/** Links followed at most: past this a chain is a loop. */
const MAX_LINKS = 40;

type Followed = { path: string } | { refused: true } | { error: "missing" | "unreadable" };

/** `p` with every link resolved by `lstat` + `readlink`, refused as soon as a prefix is one `stop` names. */
function followLinks(p: string, stop: (prefix: string) => boolean): Followed {
  const abs = resolve(p);
  let cur = parse(abs).root;
  let rest = relative(cur, abs).split(sep).filter(Boolean);
  let hops = 0;
  while (rest.length > 0) {
    const next = join(cur, rest.shift()!);
    if (stop(next)) return { refused: true };
    let link: boolean;
    try {
      link = lstatSync(next).isSymbolicLink();
    } catch (err) {
      return { error: (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
    }
    if (!link) { cur = next; continue; }
    if (++hops > MAX_LINKS) return { error: "unreadable" };
    // A relative target is relative to the folder that holds the link.
    const target = resolve(cur, readlinkSync(next));
    cur = parse(target).root;
    rest = [...relative(cur, target).split(sep).filter(Boolean), ...rest];
  }
  return { path: cur };
}

/** Our own folders (workspace, HOME): never inside another app's data unless chosen so. */
function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function resolveSearchRoot(workspace: string, root: string): SearchRoot {
  const ws = realOrSelf(workspace);
  const home = homeDir() ? realOrSelf(homeDir()) : "";
  const followed = followLinks(root, (prefix) => isProtectedRoot(prefix, ws, home));
  if ("refused" in followed) return { ok: false, reason: `another app's private data, not searched: ${root}` };
  if ("error" in followed) {
    return followed.error === "missing"
      ? { ok: false, reason: `no such folder: ${root}`, missing: true }
      : { ok: false, reason: `cannot read: ${root}` };
  }
  if (!isInsideDir(followed.path, ws)) return { ok: false, reason: `outside the workspace once its links are followed: ${root}` };
  return { ok: true, root: followed.path, home };
}
