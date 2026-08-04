---
title: Topic
definition: A topic is one unit of work that holds everything belonging to it — the agent conversation, a real terminal, the project files and their diffs, a browser, and what the turns cost — instead of scattering them across four windows that only your memory connects.
updatedDate: 2026-08-04
pillar: parallel-agents
seeAlso:
  - pane
  - agent-turn
  - dispatch
---

The unit most tools pick is the *file* or the *session*. Neither survives contact
with agents. A file is too small — the work is a change across a dozen of them. A
session is too thin: it remembers the conversation and forgets the branch it was
on, the server it started, and the page it was looking at.

A topic is the unit in between. It is scoped to a piece of work, and everything
that piece of work touches belongs to it.

## What it holds

The conversation with the agent. One or more terminals, with their scrollback. The
project directory, its diffs and its git state. A browser, if the work involves
looking at something. And the running total of what the turns have cost.

## Why the grouping matters more than it sounds

The expensive part of switching work is not finding the files. It is rebuilding
the *situation*: which branch, which server was running on which port, what the
agent had already tried, which of the four terminals was the one that mattered.
That reconstruction is minutes, and it happens every time.

If the situation is the unit, switching is a click, because nothing was
disassembled in the first place.

## The consequence for parallel agents

Once work is grouped this way, running several agents at once stops being a
question of window management. Each topic is already a self-contained context; a
second agent working a second topic is not competing for anything the first one
needs — which is precisely what makes [[git-worktree-per-agent]] the natural
companion rather than an extra feature.

## In Topics

A topic survives a restart and a second machine: panes, splits, tabs and the
terminal scrollback come back in the shape you left them.
