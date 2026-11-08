/**
 * A set of changes the diff panel reads: one declaration for both sides.
 *
 * Three routes answer with it: a card's diff (`GET /boards/:p/tasks/:t/diff`),
 * a publish (`GET /boards/:p/publish-diff`) and a topic's changeset
 * (`GET /topics/:id/changes/diff`). The server types what it builds with these
 * (`server/lib/git-diff-stat.ts`), the client derives its `DiffFileStat` and
 * `DiffBundle` from them (`client/src/lib/board.ts`): a field renamed on one
 * side fails the typecheck on the other, instead of reaching the panel as an
 * `undefined`.
 */
import type { DiffRevs } from './diff-revs';

/** One file of the set, as `git diff --numstat` and `--name-status` describe it. */
export interface ChangeSetFile {
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

export interface ChangeSet {
  /** Every file of the set: complete by contract, `--numstat` has no cap. */
  stat: ChangeSetFile[];
  /** The unified diff, cut at the server's payload cap. */
  patch: string;
  /** `patch` was cut: the files past the cut are read one by one (`?file=`). */
  truncated: boolean;
  /** The two SHAs the set compares; `null` = no byte of a file can be asked for. */
  revs: DiffRevs | null;
}
