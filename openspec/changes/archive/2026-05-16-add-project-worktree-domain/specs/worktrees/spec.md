## ADDED Requirements

### Requirement: WORKTREE-01 — Worktree Entity Lifecycle

The system SHALL persist a first-class `Worktree` entity representing a checked-out git working copy of a project at a specific branch, supporting create (with three modes), read, rename (display name only in this phase), and delete operations. Each worktree SHALL be uniquely identified by a UUID and SHALL hold a unique `(project_id, name)` pair plus a unique absolute filesystem path.

#### Scenario: Create a worktree on a fresh branch from base ref
- **GIVEN** a project exists at `/Users/x/code/foo`
- **WHEN** the user creates a worktree with `mode: 'branch'`, `base_ref: 'main'`, and an auto-generated name
- **THEN** the system SHALL persist a new `worktrees` row with `status: 'pending'` and broadcast `worktree:new`
- **AND** the system SHALL run `git worktree add -b <branch_name> <abs_path> main` against `/Users/x/code/foo`
- **AND** upon successful checkout, SHALL update the row to `status: 'ready'` and broadcast `worktree:updated`
- **AND** the directory `~/.topics/worktrees/<project-slug>/<worktree-name>/` SHALL exist with the new branch checked out

#### Scenario: Create a worktree by reusing an existing branch
- **GIVEN** a project has an existing branch `feature/auth`
- **WHEN** the user creates a worktree with `mode: 'reuse'` and that branch name
- **THEN** the system SHALL run `git worktree add <abs_path> feature/auth`
- **AND** SHALL persist the row referencing that branch as the working branch
- **AND** SHALL NOT create a new branch

#### Scenario: Create a detached worktree at a specific ref
- **GIVEN** a project exists
- **WHEN** the user creates a worktree with `mode: 'detached'` and a ref (commit sha or tag)
- **THEN** the system SHALL run `git worktree add --detach <abs_path> <ref>`
- **AND** the row's `branch_name` SHALL be NULL
- **AND** the row's `mode` SHALL be `'detached'`

#### Scenario: Worktree creation fails when source repo is itself a worktree
- **GIVEN** the project's `path` is itself a git worktree (the resolved `.git` is a file, not a directory)
- **WHEN** the user attempts to create a worktree
- **THEN** the system SHALL reject the request with HTTP 400 and a clear error message
- **AND** SHALL NOT persist any row
- **AND** the error SHALL guide the user to pick the original repo instead

#### Scenario: Worktree creation surfaces git errors with status `error`
- **GIVEN** a worktree-creation `git worktree add` exits with a non-zero status
- **WHEN** the manager catches the failure
- **THEN** the row SHALL transition to `status: 'error'` with the captured stderr stored
- **AND** SHALL broadcast `worktree:updated` with the error payload
- **AND** the row SHALL NOT be auto-deleted (the user can retry or manually clean up)

#### Scenario: Concurrent worktree creations on the same project are serialised
- **GIVEN** the user issues two worktree-create requests against the same project within the same second
- **WHEN** both requests are processed
- **THEN** the system SHALL serialise them via an in-memory queue keyed by `project_id`
- **AND** the first SHALL complete before the second starts
- **AND** both SHALL eventually result in distinct worktree rows with `status: 'ready'`

#### Scenario: Concurrent worktree creations on different projects run in parallel
- **GIVEN** the user issues worktree-create requests against two different projects simultaneously
- **WHEN** both requests are processed
- **THEN** the system SHALL run them in parallel (the queue is per-project)
- **AND** total wall-clock SHALL approach max(t1, t2), not t1 + t2

### Requirement: WORKTREE-02 — Adjective-Noun Naming Generator

The system SHALL provide an automatic worktree-name generator that produces distinctive, filesystem-safe `<adjective>-<noun>` strings drawn from embedded vocabularies of approximately 500 adjectives and 500 nouns. Collision rate against existing worktree names SHALL be < 0.5% on a freshly-seeded project.

#### Scenario: Generator produces a unique name on first try
- **WHEN** the generator is invoked for a project with no existing worktrees
- **THEN** it SHALL produce a string matching `^[a-z]+-[a-z]+$`
- **AND** the string SHALL be safe for use as a directory name on macOS / Linux / Windows

#### Scenario: Generator suffixes on collision
- **GIVEN** a project already has a worktree named `lyrical-cobra`
- **WHEN** the generator returns `lyrical-cobra` again on a retry
- **THEN** after 5 collisions the generator SHALL append a 4-char hex suffix → `lyrical-cobra-3a7f`
- **AND** the resulting string SHALL still match `^[a-z]+-[a-z]+(-[0-9a-f]{4})?$`

#### Scenario: User can override the generated name at create time
- **GIVEN** the generator suggests `mural-polio`
- **WHEN** the user edits the name field to `feature-auth-redesign`
- **THEN** the system SHALL accept any string matching `^[a-z][a-z0-9-]{0,63}$`
- **AND** SHALL reject names with control chars, whitespace, or characters outside that regex

