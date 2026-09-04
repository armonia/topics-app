/**
 * What a topic has TOUCHED: the wire contract of `GET /api/topics/:id/changes`.
 *
 * One declaration for both sides. The server aggregates the write tool calls
 * of the topic's messages (`type: 'edit' | 'write'`) and, when the topic lives
 * in a git repo, crosses them with `git status` and `git diff --numstat`
 * LIMITED to those paths: the answer is what THIS conversation did, not the
 * state of the whole repository.
 */

/** What happened to the file, after git had its say. */
export type TopicChangeKind = 'created' | 'modified' | 'deleted';

export interface TopicChangedFile {
  /** Relative to the git root when the topic sits in a repo, absolute otherwise. */
  path: string;
  kind: TopicChangeKind;
  /** How many assistant turns wrote to this file. */
  turns: number;
  /** ISO timestamp of the last write tool call on it. */
  lastAt: string;
  /** Lines added, from `git diff --numstat`. Absent outside a repo. */
  added?: number;
  /** Lines removed, from `git diff --numstat`. Absent outside a repo. */
  removed?: number;
  /** git counts no line of a binary file: it prints `-`, not `0`. */
  binary?: boolean;
}

export interface TopicChangesGit {
  /** Absolute path of the repository root the paths are relative to. */
  root: string;
  /** Branch name, or the short hash on a detached HEAD. */
  branch: string;
  /** How many of the topic's OWN files git still reports as dirty. */
  dirty: number;
}

export interface TopicChanges {
  files: TopicChangedFile[];
  /** `null` when the topic has no folder, or its folder is not a repo. */
  git: TopicChangesGit | null;
}
