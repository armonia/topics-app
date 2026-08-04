---
title: Pane
definition: A pane is one live surface inside a topic — a chat, a terminal, a browser, a diff. Unlike a tab in a text editor, a pane usually has a process behind it, which means it has a lifecycle and a measurable cost even when you are not looking at it.
updatedDate: 2026-08-04
pillar: performance
seeAlso:
  - split
  - window-group
  - topic
---

The word is borrowed from tiling window managers, and the borrowing is exact: a
pane is a rectangle showing one thing, arranged next to other rectangles rather
than stacked behind them.

What makes it different from an editor tab is what sits behind it. An inactive
editor tab is a string in memory. An inactive pane may be a shell with a running
process, a browser with a page, or an agent mid-turn.

## The cost nobody budgets for

Panes are not free while hidden. A terminal emulator keeps redrawing. A browser
keeps running timers and animations. A chat keeps a socket open and re-renders on
every streamed token. Ten panes on screen is a layout problem; ten panes *alive*
is a performance problem, and it is the one that shows up as a laptop fan.

There are two honest answers and you need both. Cap how many panes stay resident
at once, and freeze the ones nobody is looking at: stop their timers, stop their
repaints, keep their state.

## Hidden is not the same as unfocused

The trap is deciding what "nobody is looking at" means. Window focus is the
tempting signal and it is the wrong one: a pane in a background window that the
user is watching while typing elsewhere is very much being looked at, and
freezing it makes the app feel broken in a way that is hard to report.

Visibility (is this rectangle actually on screen) is the signal that survives
contact with how people really work.

Freezing hidden panes measured a 23-28% reduction in CPU at rest. The liveness
gate is deliberately built on visibility and never on window focus.
