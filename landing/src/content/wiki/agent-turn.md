---
title: Agent turn
definition: A turn is one complete cycle of request, reasoning, tool calls and reply. It is the unit that cost, latency and context growth are all measured in, which makes it the only honest thing to count when you want to know what an agent is spending.
updatedDate: 2026-08-04
pillar: cost
seeAlso:
  - effort-level
  - prompt-caching
  - context-window
---

A turn starts when you send something and ends when the agent stops and hands
control back. In between it may think, call tools, read files, run commands and think again. All of that is one turn, however long it took and however many
round trips it made internally.

## Why the unit matters

Counting messages tells you nothing: one message can be a typo correction and the
next can be forty tool calls. Counting tokens tells you the size but not the
shape. The turn is the only boundary where all three questions line up: what did it cost, how long did it take, how much bigger is the context now.

It is also the unit a person actually experiences. "It took three turns" is a
real sentence about how the work went. "It took 180,000 tokens" is not.

## What a turn costs

Four things, and only the first is obvious. The input is everything resent this
turn: system prompt, tool definitions, whole history. The reasoning is however
much thinking was asked for, which is what [[effort-level]] decides. The output
is what came back, priced higher than input and never cached.

The fourth is tools, and it is the one that catches people out.

Reading a large file into the
conversation is not a one-off cost. It is now part of the context and you pay
for it on every subsequent turn until something compacts it away.

Cost is recorded per message and per task, so "what did this turn cost" is a
number you can look at rather than a share of a monthly total.
