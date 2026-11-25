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
actions: `reap`, `archive-then-free`, `free-checkout`, `commit-residue`,
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
on what else is true its tip is pinned under `refs/topics/archive/<task>` and
then its checkout is freed, or it is left to a human. The sweep SHALL NEVER
merge a branch into `main`: a card closed without a land may have been closed
that way on purpose, and archiving SHALL happen whatever the board's auto-merge
setting says, because archiving is not landing. Detached and reused checkouts
SHALL always be left to a human.

Before destroying a branch, the sweep SHALL RE-READ the repository instead of
trusting a reported outcome: neither the card's recorded landing state nor what a
land (the manual one, which shares this guard) said it did. On 2026-07-19 a task
lost 139 lines because the outcome was believed.

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

### Requirement: WORKTREE-14 — A sub-agent can be born in a worktree of its own

A sub-agent spawned by another session SHALL be able to run in its OWN checkout
instead of the parent's directory, and that checkout SHALL be born through the
same path a board card uses: a branch worktree of the parent's project, based on
the integration branch by WORKTREE-08, materialised through WORKTREE-01 and
awaited until it is `ready`.

The isolation SHALL be opt-in. Without it the child keeps today's behaviour and
inherits the parent's working directory: a checkout is roughly 600 MB, and a
cost paid by every chat that delegates anything is not a cost anyone chose.

The project SHALL be resolved from a directory, in order: the requested working
directory, the parent's, then the working directory of the parent's topic. A
directory that is ITSELF a worktree SHALL resolve to the project that worktree
belongs to, because the parent may well be a card's agent already standing in
one. When no directory names a project the request SHALL be refused, and the
refusal SHALL name the path it could not place.

While a live session stands inside a worktree directory, the sweep SHALL keep
it, and SHALL ask that question BEFORE every other one. A worktree born minutes
ago holds no commits and belongs to no task, which is exactly the shape the
sweep reaps: without this rule the directory disappears under a child that is
still working in it.

When the child exits, nothing SHALL be deleted on the spot. The checkout stops
being live and the ordinary sweep judges it by WORKTREE-09 and WORKTREE-10: a
child that committed nothing is reaped, a child that committed keeps its branch
and loses only the directory. The parent SHALL NOT merge, land, or run git on
the child's branch.

The parent SHALL be told the branch: at spawn, in the list of its agents, when
it stops one, and in the exit report the chat receives. A parent that cannot
name the branch cannot read the work, and the work is the only reason the child
had a directory of its own.

#### Scenario: two children of the same parent do not share a directory
- **GIVEN** a parent session in a project, and two sub-agents spawned with
  worktree isolation
- **THEN** each child SHALL get its own directory and its own branch, both based
  on `refs/heads/main` even when the shared checkout stands elsewhere
- **AND** the same file written and committed in both SHALL differ between the
  two branches, with the integration branch untouched

#### Scenario: the parent is itself standing in a worktree
- **GIVEN** a parent whose working directory is a registered worktree, not a
  project path
- **THEN** the project SHALL be resolved through that worktree's project
- **AND** a directory that matches neither SHALL be refused with a message
  naming that path

#### Scenario: the sweep does not reap under a live child
- **GIVEN** a worktree with no task bound to it and a live session whose working
  directory is inside it
- **THEN** the sweep SHALL keep it, with the reason naming the live session
- **AND** that question SHALL be asked before the branch, the disk or the task
  are looked at

#### Scenario: after the child exits the ordinary rules decide
- **GIVEN** a worktree whose child has exited, leaving no live session inside
- **THEN** no immediate deletion SHALL happen because of the exit
- **AND** the next sweep SHALL judge it by WORKTREE-09 and WORKTREE-10

#### Scenario: the parent reads the branch
- **GIVEN** a sub-agent born in a worktree
- **THEN** the spawn answer, the agent list and the stop answer SHALL each name
  its branch
- **AND** a sub-agent without a worktree SHALL leave all three exactly as they
  are today

### Requirement: WORKTREE-15 — A new worktree is ready to use

A new worktree SHALL receive the untracked files its project selects in
`.worktreeinclude` at the project root, written with gitignore syntax: a card on
a project that needs `.env` cannot start without it, and git never copies it.
Only untracked files SHALL be copied. A pattern containing `..` SHALL make the
whole file refused, and a symlink, or a file that resolves outside the project
root, SHALL be skipped and logged. A failure while copying SHALL NOT cost the
card its worktree.

A project MAY declare three commands in `.topics/worktree.json`, all optional:
`setup`, `run` and `archive`, each as `{ "command": "...", "args": [...] }`.
`setup` SHALL run when the worktree is created, after the included files and the
dependencies, with a timeout of 120 s by default and 300 s at most, so that it
fits inside the agent's readiness wait. Its outcome (succeeded, failed or timed
out, the exit code, and the last 20 lines of output) SHALL appear in the card's
thread, and a failure SHALL NOT stop the turn. `run` SHALL join the project's
script runner. `archive` SHALL run before the worktree is removed.

