---
title: Kanban agent task
definition: >-
  A unit of work on a board that an agent can pick up on its own, work in an isolated
  checkout, and hand back with evidence. It differs from an ordinary ticket in that the
  acceptance criteria have to be machine-checkable, not just human-readable.
updatedDate: 2026-08-04
pillar: parallel-agents
seeAlso:
  - dispatch
  - landing-vs-approving
  - git-worktree-per-agent
---

A board of tasks is an old idea. What changes when the worker is an agent is that
the *writing* of the task stops being administrative overhead and becomes the
work, because the agent will do exactly what the card says, including the parts
you left ambiguous.

## What a card has to carry

- **What should happen**, in terms of observable behaviour rather than
  implementation.
- **Where to look**, meaning the files, the surface, the reproduction.
- **How anyone will know it worked.** A command that passes, a screenshot, a
  behaviour you can point at. Without this the card cannot be closed honestly.

The third one is the one that gets skipped and the one that matters. A task
without a check is a task whose completion is a matter of opinion, and an agent
will always have the more generous opinion.

## Delivery is committed work

"Implemented" and "committed" are different claims, and only the second can be
reviewed. A task that reaches review with an uncommitted working tree is not
ready, it is a description of something that happened on a machine.

The corollary is that the agent should move its own card to review. It is the
only party that knows when it is finished, while a human decides what happens
next. See [[landing-vs-approving]].

## Subtasks are a checklist, not a queue

Splitting a task into subtasks is a way to structure one piece of work. It is not
a way to defer scope: work that turns out to be a different job belongs in a new
top-level task, not as an open child of the one being delivered. A task with open
children cannot honestly be accepted.
