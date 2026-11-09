/**
 * Extra folders `write_file` and `edit_file` may write into, declared per
 * workspace.
 *
 * WHY. The workspace is the only perimeter a native write accepts, and channel
 * turns kept being refused for legitimate targets: 11 writes out of 14 in three
 * days. The cure is an explicit list, not a wider rule: whatever is not named
 * here stays closed.
 *
 * WHERE. `native-write-roots.json` in the app data dir, deliberately outside
 * every workspace so an agent cannot widen its own perimeter by writing it.
 * Shape: `{ "<workspace path>": ["~/Projects", "~/bin"] }`. A missing, unreadable
 * or malformed file means no extra roots.
 */

import { readFileSync } from "fs";
import { join, resolve, relative, isAbsolute } from "path";
import { expandHome } from "../../lib/expand-home";
import { resolveAppDataDir } from "../../lib/data-dir";

export const WRITE_ROOTS_FILE = "native-write-roots.json";

function same(a: string, b: string): boolean {
  const x = resolve(a);
  const y = resolve(b);
  return process.platform === "win32" || process.platform === "darwin" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** The roots declared for `workspace`, absolute. Never throws. */
export function loadWriteRoots(workspace: string, file: string = join(resolveAppDataDir(), WRITE_ROOTS_FILE)): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const roots: string[] = [];
  for (const [ws, list] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(list) || !same(expandHome(ws), workspace)) continue;
    for (const r of list) {
      if (typeof r !== "string" || !r.trim()) continue;
      const abs = resolve(expandHome(r.trim()));
      // A filesystem root or a drive root is a generic widening, not a declaration.
      if (dirnameOf(abs) === abs) continue;
      roots.push(abs);
    }
  }
  return roots;
}

function dirnameOf(p: string): string {
  return resolve(p, "..");
}

/** True when the absolute path `abs` sits inside one of `roots`. */
export function insideAnyRoot(abs: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, abs);
    return !rel.startsWith("..") && !isAbsolute(rel);
  });
}