Each worktree SHALL have a port, handed to every command above and to the
script runner as `TOPICS_PORT`. The port SHALL be the same after a server
restart, and two worktrees SHALL have different ports. Ports SHALL be claimed
oldest first, by creation time: a newcomer whose hash lands on a taken port
takes the next free one and never moves the port of a worktree whose server may
already be running.

#### Scenario: a card finds its `.env` and its setup done
- **GIVEN** a project whose `.worktreeinclude` lists `.env` and whose
  `.topics/worktree.json` declares a `setup`
- **WHEN** a card launches in a new worktree
- **THEN** the worktree SHALL contain the project's `.env`, and no tracked file
  SHALL have been copied by the include step
- **AND** the card's thread SHALL say the setup succeeded, with its last lines

#### Scenario: nothing leaves the project root
- **GIVEN** a `.worktreeinclude` with a pattern containing `..`, or a selected
  path that is a symlink to a file outside the project
- **THEN** no file outside the project root SHALL be copied

#### Scenario: a failed or slow setup leaves a readable outcome
- **GIVEN** a setup that exits with a non-zero code, or runs past its timeout
- **THEN** the outcome SHALL say failed or timed out, with the last lines of
  output, and the turn SHALL start anyway

#### Scenario: ports are distinct and stable
- **GIVEN** two worktrees of the same project
- **THEN** they SHALL have different ports, and each SHALL keep its port after
  the server restarts
- **AND** a newer worktree whose port collides SHALL NOT move the older one

### Requirement: WORKTREE-16 — A worktree nobody's sweep owns is still swept, and a live one is never touched

The sweep of WORKTREE-01..15 only knows the worktrees Topics made itself. The
ones made by the desktop app, by a sub-agent of Claude Code, or by hand sit in
`git worktree list` with nobody in charge: four of them lived INSIDE the
repository on 2026-10-22, 1.6 GB that every search of the checkout walked. A
second, scheduled pass SHALL read `git worktree list` and treat a worktree as an
orphan only when ALL of these hold: it is not the main checkout, not locked and
not managed by the Topics sweep; no process has its working directory inside; its
tree is clean; nothing happened in it for 7 days; and its branch is an ancestor
of `origin/main` or a merged pull request had exactly the branch tip as its head.
An orphan SHALL go to the Trash and be pruned, never deleted; the branch SHALL
stay. Anything else SHALL be listed with its owner, read from the path, and the
reason it was kept. The pass SHALL print a table and remove nothing unless asked.

#### Scenario: one missing condition keeps the worktree
- **GIVEN** an orphan, with exactly one condition spoiled (main checkout, locked,
  managed, a process inside, uncommitted work, active within 7 days, detached HEAD,
  branch not landed)
- **THEN** the pass SHALL keep it and say why

#### Scenario: the maker is read off the path
- **THEN** a path under `.claude/worktrees/agent-` SHALL be a Claude Code
  sub-agent, one under `.claude/worktrees` a desktop-app session, one in a
  `scratchpad` an agent session, and anything else a worktree made by hand

### Requirement: WORKTREE-17 — Branches of finished cards leave origin on every audit round

On every delivery-audit round the system SHALL delete from origin the branches
whose cards are ALL done or archived and none `unpushed`. A branch contained in
main is deleted outright; one outside main is deleted only after a LOCAL
`archive/<branch>` tag keeps its tip. A branch with an open card, a branch no
card owns, and main itself SHALL stay. The delete SHALL use a lease on the tip
that was read.

#### Scenario: finished card outside main
- **GIVEN** a branch on origin whose only card is done and whose tip is not in main
- **THEN** a local archive tag SHALL be created, then the branch deleted with a lease on that tip

### Requirement: WORKTREE-18 — A card that declares a wait keeps the branch it worked on

When an agent declares a wait, the card SHALL write the branch of its worktree
into `prior_branch` before the link to the topic is cleared, when that branch
has commits ahead of main. Without commits ahead, the `prior_branch` the card
already had SHALL stay as it was. A rerun then starts from that branch, not
from main.

#### Scenario: wait with commits on the branch
- **GIVEN** a card with an assigned topic whose worktree branch is ahead of main
- **WHEN** the agent declares a wait
- **THEN** `prior_branch` SHALL be that branch, and the topic link SHALL be cleared

#### Scenario: wait with nothing ahead of main
- **GIVEN** a card with `prior_branch` set and a worktree branch with no commits ahead of main
- **WHEN** the agent declares a wait
- **THEN** `prior_branch` SHALL keep its value

### Requirement: WORKTREE-STD-01 — La radice delle worktree e i suoi tetti sono impostazioni della macchina
**Intersects:** KANBAN-76

