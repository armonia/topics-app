/**
 * When the changed-files strip names a branch.
 *
 * The rule has one input that matters, the topic's worktree binding: without
 * it the branch is the project's, already shown elsewhere, and the strip stays
 * silent about it even when git answered. With it the branch is the topic's
 * own and it shows, but only if git had something to say.
 *
 * @covers CHAT-CHANGES-01
 */
import { describe, test, expect } from 'bun:test';
import { branchLabelFor } from './changesStripBranch';
import type { TopicChangesGit } from '../../../shared/topic-changes';

const git: TopicChangesGit = { root: '/repo/.worktrees/wt-1', branch: 'task/wt-1', dirty: 2 };

describe('branchLabelFor', () => {
  test('a topic without a worktree names no branch, even when git answered', () => {
    expect(branchLabelFor({ worktreeId: null }, git)).toBeNull();
    expect(branchLabelFor({ worktreeId: undefined }, git)).toBeNull();
    expect(branchLabelFor({}, git)).toBeNull();
  });

  test('a topic bound to a worktree names the branch git reported', () => {
    expect(branchLabelFor({ worktreeId: 'wt-1' }, git)).toBe('task/wt-1');
  });

  test('a topic bound to a worktree, but outside a repository, names nothing', () => {
    expect(branchLabelFor({ worktreeId: 'wt-1' }, null)).toBeNull();
  });
});
