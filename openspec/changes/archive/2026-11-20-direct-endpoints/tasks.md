# Tasks

1. [x] `shared/direct-endpoints.ts` — pure types + validation (slug, URL shape, auth mode, model filter, timeout). Unit test.
2. [x] `server/services/direct-endpoint-store.ts` — atomic read/write of `<STATE_DIR>/direct-endpoints.json`, bearer secrets in their own 0600 file. Unit test: round-trip, corrupt file, delete removes the secret.
3. [x] `server/lib/private-endpoint-url.ts` — the URL guard, table-driven test, plus the checked-fetch helper that re-checks redirects.
4. [x] `server/providers/openai-wire.ts` — extract SSE consumption and body assembly from `openai.ts`; the 8 existing tests stay green.
5. [x] `server/providers/openai-compatible.ts` — parametric provider; registration/unregistration on store change.
6. [x] HTTP API + Settings UI: list, add, test, delete; secret write-only.
7. [x] `modelContextWindows` through the snapshot, picker and assembler; context-exceeded message.
8. [x] E2E: Settings CRUD, stubbed chat (stream/abort/usage), board picker exclusion.
9. [ ] Live probe against the LAN llama-server, warm-up request first.

Step 9 needs a machine that is not this one: the endpoint lives on the LAN box and reaching it takes an ssh session on somebody's PC. Asked on the card rather than done unasked.
