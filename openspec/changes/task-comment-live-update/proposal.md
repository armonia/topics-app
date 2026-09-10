# Task comment live updates

## Goal
Keep a saved task reply visible in the open conversation and state whether it is a note or waiting to reach an agent.

The reported Guido task has two persisted human comments, remains in review, and has no assigned session. The full detail endpoint returns both comments. The drawer currently discards the comment POST response, waits for another GET, and allows older concurrent GET responses to overwrite newer state. A task without an agent also offers no explanation that its text was saved only as a note.

## Scope
Use the acknowledged comment immediately, prevent stale detail reads from winning, preserve conversation scroll on remote updates while revealing the author's own reply, and make saved versus queued feedback truthful. Preserve task history and dispatch rules.

No live task mutations, agent migration, quota changes, production restarts, merge or publication. Tests use the isolated worktree and E2E port 13365.

## Acceptance
- A successful comment appears once immediately after its POST acknowledgement, even if a detail read is slow or fails.
- A stale GET cannot erase a newer acknowledged reply or overwrite a newer successful detail read.
- Another client's comment updates an open drawer without closing and reopening it.
- An unassigned review task explicitly says the message is a saved note, not an agent response in progress.
- Queued delivery remains distinct from confirmed delivery; quiet notes do not restart agents or change task state.

## Authorization
Implementation and isolated verification requested by the user through the parent task on 2026-09-08.
