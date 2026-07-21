# Design — chat-tool-experience

## 1. Transport: `--include-partial-messages`

### Wire format (CLI ≥ 2.x, `--output-format stream-json`)

Con il flag, il CLI emette righe `stream_event` in aggiunta agli snapshot `assistant`:

```
{ type:"stream_event", event:{ type:"content_block_start", index:N,
    content_block:{ type:"tool_use", id:"toolu_…", name:"Edit", input:{} } }, … }
{ type:"stream_event", event:{ type:"content_block_delta", index:N,
    delta:{ type:"input_json_delta", partial_json:"{\"file_p" } }, … }
{ type:"stream_event", event:{ type:"content_block_stop", index:N }, … }
```

Gli snapshot `assistant` cumulativi restano invariati e restano la fonte di verità per
text/thinking (non tocchiamo quel path: niente doppio conteggio del testo).

### Integrazione in `handleCLIEvent` (claude-code.ts)

Nuovo ramo `type === "stream_event"`, PRIMA del ramo assistant/user:

- Scarta eventi con `parent_tool_use_id` (sidechain → già gestita dai suoi snapshot).
- `content_block_start` con `content_block.type === "tool_use"`:
  - registra in `pp.streamingToolInputs: Map<index, { id, name, buf }>`;
  - `pp.activeToolCalls.add(id)` + `handler.onToolStart(id, name, {})` → il route
    handler crea il ToolCall `running` con `startedAt: Date.now()` e broadcast.
- `content_block_delta` con `delta.type === "input_json_delta"`: accumula
  `partial_json` nel buffer. Nessun parse per-delta (costoso e quasi sempre JSON
  troncato): il live-preview degli args arriva al block_stop.
- `content_block_stop`: prova `JSON.parse(buf)`; se ok → `handler.onToolArgsUpdate(id,
  args)` (nuovo callback opzionale) e rimuove l'entry. Il route handler aggiorna il
  ToolCall persistito (`updateToolCallFields`) e ri-broadcast `stream:tool_call` con
  gli args completi — il client fa già upsert per id (`addToolCallToLastMessage`,
  useChat.ts). Qui gira anche `detectUserInputRequest` (serve l'input completo).

### Dedup con gli snapshot assistant

`pp.activeToolCalls` già impedisce il re-announce. Il loop degli snapshot viene esteso:
per un `tool_use` GIÀ annunciato (presente in `activeToolCalls`), invece di `continue`
secco esegue il path "late-args" (stesso `onToolArgsUpdate` + `detectUserInputRequest`,
idempotente — serve quando il parse del buffer fallisce o il CLI non emette il
block_stop). Guardia `pp.argsFinalized: Set<id>` per non ripetere il lavoro a ogni
snapshot cumulativo.

Se il CLI installato NON supporta il flag o non emette `stream_event`, nulla cambia:
il path snapshot resta completo e auto-sufficiente (fallback naturale).

### Timestamp

`ToolCall.startedAt?: number` (epoch ms, stampato dal route handler in `onToolStart`)
e `endedAt?: number` (in `onToolResult`/finalize). Vanno su: `shared/types.ts` (se il
tipo vive lì), `server` StoredMessage blob (già passa dal serialize del ToolCall),
`client/src/types/index.ts`. La UI mostra `endedAt-startedAt` (formato `1.2s`/`12s`/
`1m 05s`) sulla riga e la somma sul gruppo.

## 2. Client: ToolGroupRow

Nuovo componente `client/src/components/Chat/ToolGroupRow.tsx` + helper puro
`client/src/components/Chat/toolGrouping.ts` (unit-testato con bun:test).

### Helper `partitionToolGroup(tools: ToolCall[])`

Ritorna segmenti ordinati: `{ kind:'aggregate', tools }` per le run di call
"aggregabili" e `{ kind:'solo', tool }` per quelle che non si aggregano mai:
- `status === 'waiting_for_input'` (il form è il segnale)
- `detail.type === 'sub_agent'` (log auto-aperto)
Le call in errore RESTANO nell'aggregato ma la sintesi espone il conteggio errori
(badge rosso) — un errore non deve sparire a gruppo chiuso.

`summarizeToolGroup(tools)` → `{ counts: Array<{name,count}>, total, errors,
running, durationMs? }` usando `buildToolDisplayLabel(resolveToolDetail(tc)).name`
per i nomi canonici (Read/Edit/Shell/…), ordinati per count desc.

### Rendering (MessageContent, gruppi `kind:'tools'`)

- `< GROUP_MIN (3)` call aggregabili → rendering attuale (stack di ToolCallRow).
- Altrimenti `<ToolGroupRow>`:
  - **Live** (≥1 call `pending|running` nel gruppo): header di sintesi (conteggi
    aggiornati in tempo reale, spinner) + SOLO le call attive renderizzate come
    ToolCallRow (body auto-aperto). Le completate vivono nella sintesi. Il container
    resta montato mentre le call si succedono → un unico pannello caldo, zero flash.
  - **Settled**: una riga collassata `⚡ N azioni · Read ×5 · Edit ×3 · 41s [·✗ K]`;
    click → espande lo stack di ToolCallRow classiche. Stato locale come
    ReasoningRow (default collapsed).
- I segmenti `solo` si renderizzano come oggi, interrompendo l'aggregato.

### Anti-flash ToolCallRow

`effectiveOpen` per `isRunning` diventa gated da un timer: apre solo se il running
dura > 250ms (`useEffect` + `setTimeout`), e una volta aperto resta aperto almeno
1500ms anche se il tool finisce prima (chiusura posticipata). I toggle utente vincono
sempre (`userToggled` invariato).

## 3. Highlighting nei ToolCards

`langFromPath(filePath)` in `lib/syntaxHighlight.ts` (estensione → fence lang,
riusa `LANG_ALIASES`). Componente condiviso in ToolCards:

```tsx
function HighlightedPre({ code, lang, className }) {
  const ready = useSyncExternalStore(subscribeHighlighter, highlighterReady);
  const html = useMemo(() => highlightCode(code, lang), [code, lang, ready]);
  return html
    ? <pre className={className}><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
    : <pre className={className}>{code}</pre>;
}
```

Usato da: ReadCard (content, lang da filePath), WriteCard (content, lang da
filePath), ShellCard (comando come `bash`; l'output resta piatto — è output di
runtime, non codice), EditCard before/after (lang da filePath; il ramo unifiedDiff
mantiene la colorazione diff esistente). Il tema scuro dei token hljs è già gestito
dal CSS esistente dei code block (classi `hljs-*`); i card usano lo stesso wrapper
`font-mono text-[11px]` di oggi. Cap `MAX_HIGHLIGHT_CHARS` già nel facade.

## 4. Test

- `toolGrouping.test.ts` (bun:test): partition (solo vs aggregate), summarize
  (conteggi, errori, running, durata), soglia GROUP_MIN.
- E2E `tool-call-ui.spec.ts` / `tool-call-rendering.spec.ts` estesi: gruppo ≥3 call
  → sintesi collassata con conteggi, expand al click mostra le row; call in errore →
  badge sulla sintesi; highlighting: Read di un .ts mostra token hljs
  (`.hljs-keyword` presente nel body espanso).
- Provider: unit sul parse degli stream_event (fixture NDJSON) se esiste già un
  harness per claude-code.ts; altrimenti la copertura passa dagli E2E mocked-SSE
  (che testano il contratto route→client, invariato).
