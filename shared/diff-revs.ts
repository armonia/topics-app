/**
 * The two revisions a board diff compares, as full SHAs: the wire field `revs`
 * of `GET /boards/:p/tasks/:t/diff` and `GET /boards/:p/publish-diff`.
 *
 * The diff's own `range` is a selector for `git diff` and may be symbolic
 * (`main`, `sha^1`, `origin/x`): a name moves, a SHA does not. The panel asks
 * for a file's bytes at one of these two SHAs, and the byte route accepts only
 * these two, so what is shown is always the content the list names.
 */
export interface DiffRevs {
  /** The Before. Can be the empty tree when the oldest commit is the root. */
  base: string;
  /** The After, or `null` when it is the working tree of a live worktree. */
  head: string | null;
}
