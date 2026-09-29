# Design: live-tool-output-tail

Solo le scelte tecniche; quelle che cambiano cosa vedi stanno nel blocco
«Da decidere» di `proposal.md`.

## 1. Un evento che c'è già, a sostituzione

`stream:tool_update` esiste (`shared/ws-outbound.ts:591`, `looseObject`), ha già
il coalescing a frame sul client (`useChat.ts:1175-1230`) e tre provider che lo
emettono. La semantica è **sostituisci `result`**, e resta: il nativo manda la
coda intera ogni volta. Un `stream:tool_output_delta` ad append avrebbe bisogno
di un buffer nuovo, e nella finestra mittente (che riceve WS + SSE) un delta
ricevuto due volte si raddoppia: è proprio ciò che `senderAlsoSees.ts` vieta.

## 2. Il buffer della coda è separato da `out`

`out` si tronca mentre arriva (`tools.ts:285`, fino a 60 000 caratteri) perché
il modello riceve testa e coda tagliate più avanti (`clipToolResult`,
`agent-loop.ts`). La coda viva vuole invece gli **ultimi** byte: un secondo
buffer circolare di 16 KB in `cap`, che dopo ogni aggiunta scarta la testa
eccedente. Costo di memoria fisso per comando, indipendente dall'output.

## 3. Throttle a 250 ms, e niente dopo `chiudi`

Un `npm install` produce centinaia di chunk al secondo; ogni `onToolUpdate`
diventa un frame WS verso ogni finestra che guarda il topic e un
`resetStreamTimer()` (`chat.ts:2766`). 250 ms (4 frame/s) è sotto la soglia
percettiva di CHAT-TOOL-03 e tiene il carico trascurabile. L'ultima chiamata in
coda si annulla in `chiudi` (`tools.ts:298`, accanto a `clearTimeout(timer)`):
dopo l'esito un parziale sarebbe solo testo vecchio.

`onOutput` si chiama dentro `try/catch`: è una gentilezza verso chi guarda, e
non può rompere il comando dell'agente.

## 4. Il client: taglio puro, resa nella `ShellCard`

- Funzione pura `liveShellTail(result, maxLines = 8)` → `{ lines, hiddenAbove }`.
  Spezza su `\n`, per ogni riga tiene il segmento dopo l'ultimo `\r`, scarta la
  riga vuota finale, prende le ultime `maxLines`.
- Dove innestarla: `ToolCallRow` passa a `ToolCardBody` il `detail` da
  `resolveToolDetail` (`ToolCallRow.tsx:169`) e `isRunning`
  (`ToolCallRow.tsx:174`). La `ShellCard` riceve un `liveResult?: string`
  valorizzato solo quando `isRunning && !detail.output`; non si tocca
  `resolveToolDetail`, che resta la verità per le righe chiuse.
- Nessun conteggio nell'avviso: il server nativo manda al massimo 16 KB, quindi
  il client non sa quante righe ci sono sopra. Per codex (cumulato intero) lo
  saprebbe, ma due comportamenti per lo stesso avviso non valgono la riga.

## 5. Finestra mittente: WS più guardia di stato

Alternativa scartata: mandare il parziale anche sull'SSE (`writeSSE` in
`chat.ts:2765`). Richiede un nuovo tipo di delta nel parser SSE del client, e il
problema d'ordine con `tool_result` non sparisce, si sposta. La via scelta:
`stream:tool_update` in `SENDER_ALSO_SEES`, e `flushToolUpdates`
(`useChat.ts:1210`) scrive `result` solo se la riga è `pending`/`running`. La
guardia non è un caso teorico: nella finestra mittente esito (SSE) e parziale
(WS) viaggiano su due canali senza ordine reciproco.
