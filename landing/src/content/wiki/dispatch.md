---
title: Dispatch
definition: >-
  Dispatch is handing a task to an agent along with the environment it needs (working
  directory, model, effort level and an isolated checkout) so that starting work does not
  require a human to set the stage first.
updatedDate: 2026-08-04
pillar: parallel-agents
seeAlso:
  - kanban-agent-task
  - git-worktree-per-agent
  - effort-level
---

Running an agent by hand means doing four things before the interesting part: get
to the right directory, put the code in the right state, choose a model, and
explain what to do. Dispatch is the name for having that assembled automatically
from the task itself.

## What has to travel with the task

- **A working directory**, which for parallel work means [[git-worktree-per-agent]]
  rather than the checkout you are using.
- **A model and an [[effort-level]]**, decided per task rather than globally:
  a mechanical rename does not need deep reasoning and should not be billed for it.
- **The brief**, which is what should happen, where to look, and how anyone will
  know it worked. The part that cannot be automated, and the part that decides
  whether the result is any good.
- **A definition of done** that the agent can be held to.

## Capacity is part of it

Dispatch without a ceiling is a way to make a laptop unusable. Each agent is a
process with a model connection, a checkout and usually a dev server; eight of
them do not run eight times faster, they thrash. Concurrency has to be sized to
the machine, and ideally to whether the machine is currently being used by a
person.

## The brief is the whole game

An agent given a vague task returns vague work, and the loop that follows costs
more than writing the task properly would have. The rule that survives contact
with reality: if you cannot say how you will check it, it is not ready to be
dispatched.

## In Topics

A task on the board can be assigned to an agent, which picks it up with its
worktree, model and effort already set, and moves its own card to review when it
has committed something and attached evidence.
