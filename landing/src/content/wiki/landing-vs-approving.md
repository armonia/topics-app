---
title: Landing vs approving
definition: Approving accepts an agent's work; landing merges it into your main branch; publishing pushes it to a remote. Collapsing the three into one button is how code you have not read ends up somewhere you cannot easily take it back from.
updatedDate: 2026-08-04
pillar: worktrees
seeAlso:
  - git-worktree-per-agent
---

When an agent finishes a task in its own worktree, its work exists on a branch
and nowhere else. Three separate things can happen to it, and they have
different blast radii:

| Action | What changes | How hard to undo |
|---|---|---|
| **Approve** | The task's state. No code moves. | Trivial |
| **Land** | Your local `main` gains the commits. | A local reset |
| **Publish** | The remote gains them. CI runs. Others pull. | Depends who pulled |

Treating them as one gesture is tempting, because the work is good and you want
it through. It is also how an unattended board ends up pushing to a remote at
three in the morning.

## Why approving is not enough

The mirror-image mistake is quieter and more common. If approving only marks the
task done, the code stays in an isolated worktree that nobody is looking at.
Everyone believes the task shipped; the branch sits there; a fortnight later the
worktree is garbage-collected and the work is gone.

So approving without landing is not "safe", it is a different way to lose the
work. The gate is worth having only if the landing step is a real, visible thing
someone does.

## Squash-landed branches

Once landing squashes, a branch whose content is in `main` no longer shares a
commit with it. Ask git whether the branch is merged and it says no, because it
is answering a question about ancestry, not about content.

Any cleanup that deletes "unmerged" branches will therefore refuse to delete
branches that are actually done — or, worse, a cleanup that trusts the opposite
heuristic will delete work that never landed. The reliable test is by content,
not by ancestry.

## In Topics

The three actions are three clicks. An agent can deliver, comment and move its
own card to review; it cannot approve its own work, it cannot land, and it never
pushes. The board also refuses to accept a task into review while its worktree
is dirty, because "done" should mean something you can read as a diff.
