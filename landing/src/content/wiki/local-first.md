---
title: Local-first
definition: An architecture where your data lives on your disk and the network is an optimisation rather than a requirement. It is not the same as offline support — the difference is which copy is authoritative when the two disagree.
updatedDate: 2026-08-04
pillar: substrate
seeAlso:
  - tombstone
  - lww
  - byok
---

A cloud application keeps the truth on a server and caches it locally. A
local-first application keeps the truth locally and uses the network to
synchronise between copies that are each equally real.

The distinction sounds academic until something goes offline, at which point it
decides whether you can work.

## What it buys

Your data outlives the vendor. There is no seat to lose, no export to request,
no service to be sunset. It works on a plane. And nothing has to be trusted with
your code, because nothing is sent. See [[byok]].

## What it costs, honestly

**Sync becomes a real problem.** Two devices editing the same thing can
genuinely conflict, and someone has to decide. See [[lww]].

**Deletion becomes a problem.** Removing a row locally does not tell the other
device anything; it just looks like the other device has a row you do not. Which
is why local-first systems need [[tombstone]] records rather than deletions.

**Nothing continues while you are away.** If the laptop closes, the work stops.
There is no server quietly continuing on your behalf, and for long-running agents
that is a real limitation rather than a philosophical one.

## The claim worth checking

"Local-first" is a claim about where the bytes are, and it is checkable in a
minute: find the data directory, and watch what leaves the machine. A product
that makes the claim and makes it awkward to verify is making a different claim
than it appears to be.
