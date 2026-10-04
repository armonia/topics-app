# Agents — sub-agents run on the Topics engine

`spawn_agent` stops being "always a Claude CLI". By default the child is a chat
of its own on the Topics engine; the CLI stays one call away.

## MODIFIED Requirements

### Requirement: SUBAGENT-08 — The caller chooses the sub-agent's model, and the answer names the model it got

`spawn_agent` SHALL accept `model` ∈ {`inherit`, `sonnet`, `opus`, `fable`,
`haiku`}. The route SHALL resolve one model in this order: the call's `model`,
then the `model:` of the chosen profile (SUBAGENT-09), then `inherit`.

`inherit` SHALL resolve to the parent's model: for a `topic:` parent,
`topics.model` as stored, `[1m]` suffix included; for a Claude PTY parent, the
`message.model` of the last assistant record in its transcript. A parent whose
model is not a Claude model, or unknown, SHALL yield no model, and the spawn
answer SHALL say why.

The child SHALL run that model on its runtime (SUBAGENT-18): on the engine, an
alias SHALL become the engine's id of the newest model of that family
(`sonnet` → `claude-sonnet-5-5`, `opus[1m]` → `claude-opus-5-5[1m]`), stored as
the child chat's `topics.model`; on the CLI, it SHALL be passed as `--model`.
No model leaves the engine's or the CLI's default.

The spawn answer SHALL carry the model the child was given and how it was
resolved. The result of every turn (SUBAGENT-11) SHALL carry the model the
child ACTUALLY ran: the CLI's first assistant record, the engine's last
assistant row.

The tool description SHALL tell the model not to choose `haiku` on its own
initiative, only when the human asks for it.

Dove cambiarla: scelta 2 del blocco «Da decidere» di `subagent-nativi` (il
runtime di default); la catena del modello resta la scelta 1 di
`subagent-tool-standard`.

#### Scenario: a sonnet chat opens a sonnet child on the engine
- **GIVEN** a topic whose model is `claude-sonnet-5-5[1m]`
- **WHEN** `spawn_agent` is called without `model`, `agent_type` or `runtime`
- **THEN** the child chat's model SHALL be `claude-sonnet-5-5[1m]`
- **AND** the answer SHALL carry `runtime: "topics"` and `modelSource: "parent"`

#### Scenario: the requested model reaches the CLI
- **GIVEN** a chat parent and a fake PTY bridge recording create frames
- **WHEN** `spawn_agent` is called with `{prompt, model: "sonnet", runtime: "claude-code"}`
- **THEN** the create frame's args SHALL contain `--model sonnet`

#### Scenario: an unknown model is refused before anything starts
- **WHEN** `spawn_agent` is called with `model: "gpt-5"`
- **THEN** the route SHALL answer 400, naming the accepted values
- **AND** no chat and no create frame SHALL exist for it

### Requirement: SUBAGENT-15 — Limits are counted from persisted rows, with a machine-wide cap

Spawning SHALL be refused (429) past any of these limits:

- depth 2: a child may spawn, a grandchild may not (choice 3 of
  `subagent-nativi`);
- 5 live children per parent;
- 6 live sub-agents across the machine.

All three SHALL be counted from the persisted sub-agent rows joined with the
live PTYs, so a restart does not reset them. The depth walk SHALL cross native
children through the session key of their chat. A retired child counts toward
none of them; a native child holds a slot only while its turn runs.

A child at the depth cap on the engine SHALL NOT be offered the five
sub-agent tools (`spawn_agent`, `send_to_agent`, `read_agent`, `list_agents`,
`stop_agent`), and SHALL be refused them at execution too.

The machine-wide refusal SHALL name the parent and the name of each child
holding a slot. The board refusals (`boardSpawnRefusal`) SHALL keep running
first and unchanged.

Dove cambiarla: scelta 3 di `subagent-nativi` (profondità 2 contro 1); scelta 4
di `subagent-tool-standard` (il tetto globale).

#### Scenario: a grandchild cannot delegate
- **GIVEN** a chat, its native child, and that child's native child
- **WHEN** the grandchild calls `spawn_agent`
- **THEN** the route SHALL answer 429 with `depth limit (2)`
- **AND** the grandchild's turn SHALL NOT declare `spawn_agent`, while the child's does

#### Scenario: native children working hold slots
- **GIVEN** a parent with 5 native children in the middle of their turns
- **WHEN** it calls `spawn_agent` again
- **THEN** the route SHALL answer 429

## ADDED Requirements

### Requirement: SUBAGENT-18 — A sub-agent runs on the Topics engine as a chat of its own, unless the call asks for the CLI

