---
title: A commit about a landing page deleted two React components
description: >-
  Two agents shared one checkout, so they shared one git index. A commit that touched only the
  marketing demo swept in another agent's staged deletions and left main importing two files
  that no longer existed, for forty-one minutes.
pubDate: 2026-08-05
pillar: worktrees
format: field-notes
seoTarget: git worktree for parallel ai coding agents
wiki:
  - git-worktree-per-agent
  - worktree-reaping
  - squash-landed-branch
---

On 2 June 2026 at 19:54 a commit landed here called *"realistic app demo:
faithful dark IDE chrome, generic data"*. Its diff touches five files. Three of
them are the marketing demo it says it is about. The other two are
`ClaudePhaseDot.tsx` and `ClaudeSessionContext.tsx`, deleted, 221 lines gone.

Four files still imported them. Main was broken for forty-one minutes.

Nobody made a mistake. Two agents were working the repository at once and
sharing one checkout, which means sharing one git index, and the index does not
know which of them put something in it.

## What the index actually is

A commit does not read your working tree. It reads the index, the staging area
`git add` writes to, and the index belongs to the checkout rather than to
whoever is typing.

So the sequence needs no bug to go wrong:

1. Agent A runs `git rm ClaudePhaseDot.tsx ClaudeSessionContext.tsx`. That
   command **stages** the deletion. A is not finished: the imports still need
   removing, and those edits are unstaged.
2. Agent B, working on the landing demo, commits its own work.
3. B's commit takes the whole index, which now contains A's two deletions.

B did nothing careless. It committed what git told it was staged. A's
half-finished work went out under B's message, with the half that would have
made it compile left behind.

## The part that makes it worse

`git commit -- <pathspec>` looks like the fix. Name your own files, commit only
those, stay out of everyone else's way.

It is not the fix, and it fails in a more confusing direction: with a pathspec,
git commits the **working-tree** version of those paths and ignores the index
entirely. If another agent has uncommitted edits in a file you named, your
commit swallows them. Not their staged version: whatever happens to be on disk
at that instant.

One habit stages another agent's deletions; the other habit commits another
agent's live edits. Both of them look like being careful.

## Why a worktree is a different answer from a branch

A branch is a name for a commit. Two agents on two branches in one checkout
still share one index, one working tree and one `HEAD`, so a branch changes
nothing about any of the above.

`git worktree add` gives a second directory with its own index, its own `HEAD`
and its own files, backed by the same object database. Two agents in two
worktrees cannot stage into each other's index because there is no "each
other's index" to reach. The failure above stops being a rule to remember and
becomes a thing that cannot be expressed.

The cost is real and worth stating: a worktree is a full checkout, so it is disk
and a `node_modules` decision, and it needs removing afterwards or you collect
dozens. That is the trade: disk in exchange for a class of failure.

## What we do now

Every dispatched task gets its own worktree on its own branch. The agent commits
there, and the merge back into main is a separate, human click, so a broken
intermediate state cannot reach the branch anyone else is building on.

When several sessions do share a checkout, which happens constantly whenever a
person and an agent are in the same directory, the rules are narrower than they
look:

- Never `git add -A` or `git commit -a`. They take the shared index by
  definition.
- Never leave anything staged across time. If you are not committing now, use
  plain `rm` rather than `git rm`, so nothing waits in the index to be swept up
  by the next commit anyone makes.
- Do not assume `HEAD` is where you left it. Between two of your commands
  another session may have committed; check before comparing against a baseline.
- Avoid `git stash` here. Staged deletions round-trip through stash badly, and
  the deletion can come back without the file.

## Method

The incident is `adbe89ce`, 2 June 2026 19:54, and its repair is `6ad47678` at
20:35, one commit later. `git show --stat adbe89ce` is where the two unrelated
deletions are visible. That four files still imported the deleted modules is
`git grep -l ClaudePhaseDot adbe89ce -- client/src`, which returns `App.tsx`,
`PaneTabBar.tsx`, `TopicItem.tsx` and `TopicTree.tsx`. Every number here is a
command anyone can run against the public repository.

## Limits

One incident on one repository, and it is our own, so treat the frequency claim
with suspicion. We have not counted how often this happens in general, only that
it happened here and cost forty-one minutes.

Nor does a worktree per agent solve the interesting problem. It removes
collisions in the index and the working tree; it does nothing about two agents
editing the same function in two branches and both being right, which merges
into a conflict a person has to read. Isolation buys you the boring failures
back. The hard ones are unaffected, and pretending otherwise is how a
[worktree per agent](/wiki/git-worktree-per-agent/) gets sold as more than it
is.
