# Tasks — collaborator-activity

1. **Migration**: additive `task_comments.actor_person_id`, `actor_device_id`
   (nullable, FK `ON DELETE SET NULL`). No backfill.
2. **Write path**: interface-originated comment/status writes on `tasks.ts`
   capture `resolvePrincipals(db, deviceId)` and store `personId`/`deviceId`
   when known (MCP/API-originated writes leave both NULL — no device to
   attribute to).
3. **Read-model**: a pure function `taskActivity(task, lastComment, machine)`
   → `{ assignee, author, executor, machine, agentState }`, unit-tested in
   isolation (no DB).
4. **API**: fold `taskActivity` into the task payload already sent to
   `/api/boards/:projectId/tasks` and task-detail — no new route, no new
   permission surface to re-derive.
5. **Filters**: `person` and `machine` `FilterGroup`s in `filterRows.ts`,
   wired into `FilterTokenField`/`KanbanBoardPane` next to `assignee`; options
   built from the caller's own visible tasks.
6. **UI**: card badge + `TaskDetail` "session details" (expandable) showing
   author/executor/machine/state, IT/EN, light/dark, desktop/narrow/mobile.
7. **Tests**: read-model unit tests; combined person+machine filter test;
   grant-revoke removes a task (and its activity) from a guest's WS and REST
   view (extends the existing `GUEST-04` harness, not a new one).
8. **Gates + delivery.**
