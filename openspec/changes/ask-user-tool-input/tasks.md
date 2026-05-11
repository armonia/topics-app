# Tasks — Ask-User Tool Input

## 1. Types & contract

- [ ] 1.1 In `server/providers/types.ts` aggiungere `UserInputRequiredEvent` allo union `StreamEvent`.
- [ ] 1.2 In `server/providers/types.ts` aggiungere `resumeWithToolResponse?` a `AIProvider` + type `ToolUserResponse`.
- [ ] 1.3 In `client/src/types/index.ts` aggiungere `"waiting_for_input"` a `ToolCall.status`, e i campi opzionali `userInputSchema?: UserInputSchema` + `userResponse?: ToolUserResponse`.
- [ ] 1.4 Modulo condiviso `shared/userInputSchema.ts` (o duplicazione type controllata in client + server) per la shape di `UserInputSchema`.

## 2. Detector

- [ ] 2.1 Creare `server/providers/ask-user-detector.ts` con `detectUserInputRequest(toolUse)` (vedi `design.md` per le regole).
- [ ] 2.2 Test `server/providers/ask-user-detector.test.ts` con almeno: AskUserQuestion valido, AskUserQuestion shape malformata → fallback raw, MCP elicitation, tool sconosciuto → null, tool con name simile ma senza `questions` field.

## 3. Provider: claude-code

- [ ] 3.1 In `server/providers/claude-code.ts` modificare `handleStreamEvent` (~lines 996-1141) per chiamare `detectUserInputRequest(toolUseBlock)` sui blocchi `tool_use`. Se risultato non-null:
  - Emettere `ToolStartEvent` con `status: "waiting_for_input"` e `userInputSchema` popolato.
  - Emettere `UserInputRequiredEvent`.
  - Aggiungere a `pp.pendingInputs: Map<toolCallId, { sessionKey, schema, awaitingSince }>`.
- [ ] 3.2 Aggiungere `resumeWithToolResponse` come metodo dell'oggetto provider. Scrive sullo stdin tramite la serial queue esistente (linee ~444, 526). Rimuove da `pendingInputs`. Aggiorna `pp.lastEventAt`.
- [ ] 3.3 In `cleanupTimers`, `abort()`, e `finalizeStream` rimuovere tutte le voci di `pendingInputs` del sessionKey.
- [ ] 3.4 Heartbeat e soft-timer (cfr. `stream-timeout-resilience`): trattare un tool in `waiting_for_input` come un tool `running` ai fini della sospensione del timer.
- [ ] 3.5 Test `server/providers/claude-code-replay.test.ts` esteso: replay di una stream-json fixture che contiene AskUserQuestion → verifica che lo stato sia `waiting_for_input` e che `pendingInputs` sia popolato.

## 4. Route handler

- [ ] 4.1 Creare `server/routes/tool-response.ts` con `POST /api/chat/tool-response`. Validazione: 400 se manca un campo, 404 se nessun tool pending matcha, 503 se il provider non ha `resumeWithToolResponse`.
- [ ] 4.2 Su successo: persiste `toolCall.userResponse = { submittedAt, value }` nel `tool_calls` del messaggio assistente attivo (loadActiveThread → mutate → saveLocalMessages), aggiorna `status = "running"`, broadcast `stream:tool_update`.
- [ ] 4.3 Wire del router in `server/routes/topics.ts` (o entrypoint server).
- [ ] 4.4 Test `server/routes/tool-response.test.ts`: caso ok, 404 su tool inesistente, 404 su tool già consumato (doppio submit), 503 su provider senza resume, persistenza del `userResponse` verificata leggendo la DB.

## 5. Client: state + API

- [ ] 5.1 In `client/src/lib/api.ts` aggiungere `chatApi.toolResponse(sessionKey, toolCallId, response)` (POST /api/chat/tool-response). Su 404 → propaga errore strutturato.
- [ ] 5.2 In `client/src/hooks/useChat.ts` aggiungere handler WS per `stream:tool_user_input_required` (popola `userInputSchema` + `status` sul tool call appropriato) e `stream:tool_update` (transitions ricevute dal server).
- [ ] 5.3 Update logic del `ToolCall` esistente in `useChat.ts` per non sovrascrivere `status: "waiting_for_input"` quando arrivano `tool_update` parziali che non riguardano lo status.

