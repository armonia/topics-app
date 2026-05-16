## ADDED Requirements

### Requirement: TOPIC-WT-01 — Optional Worktree Binding

A topic MAY optionally be bound to a single Worktree via the new `worktree_id` foreign key column. Topics not bound to a worktree (legacy topics, or new topics created with the default option) SHALL behave exactly as before this change. Binding is established at create time via the New Topic dialog or later via the topic settings modal.

#### Scenario: Create topic without worktree (default — preserves legacy behavior)
- **GIVEN** the user opens the New Topic dialog and selects a project path
- **WHEN** the user picks "Use project path directly" in the Worktree picker (the default)
- **AND** clicks Create Topic
- **THEN** the new topic SHALL be persisted with `worktree_id = NULL`
- **AND** all chat, tool, file, and git operations against the topic SHALL operate inside the topic's `project_path`
- **AND** the topic settings modal SHALL NOT show a Worktree section
- **AND** the user SHALL observe behavior identical to the pre-change baseline

#### Scenario: Create topic bound to a new worktree
- **GIVEN** the user opens the New Topic dialog and selects a project that supports worktrees
- **WHEN** the user picks "Create new worktree", chooses `mode: 'branch'`, accepts the auto-generated name, and clicks Create Topic
- **THEN** a worktree SHALL be created first (status: pending → ready)
- **AND** the topic SHALL be persisted with `worktree_id = <new worktree id>`
- **AND** subsequent chat/tool/file operations on the topic SHALL operate inside the worktree's `abs_path`, not the project's `path`
- **AND** the topic settings modal SHALL show the bound worktree (display name, branch name, abs path)

#### Scenario: Create topic bound to an existing worktree
- **GIVEN** project P already has worktrees `lyrical-cobra` and `mural-polio`
- **WHEN** the user opens New Topic, picks project P, picks "Pick existing worktree", and selects `mural-polio`
- **THEN** the topic SHALL be persisted with `worktree_id` referencing `mural-polio`
- **AND** operations SHALL run inside `mural-polio`'s `abs_path`

#### Scenario: Topic falls back to project path when worktree is deleted
- **GIVEN** a topic has `worktree_id` set to a worktree W
- **WHEN** worktree W is deleted via `DELETE /api/worktrees/:id`
- **THEN** the topic's `worktree_id` SHALL be NULLed via FK `ON DELETE SET NULL`
- **AND** subsequent operations on the topic SHALL operate inside `topic.project_path`
- **AND** the topic SHALL continue to function with no user-visible error
- **AND** the topic settings modal SHALL no longer show the Worktree section

#### Scenario: Slash commands resolve cwd from the worktree when bound
- **GIVEN** a topic is bound to worktree W with `abs_path = ~/.topics/worktrees/foo/lyrical-cobra/`
- **WHEN** the user issues `/files list` in the chat
- **THEN** the response paths SHALL be relative to (or contained within) `~/.topics/worktrees/foo/lyrical-cobra/`
- **AND** SHALL NOT include files from the project's primary `path`

### Requirement: TOPIC-WT-02 — Topic-Worktree Distinction From Message Branching

The Topic-level `worktree_id` (a git working copy) SHALL remain entirely separate from the Message-level branching system (`messages.parent_id` + `active_branches`). The two MUST NOT be confused in code, UI, or documentation. A topic's git worktree is unrelated to whether the user has edited-and-resent a message to create a sibling thread.

#### Scenario: Editing a message creates a message branch, not a worktree branch
- **GIVEN** a topic has at least one message
- **AND** the topic is bound to a worktree
- **WHEN** the user edits a previously-sent message
- **THEN** the system SHALL create a new sibling message under the same `parent_id` and update `active_branches` (the existing behavior)
- **AND** SHALL NOT create a new git branch
- **AND** SHALL NOT modify the worktree binding

#### Scenario: Switching message branches preserves worktree binding
- **GIVEN** a topic has multiple message branches
- **AND** the topic is bound to a worktree
- **WHEN** the user switches the active message branch
- **THEN** the topic's `worktree_id` SHALL remain unchanged
- **AND** the worktree's git branch SHALL remain checked out as it was

### Requirement: TOPIC-WT-03 — Topic Settings Show Bound Worktree (Read-Only)

When a topic has a non-null `worktree_id`, the topic settings modal SHALL display a Worktree section with the worktree's name, git branch name, base ref, and absolute filesystem path. The section is read-only in this phase — there is no in-modal control to change the binding or operate on the worktree. When `worktree_id` is null, the section SHALL be hidden entirely.

#### Scenario: Topic with worktree shows the section
- **GIVEN** a topic is bound to worktree `lyrical-cobra` on branch `topics/lyrical-cobra` with base ref `main`
- **WHEN** the user opens the topic settings modal
- **THEN** a Worktree section SHALL render with: name `lyrical-cobra`, branch `topics/lyrical-cobra`, base ref `main`, and the abs path
- **AND** no edit controls SHALL be present in this phase

#### Scenario: Topic without worktree omits the section
- **GIVEN** a topic with `worktree_id = NULL`
- **WHEN** the user opens the topic settings modal
- **THEN** no Worktree section SHALL render
- **AND** the modal SHALL look exactly as it did before this change
