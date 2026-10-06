# Muse — first-class provider

Muse (Meta's CLI) SHALL behave like every other first-class provider in
Topics: registered by the backend, listed with models, selectable in chat and
task pickers, configurable in Settings, a PTY short of nothing.

## ADDED Requirements

### Requirement: MUSE-01 — Registered when installed and logged in, absent otherwise

When the `muse` launcher resolves and a stored Meta login exists
(`auth.json` carries `providers.meta.mechanism`, or `META_API_KEY` is set),
the provider SHALL register with `connected: true`. When the launcher is
missing or no login exists, the provider SHALL NOT register: no dead picker
entry.

#### Scenario: logged-in machine registers muse
- **GIVEN** `muse` on PATH and a stored login
- **WHEN** the server boots and builds the providers snapshot
- **THEN** the snapshot carries a `muse` entry with status `ready` and the
  catalog models

#### Scenario: no login, no provider
- **GIVEN** `muse` on PATH and no stored login
- **WHEN** the server boots
- **THEN** no `muse` entry exists in the snapshot and the picker shows no
  Muse row

### Requirement: MUSE-02 — A turn streams text and tools, then closes with usage

A chat turn on provider `muse` SHALL stream assistant text deltas and tool
calls to the `StreamHandler` and SHALL close exactly once (`onDone` with the
full text and usage, or `onError`). Aborting mid-turn SHALL kill only that
turn's process and report `onAborted`, never a crash.

#### Scenario: delta, tool and terminal all reach the handler
- **GIVEN** a topic on a muse model
- **WHEN** one turn runs with text, one tool call and a terminal event
- **THEN** the handler sees every delta, the tool start and result, and
  exactly one terminal close

### Requirement: MUSE-03 — Turns resume the same CLI session

The provider SHALL persist one Muse session id per Topics session and reuse
it (`--session-id`) on later turns, so the model keeps the conversation
without Topics resending history. When the stored id is orphaned (the CLI's
session log is gone), the provider SHALL fall back to a fresh session once
and forget the dead id.

#### Scenario: second turn reuses the sid
- **GIVEN** a topic with one completed muse turn and a stored sid
- **WHEN** a second turn runs
- **THEN** the CLI is invoked with the same sid and no transcript is
  re-sent, and the answer shows memory of the first turn

### Requirement: MUSE-04 — Settings card and pickers list Muse like the rest

Settings → Providers SHALL show a Muse card (status, program path, default
model), and the chat ModelSelector SHALL list the visible catalog models as
selectable rows. Selecting one SHALL route the topic's turns to it.

#### Scenario: card ready with the catalog models
- **GIVEN** a logged-in machine with two visible catalog models
- **WHEN** Settings → Providers opens
- **THEN** the Muse card shows ready with 2 models

#### Scenario: model answers on the topic
- **GIVEN** a topic
- **WHEN** a muse model is picked and a message sent
- **THEN** the assistant answer arrives on that topic
