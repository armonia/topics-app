# Lifecycle Hooks

User-declared shell commands that run on named Topics events, from a single
user-level file. The point is the one thing a rule engine inside the app can
never be: a place to put YOUR rule between the agent and the repository without
modifying Topics.

## Why a file and not a setting

The competitors that have this ship it as a file (Claude Code, Cursor, and the
`hooks.json` of Codex), and a file is what makes it scriptable, diffable and
possible to write while the app is running. There is no UI, no database column
and no settings entry: the configuration is one JSON file, and the reason a
refusal gives travels on channels the chat already draws.

The file is USER level only. A per-project `hooks.json` read from a checkout
would mean that cloning a repository is enough to run commands on the host, and
the trust prompt that would make that safe does not exist here. The payload
carries `cwd`, so a script that wants to behave differently per project decides
by itself.

## What it is NOT

The hook does not replace the permission verdict (RT-07): it runs AFTER
`decide()` has said yes, so it can only take away, never grant. It covers the
native runtime alone; the CLI providers (claude-code, codex, acp) carry their
own hook systems and are left to them. It is unrelated to the INCOMING hooks of
`server/routes/claude-hooks.ts` (CCS-02), from which it borrows only the field
names of the payload.

### Requirement: HOOKS-01 — Closed vocabulary, tolerant configuration, boot never blocked

The system SHALL read hook declarations from a single user-level file
`hooks.json` under the Topics home directory, and SHALL recognise exactly FOUR
event names: `pre-tool`, `turn-end`, `task-deliver`, `worktree-create`. An
entry naming any other event SHALL be discarded with a named warning, and the
vocabulary SHALL be closed the way the control-tool vocabulary is closed
(CTRLTOOL-01): unknown means dropped, never guessed.

Each entry SHALL declare a shell command (`cmd`), MAY declare an optional
`timeoutMs`, and for `pre-tool` MAY declare an optional `tool` filter that
restricts the hook to one tool name. The command SHALL receive the event
payload as JSON on stdin, with the field names of the incoming hook payload
(CCS-02): `hook_event_name`, `session_id`, `cwd`, and per event `tool_name`,
`tool_input`.

A file that is absent, unreadable, not valid JSON, or not shaped as expected
SHALL mean NO HOOKS, never a failed boot: the system SHALL log one warning and
carry on. The file SHALL be re-read at every event, so that editing it takes
effect without restarting the server.

#### Scenario: A malformed file means no hooks and one warning
- **GIVEN** the user's `hooks.json` contains text that is not valid JSON
- **WHEN** the system loads the configuration
- **THEN** the parse SHALL yield zero hooks and exactly one warning
- **AND** the server SHALL start and every event SHALL proceed as if no hook existed

#### Scenario: An unknown event name is dropped and named
- **GIVEN** a configuration declaring an entry on `post-tool`
- **WHEN** the configuration is parsed
- **THEN** that entry SHALL be discarded
- **AND** a warning SHALL name the rejected event so the author can see the typo
- **AND** the entries on the four known events in the same file SHALL still load

#### Scenario: The tool filter narrows a pre-tool hook
- **GIVEN** a `pre-tool` hook declared with `tool: "bash"`
- **WHEN** the runtime is about to run a tool whose name is not `bash`
- **THEN** the hook SHALL NOT be executed

### Requirement: HOOKS-02 — A non-zero exit blocks the action, and its stderr is the reason

A hook that exits non-zero SHALL block the action it was attached to, and the
text the command wrote on stderr SHALL be the reason the human and the agent
read. Each event SHALL carry that reason on the channel its surface already
has:

- `pre-tool` SHALL block the tool call in the native runtime and SHALL return
  the reason as a tool result marked as an error, exactly as a denied
  permission does. The tool SHALL NOT run.
- `worktree-create` SHALL refuse the creation BEFORE any row is persisted, so
  that a refusal leaves no pending worktree behind (WORKTREE-01).
- `task-deliver` SHALL refuse the move to `review` with HTTP 409 and a code of
  its own, as the twin of the existing delivery refusals (KANBAN-05).
- `turn-end` SHALL NEVER block: the turn is already over. Its reason SHALL be
  appended to the conversation as an assistant line so it is read in chat.

A hook that exits zero SHALL be silent and SHALL change nothing.

#### Scenario: A hook refuses bash and the message is read in chat
- **GIVEN** a `pre-tool` hook on `bash` that writes a message on stderr and exits 1
- **WHEN** the native runtime is about to execute a `bash` tool call
- **THEN** the command SHALL NOT be executed
- **AND** the tool result SHALL carry the hook's stderr and SHALL be marked as an error

#### Scenario: A refused worktree leaves no row
- **GIVEN** a `worktree-create` hook that exits non-zero
- **WHEN** a worktree creation is requested
- **THEN** the creation SHALL be refused with the hook's reason
- **AND** no worktree row SHALL have been persisted, not even in `pending`

#### Scenario: A refused delivery answers 409
- **GIVEN** a `task-deliver` hook that exits non-zero
- **WHEN** an agent moves its task to `review`
- **THEN** the request SHALL be refused with HTTP 409 and a distinct code
- **AND** the response SHALL carry the hook's reason so the agent can act on it

### Requirement: HOOKS-03 — Every hook has a ceiling, and the ceiling is not a veto

Every hook SHALL run under a time limit: `timeoutMs` when declared, a default
of 10 seconds otherwise, and never more than 60 seconds. When the limit
elapses the system SHALL kill the whole process tree of the hook, not the shell
alone.

The answer SHALL be produced by the timer itself, after a grace period, EVEN IF
no exit event ever arrives: killing is a request, not a guarantee, and a runner
that waits for the death it asked for hands a turn to any command that ignores
the signal.

A hook stopped by its ceiling SHALL NOT count as a refusal: the action
proceeds, and the system SHALL log one warning. A veto is something a command
said, and a command that ran out of time said nothing.

#### Scenario: A slow hook does not hold the turn past its ceiling
- **GIVEN** a hook whose command sleeps far longer than its `timeoutMs`
- **WHEN** the event fires
- **THEN** the runner SHALL answer within a small multiple of `timeoutMs`, not of the sleep
- **AND** the answer SHALL be "not blocked"

#### Scenario: A hook that cannot be started is not a refusal
- **GIVEN** a hook whose command cannot be spawned at all
- **WHEN** the event fires
- **THEN** the action SHALL proceed
- **AND** the failure SHALL be logged, never turned into a block
