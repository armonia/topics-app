## Purpose

The global Kanban coordinator: one persistent Topic, opened from the global
board, that reads every board and makes one explicit task change at a time.
It is an ordinary Topic in every way the server does not explicitly reserve,
and a Codex-only conversation whose privileged role lives in a server-side
registry rather than in anything a person or a model can type.

## Background

THE ROLE IS A ROW, NOT A NAME. The only identity of the coordinator is the
`global_orchestrator_sessions` registry row (migration `20260904110000`).
Titles, prompts, MCP policy, provider and project binding are mutable
presentation or configuration and are never consulted to infer the role. The
client receives a transport-only marker (`isGlobalOrchestrator`) that the
server projects from the registry on every Topic it sends; the client uses it
to remove controls that cannot apply, and the server enforces every invariant
independently of that marker.

WHAT THE COORDINATOR NEVER DOES: archive, bind to a project or worktree,
change provider, receive generic contexts, files, memory, processes, browser
or checkpoints. Codex Voice remains external to this product surface: it is
never simulated, embedded or linked from the coordinator conversation.

This spec was written after the implementation (retroactive, 2026-09-04) to
give the existing tests a requirement to trace to; it needs explicit approval
before the branch lands.

## Requirements

### Requirement: GLOBAL-ORCHESTRATOR-REGISTRY-01 — The registry row is the only identity

The system SHALL identify the global coordinator exclusively through the
`global_orchestrator_sessions` registry row (scope `global`, one `topic_id`),
SHALL project the transport-only `isGlobalOrchestrator` marker on every Topic
it sends from that row alone, and SHALL treat a registered Topic that no
longer satisfies the Codex-only, unbound shape as corrupt rather than as an
ordinary Topic.

#### Scenario: A lookalike Topic is not the coordinator
- **GIVEN** a Topic whose name, system prompt and MCP policy match the coordinator's
- **AND** no registry row points at it
- **WHEN** the server resolves the role by topic id or session key
- **THEN** the Topic is ordinary and carries no `isGlobalOrchestrator` marker

#### Scenario: The registered Topic carries the marker on every projection
- **GIVEN** the registry row points at Topic T
- **WHEN** T is sent in the topics list, in `GET /api/topics/:id`, or in a broadcast frame carrying a `topic`
- **THEN** every projection carries `isGlobalOrchestrator: true`

#### Scenario: A damaged registered row is corrupt, not ordinary
- **GIVEN** the registry row points at Topic T
- **AND** T has been bound to a project or switched to a non-Codex provider
- **WHEN** the server checks eligibility
- **THEN** T is registered but not eligible, and no route treats it as an ordinary Topic

#### Scenario: Deleting the Topic deletes the registry row
- **GIVEN** the registry row points at Topic T
- **WHEN** T's row is deleted from `topics`
- **THEN** the registry row is removed by `ON DELETE CASCADE`

### Requirement: GLOBAL-ORCHESTRATOR-ROUTE-01 — One entry point mints or reuses the coordinator

The system SHALL expose `POST /api/orchestrator-sessions/global/ensure` as the
only way to create the coordinator: it SHALL create at most one unbound,
Codex-only Topic, register it, repair a registered row that was archived or
altered, broadcast the Topic with its marker, and refuse guests.

#### Scenario: First call creates and registers the Topic
- **GIVEN** no registry row exists
- **WHEN** the owner calls the ensure route
- **THEN** one Topic is created with provider `codex`, no project path and no worktree
- **AND** the registry row points at it
- **AND** the response and the broadcast carry `isGlobalOrchestrator: true`

#### Scenario: Second call reuses the same Topic
- **GIVEN** the registry row already points at Topic T
- **WHEN** the ensure route is called again
- **THEN** the response returns T and no second Topic is created

#### Scenario: An archived registered Topic is repaired in place
- **GIVEN** the registry row points at Topic T and T is archived
- **WHEN** the ensure route is called
- **THEN** T is restored, still registered, and returned

#### Scenario: Guests and other methods are refused
- **GIVEN** a guest identity, or a `GET` on the route
- **WHEN** the request reaches the route
- **THEN** the guest receives 403 and the `GET` receives 405

### Requirement: GLOBAL-ORCHESTRATOR-PROVIDER-01 — Codex is the only provider

The system SHALL run the coordinator only through the Codex provider, with a
read-only sandbox, an isolated configuration and a temporary workspace, and
SHALL refuse any other provider at the chat route and at the provider spawn
boundary, before a user message is persisted.

#### Scenario: The chat route refuses a non-Codex resolution
- **GIVEN** the registered Topic
- **WHEN** a chat turn would resolve to a provider other than Codex
- **THEN** the turn is refused with `orchestrator_topic_invariant` and no provider is called

#### Scenario: Claude Code never spawns for the registry row
- **GIVEN** the registered session key, eligible or corrupt
- **WHEN** `ClaudeCodeProvider.sendChat` or its persistent spawn is called directly
- **THEN** the call errors and no process, MCP config or workspace is created

#### Scenario: Codex runs the coordinator restricted
- **GIVEN** the eligible registered session
- **WHEN** the Codex provider spawns it
- **THEN** the arguments carry `--sandbox read-only`, `--ignore-user-config --ignore-rules`, and the topics bridge with profile `global-orchestrator`

