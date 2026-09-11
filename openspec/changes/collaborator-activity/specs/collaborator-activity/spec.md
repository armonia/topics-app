## ADDED Requirements

### Requirement: COLLAB-01 — A task's activity separates assignee, author, executor and machine

The board SHALL derive, per task, four distinct fields instead of one
conflated label: the **assignee** (`tasks.assigned_to`, unchanged), the
**author** of the latest action (resolved from `task_comments.actor_person_id`
when the writing row has one, else the existing `shared/comment-author.ts`
label), the **executor** (the agent/session currently or last assigned to the
task), and the **machine** (`tasks.machine_id` joined to `machines`, or "this
machine" when NULL). None of the four SHALL be presented as if it were
another.

#### Scenario: A comment written by an authenticated collaborator carries their identity
- **GIVEN** a guest device with a `comment`-or-higher grant on a task, resolving to a known person
- **WHEN** that guest posts a comment on the task
- **THEN** the stored row SHALL carry that person's id in `actor_person_id`
- **AND** the task's activity SHALL show that person as the author, not the generic agent label

#### Scenario: An MCP/API write leaves the actor unresolved, and says so
- **GIVEN** a comment written through the MCP or API surface, with no device identity
- **WHEN** the task's activity is read
- **THEN** `author` SHALL fall back to the existing `shared/comment-author.ts` label
- **AND** it SHALL NOT be attributed to any specific person

#### Scenario: A single-machine install shows a machine, not a blank
- **GIVEN** a task whose `machine_id` is NULL (no remote-node dispatch ever used)
- **WHEN** the task's activity is read
- **THEN** `machine` SHALL read as the local machine, not as an empty or missing value

### Requirement: COLLAB-02 — Person and machine filters combine on the board

`FILTER_GROUP_ORDER` SHALL include `person` and `machine` groups, built from
the tasks already visible to the caller. Combining a `person` and a `machine`
token SHALL narrow to tasks matching both, with a stable count.

#### Scenario: Combined filter narrows correctly
- **GIVEN** a board with tasks from two different authors on two different machines
- **WHEN** the user picks one person token and one machine token
- **THEN** only tasks matching both SHALL remain
- **AND** the shown count SHALL equal the number of matching rows

#### Scenario: An empty combination is actionable, not a dead end
- **GIVEN** a person+machine combination that matches no task
- **WHEN** the filter is applied
- **THEN** the board SHALL show an empty state offering to clear the filter
- **AND** clearing it SHALL restore the full, unfiltered board

### Requirement: COLLAB-03 — A guest never receives activity for what it cannot see

Activity fields SHALL ride the same task object already filtered by existing
grant checks (`GUEST-04`). A task a guest holds no grant on SHALL NOT surface
its assignee, author, executor or machine to that guest, over REST or over the
socket, and a revoked grant SHALL remove that task's activity from both within
one update cycle — no polling required.

#### Scenario: Revocation removes activity from the guest's socket
- **GIVEN** a guest with a live socket and a `comment` grant on a task, currently visible with its activity
- **WHEN** the owner revokes that grant
- **THEN** the guest's socket SHALL stop receiving frames about that task
- **AND** a subsequent REST read by that guest SHALL NOT include the task or its activity

#### Scenario: The owner still sees full activity on the same task
- **GIVEN** the same revocation
- **WHEN** the owner reads the task
- **THEN** the owner SHALL see the task's activity unchanged
