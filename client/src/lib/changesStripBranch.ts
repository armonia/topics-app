/**
 * Whether the changed-files strip names a branch, and which one.
 *
 * The branch is a fact about the topic's FOLDER, and for a topic that works in
 * the project's own checkout it is the same branch the project sidebar already
 * shows: repeating it under every chat is noise. A topic bound to an isolated
 * worktree is the other case, the one where the branch is news: it is the
 * topic's own branch, nowhere else on screen, and the file list without it does
 * not say where those files went.
 *
 * Pure on purpose: the strip renders what this returns, and the three cases
 * are pinned in the co-located test instead of in a browser.
 */
import type { Topic } from '../types';
import type { TopicChangesGit } from '../../../shared/topic-changes';

export function branchLabelFor(
  topic: Pick<Topic, 'worktreeId'>,
  git: TopicChangesGit | null,
): string | null {
  if (!topic.worktreeId) return null;
  if (!git) return null;
  return git.branch;
}
