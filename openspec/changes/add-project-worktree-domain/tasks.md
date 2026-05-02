# Tasks — add-project-worktree-domain

## 1. Schema migrations (additive only)

- [ ] 1.1 Create `server/db/migrations/016_projects.sql` with `CREATE TABLE projects` (id, name, slug UNIQUE, path, color DEFAULT NULL, icon DEFAULT NULL, archived INTEGER DEFAULT 0, created_at, updated_at) and indexes on `slug`, `path`.
- [ ] 1.2 Create `server/db/migrations/017_worktrees.sql` with `CREATE TABLE worktrees` (id, project_id FK, name, branch_name, base_ref, mode CHECK IN ('branch','reuse','detached'), abs_path UNIQUE, is_pushed INTEGER DEFAULT 0, branch_renamed INTEGER DEFAULT 0, status CHECK IN ('pending','ready','error'), created_at, updated_at) + UNIQUE INDEX on (project_id, name) + index on project_id.
- [ ] 1.3 Create `server/db/migrations/018_topics_worktree_id.sql` — `ALTER TABLE topics ADD COLUMN worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL` + index on worktree_id.
- [ ] 1.4 Verify migration runner picks up the three new files in numeric order; run them on a fresh DB and on a DB seeded from production-shaped fixtures.
- [ ] 1.5 Confirm `assertUiStateMigrationApplied` in `server.ts:66-72` is unaffected (migration 012 still gates startup).

## 2. Server — types and shared helpers

- [ ] 2.1 Add `Project` and `Worktree` interfaces to `server/types.ts` matching the SQL columns.
- [ ] 2.2 Extend `AppContext` (in `server/utils.ts`) with three new helpers: `projectStore`, `worktreeStore`, `worktreeManager`.
- [ ] 2.3 Implement `server/utils/worktree-naming.ts` — exports `generateWorktreeName(): string` plus the `ADJECTIVES` / `NOUNS` arrays. Include a unit test in `tests/unit/worktree-naming.test.ts` (Bun test) that runs 1000 generations and asserts the regex / collision-rate invariants.

## 3. Server — `WorktreeManager` service

- [ ] 3.1 Create `server/services/worktree-manager.ts` with the class `WorktreeManager` and methods `create`, `delete`, `list`, `status`, `rename`. All git ops via `Bun.spawn(["git", ...])`, never `exec`.
- [ ] 3.2 Per-project async serialization: a `Map<projectId, Promise<void>>` queue inside the manager. Reads bypass it.
- [ ] 3.3 Refuse to create a worktree from inside an existing worktree — detect via `git rev-parse --git-dir` output starting with `.git` (not a directory).
- [ ] 3.4 Pending → ready state machine: `create()` returns immediately with `status: pending`, then materialises the worktree on disk, then UPDATEs status to `ready` and broadcasts `worktree:updated`.
- [ ] 3.5 On error, transition to `status: error` with a stored message, broadcast `worktree:updated`. Do **not** delete the row — the user can retry or manually clean up.

## 4. Server — REST routes

- [ ] 4.1 Create `server/routes/projects.ts` with handlers for `GET /api/projects`, `GET /api/projects/:id`, `GET /api/projects?path=<path>` (lookup-or-null), `POST /api/projects`, `PATCH /api/projects/:id`, `POST /api/projects/:id/archive`, `POST /api/projects/:id/restore`, `DELETE /api/projects/:id`. Validation: name ≤ 200 chars, slug regex `^[a-z][a-z0-9-]{0,63}$`, path absolute and exists at create time.
- [ ] 4.2 Create `server/routes/worktrees.ts` with handlers for `GET /api/worktrees?project_id=...`, `GET /api/worktrees/:id`, `POST /api/worktrees`, `PATCH /api/worktrees/:id` (rename only — branch ops deferred), `DELETE /api/worktrees/:id`.
- [ ] 4.3 Wire the new routers in `server.ts:340-367`. Order: after `topicsRouter`, before `boardsRouter`.
- [ ] 4.4 Validate all payloads with the existing pattern (`ctx.matchRoute`, hand-rolled validators in `utils.ts`). UUID format strict, length caps, control-char strip on names.
- [ ] 4.5 Emit WS broadcasts on every successful mutation: `project:new`, `project:updated`, `project:archived`, `project:deleted`, `worktree:new`, `worktree:updated`, `worktree:deleted`. Use `broadcastToAll(...)`.
- [ ] 4.6 Extend `purgeTopicFromUiState` (`routes/topics.ts:23-94`) to also strip references to a deleted worktree id. Same `BEGIN IMMEDIATE` + `MAX(server_seq)+1` pattern. Must keep `payload_version=2` invariant.

## 5. Server — topics integration

- [ ] 5.1 `POST /api/topics` accepts an optional `worktree_id` field; validate FK, persist on the row.
- [ ] 5.2 `PATCH /api/topics/:id` accepts updates to `worktree_id` (including null).
- [ ] 5.3 `GET /api/topics` (and `:id`) include `worktree_id` and a denormalised `worktree` object (joined) when present.
- [ ] 5.4 The slash-command handler (`/api/command`, `topics.ts:2840`) and the chat-send path resolve the working directory from `worktree.abs_path` when present, otherwise fall back to `topic.project_path`. Verify all 11 `message:new` broadcast sites carry the right `cwd` context.

## 6. Server — git-watcher extension

