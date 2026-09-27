# Chat — la coda viva di un comando lungo

## ADDED Requirements

### Requirement: CHAT-NTOOL-04 — Il `bash` nativo manda la coda del suo output mentre gira

Il runtime nativo SHALL rendere visibile l'output di un `bash` mentre il comando
gira, attraverso il canale che gli altri provider usano già:
`handler.onToolUpdate(toolCallId, partialResult)`, che `chat.ts:2765` trasmette
come `stream:tool_update`.

- `ToolContext` (`server/providers/native/tools.ts:38`) SHALL avere un campo
  opzionale `onOutput?: (tail: string) => void`. Assente = comportamento di oggi.
- Il caso `bash` (`tools.ts:565`) SHALL passarlo a `runCommand`. `grep`
  (`tools.ts:585`) e l'altro chiamante (`tools.ts:593`) NON SHALL passarlo.
- `agent-loop.ts:884` SHALL costruire il contesto della singola chiamata con
  `onOutput: (s) => handler.onToolUpdate?.(t.id!, s)`.
- Ogni chiamata SHALL portare la coda **intera** corrente, non il pezzo nuovo:
  il client sostituisce `result` (`useChat.ts:1210`), e con la sostituzione
  applicare tutti i frame o solo l'ultimo lascia lo stesso stato.
- La coda SHALL venire da un buffer suo, degli ultimi 16 KB, e NON da `out`:
  `out` smette di crescere a `MAX_OUTPUT_CHARS * 2` (`tools.ts:285`), e una coda
  ritagliata da lì resterebbe ferma a metà su un comando verboso. Quando il
  buffer taglia la testa, la coda SHALL cominciare dopo il primo `\n`, mai a
  metà riga.
- Le chiamate SHALL essere al massimo una ogni 250 ms, con un'ultima chiamata
  in coda per l'output arrivato dentro la finestra. Alla chiusura del comando
  (`chiudi`, `tools.ts:298`) la chiamata in coda SHALL essere annullata: l'esito
  viaggia su `onToolResult`, e nessun parziale SHALL arrivare dopo.
- Un `onOutput` che lancia SHALL essere ignorato: l'esito del tool NON SHALL
  cambiare.

#### Scenario: un comando lento si vede mentre gira
- **GIVEN** `executeTool('bash', { command: 'for i in 1 2 3; do echo L$i; sleep 0.4; done' }, { workspace, onOutput })`
- **WHEN** il comando gira
- **THEN** `onOutput` è chiamato almeno due volte prima che la promessa si risolva
- **AND** una chiamata intermedia contiene `L1` e non `L3`
- **AND** il `content` finale è identico a quello di una chiamata senza `onOutput`

#### Scenario: un comando verboso non congela la coda
- **GIVEN** `bash` con `seq 1 20000; sleep 1` (circa 109 KB, oltre il tetto di `out`)
- **WHEN** arriva una chiamata durante lo `sleep`
- **THEN** la coda termina con `20000`
- **AND** è lunga al massimo 16 KB e comincia a inizio riga

#### Scenario: niente dopo l'esito
- **GIVEN** un `bash` che stampa di continuo per 1 s e poi esce
- **WHEN** la promessa si è risolta e passano altri 500 ms
- **THEN** il numero di chiamate a `onOutput` non è cambiato
- **AND** le chiamate totali sono al massimo 5

#### Scenario: un callback rotto non rompe il tool
- **GIVEN** un `onOutput` che lancia a ogni chiamata
- **WHEN** gira `echo ok`
- **THEN** il tool risponde `ok`, senza errore

### Requirement: CHAT-TOOL-08 — La riga di un comando in corso mostra le sue ultime 8 righe

Una riga `shell` con stato `pending` o `running`, il cui `detail` tipizzato non
ha `output`, e con `tc.result` stringa non vuota, SHALL mostrare nel corpo
aperto le **ultime 8 righe** di `tc.result`, sotto il comando. Vale per ogni
provider che manda `stream:tool_update` (nativo, codex, acp, openclaw).

- Il taglio SHALL stare in una funzione pura raggiungibile da `bun:test`
  (in `client/src/components/Chat/toolDetail.ts` o accanto), che restituisce le
  righe da mostrare e se ne sono state nascoste sopra.
- Una riga ridisegnata con `\r` (le barre di avanzamento, es. `curl`) SHALL
  contare come il suo ultimo ridisegno, non come un muro di testo.
- Quando le righe sono più di 8, SHALL comparire un avviso che sopra c'è altro
  output, SENZA numero: la coda nativa è già tagliata dal server e un conteggio
  sarebbe falso. Il testo passa dall'i18n (`i18n-it.ts`, `i18n-en.ts`).
- Il blocco SHALL avere `data-testid="shell-running-tail"`, distinto da
  `shell-live-output` (la shell in background, `ToolCards.tsx:96`) e da
  `tool-call-result` (l'output finale).
- Quando la riga chiude, il corpo SHALL mostrare l'output definitivo del
  `detail` come oggi; la coda sparisce. L'apertura e la chiusura del corpo
  restano quelle di CHAT-TOOL-03.

#### Scenario: venti righe, se ne vedono otto
- **GIVEN** una riga `Bash` in `running` con `detail = { type: 'shell', command }` e `result` di 20 righe `r1…r20`
- **WHEN** si risolve cosa mostrare
- **THEN** si mostrano `r13…r20`
- **AND** è segnalato che sopra c'è altro

#### Scenario: una barra di avanzamento è una riga
- **GIVEN** `result = "scarico\n 10%\r 50%\r100%\nfatto"`
- **THEN** le righe mostrate sono `scarico`, `100%`, `fatto`

#### Scenario: la coda segue il comando e lascia il posto all'esito
- **GIVEN** la chat su `:13334` e, via `page.routeWebSocket`, un `stream:tool_call` `Bash` in `running`
- **WHEN** arrivano due `stream:tool_update` con 12 e poi 20 righe
- **THEN** il corpo auto-aperto mostra in `shell-running-tail` le ultime 8 righe del primo, poi del secondo
- **AND** dopo `stream:tool_result` con `detail.output` il `shell-running-tail` non c'è più e `tool-call-result` mostra l'output definitivo

### Requirement: CHAT-TOOL-09 — La coda raggiunge anche la finestra da cui hai scritto, e non scrive mai su una riga chiusa

`stream:tool_update` SHALL entrare in `SENDER_ALSO_SEES`
(`client/src/hooks/senderAlsoSees.ts:44`). Rispetta la regola del file: scrive
uno stato fisso (sostituisce `result`), e riceverlo due volte lascia lo stesso
stato.

Nella finestra mittente l'esito arriva sull'SSE e il parziale su WS: due canali
senza ordine fra loro. Per questo `flushToolUpdates` (`useChat.ts:1210`) SHALL
scrivere `result` solo su una riga in `pending` o `running`. La parte di stato
dell'evento (`toolUpdatePatch`) resta com'è.

#### Scenario: la finestra da cui hai scritto vede la coda
- **WHEN** si chiede `senderAlsoSees('stream:tool_update')`
- **THEN** la risposta è `true`

#### Scenario: un parziale in ritardo non cancella l'esito
- **GIVEN** una riga `Bash` già in `success` con il suo `result` finale
- **WHEN** arriva un `stream:tool_update` per la stessa riga
- **THEN** `result` resta quello finale
