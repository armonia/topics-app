# Tasks

1. `shared/direct-endpoints.ts` — pure types + validation (slug, URL shape, auth mode, model filter, timeout). Unit test.
2. `server/services/direct-endpoint-store.ts` — atomic read/write of `<STATE_DIR>/direct-endpoints.json`, bearer secrets in their own 0600 file. Unit test: round-trip, corrupt file, delete removes the secret.
3. `server/lib/private-endpoint-url.ts` — the URL guard, table-driven test, plus the checked-fetch helper that re-checks redirects.
4. `server/providers/openai-wire.ts` — extract SSE consumption and body assembly from `openai.ts`; the 8 existing tests stay green.
5. `server/providers/openai-compatible.ts` — parametric provider; registration/unregistration on store change.
6. HTTP API + Settings UI: list, add, test, delete; secret write-only.
7. `modelContextWindows` through the snapshot, picker and assembler; context-exceeded message.
8. E2E: Settings CRUD, stubbed chat (stream/abort/usage), board picker exclusion.
9. Live probe against the LAN llama-server, warm-up request first.
