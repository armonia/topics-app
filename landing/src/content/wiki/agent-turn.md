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
control back. In between it may think, call tools, read files, run commands and
think again — all of that is one turn, however long it took and however many
round trips it made internally.

## Why the unit matters

Counting messages tells you nothing: one message can be a typo correction and the
next can be forty tool calls. Counting tokens tells you the size but not the
shape. The turn is the only boundary where all three questions line up — what did
it cost, how long did it take, how much bigger is the context now.

It is also the unit a person actually experiences. "It took three turns" is a
real sentence about how the work went. "It took 180,000 tokens" is not.

## What a turn costs

Four things, and only the first is obvious:

- **Input**: everything resent this turn — system prompt, tools, whole history.
- **Reasoning**: how much thinking was asked for. See [[effort-level]].
- **Output**: what came back, priced higher than input and never cached.
- **Tools**: what the tool calls themselves returned, which then becomes input
  for the rest of the turn and for every turn after it.

The last one is the one that surprises people. Reading a large file into the
conversation is not a one-off cost — it is now part of the context and you pay
for it on every subsequent turn until something compacts it away.

## In Topics

Cost is recorded per message and per task, so "what did this turn cost" is a
number you can look at rather than a share of a monthly total.
