# Layout — «Attende te» vede anche le domande dell'app

## MODIFIED Requirements

### Requirement: CHROME-07 — I tre stati di una superficie si distinguono, e si raggruppano

Gli stati di una sessione — chi ASPETTA una decisione, chi ASPETTA una risposta,
chi LAVORA — SHALL essere distinguibili sulla scheda e nella riga, per segno E per
testo.

SHALL esistere una vista che li RAGGRUPPA: chi aspetta te, chi sta lavorando, il
resto.

La sezione «Attende te» SHALL contenere ogni riga che la sidebar colora come in
attesa, ambra o blu: per le chat l'unione `awaitingFeedbackTopics ∪
awaitingInputTopics`. Una chat ferma su una domanda o su un permesso dentro
l'app ha lo stream ancora aperto, e NON SHALL finire in «Al lavoro»: chi aspetta
precede chi lavora. I segnali della vista SHALL venire da una sola funzione pura
(`sidebarStateSignals`), la stessa che usa la coda di CHAT-WAIT-03.

La differenza fra chi aspetta e chi lavora SHALL essere visibile come TINTA e
RITMO, non solo come attributo: un esito verde non la dimostra a nessuno.

#### Scenario: le tre sessioni insieme
- **GIVEN** una in attesa di decisione, una in attesa di risposta, una al lavoro
- **THEN** SHALL essere distinguibili per segno e per testo

#### Scenario: la vista per stato
- **GIVEN** più sessioni
- **THEN** SHALL essere raggruppate per chi aspetta e chi lavora

#### Scenario: una domanda dentro l'app sta in «Attende te»
- **GIVEN** su `:13334`, vista per stato, una chat con lo stream aperto e l'ultima riga con `mcp__topics__ask_user_question` in `waiting_for_input`, che `GET /api/topics/streaming` riporta `waiting`
- **THEN** la sua riga sta in `sidebar-state-section-awaiting`
- **AND** non sta in `sidebar-state-section-working`