## 6. Client: UI

- [ ] 6.1 Creare `client/src/components/Chat/ToolInputForm.tsx`. Renderizza in base a `schema.kind`:
  - `questions`: una `<fieldset>` per ogni domanda. Radio per opzioni; "Other" sempre disponibile come opzione finale con textarea inline. Multi-select se `multiSelect: true`.
  - `elicitation`: form generato. Subset JSON Schema supportato: type=string, number, boolean, enum, array di string (chip input). Required fields obbligatori. Per shape complesse, fallback a textarea con JSON.
  - `raw`: textarea singola.
- [ ] 6.2 Bottone "Invia": chiama `chatApi.toolResponse`. Disabled in volo, errore inline su rejection. Su successo: niente reset locale (il WS broadcast aggiornerà lo stato del tool).
- [ ] 6.3 In `client/src/components/Chat/ToolCallRow.tsx`, quando `status === "waiting_for_input"`:
  - Auto-expand la riga.
  - Renderizza `<ToolInputForm>` invece dello spinner.
  - Aggiungere mini-banner "L'agente attende la tua risposta".
- [ ] 6.4 Quando `status === "running"` AND `userResponse` presente: mostrare un summary collassato della risposta inviata invece del form.
- [ ] 6.5 Test `client/src/components/Chat/ToolInputForm.test.tsx`: render delle tre shape, submission, errore di rete, disabled state.

## 7. Server-side: WS broadcast

- [ ] 7.1 In `server/routes/topics.ts`, nel listener provider stream, aggiungere caso `tool_user_input_required` → `broadcastToTopic({ type: "stream:tool_user_input_required", sessionKey, toolCallId, schema })`.
- [ ] 7.2 Verificare che `broadcastToTopic` (non `broadcastToAll`) sia corretto: solo i client che hanno focus su quel topic devono ricevere il form. Altrimenti il `loadHistory` su altri tab vedrà comunque il tool nello stato corretto.

## 8. Persistence shape

- [ ] 8.1 Confermare che `tool_calls` JSON blob accetta `userInputSchema` + `userResponse` senza migrazione (è già un blob opzionale). Aggiungere un test di round-trip `loadLocalMessages` → `saveLocalMessages` → riload, che verifica che i due campi sopravvivono.
- [ ] 8.2 Aggiornare `server/utils.ts:loadLocalMessages` / `saveLocalMessages` solo se serve parsing strict (probabilmente no — il blob è opaco).

## 9. E2E (Playwright)

- [ ] 9.1 Test `tests/e2e/ask-user-tool.spec.ts`: mock provider (fake claude-code che emette AskUserQuestion al primo turn) → utente apre topic → vede form → invia risposta → vede tool transition + assistant resume.
- [ ] 9.2 Test "refresh durante pending": durante il `waiting_for_input` ricaricare la pagina → form ricompare → submit → ok.
- [ ] 9.3 Test "stop globale durante pending": click Stop → form scompare, partial finalizzato, no wipe.

## 10. Documentation

- [ ] 10.1 Aggiornare `openspec/specs/chat/spec.md` con il delta (vedi `specs/chat/spec.md` di questa change).
- [ ] 10.2 Creare/aggiornare `openspec/specs/tools/spec.md` (nuova capability) con il rendering di `waiting_for_input` e le tre shape.
- [ ] 10.3 README/MEMORY entry breve: come testare manualmente AskUserQuestion (es. system prompt che chiede al modello di "use AskUserQuestion to confirm").

## Out of scope (deliberate)

- Permission/approval prompts per tool distruttivi — change separato.
- MCP elicitation server-side beyond detection — implementiamo quando agganceremo un MCP che ne emette.
- Auto-timeout della risposta utente — l'utente può sempre cliccare Stop.
- Persistenza del pending state cross-restart server — out of scope, documentato.
