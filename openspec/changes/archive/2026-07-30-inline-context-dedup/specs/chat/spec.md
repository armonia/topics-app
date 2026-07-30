## ADDED Requirements

### Requirement: CHAT-CACHE-01 — I provider SDK marcano il prefisso stabile come cacheabile

Il sistema SHALL marcare con un breakpoint di prompt caching le porzioni ripetute del
prefisso inviato ai provider che parlano direttamente con l'SDK Anthropic, in modo che le
richieste successive della stessa conversazione le rileggano dalla cache invece di
riprefillarle.

#### Scenario: Gli schemi dei tool sono cacheati

- **GIVEN** una richiesta che include definizioni di tool
- **WHEN** vengono costruiti i parametri per il provider
- **THEN** l'ultima definizione di tool porta un marker di cache effimera

#### Scenario: Il preambolo di sistema è cacheato

- **GIVEN** una richiesta con un messaggio di sistema non vuoto
- **WHEN** vengono costruiti i parametri per il provider
- **THEN** il preambolo di sistema è espresso come blocchi di testo
- **AND** l'ultimo blocco porta un marker di cache effimera

#### Scenario: La conversazione fino al turno corrente è cacheata

- **GIVEN** una richiesta con almeno un messaggio in conversazione
- **WHEN** vengono costruiti i parametri per il provider
- **THEN** l'ultimo messaggio porta un marker di cache effimera

#### Scenario: Non si superano i breakpoint consentiti

- **GIVEN** una richiesta con tool, sistema e conversazione tutti presenti
- **WHEN** vengono costruiti i parametri per il provider
- **THEN** il numero totale di marker di cache non supera quattro

#### Scenario: Una richiesta senza parti stabili resta invariata

- **GIVEN** una richiesta senza tool, senza sistema e senza messaggi
- **WHEN** vengono costruiti i parametri per il provider
- **THEN** nessun marker di cache viene applicato
