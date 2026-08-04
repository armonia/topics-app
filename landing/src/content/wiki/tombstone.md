---
title: Tombstone
definition: A record that something was deleted, kept instead of simply removing the row. Without one, a sync cannot tell "you deleted this" from "I have something you have not seen yet" — so deleted things come back.
updatedDate: 2026-08-04
pillar: substrate
seeAlso:
  - lww
  - local-first
---

Two devices reconcile their state. Device A has a tab that device B does not.
Two histories produce that situation and they need opposite outcomes:

- B never received it → **send it to B**.
- B deleted it → **remove it from A**.

The current state is identical in both cases. Without a record of the deletion,
whatever the sync does is right half the time, and the visible symptom is a tab
you closed reappearing on every device a moment later.

## What a tombstone carries

The identity of the deleted thing and *when* it was deleted. The timestamp is the
load-bearing part: a tombstone that only says "gone" cannot survive the case
where the same thing is legitimately created again afterwards.

## The stale tombstone problem

Close a tab, then open a new one with the same identity. Now there is a tombstone
saying "deleted" and a live object saying "here". Which wins?

Not the newer timestamp by wall-clock — clocks on two machines disagree by more
than the gap between those two actions. What resolves it is *causality*: the
tombstone applies only if the deletion happened after the creation it is talking
about. A creation that is newer than the tombstone that mentions it means the
tombstone is stale and must be dropped, not applied.

Getting this wrong produces the most frustrating class of sync bug there is: an
object you just made disappearing a second later, for reasons invisible from the
interface.

## Garbage collection

Tombstones cannot accumulate forever, but they must outlive the longest plausible
offline period of any device. Expiring them in an hour means a laptop opened after
a week resurrects everything it deleted before closing.
