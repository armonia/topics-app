## Purpose

Provider setup, model selection, and coding execution must describe the same available service. API chat and native/CLI coding have distinct capabilities.

## Requirements

### Requirement: MP-SETUP-02 — One provider page with separate tool management

Provider AI settings SHALL keep setup, model selection and connection maintenance in the same expandable list. Unconfigured API connections SHALL expand in place; ready connections SHALL expose key replacement on request within their own card. Provider status and the selected model SHALL remain understandable when collapsed. Errors SHALL retain a direct recovery path.

Advanced provider controls SHALL be grouped as agent execution and local programs. MCP and persistent tool grants SHALL live in a separate Tools settings section using the shared navigation and deep-link registry. Opening Providers, including advanced controls, SHALL issue no MCP discovery requests. Opening Tools SHALL load its current state without modifying any settings or grants.

#### Scenario: Connect and manage in place
- **WHEN** a user expands an unconfigured API provider and connects it
- **THEN** its model controls remain open in the same list
- **AND** a ready provider keeps key replacement folded until requested.

#### Scenario: Tools are independent from provider execution
- **WHEN** a user opens provider execution settings and then Tools
- **THEN** MCP is loaded only in Tools and tool grants remain reachable there
- **AND** provider, runtime and permission selections remain unchanged.

### Requirement: MP-SETUP-01 — Discoverable and persistent API connections

Settings SHALL offer OpenAI and Anthropic API setup before provider registration, support replacement of rejected keys, and explain API billing and installation-scoped storage. Keys SHALL be validated before replacing working credentials, persist in a private server file, and never appear in public settings or snapshots. The reserved credentials directory SHALL be excluded from project file reads, preview, media, file listings, and search, including access through symbolic links. Bootstrap and later discovery SHALL use the same canonical state root. Desktop and mobile SHALL retain usable inputs and controls. Advanced runtime tools SHALL mount only when expanded.

#### Scenario: First API connection and replacement
- **WHEN** a user connects an API key and later replaces it
- **THEN** the validated key persists, the provider appears in the picker, and existing turns continue
- **AND** rejected replacements leave the old credentials intact.

### Requirement: MP-API-01 — Explicit selection and current OpenAI requests

OpenAI requests SHALL preserve the selected model and use compatible output limits. Default settings SHALL apply to subsequent requests. The model catalog SHALL exclude incompatible modalities and share diagnostics requests. Late probes and initial HTTP snapshots SHALL not overwrite newer configuration. Stream failures SHALL not be reported as successful completions. An unavailable explicitly selected provider SHALL fail before message persistence, without routing to another provider.

#### Scenario: Selected GPT and a stale provider response
- **WHEN** a GPT model is selected and a prior snapshot arrives late
- **THEN** the chosen provider/model remain unchanged and subsequent requests carry the selected model.

### Requirement: MP-TASK-01 — Coding-capable task models and correct workspace

Task selectors SHALL list models only from ready coding runtimes. API chat-only transports SHALL not execute coding tasks. A selected GPT model SHALL route to Codex with the task worktree as its working directory. Missing coding runtimes SHALL produce an actionable error rather than use an unrelated default. Existing sessions SHALL not migrate automatically when settings change, and controls SHALL not offer task-model changes that dispatch ignores.

#### Scenario: GPT task with an unavailable runtime
- **WHEN** the selected coding runtime is unavailable at dispatch
- **THEN** no API-only or foreign runtime starts the task.

### Requirement: MP-TASK-02 — Stable readiness while provider discovery refreshes

A routine snapshot refresh SHALL retain the last successful readiness and model catalog until its replacement diagnostic completes. A failed replacement diagnostic SHALL revoke readiness. Explicit invalidation, including credential replacement, SHALL discard the previous readiness immediately.

During initial discovery, a task's explicit Codex selection or Codex coding default SHALL wait for Codex instead of falling back to Claude. Pending discovery SHALL be distinguishable from unavailable configuration, and dispatcher retries SHALL preserve the selected provider without consuming an execution attempt.

#### Scenario: A ready provider is being refreshed
- **WHEN** the snapshot cache expires and a new diagnostic is still pending
- **THEN** the previously ready provider remains routable with its prior catalog
- **AND** a subsequent failed diagnostic makes it unavailable for new tasks.

#### Scenario: Codex has not finished its first diagnostic
- **GIVEN** Codex is the selected task provider or coding default and Claude is ready
- **WHEN** Codex is still loading
- **THEN** task routing reports pending Codex discovery without selecting Claude.

### Requirement: MP-AUTH-01 — Bounded native credential renewal

Native OAuth renewal SHALL hold the inter-process lock, honor a bounded network timeout, and re-read credentials after waiting. A failed lock acquisition SHALL not cause a concurrent refresh or removal of another process's lock.

#### Scenario: Another process owns credential renewal
- **WHEN** the lock wait expires
- **THEN** Topics reuses freshly renewed credentials if available or reports unavailability without issuing an unlocked refresh.

### Requirement: MP-DISPATCH-01 — Claude plan limits only hold Claude work

A Claude plan hold SHALL prevent new Claude coding turns and task resumes until the hold expires or is cleared. The approaching-limit threshold SHALL prevent new Claude task starts while preserving the existing policy for already assigned sessions. Neither limit SHALL prevent Codex/GPT tasks from starting or resuming. A held Claude task SHALL not block an eligible Codex task behind it.

The decision SHALL use the same effective provider as task execution: explicit task model, then board model, then the current coding default. Reused or assigned sessions SHALL retain their actual provider. A limit SHALL not switch providers, consume dispatch attempts, create worktrees or topics, or drop pending human updates. Queued tasks SHALL become eligible again when the relevant limit ends.

