---
title: Lossless reattach
definition: Reconnecting to a terminal session and getting back the whole scrollback, not just the last screen. Almost every embedded terminal gets this wrong, and the difference shows up exactly when it matters — when you want to know what happened while you were not looking.
updatedDate: 2026-08-04
pillar: substrate
seeAlso:
  - pty
  - pty-bridge
  - scrollback
---

Three different things get called the same word.

A *restart* gives you a new shell in the same directory. Whatever was running is
dead. A *lossy reattach* means the session survived and you get its current
screen back, but everything that scrolled past while you were away is gone. That
is what most implementations do, and it is where the interesting output usually
was. A *lossless reattach* gives you the session and its full history, exactly as
if you had been watching the whole time.

## Why the third one is the only useful one here

The whole reason to leave an agent running is to read what it did afterwards. If
reattaching gives you the last twenty-four lines, then the compile error at line
four hundred (the reason you came back) is not there.

## What it takes

The [[pty-bridge]] must keep a bounded buffer of the byte stream, not of rendered
frames, because terminal output is a stream of control sequences and replaying it
is what reconstitutes the screen. On attach it replays the buffer and then
switches to live.

The bound is a real decision: too small and long builds are truncated, too large
and a chatty process eats memory. It is a per-session cap, not a global one.

## Where it still breaks

If the bridge reconnects but the interface does not reconcile which sessions
exist, you get tabs that are present and blank, attached to nothing. It is
worth testing explicitly, because it looks like a rendering bug and is a
lifecycle one.
