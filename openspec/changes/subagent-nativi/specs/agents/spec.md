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

### Requirement: SUBAGENT-14 — A finished sub-agent can be continued, even after its process is gone

A child that reported its turn and stayed idle SHALL be retired after 15
minutes (choice 5): its PTY closed gracefully, and its row kept as `retired`
with `claude_session_id`, model, profile, effort, cwd and branch. The
retirement passes the same gates as the idle park: a child whose pane a window
is showing, or that holds a pending question, is not retired until those clear.

`send_to_agent` on a `retired`, `stopped` or `lost` child SHALL bring it back
with the same `agentId` and then deliver the input — on the engine when the
engine can take it, on the CLI otherwise. A CLI-born child whose engine is
connected and whose directory is a project Topics knows SHALL come back as a
native child (SUBAGENT-18): a new chat whose first turn carries its handover
(the starting task, its last report, the CLI transcript when one exists) and
the new message, and whose row is rewritten `runtime = 'topics'`. Only when
the engine cannot take it SHALL the child be recreated with
`--resume <claude_session_id>`, the same flags and the same cwd. The same
SHALL hold after a server or bridge restart, because the row, not memory,
holds what the resume needs.

More than 24 h after it ended, a child SHALL leave `list_agents`, and a resume
SHALL answer 410 naming why. This also sweeps the dormant child rows that no
sweep reaches today.

Dove cambiarla: scelta 5. With «no» no idle child is retired, and only the
resume half of this requirement stands.

#### Scenario: an idle finished child is retired and resumed
- **GIVEN** a child idle 15 minutes after reporting its turn
- **THEN** its PTY SHALL be closed, and its row SHALL read `retired`
- **WHEN** the parent calls `send_to_agent` with that `agentId`
- **THEN** the child SHALL come back with the same `agentId`, and the input SHALL be delivered to it

#### Scenario: resumption survives a restart
- **GIVEN** a stopped child and a server restart
- **WHEN** the parent calls `send_to_agent` on it
- **THEN** the child SHALL be recreated from its persisted row, not refused with 404

#### Scenario: a CLI child written to after its stop comes back on the engine
- **GIVEN** a `claude-code` child, stopped, whose engine is connected
- **WHEN** the parent calls `send_to_agent` with its `agentId`
- **THEN** no create frame SHALL reach the PTY bridge
- **AND** the row SHALL read `runtime = 'topics'` with the same `agentId`
- **AND** the engine's first turn SHALL carry its starting task, its last report and the new message

#### Scenario: without an engine the resume is still --resume
- **GIVEN** a `claude-code` child, stopped, whose engine is not connected
- **WHEN** the parent calls `send_to_agent` with its `agentId`
- **THEN** a create frame SHALL carry `--resume <its claude_session_id>` with its model and profile flags

#### Scenario: a native Agent id gets a useful refusal
- **WHEN** `read_agent` or `send_to_agent` is called with an id shaped like a CLI `Agent` task id (`a` followed by 16 hex)
- **THEN** the 404 SHALL say that the id belongs to the CLI's own `Agent` tool, not to `spawn_agent`

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

