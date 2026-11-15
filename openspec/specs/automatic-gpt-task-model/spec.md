# Automatic coding model planning

### Requirement: AGPT-01 — Available model, task-aware choice
For a fresh task, explicit task > explicit board choice remains authoritative. Unconstrained Automatic compares all ready coding models across providers, excluding any provider during its own hold or, for Claude only, its approaching-limit window. It does not inherit a provider restriction from the host default. A legacy Codex alias remains an explicit provider restriction. Use one brief classification through an eligible runtime; never consume a held provider. Provide the visible account catalog descriptions and supported effort levels and bounded task title/description as data. Choose the least costly adequate capability, considering scope, uncertainty and correctness requirements; do not infer complexity from keyword matches alone. Model complexity, reasoning effort and local machine weight are separate decisions.

#### Scenario: Automatic compares every ready coding provider
- **GIVEN** a fresh task with no explicit task or board choice and ready coding catalogs from more than one provider
- **WHEN** Automatic resolves the model
- **THEN** it compares all of them irrespective of the host default provider
- **AND** one brief classification picks the least costly adequate model

#### Scenario: a held provider is excluded and never consumed
- **GIVEN** a provider during its own hold
- **WHEN** Automatic resolves the model
- **THEN** its models are not candidates and it is not used to classify

### Requirement: AGPT-02 — Validated concrete result and fallback
Accept only a concrete ID in the eligible coding catalog and an effort supported by both that model and Topics task storage. Persist the concrete model on the task and topic before execution. Failed, malformed or unavailable selections fall back to an available everyday coding model with a supported effort; log the fallback reason and actual model. An absent eligible coding catalog produces an actionable error before creating the task agent, with no invented model and no cross-provider fallback.

#### Scenario: invalid, failed or unavailable selection falls back
- **GIVEN** a classification that is malformed, names an ID outside the eligible catalog, names an unsupported effort, or fails or times out
- **WHEN** the plan is validated
- **THEN** an available everyday coding model with a supported effort SHALL be used
- **AND** the fallback reason and the actual model are logged

#### Scenario: no eligible coding catalog
- **GIVEN** an absent eligible coding catalog
- **WHEN** Automatic resolves the model
- **THEN** an actionable error is raised before the task agent is created
- **AND** no model is invented and no other provider is used as fallback

### Requirement: AGPT-03 — Binding and manual precedence
Explicit concrete task and board models bypass classification. A task's explicit provider choice overrides a different board provider choice. Reused or resumed topics retain their existing model/provider/effort without reclassification. A concrete model and its automatic effort stay paired on the task after a fresh resolution; legacy concrete models without a pair use the moderate `medium` fallback. Fresh fanout tasks resolve once and share the same choice across attempts.

#### Scenario: an explicit concrete model bypasses classification
- **GIVEN** a task with an explicit concrete model
- **WHEN** the task is dispatched
- **THEN** the classifier SHALL NOT run
- **AND** with automatic effort the task stores the moderate `medium` fallback

#### Scenario: a reused topic keeps its model
- **GIVEN** a topic reused from a blocker, or resumed
- **WHEN** the task is dispatched
- **THEN** it keeps its existing model, provider and effort without reclassification

#### Scenario: a fresh resolution stays paired with its effort
- **GIVEN** a fresh Automatic resolution that picked a concrete model and effort
- **WHEN** the task is requeued and started again
- **THEN** the same model and effort are used, without a new classification

#### Scenario: fanout resolves once
- **GIVEN** a fresh fanout task on Automatic
- **WHEN** its attempts start
- **THEN** the classifier runs once and every attempt shares the same model and effort

### Requirement: AGPT-04 — Bounded classifier and effective effort
Classification honors per-call model and effort with a short deadline. Codex runs ephemeral with isolated config/rules, no shell/web/MCP tools, and an empty temporary directory. Claude Code uses its existing no-tools and empty strict MCP configuration. Both CLI deadlines terminate their owned process group, including a native process behind a wrapper, before fallback. Topics native uses no tools and propagates its deadline as an AbortSignal to HTTP. The actual task turn reads its topic effort ahead of global defaults. Tests use fake executables and mocked completions only.

#### Scenario: Codex classifier is isolated and bounded
- **GIVEN** a classification through Codex with a per-call model, effort and short deadline
- **WHEN** it runs
- **THEN** it is ephemeral with isolated config and rules, no shell or web tools, and an empty temporary directory
- **AND** on timeout its whole process group, including a native process behind a wrapper, is terminated before fallback

#### Scenario: Claude Code classifier has no tools
- **GIVEN** a classification through Claude Code with a per-call model and effort
- **WHEN** it runs
- **THEN** it uses the existing no-tools configuration
- **AND** on timeout its process tree is closed before fallback

#### Scenario: Topics native classification propagates its deadline
- **GIVEN** a classification through Topics native with a short deadline
- **WHEN** the deadline expires
- **THEN** it is propagated as an AbortSignal to the HTTP request

## Provider and future account boundary
Candidates carry provider identity separately from model identity. Runtime readiness, quota eligibility and advertised model capabilities define the candidate pool; the classifier does not select credentials. Future account connections can supply separate eligible catalogs through this boundary, without changing task binding semantics. Multiple-account authentication is outside this change.

## Current compatible runtime boundary
Automatic candidates are Topics native, Claude Code and Codex with ready advertised catalogs. API chat transports are not coding task agents. ACP Gemini/jcode sessions currently have no Topics bridge (their new/load requests pass empty MCP servers), so they remain outside automatic task selection; existing manual routing and bound sessions are preserved. This is a compatibility boundary, not an account selector.
