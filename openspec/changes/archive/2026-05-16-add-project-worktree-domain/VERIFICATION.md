# Phase A — Verification Report

> Status as of the final implementation commit on `phase-a/project-worktree-domain`.
> The change is **NOT archived** — it remains open until the deferred items
> below are addressed at the merge gate.

---

## Executive summary

| Lane | Status |
|---|---|
| Schema migrations 016-018 | ✅ Applied additively, 18/18 migrations track on a fresh DB |
| ProjectStore + WorktreeStore + WorktreeManager | ✅ All three landed; happy path + error paths covered |
| REST `/api/projects` + `/api/worktrees` | ✅ Mounted in `server.ts` route fan-out, validation + WS broadcasts verified |
| `purgeWorktreeFromUiState` extension | ✅ Honors `payload_version=2` + `server_seq` invariant |
| Topics integration (`worktree_id`, `resolveTopicCwd`) | ✅ POST/PATCH accept the FK; cwd helper precedence verified |
| `git-watcher` worktree-aware | ✅ Resolves `.git`-as-file pointer; `worktreeId` opt-in in broadcast |
| Client types, API, hooks | ✅ Project + Worktree mirror server; `useProjects` / `useWorktrees` ship |
| New Topic dialog worktree picker | ✅ Three modes; pending → ready transition wired through WS |
| Topic settings worktree section | ✅ Read-only; hidden for legacy topics |
| WS envelope discriminated union | ✅ `WSProjectMessage` + `WSWorktreeMessage` folded into `WSMessage` |
| Unit tests (worktree-naming) | ✅ 23 pass / 1826 expects / 138 ms |
| Integration tests (domain end-to-end) | ✅ 11 pass / 430 expects / 542 ms |
| `bun run check:any` | ✅ 7 files clean, throughout |
| 6 e2e Playwright specs (10.1–10.6) | ⏳ **Deferred** — domain coverage exists at the integration level |
| `bun run build:client` (bundle ≤ 800 KB gz) | ⏳ **Deferred** — blocked on pre-existing TS drift in unrelated hooks |
| Cold-cache TTI < 2.5 s | ⏳ **Deferred** to the merge gate |
| 25 do-not-break exec receipts | ⏳ **Deferred** to the merge gate |

---

## Evidence

### Schema migrations

```
$ bun -e 'await import("./server/db.ts").then(m => m.initDatabase("."))'
[DB] Running migration 001-initial.sql        … ✓
…
[DB] Running migration 015-message-blocks.sql … ✓
[DB] Running migration 016-projects.sql       … ✓
[DB] Running migration 017-worktrees.sql      … ✓
[DB] Running migration 018-topics-worktree-id.sql … ✓
[DB] Applied 18 migration(s)
```

### Integration test (`tests/integration/project-worktree-domain.test.ts`)

```
$ bun test tests/integration/project-worktree-domain.test.ts
…
 11 pass
 0 fail
 430 expect() calls
Ran 11 tests across 1 file. [542.00ms]
```

Coverage:
1. Migrations applied (`projects`, `worktrees`, `topics.worktree_id`).
2. `ProjectStore.create` + lookup by slug + lookup by path + list active.
3. `ProjectStore.create` rejects duplicate slug → `SlugConflictError`.
4. `ProjectStore.archive` / `restore` round-trip.
5. `WorktreeManager.create` (pending) → `awaitMaterialisation` (ready) in <50 ms; on-disk dir + git branch verified.
6. `WorktreeManager.create` from inside an existing worktree → `WorktreeRefusalError`.
7. `WorktreeManager.delete` → row gone + dir gone.
8. FK `ON DELETE SET NULL` on `topics.worktree_id` when worktree is deleted.
9. `resolveTopicCwd` precedence: ready worktree's `absPath` first, fall back to `projectPath`, null if neither.
10. `POST /api/projects` valid → 201, missing path → 400, broadcasts emitted.
11. `POST /api/worktrees` invalid mode → 400, valid → 202 with status:pending.

### Unit test (`tests/unit/worktree-naming.test.ts`)

```
$ bun test tests/unit/worktree-naming.test.ts
 23 pass
 0 fail
 1826 expect() calls
Ran 23 tests across 1 file. [138.00ms]
```

Coverage: vocabulary shape (≥ 400 entries each, lowercase ASCII only, ≤ 14 chars), regex compliance over 200 generations, collision rate < 5% over 1000 generations, suffix fallback when `existingNames` collides, `isValidWorktreeName` user-input validator (rejects uppercase, whitespace, underscores, path traversal, control chars, unicode).

### `check:any` script

```
$ bun run check:any
[check-any] OK — 7 file(s) clean.
```

Verified after every commit in the chain.

### `[WorktreeManager]` structured timing

Sample log lines from the integration test:
```
[WorktreeManager] created { project: …/test-repo, worktree: …/famed-zephyr,    mode: branch, base_ref: main, ms: 39 }
[WorktreeManager] created { project: …/test-repo, worktree: …/cosmic-rivet,    mode: branch, base_ref: main, ms: 34 }
[WorktreeManager] created { project: …/test-repo, worktree: …/pensive-marker,  mode: branch, base_ref: main, ms: 37 }
[WorktreeManager] created { project: …/test-repo, worktree: …/melodic-anchor,  mode: branch, base_ref: main, ms: 38 }
```

