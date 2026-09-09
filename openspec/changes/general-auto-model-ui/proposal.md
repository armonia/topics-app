# General Auto model presentation

The user clarified that Auto should select across connected providers, while manual choices remain available. This change aligns the three task/board selectors and preserves recognizable model versions in resolved task chips. Routing and readiness are implemented in the parallel general Auto change; this patch adds no selector mode, credentials, migration, or runtime behavior.

Validation: targeted model-formatting regressions, existing task/card unit tests, client typecheck, and isolated browser evidence for resolved chips and unchanged manual/assigned controls. No real provider login or model call is needed.

## Future account boundaries

- `server/providers/types.ts: AIProvider` describes an execution adapter; `server/providers/index.ts` registers one instance per provider name. A provider name currently also identifies the configured connection.
- `server/services/api-provider-credentials.ts` stores one key per API provider per installation. `server/providers/codex.ts` discovers one account context from its configured home. Neither is a Topics account registry.
- `shared/types.ts: ProviderSnapshotEntry` exposes status and a model catalog per provider; `Topic` persists provider/model. `shared/task-coding-models.ts` still encodes some task routing in the model string. No connection/account identity exists on these contracts.
- A future multiple-account design needs a separate connection identity referencing the adapter, private credentials, owner/access scope and account-specific availability/limits. A running session must remain bound to that connection. The model id must stay distinct from that identity; exposing another model choice alone cannot select another account.

These are implementation boundaries for the existing Topics follow-up tasks, not a new account feature or a proposed authentication flow.
