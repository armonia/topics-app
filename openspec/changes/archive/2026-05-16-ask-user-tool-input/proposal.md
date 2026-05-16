# Proposal — Ask-User Tool Input

## Why

Quando un agente di un topic emette un tool call che richiede una risposta umana — ad oggi i due casi reali sono `AskUserQuestion` del Claude Agent SDK e `elicitation/create` di MCP — la nostra UI lo mostra come spinner che **non termina mai**:

- `server/providers/claude-code.ts` (lines ~996-1141) processa il `tool_use` block e emette un `ToolStartEvent` con `status: "running"`. Per qualunque altro tool il provider attende il `tool_result` autogenerato dal CLI/MCP e finalizza con `ToolResultEvent`. Per `AskUserQuestion` quel risultato **non arriverà mai**, perché il CLI sta aspettando un `tool_result` da noi — che noi non sappiamo costruire perché abbiamo solo lo spinner.
- `server/providers/types.ts` (lines 74-125) non ha un evento "user input required". `ToolCall.status` (definito in `client/src/types/index.ts:139`) ammette solo `pending | running | success | error` — nessuno stato che dica "sto aspettando l'umano".
- `client/src/components/Chat/ToolCallRow.tsx` e `ToolCards.tsx` renderizzano solo lo stato visivo. Non c'è form, non c'è dispatcher per inviare risposte, non c'è un endpoint server `/api/chat/tool-response`.

Risultato osservabile: l'utente clicca su un agent che pone una domanda → spinner infinito → unico recupero è killare il turn (`POST /api/chat/abort`), che con il bug recentemente fissato non distrugge più la cronologia ma butta comunque a mare la risposta del modello.

Il problema non è una bug puntuale, è **feature mancante end-to-end**: serve un canale di "input umano in-band" che il provider sa propagare, il client sa renderizzare, e il server sa reiniettare nello stream del CLI/MCP per far ripartire il turn.

## What Changes

### 1. Tool status `waiting_for_input` (`chat` capability)

- `ToolCall.status` cresce di un valore: `"pending" | "running" | "waiting_for_input" | "success" | "error"`.
- Quando un tool entra in `waiting_for_input` la UI espande automaticamente il `ToolCallRow` e mostra un form invece dello spinner. Il bottone "Stop" globale **rimane** disponibile come escape hatch.

### 2. Stream event `UserInputRequiredEvent` (provider boundary)

- Aggiunta a `StreamEvent` un caso `UserInputRequiredEvent { type: "tool_user_input_required"; toolCallId; toolName; schema; }`.
- `schema` è una shape strutturata: per `AskUserQuestion` è `{ kind: "questions"; questions: AskUserQuestionItem[] }`; per MCP elicitation è `{ kind: "elicitation"; requestedSchema: JSONSchema; }`; per tool generici sconosciuti è `{ kind: "raw"; rawInput: unknown }` (fallback testo libero).
- Il provider è l'unico responsabile di tradurre l'input del tool nel formato `schema`. Né il route handler né il client devono toccare la shape grezza del CLI.

### 3. Provider hook `resumeWithToolResponse(toolCallId, response)` 

- Aggiunto a `AIProvider` un metodo `resumeWithToolResponse?` opzionale. Le implementazioni:
  - `claude-code`: scrive sulla pipe stdin del subprocess un line JSON `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"…","content":"…"}]}}` usando lo stream-json input format già attivo (vedi `claude-code.ts:785-786`). Restart non necessario: lo stream del CLI riparte da solo perché era in attesa di tool_result.
  - `mcp` (futuro): traduce in `elicitation/result`.
  - Provider che non supportano input umano dichiarano `resumeWithToolResponse: undefined` → il tool non viene mai messo in `waiting_for_input` da quel provider.
- Il provider sospende il proprio timer di inattività finché il tool è in `waiting_for_input` (stessa logica già usata per i tool in `running`, vedi `stream-timeout-resilience`).

### 4. Endpoint `POST /api/chat/tool-response`

- Body: `{ sessionKey, toolCallId, response }` dove `response` è la shape concordata con il provider (testo, oggetto JSON per schema, opzioni selezionate per `AskUserQuestion`).
- Il handler valida che esista un tool in `waiting_for_input` per quel `sessionKey`/`toolCallId`, persiste la risposta (timestamp + payload) nel `tool_calls` JSON del messaggio assistente, chiama `provider.resumeWithToolResponse`, transiziona lo stato a `running` e ribroadcasta `stream:tool_update`.
- Su tool sconosciuto / sessione senza tool pending → 404 con `{ error: "no pending tool input" }`.

