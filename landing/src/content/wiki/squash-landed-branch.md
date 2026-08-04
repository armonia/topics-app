---
title: Squash-landed branch
definition: >-
  A branch whose changes are all in main but whose commits are not, because landing squashed
  them into one new commit. Git's "is it merged" check answers about ancestry, so it says no,
  and any cleanup that trusts that answer either keeps everything or deletes the wrong thing.
updatedDate: 2026-08-04
pillar: worktrees
seeAlso:
  - worktree-reaping
  - landing-vs-approving
  - git-worktree-per-agent
---

A merge commit has two parents, so the branch remains an ancestor of `main` and
`git branch --merged` lists it. A squash creates one *new* commit with the same
tree and a single parent, and the branch's commits are not in the history at all.

Same result in the files. Completely different answer to "is this merged".

## Why it bites here specifically

Squash landing is the norm for agent work, because a task's fifteen intermediate
commits are not a history anyone wants. So in a workflow built on
[[git-worktree-per-agent]], nearly every completed branch is in exactly this
state, and any automated cleanup keyed to ancestry is wrong about nearly
everything.

There are two ways to be wrong and one of them destroys work:

- Trust `--merged` and nothing is ever cleaned up. Annoying.
- Compensate with a heuristic that is too eager and delete a branch that was
  never landed. Not annoying.

## The check that works

Compare content, not ancestry. Does the diff between this branch and its base
already appear in the target? `git cherry` answers a version of this, and so does
diffing the trees directly. It is slower than reading a flag and it is correct.

## The corollary for delivery

Because "merged" is not a reliable local signal, the moment work lands should be
recorded as a fact rather than inferred later from the shape of the graph.
Guessing after the fact is exactly the problem this entry describes.
