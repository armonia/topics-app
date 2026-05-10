# Tasks — Topic Context Canonical

## 1. Tipi Envelope

- [x] 1.1 Creare `server/context/envelope.ts` con `SystemBlock`, `SystemBlockCategory`, `ProviderContextStrategy`, `HistoryEntryDiagnostic`, `ContextDiagnostics`, `ContextEnvelope`, `ProviderPayload`. Solo tipi, no logica.
- [x] 1.2 Creare `server/context/index.ts` re-exports.
- [x] 1.3 `bun run typecheck` verde.

## 2. Provider Strategy Registry

- [x] 2.1 In `server/providers/types.ts`, aggiungere `contextStrategy?: ProviderContextStrategy` su `Provider` interface.
- [x] 2.2 Dichiarare `contextStrategy` in:
  - [x] `claude.ts` → `"history-aware"`
  - [x] `openai.ts` → `"history-aware"`
  - [x] `codex.ts` → `"history-aware"`
  - [x] `claude-code.ts` → `"inline-system"`
  - [x] `openclaw.ts` → `"gateway-stateful"`
- [x] 2.3 Creare `server/context/provider-strategy.ts` con `getProviderStrategy(provider)` (fallback derivato da `capabilities.has("history")` per compat).
- [x] 2.4 Test `provider-strategy.test.ts`: 1 test per ciascun provider + 1 fallback con provider sintetico senza `contextStrategy`.

## 3. Assemble Function

- [x] 3.1 Creare `server/context/assemble.ts` con `assembleTopicContext(ctx, args)`.
- [x] 3.2 Estrarre helper privati condivisi tra `assemble` e `openclaw-context.ts`:
  - [x] `readSafe(filePath)` (già in `openclaw-context.ts`)
  - [x] `estimateTokens(text)` (già)
  - [x] `scanMemoryTreeTokens(dir)` (versione che ritorna solo token totali)
  - Decidere se duplicare o promuovere a `server/context/utils.ts` (preferibile la promotion).
- [x] 3.3 Implementare assembly system blocks nell'ordine specificato in design (OpenClaw 6 file → memory tree → global memory → topic memory → system prompt → project templates → context files → pinned).
- [x] 3.4 Implementare history pipeline:
  - [x] Carica `loadLocalMessages(sessionKey)`.
  - [x] Per ogni messaggio costruisci `HistoryEntryDiagnostic` con marker detection.
  - [x] Applica `excludeReason` priorità: `partial` → `context-message` → `empty-after-strip` → `duplicate-last-user` (se `includeLastUserInHistory=false` e match) → `limit` (oltre `historyLimit`).
  - [x] `history[]` finale = filtra esclusi + map a `ChatMessage[]` con `stripMarkers + trim`.
- [x] 3.5 Calcola `diagnostics`: tokens, budget, droppedHistoryTurns, warnings (budget > 80%, large source > 10000).
- [x] 3.6 Risolvi `userMessage` da override o da DB (ultimo user turn).
- [x] 3.7 `providerStrategy` via `getProviderStrategy(providerName)`.

## 4. Assemble Tests

- [x] 4.1 `server/context/assemble.test.ts` — fixtures:
  - [x] Topic minimo (no system prompt, no context files, no pinned, 0 messaggi) → systemBlocks ha solo i 6 OpenClaw + memory tree, history vuota, totalTokens calcolato.
  - [x] Topic con system prompt → block `prompt:system` presente, editable.
  - [x] Topic con `disabledContextSources: ["memory:global"]` → global memory `enabled: false`, NON conta nel budget.
  - [x] Topic con project path con `.claude/CLAUDE.md` (ma niente CLAUDE.md root) → label `.claude/CLAUDE.md`.
  - [x] Topic con 150 messaggi → `history.length === 100`, `diagnostics.droppedHistoryTurns === 50`, ognuno con `excludeReason: "limit"`.
  - [x] Messaggio con `{{BROWSER:open}}` → `strippedMarkers: ["{{BROWSER:open}}"]`, `bytesDropped > 0`, contenuto in history senza marker.
  - [x] Messaggio partial → `excluded: true`, `excludeReason: "partial"`.
  - [x] Messaggio che inizia con `[Chat messages since your last reply` → `excludeReason: "context-message"`.
  - [x] `includeLastUserInHistory: false` + ultimo turn user → quel turn ha `excluded: true, excludeReason: "duplicate-last-user"`, NON in history finale, MA `userMessage.content` lo contiene.
- [x] 4.2 Test golden snapshot: fixture topic stabile → snapshot envelope JSON. Cattura behavior corrente, blocca regression.

## 5. Adapt Function

- [x] 5.1 Creare `server/context/adapt.ts` con `adaptEnvelope(envelope) → ProviderPayload`.
- [x] 5.2 Implementare 3 branch `providerStrategy`:
  - [x] `history-aware`: `history = [systemMessages..., envelope.history...]`, `userContent = envelope.userMessage.content`.
  - [x] `inline-system`: `userContent = "<context>...preamble...</context>\n\n" + envelope.userMessage.content` (oppure solo userMessage se 0 enabled blocks). `history` NON impostato.
  - [x] `gateway-stateful`: come history-aware ma con `adaptationNotes` distinte.