### 5. UI: `ToolInputForm`

- Nuovo componente `client/src/components/Chat/ToolInputForm.tsx`. Renderizza tre forme:
  - **questions** (`AskUserQuestion`): per ogni domanda, radio con le opzioni + textarea "Altro" se l'opzione "Other" è abilitata (sempre presente). Multi-select gestito se `multiSelect: true`.
  - **elicitation**: form generato da `requestedSchema` (subset di JSON Schema: string, number, enum, boolean, object di proprietà piatte). Validazione client.
  - **raw**: textarea libera.
- Bottone "Invia" → `chatApi.toolResponse(sessionKey, toolCallId, payload)`.
- Mentre la richiesta è in volo: bottone disabilitato + mini-spinner. Su errore: errore inline, form ancora editabile.

### 6. Persistenza

- Le risposte umane diventano parte del `tool_calls` array del messaggio assistente, in un campo `userResponse: { submittedAt, value }`. Servono per il context envelope futuro (l'agente vede la risposta nello scrollback), per il replay (`claude-code-replay.test.ts`-style), e per audit.
- Nessuna nuova tabella: il blob JSON di `messages.tool_calls` già esiste e accetta campi opzionali.

## Impact

### Capability impactate

- **`chat`** — nuovi requirement: tool input pending, stream event, endpoint /tool-response, persistenza risposte.
- **`tools`** (nuova specs/tools/spec.md, perché il dominio "tool calls" merita una capability dedicata) — requirement sul rendering di `waiting_for_input` e sui form per le tre shapes.

### File toccati

**Nuovi (server)**
- `server/routes/tool-response.ts` — handler `POST /api/chat/tool-response`.
- `server/providers/ask-user-detector.ts` — funzioni `detectUserInputRequest(toolUse)` che riconosce `AskUserQuestion` / MCP elicitation / fallback raw.
- Test: `server/providers/ask-user-detector.test.ts`, `server/routes/tool-response.test.ts`.

**Modificati (server)**
- `server/providers/types.ts` — `StreamEvent` cresce di `UserInputRequiredEvent`; `AIProvider` di `resumeWithToolResponse?`.
- `server/providers/claude-code.ts` — `handleStreamEvent` (linee ~996-1141) chiama `detectUserInputRequest` sui `tool_use` blocks. Aggiunto `resumeWithToolResponse` che scrive sullo stdin in stream-json input format. Heartbeat/timer trattano `waiting_for_input` come `running` (no soft timeout).
- `server/routes/topics.ts` — wire del nuovo route handler. Propaga `tool_user_input_required` come WS broadcast.

**Nuovi (client)**
- `client/src/components/Chat/ToolInputForm.tsx` — form runtime con tre shape (questions, elicitation, raw).
- Test: `client/src/components/Chat/ToolInputForm.test.tsx`.

**Modificati (client)**
- `client/src/types/index.ts` — `ToolCall.status` cresce di `"waiting_for_input"`; `ToolCall.userInputSchema?` (la stessa shape del server) e `ToolCall.userResponse?`.
- `client/src/components/Chat/ToolCallRow.tsx` — quando `status === "waiting_for_input"` apre l'expanded view e renderizza `<ToolInputForm>`.
- `client/src/lib/api.ts` — `chatApi.toolResponse(sessionKey, toolCallId, payload)`.
- `client/src/hooks/useChat.ts` — handler WS per `tool_user_input_required` aggiorna lo stato del tool nel messaggio appropriato.

### Out of scope (deliberate)

- **Permission prompts** (es. "esegui questo bash?" stile Cursor) — sembra simile ma è un flow di approval, non un input strutturato. Pianificato come change separato.
- **MCP elicitation server-side**: questa change definisce il client-side e i tipi, ma l'integrazione concreta con un MCP server che usa `elicitation/create` segue quando agganceremo il primo MCP che lo emette.
- **Persistenza cross-restart del `waiting_for_input`**: se il server si riavvia mentre un tool è in attesa, il subprocess CLI muore e il turn va perso. Acceptable nel breve; un follow-up potrebbe persistere lo stato e ricostruirlo on resume.
- **Auto-timeout della risposta utente**: non scade. L'utente può sempre cliccare Stop globale per abortire.
