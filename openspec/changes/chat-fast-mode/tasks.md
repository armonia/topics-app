# Tasks — chat-fast-mode

Ordine progettato per atomic commits + bisectabilità. Ogni task = 1 commit verde.

## 1. Server: mappatura fast model per provider

- [ ] 1.1 Crea `server/providers/fast-models.ts` con `FAST_MODELS: Record<string, string | null>` + `getFastModelFor(name: string): string | null`.
- [ ] 1.2 Test unit `server/providers/fast-models.test.ts`: ogni provider noto restituisce un id valido; provider sconosciuto → `null`; case-insensitive sui nomi.
- [ ] 1.3 Verifica con `bun test server/providers/fast-models.test.ts` → verde.

## 2. Server: schema Topic + migration `fast_mode`

- [ ] 2.1 Rintraccia `server/db/topics.ts` (o equivalente): definizione tabella `topics`.
- [ ] 2.2 Aggiungi colonna `fast_mode INTEGER DEFAULT 0 NOT NULL` con migration ALTER TABLE idempotente.
- [ ] 2.3 Esponi `Topic.fastMode: boolean` in tipo TS server (mirror di `planMode`).
- [ ] 2.4 Test esistenti su `topics` DB devono continuare a passare.

## 3. Server: route `/api/chat` rispetta fastMode

- [ ] 3.1 In `server/routes/topics.ts` `/api/chat`: leggi `body.fastMode === true`.
- [ ] 3.2 Dopo "Resolve provider", se `fastMode && !body.model && !matchedTopic.model`, set `overrideModel = getFastModelFor(topicProvider.name) ?? overrideModel`.
- [ ] 3.3 Se `getFastModelFor` ritorna un id, ma `snap.providers[].models` non lo lista, lascia che il guard esistente lo droppi e logga `[Chat] Fast mode requested but fast model unavailable for provider X — falling back to default`.
- [ ] 3.4 Propaga `fastMode` a `assembleTopicContext()` opts (per diagnostics).

## 4. Server: route `PUT /api/topics/:id` accetta fastMode

- [ ] 4.1 Aggiungi accettazione `fastMode?: boolean` in handler PUT.
- [ ] 4.2 Broadcast `topic:updated` include nuovo valore (consumato dal sync cross-window).

## 5. Server: envelope diagnostics

- [ ] 5.1 In `server/context/envelope.ts`: `ContextDiagnostics.fastMode?: boolean`.
- [ ] 5.2 In `server/context/assemble.ts`: accetta `opts.fastMode?: boolean`, propaga in `diagnostics.fastMode` (default `false`).
- [ ] 5.3 Test in `server/context/assemble.test.ts`: nuovo scenario verifica `diagnostics.fastMode === true` quando opt è true.

## 6. Server: integration test `/api/chat` con fastMode

- [ ] 6.1 Test: POST `/api/chat` con `fastMode: true` + nessun `model` override + provider `claude-code` → il provider mock riceve `options.model === 'claude-haiku-4-5'`.
- [ ] 6.2 Test: POST con `fastMode: true` MA `model: "claude-sonnet-4-6"` → picker wins, fast ignorato, log info presente.
- [ ] 6.3 Test: POST con `fastMode: false` → comportamento identico al pre-change (regression).

## 7. Client: types + ChatRequest

- [ ] 7.1 `client/src/types/index.ts`: `Topic.fastMode?: boolean`.
- [ ] 7.2 `client/src/hooks/useChat.ts`: `ChatRequest.fastMode?: boolean` + propagazione.
- [ ] 7.3 `client/src/lib/api.ts`: `ChatRequest.fastMode?: boolean`.

## 8. Client: state fastMode in ChatPane

- [ ] 8.1 `ChatPane.tsx`: aggiungi `[fastMode, setFastMode]` con localStorage init/persist `fastMode:${topic.id}`.
- [ ] 8.2 `toggleFastMode` mirror di `togglePlanMode`: aggiorna state + localStorage + `PUT /api/topics/:id` ottimistico.
- [ ] 8.3 `handleSendMessage`: se `fastMode` true → `opts.fastMode = true` nel chiamato a `sendMessage`.

## 9. Client: bottone ⚡ in ChatInput

- [ ] 9.1 `ChatInput.tsx`: nuovi prop `fastMode?: boolean`, `onToggleFastMode?: () => void`.
- [ ] 9.2 Inserisci `<button>` con icona `Zap` (lucide-react) tra `<ClipboardList>` button (line ~838-850) e `<ContextRing>` button (line ~852-862).
- [ ] 9.3 Stile: ON = `text-amber-500 bg-amber-500/10`, OFF = `text-app-text-muted hover:text-app-text hover:bg-app-hover`. `data-testid="chat-input-fast-mode"`.
- [ ] 9.4 Tooltip dinamico con nome provider/modello.

## 10. Client: cross-window sync

- [ ] 10.1 `useProjectChatSync` (o equivalente listener `topic:updated`): aggiorna `Topic.fastMode` in cache locale quando arriva broadcast.
- [ ] 10.2 ChatPane: subscribe a topic updates per ri-allineare `fastMode` se cambiato da altra window.

## 11. Tests E2E (Playwright)

- [ ] 11.1 Spec `tests/e2e/chat-fast-mode.spec.ts`: apre topic, clicca ⚡, invia messaggio, verifica che il body request contiene `fastMode: true`, verifica che il bottone è amber.
- [ ] 11.2 Spec verifica persistenza: chiude/riapre topic, ⚡ resta ON.
- [ ] 11.3 Spec verifica compatibilità con Plan: attiva ⚡ + Plan, entrambi sono ON, request contiene `planMode: true, fastMode: true`.
- [ ] 11.4 Video output salvato in `test-results/chat-fast-mode/`.

## 12. Verify & Ship

- [ ] 12.1 `bun test server/` → tutto verde (no regression).
- [ ] 12.2 `bun run build:client` → no TS errors.
- [ ] 12.3 `npx playwright test tests/e2e/chat-fast-mode.spec.ts` → verde + video.
- [ ] 12.4 `/gsd:spec-verify chat-fast-mode` → AC coverage OK.
- [ ] 12.5 Smoke manuale: toggle ⚡, invia "ciao", osserva latenza minore e nel context inspector `diagnostics.fastMode: true`.
- [ ] 12.6 Commit atomici per ognuno dei 1-11. Squash NON ammesso (bisectabilità).