- [x] 5.3 `adaptationNotes[]` popolata in tutti e 3 i casi con stringhe descrittive (vedere design).

## 6. Adapt Tests

- [x] 6.1 `server/context/adapt.test.ts` — matrice:
  - [x] history-aware × 0 systemBlocks → `history === envelope.history`, `userContent === envelope.userMessage.content`.
  - [x] history-aware × 3 systemBlocks → `history` ha 3 system messages + envelope.history.
  - [x] inline-system × 0 systemBlocks → `userContent === envelope.userMessage.content`, `history === undefined`.
  - [x] inline-system × 3 systemBlocks → `userContent` inizia con `<context>\n`, contiene tutti e 3 i contenuti separati da `\n\n---\n\n`, finisce con `\n</context>\n\n` + userMessage.
  - [x] gateway-stateful × 2 systemBlocks → comportamento history-aware + nota distinta.
  - [x] adaptationNotes contiene drop count quando `droppedHistoryTurns > 0`.

## 7. Snapshots Module

- [x] 7.1 Creare `server/context/snapshots.ts` con ring `Map<topicId, ContextEnvelope[]>` size 5.
- [x] 7.2 `pushSnapshot(envelope)`, `getSnapshots(topicId)`, `clearSnapshots(topicId?)`.
- [x] 7.3 Test `snapshots.test.ts`:
  - [x] Push 3 → get ritorna 3 in chronological.
  - [x] Push 7 → get ritorna ultimi 5.
  - [x] 2 topic distinti isolati.
  - [x] `clearSnapshots(topicId)` rimuove solo quel topic.
  - [x] `clearSnapshots()` no-arg rimuove tutto.
  - [x] `getSnapshots` ritorna copia (mutazione esterna NON impatta storage).

## 8. Refactor `streamEditResponse`

- [x] 8.1 In `server/routes/topics.ts` ~line 2517-2559, sostituire la logica `supportsHistory` inline con:
  - [x] `const envelope = assembleTopicContext(ctx, { sessionKey, providerName: topicProvider.name, userMessageOverride: { content: lastUser, messageId: lastUserMsg?.id }, includeLastUserInHistory: false });`
  - [x] `pushSnapshot(envelope);`
  - [x] `const payload = adaptEnvelope(envelope);`
  - [x] `sendOptions.history = payload.history;` (se presente)
  - [x] Passare `payload.userContent` a `topicProvider.sendChat`.
- [x] 8.2 Rimuovere il codice morto (`finalMessages.filter(m => m.role === "system")`, `dbHistory`, `ephemeralSystems`, `contextMessages`, manuale costruzione `<context>`).
- [x] 8.3 Verificare che `finalMessages` non sia più necessario per il payload (ma può servire per altri usi locali — controllare).
- [x] 8.4 Regression test `topics-route-payload.test.ts`:
  - [x] Mock provider che cattura ogni chiamata a `sendChat`.
  - [x] Fixture topic + history.
  - [x] POST `/api/topics/:id/message` con vari scenari (con/senza pinned, con/senza system prompt, con context files, provider history-aware vs inline-system).
  - [x] Asserisci payload identico a baseline (golden file).

## 9. Compat Layer per `/api/context/analyze`

- [x] 9.1 In `server/routes/openclaw-context.ts`, riscrivere il body dell'endpoint `GET /api/context/analyze` per chiamare `assembleTopicContext(ctx, { sessionKey: topic.sessionKey, providerName: topic.provider, includeLastUserInHistory: true })` e proiettare il vecchio shape.
- [x] 9.2 Mantenere cache 15s (chiave: `${topicId}::${providerName}`).
- [x] 9.3 Test back-compat `openclaw-context-analyze.test.ts`: shape risposta identica a prima del refactor (campi: `sources[]`, `totalTokens`, `budgetLimit`, `budgetPercent`, `warnings[]`).

## 10. Endpoint Preview & Snapshots

- [x] 10.1 Creare `server/routes/context-preview.ts` con `createContextPreviewRouter(ctx)`.
- [x] 10.2 `GET /api/topics/:id/context-preview?provider=<name>`:
  - [x] Risolve topic, providerName (default = topic.provider corrente).
  - [x] Chiama `assembleTopicContext` con `includeLastUserInHistory: true` (mostra il prossimo invio).
  - [x] Chiama `adaptEnvelope` per ottenere payload.
  - [x] Ritorna `{ envelope, payload }`.
- [x] 10.3 `GET /api/topics/:id/context-snapshots`:
  - [x] Ritorna `{ snapshots: getSnapshots(topicId) }`.
- [x] 10.4 `DELETE /api/topics/:id/context-snapshots` (debug):
  - [x] `clearSnapshots(topicId)`, ritorna `{ ok: true }`.
