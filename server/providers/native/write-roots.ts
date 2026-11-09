/**
 * Extra folders `write_file` and `edit_file` may write to, besides the workspace.
 *
 * WHY. The perimeter is the workspace, and channel turns kept asking to write
 * to a sibling projects folder or a personal bin folder: 11 of 14 writes were
 * refused in three days. The cure is NOT a wider perimeter but an explicit list,
 * per workspace, that the person declares. Everything not listed stays closed.
 *
 * WHERE IT LIVES. In the app data folder, `native-write-roots.json`, never
 * inside the workspace: an agent that can write in its workspace must not be
 * able to widen its own perimeter by editing the file that defines it.
 *
 *   { "<workspace path>": ["~/Projects", "~/bin"], "*": ["~/shared"] }
 *
 * `*` applies to every workspace. A missing or unreadable file means no extra
 * roots. The filesystem root and the home folder itself are ignored, as they
 * would reopen the whole disk. Paths are compared on their REAL location, so a
 * link inside an allowed root that points elsewhere does not pass.
 */

import { existsSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, parse, resolve } from "path";
import { resolveAppDataDir } from "../../lib/data-dir";
import { isInsideDir } from "../../lib/path-containment";

const WRITE_ROOTS_FILE = "native-write-roots.json";

function expandRoot(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/** The nearest existing ancestor resolved through links, plus the missing tail. */
function realWithTail(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(parse(head).base);
    head = dirname(head);
  }
  let real = head;
  try { real = realpathSync(head); } catch { /* keep the spelling */ }
  return join(real, ...tail);
}

/** The extra roots declared for a workspace, absolute and without the unsafe ones. */
export function writeRootsFor(workspace: string, file = join(resolveAppDataDir(), WRITE_ROOTS_FILE)): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf-8")); } catch { return []; }
  if (!parsed || typeof parsed !== "object") return [];
  const map = parsed as Record<string, unknown>;
  const ws = resolve(workspace);
  const raw: unknown[] = [];
  for (const [key, value] of Object.entries(map)) {
    if (!Array.isArray(value)) continue;
    if (key === "*" || (isAbsolute(key) && resolve(key) === ws)) raw.push(...value);
  }
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string" || !r.trim()) continue;
    const abs = resolve(expandRoot(r.trim()));
    if (abs === parse(abs).root || abs === resolve(homedir())) continue;
    out.push(abs);
  }
  return [...new Set(out)];
}

/** Is an absolute path inside one of the roots, on real locations? */
export function insideWriteRoots(abs: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return false;
  const real = realWithTail(abs);
  return roots.some((r) => isInsideDir(real, realWithTail(r)));
}
