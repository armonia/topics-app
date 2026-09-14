# Configurable OpenAI-compatible endpoints for chats

## Goal
Let whoever uses the app add their own OpenAI-compatible HTTP endpoints (llama-server, vLLM, LM Studio, a remote gateway) in Settings and pick them for CHATS, without touching the two built-in API providers.

## Scope
Endpoints are declared in Settings, persisted outside the database, registered as regular chat providers named `direct-<slug>`, and offered in the chat provider/model picker. The OpenAI transport is factored into a reusable wire module so both the built-in `openai` provider and the configurable ones share one code path.

Out of scope, deliberately: the Kanban task pickers. MP-TASK-01 requires coding-capable runtimes, and this transport does one completion round with no file/bash tools and no board access, so a card dispatched on it could never close. Running the board on a local model is a separate decision (ACP with a jcode profile is the short road).

## Acceptance bar
- Unit: URL guard table, endpoint store round-trip, wire module. The 8 existing `openai.test.ts` tests stay green unchanged.
- E2E: add / test / delete an endpoint in Settings; a chat against a stubbed endpoint (`page.route`) covering streaming, abort and usage; an explicit test that no `direct-*` provider appears in the task pickers.
- Live probe against a real llama-server on the LAN, with one warm-up request before the measurement.
- The seven code gates green; no bloat added to the frozen files (`agent-loop.ts`, `native/provider.ts`, `chat.ts`, `task-dispatcher.ts`).

## Verification
Filled at delivery.
