---
title: Scrollback
definition: The lines a terminal has already printed and still keeps. It is the part almost every embedded terminal discards, and the only part that answers the question you actually have when an agent finishes — what did it do while I was away.
updatedDate: 2026-08-04
pillar: substrate
seeAlso:
  - lossless-reattach
  - pty-bridge
---

A terminal shows a screen — perhaps fifty lines. The scrollback is everything
above it that has been kept.

## Why it is the valuable part

A finished agent run is almost never interesting at its end. The end says "done"
or shows a prompt. The interesting parts are in the middle: the command that
failed the first time, the warning nobody read, the test that was already broken
before any of this started.

Keep only the screen and you have kept the least informative fifty lines of the
run.

## What it actually is

Not text. A terminal's output is a byte stream containing control sequences: cursor moves, colour changes, screen clears, alternate-buffer switches. Storing
"the text" means storing a rendering, which cannot be replayed and loses colour
and structure.

The thing worth storing is the stream, so replaying it reconstructs the screen
exactly.

## The alternate buffer trap

Full-screen programs (`vim`, `htop`, an interactive installer) switch to the
alternate buffer, draw there, and switch back on exit. Their output should NOT
join the scrollback, which is why your shell history looks unchanged after
quitting an editor.

An implementation that stores everything indiscriminately produces a scrollback
containing thousands of lines of a redrawn editor, which is worse than useless:
it is the sound of the buffer limit being consumed by nothing.

## The bound

Scrollback has to be capped or a chatty process will eat memory. Per session, not globally. One noisy build should not evict the history of the session you care
about.