The child chat SHALL NOT be listed as a chat of its own, and SHALL NOT open a
tab by itself. The server SHALL project `subagentOf` (the parent's session key,
from `subagents`) on the child's topic, and the sidebar SHALL nest the child
under its parent's row, chat or terminal, the way a CLI child's terminal is
nested; a grandchild SHALL nest under the child. A nested child SHALL keep its
parent row listed only while it is open or lit; once archived (`stop_agent`) it
SHALL leave the nest unless archived rows are shown. A child whose parent is
not loaded SHALL fall back to a normal chat row. Opening a child from the
result card or the strip SHALL open its chat, never a terminal tab. Changed on
04/10 at Attilio's request: «non dovrei vedere i sub-agent come tab, cioè, se
proprio potrebbero uscire come sotto tab nella sidebar» (before: a flat chat in
the project's sidebar).

A child born on the CLI and written to again with `send_to_agent` after it
ended SHALL come back on the engine with the same id: its row SHALL be updated,
never replaced, so its reported turns and pending results stay and the next
turn is numbered after them; it SHALL carry its profile's instructions and
tools, and its task, last report and transcript path as context. The reason a
child was born on its runtime SHALL be recorded (`asked`, `fallback`,
`default`); a child whose call asked for `runtime: "claude-code"` SHALL resume
on the CLI. A row older than that record SHALL migrate. Added on 04/10 at
Attilio's request: «pulisci, migri».

Dove cambiarla: scelta 1 (chat a sé, non turno annidato) e scelta 2 (default
nativo per tutti) di `subagent-nativi`; dove si vede, questo requisito.

#### Scenario: no runtime asked, no CLI started
- **GIVEN** a chat in a project
- **WHEN** it calls `spawn_agent` with only a prompt
- **THEN** a topic pinned to the engine SHALL exist with that project
- **AND** the chat route SHALL have received the prompt on its session key
- **AND** no create frame SHALL reach the PTY bridge

#### Scenario: the child nests under its parent in the sidebar
- **GIVEN** a chat `topic:orch` that spawned a native child, which spawned a grandchild
- **WHEN** the sidebar is built with the parent's tab open
- **THEN** the project SHALL list only the parent's row
- **AND** the child SHALL be nested under it, and the grandchild under the child
- **AND** no tab SHALL have been opened for either

#### Scenario: the CLI on request
- **WHEN** `spawn_agent` is called with `runtime: "claude-code"`
- **THEN** a create frame SHALL reach the PTY bridge, and the row SHALL say `claude-code`

#### Scenario: a profile's tools, in the engine's names
- **GIVEN** a profile with `tools: Read, Grep, Glob, mcp__topics__list_agents`
- **WHEN** a child is spawned from it
- **THEN** the child chat SHALL be offered `read_file`, `grep`, `glob`, `list_agents` and no `bash`

#### Scenario: a CLI child resumed moves to the engine and keeps counting
- **GIVEN** a CLI child with no recorded reason whose turn 1 was reported, then stopped
- **WHEN** its parent calls `send_to_agent` twice
- **THEN** the row SHALL say `topics`, and the parent SHALL receive turns 2 and 3, both `completed`
- **AND** a child spawned with `runtime: "claude-code"` SHALL instead resume as a CLI

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
chat SHALL be archived. A person's Stop on the parent chat SHALL also stop
its live children, without archiving their chats. Both stops SHALL reach the
whole live tree: children waiting on their own children, and those children,
native or CLI. No result produced after the Stop SHALL wake the parent, and a
stopped child's chat SHALL report nothing until `send_to_agent` resumes it.

A child whose turn ends while work it started will still wake it (a child not
seen finished, a result not yet delivered, a command or background task of
its chat) SHALL stay `running` and in view. Every turn of its chat that the
server did not send (the wake) SHALL be reported once, as the next turn, with
its own last words. When that work is over without a wake turn (a grandchild
retired or lost, a wake the route refused), the child SHALL be closed, not
left running. Resuming an archived child SHALL undo the archive whole (flag,
`ui_state` markers, retirement fact), through the unarchive's own door.

While a native child's turn runs, the parent's goal loop SHALL read it as
background work, and SHALL NOT send «Objective still open».

After a restart, a native child still `running` SHALL be watched for a minute:
a turn resumed with its chat SHALL be awaited and reported; one that does not
come back SHALL be reported `lost` with what it had written. A child that had
reported and was only waiting on its own work lost no turn: it SHALL NOT be
reported `lost`.

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

### Requirement: SUBAGENT-20 — Stopping work another session started asks first

Owner, 04/10: «poi in realtà non dovrei poterle chiudere allegramente come
processi, in caso siano avviati da altre sessioni dovrebbe chiedere conferma».

When a person, from the interface, does something that STOPS a sub-agent
another session started (a terminal with `parentSessionKey`, a chat with
`subagentOf`) while it is still working, the client SHALL ask first with the
app's own dialog (`useConfirm`, never `window.confirm`). The dialog SHALL name
the sub-agent and the session that started it, and SHALL say that its work
stops and the parent gets the result «stopped».

Working means: for a CLI child, phase `working` or `waiting-prompt`, or with no
phase yet a busy PTY; for a native child, a streaming turn.

It asks on: closing the sub-agent's terminal tab (project tab bar and top-level
grid, deferred or «close now»), closing its terminal from the sidebar (row or
menu), and the sidebar Stop on a native child's chat.