### Requirement: WORKTREE-03 — Worktree Deletion Cascade

When a worktree is deleted, the system SHALL clean up the on-disk directory, optionally delete the branch (if `mode = 'branch'` and the branch has no other worktrees), null out `topics.worktree_id` for any topic bound to that worktree (via FK `ON DELETE SET NULL`), and purge persisted ui_state references using the existing `purgeTopicFromUiState` machinery. The originating project SHALL be unaffected.

#### Scenario: Delete a `branch`-mode worktree removes the directory and branch
- **GIVEN** a worktree in `mode: 'branch'` exists with `branch_name: 'topics/lyrical-cobra'`
- **WHEN** the user issues `DELETE /api/worktrees/:id`
- **THEN** the system SHALL run `git worktree remove <abs_path>`
- **AND** SHALL run `git branch -D topics/lyrical-cobra` against the project's repo
- **AND** SHALL DELETE the row from the worktrees table
- **AND** any bound topics' `worktree_id` SHALL transition to NULL via FK
- **AND** SHALL broadcast `worktree:deleted`

#### Scenario: Delete a `reuse`-mode worktree preserves the branch
- **GIVEN** a worktree in `mode: 'reuse'` exists referencing branch `feature/auth`
- **WHEN** the user issues `DELETE /api/worktrees/:id`
- **THEN** the system SHALL run `git worktree remove <abs_path>`
- **AND** SHALL NOT run `git branch -D` (the branch may be referenced elsewhere)
- **AND** SHALL DELETE the row

#### Scenario: Bound topics fall back to project path after worktree deletion
- **GIVEN** a topic has `worktree_id` referencing worktree X with `abs_path = ~/.topics/worktrees/foo/lyrical-cobra/`
- **WHEN** worktree X is deleted
- **THEN** the topic's `worktree_id` SHALL be set to NULL via the FK cascade
- **AND** the topic SHALL continue to function with all chat, tool, and slash commands operating against `topic.project_path`
- **AND** the topic settings panel SHALL no longer show the Worktree section

#### Scenario: ui_state references to deleted worktree are purged atomically
- **GIVEN** a worktree is referenced inside a `pane-store-v2` snapshot in `ui_state`
- **WHEN** the worktree is deleted
- **THEN** the system SHALL extend the existing `purgeTopicFromUiState` transaction (`BEGIN IMMEDIATE` + `MAX(server_seq)+1`) to also strip references to the deleted worktree id
- **AND** SHALL broadcast a `ui-state:patch` event with the bumped `server_seq`
- **AND** the `payload_version=2` invariant SHALL be preserved

### Requirement: WORKTREE-04 — Worktree Rename (Display Name Only in This Phase)

The system SHALL allow renaming a worktree's display `name` (the string shown in the UI) without changing the underlying git branch name or the on-disk directory path. Git-branch rename is deferred to a later phase. The slug-derived directory path is determined at creation time and is immutable.

#### Scenario: Rename only updates display name
- **GIVEN** a worktree exists with `name: 'lyrical-cobra'` and `branch_name: 'topics/lyrical-cobra'`
- **WHEN** the user issues `PATCH /api/worktrees/:id` with `{ name: 'auth-redesign' }`
- **THEN** the system SHALL update only the `name` column to `'auth-redesign'`
- **AND** the `branch_name` column SHALL remain `'topics/lyrical-cobra'`
- **AND** the on-disk directory SHALL remain at the original `abs_path`
- **AND** SHALL broadcast `worktree:updated` with the new name

#### Scenario: Rename validates uniqueness within the project
- **GIVEN** project P has worktrees `lyrical-cobra` and `mural-polio`
- **WHEN** the user attempts to rename `mural-polio` → `lyrical-cobra`
- **THEN** the system SHALL reject the request with HTTP 409
- **AND** the conflict response SHALL name the existing worktree

### Requirement: WORKTREE-05 — Worktree-Aware Git Watcher

The git-watcher SHALL be extended to watch each worktree's absolute path independently of the project's primary path. When a watched path is a worktree, broadcasts SHALL include a `worktreeId` field. Existing watcher subscriptions on project paths without worktrees SHALL behave exactly as today.

#### Scenario: Watcher emits worktree-scoped status events
- **GIVEN** a worktree exists at `~/.topics/worktrees/foo/lyrical-cobra/`
- **WHEN** the user makes a file change inside that directory
- **THEN** within 500 ms (the existing debounce window) the watcher SHALL broadcast `git:status`
- **AND** the broadcast envelope SHALL include `worktreeId: <id>` alongside the existing `projectPath` field
- **AND** the broadcast SHALL contain the worktree's branch, ahead/behind, and porcelain status

#### Scenario: Project-path watcher is unchanged for non-worktree paths
- **GIVEN** a topic with `project_path = '/Users/x/code/foo'` and no worktree binding
- **WHEN** files change inside `/Users/x/code/foo`
- **THEN** the watcher SHALL emit `git:status` with no `worktreeId` field
- **AND** consumers that did not opt in to worktree awareness SHALL continue to handle the broadcast exactly as today
