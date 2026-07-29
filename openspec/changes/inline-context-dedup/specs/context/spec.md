## ADDED Requirements

### Requirement: CTX-DEDUP-01 — Il preambolo inline porta solo ciò che è cambiato

Per la sola strategia `inline-system`, il sistema SHALL anteporre al messaggio utente uno
slot di contesto composto se e solo se la sessione CLI corrente non ha già ricevuto quello
slot con contenuto identico. L'identità è l'hash del contenuto composto dello slot.

#### Scenario: Il primo turno di una sessione porta il contesto completo

- **GIVEN** un topic su provider `claude-code` senza slot registrati come inviati
- **WHEN** l'utente invia il primo messaggio
- **THEN** il preambolo `<context>` contiene tutti gli slot abilitati
- **AND** il contenuto è byte-identico a quello prodotto senza deduplicazione

#### Scenario: Un turno successivo senza cambiamenti non ripete il preambolo

- **GIVEN** una sessione in cui tutti gli slot abilitati risultano già inviati con lo stesso hash
- **WHEN** l'utente invia un altro messaggio
- **THEN** il contenuto inviato al provider è il messaggio utente senza alcun blocco `<context>`
- **AND** le note di adattamento riportano quanti slot sono stati saltati e i token risparmiati

#### Scenario: Uno slot il cui contenuto cambia viene rimandato per intero

- **GIVEN** una sessione in cui lo slot `template` risulta già inviato
- **AND** un file di progetto incluso in quello slot viene modificato
- **WHEN** l'utente invia un messaggio
- **THEN** il preambolo contiene lo slot `template` completo, non il solo file modificato
- **AND** gli altri slot invariati restano esclusi

#### Scenario: Lo slot modale plan-mode non viene mai deduplicato

- **GIVEN** una sessione con plan mode attivo e lo slot `plan-mode` già inviato
- **WHEN** l'utente invia un altro messaggio con plan mode ancora attivo
- **THEN** il preambolo contiene lo slot `plan-mode`

#### Scenario: Le strategie non-inline restano invariate

- **GIVEN** un topic su un provider `history-aware` o `gateway-stateful`
- **WHEN** viene assemblato il payload
- **THEN** i messaggi di sistema sono anteposti alla history esattamente come senza deduplicazione

#### Scenario: La deduplicazione si può disattivare

- **GIVEN** la variabile d'ambiente `TOPICS_INLINE_CONTEXT_DEDUP` valorizzata a `0`
- **WHEN** l'utente invia un messaggio qualsiasi su provider `inline-system`
- **THEN** il preambolo contiene tutti gli slot abilitati ad ogni turno

### Requirement: CTX-GOAL-01 — L'obiettivo del topic raggiunge il modello

Il sistema SHALL includere il blocco dell'obiettivo attivo del topic fra i contenuti
inviati al provider, coerentemente con il fatto che l'ispettore lo mostra e lo conta nel
budget del contesto.

#### Scenario: Un obiettivo attivo viene inviato

- **GIVEN** un topic con un obiettivo attivo
- **WHEN** viene composto il contesto da inviare
- **THEN** il contenuto dell'obiettivo è presente fra i messaggi di sistema composti

#### Scenario: Un obiettivo completato viene dichiarato non più in vigore

- **GIVEN** una sessione `inline-system` in cui l'obiettivo era già stato inviato
- **WHEN** l'obiettivo non è più attivo e l'utente invia un messaggio
- **THEN** il preambolo dichiara l'obiettivo non più in vigore

### Requirement: CTX-DEDUP-02 — Lo stato di invio è valido solo per la conversazione CLI corrente

Il sistema SHALL legare gli slot registrati come inviati a uno scope composto
dall'identificativo della sessione CLI e dal numero di compattazioni della sessione, e
SHALL scartare l'intero stato quando lo scope osservato differisce da quello memorizzato.

#### Scenario: Una nuova sessione CLI riparte dal contesto completo

- **GIVEN** una sessione con tutti gli slot registrati come inviati
- **WHEN** l'identificativo della sessione CLI cambia
- **AND** l'utente invia un messaggio
- **THEN** il preambolo contiene tutti gli slot abilitati

#### Scenario: Dopo una compattazione il contesto viene rimandato

- **GIVEN** una sessione con tutti gli slot registrati come inviati
- **WHEN** viene registrato un nuovo marker di compattazione per quella sessione
- **AND** l'utente invia un messaggio
- **THEN** il preambolo contiene tutti gli slot abilitati

#### Scenario: Un invio fallito non consuma lo stato

- **GIVEN** una sessione senza slot registrati come inviati
- **WHEN** un turno viene composto e l'invio al provider fallisce
- **AND** l'utente invia di nuovo un messaggio
- **THEN** il preambolo contiene tutti gli slot abilitati

### Requirement: CTX-DEDUP-03 — Uno slot ritirato viene dichiarato

Quando uno slot precedentemente inviato non è più presente tra quelli composti, il sistema
SHALL dichiararlo esplicitamente nel preambolo e SHALL rimuoverlo dallo stato di invio.

#### Scenario: La disattivazione del plan mode viene comunicata al modello

- **GIVEN** una sessione con lo slot `plan-mode` registrato come inviato
- **WHEN** l'utente invia un messaggio con plan mode disattivato
- **THEN** il preambolo contiene una riga che dichiara `plan-mode` non più in vigore

#### Scenario: Un ritiro già dichiarato non viene ripetuto

- **GIVEN** una sessione in cui il ritiro dello slot `plan-mode` è già stato dichiarato
- **WHEN** l'utente invia un altro messaggio con plan mode ancora disattivato
- **THEN** il preambolo non contiene alcuna riga di ritiro per `plan-mode`
