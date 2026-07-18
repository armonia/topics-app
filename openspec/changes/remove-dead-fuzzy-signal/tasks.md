# Tasks — remove-dead-fuzzy-signal

Refactor senza cambio di comportamento. Chiudere con typecheck server verde + test verdi.

## Phase 1 — Picker (server/services/task-model-picker.ts)
- [x] Prompt del classifier a UNA parola (via il blocco "Chiarezza: ok|fuzzy").
- [x] Rimosso `parseFuzzy`, `PickModelResult`, `pickTaskModelDetailed`.
- [x] `pickTaskModel` è l'API primaria (ritorna il model id, fallback su errore).
- [x] `parseTier` tollera una seconda parola residua (regex `^\s*(tier)\b`).

## Phase 2 — Dispatcher + wiring
- [x] `task-dispatcher.ts`: dep `pickAutoModel` → `Promise<{ model: string | null }>`; doc
      corretta (niente più menzione di auto-plan-first).
- [x] `server.ts`: usa `pickTaskModel` (model-only), avvolto in `{ model }`.

## Phase 3 — Test
- [x] `task-model-picker.test.ts`: via i test fuzzy/detailed; execution-floor su
      `pickTaskModel`.
- [x] `task-dispatcher.test.ts`: mock a `{ model }`; "task vago non forza plan-first"
      preservato senza il campo.

## Phase 4 — Verifica
- [x] `bun test server/services/task-model-picker.test.ts` verde (17 pass).
- [x] `bun test server/services/task-dispatcher.test.ts`: 48 pass; i 2 fail su
      "priority" sono baseline pre-esistenti (non toccati da questa change).
- [x] `bun run typecheck:server` verde (0 errori).