All within the 2 s budget; well-positioned for Phase B telemetry.

### Backward-compat invariants reaffirmed

- `topics.project_path` (legacy column) **untouched**. New code paths read `worktree_id` first, fall back to `project_path` for unbound topics.
- `purgeTopicFromUiState` (`server/routes/topics.ts:23-94`) **untouched**. The new `purgeWorktreeFromUiState` (`server/services/ui-state-purge.ts`) is a *parallel* helper using the same `BEGIN IMMEDIATE` + `MAX(server_seq)+1` + `payload_version=2` pattern, so do-not-break #5 (cross-tab/device pane-store sync) and #6 (ghost-topic fix) are preserved.
- `tasks.project_id` (string column on the kanban side) **untouched** — Phase A introduces no FK on it.
- `git-watcher.ts` keeps the existing `(projectPath, ctx)` signature working; the new third `worktreeId?` argument is additive. Existing callers see byte-identical broadcasts.
- All 11 `message:new` broadcast sites in `routes/topics.ts` are untouched.
- `assertUiStateMigrationApplied` startup gate (mig 012) still passes — verified by booting the server against a fresh DB plus a DB seeded from production-shaped fixtures.

---

## Deferred items (carried into the merge gate)

The change stays open until these land. None are blockers for *correctness* of the domain model — they're integration-surface and bundle-hygiene work that needs cross-team coordination.

1. **e2e Playwright specs (10.1–10.6).** UI-level regression for the worktree picker, topic-binding, settings panel, and deletion. Domain-level invariants are already covered by the integration suite; the e2e specs add renderer-side coverage and screenshots/videos.

2. **`bun run build:client` to budget.** Blocked on pre-existing TypeScript drift in `useBoard.ts`, `useChat.ts`, `useWebSocket.ts`, `usePanelLifecycle.ts`, `useServerState.ts`, `useTabNotifications.tsx`, and a few component files. These errors are present on `main` and are *not* introduced by Phase A — `bunx tsc --noEmit` is clean on every Phase A file. Owner: a follow-up TS-tightening pass.

3. **Cold-cache TTI measurement.** Requires a fresh dev-server restart which `CLAUDE.md` line 24 explicitly forbids during this session. Will run at merge time.

4. **25-item do-not-break manual walkthrough.** Each capability gets a short paragraph confirming behaviour against the new schema with an exec receipt (test command + observed output). The integration suite already covers the high-risk subset (cross-tab sync invariant, FK cascade, ghost-topic purge, message branching distinct from worktree branching). The full walkthrough is the merge-gate artifact.

---

## Files touched

```
$ git diff --stat phase-a/project-worktree-domain main -- ':!openspec/'
…
client/src/App.tsx                                |   1 +
client/src/components/Modals/NewTopicModal.tsx    | 293 ++++++++++++++++++++--
client/src/components/Modals/TopicSettingsModal.tsx |  63 +++++-
client/src/hooks/useProjects.ts                   | 120 +++++++++
client/src/hooks/useWorktrees.ts                  | 100 ++++++++
client/src/lib/api.ts                             |  76 +++++++
client/src/types/index.ts                         |  58 +++++
server.ts                                         |   6 +
server/db/migrations/016-projects.sql             |  31 +++
server/db/migrations/017-worktrees.sql            |  53 +++++
server/db/migrations/018-topics-worktree-id.sql   |  21 ++
server/git-watcher.ts                             |  71 ++++--
server/routes/projects.ts                         | 195 +++++++++++++++
server/routes/topics.ts                           |  60 +++--
server/routes/worktrees.ts                        | 209 ++++++++++++++++
server/services/project-store.ts                  | 189 ++++++++++++++
server/services/ui-state-purge.ts                 | 149 +++++++++++
server/services/worktree-manager.ts               | 356 ++++++++++++++++++++++++++
server/services/worktree-store.ts                 | 232 +++++++++++++++++
server/types.ts                                   |  74 ++++++
server/utils.ts                                   |  52 +++-
tests/integration/project-worktree-domain.test.ts | 353 ++++++++++++++++++++++++++
tests/unit/worktree-naming.test.ts                | 171 ++++++++++++
```

Total: 13 new files, 8 modified files, ~3,000 lines added.

---

## Commit chain (atomic per section)

```
5df65f5  spec(phase-a):           add-project-worktree-domain change proposal
610d8b3  feat(db):                projects + worktrees tables, topics.worktree_id (016-018)
41f9f57  feat(types):             Project + Worktree types and naming generator
864facc  feat(services):          ProjectStore, WorktreeStore, WorktreeManager + AppContext
ad4002e  feat(routes):            /api/projects + /api/worktrees with WS broadcasts
f4fd3d0  feat(topics):            bind worktree_id at create/update + cwd resolution
7a191df  feat(git-watcher):       support git worktrees + optional worktreeId broadcast
3072500  feat(client):            Project + Worktree types, API client, hooks
e3b6a63  feat(modals):            worktree picker in New Topic + read-only worktree section
83f9b18  feat(types):             WSProjectMessage + WSWorktreeMessage discriminated union
7e00341  test(integration):       Phase A end-to-end domain coverage (11 cases)
84d545a  docs(phase-a):           mark tasks complete + flag e2e/build deferrals
```

Working tree: clean. Branch: `phase-a/project-worktree-domain`. Ready for review.
