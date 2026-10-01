/**
 * The native agent's `glob`: files under a root whose path matches a pattern,
 * found by walking the tree in-process. NO SHELL, on purpose.
 *
 * WHY. It used to be `bash -lc "… printf '%s\n' <pattern>"`, with the pattern
 * pasted into the command line. `glob` is a READ-ONLY tool (`permissions.ts`),
 * allowed even in «ask» mode, so `$(…)` in a pattern ran any command the bash
 * gate would have refused, and `../*` listed outside the workspace. And macOS
 * `/bin/bash` is 3.2, without `globstar`: `**` matched one level, and every
 * answer started with bash's error line.
 *
 * THE WALK IS THE SERVER'S, so it obeys the walkers' rules. The literal head of
 * the pattern (`src/lib` in `src/lib/**`) is a folder the agent names, exactly
 * like `path`: it goes through `resolveSearchRoot`, links followed, so a link
 * to `/etc` or to another app's data is refused there. Below it the walk never
 * follows a linked folder (a link is listed by its name, never entered), never
 * enters other apps' data (`lib/protected-app-data.ts`), and enters dependency
 * folders only when the pattern names them.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { HEAVY_DIRS } from "../../lib/file-tree";
import { isProtectedFromWalk } from "../../lib/protected-app-data";
import { resolveSearchRoot } from "./search-root";

const GLOB_CHARS = /[*?[\]{}]/;

/** Folders a wildcard does not enter: version control plus `HEAVY_DIRS`. */
const SKIPPED_DIRS = new Set([".git", ...HEAVY_DIRS]);

export interface GlobOptions {
  /** The perimeter: the session's workspace. Defaults to `root`. */
  within?: string;
  /** Matches returned at most. */
  maxResults?: number;
  /** Directory entries read at most: the bound on a walk from HOME. */
  maxEntries?: number;
  signal?: AbortSignal;
}

export type GlobOutcome =
  | { ok: true; files: string[]; truncated: boolean }
  | { ok: false; reason: string };

/**
 * Files under `root` whose `/`-separated path relative to `root` matches
 * `pattern` (Bun's glob syntax: `**`, `*`, `?`, `[…]`, `{a,b}`; dotfiles
 * included). A pattern ending in `/` lists folders instead, with the slash.
 */
export async function globFiles(root: string, pattern: string, opts: GlobOptions = {}): Promise<GlobOutcome> {
  const maxResults = opts.maxResults ?? 1000;
  const maxEntries = opts.maxEntries ?? 200_000;
  // `\` is a separator only on Windows; elsewhere it escapes, as in bash.
  const text = (process.platform === "win32" ? pattern.replace(/\\/g, "/") : pattern).trim();
  if (!text) return { ok: false, reason: "empty pattern" };
  // The pattern is relative to the root and stays under it: the perimeter
  // is the root, and `path` is where a search starts elsewhere.
  if (isAbsolute(text) || text.startsWith("/") || text.startsWith("~")) {
    return { ok: false, reason: `the pattern is relative to the search root, pass the folder as \`path\`: ${pattern}` };
  }
  const segs = text.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.includes("..")) return { ok: false, reason: `\`..\` leaves the search root: ${pattern}` };
  if (segs.length === 0) return { ok: false, reason: "empty pattern" };
  const dirsOnly = text.endsWith("/");

  // The literal head of the pattern is a path, not a search: the walk starts
  // there, and a dependency folder named in it is walked like any other.
  let head = 0;
  while (head < segs.length - 1 && !GLOB_CHARS.test(segs[head]!)) head++;
  // Every literal word, brace alternatives included: `{build,lib}/*` names both.
  const named = new Set(
    segs.flatMap((s) => s.replace(/[{}]/g, ",").split(",")).filter((w) => w && !GLOB_CHARS.test(w)),
  );
  // A brace group with a `/` inside (`{src/a,lib}/*.ts`) has no per-level
  // segments: it is walked like `**`, and only the whole pattern decides.
  const braces = segs.some((s) => (s.match(/\{/g)?.length ?? 0) !== (s.match(/\}/g)?.length ?? 0));
  const recursive = braces || segs.slice(head).includes("**");
  // Without `**`, a match can only sit exactly this many levels below the start.
  const lastLevel = segs.length - head - 1;
  const segMatchers = recursive ? [] : segs.map((s) => new Bun.Glob(s));
  const whole = new Bun.Glob(segs.join("/"));

  const start = segs.slice(0, head);
  const startDir = join(root, ...start);
  if (!existsSync(startDir)) return { ok: true, files: [], truncated: false };
  const where = resolveSearchRoot(opts.within ?? root, startDir);
  if (!where.ok) return where;
  const { root: base, home } = where;

  const files: string[] = [];
  let entries = 0;
  let truncated = false;

  async function walk(dir: string, rel: string, level: number): Promise<void> {
    if (truncated || opts.signal?.aborted) return;
    let list;
    try {
      list = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of list) {
      if (++entries > maxEntries || files.length >= maxResults) { truncated = true; return; }
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (dirsOnly && whole.match(path)) files.push(`${path}/`);
        // Without `**` each level has its own segment: a folder past the last
        // one, or one that does not match its own, cannot hold a match.
        if (!recursive && (level >= lastLevel || !segMatchers[head + level]!.match(entry.name))) continue;
        if (SKIPPED_DIRS.has(entry.name) && !named.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (isProtectedFromWalk(full, base, home)) continue;
        await walk(full, path, level + 1);
        if (truncated) return;
      } else if (!dirsOnly && (entry.isFile() || entry.isSymbolicLink()) && whole.match(path)) {
        files.push(path);
      }
    }
  }

  await walk(base, start.join("/"), 0);
  if (opts.signal?.aborted) return { ok: false, reason: "search cancelled" };
  return { ok: true, files, truncated };
}

/** The tool's answer: one path per line, and a note when the walk stopped early. */
export function globAnswer(files: string[], truncated: boolean): string {
  const note = truncated ? "\n(walk stopped early: narrow the pattern or pass a deeper `path`)" : "";
  return (files.join("\n") || "nessun file") + note;
}