La radice in cui nascono le worktree SHALL risolversi, in quest'ordine, da env `TOPICS_WORKTREES_DIR`, dall'impostazione `app_settings.worktree_root`, dal default `<casa di Topics>/worktrees`; un valore vuoto a un passo SHALL cadere al successivo. L'impostazione SHALL essere un percorso assoluto fuori da `/tmp`: un valore relativo o in un'area temporanea SHALL essere rifiutato dalla rotta e ignorato dal risolutore. Cambiare la radice SHALL valere per le worktree nuove senza riavvio; quelle esistenti SHALL restare dove sono e una riga con percorso nella vecchia radice SHALL restare rimovibile da Topics. Il tetto di worktree per progetto (default 20), il pavimento di disco libero (default 12 GB, che sostituisce la costante del dispatcher), la modalità di `CARGO_TARGET_DIR` (`shared` | `per-worktree`, default `shared`), il permesso di pulire worktree fatte altrove (`off` | `merged`, default `off`) e i giorni dopo cui un ramo non unito è fermo (default 7) SHALL essere impostazioni, tutte vuote di default con il comportamento di prima.

#### Scenario: l'ordine di risoluzione
- **GIVEN** un'impostazione `worktree_root` valorizzata e l'env `TOPICS_WORKTREES_DIR` valorizzata
- **WHEN** si risolve la radice
- **THEN** SHALL vincere l'env; senza env SHALL vincere l'impostazione; con l'impostazione vuota SHALL vincere `<casa>/worktrees`

#### Scenario: un valore sbagliato non passa
- **GIVEN** la richiesta `PUT /api/app-settings` con `worktreeRoot: "/tmp/wt"` o `"wt"`
- **THEN** la risposta SHALL essere 400 sul campo `worktreeRoot` e il valore salvato SHALL restare quello di prima

### Requirement: WORKTREE-STD-02 — I checkout usa-e-getta stanno nella radice, sotto `_scratch`
**Intersects:** LAND-19, LAND-20

I checkout temporanei di land, realign, misura di integrazione e controlli dei nodi SHALL nascere in `{radice}/_scratch/{land|realign|integrazione|node-checks}/{id}` e NON SHALL usare la cartella temporanea di sistema. All'avvio del server, prima di qualunque lavoro, SHALL essere tolto ciò che il processo precedente ha lasciato in `land`, `realign`, `integrazione` e (col suo pool) `node-checks`, dal disco e da `git worktree list`; anche i controlli dei nodi lasciati nella vecchia cartella temporanea SHALL essere tolti una volta. Due server con case diverse NON SHALL spazzare i checkout l'uno dell'altro.

#### Scenario: ciò che il processo prima ha lasciato sparisce all'avvio
- **GIVEN** una worktree registrata in `{radice}/_scratch/land/<id>` lasciata da un processo ucciso
- **WHEN** parte la spazzata d'avvio
- **THEN** la cartella SHALL non esistere più e `git worktree list` SHALL non nominarla; una worktree sotto `{radice}/<progetto>/` SHALL restare intatta

### Requirement: WORKTREE-STD-03 — Il GC guarda la radice e le righe insieme, e non rimuove mai lavoro vivo
**Intersects:** WORKTREE-09, KANBAN-76

Il GC SHALL unire la lettura della radice (`{radice}/*/*`, esclusa `_scratch`), le righe del DB e `git worktree list --porcelain -z` dei progetti noti, e classificare ogni cartella: unita e pulita (reap), ferma da più dei giorni impostati (archive-then-free), orfana con `.git` (registrata e poi giudicata), fantasma senza `.git` e fuori da git (rimossa, età minima 24 ore), riga senza cartella, errori compresi (riga chiusa), fuori radice (solo inventario, rimozione solo su richiesta con anteprima). Il GC NON SHALL mai rimuovere una worktree lockata da altri, sporca, con commit non raggiungibili da un altro ref, con card attiva, né una cartella senza riga o una riga in errore più giovane di 24 ore, e SHALL scrivere `refs/topics/archive/<task>` (`wt-<id>` se la riga non ha task) prima di liberare o abbandonare un checkout e rimuovere solo con `git worktree remove` (il `rm` vale solo per i fantasmi: senza `.git`, non elencati da git, a due livelli sotto la radice, mai un link). `create` SHALL scrivere il marcatore `.git/worktrees/<id>/topics-owner` (mai `git config`) e prendere `git worktree lock --reason topics:<nome>`, che `delete` toglie prima di rimuovere; un lock con un'altra ragione NON SHALL mai essere tolto e `delete` lo rifiuta. Una riga che fallisce 3 passate di fila SHALL essere lasciata stare fino al riavvio. Il GC SHALL girare 120 s dopo l'avvio, ogni 30 minuti e a ogni `create` oltre il tetto, e `POST /__daemon/worktree-gc?dryRun=1` SHALL elencare per cartella classe, azione e peso senza toccare niente.

#### Scenario: l'anteprima non cambia niente
- **GIVEN** una radice con una worktree unita, una sporca e una fantasma
- **WHEN** si chiama il GC con `dryRun=1`
- **THEN** la risposta SHALL dare classe e azione di ciascuna e il disco e il DB SHALL restare identici

