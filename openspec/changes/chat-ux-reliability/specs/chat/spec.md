## ADDED Requirements

### Requirement: CHAT-REL-01 — Azioni messaggio raggiungibili con click reali

La toolbar delle azioni messaggio (Edit/Reply/Copy/Pin/Save-to-memory) SHALL essere
visibile e cliccabile con un click reale al centro del bottone su ogni messaggio,
inclusi i messaggi adiacenti a separatori di data e i messaggi consecutivi.

#### Scenario: copy su messaggio sotto il separatore data
- **GIVEN** una conversazione il cui primo messaggio del giorno segue il separatore "TODAY"
- **WHEN** l'utente porta il mouse sul messaggio e clicca "Copy message" (click reale, no force)
- **THEN** il contenuto è copiato e il bottone mostra la conferma

#### Scenario: edit su messaggio utente consecutivo
- **GIVEN** due messaggi utente consecutivi in una conversazione
- **WHEN** l'utente hovera il secondo e clicca "Edit message" (click reale)
- **THEN** il composer entra in modalità edit con il testo del messaggio

#### Scenario: i separatori data non intercettano click
- **GIVEN** una toolbar azioni che si sovrappone visivamente a un separatore data
- **WHEN** l'utente clicca un bottone della toolbar
- **THEN** il click raggiunge il bottone (il separatore è pointer-events-none)

### Requirement: CHAT-REL-02 — New Chat sempre visibile appena creata

Un pane draft creato da "New Chat" SHALL essere renderizzato (tab + vista draft con
composer) nel frame successivo alla creazione su ogni superficie (desktop e mobile
<768px), indipendentemente dallo stato di hydration del layout persistito.

#### Scenario: New Chat a client freddo su mobile
- **GIVEN** l'app appena caricata su viewport <768px, nessuna tab aperta
- **WHEN** l'utente clicca "New Chat"
- **THEN** compare la vista draft con composer (mai schermo vuoto)

#### Scenario: New Chat con altre tab aperte
- **GIVEN** tab progetto/terminale già aperte
- **WHEN** l'utente clicca "New Chat"
- **THEN** la tab "New Chat" appare e diventa attiva

### Requirement: CHAT-REL-03 — /browser gestito e con feedback

Il comando `/browser <url>` SHALL aprire/navigare il pane browser del topic in ogni
configurazione di finestre (topic standalone anche con tab progetto aperte; topic di
progetto nel proprio project window) e SHALL dare feedback visibile nel pannello
comando.

#### Scenario: topic standalone con tab progetto aperte
- **GIVEN** un topic standalone attivo e una tab progetto aperta nella stessa finestra
- **WHEN** l'utente invia `/browser https://example.com`
- **THEN** il pane browser del gruppo standalone si apre/naviga su quella URL
- **AND** il pannello comando mostra "Opening https://example.com…"

#### Scenario: nessun hijack dei topic di progetto
- **GIVEN** un topic che appartiene a un progetto renderizzato
- **WHEN** quel topic invia `/browser <url>`
- **THEN** è il project window a gestire l'apertura (il gruppo standalone non
  crea pane per topic che non sono suoi membri)
