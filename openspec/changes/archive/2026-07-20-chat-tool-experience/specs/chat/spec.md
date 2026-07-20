## ADDED Requirements

### Requirement: CHAT-TOOL-01 — Lo stato "running" copre l'utilizzo reale del tool

Il sistema SHALL mostrare una tool call come attiva (`running`) per tutta la finestra di
utilizzo reale: dalla partenza della generazione dell'input da parte del modello fino
all'arrivo del risultato — non solo durante l'esecuzione. Il `ToolCall` SHALL registrare
`startedAt`/`endedAt` e la UI SHALL mostrare la durata reale.

#### Scenario: tool con input lungo appare subito
- **GIVEN** un turno claude-code in cui il modello genera un Edit con input corposo
- **WHEN** il modello inizia a scrivere l'input del tool
- **THEN** la riga del tool appare subito in stato running (nome noto, args in arrivo)
- **AND** resta running finché il risultato non arriva

#### Scenario: durata reale visibile
- **GIVEN** una tool call completata
- **WHEN** l'utente guarda la riga
- **THEN** vede la durata effettiva (endedAt − startedAt) accanto allo stato

#### Scenario: args completi al termine della generazione
- **GIVEN** una tool call annunciata con args parziali
- **WHEN** l'input del tool è completo
- **THEN** la riga si aggiorna con gli args completi senza duplicare la call

### Requirement: CHAT-TOOL-02 — Aggregazione dei gruppi di tool call

Il sistema SHALL collassare i gruppi di tool call consecutive con 3 o più call in una
riga di sintesi con conteggi per tool e durata totale, espandibile al click nelle righe
per-call. Con il gruppo ancora in streaming, la sintesi delle call completate e la call
attiva (body aperto) SHALL essere visibili insieme. `waiting_for_input` e sub-agent non
si aggregano mai; gli errori SHALL restare visibili (conteggio) anche a gruppo chiuso.

#### Scenario: gruppo settled collassato con conteggi
- **GIVEN** un messaggio con 12 tool call consecutive completate
- **WHEN** l'utente guarda il messaggio
- **THEN** vede una sola riga di sintesi (es. "12 azioni · Read ×5 · Edit ×3 · Bash ×4")
- **AND** al click si espande nella lista delle 12 righe per-call

#### Scenario: la sintesi dice COSA è stato fatto, non solo quante volte
- **GIVEN** un gruppo collassato con comandi shell e file toccati
- **WHEN** l'utente guarda la riga di sintesi
- **THEN** sotto i conteggi vede gli highlights per tipo (comandi eseguiti, basename
  dei file, pattern cercati, host fetchati), dedupati in ordine di esecuzione

#### Scenario: gruppo live mostra la call attiva
- **GIVEN** un turno in streaming con 5 call completate e una in esecuzione
- **WHEN** l'utente guarda il messaggio
- **THEN** vede la sintesi delle 5 completate e la call attiva col pannello aperto

#### Scenario: errore visibile a gruppo chiuso
- **GIVEN** un gruppo settled con una call in errore
- **WHEN** il gruppo è collassato
- **THEN** la sintesi espone il conteggio errori con accento rosso

#### Scenario: il form di input non si aggrega
- **GIVEN** un gruppo di call in cui una è `waiting_for_input`
- **WHEN** il messaggio renderizza
- **THEN** la call col form resta una riga autonoma col form visibile

### Requirement: CHAT-TOOL-03 — Niente flash del pannello per i tool rapidi

Il body auto-aperto di una tool call running SHALL aprirsi solo se l'esecuzione supera
una soglia percettiva (~250ms) e, una volta aperto, restare visibile per un tempo minimo
(~1.5s) anche se il tool termina prima. Un toggle esplicito dell'utente SHALL sempre
prevalere sull'automatismo.

#### Scenario: tool istantaneo non sfarfalla
- **GIVEN** una tool call che completa in meno di 250ms
- **WHEN** la call passa da running a success
- **THEN** il body non si è mai auto-aperto (nessun flash open/close)

#### Scenario: tool breve resta leggibile
- **GIVEN** una tool call che completa in ~500ms
- **WHEN** il body si è auto-aperto
- **THEN** resta aperto almeno il dwell minimo prima di collassare

### Requirement: CHAT-TOOL-04 — Codice formattato nei body dei tool

Il sistema SHALL evidenziare la sintassi del codice mostrato nei body dei tool
(Read/Write/Edit content, comando Shell) con l'infrastruttura hljs esistente, derivando
la lingua dall'estensione del file. Il fallback per lingua ignota/oversize/tokenizer
non pronto SHALL restare il testo piatto attuale.

#### Scenario: Read di un file TypeScript evidenziato
- **GIVEN** una tool call Read completata su un file `.ts`
- **WHEN** l'utente espande il body
- **THEN** il contenuto mostra token evidenziati (keyword, stringhe) come i code fence

#### Scenario: fallback su lingua ignota
- **GIVEN** una tool call Read su un file con estensione non riconosciuta
- **WHEN** l'utente espande il body
- **THEN** il contenuto renderizza come testo monospace piatto (comportamento attuale)
