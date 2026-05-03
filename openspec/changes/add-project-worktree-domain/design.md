# Design — Project + Worktree Domain Models

## Context

Topics today materialises a "project" as **a string** in two places:
- `topics.project_path` (TEXT, nullable) — the file path the topic operates against.
- `tasks.project_id` (TEXT) — used by `boards.ts` and `agent_assignments.ts` as a partitioning key. Often holds the same value as the topic's project path, but not always.

There is **no `projects` table**. There is **no `worktrees` table**. The 11 sites that broadcast `message:new` in `routes/topics.ts` (lines 299, 322, 684, 1113, 1301, 1483, 1860, 2232, 2249, 2282, 2347) all assume a single working tree per project. The `git-watcher` watches one `.git/` per project path — adding worktrees means watching multiple `.git/` files (each git worktree has its own `.git` *file* pointing at the parent's `.git/` *directory*).

Spaces (`spaces.json`, file-backed) are an orthogonal tenancy concept and explicitly **out of scope** for this phase. Projects nest *within* the active space when Spaces is finally migrated to SQLite (separate change). For now, projects are user-global.

## Goals / Non-Goals

**Goals:**
- Persist Project and Worktree as first-class entities with CRUD APIs, WS broadcast, and FK relationship `topics.worktree_id`.
- Allow the same project (same path) to have **multiple parallel worktrees** on different branches, with isolated working trees on disk.
- Auto-generate human-readable worktree names (`<adjective>-<noun>`) so the user rarely has to think about a name.
- Keep every existing capability green (see proposal §Impact). Topics not bound to a worktree behave exactly as today.

**Non-Goals:**
- Migrating Tasks/Boards from `project_id: string` to FK — too risky for one phase, deferred until projects are stable in production.
- Cloud / sandbox worktrees — not on the Topics roadmap.
- Branch-rename / commit / PR-create flows — those are separate features in later phases.
- A workspace-level UI (Project switcher, project list view). The minimum UI here is the New Topic dialog's worktree picker. A full Project sidebar lives in its own change.

## Decisions

### D1: Additive-only schema migrations

Migrations 016 and 017 only `CREATE TABLE` and `ALTER TABLE ... ADD COLUMN ... NULL`. **No** existing column is dropped, renamed, or constrained-changed. **No** existing row is touched. This guarantees zero risk of breaking the 25 do-not-break items.

`topics.project_path` (TEXT, nullable) **stays**. `topics.worktree_id` is added as nullable. New code reads `worktree_id` first, falls back to `project_path` for legacy rows. Old code reads `project_path` only and is unaware of `worktree_id`.

### D2: Projects are user-global, not space-scoped (yet)

Spaces (`spaces.json`) is file-backed and not in SQLite — adding `space_id` to `projects` now would create another inconsistent layer. Until Spaces is migrated to SQLite (separate change), Projects ignore Spaces. Spaces UI is unchanged.

When Spaces eventually moves to SQLite, that change adds a nullable `space_id` to `projects` (additive). No regression then either.

### D3: Worktree directory layout

```
~/.topics/worktrees/<project-slug>/<worktree-name>/
```

- `<project-slug>` = lowercase, hyphenated form of the project's `name` (or `basename(path)` if the user didn't set a name) — matches the slug column on `projects`.
- `<worktree-name>` = the unique `<adjective>-<noun>` (or user-chosen name) on the worktrees row.

Configurable via env `TOPICS_WORKTREES_DIR` (default `~/.topics/worktrees`). The directory is created lazily on first worktree creation.

### D4: Worktree mode enum

Three modes:
- `branch` (default) — `git worktree add -b <branch_name> <abs_path> <base_ref>`. Creates a fresh branch off `base_ref` and checks it out.
- `reuse` — `git worktree add <abs_path> <existing_branch>`. Checks out an existing branch (no new branch created).
- `detached` — `git worktree add --detach <abs_path> <ref>`. Detached HEAD at `ref`.

Mode is stored on the row so deletion knows whether to also delete the branch (`git branch -D` only on `branch` mode unless the user opted in for `reuse` deletion).

