---
title: Context window
definition: >-
  The ceiling on how much text a model can see in one turn. Now that a million tokens is an
  ordinary size, the binding question has changed from "will it fit" to "what does it cost to
  keep it there", because everything in the window is re-read and re-billed every turn.
updatedDate: 2026-08-04
pillar: cost
seeAlso:
  - agent-turn
  - prompt-caching
  - auto-compaction
---

Everything the model considers has to be inside the window: the system prompt,
the tool definitions, the project instructions, every message so far, and every
file the agent has read along the way.

## The change nobody has fully absorbed

When windows were small, the window was a *constraint*: the discipline was
fitting. Now that a million tokens is available, the constraint has moved. It
fits. The question is what it costs to have it there.

Because the whole window is input on every turn, a context you have let grow to
half a million tokens is half a million tokens of input on turn one, on turn two,
and on turn forty. The cost of a long session is not linear in its length; it is
closer to quadratic, and the thing that bends the curve back down is
[[prompt-caching]], which only works on the stable prefix.

## What actually fills it

Rarely the conversation. Usually tool output: a file read whole to change three
lines, a test run that printed everything, a directory listing of a repository.
Each of those is now permanent furniture until something removes it.

## Two ways to control it, and they are not the same

**Compaction** summarises the middle to make room. It is cheaper per turn, lossy, and it happens whether or not you are ready. See [[auto-compaction]].

**Scope** is deciding what enters at all. A grep that returns twenty lines
instead of a file that returns two thousand costs one hundredth as much, forever,
and loses nothing the work needed.

The second is the one worth building habits around. The first is what happens
when you did not.
