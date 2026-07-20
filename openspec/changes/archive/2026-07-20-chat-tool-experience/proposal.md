## Why

Le tool call nella chat di Topics oggi hanno tre problemi di esperienza, verificati sul
codice:

1. **Il pannello live dura troppo poco (non è sincronizzato all'utilizzo reale).**
   Il provider Claude Code (`server/providers/claude-code.ts`) legge lo stream-json del
   CLI **senza** `--include-partial-messages`: gli eventi `assistant` sono snapshot
   cumulativi emessi a blocco completato, quindi il `tool_use` viene annunciato solo
   DOPO che il modello ha finito di scrivere l'input del tool. La finestra `running`
   visibile in UI copre solo l'esecuzione (per un Read: millisecondi), non il tempo in
   cui il modello sta generando l'input (per un Edit grosso: 10-30s). Risultato: il body
   auto-aperto di `ToolCallRow` (che si apre su `isRunning` e si chiude su `success`)
   lampeggia — flash open/close per i tool veloci, invisibilità per la fase più lunga.

2. **Una riga per tool call non scala.** Un turno agentico produce 10-30 call: la chat
   diventa un muro di righe. Gli altri aggregano: claude.ai/Desktop collassa le call
   consecutive in un blocco espandibile; Cursor mostra sintesi con conteggi ("Read 5
   files"); Claude Code CLI collassa i risultati per-riga. Il pattern giusto per Topics:
   sintesi con conteggi caldi ("cosa è stato fatto e quante volte") + drill-down al
   click. Il punto di aggancio esiste già: `MessageContent.tsx` raggruppa i tool block
   consecutivi (`kind: 'tools'`), oggi renderizzati come stack piatto di `ToolCallRow`.

3. **Il codice nei body dei tool è testo piatto.** `ToolCards.tsx` renderizza tutto in
   `<pre>` grezzo ("No fancy syntax highlighting yet — that's a future polish"), mentre
   l'app ha già l'infrastruttura: `highlightCode`/hljs lazy (`lib/syntaxHighlight.ts`,
   pattern CodeBlock con `subscribeHighlighter`). Un Read di un .ts e il codice in un
   fence markdown della stessa chat oggi appaiono con due qualità diverse.

## What Changes

1. **Sync del running-state all'utilizzo reale (transport).** Il provider claude-code
   SHALL passare `--include-partial-messages` al CLI e gestire gli eventi
   `stream_event`: `content_block_start` di tipo `tool_use` → `onToolStart` immediato
   (nome noto, args parziali); `input_json_delta` → accumulo dell'input;
   `content_block_stop` / snapshot assistant → update degli args completi (upsert per
   id, il client già merge-a `stream:tool_call` per id). La finestra `running` copre
   quindi generazione input + esecuzione. Il `ToolCall` SHALL portare
   `startedAt`/`endedAt` per mostrare durate reali. Gli `stream_event` con
   `parent_tool_use_id` (sidechain sub-agent) restano esclusi. La detection
   `waiting_for_input` continua a valutare gli args completi.

2. **Aggregazione ToolGroupRow.** I gruppi di tool consecutivi con ≥3 call SHALL
   collassare in una riga di sintesi con conteggi per tool (`Read ×5 · Edit ×3 · Bash
   ×4`) e durata totale, espandibile al click nelle `ToolCallRow` per-call attuali.
   Durante lo streaming il gruppo mostra la sintesi delle call completate + la call
   attiva col body aperto (un solo pannello caldo persistente, niente flash). Mai
   aggregate: `waiting_for_input` (il form deve emergere), sub-agent (il log è il
   segnale), errori (badge visibile anche a gruppo chiuso). Gruppi da 1-2 call restano
   righe singole.

3. **Anti-flash su ToolCallRow.** L'auto-open del body SHALL avere un ritardo di
   apertura (~250ms: i tool istantanei non aprono nulla) e un dwell minimo una volta
   aperto, così anche i tool sotto il secondo si leggono senza sfarfallio.

4. **Syntax highlighting nei body dei tool.** Read/Write/Edit SHALL evidenziare il
   contenuto con `highlightCode` derivando la lingua dall'estensione del file; Shell
   evidenzia il comando come bash. Stesso pattern lazy di CodeBlock
   (`subscribeHighlighter`/`highlighterReady`), stessa cap di dimensione. Il diff
   colorato dell'EditCard resta.

**Non-goal:** nessun cambio al rendering del testo/thinking (gli snapshot cumulativi
restano la fonte per text); nessun nuovo tipo di evento WS (si riusa l'upsert di
`stream:tool_call`); nessuna virtualizzazione della lista messaggi; nessun redesign dei
singoli ToolCard oltre l'highlighting.