`spawn_agent` SHALL accept `runtime` ∈ {`topics`, `claude-code`}; any other
value SHALL be refused with 400.

Without `runtime`, or with `topics`, the child SHALL be a chat of its own: a
topic pinned to the engine (`provider: "topics"`), named as the parent chose,
in the parent's project and worktree (SUBAGENT-17), with the parent's autonomy.
Its prompt SHALL be the chat's first message, sent through the chat route of
the server itself; no process and no PTY SHALL be started for it. Its row in
`subagents` SHALL carry `runtime = 'topics'` and the chat's session key.

The engine SHALL be skipped, and the child started as a CLI, when the engine
is not connected, or when the child would have no project Topics knows (a
`cwd` that is not a known project, a terminal parent outside one). The answer
SHALL then carry `runtime: "claude-code"` and the reason; a call that asked for
`runtime: "topics"` SHALL instead be refused (503 or 400) with that reason.

With `runtime: "claude-code"` the child SHALL be the interactive CLI of
SUBAGENT-01..17, unchanged.

A profile (SUBAGENT-09) SHALL give the child chat its instructions as system
prompt, its model and effort, and its `tools:` line translated into the
engine's tool names (`Read` → `read_file`, `mcp__topics__x` → `x`, `Agent`/
`Task` → the sub-agent tools); a tool the engine does not have SHALL be
dropped. A profile without `tools:` SHALL restrict nothing.

Dove cambiarla: scelta 1 (chat a sé, non turno annidato) e scelta 2 (default
nativo per tutti) di `subagent-nativi`.

#### Scenario: no runtime asked, no CLI started
- **GIVEN** a chat in a project
- **WHEN** it calls `spawn_agent` with only a prompt
- **THEN** a topic pinned to the engine SHALL exist with that project
- **AND** the chat route SHALL have received the prompt on its session key
- **AND** no create frame SHALL reach the PTY bridge

#### Scenario: the CLI on request
- **WHEN** `spawn_agent` is called with `runtime: "claude-code"`
- **THEN** a create frame SHALL reach the PTY bridge, and the row SHALL say `claude-code`

#### Scenario: a profile's tools, in the engine's names
- **GIVEN** a profile with `tools: Read, Grep, Glob, mcp__topics__list_agents`
- **WHEN** a child is spawned from it
- **THEN** the child chat SHALL be offered `read_file`, `grep`, `glob`, `list_agents` and no `bash`

### Requirement: SUBAGENT-19 — A native child's turn ends in a result read from its chat, and stops like a chat

The end of every turn of a native child SHALL produce one result (SUBAGENT-11)
read from its chat: the last assistant row written since the turn began, and
the turn's end in the turn-end registry. `end_turn` SHALL be `completed`;
`cancelled` SHALL be `stopped`; any other end, or a chat route that refused the
turn, SHALL be `failed` with the reason. The result SHALL go to the parent the
way a CLI child's does (SUBAGENT-12, 13). At the end of its turn the row SHALL
become `retired`: no process is left to park.

`send_to_agent` SHALL be the child chat's next turn, within the 24-hour window
of SUBAGENT-14 and through the same limits; on a child whose turn is running
it SHALL answer 409. `read_agent` SHALL read the child's chat, with a row
index as offset.

`stop_agent` SHALL cancel the running turn through the chat's own Stop; the
result SHALL be `stopped` by the parent, which wakes nobody, and the child's
chat SHALL be archived. A person's Stop on the parent chat SHALL also stop the
native children whose turn is running, without archiving their chats.

While a native child's turn runs, the parent's goal loop SHALL read it as
background work, and SHALL NOT send «Objective still open».

After a restart, a native child still `running` SHALL be watched for a minute:
a turn resumed with its chat SHALL be awaited and reported; one that does not
come back SHALL be reported `lost` with what it had written.

#### Scenario: one turn, one result, slot freed
- **GIVEN** a native child whose chat answers and ends with `end_turn`
- **THEN** the parent SHALL receive one result `completed` with the chat's last answer, turn 1
- **AND** the row SHALL be `retired`

#### Scenario: stopped by the parent mid-turn
- **GIVEN** a native child in the middle of its turn
- **WHEN** the parent calls `stop_agent`
- **THEN** the result SHALL be `stopped`, `stoppedByParent`, with the half answer as partial text
- **AND** the row SHALL be `stopped` and the child chat archived

#### Scenario: a person's Stop reaches the children
- **GIVEN** a native child in the middle of its turn
- **WHEN** a person presses Stop on the parent chat
- **THEN** the child's turn SHALL end `stopped`, and its chat SHALL stay unarchived
