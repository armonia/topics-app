---
title: Worktree reaping
definition: Removing a git worktree once its work has landed. Skipping it leaves branches, disk and (worse) anything still pointing at that directory in a state that looks broken rather than finished.
updatedDate: 2026-08-04
pillar: worktrees
seeAlso:
  - git-worktree-per-agent
  - squash-landed-branch
  - landing-vs-approving
---

If every dispatched task creates a [[git-worktree-per-agent]], something has to
remove them. Left alone they accumulate: a branch each, a checkout each, and a
directory that other things may still be referencing.

## The failure that is hard to diagnose

The obvious cost is disk. The expensive one is a dangling reference: a session, a
terminal or a topic whose working directory was that worktree. Reap the directory
without telling them and they do not report an error. They simply stop working,
in a way that reads as the application being broken rather than as a directory
having been removed.

Which means reaping is not a cleanup job that can run blindly. It has to know
what still points at the thing it is about to delete.

## Deciding what is safe to remove

The tempting test is "is the branch merged", and it is wrong once landing squashes. See [[squash-landed-branch]]. A squashed branch shares no commit with
`main` even though its content is entirely there, so an ancestry test says "not
merged" about work that is completely done.

The test that survives is by content: is what this branch changed already present
in the target. And the safe default when the answer is unclear is to keep it. An extra directory costs disk, a wrong deletion costs work.

## Uncommitted changes are a veto

A worktree with uncommitted changes is never safe to remove automatically, no
matter how finished the task looks. That is the one case where the right
behaviour is to stop and say so.
