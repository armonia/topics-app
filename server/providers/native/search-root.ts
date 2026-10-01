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
 * container answer the same. A `..` in a link's target is taken the way the
 * kernel takes it, from the folder the walk has really reached, not by editing
 * the text of the path.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { homeDir } from "../../lib/broad-cwd";
import { isInsideDir } from "../../lib/path-containment";
import { isProtectedRoot } from "../../lib/protected-app-data";

export type SearchRoot =
  | { ok: true; root: string; home: string }
  | { ok: false; reason: string; missing?: true };

/** A `\\` is a separator in a link target only on Windows; elsewhere it is part of a name. */
const TARGET_SEP = process.platform === "win32" ? /[\\/]/ : "/";

/** Links followed at most, as the kernel does (`MAXSYMLINKS`): past this a chain is a loop. */
const MAX_LINKS = 32;

/**
 * macOS reaches the data volume under a second spelling too (`/Users/x` is
 * `/System/Volumes/Data/Users/x`), through a firmlink that `lstat` does not
 * report as a link. A prefix is checked under both.
 */
const DATA_VOLUME = "/System/Volumes/Data";
function withoutDataVolume(p: string): string | null {
  return process.platform === "darwin" && p.startsWith(`${DATA_VOLUME}/`) ? p.slice(DATA_VOLUME.length) : null;
}

type Followed = { path: string } | { refused: true } | { error: "missing" | "unreadable" };

/** `p` with every link resolved by `lstat` + `readlink`, refused as soon as a prefix is one `stop` names. */
function followLinks(p: string, stop: (prefix: string) => boolean): Followed {
  const abs = resolve(p);
  let cur = parse(abs).root;
  let rest = relative(cur, abs).split(sep).filter(Boolean);
  let hops = 0;
  while (rest.length > 0) {
    const part = rest.shift()!;
    if (part === ".") continue;
    // `cur` holds no links any more, so its parent is the real one.
    if (part === "..") { cur = dirname(cur); continue; }
    const next = join(cur, part);
    const alias = withoutDataVolume(next);
    if (stop(next) || (alias !== null && stop(alias))) return { refused: true };
    let link: boolean;
    try {
      link = lstatSync(next).isSymbolicLink();
    } catch (err) {
      return { error: (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
    }
    if (!link) { cur = next; continue; }
    if (++hops > MAX_LINKS) return { error: "unreadable" };
    const target = readlinkSync(next);
    if (!target) return { error: "missing" };
    // A relative target continues from the folder that holds the link; its
    // components, `..` included, are walked like the rest, never collapsed.
    if (isAbsolute(target)) cur = parse(target).root;
    rest = [...target.slice(isAbsolute(target) ? parse(target).root.length : 0).split(TARGET_SEP).filter(Boolean), ...rest];
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
