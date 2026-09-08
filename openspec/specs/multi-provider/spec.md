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
