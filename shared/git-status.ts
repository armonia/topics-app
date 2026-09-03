/**
 * The git status of an opened folder as it travels on the wire, from
 * `GET /api/git/status` and from the watcher push to the client panel.
 *
 * One declaration for both sides. Until 2026-09-03 the client and
 * `server/lib/git-status.ts` each declared their own `GitStatus`, and the two
 * disagreed on the one field that bites: `lastCommit`.
 */

/** Per-side line counts of one changed file, from `git diff --numstat`. */
export interface GitLineStat {
  added: number;
  removed: number;
  /** git does not count the lines of a binary: `-`/`-`, not `0`/`0`. */
  binary?: boolean;
}

/** One changed file as `git status --porcelain` reports it. */
export interface GitStatusFile {
  /** The current path (for a rename: the NEW one). */
  path: string;
  /** The raw two-character XY code, never trimmed. */
  status: string;
  /** Renames and copies only: the path it came from. */
  origPath?: string;
  staged?: GitLineStat;
  unstaged?: GitLineStat;
}

export interface GitStatus {
  branch: string;
  /**
   * The last commit, `null` WHEN THERE IS NONE.
   *
   * The client type used to say it is always there, and the server has always
   * said otherwise: `server/routes/files.ts` answers `lastCommit: null` for a
   * folder that is not a repo, and a repo with no commit has no `git log -1`
   * to read it from. The client trusted the declaration and read
   * `gitStatus.lastCommit.hash` directly: measured on 2026-08-08, a
   * `TypeError: Cannot read properties of undefined (reading 'hash')` that the
   * ErrorBoundary turned into the whole project window VANISHING, with five
   * red tests blaming the processes panel, which was never even mounted.
   */
  lastCommit: { hash: string; message: string; author: string; ago: string } | null;
  files: GitStatusFile[];
  ahead: number;
  behind: number;
  /** The opened folder is itself untracked by the repo that contains it. */
  folderUntracked?: boolean;
  /** The repo that HOSTS the opened folder (empty at the repo root). */
  repoName?: string;
}
