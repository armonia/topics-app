# Proposal: multi-project-intake

Card 71438f36 (part 2 of the director plan; part 1 is card f2289637: confirmation
at birth, `created_by`, notice after 10 minutes in backlog).

Decision recorded on the card on 2026-11-03: before creating any card, show a
proposal to confirm, one line per card with its project, sub-cards under their
parent. This page is the contract; no code is written before it is read.

## GOAL

From the Topics input, one request can become several cards across several
projects. For each proposed card the writer sees:

1. the target project (which board it lands on);
2. whether it goes **under** an existing card (it becomes a sub-card) or
   **above** it (the new card becomes the parent of an existing one);
3. nothing is created until the writer confirms.

## Flow (shown to the requester first)

```
Request: "fix the relay timeout and document it in the landing"

Proposal (nothing created yet)
  [x] topics-app   Fix relay reconnect timeout            new, top level
        [x] topics-app   Add regression test             new, sub-card of the line above
  [x] landing      Document relay timeout behaviour       new, top level
  [ ] topics-app   Existing card "Relay flaky" (a1b2c3d4) would become a sub-card
                   of the first line (above/below suggestion, off by default)

  [Create 3 cards]   [Edit]   [Cancel]
```

- One row per card: checkbox, project, title, relation. Sub-cards are indented
  under their parent.
- Project and relation are editable per row; unchecked rows are skipped.
- Re-parenting an EXISTING card (the "above" case) is only ever a suggestion,
  off by default, because it changes a card someone else may be working on.
- Confirm creates everything in one step, parents before children, each card
  with `created_by` set to the writer. Cancel creates nothing.
- Single-project, single-card requests keep today's behaviour (one card, one
  confirmation line), so the common case does not get heavier.

## FUORI (out of scope)

- Automatic creation without confirmation.
- Moving or merging existing cards between projects.
- Re-parenting an existing card without an explicit tick.
- Cross-project dependencies and ordering between cards.
- The part 1 items (confirmation at birth, `created_by`, 10 minute notice).
- Dispatching the new cards: they land in backlog like any card.

## BARRA (acceptance bar)

- A request naming two projects yields a proposal with rows on both, and
  confirming creates exactly the ticked rows, none before.
- Sub-cards are created after their parent and carry its id as parent.
- Cancelling or closing the proposal leaves the boards unchanged (test).
- A failure on one row reports it and does not leave a half-created tree
  without saying so: created rows are listed, failed ones can be retried.
- The proposer only ever names projects that exist; an unknown project is shown
  as unresolved, never invented.
- Unit tests for the proposal model and the create step; e2e spec for the
  confirm flow under `tests/e2e/`.
- All seven code gates green.

## Open point

Where the proposal comes from (a model call that splits the request, versus
rules on explicit project names) is decided at design time after this flow is
approved. Recommended: a model call with the project list as context, since
free text rarely names projects literally.
