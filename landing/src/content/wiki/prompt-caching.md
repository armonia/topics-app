---
title: Prompt caching
definition: Prompt caching lets a provider reuse the already-processed prefix of a prompt instead of reading it again. It is the difference between paying for your system prompt once and paying for it on every single turn, and it breaks the moment anything near the front of the context changes.
updatedDate: 2026-08-04
pillar: cost
seeAlso:
  - effort-level
  - git-worktree-per-agent
---

A conversation with an agent is not a series of independent questions. Every
turn resends the whole context: the system prompt, the tool definitions, the
project instructions, and the entire history so far. Without caching you pay
full input price for all of it, every time, and the bill grows with the square
of the conversation, not with its length.

Caching marks a **prefix** as reusable. The provider keeps the processed form
for a short window, and subsequent turns that begin with byte-identical content
are charged at a fraction of the normal input rate.

## Prefix means prefix

This is the part that catches people. The cache matches from the first token
forward and stops at the first difference. Anything that changes near the front
invalidates everything after it, no matter how stable the rest is.

Things that quietly break a cache:

- A timestamp or a session id in the system prompt.
- Tool definitions that serialise in a different order between runs.
- A "current file" or "current branch" block placed before the static
  instructions instead of after them.
- Injecting one new tool in the middle rather than appending it at the end.

The fix is always the same shape: sort the stable material to the front, keep it
byte-stable, and let everything volatile live behind it.

## What it does not do

It does not make the model faster at thinking, and it does not reduce output cost, because output is never cached. It also expires: leave a session idle past the
cache window and the next turn pays full price to warm it again.

## In Topics

The stable prefix of a session is marked cacheable explicitly, and what the
cache actually did, how much was read from it against how much was written to it, is visible per turn rather than inferred at the end of the month. A cache
that silently stopped working looks exactly like a cache that is working, until
you can see the two numbers side by side.
