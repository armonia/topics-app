/**
 * Which files a `git diff` selector touches, and by how much.
 *
 * The stat half of the task drawer's diff bundle (`routes/tasks.ts`), out here
 * so the chat's changed-files strip reads a task's range the same way the
 * drawer does: same numstat, same name-status letter, same untracked files
 * listed as `A`. Two surfaces answering "what did this card change" with two
 * parsers would sooner or later answer it two ways.
 */
import { gitRead } from "./git-porcelain";

export interface DiffStatEntry {
  path: string;
  /** Lines added; `-1` for a binary file, where git prints `-` and counts nothing. */
  additions: number;
  /** Lines removed; `-1` for a binary file. */
  deletions: number;
  /** The `--name-status` letter (A, M, D, R, C, T). Untracked files are `A`. */
  status: string;
}

/**
 * Cap on how many untracked files get folded in. A runaway worktree
 * (node_modules never gitignored, a build dir...) must not spawn thousands of
 * git processes: each one costs a `--no-index` spawn.
 */
export const UNTRACKED_FILE_CAP = 500;

/** Run a read-only git in `cwd`. Never throws: a missing git or a vanished directory is code 1. */
export async function runGitRead(cwd: string, args: string[]): Promise<{ code: number; text: string }> {
  try {
    const proc = Bun.spawn(gitRead(...args), { cwd, stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return { code: proc.exitCode ?? 1, text };
  } catch {
    return { code: 1, text: "" };
  }
}

/**
 * The DESTINATION path of a `--numstat` line.
 *
 * On a rename git does not print a path: it prints the transformation, in two
 * shapes, `old => new` when the whole path changes and `dir/{a => b}/f.ts`
 * when only one segment does. Taken literally neither matches the `b/...` of
 * the patch, so the stat row was orphaned: no `+N -M` next to the name, and
 * the same file listed TWICE, once for the stat and once for the patch hunk.
 */
export function numstatPath(raw: string): string {
  const path = raw.trim();
  if (!path.includes("=>")) return path;
  // The braced shape first, since it sits inside the path: the group becomes
  // its right-hand side (empty means the segment disappears).
  const braced = path.replace(/\{([^{}]*?) => ([^{}]*?)\}/g, "$2");
  if (braced !== path) return braced.replace(/\/{2,}/g, "/");
  const arrow = path.split(" => ");
  return (arrow[arrow.length - 1] ?? path).trim();
}

function lineCount(raw: string | undefined): number {
  return raw === "-" ? -1 : Number.parseInt(raw ?? "0", 10) || 0;
}

/**
 * The per-file stat of `range` (any `git diff` selector: an `a..b` range, or a
 * single revision compared with the working tree).
 *
 * `includeUntracked` folds in the files git does not track yet: plain `git
 * diff` ignores them, so a task whose only output is a brand-new file would
 * read as an empty diff. They come back as `A`, counted against /dev/null (no
 * index mutation), and are also returned in `untracked` for a caller that
 * wants their patch. Only meaningful when the range ends on the working tree.
 */
export async function gitDiffStat(
  cwd: string,
  range: string,
  opts: { includeUntracked?: boolean; untrackedCap?: number } = {},
): Promise<{ stat: DiffStatEntry[]; untracked: string[] }> {
  const [numstat, nameStatus] = await Promise.all([
    runGitRead(cwd, ["diff", "--numstat", range]).then((r) => r.text),
    runGitRead(cwd, ["diff", "--name-status", range]).then((r) => r.text),
  ]);
  const statusByPath = new Map<string, string>();
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const p = parts[parts.length - 1] ?? ""; // rename: status\told\tnew, take new
    if (p) statusByPath.set(p, (parts[0] ?? "M")[0] ?? "M");
  }
  const stat: DiffStatEntry[] = numstat.split("\n").filter(Boolean).map((line) => {
    const parts = line.split("\t");
    const path = numstatPath(parts[parts.length - 1] ?? "");
    return { path, additions: lineCount(parts[0]), deletions: lineCount(parts[1]), status: statusByPath.get(path) ?? "M" };
  });

  const untracked: string[] = [];
  if (opts.includeUntracked) {
    // -z: NUL-separated, so paths with spaces/newlines survive intact.
    const others = (await runGitRead(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).text;
    for (const f of others.split("\0").filter(Boolean).slice(0, opts.untrackedCap ?? UNTRACKED_FILE_CAP)) {
      // A pure file compare, no index touched; exit code 1 just means "differs".
      const ns = (await runGitRead(cwd, ["diff", "--no-index", "--numstat", "--", "/dev/null", f])).text;
      const parts = (ns.split("\n").find(Boolean) ?? "").split("\t");
      stat.push({ path: f, additions: lineCount(parts[0]), deletions: lineCount(parts[1]), status: "A" });
      untracked.push(f);
    }
  }
  return { stat, untracked };
}
