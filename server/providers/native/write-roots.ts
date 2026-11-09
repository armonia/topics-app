/**
 * Extra roots the native `write_file` / `edit_file` may write into, declared
 * per workspace.
 *
 * WHY. `safePath` refuses every path outside the workspace, and channel turns
 * that legitimately write to `~/Projects` or `~/bin` were refused (11 of 14
 * writes in three days). The cure is an explicit list, not a wider perimeter:
 * anything not listed stays closed.
 *
 * WHERE. `native-write-roots.json` in the app data dir, deliberately OUTSIDE
 * the workspace so the agent cannot grant itself a root with `write_file`:
 * `{ "<workspace path>": ["~/Projects", "~/bin"] }`. Not tracked in the repo.
 * A missing, unreadable or malformed file means no extra roots.
 */
import { existsSync, readFileSync, realpathSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { homedir } from "os";
import { resolveAppDataDir } from "../../lib/data-dir";

export const WRITE_ROOTS_FILE = "native-write-roots.json";

function expandRoot(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

function isInside(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The real path of `abs`, resolving symlinks through the nearest existing ancestor. */
function realish(abs: string): string {
  let cur = abs;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return abs;
    tail.unshift(cur.slice(up.length).replace(/^[\/]+/, ""));
    cur = up;
  }
  return join(realpathSync(cur), ...tail);
}

/** Roots declared for `workspace`. Relative entries, `/`, and the bare home are dropped: too wide or ambiguous. */
export function readWriteRoots(workspace: string, dataDir: string = resolveAppDataDir()): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dataDir, WRITE_ROOTS_FILE), "utf-8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const ws = resolve(workspace);
  const entry = Object.entries(parsed as Record<string, unknown>).find(([k]) => resolve(expandRoot(k)) === ws);
  if (!entry || !Array.isArray(entry[1])) return [];
  const home = resolve(homedir());
  const roots: string[] = [];
  for (const raw of entry[1]) {
    if (typeof raw !== "string") continue;
    const expanded = expandRoot(raw);
    if (!isAbsolute(expanded)) continue;
    const abs = resolve(expanded);
    if (dirname(abs) === abs || abs === home) continue;
    roots.push(abs);
  }
  return roots;
}

/** True when `abs` sits inside one of the roots declared for `workspace`, symlinks resolved. */
export function isInWriteRoot(workspace: string, abs: string, dataDir?: string): boolean {
  const target = realish(abs);
  return readWriteRoots(workspace, dataDir).some((root) => isInside(realish(root), target));
}
