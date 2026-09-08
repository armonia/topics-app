# Automatic coding model planning

### Requirement: AGPT-01 — Available model, task-aware choice
For a fresh task, explicit task > explicit board choice remains authoritative. Unconstrained Automatic compares all ready coding models across providers, excluding Claude during a hold or approaching-limit window. It does not inherit a provider restriction from the host default. A legacy Codex alias remains an explicit provider restriction. Use one brief classification through an eligible runtime; never consume a held Claude provider. Provide the visible account catalog descriptions and supported effort levels and bounded task title/description as data. Choose the least costly adequate capability, considering scope, uncertainty and correctness requirements; do not infer complexity from keyword matches alone. Model complexity, reasoning effort and local machine weight are separate decisions.

### Requirement: AGPT-02 — Validated concrete result and fallback
Accept only a concrete ID in the eligible coding catalog and an effort supported by both that model and Topics task storage. Persist the concrete model on the task and topic before execution. Failed, malformed or unavailable selections fall back to an available everyday coding model with a supported effort; log the fallback reason and actual model. An absent eligible coding catalog produces an actionable error before creating the task agent, with no invented model and no cross-provider fallback.

### Requirement: AGPT-03 — Binding and manual precedence
Explicit concrete task and board models bypass classification. A task's explicit provider choice overrides a different board provider choice. Reused or resumed topics retain their existing model/provider/effort without reclassification. Fresh fanout tasks resolve once and share the same choice across attempts.

### Requirement: AGPT-04 — Bounded classifier and effective effort
Classification honors per-call model and effort with a short deadline. Codex runs ephemeral with isolated config/rules, no shell/web/MCP tools, and an empty temporary directory. Claude Code uses its existing no-tools and empty strict MCP configuration. Both CLI deadlines terminate their owned process group, including a native process behind a wrapper, before fallback. Topics native uses no tools and propagates its deadline as an AbortSignal to HTTP. The actual task turn reads its topic effort ahead of global defaults. Tests use fake executables and mocked completions only.

## Provider and future account boundary
Candidates carry provider identity separately from model identity. Runtime readiness, quota eligibility and advertised model capabilities define the candidate pool; the classifier does not select credentials. Future account connections can supply separate eligible catalogs through this boundary, without changing task binding semantics. Multiple-account authentication is outside this change.

## Current compatible runtime boundary
Automatic candidates are Topics native, Claude Code and Codex with ready advertised catalogs. API chat transports are not coding task agents. ACP Gemini/jcode sessions currently have no Topics bridge (their new/load requests pass empty MCP servers), so they remain outside automatic task selection; existing manual routing and bound sessions are preserved. This is a compatibility boundary, not an account selector.