- [ ] 6.1 Extend `server/git-watcher.ts` to accept `(absPath, worktreeId?)`. Maintain one `fs.watch` per `absPath` (not per project). Existing callers passing only `projectPath` keep today's behavior.
- [ ] 6.2 Broadcasted `git:status` envelope gains `worktreeId?: string` (omitted for non-worktree paths).
- [ ] 6.3 Add a worktree-aware cache invalidation in `routes/files.ts` git surface — when a path is a worktree, invalidate its key only.

## 7. Client — types + API client

- [ ] 7.1 Add `Project` and `Worktree` interfaces to `client/src/types/index.ts`.
- [ ] 7.2 Extend the API client in `client/src/lib/` with `projects.list/get/byPath/create/update/archive/restore/delete` and `worktrees.list/get/create/update/delete`. Mirror existing topics-API style.
- [ ] 7.3 Create React Query hooks `useProjects` and `useWorktrees` in `client/src/hooks/`. Subscribe to WS `project:*` / `worktree:*` events and update the query cache via `setQueryData` + selective `invalidateQueries`.

## 8. Client — UI integration (minimum surface)

- [ ] 8.1 Locate the existing New Topic dialog (search `App.tsx` for `Cmd+Shift+N` handler — `App.tsx:685-690` is a hint).
- [ ] 8.2 When the user picks a `projectPath` that resolves to a Project (auto-detect via `GET /api/projects?path=`), show a Worktree picker step.
- [ ] 8.3 Worktree picker has three modes: "Use project path directly" (default — current behavior), "Pick existing worktree", "Create new worktree".
- [ ] 8.4 "Create new worktree" expands to: mode (radio: branch / reuse / detached), base_ref (text, default "main"), name (text, autofilled from generator with a "regenerate" button).
- [ ] 8.5 On create, the dialog shows a pending state until WS `worktree:updated` flips status to ready, then proceeds to create the topic with that worktree_id.
- [ ] 8.6 Topic settings modal shows the bound worktree (read-only — name + branch + path). When `worktree_id` is null, hide the section entirely (no UI surface for legacy topics).

## 9. WebSocket envelope additions

- [ ] 9.1 Add `project:new`, `project:updated`, `project:archived`, `project:deleted` to `server/types.ts WSData` (or wherever the WS message union lives).
- [ ] 9.2 Add `worktree:new`, `worktree:updated`, `worktree:deleted`.
- [ ] 9.3 Document each in the `chat-reliability-spec.md` style if applicable; otherwise keep the change inside this proposal's spec deltas.

## 10. Testing

- [ ] 10.1 Add `tests/e2e/backward-compat-no-worktree.spec.ts` — open an existing topic with no worktree_id, send a chat message, edit a file via slash command, verify everything works against the legacy `project_path` exactly as today.
- [ ] 10.2 Add `tests/e2e/worktree-creation.spec.ts` — create a worktree on `branch` mode, assert directory + git branch exist, status flips pending→ready, broadcast received.
- [ ] 10.3 Add `tests/e2e/worktree-naming.spec.ts` — call generator 1000×, assert regex + collision rate.
- [ ] 10.4 Add `tests/e2e/topic-worktree-binding.spec.ts` — bind topic to worktree, send chat, assert tools operate inside the worktree's abs_path.
- [ ] 10.5 Add `tests/e2e/worktree-deletion.spec.ts` — delete worktree, assert `topics.worktree_id` set to NULL via FK, ui_state purged of references, topic falls back to `project_path` and still works.
- [ ] 10.6 Add `tests/e2e/worktree-rename.spec.ts` — rename display name (NOT git branch yet), assert directory and git branch unchanged.
- [ ] 10.7 Add `tests/unit/worktree-naming.test.ts` — pure-module test under `bun:test`.
- [ ] 10.8 Run the full existing 65-spec Playwright suite, confirm zero regressions. Capture videos for any that fail and triage individually.
- [ ] 10.9 Manually verify each of the 25 do-not-break items in §10 of `/tmp/omnara-analysis/reports/05-topics-current-state.md` and record an exec receipt (a paragraph per item) in the change archive after merge.

## 11. Performance verification

- [ ] 11.1 Measure cold-cache TTI before and after — must remain < 2.5 s per `performance/spec.md`.
- [ ] 11.2 Measure bundle size — must remain ≤ 800 KB gz (current ~704 KB gives ~96 KB headroom).
- [ ] 11.3 Add a `[WorktreeManager]` structured log line on each worktree creation with `{ project_slug, worktree_name, mode, base_ref, ms }` for future Phase B telemetry.
- [ ] 11.4 Assert worktree creation < 2 s in CI for a 30 MB repo via the e2e test.

## 12. Documentation

- [ ] 12.1 Update `BACKLOG.md` if any of the additions create new known issues to track.
- [ ] 12.2 Add a section to `CLAUDE.md` describing the new `~/.topics/worktrees/` directory and the env override `TOPICS_WORKTREES_DIR`.
- [ ] 12.3 Update the Topics spec (`openspec/specs/topics/spec.md`) via the delta in `specs/topics/spec.md` of this change after archive.
- [ ] 12.4 Document the worktree-naming generator's vocabularies in code comments — non-engineers may want to extend them.

## 13. Verification gate (before this change is archived)

- [ ] 13.1 All e2e tests pass on the new schema with video proof.
- [ ] 13.2 `bun run check:any` clean.
- [ ] 13.3 `bun run build:client` produces a bundle within budget.
- [ ] 13.4 Manual smoke test: New Topic → with worktree, without worktree, switching mid-conversation. All flows green.
- [ ] 13.5 The 25 capabilities-to-preserve list (`05-topics-current-state.md` §10) manually walked through with exec receipts captured in the change archive.