#### Scenario: la barra del disco
- **GIVEN** la radice reale dopo un giro di GC
- **WHEN** gira `bun scripts/worktree-orphans.ts --check`
- **THEN** SHALL uscire 1 se resta un fantasma, un orfano non registrato o una riga senza cartella, o se la scansione supera 2 secondi

### Requirement: WORKTREE-STD-04 — I tetti per progetto e il target di Rust condiviso

Oltre il tetto di worktree per progetto il GC SHALL prima alleggerire (slim) le worktree in review o backlog non vive, poi rimuovere la più vecchia tra quelle ammesse. Con `cargo_target_mode = shared` l'ambiente dell'agente SHALL ricevere `CARGO_TARGET_DIR={radice}/_cache/cargo/{slug}`, uno per progetto; con `per-worktree` NON SHALL ricevere nulla.

#### Scenario: oltre il tetto
- **GIVEN** un progetto con tetto 2 e tre worktree ammesse alla rimozione di età diverse
- **WHEN** gira il GC
- **THEN** SHALL restare in numero il tetto e SHALL essere stata rimossa la più vecchia, dopo lo slim delle ferme

#### Scenario: il target condiviso
- **GIVEN** `cargo_target_mode = shared`
- **WHEN** parte un agente su una worktree del progetto `p`
- **THEN** il suo ambiente SHALL avere `CARGO_TARGET_DIR` uguale a `{radice}/_cache/cargo/p`

### Requirement: WORKTREE-STD-05 — Una worktree non è mai un progetto
**Intersects:** TOPIC-WT-02

`canonicalProjectFor(path)` SHALL fare `realpath` del percorso, leggere la common dir git e restituire l'id del progetto il cui `path` ha la stessa common dir; la dispatcher, l'adozione di una sessione, l'aggancio automatico e `POST /api/projects` SHALL usarla, così che un percorso di worktree (o un alias di cartella) NON SHALL più creare un progetto con la sua board. Una cartella sparita SHALL riconoscersi dal segmento `{radice}/{slug}/`.

#### Scenario: tre vie, lo stesso progetto
- **GIVEN** un progetto per un repo, una sua worktree, un link simbolico al repo e una worktree la cui cartella non esiste più
- **WHEN** si chiede il progetto canonico di ciascuno
- **THEN** SHALL tornare sempre l'id del progetto del repo

### Requirement: WORKTREE-STD-06 — I repo fratelli si accorpano o si separano, senza toccare le card
**Intersects:** KANBAN-107, TOPIC-09

`projects.parent_id` e `projects.merge_mode` (`accorpa` | `separa`, default `accorpa`) SHALL stare sul progetto figlio, con un interruttore nel menu del progetto e nelle sue impostazioni. La board del padre SHALL includere le card del padre e dei figli `accorpa`, ciascuna col figlio come etichetta; la sidebar SHALL mostrare i topic dei figli `accorpa` sotto il padre; `separa` SHALL lasciare tutto com'è. Nessuna riga di `tasks` e nessun `project_path` esistente SHALL cambiare; la migrazione SHALL assegnare `parent_id` ai progetti-worktree già presenti dalla common dir o dal segmento della radice.

#### Scenario: accorpa e separa
- **GIVEN** un progetto padre con 3 card e un figlio con 9, entrambi su `accorpa`
- **WHEN** si guarda la board del padre, poi si imposta il figlio su `separa`
- **THEN** la board SHALL mostrare 12 card con l'etichetta del figlio su 9, poi 3; la tabella `tasks` SHALL risultare identica byte per byte

### Requirement: WORKTREE-STD-07 — Le worktree fuori radice si adottano o si spostano con anteprima

«Adotta» SHALL creare una riga `mode: "reuse"` così che il GC la veda. «Sposta» SHALL usare `git worktree move` e `repair` e SHALL rifiutare una worktree sporca, con sottomoduli o con sessione viva, dando prima un'anteprima di cosa farebbe. Dopo lo spostamento `git worktree list` SHALL combaciare con la riga. La UI SHALL contare le worktree esistenti fuori radice («fuori radice: N»).

#### Scenario: lo spostamento rifiutato
- **GIVEN** una worktree fuori radice con un file modificato
- **WHEN** si chiede di spostarla
- **THEN** SHALL rispondere col motivo e restare dov'è; pulita e senza sessione viva SHALL spostarsi e la riga SHALL indicare il nuovo percorso

### Requirement: WORKTREE-STD-08 — Una porta di registrazione per i worktree fatti da altri, aperta solo dal token degli hook