### D5: Worktree-name generator

Embedded vocabularies in `server/utils/worktree-naming.ts`:
- `ADJECTIVES`: ~500 short, distinctive adjectives — preferring concrete and metaphorical (`brassy`, `lyrical`, `mural`, `sincere`, `headless`, `cobblestone`, `daring`).
- `NOUNS`: ~500 short, recognizable nouns — preferring concrete (`cobra`, `polio`, `cliff`, `rivet`, `hammer`, `coffee`, `cypress`).

Selection: cryptographic random pick from each list, joined with `-`. Collision check against the worktrees table (per project): on collision, retry up to 5 times, then suffix with a 4-char random hex (`lyrical-cobra-3a7f`). With ~250k unique combinations × per-project scope, collisions are vanishingly rare.

Vocabularies are deliberately **kept compact** — emojis, slurs, ambiguous words are excluded. Reviewable diff. No external dictionary download.

### D6: WorktreeManager wraps git via `Bun.spawn`, not `simple-git`

Topics' existing `git-watcher.ts:14-49` and the ~25-endpoint git surface in `routes/files.ts` already shell out via `Bun.spawn(["git", ...])`. Adding `simple-git` (a Node-native package) brings:
- Another transitive dep tree.
- A second style for git invocation (inconsistent with current code).
- A `simple-git` API that ultimately just calls the same `git` binary, so no real abstraction win.

Decision: use `Bun.spawn` directly. Centralise git invocation in `WorktreeManager`. Subset to the operations we need:
- `worktreeAdd(absPath, branchOrRef, mode, baseRef?)`
- `worktreeRemove(absPath)`
- `worktreeList()` (parses `git worktree list --porcelain`)
- `branchRename(worktreeAbsPath, oldName, newName)` (deferred to a later phase, but interface defined now)

### D7: WS broadcast vs REST cache invalidation

The new WS message types `project:*` and `worktree:*` are emitted from the route handlers immediately after the SQLite write succeeds. Pattern is identical to existing `topic:new` etc. (`routes/topics.ts:299`).

Renderer consumers (React Query hooks in `client/src/hooks/useProjects.ts` and `useWorktrees.ts`) subscribe to these events via the existing WS bus (`useWebSocket` hook) and call `queryClient.setQueryData` / `invalidateQueries` accordingly. **No new WS infrastructure**.

The cross-tab `pane-store-v2` sync in `state/pane/middleware/` is **not** affected — projects/worktrees aren't pane-store data; they're domain entities and use React Query like Topics already does for its own list.

### D8: Backward compat in `purgeTopicFromUiState`

When a worktree is deleted, any topic with `worktree_id = <deleted>` gets its `worktree_id` set to NULL via `ON DELETE SET NULL` (so it falls back to `project_path` behavior). The existing `purgeTopicFromUiState` is **extended** (not rewritten) to also walk persisted ui_state snapshots and clean any references to the deleted worktree id. Same `BEGIN IMMEDIATE` + `MAX(server_seq)+1` pattern; no change to invariants.

### D9: New Topic dialog UX

The existing dialog has: name field, template buttons, optional `projectPath` picker. We add a **conditional second step** that fires when the chosen `projectPath` resolves to a Project (via `GET /api/projects?path=<path>` lookup or auto-create fallback):

1. **Project selector** (or auto-detect from path).
2. **Worktree selector** with three options:
   - **(default) "Use project path directly"** — `worktree_id = NULL` — exactly today's behavior.
   - **"Pick existing worktree"** — dropdown of worktrees on this project, sorted by recent activity.
   - **"Create new worktree"** — expands to mode + base_ref + auto-prefilled name field.

The default option preserves today's behavior end-to-end. No existing user flow changes unless they explicitly engage the new UI.

### D10: `git-watcher.ts` extension

Today the watcher is keyed by `projectPath`. With worktrees, multiple absolute paths can map to the same logical project but different branches. The watcher gains a `worktreeId?: string` parameter passed alongside `projectPath`. Watching is keyed by the absolute path (not the project), so each worktree gets its own watcher instance. Broadcasts gain a `worktreeId` field when the watched path is a worktree (NULL when watching a top-level project path).

