---
title: PTY (pseudo-terminal)
definition: A pseudo-terminal is a pair of kernel devices that makes a program believe it is talking to a real terminal. It is why `vim`, `htop` and every interactive CLI behave differently when you pipe them, and it is the only channel through which a paid CLI subscription can be driven.
updatedDate: 2026-08-04
pillar: substrate
seeAlso:
  - git-worktree-per-agent
  - effort-level
---

A PTY has two ends. The program gets the *slave* end and sees something that
answers every question a terminal answers: it has a width and a height, it
reports a type, it supports raw mode, it delivers `SIGWINCH` when the window
resizes. Whoever holds the *master* end reads what the program prints and writes
what the program reads.

The difference from a pipe is not cosmetic. `isatty()` returns true, so programs
turn on colour, redraw in place, use the alternate screen buffer, and accept
single keypresses instead of waiting for a newline. Pipe the same program and it
switches to its dumb, line-buffered self.

## Why an agent workspace needs one

Two reasons, and the second is the one people miss.

The obvious one: coding agent CLIs are interactive. They redraw, they prompt,
they take a keypress to approve a tool call. Through a pipe you get a stream of
escape sequences and no way to answer.

The one that decides architecture: **a subscription is only reachable through
the official CLI.** Anthropic's plans authorise the `claude` binary, not the
API — there is no HTTP endpoint that accepts a subscription. So a workspace that
wants to use the plan you already pay for has no choice: it has to run the real
binary, and running the real binary means owning a PTY.

## The cost

A PTY is a live kernel object owned by a process. Kill the owner and the session
goes with it — which is why "reload the page and lose the terminal" is the
default behaviour of nearly every web terminal ever shipped.

Keeping one alive across reloads means the PTY has to be owned by something
longer-lived than the window: a separate process that holds the master end,
buffers the scrollback, and hands it back on reconnect.

## In Topics

Sessions are spawned as the real `claude` binary over a PTY with stream-json on
both directions, so the session inherits whatever tools the installed CLI has,
not a subset someone re-implemented. The PTY itself is held by a separate bridge
process, so closing a tab, reloading the app, or restarting the server does not
end the session or lose what it printed.
