# Tasks — chat-fast-mode

Ordine progettato per atomic commits + bisectabilità. Ogni task = 1 commit verde.

## 1. Server: mappatura fast model per provider

- [x] 1.1 Crea `server/providers/fast-models.ts` con `FAST_MODELS: Record<string, string | null>` + `getFastModelFor(name: string): string | null`.
- [x] 1.2 Test unit `server/providers/fast-models.test.ts`: ogni provider noto restituisce un id valido; provider sconosciuto → `null`; case-insensitive sui nomi.
- [x] 1.3 Verifica con `bun test server/providers/fast-models.test.ts` → verde.

## 2. Server: schema Topic + migration `fast_mode`

- [x] 2.1 Rintraccia `server/db/topics.ts` (o equivalente): definizione tabella `topics`.
- [x] 2.2 Aggiungi colonna `fast_mode INTEGER DEFAULT 0 NOT NULL` con migration ALTER TABLE idempotente.
- [x] 2.3 Esponi `Topic.fastMode: boolean` in tipo TS server (mirror di `planMode`).
- [x] 2.4 Test esistenti su `topics` DB devono continuare a passare.

## 3. Server: route `/api/chat` rispetta fastMode

- [x] 3.1 In `server/routes/topics.ts` `/api/chat`: leggi `body.fastMode === true`.
- [x] 3.2 Dopo "Resolve provider", se `fastMode && !body.model && !matchedTopic.model`, set `overrideModel = getFastModelFor(topicProvider.name) ?? overrideModel`.
- [x] 3.3 Se `getFastModelFor` ritorna un id, ma `snap.providers[].models` non lo lista, lascia che il guard esistente lo droppi e logga `[Chat] Fast mode requested but fast model unavailable for provider X — falling back to default`.
- [x] 3.4 Propaga `fastMode` a `assembleTopicContext()` opts (per diagnostics).

## 4. Server: route `PUT /api/topics/:id` accetta fastMode

- [x] 4.1 Aggiungi accettazione `fastMode?: boolean` in handler PUT.
- [x] 4.2 Broadcast `topic:updated` include nuovo valore (consumato dal sync cross-window).

## 5. Server: envelope diagnostics

- [x] 5.1 In `server/context/envelope.ts`: `ContextDiagnostics.fastMode?: boolean`.
- [x] 5.2 In `server/context/assemble.ts`: accetta `opts.fastMode?: boolean`, propaga in `diagnostics.fastMode` (default `false`).
- [x] 5.3 Test in `server/context/assemble.test.ts`: nuovo scenario verifica `diagnostics.fastMode === true` quando opt è true.

## 6. Server: integration test `/api/chat` con fastMode

- [x] 6.1 Test: POST `/api/chat` con `fastMode: true` + nessun `model` override + provider `claude-code` → il provider mock riceve `options.model === 'claude-haiku-4-5'`.
- [x] 6.2 Test: POST con `fastMode: true` MA `model: "claude-sonnet-4-6"` → picker wins, fast ignorato, log info presente.
- [x] 6.3 Test: POST con `fastMode: false` → comportamento identico al pre-change (regression).

## 7. Client: types + ChatRequest

- [x] 7.1 `client/src/types/index.ts`: `Topic.fastMode?: boolean`.
- [x] 7.2 `client/src/hooks/useChat.ts`: `ChatRequest.fastMode?: boolean` + propagazione.
- [x] 7.3 `client/src/lib/api.ts`: `ChatRequest.fastMode?: boolean`.

## 8. Client: state fastMode in ChatPane

- [x] 8.1 `ChatPane.tsx`: aggiungi `[fastMode, setFastMode]` con localStorage init/persist `fastMode:${topic.id}`.
- [x] 8.2 `toggleFastMode` mirror di `togglePlanMode`: aggiorna state + localStorage + `PUT /api/topics/:id` ottimistico.
- [x] 8.3 `handleSendMessage`: se `fastMode` true → `opts.fastMode = true` nel chiamato a `sendMessage`.

## 9. Client: bottone ⚡ in ChatInput

- [x] 9.1 `ChatInput.tsx`: nuovi prop `fastMode?: boolean`, `onToggleFastMode?: () => void`.
- [x] 9.2 Inserisci `<button>` con icona `Zap` (lucide-react) tra `<ClipboardList>` button (line ~838-850) e `<ContextRing>` button (line ~852-862).
- [x] 9.3 Stile: ON = `text-amber-500 bg-amber-500/10`, OFF = `text-app-text-muted hover:text-app-text hover:bg-app-hover`. `data-testid="chat-input-fast-mode"`.
- [x] 9.4 Tooltip dinamico con nome provider/modello.

## 10. Client: cross-window sync

- [x] 10.1 `useProjectChatSync` (o equivalente listener `topic:updated`): aggiorna `Topic.fastMode` in cache locale quando arriva broadcast.
- [x] 10.2 ChatPane: subscribe a topic updates per ri-allineare `fastMode` se cambiato da altra window.

## 11. Tests E2E (Playwright)

- [x] 11.1 Spec `tests/e2e/chat-fast-mode.spec.ts`: apre topic, clicca ⚡, invia messaggio, verifica che il body request contiene `fastMode: true`, verifica che il bottone è amber.
- [x] 11.2 Spec verifica persistenza: chiude/riapre topic, ⚡ resta ON.
- [x] 11.3 Spec verifica compatibilità con Plan: attiva ⚡ + Plan, entrambi sono ON, request contiene `planMode: true, fastMode: true`.
- [x] 11.4 Video output salvato in `test-results/chat-fast-mode/`.

## 12. Verify & Ship

- [x] 12.1 `bun test server/` → tutto verde (no regression).
- [x] 12.2 `bun run build:client` → no TS errors.
- [x] 12.3 `npx playwright test tests/e2e/chat-fast-mode.spec.ts` → verde + video.
- [x] 12.4 `/gsd:spec-verify chat-fast-mode` → AC coverage OK.
- [x] 12.5 Smoke manuale: toggle ⚡, invia "ciao", osserva latenza minore e nel context inspector `diagnostics.fastMode: true`.
- [x] 12.6 Commit atomici per ognuno dei 1-11. Squash NON ammesso (bisectabilità).

---

## Audit 2026-05-16

All 41 tasks verified implemented against the codebase:
- `server/providers/fast-models.ts` + `fast-models.test.ts` (22 pass / 0 fail / 31 expects).
- Migration `024-topic-fast-mode.sql` adds `fast_mode INTEGER DEFAULT 0 NOT NULL`.
- `Topic.fastMode` exposed in `server/types.ts` and `client/src/types/index.ts:37`.
- `/api/chat` reads `body.fastMode` and applies `getFastModelFor()` (`routes/topics.ts:1094, 1533`).
- `ContextDiagnostics.fastMode` propagated in `server/context/assemble.ts:115-222`.
- `ChatPane.tsx:124-128` has localStorage init + cross-window reconcile.

No regressions; tasks marked complete in bulk.
