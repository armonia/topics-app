## ADDED Requirements

### Requirement: CHAT-COMPACT-06 — Un agente compatta a un tetto in token, non a una frazione di 1M

Sul motore nativo una chat il cui workspace è la cartella di un agente SHALL compattare oltre il tetto `compactAtTokens` che l'agente dichiara in `agent-engine.json`, quando il tetto è sotto la soglia della finestra, e SHALL tornare al tetto per 0,40/0,85. Altrimenti SHALL valere la finestra. Il tetto SHALL valere anche nel `turn-host`.

#### Scenario: una chat da 300k su una finestra da 1M

- **GIVEN** una conversazione di circa 300k token stimati su un modello da 1M
- **WHEN** l'agente che la possiede non ha un tetto
- **THEN** non si compatta
- **WHEN** l'agente ha un tetto di 200k
- **THEN** si compatta e la storia scende sotto 94k, con la richiesta iniziale ancora in testa

#### Scenario: il tetto non alza mai la soglia

- **GIVEN** un modello da 200k (soglia 170k) e un tetto di 200k
- **THEN** soglia e obiettivo restano quelli della finestra
