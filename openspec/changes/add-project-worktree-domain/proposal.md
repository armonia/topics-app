# Add Project + Worktree Domain Models (Phase A of Multi-Phase Migration)

## Why

Topics today has two implicit layers (Topic ↔ optional `projectPath` string), but no first-class concept of a **Project** entity nor of a **Worktree** (a specific branch/working-copy of a project). This forces three pain points:

1. **No way to run multiple parallel agents on the same repo on different branches.** Today every Topic that points at a `projectPath` shares the same working tree with every other Topic on that path. If two Topics start editing the same files, they trample each other.
2. **No "fresh branch from main" affordance.** Users who want an isolated experiment must `git checkout -b` outside the app, then point a Topic at the new path manually.
3. **No project-level metadata** (display name, color, icon, sync settings). Today a project is just whatever string a `projectPath` resolves to — `boards.ts` keys by `project_id` (often the path), but there is no `projects` table to hold project-level state.

This change introduces **Project** and **Worktree** as first-class persisted entities, with `topics.worktree_id` as a new optional foreign key. The change is **additive only** — every existing Topic, Task, Board, and `project_id` string-keyed feature continues to work exactly as today. New Topics gain the option of being bound to a specific Worktree of a Project.

This is **Phase A** of a larger migration. Subsequent phases (daemon promotion, multi-machine, auto-update, UX polish, design system, CLI) build on the data model introduced here.

## What Changes

- **Add table `projects`** (`id`, `name`, `slug` UNIQUE, `path`, `color`, `icon`, `archived`, `created_at`, `updated_at`). Optional canonical record for any project Topics already references via `projectPath` / `project_id` strings.
- **Add table `worktrees`** (`id`, `project_id` FK, `name` UNIQUE per project, `branch_name`, `base_ref`, `mode`, `abs_path`, `is_pushed`, `branch_renamed`, `created_at`, `updated_at`). Each worktree is a checked-out git working copy at a specific branch, with `mode ∈ {branch, reuse, detached}`.
- **Add column `topics.worktree_id`** (NULLABLE FK to `worktrees.id ON DELETE SET NULL`). Topics that don't bind to a worktree behave exactly as today.
- **New REST routes** `/api/projects` (CRUD + `:id/archive`/`:id/restore`) and `/api/worktrees` (CRUD + `:id/rename`) that return JSON envelopes consistent with the current routes' style.
- **New WebSocket broadcast types** `project:new|updated|archived|deleted` and `worktree:new|updated|deleted`. They piggyback on the existing `broadcastToAll` helper.
- **New worktree-name generator** — `<adjective>-<noun>` from a small embedded vocabulary (~500×500 → ≥250k unique combinations, low collision rate). Generator lives in `server/utils/worktree-naming.ts`. Examples: `lyrical-cobra`, `mural-polio`, `sincerity-headless`.
- **New service `WorktreeManager`** at `server/services/worktree-manager.ts` that wraps git via `Bun.spawn` (no `simple-git` dep — keeps the existing tool style consistent with `server/git-watcher.ts:14-49`). Operations: `create`, `delete`, `rename`, `status`, `list`. Uses worktrees in `~/.topics/worktrees/<project-slug>/<worktree-name>/` (configurable via env `TOPICS_WORKTREES_DIR`).
- **New UI step in New Topic dialog** — when the user picks a project that has at least one worktree, the dialog shows a worktree picker (default = "no worktree (use project path directly)" for backward compat). When "Create new worktree" is selected, the dialog shows fields for `mode`, `base_ref` (default `main`), and an editable `name` (auto-prefilled from the generator).

## Capabilities

### New Capabilities

- `projects` — first-class Project entity with CRUD, archive/restore, color/icon, and discovery from existing `projectPath` strings.
- `worktrees` — first-class Worktree entity tied to a Project, with branch creation, base-ref override, and a unique adjective-noun naming scheme.

### Modified Capabilities

