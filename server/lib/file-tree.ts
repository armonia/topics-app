import { existsSync, readFileSync } from "fs";
import { readdir as readdirAsync, stat as statAsync } from "fs/promises";
import { join } from "path";
import { IgnoreSet } from "./gitignore";
import { isTopicsSecretPath } from "./topics-secret-path";
import type { FileNode } from "../../shared/file-tree";

/**
 * The folders no walk or search should enter: build output and caches, all
 * regenerable and all huge.
 *
 * The list used to live in the file TREE branch only; the `grep` behind
 * `/api/files/search` did not have it, and on this repo the difference was
 * measured at 198.9 s against 16.6 s, because `desktop-tauri/src-tauri/target/`
 * alone weighs 10 GB (gitignored) and took 91.6% of the time. One list, then,
 * shared by both.
 */
export const HEAVY_DIRS = new Set([
  "node_modules", ".next", "dist", "build", "__pycache__", ".cache", ".turbo",
  ".vercel", ".output", "coverage", ".nyc_output", ".parcel-cache", "target",
]);

// Always left out, whatever the .gitignore says.
const DEFAULT_EXCLUDES = new Set([".git", ".DS_Store"]);

export type { FileNode };

// A folder's .gitignore added to the ones above it; the matching rules live in
// `lib/gitignore.ts`.
// A folder without its own .gitignore reuses the parent set as is: a set is
// never modified after this returns, and sharing it keeps its compiled rules
// instead of recompiling a copy in every folder.
function readIgnore(dir: string, base: string, parent?: IgnoreSet): IgnoreSet {
  const f = join(dir, ".gitignore");
  let content: string | null = null;
  try {
    if (existsSync(f)) content = readFileSync(f, "utf-8");
  } catch {}
  if (content === null && parent) return parent;
  const set = parent ? parent.clone() : new IgnoreSet();
  // A pattern that is not a valid regex throws halfway through the file: the
  // rules read before it stay, as they always have.
  try {
    if (content !== null) set.addFile(content, base);
  } catch {}
  return set;
}

/** The tree behind `GET /api/files`: `root` down to `depth` levels. */
export async function walkFileTree(root: string, depth: number): Promise<FileNode[]> {
  // Async walk (fs.promises): the old readdirSync + per-entry statSync ran
  // inside the request handler and stalled Bun's single event loop for the
  // whole scan — a large directory (monorepo folder) queued every other
  // client's requests and WS traffic behind it.
  //
  // ONE ENTRY AT A TIME, on purpose: each await hands the loop back between
  // syscalls. Stat-ing a folder's entries concurrently made the walk faster
  // but ran the whole tree's completions back to back: on this repo at depth 3
  // the loop did not turn for the walk's 17-20 ms, and a ping answered in
  // 11-14 ms instead of 0.2 (100 ms on ~/Projects), with the tree refetched at
  // every `files:changed`. The time the walk used to spend was the ignore
  // rules, 59 of 77 ms, and those are compiled once now (`lib/gitignore.ts`).
  // Every entry keeps its own catch, so a file that vanishes between readdir
  // and stat still comes out without a size instead of emptying its folder.
  async function readDirRecursive(dir: string, currentDepth: number, relBase: string, ignore: IgnoreSet): Promise<FileNode[]> {
    try {
      const entries = await readdirAsync(dir, { withFileTypes: true });
      entries.sort((a, b) => { if (a.isDirectory() && !b.isDirectory()) return -1; if (!a.isDirectory() && b.isDirectory()) return 1; return a.name.localeCompare(b.name); });
      const nodes: Array<FileNode | null> = [];
      for (const entry of entries) nodes.push(await (async (): Promise<FileNode | null> => {
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (DEFAULT_EXCLUDES.has(entry.name) || isTopicsSecretPath(entry.name)) return null;
        if (entry.isDirectory() && HEAVY_DIRS.has(entry.name)) return null;
        if (ignore.ignores(rel, entry.isDirectory())) return null;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const node: FileNode = { name: entry.name, type: "dir", path: fullPath };
          if (currentDepth < depth) {
            // This folder's .gitignore adds to the ones above and applies
            // from here down only, as in git.
            node.children = await readDirRecursive(fullPath, currentDepth + 1, rel, readIgnore(fullPath, rel, ignore));
          }
          return node;
        }
        if (!entry.isFile()) return null;
        try { const stats = await statAsync(fullPath); return { name: entry.name, type: "file", path: fullPath, size: stats.size, modified: stats.mtime.toISOString() }; } catch { return { name: entry.name, type: "file", path: fullPath }; }
      })());
      return nodes.filter((n): n is FileNode => n !== null);
    } catch {
      return [];
    }
  }
  return readDirRecursive(root, 1, "", readIgnore(root, ""));
}
