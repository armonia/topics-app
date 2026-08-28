# Worktrees

First-class worktree entities backing topic-bound checkouts.

## Why a sweep exists

A worktree is a full checkout, and on this repository that is roughly 600 MB
each: measured on 2026-08-25, `~/.topics/worktrees` held **5.4 GB across nine
directories**, while the same repository carried **202 `topics/*` branches**
against **66 registered worktrees**. Branches outlive their checkouts about
three to one, which is the shape the sweep is built around — a branch is 41
bytes and a checkout is not.

The sweep is therefore not tidiness. Without it a machine that dispatches agents
fills its disk in weeks, and the requirements below describe what it is allowed
to throw away and — the harder half — what it must refuse to touch. Every rule
that RESERVES something is there because deleting it once cost real work:
uncommitted changes in a worktree the agent had not finished with, a branch that
looked landed by ancestry and was not, a checkout another session was standing
in. The one-way door is the reason the sweep asks `branch-status` (LAND-01) what
"merged" means instead of deciding for itself.

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

### Requirement: WORKTREE-06 — One root, and the environment decides it

The system SHALL resolve the directory that holds dispatch worktrees from the
environment, in this order: an explicit `TOPICS_WORKTREES_DIR`, otherwise
`<TOPICS_HOME>/worktrees`, otherwise `<home>/.topics/worktrees`. The resolution
SHALL be a pure calculation over strings and SHALL NOT touch the disk.

`TOPICS_WORKTREES_DIR` SHALL win outright: it is an override, not a subdirectory
of `TOPICS_HOME`.

The root SHALL NOT be computed anywhere else. A hard-coded
`<home>/.topics/worktrees` ignores `TOPICS_HOME`, and a worktree created outside
the root that every sweep scans is a worktree no sweep can ever find: measured
2026-08-19, fifty-five orphan directories (`e2e-naming-…`, `e2e-rename-…`,
`e2e-archive-…`) were invisible to every reaper for exactly that reason.

#### Scenario: `TOPICS_HOME` is set
- **GIVEN** `TOPICS_HOME` points at a directory
- **THEN** the worktree root SHALL be that directory plus `/worktrees`

#### Scenario: nothing is set
- **GIVEN** neither variable is set
- **THEN** the root SHALL be `<home>/.topics/worktrees`

#### Scenario: the explicit override
- **GIVEN** `TOPICS_WORKTREES_DIR` is set alongside a different `TOPICS_HOME`
- **THEN** the root SHALL be the override, and SHALL NOT be nested under `TOPICS_HOME`

### Requirement: WORKTREE-07 — Slimming deletes build output, and refuses anything git knows about

The system SHALL be able to reclaim the space a worktree spends on regenerable
directories by DELETING them — not by symlinking a shared copy. A shared
`node_modules` behind a symlink looks free and is not: a branch that changes
`client/package.json` would silently use another branch's dependencies, and an
install inside the worktree would write into the real ones.

The candidates SHALL come from a CLOSED list of names, and a name that is
generic SHALL stay off it. `node_modules`, the framework caches (`.next`,
`.nuxt`, `.svelte-kit`, `.turbo`, `.parcel-cache`, `.vite`, `.astro`), the
Python caches, and the QA output directories (`test-results`,
`playwright-report`) are on it. `dist`, `build`, `out` and `coverage` are NOT:
they are seventeen megabytes in total and their names mean different things in
different projects, which is the wrong trade for a deletion.

A directory whose name is ambiguous across ecosystems SHALL require a MARKER
inside it to qualify — `target` counts only when it carries `CACHEDIR.TAG`.

Before deleting anything, the system SHALL pass TWO gates, and a candidate that
fails either SHALL be REFUSED with the reason: git must declare the path
ignored, and git must find no tracked file underneath it. The tracked-file
question SHALL be asked first — a directory somebody force-added into the index
is somebody's decision, and it outranks the ignore rules.

Symlinks SHALL never be followed and never removed. The search SHALL NOT descend
into `.git`, SHALL stop at a bounded depth, and SHALL NOT descend into a
directory it has already matched.

