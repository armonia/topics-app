---
title: Window (group)
definition: >-
  A group is a set of tabs you live in: the unit a window represents. Confusing it with a cell
  of a split layout is the most common mistake in tiling interfaces, because the two look
  identical on screen and behave nothing alike.
updatedDate: 2026-08-04
pillar: performance
seeAlso:
  - split
  - pane
---

Two different things are drawn as a rectangle full of tabs, and telling them
apart decides how the whole interface behaves.

A **cell of a split** is a position in a layout tree. It exists because a pane
was divided. Close everything in it and it disappears, because the tree
rebalances. A cell is not a thing you own; it is a consequence of an
arrangement.

A **group** is a set of tabs that belongs together. It survives being emptied.
It can be detached into its own operating-system window and dragged to another
screen. It is the unit that a window *is*.

## Why the distinction is not pedantic

Every question you ask the layout has a different answer depending on which one
you meant. What happens when the last tab closes? Where does a dragged tab land?
What does "detach" produce? What gets restored after a restart, and in what
order?

Build on the wrong model and the symptoms are diffuse and maddening: windows that
vanish when you did not ask, tabs that reappear in the wrong place after a
restart, a detached window that loses its identity the moment it is emptied.

## The rule

> The group is the unit. A window is a group that has been pulled out.

Which means grouping is a first-class operation and detaching is a view of it,
rather than detaching being the operation and grouping an accident of where
things happened to land.

## On a phone

None of this survives a narrow screen. Below roughly 768 pixels there is no room
for two groups side by side, so the honest thing is to flatten them into a single
tab strip rather than to render a tiling layout nobody can hit with a thumb.
