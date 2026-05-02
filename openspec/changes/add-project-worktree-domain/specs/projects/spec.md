## ADDED Requirements

### Requirement: PROJECT-01 — Project Entity Lifecycle

The system SHALL persist a first-class `Project` entity representing a registered codebase or working directory, supporting create, read, update (rename + metadata), archive, restore, and delete operations. Projects are user-global and not space-scoped in this phase.

#### Scenario: Create a project from a directory path
- **GIVEN** the user opens the Project creation flow
- **WHEN** the user provides a name and an absolute filesystem path
- **THEN** the system SHALL persist a new row in the `projects` table with a generated UUID id, a slug derived from the name, and the provided path
- **AND** SHALL broadcast `project:new` over the WebSocket channel to all connected clients
- **AND** the new project SHALL appear in the project list returned by `GET /api/projects`

#### Scenario: Project slug is unique
- **GIVEN** a project named "Topics App" already exists with slug `topics-app`
- **WHEN** another project named "Topics App" is created
- **THEN** the system SHALL reject the request with HTTP 409 and an error payload describing the slug collision
- **AND** the user SHALL be offered an editable slug field to disambiguate

#### Scenario: Project path validation
- **GIVEN** the user is creating a project
- **WHEN** the provided path does not exist on the filesystem at create time
- **THEN** the system SHALL reject the request with HTTP 400 and a clear error message naming the missing path
- **AND** no row SHALL be persisted

#### Scenario: Lookup project by path
- **GIVEN** a project exists at path `/Users/x/code/foo`
- **WHEN** a client calls `GET /api/projects?path=/Users/x/code/foo`
- **THEN** the system SHALL return the matching project record
- **AND** if no match exists, SHALL return HTTP 200 with body `null` (not 404)

#### Scenario: Update project metadata
- **GIVEN** a project exists
- **WHEN** the user issues `PATCH /api/projects/:id` with a new name, color, or icon
- **THEN** the system SHALL persist the update with a new `updated_at` timestamp
- **AND** SHALL broadcast `project:updated` to all clients
- **AND** changing the name SHALL NOT change the slug (slug is immutable)

#### Scenario: Archive project hides it from active list
- **GIVEN** a project is active
- **WHEN** the user archives the project via `POST /api/projects/:id/archive`
- **THEN** the project SHALL be marked `archived=1` in the database
- **AND** SHALL no longer appear in `GET /api/projects` (which defaults to non-archived)
- **AND** SHALL appear in `GET /api/projects?archived=true`
- **AND** SHALL broadcast `project:archived` to all clients

#### Scenario: Restore archived project
- **GIVEN** a project is archived
- **WHEN** the user issues `POST /api/projects/:id/restore`
- **THEN** the project's `archived` flag SHALL flip back to 0
- **AND** SHALL reappear in the default `GET /api/projects` list
- **AND** SHALL broadcast `project:updated`

#### Scenario: Delete project with confirmation
- **GIVEN** a project has zero worktrees and zero topics referring to its path
- **WHEN** the user issues `DELETE /api/projects/:id`
- **THEN** the system SHALL remove the row and SHALL broadcast `project:deleted`

#### Scenario: Delete project blocked when worktrees exist
- **GIVEN** a project has at least one worktree
- **WHEN** the user issues `DELETE /api/projects/:id`
- **THEN** the system SHALL respond HTTP 409 with body listing the dependent worktrees
- **AND** the project SHALL remain unchanged
- **AND** the user SHALL be guided to delete worktrees first

### Requirement: PROJECT-02 — Backward Compatibility With `project_path` Strings

The system SHALL allow existing topics, tasks, and boards that reference a project via the legacy `project_path` / `project_id` string columns to continue functioning without any forced migration to the new `projects` table. Auto-creation of project records is optional and never destructive.

#### Scenario: Legacy topic without a project record
- **GIVEN** a topic exists with `project_path = '/Users/x/code/foo'` and no `projects` row matches that path
- **WHEN** the user opens that topic
- **THEN** all chat, tool, file, and git operations SHALL behave exactly as before this change
- **AND** the topic settings panel SHALL NOT show a Project or Worktree section

#### Scenario: Legacy topic gains a project on user action
- **GIVEN** a topic with `project_path = '/Users/x/code/foo'` and no matching `projects` row
- **WHEN** the user explicitly creates a Project at that path via the new UI
- **THEN** the new `projects` row SHALL be created
- **AND** the existing topic's `project_path` SHALL remain set unchanged
- **AND** subsequent topics opened against that path MAY display the new Project in the topic settings

#### Scenario: Tasks `project_id` string is unaffected
- **GIVEN** the `tasks` table holds rows with `project_id` as a string (often a project path)
- **WHEN** any project is created, modified, or deleted
- **THEN** the `tasks.project_id` column SHALL remain a string with no FK constraint to `projects.id`
- **AND** all existing board APIs SHALL continue to work exactly as today

### Requirement: PROJECT-03 — WebSocket Broadcast Hygiene

All project-mutating endpoints SHALL emit a typed WebSocket broadcast immediately after a successful database commit, using the existing `broadcastToAll` helper, and the broadcast envelope SHALL contain the project's full row plus a `payload_version: 1` field for forward compatibility.

#### Scenario: Broadcast follows the database commit
- **WHEN** any project mutation succeeds
- **THEN** the WebSocket broadcast SHALL be sent within 50 ms of the commit
- **AND** the broadcast envelope SHALL be `{ type: 'project:<verb>', project: <row>, payload_version: 1 }`
- **AND** clients receiving the broadcast SHALL be able to update their cache without a follow-up REST call

#### Scenario: Broadcast does not fire on validation failure
- **GIVEN** a project mutation request is rejected by validation
- **WHEN** the request is processed
- **THEN** no `project:*` broadcast SHALL be emitted
- **AND** no row SHALL be persisted