`POST /api/worktrees/register` (`{path, creator, session?, branch?, name?}`) SHALL registrare un worktree creato da un altro strumento ed SHALL essere idempotente sul percorso: la seconda chiamata SHALL restituire la stessa riga senza crearne un'altra. Un repository che nessun progetto conosce SHALL avere risposta 202 `{class:"inventory"}` e NON SHALL scrivere niente, né nel DB né nel `.git` di quel repository. Dentro la radice SHALL nascere una riga `ready` con `source` = creatore e `session_ref`, e il marcatore v2 SHALL essere scritto o completato; fuori dalla radice SHALL nascere una riga `reuse` e NON SHALL essere scritto alcun marcatore. Un checkout principale, un percorso relativo o un creatore `topics` o sconosciuto SHALL essere rifiutati con 400. `GET /api/worktrees/placement?repo=` SHALL restituire `{root, slug, projectId}` applicando l'impostazione della radice; Il ramo registrato SHALL essere quello che il checkout ha in HEAD, mai quello del corpo; la riga SHALL essere `branch` (il GC può cancellare il ramo) solo dentro la radice e solo per il ramo nato col checkout (`worktree-<nome della cartella>` o `topics/*`), `reuse` per ogni altro ramo. Due registrazioni simultanee dello stesso percorso SHALL dare una riga sola. Una riga scritta per un altro creatore NON SHALL essere toccata dal GC (spazzata e tetto) per 24 ore dalla registrazione. `POST /api/worktrees/unregister` SHALL dimenticare la riga di una cartella che non c'è più, SHALL rifiutare con 409 una cartella ancora presente e una riga fatta da Topics. Le tre rotte SHALL richiedere il token degli hook (`claude-hooks/hook-token`) e una richiesta indirizzata a questa macchina; una credenziale delegata di nodo o un ospite SHALL essere rifiutati con 403 anche col token giusto, e senza token o con un token sbagliato la risposta SHALL essere 401, sempre prima di qualunque effetto. La tabella `worktrees` SHALL avere `source TEXT NOT NULL DEFAULT 'topics'` e `session_ref TEXT`; le righe esistenti SHALL leggersi `topics`. Adottare una sessione avviata in un worktree sotto la radice SHALL riuscire se quel percorso ha una riga o un marcatore, e SHALL restare rifiutato per una cartella che non ha né l'una né l'altro.

#### Scenario: chi può aprire la porta
- **GIVEN** una richiesta di registrazione valida
- **WHEN** arriva senza token, con un token sbagliato, da una credenziale delegata, da un ospite o indirizzata a un altro host
- **THEN** la risposta SHALL essere 401 o 403 e nessuna riga né marcatore SHALL essere scritto; col token degli hook da questa macchina SHALL nascere la riga, una volta sola

#### Scenario: un repository ignoto
- **GIVEN** un worktree di un repository che nessun progetto conosce
- **WHEN** si chiede di registrarlo
- **THEN** la risposta SHALL essere 202 `inventory` e il DB e la cartella amministrativa del worktree SHALL restare identici

### Requirement: WORKTREE-STD-09 — Marcatore v2, lock per creatore e i due archivi

Il marcatore `topics-owner` SHALL accettare i campi opzionali `creator`, `session {id, transcript?}` e `machine`; un marcatore v1 SHALL continuare a leggersi e un creatore ignoto SHALL leggersi `adopted`. Il motivo di un lock SHALL nominare chi l'ha preso (`<creatore>:<etichetta>`) e solo i prefissi registrati (`topics:`, `claude-code:`) SHALL avere una regola: un lock con un prefisso che nessuno ha registrato NON SHALL mai essere tolto. Un lock `claude-code:<sessione>` SHALL essere tolto solo se il marcatore dice `creator: claude-code` con la stessa sessione, il transcript non cambia da `worktree_abandon_days`, l'albero è pulito, ogni commit è su un remote e il worktree ha più di 24 ore; un fatto che non si legge vale no. Una cartella senza riga sotto la radice con un marcatore v2 di un progetto noto SHALL essere registrata subito, senza aspettare 24 ore. Quando decide se un commit è già archiviato il GC SHALL leggere entrambi gli spazi, `refs/topics/archive/*` e i tag `archive/wt-*`.

#### Scenario: il lock di una sessione finita
- **GIVEN** due worktree con lock `claude-code:`, uno con transcript fermo da 10 giorni e uno vivo, entrambi puliti e pushati
- **WHEN** il GC applica la regola
- **THEN** SHALL togliere il lock del primo e lasciare quello del secondo; un lock `codex:` SHALL restare in ogni caso

### Requirement: WORKTREE-STD-10 — Le regole di percorso valgono anche su Windows

Il confronto fra una cartella e i cwd vivi (terminali, sottoagenti, processi avviati da Topics) SHALL usare `isInsideDir` con le regole della piattaforma, mai un separatore `/` aggiunto a mano. `canonicalPath` SHALL usare il realpath nativo su Windows e il confronto fra percorsi SHALL ignorare le maiuscole lì, così due grafie dello stesso percorso SHALL portare alla stessa riga. `POST /api/worktrees/relocate` SHALL accettare un percorso assoluto di Windows (`C:\…`) e rifiutare quello relativo al disco (`C:repo`). Ogni `git worktree add` su Windows SHALL portare `-c core.longpaths=true`. Su Windows un `EBUSY` o `EPERM` nella rimozione SHALL valere «vivo»: la riga resta, il giro dopo riprova, nessun secondo `--force` né `rm`. Ogni regola SHALL ricevere la piattaforma come parametro, così che sia provata su qualunque macchina.

