# Change: collaborator-activity

## Why

Card ef40fa34: an owner sharing a project with a collaborator (`GUEST-09`,
`comment`/`edit` grants) has no way to see what that collaborator is doing.
The board mixes four different questions under one text field:

- **assignee** — `tasks.assigned_to`, free text, unrelated to who actually acted;
- **author** — who wrote the latest comment/change (`task_comments.author`,
  today one of a fixed vocabulary: `user`, `system`, `dispatcher`, `verifier`,
  `agent:<topicId>` — never a specific PERSON when more than one exists);
- **executor** — the agent instance/session actually running the task;
- **machine** — which computer is running it (`tasks.machine_id`, populated
  only by remote-node dispatch — `winfleet`/multi-machine — and NULL on every
  single-machine install, which is most of them).

This was explicitly blocked behind `53fc5aed` (grant levels beyond `read`),
because a `read`-only guest cannot produce any of the activity this card wants
to surface. That decision landed: `grants.level` now has `read < comment <
edit < deny`. A guest can comment and edit a shared task, so there is
something real to attribute and show.

## What changes

**Attribution, additive.** `task_comments` gains two nullable columns,
`actor_person_id` and `actor_device_id`, filled at write time from the
request identity (`resolvePrincipals`) for interface-originated writes only.
Existing rows are untouched — `shared/comment-author.ts` already documents why
rewriting 404+ distinct free-text authors is not worth the risk; this change
does not touch that pipeline, it adds a second, structured field next to it
that new writes populate going forward. `assigned_to` is not migrated: it
stays exactly what it is today, a free-text label, and the new fields do not
try to explain it away.

**A read-model, not a new event table.** No `task_events` table (it was
dropped by migration 067, and building a replacement is a separate, much
bigger decision than this card asked for). "What is happening on a task" is
derived at read time from what already exists: `task_comments` (author +
the new actor columns), `tasks.status`/`dispatch_state`/`wait_reason`
(already the source the board itself reads for "in progress" chips), and
`tasks.machine_id` joined to `machines` (falls back to "this machine" — the
single local install — when NULL, which is not an error state, it is the
common case).

**Two new filters, same field.** `person` and `machine` join
`FILTER_GROUP_ORDER` in `filterRows.ts`, next to the existing `assignee`
group, built from the FilterTokenField/filterRows machinery already on the
board. Their options are derived from the caller's own already-visible task
set — the same set the `assignee` group reads today — so no new endpoint and
no new leak surface: a person/machine a guest cannot see never produces a
filter option for them, because the task itself never reached their side of
the socket (`GUEST-04`).

**No new socket surface.** The attribution fields ride the task object that
already flows through the existing guest-filtered WS fan-out
(`task-comment-live-update`). A revoked guest stops receiving task frames the
same way it already does; there is nothing additional to revoke.

## Out of scope — and why

- **Rewriting `assigned_to` into a real reference.** The card asks to stop
  *conflating* assignee/author/executor/machine when they are displayed, not
  to replace a free-text field 3792 tasks already use. A migration of that
  column is its own decision.
- **A `task_events` table.** Named directly by the blocking review on this
  card as a much bigger rebuild than "add two columns and read what already
  exists." If the read-model built here turns out to need real event
  granularity later, that is a new proposal with its own evidence for why the
  read-model is not enough.
- **Guest presence (`presence:announce`).** `GUEST_INBOUND_FRAMES` excludes it
  on purpose (`sharing-guests` GUEST-04 note) and that stays: "in progress /
  waiting / offline" here is the AGENT's dispatch state on the task, which
  already exists regardless of whether the collaborator's browser tab is
  open, not a live cursor/typing presence feed.
- **A live two-person, two-machine proof executed by this change.** The
  author writing this proposal is a single session with no second real
  account or second physical machine to log in from; the automated tests use
  seeded fixtures (multiple `people`/`devices`/`machines` rows), which is
  normal test data, not a claim of remote access. The live end-to-end proof
  with two real accounts is named as the remaining human step on delivery.
