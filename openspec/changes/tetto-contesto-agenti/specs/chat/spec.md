## ADDED Requirements

### Requirement: CHAT-COMPACT-06 — Un agente compatta a un tetto in token, non a una frazione di 1M

Sul motore nativo la chat di un agente SHALL compattare, all'inizio di un turno aperto da una persona, oltre il tetto `compactAtTokens` che l'agente dichiara in `agent-engine.json` se è sotto la soglia della finestra, e SHALL tornare al tetto per 0,40/0,85. Altrove (a metà turno, nelle riprese, senza tetto) SHALL valere la finestra. Il tetto SHALL valere anche nel `turn-host` e non SHALL tagliare i risultati recenti dei tool.

#### Scenario: una chat da 300k su una finestra da 1M

- **GIVEN** una conversazione di circa 300k token stimati su un modello da 1M
- **WHEN** l'agente che la possiede non ha un tetto
- **THEN** non si compatta
- **WHEN** l'agente ha un tetto di 200k
- **THEN** si compatta e la storia scende sotto 94k, con la richiesta iniziale ancora in testa

#### Scenario: un turno pieno di tool non perde la richiesta

- **GIVEN** una chat oltre il tetto e un turno di cinque giri che leggono 40k caratteri ciascuno
- **THEN** si compatta una volta sola, all'inizio, e ogni richiesta del turno contiene il messaggio della persona

#### Scenario: il tetto non alza mai la soglia

- **GIVEN** un modello da 200k (soglia 170k) e un tetto di 200k
- **THEN** soglia e obiettivo restano quelli della finestra

#### Scenario: una ripresa non perde la richiesta che riprende

- **GIVEN** la chat di un agente oltre il tetto, il cui ultimo turno è stato tagliato (giri finiti o riavvio)
- **WHEN** il turno dopo è la ripresa («Carry on…», la nota dopo il riavvio) e non un messaggio della persona
- **THEN** non si compatta al tetto, e la richiesta che la ripresa continua resta nella storia
