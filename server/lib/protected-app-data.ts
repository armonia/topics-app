import { basename, join, resolve, sep } from "node:path";
import { homeDir } from "./broad-cwd";
import { isInsideDir } from "./path-containment";

/**
 * Other apps' private data: the folders no walk, search or watch of this server
 * may enter on its own.
 *
 * WHY. The production server runs under the signed launcher "Topics Host", and
 * macOS attributes the whole job tree to it. Since macOS 14 the data of other
 * apps is protected (TCC service `SystemPolicyAppData`): the first read inside
 * `~/Library/Containers/<another app>` or `~/Library/Group Containers/...` pops
 * "Topics Host would like to access data from other apps", and the answer does
 * not stick across launches (auth_value 5 in TCC.db, measured 2026-10-01), so a
 * server that restarts often asks again and again. Mail, Messages, Safari and
 * Calendars are guarded the same way, by their own TCC services, and a photo or
 * music library is a package that can sit anywhere (`~/Pictures` by default).
 *
 * THE RULE, one for every walker: a walk never crosses INTO a protected area it
 * did not start in. `~/Library` as a whole is an area for a walk rooted at HOME
 * or above it, so the explorer of a project opened ON `~/Library/Logs` still
 * works, while a walk from HOME stops at `Library`; inside `~/Library` the
 * per-app folders are areas of their own. A root the user opened explicitly
 * inside an area is theirs to browse: only the crossing is refused.
 *
 * Paths are compared as given (resolved, not realpath'd): a walker builds every
 * child from its root plus `readdir` names, so both sides share one spelling.
 * The comparison ignores case where the file system usually does (macOS,
 * Windows), or `~/library/containers` would be a way around it.
 *
 * What this cannot guard: commands an AGENT runs in its own shell (`find ~`,
 * `rg` from HOME). Those are the agent's, not the server's.
 */

/** Folders under `~/Library` that hold another app's private data. */
export const PROTECTED_LIBRARY_DIRS = [
  "Containers", "Group Containers", "Mail", "Messages", "Safari", "Calendars",
] as const;

/** Media library packages: protected wherever they sit. */
const MEDIA_LIBRARY_SUFFIXES = [
  ".photoslibrary", ".photolibrary", ".migratedphotolibrary", ".aplibrary", ".musiclibrary", ".tvlibrary",
];
const MEDIA_LIBRARY_NAMES = ["Photo Booth Library"];

const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";
/**
 * A name as the file system compares it. `toLowerCase()` alone is not that:
 * APFS folds `ſ` (long s) to `s`, so `Containerſ` IS `Containers` on disk and
 * would walk past a lowercase comparison. NFKC then upper-then-lower folds it,
 * and the Kelvin sign with it. It folds a little MORE than APFS (fullwidth
 * letters), which only ever refuses a name, never lets one through.
 */
const fold = (s: string): string => (FOLD_CASE ? s.normalize("NFKC").toUpperCase().toLowerCase() : s);
const key = (p: string): string => fold(resolve(p));

function isMediaLibraryName(name: string): boolean {
  const n = fold(name);
  return MEDIA_LIBRARY_SUFFIXES.some((s) => n.endsWith(s))
    || MEDIA_LIBRARY_NAMES.some((m) => fold(m) === n);
}

/**
 * Every protected area `abs` lies in (the area's own root, case-folded).
 * `wholeLibrary: false` leaves out `~/Library` itself and keeps the per-app
 * folders and media libraries.
 */
function areasOf(abs: string, home: string, wholeLibrary = true): string[] {
  const p = key(abs);
  const out: string[] = [];
  if (home) {
    const lib = key(join(home, "Library"));
    if (isInsideDir(p, lib)) {
      if (wholeLibrary) out.push(lib);
      for (const d of PROTECTED_LIBRARY_DIRS) {
        const area = key(join(home, "Library", d));
        if (isInsideDir(p, area)) out.push(area);
      }
    }
  }
  const parts = resolve(abs).split(sep);
  for (let i = 1; i <= parts.length; i++) {
    if (isMediaLibraryName(parts[i - 1] ?? "")) out.push(key(parts.slice(0, i).join(sep) || sep));
  }
  return out;
}

/**
 * May a walk rooted at `root` enter `dir`? `true` = it must not: `dir` is in a
 * protected area that `root` is not already in.
 */
export function isProtectedFromWalk(dir: string, root: string, home: string = homeDir()): boolean {
  const rootAreas = new Set(areasOf(root, home));
  return areasOf(dir, home).some((a) => !rootAreas.has(a));
}

/**
 * May a search start at `root`, chosen by an agent whose workspace is
 * `workspace`? `true` = it must not: `root` is inside another app's folder or a
 * media library that the workspace is not in. `~/Library` itself and
 * `~/Library/Logs` are fine as roots: naming them is a choice, and the walk
 * from there still stops at the per-app folders (`isProtectedFromWalk`).
 */
export function isProtectedRoot(root: string, workspace: string, home: string = homeDir()): boolean {
  const own = new Set(areasOf(workspace, home, false));
  return areasOf(root, home, false).some((a) => !own.has(a));
}

/**
 * Does a RECURSIVE walk or watch of `root` reach other apps' data? True for
 * HOME, anything above it, and `~/Library` itself. Media libraries nested in a
 * project are not counted here: they can only be found by walking, which is
 * what `isProtectedFromWalk` and `protectedDirExcludes` are for.
 */
export function reachesProtectedAppData(root: string, home: string = homeDir()): boolean {
  if (!home) return false;
  return isInsideDir(key(join(home, "Library")), key(root));
}

/**
 * Directory names to hand a spawned `grep -r` as `--exclude-dir`, for a search
 * rooted at `root`. grep matches these against the BASE NAME at any depth, so
 * from HOME the whole `Library` name is excluded (a nested `Library` folder of a
 * project under HOME goes with it: a search from HOME is already the broadest
 * there is). A name that matches the root's own base name is left out, because
 * BSD grep applies `--exclude-dir` to the root too and would answer nothing.
 */
export function protectedDirExcludes(root: string, home: string = homeDir()): string[] {
  const names: string[] = [];
  if (home) {
    const lib = key(join(home, "Library"));
    const r = key(root);
    if (r === lib) names.push(...PROTECTED_LIBRARY_DIRS);
    else if (isInsideDir(lib, r)) names.push("Library");
  }
  const media = new Set<string>([...MEDIA_LIBRARY_SUFFIXES.map((s) => `*${s}`), ...MEDIA_LIBRARY_NAMES]);
  names.push(...media);
  const own = basename(resolve(root));
  return names
    .filter((n) => !(n.startsWith("*") ? isMediaLibraryName(own) : fold(n) === fold(own)))
    // grep compares `--exclude-dir` with case: on a file system that ignores it,
    // `Old.PHOTOSLIBRARY` is the same package and must be excluded too. The
    // Library folders keep their spelling: macOS creates them, a person does not.
    .map((n) => (FOLD_CASE && media.has(n) ? caseless(n) : n));
}

/** `*.photoslibrary` as a glob that matches it in any case: `*.[pP][hH]…`. */
function caseless(pattern: string): string {
  return pattern.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}