#### Scenario: un cwd di Windows sotto la cartella
- **GIVEN** un terminale vivo con cwd `C:\…\worktrees\repo\x\packages\a`
- **WHEN** il GC chiede se qualcuno è dentro `C:\…\worktrees\repo\x` con piattaforma `win32`
- **THEN** la risposta SHALL essere sì

### Requirement: WORKTREE-STD-11 — Il nodo riferisce, il primario decide la policy, il nodo esegue
**Intersects:** MACHINE-02

Ogni server Topics SHALL restare l'unico che scrive la propria tabella `worktrees` e tocca il proprio disco; il primario SHALL tenere solo un riepilogo per macchina in `machines.worktree_summary` (`{supported, summary:{root, count, bytes, rootFreeGb, foreign, ghosts, orphans, scanMs, at}}`), scritto dal giro di heartbeat e solo quando cambia. `GET /api/version` SHALL dichiarare `worktreeStandard: 1`; un nodo che non lo dichiara SHALL essere registrato come vecchio e saltato senza chiamarlo e senza errore, e la UI SHALL dirlo. Sul nodo: `GET /api/nodes/worktrees[?list=1]` SHALL rispondere subito con l'ultima misura (nulla finché non c'è la prima; una misura scaduta ne avvia una nuova in background, una alla volta); `PUT /api/nodes/worktree-policy` (`root`, `maxPerProject`, `diskFloorGb`, `gcForeign`, `abandonDays`, `cargoTargetMode`, `dryRun?`) SHALL scrivere nelle impostazioni del nodo con le stesse regole di `PUT /api/app-settings`, e una policy fuori schema (chiave ignota, tipo sbagliato, valore rifiutato, corpo vuoto o non oggetto) SHALL dare 400 senza scrivere niente; `POST /api/nodes/worktrees/gc` SHALL lanciare la passata del nodo, e con `dryRun=1` SHALL restituire l'anteprima senza scrivere niente. Nessuna rotta SHALL rimuovere un percorso ricevuto dal chiamante: l'unica rimozione è la passata del GC del nodo col suo contratto di sicurezza. Le tre rotte SHALL accettare solo la credenziale del primario che tiene il canale del nodo o il proprietario della macchina; una credenziale delegata SHALL essere rifiutata con 403 prima di qualunque effetto, anche col ruolo di proprietario, e così un ospite. Sul primario `GET /api/machines/worktrees` SHALL dare una riga per macchina (questa per prima, misurata qui) e `PUT /api/machines/:id/worktree-policy` / `POST /api/machines/:id/worktree-gc` SHALL controllare la forma della policy prima di chiamare il nodo e inoltrare con la credenziale del nodo, mai con una delegata. Impostazioni > Worktree SHALL mostrare per ogni macchina worktree, GB, spazio libero sotto la radice e «fuori radice».

#### Scenario: chi può chiedere
- **GIVEN** le tre rotte del nodo
- **WHEN** arriva una credenziale delegata (anche con ruolo di proprietario), un ospite o un nodo che non tiene il canale
- **THEN** la risposta SHALL essere 403 e nessuna misura, policy o passata SHALL partire

#### Scenario: anteprima e fuori schema
- **GIVEN** una policy con `dryRun: true`, una con una chiave ignota e una con `root: "/tmp/wt"`
- **WHEN** il primario le manda al nodo
- **THEN** la prima SHALL rispondere prima/dopo senza scrivere, le altre due SHALL dare 400 e le impostazioni del nodo SHALL restare identiche

#### Scenario: un nodo vecchio
- **GIVEN** un nodo la cui `/api/version` non dichiara `worktreeStandard`
- **WHEN** gira l'heartbeat o si chiede una policy o una passata
- **THEN** il nodo SHALL non ricevere nessuna chiamata di worktree, la riga SHALL dire «nodo vecchio» e la risposta SHALL essere 200 `skipped`

### Requirement: WORKTREE-STD-13 — L'hook WorktreeCreate / WorktreeRemove di Claude Code mette i worktree nella radice
**Intersects:** CCS-06

`scripts/claude-hooks/worktree-hook.sh create` SHALL leggere dal payload di Claude Code `name`, `cwd`, `session_id` e `transcript_path`, creare il worktree in `{radice}/{slug}/{nome}` (radice e slug da `GET /api/worktrees/placement`, oppure `TOPICS_WORKTREES_DIR` o `{TOPICS_HOME}/worktrees` e il nome della cartella del repository quando il server non risponde) sul ramo `worktree-<nome>` da `origin/HEAD` (dopo un fetch di al più 5 secondi; `HEAD` senza remote), copiare i file di `.worktreeinclude` che sono anche ignorati da git, scrivere il marcatore v2 con `creator: claude-code`, sessione, transcript e macchina, prendere il lock `claude-code:<sessione>`, registrarlo con `POST /api/worktrees/register` e stampare il percorso come ultima riga dello stdout, tutto il resto su stderr. Un nome SHALL essere ridotto alla regola `^[a-z][a-z0-9-]{0,63}$` (`Feature/X+Y` → `feature-x-y`); una cartella altrui con lo stesso nome SHALL far scegliere `-2`; la stessa richiesta ripetuta SHALL ristampare lo stesso percorso senza un secondo worktree. Con Topics spento il worktree SHALL nascere lo stesso; con la radice non scrivibile SHALL nascere in `<repo>/.claude/worktrees/<nome>`. `remove` SHALL scrivere prima il tag `archive/wt-<nome>` sull'HEAD (con un albero sporco, su un commit figlio dell'HEAD che contiene le modifiche e i file non tracciati) e, se non si rilegge uguale, NON SHALL rimuovere niente; poi SHALL togliere cartella e ramo `worktree-<nome>` (solo se punta ancora all'HEAD archiviato) e chiamare `unregister`. Su un checkout principale o su un lock con un prefisso diverso da `claude-code:` SHALL uscire 1 senza toccare niente. Ogni percorso mandato al server SHALL essere nella forma nativa dell'host (`cygpath -m` su Git for Windows) e il token NON SHALL comparire negli argomenti di un processo. Le sessioni Claude che Topics avvia (chat, board, terminali) SHALL portare la coppia di hook nel loro unico `--settings`, sincrona, con timeout 120 e 60 secondi, salvo `claude_worktree_hooks = off` (default `topics`); `install-claude-hooks.ts install --worktrees` SHALL aggiungerla una volta sola al `settings.json` globale e `uninstall` SHALL toglierla.

#### Scenario: Topics spento
- **GIVEN** un repository e `TOPICS_HOME` temporanei, nessun server
- **WHEN** Claude Code chiama l'hook con `name: "Feature/X+Y"`
- **THEN** l'ultima riga dello stdout SHALL essere `{TOPICS_HOME}/worktrees/{slug}/feature-x-y`, il marcatore SHALL dire `creator: claude-code` e `git worktree list` SHALL mostrarlo con il lock `claude-code:<sessione>`

#### Scenario: rimozione
- **GIVEN** quel worktree
- **WHEN** Claude Code chiama `remove`
- **THEN** il tag `archive/wt-feature-x-y` SHALL puntare al suo HEAD e cartella e ramo SHALL essere spariti; sul checkout principale o su un lock `codex:` l'uscita SHALL essere 1 e la cartella SHALL restare

### Requirement: WORKTREE-STD-14 — Una porta per ogni altro strumento: `topics-worktree` e l'hook git `post-checkout`

`scripts/topics-worktree` SHALL usare la stessa libreria dell'hook: `add <percorso del repo|progetto> [nome]` SHALL creare `{radice}/{slug}/{nome}` col marcatore v2 del creatore dato da `TOPICS_WORKTREE_CREATOR` (default `adopted`) e senza lock, `register <percorso>` SHALL registrare un worktree esistente, `list` SHALL elencare i worktree sotto la radice col loro creatore. Un progetto per nome SHALL richiedere il server (`GET /api/worktrees/placement?project=` restituisce anche `repo`), un percorso no. L'hook git opzionale `scripts/git-hooks/post-checkout-register` SHALL registrare il nuovo worktree di un `git worktree add` nudo (HEAD precedente tutto zeri, `.git` file), SHALL ignorare ogni altro checkout e il clone, SHALL saltare i worktree che l'hook di Claude Code crea da sé (`TOPICS_WORKTREE_REGISTER=skip`) e SHALL uscire 0 in ogni caso, anche senza server: non SHALL mai bloccare git.

#### Scenario: un `git worktree add` a mano
- **GIVEN** `core.hooksPath` con `post-checkout-register` e un server Topics
- **WHEN** si fa `git worktree add -b x <cartella>`
- **THEN** il server SHALL ricevere una sola registrazione con quel percorso; senza server git SHALL uscire 0 e la cartella SHALL esserci

### Requirement: WORKTREE-STD-15 — Il GC sposta solo ciò che Topics ha fatto, e mai in modo irreversibile

Una cartella senza riga SHALL essere spostata dal GC solo con una prova che l'ha fatta Topics: il marcatore `{radice}/.topics-owned/{slug}/{nome}` scritto da `create` prima di `git worktree add` (o da una riga di Topics in quella radice). Tutto il resto SHALL essere solo inventario (`foreign`/`ghost` con azione `inventory`), visibile nell'anteprima; anche un checkout con `.git` dentro la radice SHALL essere registrato solo col marcatore (nella radice o nella cartella di amministrazione della worktree), altrimenti resta inventario. Dall'anteprima una persona SHALL poter mettere in quarantena a mano un avanzo senza marcatore (stessi controlli tranne il marcatore) e ripristinare una cartella in quarantena, che torna senza marcatore. Un `{radice}/{slug}` che ha un `.git` o che è il percorso di un progetto noto NON SHALL essere letto come cartella di worktree; una cartella il cui genitore ha un `.git` NON SHALL essere spostata; un `lstat` che fallisce per un motivo diverso da ENOENT SHALL valere «tieni». Un fantasma SHALL andare in `{radice}/.quarantine/{giorno}-{ms}/{slug}/{nome}` (rinomina, contenuto intatto) e SHALL essere cancellato `worktree_quarantine_days` (default 7) dopo il momento dello spostamento, non dalla mezzanotte del giorno; anteprima e `--check` SHALL mostrare cosa c'è in quarantena e da dove viene. La radice SHALL essere decisa dal server: `PUT /api/app-settings` SHALL rifiutare con un codice la home, `/`, un antenato della home, una cartella di sistema o temporanea, una cartella dentro un progetto o che contiene un progetto, e una cartella non vuota senza la sentinella `{radice}/.topics-worktree-root`; il modulo SHALL mostrarne il motivo. Le radici SHALL venire dal cablaggio del server (corrente, predefinita, passate provate dalle righe e dalla sentinella): il GC NON SHALL aggiungerne una sua. `headStatusOfCheckout` SHALL usare lo stato del ramo salvato nella riga solo se l'HEAD è ancora su quel ramo (altrimenti chiede se l'HEAD è su main), e SHALL dire `unmerged` quando git fallisce, va in timeout o non riconosce il repository (registrazione persa), `merged` solo su un HEAD non nato; una worktree con la registrazione persa SHALL essere solo inventario. Rimuovere a mano una worktree con HEAD staccato e commit non su main SHALL essere rifiutato (`unmerged-commits`). Sweep, passata foreign, tetto e spostamento a mano SHALL chiedere la stessa domanda «c'è qualcuno dentro»: cwd vive, processi di Topics, chat a metà turno legata alla riga, sessioni esterne (`externalSessions.activeInside`, che a differenza di `activeAt` vede anche le sessioni da terminale dentro la radice). Un progetto figlio senza impostazioni proprie SHALL ereditare dal padre solo quelle di visualizzazione, mai dispatch, merge o deploy.