### Requirement: GLOBAL-ORCHESTRATOR-ISOLATION-01 — Generic Topic surfaces fail closed

The system SHALL refuse, with 403 and code `orchestrator_topic_invariant`,
every generic per-Topic surface for the registered row: browser, checkpoints,
context preview and snapshots, edit and regenerate, media and context files,
memory, permission and ask-user bridges, processes and script runs, session
environment, terminal agents, goals, project binding (including the `/project`
chat command and auto-naming), and SHALL serve history and context estimates
from local messages only.

#### Scenario: A generic surface refuses the coordinator before side effects
- **GIVEN** the registered Topic
- **WHEN** any of the listed routes is called for its id or session key
- **THEN** the response is 403 with code `orchestrator_topic_invariant`
- **AND** no file, sibling message, provider process or project row is created

#### Scenario: Auto-naming never binds a project
- **GIVEN** the registered Topic and messages that mention a known project path
- **WHEN** the auto-name route runs
- **THEN** the suggested project is null and the Topic keeps its current name and icon

#### Scenario: History and context stay local
- **GIVEN** the registered session key
- **WHEN** history or the context estimate is requested
- **THEN** only local messages are read; no provider, gateway or JSONL fallback runs

#### Scenario: Goals cannot be attached through any route
- **GIVEN** the registered Topic
- **WHEN** a goal is read, declared, looped, stepped, promoted, reopened or closed by topic id, session key or goal id
- **THEN** every response is 403 and no goal row changes

### Requirement: GLOBAL-ORCHESTRATOR-CONTEXT-01 — The board snapshot is volatile context

The system SHALL compose a `global-board` system slot for the eligible
coordinator on every assembly from live SQLite data, mark it volatile so it is
re-sent even with an identical hash, and SHALL NOT give the coordinator the
ordinary project template, workspace note, MCP fleet or goal tool hint.

#### Scenario: The snapshot is present and re-sent
- **GIVEN** the eligible registered session
- **WHEN** the context is assembled twice with the same board
- **THEN** both envelopes carry `synthetic:global-board-snapshot` after the template slot
- **AND** the second is not deduplicated away

#### Scenario: Ordinary context sources are absent
- **GIVEN** the eligible registered session
- **WHEN** the context is assembled
- **THEN** no project template, workspace note, memory, attached file or goal hint block is present

### Requirement: GLOBAL-ORCHESTRATOR-TASKS-01 — Global task tools are the only mutation path

The system SHALL publish exactly the global task tools (`list_global_tasks`,
`get_global_task`, `create_global_task`, `update_global_task`,
`comment_global_task`) to the `global-orchestrator` MCP profile, SHALL resolve
the board of every task server-side from the task row, SHALL run the same
review and delivery gates as the ordinary agent surface, and SHALL refuse the
ordinary session task routes for the registered session.

#### Scenario: The profile publishes only the global tools
- **GIVEN** the `global-orchestrator` profile
- **WHEN** tools are listed or one is called
- **THEN** only the five global task tools are available, and any other tool is refused at call time too

#### Scenario: A delivery with pending checks self-completes
- **GIVEN** a card the coordinator moves to review while its checks are still running
- **WHEN** the run ends green
- **THEN** the server re-issues the same PATCH on the global route and the card lands in review without further polling

#### Scenario: Ordinary session task routes refuse the coordinator
- **GIVEN** the registered session key
- **WHEN** `/api/sessions/:key/tasks` is called
- **THEN** the response is 403

### Requirement: GLOBAL-ORCHESTRATOR-CLIENT-01 — Entry from the global Kanban only

The client SHALL offer the coordinator only from the global Kanban board
(`board-open-orchestrator`), SHALL open it by calling the ensure route and then
dispatching the ordinary `topics:open-topic` flow with the returned Topic, and
SHALL NOT render a second chat surface for it.

#### Scenario: The button exists only on the global board
- **GIVEN** a project-scoped board
- **WHEN** the toolbar renders
- **THEN** no open-orchestrator control is shown

#### Scenario: Opening reuses the ordinary Topic panel
- **GIVEN** the global board
- **WHEN** the user clicks open-orchestrator
- **THEN** the ensure route is called once and the returned Topic opens as a permanent chat pane

### Requirement: GLOBAL-ORCHESTRATOR-LIFECYCLE-01 — The coordinator never archives

The system SHALL keep the coordinator out of every archive path: closing its
pane, the sidebar row action, the context menu, bulk archive, retirement
reconcile and `archiveTopic` itself SHALL leave it unarchived, and a stale
retirement SHALL be retracted rather than applied.

#### Scenario: Closing the pane does not archive
- **GIVEN** the coordinator open in a chat pane
- **WHEN** the pane is closed and later reopened
- **THEN** the Topic was never archived and reopens with its history

#### Scenario: Bulk archive skips it
- **GIVEN** a bulk archive that includes the coordinator's id
- **WHEN** the request runs
- **THEN** every other Topic is archived and the coordinator is skipped

#### Scenario: Retirement reconcile retracts instead of archiving
- **GIVEN** a retirement record for the coordinator left by an older client
- **WHEN** reconcile runs
- **THEN** the record is cleared and the Topic stays unarchived