An operator SHALL be able to exempt names through `TOPICS_WORKTREE_SLIM_SKIP`.

#### Scenario: the ordinary case
- **GIVEN** a worktree carrying `node_modules`, ignored by git and holding no tracked file
- **THEN** it SHALL be deleted, and the freed bytes SHALL be reported

#### Scenario: a tracked file inside an artefact directory
- **GIVEN** a directory on the list that nevertheless contains a tracked file
- **THEN** it SHALL be REFUSED with «contiene file tracciati», and SHALL survive

#### Scenario: ignored but not on the list
- **GIVEN** an ignored directory whose name is not on the closed list
- **THEN** it SHALL survive: being ignored is not enough to be regenerable

#### Scenario: the working tree is unchanged
- **GIVEN** a worktree before and after slimming
- **THEN** `git status --porcelain` SHALL be identical
- **AND** running the sweep a second time SHALL find nothing left to do

#### Scenario: the root is gone
- **GIVEN** a root directory that does not exist
- **THEN** the result SHALL be empty, and SHALL NOT be an error

### Requirement: WORKTREE-08 — A new worktree is born from `main`, never from `HEAD`

The system SHALL create a dispatch worktree from the integration branch, checked
by its full ref (`refs/heads/<main>`) so a file of the same name, or a remote of
the same name, cannot answer the question. A remote-only `origin/main` SHALL NOT
qualify.

When that branch cannot be verified — it does not exist, the project has no repo
path, or git does not answer — the system SHALL fall back to `HEAD` and SHALL
SAY SO, carrying both the flag and the reason. The fallback is a degraded mode
and must be legible as one.

Without a repo path the system SHALL fall back WITHOUT calling git at all.

> Written from the incident, not from the hypothesis. With `HEAD` as the base,
> one night (2026-08-11) produced: task branches inheriting 147 commits from
> other sessions, deliveries resting on commits that had never landed, two
> migration-number collisions (a tree stuck at 088 against a main at 089), an
> embedded manifest regenerated without somebody else's migration, and an agent
> that "fixed" tests on main while chasing a message that existed only on an
> unlanded branch — main red for an hour.

#### Scenario: the integration branch exists
- **GIVEN** a repository whose shared checkout is standing on some other branch
- **THEN** the new worktree SHALL still be based on `main`, with no fallback flag

#### Scenario: no such branch
- **GIVEN** a repository without a local `main`
- **THEN** the base SHALL be `HEAD`, the fallback flag SHALL be set, and the
  reason SHALL name the missing branch

#### Scenario: no repository path
- **GIVEN** a project with no repo path
- **THEN** the fallback SHALL be immediate, and git SHALL NOT be invoked

### Requirement: WORKTREE-09 — The sweep decides, and every doubt keeps

A periodic sweep SHALL consider every `ready` worktree and choose ONE of six
actions: `reap`, `land-then-reap`, `free-checkout`, `commit-residue`,
`abandon`, `keep`. Overlapping passes SHALL share the one in flight — two
sweeps writing at once fight over `index.lock`, and on 2026-08-19 that cost
seven worktrees.

A worktree whose task is NOT in a terminal state SHALL be kept. Terminal means:
the task is gone, `done`, or archived. A task with a LIVE turn SHALL be kept
whatever else is true, and that question SHALL be asked first.

Uncommitted work SHALL outrank every reason to delete, `done` included. Agent
junk (`.topics-daemon/`, generated summaries) SHALL NOT count as work. A git
probe that FAILS to answer SHALL count as dirty and never as clean: before this
rule a hiccup on `index.lock` unblocked the reap instead of stopping it.

A branch already merged into `main` — by the content rule of LAND-01, not by
ancestry — SHALL be reaped. A branch not merged SHALL NOT be reaped: depending
on what else is true it is landed first, or its checkout is freed, or it is left
to a human. Detached and reused checkouts SHALL always be left to a human.

