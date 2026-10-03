# Multi-provider: delta di model-selector

Modifica requisiti della change `general-auto-model-ui`, che va archiviata
prima di questa.

## MODIFIED Requirements

### Requirement: MP-TASK-04 — Execution first, then compatible models

Every AI input SHALL use the same accessible, responsive model selector
(`ModelSelector`, MSEL-01). One panel shows Automatic and the current models of
every ready engine in the server snapshot, grouped by model maker. There is no
intermediate engine step. Each model row names the engine that executes it, and
lets the user switch engine in place when more than one engine offers the model.

A row offers only models its engine can actually execute on that surface.
Coding-task surfaces SHALL exclude API chat transports. Topics native SHALL
execute only its supported Claude coding models. GPT coding models SHALL be
executed by Codex. No unavailable engine or model SHALL silently fall back to a
different engine: a direct route taken because Topics routing cannot reach the
target is declared on the row and on the turn (AICTRL-01).

#### Scenario: A coding task chooses a Codex model
- **WHEN** the user picks GPT-6.1-Sol before starting a task
- **THEN** the row names Codex as its engine
- **AND** dispatch persists and runs Codex with that model.

#### Scenario: Normal chat uses the same presentation
- **WHEN** the same control is opened in a normal chat
- **THEN** models from every ready chat provider in the server snapshot are visible together
- **AND** each row names the provider that runs it.

### Requirement: MP-TASK-07 — Interaction and localization

The shared control SHALL:
- use existing application tokens and popover primitives;
- provide Italian and English copy;
- support keyboard traversal and selection across every maker section;
- restore focus to its trigger after closing;
- remain within a small viewport as a full-width bottom sheet.

Unavailable choices SHALL expose a reason and recovery action, with sufficient
token-based contrast. The change SHALL add no dependency, and SHALL not promote
the model tier solely to render the UI.

#### Scenario: Keyboard traversal across makers
- **WHEN** the user opens the selector and presses ArrowDown repeatedly
- **THEN** focus moves from the search field through the routing band, Automatic and every model row of every maker, skipping section headers
- **AND** Enter selects the focused row and returns focus to the trigger.

#### Scenario: A selector is disabled
- **WHEN** a surface locks the selector during a write or assigned session
- **THEN** every model, Automatic, engine and recovery action is disabled.
