/**
 * What a topic has TOUCHED: the wire contract of `GET /api/topics/:id/changes`.
 *
 * One declaration for both sides. The server aggregates the write tool calls
 * of the topic's messages (`type: 'edit' | 'write'`) and, when the topic lives
 * in a git repo, crosses them with `git status` and `git diff --numstat`
 * LIMITED to those paths: the answer is what THIS conversation did, not the
 * state of the whole repository. On a topic a task was dispatched to, the
 * task's own diff range (the drawer's) gives the files instead, and on a topic
 * bound to a live worktree no task owns, that worktree's own range: shell and
 * sub-agent writes show up too.
 */

/** What happened to the file, after git had its say. */
export type TopicChangeKind = 'created' | 'modified' | 'deleted';

export interface TopicChangedFile {
  /** Relative to the git root when the topic sits in a repo, absolute otherwise. */
  path: string;
  kind: TopicChangeKind;
  /** How many assistant turns wrote to this file. `0` = no write tool call named it: a shell command or a sub-agent did. */
  turns: number;
  /** ISO timestamp of the last write tool call on it; empty when `turns` is 0. */
  lastAt: string;
  /** Lines added, from `git diff --numstat`. Absent outside a repo. */
  added?: number;
  /** Lines removed, from `git diff --numstat`. Absent outside a repo. */
  removed?: number;
  /** git counts no line of a binary file: it prints `-`, not `0`. */
  binary?: boolean;
  /**
   * Counted on the topic's diff range (its task's, or its worktree's own)
   * rather than against the checkout's HEAD. The editor's diff compares HEAD
   * with the disk, so on these rows it would show a different change: they
   * open in the task's drawer, which draws the same range. Absent on a row
   * only the tool calls gave.
   */
  inRange?: boolean;
}

export interface TopicChangesGit {
  /** Absolute path of the repository root the paths are relative to. */
  root: string;
  /** Branch name, or the short hash on a detached HEAD. */
  branch: string;
  /** How many of the topic's OWN files git still reports as dirty. Not measured on a task's range. */
  dirty?: number;
}

export interface TopicChanges {
  files: TopicChangedFile[];
  /** `null` when the topic has no folder, or its folder is not a repo. */
  git: TopicChangesGit | null;
  /** The task whose diff range gave the rows marked `inRange`. */
  taskId?: string;
}
