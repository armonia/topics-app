---
title: PTY bridge
definition: >-
  A process that owns the terminal sessions independently of the window showing them. Because
  a PTY dies with whatever holds it, keeping sessions alive across a reload, a crash or a
  server restart means moving ownership somewhere longer-lived than the interface.
updatedDate: 2026-08-04
pillar: substrate
seeAlso:
  - pty
  - lossless-reattach
  - scrollback
---

A [[pty]] is owned by a process. When that process ends, the pseudo-terminal is
torn down and everything running in it receives a hangup.

If the owner is the application window, then reloading the interface kills every
session in it. This is why most embedded terminals lose your work when the page
refreshes, and it is not a bug in their implementation. It is a consequence of
where they put ownership.

## What the bridge does

It holds the master end of every PTY, keeps a ring buffer of what each one has
printed, and speaks to the interface over a socket. The interface becomes a
*view*: it attaches, gets the buffer, and streams from there. Detaching changes
nothing about the session.

That single move buys reloading the app without losing sessions, restarting the
server without losing sessions, and attaching from a second device.

## The isolation that stops being optional

A bridge is a long-lived process spawning shells, so anything ambient it inherits
is inherited by every session it ever starts. Which means a test run, a dev
instance and a production instance must not share a data directory, a home directory or a socket path, or a probe against one will terminate the sessions
of another.

That failure is worth naming precisely because it looks like something else: to
the person whose terminals just died, it reads as a crash, and the actual cause
was a health check somewhere else on the machine.

A separate bridge process owns the PTYs. Reloading the app or restarting the
server preserves the sessions and their scrollback.
