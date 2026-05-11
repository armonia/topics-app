# Design — Ask-User Tool Input

## Goals

1. Quando il modello chiama `AskUserQuestion` (o un MCP elicitation), l'utente vede un **form interattivo** nello stesso `ToolCallRow` invece di uno spinner che non termina.
2. La risposta viene re-iniettata nel subprocess del provider come `tool_result`, e il turn riprende **senza nuovo round-trip al modello**: lo stream esistente continua nel punto in cui si era fermato.
3. Il design vale anche per i tool che non riconosciamo: fallback `raw` con textarea libera.
4. Zero impatto sui provider che non lo supportano: il path resta identico a oggi.

## Non-Goals

- Permission prompts (approvazione di azioni distruttive) — diversi semanticamente, change separato.
- UI di "domanda dall'utente verso il modello" (chat normale) — già esiste, non c'entra.
- Riavviare il subprocess su risposta: deve riprendere lo stream esistente.
- Validazione semantica forte di `requestedSchema` MCP: subset minimo, fallback a textarea.

## Flusso end-to-end (caso Claude Code + AskUserQuestion)

```
   User chat → topics-app server → claude CLI stdin (stream-json input)
                                  ↓ tool_use block, name="AskUserQuestion"
   ┌─────────────────────────────┘
   ▼
   server/providers/claude-code.ts: handleStreamEvent()
     • detectUserInputRequest(toolUse) → { kind: "questions", questions: [...] }
     • emit ToolStartEvent { status: "waiting_for_input", schema }
     • emit UserInputRequiredEvent { toolCallId, toolName, schema }
     • pp.pendingInputs.set(toolCallId, { resolve: …, sessionKey })
     • timer inattività NON armato finché toolCallId è in pendingInputs
   ▼
   server/routes/topics.ts broadcasta WS:
     { type: "stream:tool_user_input_required", sessionKey, toolCallId, schema }
   ▼
   client/src/hooks/useChat.ts onWSMessage:
     • aggiorna messages[sessionKey].toolCalls[idx].status = "waiting_for_input"
     • aggiorna messages[sessionKey].toolCalls[idx].userInputSchema = schema
   ▼
   client/src/components/Chat/ToolCallRow.tsx:
     • status === "waiting_for_input" → renderizza <ToolInputForm schema={...} onSubmit={...} />
   ▼
   User compila e clicca Invia
     → chatApi.toolResponse(sessionKey, toolCallId, payload)
     → POST /api/chat/tool-response
   ▼
   server/routes/tool-response.ts:
     • valida sessionKey + toolCallId esiste in pp.pendingInputs
     • persiste toolCall.userResponse nel DB (loadActiveThread + saveLocalMessages)
     • chiama provider.resumeWithToolResponse(toolCallId, payload)
       └─ claude-code: scrive su stdin:
          {"type":"user","message":{"role":"user","content":[
            {"type":"tool_result","tool_use_id":"toolCallId","content": serialize(payload)}
          ]}}
     • aggiorna toolCall.status = "running"
     • broadcastToAll({ type: "stream:tool_update", toolCallId, status: "running" })
     • return 200 { ok: true }
   ▼
   claude CLI riceve il tool_result, continua a streamare il turn, eventualmente
   emette ToolResultEvent finale per quel toolCallId (l'evento "result" interno
   del CLI per AskUserQuestion arriva immediatamente perché abbiamo già fornito
   il payload — questo è il normale comportamento del SDK).
```

## Shape del payload sullo stream-json di claude-code

Lo stream-json input format del CLI accetta `{"type":"user", "message":{...}}` per qualunque turn user, incluso un tool_result. Il blocco `tool_result` rispetta la shape del SDK Anthropic:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_abc123",
        "content": [{"type": "text", "text": "<serialized answer>"}],
        "is_error": false
      }
    ]
  }
}
```

`serialize(payload)` per i tre kind:

- `questions`: oggetto `{"answers": {"<question text>": "<selected label or free text>"}, "metadata"?: {...}}` — JSON-stringified come `content[0].text`. Stessa shape che il SDK Claude Code restituisce quando AskUserQuestion gira nella UI ufficiale, così il modello vede esattamente quel formato.
- `elicitation`: oggetto JSON conforme a `requestedSchema`, stringified.
- `raw`: la stringa così com'è (no JSON wrapping).

## Provider strategy

Aggiunta a `AIProvider`:

```ts
interface AIProvider {
  // … esistente …
  /**
   * Ri-inietta la risposta umana al tool pending per il sessionKey indicato.
   * Implementato solo dai provider che supportano user input in-band.
   * Provider senza supporto NON devono dichiararlo: ask-user-detector
   * controllerà la presenza prima di mettere un tool in waiting_for_input.
   */
  resumeWithToolResponse?(
    sessionKey: string,
    toolCallId: string,
    response: ToolUserResponse
  ): Promise<void>;
}

