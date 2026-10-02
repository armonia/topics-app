# Chat — cercare dentro una conversazione

## ADDED Requirements

### Requirement: CHAT-FIND-01 — La chat cerca nella conversazione intera, nei dati e non nel DOM

Il cercatore della chat SHALL cercare nei messaggi della sessione, non nelle
righe montate dalla lista virtuale (`MessageList.tsx:2111,2267`).

SHALL cercare in tutti i messaggi della conversazione: quelli nello store e
quelli che `historyCompleteness` tiene in attesa (`staged`). Se la storia non è
completa, la barra SHALL chiederla con `requestHistoryCompletion(sessionKey,
'stage')`, che NON SHALL unire le righe alla lista; finché non arrivano il
contatore SHALL dire che il totale è parziale, e all'arrivo la ricerca SHALL
rifarsi.

In ogni messaggio SHALL cercare: il testo; i ragionamenti; il comando o gli
argomenti e l'uscita di ogni strumento (dal `detail` validato, o da `result`
quando `detail` manca). La funzione SHALL essere pura
(`client/src/components/Chat/chatFind.ts`) e SHALL dare per ogni risultato
`messageId`, la parte (`text`, `thinking`, o lo strumento) e la posizione.

I risultati SHALL essere nell'ordine in cui la conversazione li mostra, dal
primo messaggio all'ultimo. Il primo passo avanti da fermo SHALL essere il
primo risultato **sotto** la posizione di lettura, e il primo indietro il primo
sopra (poi BROWSER-FIND-01 per il ciclo).

Senza maiuscole/minuscole il confronto SHALL ignorare le maiuscole; una parola
vuota SHALL dare zero risultati.

#### Scenario: una parola solo nel primo messaggio di una chat lunga
- **GIVEN** una chat con più messaggi di quanti ne porti la prima pagina (`HISTORY_FIRST_PAGE`) e la parola «zibaldone» solo nel primo
- **WHEN** apro la chat e cerco «zibaldone»
- **THEN** il contatore arriva a «1 di 1» senza che la lista cambi righe sotto gli occhi
- **AND** con Invio la riga del primo messaggio è in vista

#### Scenario: una parola solo nell'uscita di uno strumento
- **GIVEN** una risposta con una chiamata a uno strumento chiusa, la cui uscita contiene «ENOENT»
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
  chiusa, e lasciarla aperta dopo;
- espandere il corpo se il risultato è oltre il taglio di `clampBody`
  (`Chat/clampBody.ts:14`);
- evidenziare la parola nel testo a schermo con la CSS Custom Highlight API
  (`CSS.highlights`), il corrente con un colore suo, senza modificare il DOM
  della riga. Dove la parola non si ritrova nel testo a schermo (markdown che la
  spezza) SHALL evidenziare la riga intera (`chat-msg-jump-highlight`).

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