After attempting a land, the sweep SHALL RE-READ the repository instead of
trusting the reported outcome. On 2026-07-19 a task lost 139 lines because the
outcome was believed.

Every worktree KEPT SHALL carry a normalized reason. Without it, thirty-eight
kept worktrees were invisible — no line, no why, and growing on the disk.

An error inside the pass SHALL NOT propagate: the sweep must never take the
server down with it.

#### Scenario: uncommitted work on a closed task
- **GIVEN** a `done` task whose worktree holds real uncommitted changes
- **THEN** the action SHALL NOT be `reap`
- **AND** the changes SHALL be committed to the branch first when that is possible

#### Scenario: clean but unmerged
- **GIVEN** a clean worktree whose branch is not in `main`
- **THEN** the action SHALL NEVER be `reap`

#### Scenario: the probe cannot answer
- **GIVEN** a worktree whose `git status` exits non-zero
- **THEN** it SHALL be treated as dirty, and kept with a reason

#### Scenario: an agent is working
- **GIVEN** a task with a live turn
- **THEN** the worktree SHALL be kept regardless of every other condition

#### Scenario: abandonment is bounded and narrow
- **GIVEN** a worktree idle beyond the abandonment threshold
- **THEN** it SHALL be abandoned ONLY when the task is `in_progress`, the
  worktree is clean, and the checkout is not detached
- **AND** a threshold of zero or less SHALL disable abandonment entirely

### Requirement: WORKTREE-10 — A directory is not a commit

When a branch cannot be landed but still exists, the sweep SHALL free the
CHECKOUT and leave the branch alone. Removing a working directory does not touch
a single commit as long as a ref still reaches it — and until this distinction
existed the only two answers were "destroy everything" and "touch nothing",
which on 2026-08-11 meant 77 worktrees and 33.9 GB held alive for "unmerged
commits" that were never at risk.

Before freeing the checkout the system SHALL STAMP the delivery branch on the
card, and SHALL do it BEFORE the removal, while the branch name is still known.
The stamp SHALL be a write that sets only the branch: it SHALL NOT clear an
existing delivery commit, diffstat or landing verdict. Without the stamp the
chain task → topic → worktree breaks, the land finds no branch, and the card
closes without merging anything — a fix was lost twice that way.

After freeing, the card SHALL receive a note naming the branch and the commands
to reach the work.

A free-checkout that fails SHALL fall back to keeping the worktree.

#### Scenario: unmergeable, branch alive
- **GIVEN** a terminal task, a clean worktree, a branch that is not in `main`
  and cannot be auto-landed
- **THEN** the directory SHALL be removed and the branch SHALL survive
- **AND** the branch SHALL still resolve, and its files SHALL still be readable
  through git

#### Scenario: the stamp comes first
- **GIVEN** a worktree about to be freed
- **THEN** the delivery branch SHALL be written to the card BEFORE the removal
- **AND** the write SHALL leave an existing delivery commit and landing verdict
  untouched, so the card stays inside the landing audit

### Requirement: WORKTREE-11 — The residue is put somewhere safe before the door closes

When a worktree holds uncommitted work that the sweep would otherwise have to
keep forever, the system SHALL be able to commit that work to its own branch,
so the directory stops being the only copy. Measured 2026-08-19: 191 worktrees,
none collected, 137 held for "uncommitted changes", roughly 6 GB duplicated
forever under closed tasks.

The commit SHALL carry the fixed subject `Residuo non committato, messo al
sicuro dalla potatura`, and its body SHALL say what it is NOT: not a delivery,
through no gate, reviewed by nobody. It SHALL NOT count as the task's own work
anywhere the task's commits are listed (LAND-02).

The system SHALL REFUSE to commit — and say so, rather than falling through to a
reap — when the worktree is in the middle of a git operation (merge,
cherry-pick, revert, rebase), when `HEAD` is detached, when the index carries a
conflict even with no operation ref present (a failed `stash pop` looks exactly
like that), or when the tree is clean (an empty commit is not a rescue).

The detached check SHALL be asked with `symbolic-ref HEAD`: the alternative
exits zero even on a path that does not exist, and was a check that checked
nothing.