It SHALL NOT ask when nothing stops: a session the person started, a child that
already finished its turn (even with its PTY alive), archiving a chat row (the
server does not abort a turn on archive), closing a chat tab (a chat tab is a
view, the turn goes on), and the «Sotto-agenti» strip's × (it only dismisses an
ended row) or the result card (it only opens the child).

#### Scenario: closing a working CLI child's tab
- **GIVEN** a terminal tab of a sub-agent spawned by `topic:pop`, phase `working`
- **WHEN** the person closes the tab
- **THEN** a dialog names the child and «Remake Prince of Persia» before anything is retired
- **AND** cancelling leaves the tab open and the PTY alive

#### Scenario: a finished child or the person's own terminal
- **GIVEN** a sub-agent in phase `finished`, or a terminal with no `parentSessionKey`
- **WHEN** the person closes its tab
- **THEN** it closes as before, with no question

### Requirement: SUBAGENT-21 — Sub-agents stay folded and quiet until the person opens them

Owner, 05/10: «sta succedendo un casino, vedo notifiche sulle tab dei sotto
agenti ma praticamente dovrebbe esserci una accordion sulla tab principale da
essere chiusa di default e diciamo non essere "attiva" fino a che non
interagisci?».

Under the parent's sidebar row the sub-agents (native `subagentOf` and CLI
`parentSessionKey`) SHALL sit in an accordion CLOSED by default: a header with
the count and a dot while one of them works. It SHALL open on a click and stay
as the person left it (remembered per parent on this device), and SHALL open by
itself only while one of its children is the row in front.

A sub-agent the person has not opened SHALL NOT light: its finished turn (done
or error) makes no badge, no history row, no push, no lit sort. The attention
store decides it at the source (`quiet` input of `composeAttention`, the
`subagents` table as the one source of who is a sub-agent): its result already
reaches the parent (wake and card), and the parent is what notifies. Its work
SHALL still show as `working`, and a wait it opens (a question, a permission)
SHALL still need the person, since nobody else can answer it. Once the person
opens it (its seen door) or keeps it in front of an awake window for the
seen's dwell (`SEEN_DWELL_MS`), it lights like any chat; a window's first focus
after loading, the layout it restored, does not count. That engagement SHALL be written on the child's row
(`engaged_at`): after a restart the child is still the person's. A closed
accordion SHALL show an amber dot while one of its children waits on the
person.

#### Scenario: a child finishes while the person looks elsewhere
- **GIVEN** a chat with three sub-agents, the accordion closed
- **WHEN** one of them ends its turn
- **THEN** the child row has no badge and nothing is pushed
- **AND** the parent chat receives the result and is the one that lights

#### Scenario: the person opens a child
- **GIVEN** the accordion opened and a child clicked
- **WHEN** that child ends its next turn
- **THEN** it lights like any chat

### Requirement: SUBAGENT-22 — Un figlio finito esce dalla vista da solo

Attilio, 05/10: «pulisci anche quelli che non servono più, dovrebbero chiudersi». Un figlio nativo
il cui turno finisce da solo (esito `completed`, già consegnato al padre) SHALL archiviare la sua
chat, e con lei i suoi segnali di attenzione, come i figli del tool Agent di Claude Code. NON SHALL
archiviarsi un figlio fermato (si legge cosa ha fatto) né uno che la persona ha aperto o messo
davanti (SUBAGENT-21). L'archiviazione SHALL passare dalla stessa porta di ogni archivio
(`archiveTopicFully`). Un figlio con nipoti ancora al lavoro o lavoro in background che lo
risveglierà NON è finito: SHALL restare `running` e in vista, e il turno del suo risveglio SHALL
arrivare al padre come turno successivo (SUBAGENT-19). `send_to_agent` lo riporta in vista.

#### Scenario: Turno finito, figlio fuori dalla vista
- **GIVEN** un figlio nativo mai aperto dalla persona
- **WHEN** il suo turno finisce con esito `completed`
- **THEN** la sua chat è archiviata e non ha badge
- **AND** un `send_to_agent` successivo la riapre e ci manda il turno
