/**
 * The git status of a working tree, computed ONCE and in five spawns.
 *
 * WHAT THERE WAS. Two copies of the same procedure, one in the route
 * (`GET /api/git/status`, routes/files.ts) and one in the watcher
 * (git-watcher.ts), each spawning eight git processes per call on a normal
 * branch: rev-parse --git-dir, status, branch --show-current, log -1,
 * rev-list --left-right, rev-parse --show-toplevel, and the two numstats.
 * With two project panels open that was about one git subprocess per second
 * in steady state, on a machine at loadavg 33, and the two copies had already
 * drifted once (the symlink prefix bug the watcher's comment records).
 *
 * WHAT THERE IS. One function, called by both, and five spawns:
 *  - `rev-parse --git-dir --show-toplevel`: is it a repo, and where is its
 *    root (one answer per line; a non-zero exit is "not a repo");
 *  - `status --porcelain -z --branch`: the files AND the `## branch...upstream
 *    [ahead N, behind M]` header, which replaces both `branch --show-current`
 *    and `rev-list --left-right --count`;
 *  - `log -1`: the last commit, with `%h` standing in for the branch label of
 *    a detached HEAD (it used to be a separate `rev-parse --short HEAD`);
 *  - the two numstats (`lib/git-numstat.ts`), unchanged.
 * The last three run in parallel: the count is what costs, the wall time is
 * a bonus.
 */
import { gitRead, parsePorcelainZ, repoPrefixOf, scopeToPrefix, statusOfPrefix } from "./git-porcelain";
import type { PorcelainEntry } from "./git-porcelain";
import { attachNumstats, readNumstats } from "./git-numstat";

/** A porcelain entry with its per-side line counts attached (`lib/git-numstat.ts`). */
export type GitStatusFileEntry = ReturnType<typeof attachNumstats<PorcelainEntry>>[number];

export interface GitStatus {
  branch: string;
  lastCommit: { hash: string; message: string; author: string; ago: string };
  files: GitStatusFileEntry[];
  ahead: number;
  behind: number;
  /** The opened folder is itself untracked by the repo that contains it. */
  folderUntracked: boolean;
  /** The repo that HOSTS the opened folder (empty at the repo root). */
  repoName: string;
}

/** `git status --porcelain -z --branch`: the entries plus a leading `## ` record. */
export const STATUS_BRANCH_ARGS = gitRead("status", "--porcelain", "-z", "--branch");

export interface BranchHeader {
  /** The branch name; `null` on a detached HEAD. */
  branch: string | null;
  ahead: number;
  behind: number;
}

/**
 * The `## ...` record of `status --branch`, in the shapes git prints:
 *   `## main`, `## main...origin/main`, `## main...origin/main [ahead 1, behind 2]`,
 *   `## main...origin/main [gone]`, `## HEAD (no branch)`,
 *   `## No commits yet on main` (and the older `## Initial commit on main`).
 */
export function parseBranchHeader(header: string): BranchHeader {
  const body = header.replace(/^##\s*/, "");
  if (/^HEAD \(no branch\)/.test(body)) return { branch: null, ahead: 0, behind: 0 };
  const unborn = body.match(/^(?:No commits yet|Initial commit) on (.+)$/);
  if (unborn) return { branch: unborn[1], ahead: 0, behind: 0 };
  let ahead = 0;
  let behind = 0;
  const bracket = body.match(/\s\[([^\]]*)\]$/);
  let head = body;
  if (bracket) {
    head = body.slice(0, body.length - bracket[0].length);
    const a = bracket[1].match(/ahead (\d+)/);
    const b = bracket[1].match(/behind (\d+)/);
    if (a) ahead = parseInt(a[1], 10) || 0;
    if (b) behind = parseInt(b[1], 10) || 0;
  }
  const dots = head.indexOf("...");
  const branch = dots >= 0 ? head.slice(0, dots) : head;
  return { branch, ahead, behind };
}

/** Split the `-z` output into the `## ` header (if any) and the entries text. */
export function splitBranchHeader(text: string): { header: string | null; entries: string } {
  if (!text.startsWith("## ")) return { header: null, entries: text };
  const nul = text.indexOf("\0");
  if (nul < 0) return { header: text, entries: "" };
  return { header: text.slice(0, nul), entries: text.slice(nul + 1) };
}

async function readText(args: string[], cwd: string): Promise<{ code: number; text: string }> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return { code: proc.exitCode ?? 1, text };
}

/**
 * The status of `resolvedDir`, or `null` when it is not inside a git repo.
 * Other failures throw: the route turns them into a 500, the watcher into a
 * skipped push.
 */
export async function computeGitStatus(resolvedDir: string): Promise<GitStatus | null> {
  const probe = await readText(["git", "rev-parse", "--git-dir", "--show-toplevel"], resolvedDir);
  if (probe.code !== 0) return null;
  const gitRoot = probe.text.split("\n")[1]?.trim() ?? "";
  // Same prefix rule as always (`repoPrefixOf` compares REAL paths: a folder
  // reached through a symlink, `/tmp` on macOS, would otherwise get no prefix).
  const scope = gitRoot ? repoPrefixOf(resolvedDir, gitRoot) : { prefix: "", repoName: "" };

  const [status, log, numstats] = await Promise.all([
    readText(STATUS_BRANCH_ARGS, resolvedDir),
    readText(["git", "log", "-1", "--format=%h|%H|%s|%an|%ar"], resolvedDir),
    readNumstats(resolvedDir),
  ]);

  const { header, entries } = splitBranchHeader(status.text);
  const branchInfo = header ? parseBranchHeader(header) : { branch: null, ahead: 0, behind: 0 };
  const [short = "", hash = "", message = "", author = "", ago = ""] = log.text.trim().split("|");
  // Detached HEAD: the short hash is the label, as `rev-parse --short HEAD` was.
  const branch = branchInfo.branch ?? (short || "HEAD");

  // Raw 2-char XY codes, never trimmed: the client reads them by position.
  const parsed = parsePorcelainZ(entries);
  const files = attachNumstats(scopeToPrefix(parsed, scope.prefix), numstats, scope.prefix);
  const folderUntracked = statusOfPrefix(parsed, scope.prefix) === "??";

  return {
    branch,
    lastCommit: { hash, message, author, ago },
    files,
    ahead: branchInfo.ahead,
    behind: branchInfo.behind,
    folderUntracked,
    repoName: scope.repoName,
  };
}
