# Model for workflow stages and subagents

Every `agent()` call in a workflow, and every subagent, declares its model
(`model` or `agentType`). Without a declaration it inherits the session model,
which is the most expensive one.

- Workers: Sonnet (`model: 'sonnet'` or `agentType: 'worker'`).
- Mechanical work (sweeps, extraction): Haiku.
- Opus only for `verifier` and `oracle`.
- Never an `Agent` fork, it inherits the full session model.

Origin: card f50e49ae. Measured on the last six coordinator workflows, only 2
of 22 `agent()` calls declared a model; the rest ran on Opus.
