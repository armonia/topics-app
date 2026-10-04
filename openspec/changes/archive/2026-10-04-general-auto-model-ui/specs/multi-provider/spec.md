## ADDED Requirements

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

Every AI input SHALL use the same accessible, responsive execution-and-model
presentation. The first step chooses Automatic or one execution engine reported
by the current server snapshot; the second step contains only models that engine
can actually execute on that surface. Coding-task surfaces SHALL exclude API
chat transports. Topics native SHALL expose only its supported Claude coding
models, while GPT coding models SHALL be routed through Codex. No unavailable
engine or model SHALL silently fall back to a different engine.

#### Scenario: A coding task chooses its execution engine
- **WHEN** the user chooses Codex before starting a task
- **THEN** only Codex coding models are offered
- **AND** dispatch persists and runs the chosen Codex engine and model.

#### Scenario: Normal chat uses the same presentation
- **WHEN** the same control is opened in a normal chat
- **THEN** ready chat providers from the server snapshot are execution choices
- **AND** their own advertised models are shown after the provider is chosen.

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

The shared control SHALL use existing application tokens and popover primitives,
provide Italian and English copy, support keyboard traversal and selection,
restore focus to its trigger after closing, and remain within a small viewport.
Unavailable choices SHALL expose a reason and recovery action with sufficient
token-based contrast. The change SHALL add no dependency and SHALL not promote
the model tier solely to render the UI.

#### Scenario: Keyboard transition between levels
- **WHEN** the user enters an execution engine with Enter and returns with the back row
- **THEN** focus moves to the new level and returns to the same execution row
- **AND** Arrow keys and Enter continue to operate after each DOM replacement.

#### Scenario: A selector is disabled
- **WHEN** a surface locks the selector during a write or assigned session
- **THEN** every execution, model, Automatic, back and recovery action is disabled.