#### Scenario: dati dell'utente sotto la radice
- **GIVEN** una radice con `Documents/…`, `Projects/app/src` e un checkout completo a livello di slug, tutti vecchi di 30 giorni
- **WHEN** gira il GC
- **THEN** ogni cartella SHALL restare dov'è e l'anteprima SHALL elencarle come inventario

#### Scenario: il fantasma di Topics
- **GIVEN** una cartella con il marcatore di Topics, senza `.git`, vecchia di 3 giorni
- **WHEN** gira il GC, e di nuovo dopo i giorni di quarantena
- **THEN** SHALL essere spostata in quarantena intatta e poi cancellata

### Requirement: WORKTREE-STD-16 — Ogni porta fra macchine e strumenti lascia la prova di Topics, e niente si cancella senza

Ogni cartella che nasce dentro la radice da una porta che non è il `create` di Topics SHALL ricevere la stessa prova che il GC chiede (WORKTREE-STD-15): la voce `{radice}/.topics-owned/{slug}/{nome}` e la sentinella della radice. L'hook WorktreeCreate di Claude Code e `topics-worktree add` SHALL scriverla prima di `git worktree add` (e toglierla se l'add fallisce senza lasciare la cartella), anche con Topics spento; la ricaduta `<repo>/.claude/worktrees` NON SHALL riceverla. La porta di registrazione SHALL scriverla per un worktree dentro la radice, accanto al marcatore v2, e `unregister` SHALL toglierla con la riga; fuori dalla radice NON SHALL scrivere niente. `topics-worktree register` e l'hook `post-checkout-register` SHALL scrivere voce e marcatore v2 (se manca) per un worktree dentro la radice anche quando il server non risponde, e niente fuori. L'hook WorktreeRemove NON SHALL rimuovere un worktree che non porta né il marcatore `topics-owner` nella cartella di amministrazione né la voce della radice (uscita 1, cartella e file ignorati intatti), e dopo la rimozione SHALL togliere la voce. Sul nodo, la radice mandata dal primario SHALL essere giudicata con le regole del nodo (la sua home, il suo disco, la sua sentinella, i suoi progetti) e il rifiuto SHALL tornare al primario col suo codice; `POST /api/nodes/worktrees/gc` SHALL far girare solo la passata del nodo, senza passarle niente del corpo della richiesta.

#### Scenario: un worktree fatto a mano nella radice
- **GIVEN** un `git worktree add` senza hook dentro `{radice}/{slug}/`, senza lock né marcatore, con un `.env` ignorato
- **WHEN** Claude Code chiama `remove` su quel percorso
- **THEN** l'uscita SHALL essere 1 e la cartella col suo `.env` SHALL restare; un worktree nato dall'hook SHALL invece essere rimosso e la sua voce SHALL sparire

#### Scenario: la radice di un nodo
- **GIVEN** un nodo con la home `/data/home`
- **WHEN** il primario gli manda come radice `/data/home`, `/data`, la sua cartella temporanea o `/data/home/Documents` non vuota senza sentinella
- **THEN** la risposta SHALL essere 400 col codice del rifiuto e le impostazioni del nodo SHALL restare identiche
