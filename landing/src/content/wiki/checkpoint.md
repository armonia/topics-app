---
title: Checkpoint
definition: >-
  A saved point in a session you can return to, taking the working tree back with you. It is
  the answer to an agent that went somewhere wrong twenty minutes ago and has been building on
  it since.
updatedDate: 2026-08-04
pillar: substrate
seeAlso:
  - agent-turn
  - auto-compaction
---

Long agent sessions fail in a particular way: not with an error, but with a wrong
turn that is only obvious later. By the time you notice, the conversation has
built on it, the files have moved on, and undoing means either arguing with the
agent about what it did or unpicking the diff by hand.

A checkpoint makes that a single action. Go back to the state before the wrong
turn (conversation and files together) and try a different instruction.

## Conversation and files, or neither

Rolling back only the conversation leaves the agent looking at a working tree
that reflects decisions it no longer remembers making, which produces the most
confusing failures in the whole category. Rolling back only the files leaves it
convinced of changes that are gone.

The pairing is the feature. A checkpoint that covers one and not the other is
worse than none, because it looks like it worked.

## Why not just git

Git is the right substrate and the wrong interface here. Committing every turn
produces a history nobody wants to read and that has to be squashed before it can
land; not committing means there is nothing to go back to. A checkpoint is the
in-between: cheap, unnamed, local, and expected to be thrown away.

## What it does not fix

Anything outside the tree: a migration already applied to a database, a request
already sent, a file written outside the project. Going back in the conversation
does not go back in the world, and an agent that has run a destructive command
has run it.