The commit SHALL respect `.gitignore` and SHALL bypass hooks: a red gate here is
EXPECTED — this is a rescue, not a delivery.

#### Scenario: dirty worktree on a closed task
- **GIVEN** a terminal task whose worktree has uncommitted changes and a live branch
- **THEN** the changes SHALL be committed with the fixed subject
- **AND** only then MAY the checkout be freed

#### Scenario: a conflict with no operation in progress
- **GIVEN** a worktree whose index carries conflict markers after a failed `stash pop`
- **THEN** the commit SHALL be refused

#### Scenario: nothing to rescue
- **GIVEN** a clean worktree
- **THEN** no commit SHALL be created

### Requirement: WORKTREE-12 — The abandonment notice never contradicts itself

When the system unbinds or abandons a worktree it SHALL write a note on the card,
and that note SHALL describe the branch in one of THREE states: `present`,
`gone`, or `unverified`. `unverified` SHALL NOT be rendered as reassurance — it
means nobody looked.

A fixed sentence is forbidden. The historical failure this rule comes from
(task `5770b9de`) said, in the same line, that the branch did not exist and that
it was intact with nothing lost.

When the branch is present the note SHALL count the commits beyond `main`, SHALL
say plainly when there are none to recover, and SHALL admit when the count is
not obtainable instead of inventing a number. When the branch is gone the note
SHALL point at `git reflog` and `git fsck --lost-found`.

A card in `review` SHALL STAY in review: unbinding its dead worktree SHALL NOT
send it back to the backlog — it is waiting for a person, and the sweep is not
that person. When the branch is gone BECAUSE the work landed, the note SHALL
explain the landing rather than raise an alarm.

#### Scenario: the branch survived
- **GIVEN** an abandoned worktree whose branch still exists with commits beyond `main`
- **THEN** the note SHALL name the branch and how many commits it holds

#### Scenario: nobody could look
- **GIVEN** an abandoned worktree with no repo path
- **THEN** the state SHALL be `unverified`, and the note SHALL say the branch was
  NOT verified and how to check by hand

#### Scenario: the branch is gone because it landed
- **GIVEN** a card in review whose branch was deleted by a successful land
- **THEN** the card SHALL stay in review
- **AND** the note SHALL explain the landing instead of warning about a lost branch

### Requirement: WORKTREE-13 — A worktree is born able to compile the desktop crate

A newly created worktree SHALL be given the Tauri sidecars of the main checkout
(`desktop-tauri/src-tauri/binaries/`), because git does not track them and
`tauri-build` refuses to compile without them: without this step no agent can
prove a Rust change builds, nor notice it broke the build, and the first place a
mistake appears is Windows CI.

The provisioning SHALL be a CLONE and not a link wherever the filesystem shares
blocks (`cp -Rc`, `--reflink=auto`), so that a build run inside the worktree
cannot write through into the real checkout. A link SHALL be used only as a
fallback. The step SHALL be best effort: it SHALL NOT prevent a worktree from
being born, and a main checkout without sidecars is a normal state, not a
failure.

The ignore rule for that path SHALL match a SYMLINK as well as a directory. This
is the half that is forgotten: with the trailing-slash form a provisioned link
shows up as untracked, and one `git add -A` commits an absolute home path into a
public repository.

When the sidecars are absent the failure SHALL be legible: a check SHALL name
the missing setup and exit with the NOT MEASURED code (97) instead of letting a
setup problem read as a compile error.

#### Scenario: a fresh worktree
- **GIVEN** a main checkout that holds the sidecars
- **WHEN** a worktree is created
- **THEN** the worktree SHALL hold them too, and `git status` SHALL stay clean

#### Scenario: nothing to hand over
- **GIVEN** a main checkout without sidecars
- **THEN** the worktree SHALL still be created, and the step SHALL report that
  there was no source

#### Scenario: run twice
- **GIVEN** a worktree that already holds the sidecars
- **THEN** the provisioning SHALL leave them alone and report them present
