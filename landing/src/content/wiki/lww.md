---
title: LWW (last-writer-wins)
definition: A conflict rule that keeps the most recent write. It is the simplest thing that works for synchronising state across devices, and it is only correct if "most recent" is decided causally rather than by reading two clocks that disagree.
updatedDate: 2026-08-04
pillar: substrate
seeAlso:
  - tombstone
  - local-first
  - split
---

Two devices change the same thing while apart. When they meet, something has to
choose. LWW chooses the later write.

For interface state (which tabs are open, how the panes are arranged) this is
the right amount of machinery. Nobody wants a merge dialogue about a divider
position, and losing one of two conflicting layouts costs a drag to fix.

## Where it goes wrong

**Wall-clock time.** Machine clocks differ by seconds, sometimes minutes.
Deciding "later" by comparing two timestamps taken on two machines means the
device with the faster clock wins arguments it should lose, permanently and
invisibly.

The fix is a monotonic sequence assigned by whatever both parties agree on — a
server sequence number, or a logical clock. "Later" then means *after* in a
causal sense, which is the thing you actually meant.

**Granularity.** LWW over a whole object throws away non-conflicting changes: if
one device moved a divider and the other opened a tab, resolving at the object
level loses one of them although they do not conflict at all. Resolving per field
keeps both.

**Empty wins.** The most damaging version is a device that syncs an empty state
during startup, before it has loaded anything, and wins on recency — wiping every
other device. A rule of "later wins" needs a companion rule that an empty state
is never authoritative.

## What LWW is not for

Documents and text. Losing half a paragraph because two people typed at once is
not an acceptable outcome, and that is what CRDTs and operational transforms
exist for. LWW is for state where a lost update costs a gesture, not work.