Backward compat: existing callers that pass only `projectPath` get worktree-less behavior identical to today.

## Risks / Trade-offs

- **Duplicate state** between `projects.path` and `topics.project_path`. The `projects` table is, in essence, a registry of paths. Risk: drift. Mitigation: a project is auto-created the first time a topic is bound to a worktree; backfill of legacy `project_path` values is **deferred** to avoid touching live rows. Read paths fall back to `project_path` when no project record exists.
- **Worktree disk usage**. Each worktree is a full checkout of the working tree (git index + files). 5 worktrees on a 1 GB repo = 5 GB. Mitigation: surface size in worktree settings UI (later phase) and offer "delete worktree" with disk-recovery confirmation. For Phase A, document in the change-log.
- **Concurrent git operations on the same project**. Two simultaneous `git worktree add` calls on the same parent repo can deadlock under rare conditions. Mitigation: serialise worktree-mutation calls **per project** via an in-memory async queue keyed by `project_id` in `WorktreeManager`. Reads (`worktreeList`) are not serialised.
- **Worktree-name collisions on first run** when the random generator hits an existing name. Mitigation: D5 retry-then-suffix strategy. Already low-probability.
- **`git worktree add` requires the repo not to be a worktree itself**. If the user's `projectPath` is itself a worktree, `git worktree add` fails. Mitigation: detect in `WorktreeManager.create` (parse `git rev-parse --git-dir` output) and surface a clear error "Cannot create worktrees from inside a worktree — pick the original repo".
- **Naming collisions with the `topics` notion of a "branch"**. The `messages.parent_id` + `active_branches` table tracks message-level branches (edit-and-resend creates siblings). The `worktrees.branch_name` is a *git* branch. The two are unrelated and never interact in code or UI. The change adds a one-line note to `specs/topics/spec.md` clarifying the distinction.
- **Disk operations off the request thread**. `git worktree add` can take seconds on large repos. The route handler runs it asynchronously and returns 202 Accepted with the new worktree row in `pending` status; a follow-up WS broadcast `worktree:updated` flips status to `ready` when the working tree is materialised. UI shows a loader on the new worktree row in the meantime.

## Migration test plan

E2E (`tests/e2e/`):
1. **`backward-compat-no-worktree.spec.ts`** — Open existing topic, verify chat sends, file edits land in original `projectPath`, no UI exposes a worktree concept. **Must pass**.
2. **`worktree-creation.spec.ts`** — From New Topic, create a worktree on `branch` mode off `main`, verify `~/.topics/worktrees/<slug>/<name>/` exists, branch is checked out, `worktrees` row exists.
3. **`worktree-naming.spec.ts`** — Call generator 1000 times, assert: all names match `^[a-z]+-[a-z]+(-[0-9a-f]{4})?$`, < 0.5 % suffixed (collision rate). All names are filesystem-safe.
4. **`topic-worktree-binding.spec.ts`** — Create Topic bound to worktree, send `/files list` slash command, verify the response paths are inside the worktree absolute path, not the project path.
5. **`worktree-deletion.spec.ts`** — Delete a worktree, verify `topics.worktree_id` set to NULL on bound topics, no orphaned ui_state references, the topic still works using `project_path`.
6. **`worktree-rename.spec.ts`** — Rename a worktree row's display name (the underlying git branch name is **not** renamed in this phase — that's a later capability). Verify the slug-derived directory is unchanged (only the display name moves).

Performance:
- Worktree creation timing recorded in a structured log line `[WorktreeManager] created { project_slug, worktree_name, ms }`. Phase B will turn this into a `git_worktree_add_ms` daemon RPC metric.
- Tests assert creation < 2 s for a 30 MB repo (CI median).

Backward-compat regression sweep before merge:
- All 65 existing Playwright spec files must pass on the new schema.
- The 25 do-not-break items in `/tmp/omnara-analysis/reports/05-topics-current-state.md` §10 reviewed manually with each one of them mapped to either "untouched" or "verified-still-works" with an exec receipt.