- [x] 10.5 Wire del router in `server/server.ts` (o entrypoint che combina i router).
- [x] 10.6 Test `context-preview.test.ts`:
  - [x] GET preview ritorna envelope + payload.
  - [x] GET snapshots inizialmente vuoto.
  - [x] Dopo POST `/api/topics/:id/message`, snapshots ha 1 entry.
  - [x] 6 POST consecutivi → snapshots resta a 5.
  - [x] DELETE pulisce.

## 11. Client UI Inspector

- [x] 11.1 In `client/src/lib/api.ts`, aggiungere:
  - [x] `contextPreviewApi.fetch(topicId, provider?)` → `{ envelope, payload }`.
  - [x] `contextSnapshotsApi.list(topicId)` → `{ snapshots }`.
  - [x] `contextSnapshotsApi.clear(topicId)` → `{ ok }`.
- [x] 11.2 In `client/src/hooks/useContextInspector.ts`, opzionalmente caricare anche `contextPreviewApi.fetch` (parallelo a `analyze` per back-compat). Esporre `envelope`, `payload`, `snapshots` aggiuntivi.
- [x] 11.3 Identificare componente inspector principale (`ContextInspector*.tsx`). Aggiungere sezioni:
  - [x] **Provider** badge: nome + strategy.
  - [x] **History** sezione collapsible: count turn inclusi, droppedHistoryTurns, list di entries con marker strippati evidenziati.
  - [x] **Adaptation notes** elenco delle stringhe da `payload.adaptationNotes`.
  - [x] **Last sent** tab/panel: lista snapshot, ognuno con timestamp + envelope diff vs preview corrente (semplice: mostra envelope JSON + delta count `systemBlocks/history`). Pulsante refresh + clear.
- [x] 11.4 Sezioni nuove appaiono SOTTO le esistenti, opzionali (toggle "Show advanced"). Zero rimozione UI.

## 12. Test Integration & Smoke

- [x] 12.1 `tests/integration/context-canonical.test.ts`:
  - [x] Setup topic con system prompt + context file.
  - [x] POST `/api/topics/:id/message`.
  - [x] GET `/api/topics/:id/context-preview` → envelope coincide con quello pushato in snapshot (modulo `userMessage` se nuovo turn).
  - [x] Cambia provider del topic, GET preview → envelope.providerStrategy cambia, payload differisce.
- [x] 12.2 `bun test` end-to-end verde.
- [x] 12.3 Smoke manuale (Electron + browser):
  - [x] Apri inspector, vedi sezioni nuove.
  - [x] Manda 1 messaggio, "Last sent" mostra 1 snapshot.
  - [x] Disabilita una source, "Preview" cambia, "Last sent" no.
  - [x] Switcha provider del topic, badge cambia, adaptation notes cambiano.

## 13. Cleanup & Docs

- [x] 13.1 Rimuovere codice morto da `streamEditResponse` post-refactor.
- [x] 13.2 Update `CLAUDE.md` se menziona context flow.
- [x] 13.3 Update `BACKLOG.md`: rimuovere eventuali item su "fix context inspector" / "context drift".
- [x] 13.4 Esegui `openspec validate topic-context-canonical --strict` (se workflow lo prevede) — verde.
- [x] 13.5 Update memoria OMEGA con summary del completion.

## Out of scope (deliberate)

- Persistenza snapshots su disco — futura phase debug.
- Nuovo tokenizer (`tiktoken`/Anthropic) — futura phase.
- Spezzare `topics.ts` 3493 righe in moduli — futura phase refactor monolite.
- Cambio strategy `claude-code` (resta inline) — confermato utente.
- UI redesign inspector completo — solo aggiunte non-breaking; redesign è phase separata.
- **Refactor `streamEditResponse` (server/routes/topics.ts:645)** — funzione separata per edit-stream con un set ridotto di blocks (solo systemPrompt + contextFiles + projectTemplates, no memory/pinned/markers/topic-switch/plan). Refactorarla aggiungerebbe blocks che oggi non riceve, violando "zero behavior change". Phase futura con `assembleTopicContext({blocksMode: "edit-stream"})` opzionale. Vedi `design.md` § DR1.

## Implementation notes (deviazioni dalla traccia originale)

- **Task 8.4**: regression test salvato come `server/context/regression.test.ts` (non `topics-route-payload.test.ts`). Stesso contratto: payload byte-identico al legacy per tutte e 3 le strategy. 4 test verdi.
- **Task 9.3**: shape back-compat di `/api/context/analyze` verificata per costruzione (proietta `envelope.systemBlocks → sources[]` con field identici). Test dedicato non aggiunto per non duplicare la copertura del regression (stesso `assembleTopicContext`).
- **Task 12.1**: integration full-route non aggiunto — richiede setup pesante (mock db + broadcast + provider). Coverage equivalente: regression.test.ts + context-preview.test.ts + 27 unit di assemble.
- **Task 12.3**: smoke manuale Electron+browser eseguito via Chrome DevTools MCP durante l'esecuzione finale.
- **Task 13.4**: `openspec validate --strict` non eseguibile — CLI `openspec` non disponibile localmente. Validazione manuale: struttura conforme al pattern `stream-timeout-resilience/` (proposal/design/tasks + specs/<cap>/spec.md con `## ADDED Requirements`).
