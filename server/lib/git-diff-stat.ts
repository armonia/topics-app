/**
 * Which files a `git diff` selector touches, and by how much.
 *
 * The stat half of the task drawer's diff bundle (`routes/tasks.ts`), out here
 * so the chat's changed-files strip reads a task's range the same way the
 * drawer does: same numstat, same name-status letter, same untracked files
 * listed as `A`. Two surfaces answering "what did this card change" with two
 * parsers would sooner or later answer it two ways.
 */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { gitRead } from "./git-porcelain";
import { parseNumstatZ } from "./git-numstat";

export interface DiffStatEntry {
  path: string;
  /** Lines added; `-1` for a binary file, where git prints `-` and counts nothing. */
  additions: number;
  /** Lines removed; `-1` for a binary file. */
  deletions: number;
  /** The `--name-status` letter (A, M, D, R, C, T). Untracked files are `A`. */
  status: string;
  /** Only on a rename or copy (`R`, `C`): the OLD path, where the diff panel reads a picture's Before. */
  origPath?: string;
}

/**
 * Cap on how many untracked files get folded in. A runaway worktree
 * (node_modules never gitignored, a build dir...) must not read thousands of
 * files to draw a list nobody scrolls.
 */
export const UNTRACKED_FILE_CAP = 500;

/** git's own `core.bigFileThreshold` default: past it a file is diffed as binary. */
const BIG_FILE_BYTES = 512 * 1024 * 1024;
/** git looks for a NUL in this many leading bytes to call a file binary. */
const BINARY_SNIFF_BYTES = 8000;
const LINE_FEED = 0x0a;
const UNTRACKED_READS_AT_ONCE = 16;

/**
 * The `diff` attribute of each path, from ONE `git check-attr` for the whole
 * list: `unset` (`-diff`, or the `binary` macro) is binary whatever the bytes
 * say, `set` is text even with a NUL. Lockfiles and generated data are marked
 * this way in real projects, and the patch of the same bundle already says
 * «Binary files differ» for them.
 */
async function diffAttributes(cwd: string, paths: string[]): Promise<Map<string, string>> {
  const byPath = new Map<string, string>();
  if (!paths.length) return byPath;
  const out = (await runGitRead(cwd, ["check-attr", "-z", "diff", "--", ...paths])).text.split("\0");
  // `-z` prints `<path> NUL <attribute> NUL <value> NUL` per path.
  for (let i = 0; i + 2 < out.length; i += 3) byPath.set(out[i]!, out[i + 2]!);
  return byPath;
}

/**
 * What `git diff --no-index --numstat /dev/null <file>` prints for an
 * untracked file, counted here instead. That was one git process per file, in
 * sequence, and the chat's strip asks at the end of every turn: 50 untracked
 * artifacts cost 685 ms and 50 spawns. A symlink is its target's path, one line
 * with no newline; a NUL in the first 8000 bytes is binary (`-1`), as git has
 * it, unless the `diff` attribute (`diffAttributes`) already decided.
 */
async function untrackedCounts(path: string, diffAttr: string | undefined): Promise<{ additions: number; deletions: number }> {
  const binary = { additions: -1, deletions: -1 };
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { additions: 1, deletions: 0 };
    if (!info.isFile()) return { additions: 0, deletions: 0 };
    if (diffAttr === "unset" || info.size > BIG_FILE_BYTES) return binary;
    const sniff = diffAttr !== "set";
    let lines = 0;
    let seen = 0;
    let last = LINE_FEED;
    // Streamed: an untracked dump or video is counted without holding it in memory.
    const reader = Bun.file(path).stream().getReader();
    try {
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        const chunk = read.value;
        if (sniff && seen < BINARY_SNIFF_BYTES && chunk.subarray(0, BINARY_SNIFF_BYTES - seen).includes(0)) return binary;
        for (let i = chunk.indexOf(LINE_FEED); i !== -1; i = chunk.indexOf(LINE_FEED, i + 1)) lines++;
        if (chunk.length) last = chunk[chunk.length - 1]!;
        seen += chunk.length;
      }
    } finally {
      // Closes the file when a binary stopped the read early.
      reader.cancel().catch(() => {});
    }
    return { additions: seen && last !== LINE_FEED ? lines + 1 : lines, deletions: 0 };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

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
 * `git diff --name-status -z`: path -> status letter, plus the old path of a
 * rename or copy. Each record is the status, then one path, or two on a rename
 * or copy (`R100`, `C75`), OLD then NEW; the key is the new one, the path
 * `--numstat` reports too.
 */
function parseNameStatusZ(text: string): Map<string, { letter: string; origPath?: string }> {
  const byPath = new Map<string, { letter: string; origPath?: string }>();
  const fields = text.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const letter = fields[i]?.[0];
    if (!letter) continue;
    const origPath = letter === "R" || letter === "C" ? fields[++i] : undefined;
    const path = fields[++i];
    if (path) byPath.set(path, origPath ? { letter, origPath } : { letter });
  }
  return byPath;
}

/**
 * The per-file stat of `range` (any `git diff` selector: an `a..b` range, or a
 * single revision compared with the working tree).
 *
 * `includeUntracked` folds in the files git does not track yet: plain `git
 * diff` ignores them, so a task whose only output is a brand-new file would
 * read as an empty diff. They come back as `A`, counted as git counts them
 * against /dev/null (`untrackedCounts`), and are also returned in `untracked`
 * for a caller that wants their patch. Only meaningful when the range ends on
 * the working tree.
 */
export async function gitDiffStat(
  cwd: string,
  range: string,
  opts: { includeUntracked?: boolean; untrackedCap?: number } = {},
): Promise<{ stat: DiffStatEntry[]; untracked: string[] }> {
  // -z: without it git quotes a path with a non-ASCII letter in octal
  // (`"docs/citt\303\240.md"`) and prints a rename as `a/{x => y}/f`, and
  // neither matches the path a tool call names.
  const [numstat, nameStatus] = await Promise.all([
    runGitRead(cwd, ["diff", "--numstat", "-z", range]).then((r) => parseNumstatZ(r.text)),
    runGitRead(cwd, ["diff", "--name-status", "-z", range]).then((r) => parseNameStatusZ(r.text)),
  ]);
  const stat: DiffStatEntry[] = [...numstat].map(([path, n]) => {
    const named = nameStatus.get(path);
    return {
      path,
      additions: n.binary ? -1 : n.added,
      deletions: n.binary ? -1 : n.removed,
      status: named?.letter ?? "M",
      ...(named?.origPath ? { origPath: named.origPath } : {}),
    };
  });

  const untracked: string[] = [];
  if (opts.includeUntracked) {
    // -z: NUL-separated, so paths with spaces/newlines survive intact.
    const others = (await runGitRead(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).text;
    const files = others.split("\0").filter(Boolean).slice(0, opts.untrackedCap ?? UNTRACKED_FILE_CAP);
    const attrs = await diffAttributes(cwd, files);
    // A few at a time: 500 open files at once would compete with the server's own descriptors.
    for (let i = 0; i < files.length; i += UNTRACKED_READS_AT_ONCE) {
      const batch = files.slice(i, i + UNTRACKED_READS_AT_ONCE);
      const counts = await Promise.all(batch.map((f) => untrackedCounts(join(cwd, f), attrs.get(f))));
      batch.forEach((f, j) => stat.push({ path: f, ...counts[j]!, status: "A" }));
      untracked.push(...batch);
    }
  }
  return { stat, untracked };
}