- `topics` — Topic gains an optional `worktree_id` foreign key; New Topic dialog gains a Worktree selector step; topic settings modal exposes the bound worktree (read-only for now). Existing topics without a worktree continue to behave exactly as today.

## Impact

**Server:**
- `server/db/migrations/016_projects.sql` (new) — `CREATE TABLE projects`.
- `server/db/migrations/017_worktrees.sql` (new) — `CREATE TABLE worktrees` + `ALTER TABLE topics ADD COLUMN worktree_id`.
- `server/routes/projects.ts` (new) — REST router.
- `server/routes/worktrees.ts` (new) — REST router.
- `server/services/worktree-manager.ts` (new) — Git operations.
- `server/utils/worktree-naming.ts` (new) — Adjective-noun generator + collision check.
- `server/types.ts` — Add `Project`, `Worktree` types.
- `server/utils.ts` — `AppContext` gains `projectStore`, `worktreeStore`, `worktreeManager`.
- `server.ts:340-367` — Mount new routers.
- `server/routes/topics.ts` — `POST /api/topics` accepts optional `worktree_id`; `PATCH /api/topics/:id` allows updating it.

**Client:**
- `client/src/types/index.ts` — Add `Project`, `Worktree` interfaces.
- `client/src/components/Sidebar/NewTopicDialog.tsx` (or wherever today's dialog is — verify in implementation) — Add Worktree picker step.
- `client/src/components/Settings/TopicSettings.tsx` — Display bound worktree (read-only).
- `client/src/lib/api.ts` (or current API client) — Add `projects.*` and `worktrees.*` API methods.
- `client/src/hooks/useProjects.ts` (new) — React Query hook.
- `client/src/hooks/useWorktrees.ts` (new) — React Query hook.

**Tests:**
- `tests/e2e/worktree-creation.spec.ts` (new) — Playwright e2e: pick project → create worktree → see new branch.
- `tests/e2e/worktree-naming.spec.ts` (new) — Verify generator produces valid filesystem names, no collisions over 1000 calls.
- `tests/e2e/topic-worktree-binding.spec.ts` (new) — Create Topic bound to worktree, verify chat works in that working copy.
- `tests/e2e/backward-compat-no-worktree.spec.ts` (new) — Existing topics without `worktree_id` keep behaving as today.

**Out of scope for this phase (deliberate):**
- Migrating Tasks/Boards from `project_id` string to `projects.id` FK — preserved as legacy column; new code can use either.
- Daemon split — Phase B.
- Multi-machine — Phase D.
- Cloud sandbox / remote worktree mode — never planned for Topics, scope-cut.
- TanStack DB cache layer — Phase C.
- Any UI redesign — Phase G.

**Performance budget (`performance/spec.md`):**
- Worktree creation must complete within 2 s on a typical repo (median 30 MB working tree). Surfaced as a daemon RPC timing in §3.4 of perf spec.
- `GET /api/projects` and `GET /api/worktrees/?project_id=X` must respond in < 50 ms with cached SQLite reads.
- No regression to existing TTI < 2.5 s cold-cache target — new tables add ~0 µs to startup since they're read on demand.

**Capabilities to preserve (cross-reference with `/tmp/omnara-analysis/reports/05-topics-current-state.md` §10):**
- All 25 do-not-break items remain green. Specifically:
  - #5 Cross-tab/device pane-store sync (`payload_version=2` + `server_seq` LWW) — untouched.
  - #6 `purgeTopicFromUiState` ghost-topic fix — extended to also clear references to deleted worktrees.
  - #7 WS catch-up on connect for active streams — untouched.
  - #8 Tray menu + dock badge — untouched (worktree concept invisible to tray for now).
  - #9 Detached topic windows — `?topic=` contract unchanged.
  - #16 Chronological `blocks` content timeline — untouched.
  - #17 Branching messages (`active_branches`) — untouched (this is the *message-level* branch, distinct from the *git-level* worktree branch we're adding).