#### Scenario: Mixed queue during a Claude plan hold
- **GIVEN** a held Claude task ahead of a task explicitly assigned to GPT
- **WHEN** dispatch runs with Codex available
- **THEN** only the GPT task starts, through Codex, and the Claude task remains queued without consuming an attempt.

#### Scenario: A bound session outlives a default change
- **GIVEN** an existing Claude session and a new Codex default
- **WHEN** a Claude hold is active and a human update requests resume
- **THEN** the update waits for Claude without changing the session; an existing Codex session may resume.

### Requirement: MP-TASK-03 — General automatic selection and readable task models

Task creation, task details and board settings SHALL describe Auto as selection among connected, available models compatible with coding tasks, across providers. The task's Auto choice SHALL explain that an explicit project model takes precedence over general Auto. Auto SHALL NOT imply a restriction to one provider or access to API-only coding capabilities. Existing explicit model overrides and the lock on already assigned sessions SHALL remain intact.

When dispatch resolves a model, task details and board cards SHALL retain its recognizable model name and version rather than reducing it to a provider or family name. Long labels SHALL fit their containing surface, with the complete model available in the detail or tooltip.

#### Scenario: General Auto and a resolved GPT model
- **WHEN** a task using Auto is resolved to `gpt-5.5`
- **THEN** the model chip identifies `GPT-5.5`, not only `gpt`
- **AND** the same model label is used in manual selection and task presentation.

#### Scenario: Manual selection and existing sessions
- **WHEN** a user opens the task model selector before assignment
- **THEN** Auto and available explicit models remain selectable
- **AND** an assigned session keeps its model selector locked.

### Requirement: MP-TASK-04 — Execution first, then compatible models

Every AI input SHALL use the same accessible, responsive model selector
(`ModelSelector`, MSEL-01). One panel shows Automatic and the current models of
every ready engine in the server snapshot, grouped by model maker. There is no
intermediate engine step. Each maker group names, in its heading, the engine
that executes its rows, and lets the user switch engine in place when more than
one engine serves the group; a row repeats its engine only when it differs from
the heading, and its accessible name always contains it (amended 2026-10-04: the
row used to carry the engine and the switch).

A row offers only models its engine can actually execute on that surface.
Coding-task surfaces SHALL exclude API chat transports. Topics native SHALL
execute only its supported Claude coding models. GPT coding models SHALL be
executed by Codex. No unavailable engine or model SHALL silently fall back to a
different engine: a direct route taken because Topics routing cannot reach the
target is declared on the row and on the turn (AICTRL-01).

#### Scenario: A coding task chooses a Codex model
- **WHEN** the user picks GPT-6.1-Sol before starting a task
- **THEN** the OpenAI group heading names Codex as its engine, and the row's accessible name contains Codex
- **AND** dispatch persists and runs Codex with that model.

#### Scenario: Normal chat uses the same presentation
- **WHEN** the same control is opened in a normal chat
- **THEN** models from every ready chat provider in the server snapshot are visible together
- **AND** each group heading names the provider that runs its rows, and a row that runs elsewhere names its own.

### Requirement: MP-TASK-05 — Explicit automatic and project-default scopes

General Automatic SHALL consider ready, compatible providers that are not in an
exhausted quota window. A project default SHALL be labelled and stored as a
separate scope, not as Automatic, an account, a model, or a runtime. Automatic
inside an explicitly selected execution engine SHALL remain constrained to that
engine. The concrete resolved model SHALL stay visible after dispatch without
rewriting labels on historical turns.

#### Scenario: Project default and general Automatic differ
- **WHEN** a task has no override and its project has an explicit default
- **THEN** the UI identifies that inherited project default
- **AND** general Automatic remains a separate selectable value.

### Requirement: MP-TASK-06 — Persistence, unavailability and compatibility

Runtime and model choices SHALL survive task creation, editing, dispatch and
resume. Existing model-only values SHALL remain readable and executable under
their legacy routing rules. An explicit stored value that is no longer
available SHALL remain visible with its reason and a Settings action; it SHALL
not be rewritten. Existing effort choices, manual provider/model overrides and
already-running session bindings SHALL remain authoritative.

#### Scenario: A selected runtime becomes unavailable
- **WHEN** the server snapshot reports the explicitly selected runtime as
  unavailable
- **THEN** the control retains the runtime and model with the reported reason
- **AND** dispatch stops with an actionable error instead of switching runtime.

#### Scenario: A saved model leaves a ready catalog
- **WHEN** a saved prefixed or legacy model is absent from its runtime's latest catalog
- **THEN** it remains the selected manual value in a disabled unavailable row
- **AND** the reason and Settings recovery action remain visible without selecting project Auto.

#### Scenario: A task-capable ACP runtime
- **WHEN** an ACP adapter advertises coding-task capability
- **THEN** its compatible models may appear for explicit task selection
- **AND** an ACP adapter without that capability remains chat-only.

#### Scenario: A resumed session is already bound
- **WHEN** a task resumes or reuses an existing session
- **THEN** its provider, model and effort remain unchanged
- **AND** the selector cannot reclassify that historical binding.

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
- **THEN** focus moves from the search field through the routing band, Automatic and every model row of every maker, skipping section header labels (a header's engine button is a stop only when it offers a choice)
- **AND** Enter selects the focused row and returns focus to the trigger.

#### Scenario: A selector is disabled
- **WHEN** a surface locks the selector during a write or assigned session
- **THEN** every model, Automatic, engine and recovery action is disabled.
