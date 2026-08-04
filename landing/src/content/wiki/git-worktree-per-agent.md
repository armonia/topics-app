---
title: Git worktree per agent
definition: A git worktree is a second working copy of the same repository, checked out to its own branch in its own directory. Giving each coding agent one is what lets several of them edit the same project at once without touching each other's files.
updatedDate: 2026-08-04
pillar: worktrees
seeAlso:
  - landing-vs-approving
  - pty
---

`git worktree add` creates a second checked-out directory backed by the same
`.git` object store. Two worktrees share history, remotes and objects; they do
not share a working directory, an index, or a `HEAD`. That last part is the
whole point.

## Why it matters when the editor is an agent

A human working on two branches switches between them: one checkout, one thing
at a time. Agents do not take turns. Point three of them at one checkout and
they will each run `git add`, each write files, and each assume the tree they
read a second ago is the tree they are writing into.

The failure is not theoretical and it is not a merge conflict — a merge conflict
is git telling you it noticed. The quiet version is **a shared index**: two
processes staging into the same `.git/index` interleave, and one of them commits
a snapshot containing half of somebody else's work. Nothing errors. The commit
looks fine. The bug arrives days later in a file nobody remembers touching.

## What it does not solve

A worktree isolates the *files*. It does not isolate anything else the agent
touches: a dev server on a fixed port, a shared database, a lockfile in the home
directory, a global cache. Two agents in two worktrees running `bun run dev` are
still fighting over port 3000.

It also has to be cleaned up. An abandoned worktree keeps a branch alive, keeps
disk, and (if something else points at it) leaves the thing that pointed at it
in a state that looks broken rather than finished.

## In Topics

Every task dispatched from the board gets its own worktree on its own branch,
created as `git worktree add -b topics/<name> <path> <base>`. The agent works
there and nowhere else, which is what makes it safe to have four of them running
while you keep using your own checkout.

Delivery is a commit on that branch: the server refuses to move a task to review
while its worktree is dirty, because "implemented" and "committed" are different
claims and only one of them can be reviewed.
