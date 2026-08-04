---
title: Auto-compaction
definition: The automatic summarising of older context when a session approaches the model's window limit. It keeps long sessions alive, and it is also the moment a watchdog is most likely to mistake a working agent for a dead one.
updatedDate: 2026-08-04
pillar: cost
seeAlso:
  - context-window
  - agent-turn
  - checkpoint
---

As a conversation approaches the [[context-window]] ceiling, something has to
give. Compaction replaces the older middle of the conversation with a summary,
freeing room while keeping the thread.

It is genuinely useful and it is lossy in a specific way: the summary keeps what
was *said* and loses the exact text. Details that were never restated — a precise
error string, an exact path, a number — do not survive. Anything the rest of the
session depends on verbatim should be written into a file or a standing
instruction rather than trusted to survive a compaction.

## The operational trap

Compaction takes time and produces no output while it runs. From outside, a
session that is compacting looks exactly like a session that has hung: no tokens,
no tool calls, nothing on screen.

Any supervisor with an inactivity timeout will therefore eventually kill a
healthy session in the middle of compacting it, and it will do so
preferentially to *long* sessions, which are the expensive ones you least want to
lose. If a watchdog exists, compaction has to be a state it knows about, not an
absence of activity it infers from.

## Notice when it happens

A session that has compacted is not the same session, in the sense that matters:
it now knows a summary of what it used to know precisely. That is worth being
told about. Both to judge a strange answer afterwards, and because it is often
the signal that the session should have been split into two.
