---
title: Split
definition: A split divides a pane in two, producing a tree of rows and columns rather than a flat list. It is what lets a terminal, the file it is editing and the page it renders sit on screen together instead of taking turns.
updatedDate: 2026-08-04
pillar: performance
seeAlso:
  - pane
  - window-group
---

Splitting is recursive. Divide a pane and you get two; divide one of those and you
get three. The layout is therefore a *tree*, not a grid: each node is either a
leaf holding a pane, or a row or column holding children with proportions.

That structure is why dragging one divider does not disturb the rest of the
screen. A divider belongs to one node, so moving it changes the proportions
inside that node and nothing else, provided the tree is the source of truth and
not a rendering of some flatter model kept alongside it.

## Where it goes wrong

The classic bug is two representations of the same layout that drift: a tree for
drawing and a list for persistence. Resize a divider and the tree updates, the
list does not, and the layout you get back after a restart is not the one you
left.

The subtler one is a resize triggered by teardown. When a pane unmounts, the
container reports a new size, and if that report is treated as a user intent the
proportions get rewritten to something nobody asked for, usually an even split,
because that is the fallback. It is a difficult bug precisely because a unit test
of the resize logic passes: the logic is right, the *caller* was wrong about what
happened.

## What a split has to survive

A reload, a restart, and a second machine. Which means the tree has to be
serialisable and reconcilable — two devices can both have opinions about it, and
one of them has to win in a way that is not simply "whoever wrote last by
wall-clock".

Layout is a single split tree, persisted and synced. Every divider is the same
kind of object, which is what makes the drag behaviour identical everywhere.
