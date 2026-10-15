## ADDED Requirements

### Requirement: LIVETERM-01 — Ogni terminale acceso sul Mac si vede, si legge e si scrive dalla tendina

In fondo a ogni barra di tab, accanto al «+», SHALL esserci la tendina dei terminali vivi. SHALL
elencare le PTY di Topics, i pane tmux e le tab di Terminal.app, un ramo per origine. Una sessione
di Topics SHALL aprirsi nella sua tab; un terminale di fuori SHALL aprire a lato il suo schermo
attuale e un campo da cui scriverci, con Invio. La tendina NON SHALL interrogare il server mentre è
chiusa. Sul telefono, dove le barre di tab non ci sono, la tendina
SHALL stare nella riga in alto accanto alla campanella, con lo stesso bersaglio da 44 px.

#### Scenario: rispondere a un terminale tmux dalla tendina

- **GIVEN** una sessione tmux accesa sul Mac
- **WHEN** apro la tendina, scelgo il suo pane e scrivo `echo ciao` con Invio
- **THEN** tmux esegue il comando e lo schermo nella tendina mostra `ciao`

### Requirement: LIVETERM-02 — La tendina è un'opzione, accesa di serie

L'opzione «Mostra i terminali vivi in fondo alle tab» SHALL stare nel menu Vista, accesa di serie.
Spenta, il bottone NON SHALL esserci; riaccesa, SHALL tornare senza ricaricare.

#### Scenario: spegnere e riaccendere

- **WHEN** spengo l'opzione in Vista
- **THEN** la tendina sparisce da ogni barra, e riaccesa ritorna

### Requirement: LIVETERM-03 — Gli agenti pilotano gli stessi terminali

`GET /api/live-terminals`, `GET /api/live-terminals/:id/screen` e `POST /api/live-terminals/:id/send`
SHALL esporre gli stessi terminali della tendina, e gli strumenti MCP `session_list`,
`session_read`, `session_send` SHALL usarli. Un id che non ha la forma della sua sorgente NON SHALL
raggiungere tmux né osascript. Un `tell application "Terminal"` NON SHALL partire se Terminal non è
già aperto.

#### Scenario: un id storto

- **WHEN** un client scrive a `tmux:-t`
- **THEN** la risposta è 404 e tmux non viene chiamato
