# Chat — cercare dentro una conversazione

## ADDED Requirements

### Requirement: CHAT-FIND-01 — La chat cerca nella conversazione intera, uscite degli strumenti comprese, sul server

Il cercatore della chat NON SHALL cercare nelle righe montate dalla lista
virtuale (`MessageList.tsx:2111,2267`), e NON SHALL cercare l'uscita degli
strumenti nei dati del client. Il client non la riceve: la storia la toglie
(`server/routes/history.ts:136-143,266`, `shared/lean-tool-call.ts:305,433-436,516`).

SHALL chiedere i risultati alla rotta `POST /api/history-find`
(`{ sessionKey, query, matchCase }`, in `server/routes/history.ts`). La rotta
SHALL leggere tutti i messaggi attivi della sessione con le uscite rimesse da
`message_tool_outputs`, e SHALL rispondere
`{ total, hits: [{ messageId, part, toolCallId?, offset }], truncated }`, con
`total` esatto e al più 5.000 posizioni. La rotta NON SHALL essere aperta agli
ospiti (`server/lib/grants.ts:101`).

In ogni messaggio SHALL cercare: il testo; i ragionamenti; il comando o gli
argomenti e l'uscita di ogni strumento (dal `detail` validato, o da `result`
quando `detail` manca). NON SHALL cercare nei comandi lanciati da chi scrive
(`CommandRunBlock`), che non sono messaggi. La ricerca SHALL essere una
funzione pura (`shared/chat-find.ts`), la stessa per la rotta e per il client,
e SHALL dare per ogni risultato `messageId`, la parte (`text`, `thinking`,
`tool` con `toolCallId`) e la posizione.

Il messaggio in streaming SHALL essere cercato nel client, sul testo ricevuto
dal vivo; i suoi risultati SHALL sostituire quelli della rotta per lo stesso
`messageId`. La barra SHALL chiedere alla rotta 250 ms dopo l'ultima lettera,
annullando la richiesta precedente, e di nuovo a fine turno.

I risultati SHALL essere nell'ordine in cui la conversazione li mostra, dal
primo messaggio all'ultimo. Il primo passo avanti da fermo SHALL essere il
primo risultato **sotto** la posizione di lettura, e il primo indietro il primo
sopra (poi BROWSER-FIND-01 per il ciclo).

Senza maiuscole/minuscole il confronto SHALL ignorare le maiuscole; una parola
vuota SHALL dare zero risultati. Oltre 5.000 risultati il contatore SHALL dire
«oltre 5000».

Per un ospite di una chat condivisa la barra SHALL cercare solo nel testo e nei
ragionamenti che il client ha.

#### Scenario: una parola solo nel primo messaggio di una chat lunga
- **GIVEN** una chat con più messaggi di quanti ne porti la prima pagina (`HISTORY_FIRST_PAGE`) e la parola «zibaldone» solo nel primo
- **WHEN** apro la chat e cerco «zibaldone»
- **THEN** il contatore arriva a «1 di 1» senza che la lista cambi righe sotto gli occhi
- **AND** con Invio la riga del primo messaggio è in vista

#### Scenario: una parola solo nell'uscita di uno strumento
- **GIVEN** una risposta con una chiamata a uno strumento chiusa, la cui uscita contiene «ENOENT» e sta in `message_tool_outputs`
- **WHEN** cerco «ENOENT»
- **THEN** il contatore dice almeno un risultato

#### Scenario: la funzione pura
- **WHEN** `chatFind([{ id: 'a', content: 'Uno uno' }], 'uno', { matchCase: false })`
- **THEN** il risultato ha due voci su `messageId: 'a'`, parte `text`, posizioni 0 e 4

### Requirement: CHAT-FIND-02 — Arrivare su un risultato lo mostra, anche se era chiuso

Andare su un risultato SHALL:

- portare la sua riga al centro della vista, con il salto che già usa la
  palette (`requestScrollToMessage`, `MessageList.tsx:1384-1460`), che unisce la
  storia mancante (`'apply'`) solo in questo momento;
- aprire la sezione dei ragionamenti o dello strumento che lo contiene, se è
  chiusa, e lasciarla aperta dopo; una riga di strumento SHALL chiedere il suo
  testo intero con la richiesta che c'è già (`ToolCallRow.tsx:274-283`) prima
  di evidenziare;
- espandere il corpo se il risultato è oltre il taglio di `clampBody`
  (`Chat/clampBody.ts:14`);
- evidenziare la parola nel testo a schermo con la CSS Custom Highlight API
  (`CSS.highlights`), il corrente con un colore suo, senza modificare il DOM
  della riga. Dove la parola non si ritrova nel testo a schermo (markdown che la
  spezza, uscita disegnata in parte) SHALL evidenziare la riga intera
  (`chat-msg-jump-highlight`).

Chiudere la barra SHALL togliere ogni evidenziazione e NON SHALL richiudere le
sezioni aperte.

#### Scenario: la sezione chiusa si apre
- **GIVEN** il risultato corrente dentro l'uscita di uno strumento chiuso
- **WHEN** ci arrivo con Invio
- **THEN** la sezione è aperta e la parola ha l'evidenziazione del corrente

#### Scenario: nessun layout shift dall'evidenziazione
- **GIVEN** una riga montata con tre risultati
- **WHEN** la barra li evidenzia
- **THEN** l'altezza della riga non cambia

### Requirement: CHAT-FIND-03 — Mentre l'agente scrive il conteggio cresce, e non ti sposta

Con la barra aperta su una chat in streaming, il cercatore SHALL ricercare il
messaggio in corso quando il suo testo cambia, al più ogni 120 ms. I risultati
nuovi SHALL aggiungersi al totale; l'indice e la posizione del risultato
corrente NON SHALL cambiare, e la lista NON SHALL scorrere da sola per un
risultato nuovo.

#### Scenario: un risultato nuovo in coda
- **GIVEN** la barra su «3 di 5» e un turno in streaming
- **WHEN** l'agente scrive la parola cercata
- **THEN** il contatore dice «3 di 6»
- **AND** la vista non si è spostata
