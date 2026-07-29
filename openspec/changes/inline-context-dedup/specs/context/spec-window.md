## ADDED Requirements

### Requirement: CTX-WIN-01 — La finestra del modello è quella vera

Il sistema SHALL dimensionare il contesto di una sessione sulla finestra reale del
modello, e SHALL trattare il milione di token come la finestra di serie della
generazione corrente anziché come una variante.

#### Scenario: I modelli della generazione corrente hanno un milione di token

- **GIVEN** un modello della generazione corrente della famiglia Opus o Sonnet
- **WHEN** viene richiesta la sua finestra di contesto
- **THEN** la finestra è di un milione di token
- **AND** è dichiarata come nota, non stimata

#### Scenario: Haiku resta a duecentomila

- **GIVEN** un modello della famiglia Haiku
- **WHEN** viene richiesta la sua finestra di contesto
- **THEN** la finestra è di duecentomila token

#### Scenario: Un modello legacy conserva la sua finestra storica

- **GIVEN** un modello di una generazione precedente la cui finestra era di duecentomila token
- **WHEN** viene richiesta la sua finestra di contesto
- **THEN** la finestra resta quella storica, non quella della generazione corrente

#### Scenario: Un modello sconosciuto cade sul default moderno ed è dichiarato stimato

- **GIVEN** un nome di modello non presente in tabella
- **WHEN** viene richiesta la sua finestra di contesto
- **THEN** la finestra è quella di default della generazione corrente
- **AND** è dichiarata come stimata, così l'interfaccia può segnalare l'approssimazione

### Requirement: CTX-WIN-02 — Il denominatore del ring si ricalcola, il numeratore no

Il sistema SHALL classificare l'ultima misura di contesto contro la finestra del
modello attualmente selezionato per il topic, e SHALL conservare invariata la misura
stessa.

#### Scenario: Una misura registrata con una finestra sbagliata viene corretta alla lettura

- **GIVEN** una misura persistita con una finestra non corrispondente al modello
- **WHEN** viene richiesto il contesto vivo della sessione
- **THEN** la percentuale è calcolata sulla finestra corretta del modello
- **AND** i token usati restano quelli misurati

#### Scenario: Il cambio di modello aggiorna il contesto senza attendere un altro turno

- **GIVEN** una sessione con una misura di contesto già registrata
- **WHEN** l'utente cambia il modello del topic
- **THEN** viene emesso un aggiornamento di contesto con la nuova finestra
- **AND** i token usati sono invariati

#### Scenario: Una finestra sconosciuta non sovrascrive quella registrata

- **GIVEN** una misura persistita e un modello la cui finestra non è in tabella
- **WHEN** viene richiesto il contesto vivo della sessione
- **THEN** viene usata la finestra registrata con la misura
