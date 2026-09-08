## Purpose

Provider setup, model selection, and coding execution must describe the same available service. API chat and native/CLI coding have distinct capabilities.

## Requirements

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