type ToolUserResponse =
  | { kind: "questions"; answers: Record<string, string>; metadata?: Record<string, unknown> }
  | { kind: "elicitation"; value: unknown }
  | { kind: "raw"; text: string };
```

`claude-code` implementa scrivendo sullo stdin del subprocess sotto serial queue (già presente, vedi `claude-code.ts:444`). Tutti gli altri provider attualmente in repo (`claude`, `openai`, `codex`, `openclaw`) **non** lo implementano in questa change: nessuno di loro emette tool_use con AskUserQuestion oggi (è specifico del Claude Agent SDK).

## Detector

`server/providers/ask-user-detector.ts`:

```ts
export type UserInputSchema =
  | { kind: "questions"; questions: AskUserQuestionItem[] }
  | { kind: "elicitation"; requestedSchema: JSONSchema; message?: string }
  | { kind: "raw"; rawInput: unknown };

export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export function detectUserInputRequest(toolUse: {
  name: string;
  input: unknown;
}): UserInputSchema | null;
```

Regole di detection:

1. `toolUse.name === "AskUserQuestion"` AND `input.questions` è array → `{ kind: "questions", questions }`. Sanity check per ogni item: `question` string non vuota, `options` array di ≥2 e ≤4 entries con `label`. Se shape sospetta, fallback a `raw`.
2. `toolUse.name` matcha `^mcp__.+__(elicitation|elicit|prompt)` AND `input.requestedSchema` esiste → `{ kind: "elicitation", requestedSchema, message: input.message }`.
3. Altrimenti → `null` (il tool non richiede input umano, percorso normale).

Il punto chiave: il detector restituisce `null` per tutti i tool che non riconosce. Nessun rischio di intercettare per errore un tool normale.

## Edge cases

- **Stop globale mentre il tool è pending**: `POST /api/chat/abort` esistente continua a funzionare. Il provider deve, durante l'abort path, scaricare `pendingInputs.delete(toolCallId)` e il client deve nascondere il form (lo fa già finalizzando il messaggio). Aggiungere a `claude-code.ts:abort()` un loop su `pendingInputs` del sessionKey.
- **Refresh client mentre il tool è pending**: il server sa che c'è un tool pending (`pp.pendingInputs` in-memory). Quando il client ricarica history via `GET /api/topics/:id/history`, i `tool_calls` includono `status: "waiting_for_input"` e `userInputSchema`. Il `ToolInputForm` ricompare. La submission funziona perché il provider è ancora vivo.
- **Server restart mentre il tool è pending**: il subprocess CLI muore. Out of scope per questa change. UX: al prossimo `loadHistory` il client vede un tool_call ancora in `waiting_for_input` ma il server non ha più nulla pending → il form invia ma il server risponde 404, il client transitiona a `error` con messaggio "Sessione interrotta, ritenta". Documentato nel proposal come "out of scope".
- **Doppio submit**: dopo la prima submit di successo (HTTP 200), il form scompare. Se l'utente preme due volte rapidamente, la seconda risposta riceve 404 (`pendingInputs` già consumato) e finisce nel toast.
- **Tool con shape "questions" invalida**: il modello potrebbe inviare `AskUserQuestion` con shape malformata (es. 1 sola option). Detector applica le sanity check di SDK (≥2 ≤4 options, max 4 questions): se fallisce, fallback a `{ kind: "raw", rawInput }` invece di silently ignore. Almeno l'utente vede qualcosa.

## Alternatives considered

- **Modal globale**: bocciato. Rompe il flusso visivo del topic, conflict con multiple topic aperti che pongono domande contemporaneamente, impossibilita la conversazione storica di mostrare "cosa è stato chiesto e cosa ha risposto l'utente".
- **Form sempre in fondo alla chat**: bocciato per gli stessi motivi del modal, in più rende invisibile il tool che ha generato la richiesta.
- **Polling**: bocciato. Già abbiamo WebSocket per gli altri eventi stream, riusiamo.
- **Risposta via chat input (testo libero)**: usabile come ultimo fallback ma non sostituisce le radio. La useremo come default per `raw`.
