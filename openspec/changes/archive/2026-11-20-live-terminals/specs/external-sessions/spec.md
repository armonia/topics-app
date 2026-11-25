## ADDED Requirements

### Requirement: LIVETERM-01 — Ogni terminale acceso sul Mac si vede, si legge e si scrive da un ramo di menu

In fondo al menu «+» di ogni barra di tab, e nel menu «Topics», SHALL esserci il ramo «Terminali
vivi». SHALL elencare le PTY di Topics, i pane tmux e le tab di Terminal.app, un ramo per origine.
Una sessione di Topics SHALL aprirsi nella sua tab; un terminale di fuori SHALL aprire a lato il suo
schermo attuale e un campo da cui scriverci, con Invio. Il ramo NON SHALL togliere larghezza alle
tab e NON SHALL interrogare il server mentre è chiuso. Sul telefono SHALL essere raggiungibile dal
menu «Topics» senza pressione lunga.

#### Scenario: rispondere a un terminale tmux dal menu «+»

- **GIVEN** una sessione tmux accesa sul Mac
- **WHEN** apro «+» → «Terminali vivi», scelgo il suo pane e scrivo `echo ciao` con Invio
- **THEN** tmux esegue il comando e lo schermo nel livello mostra `ciao`

### Requirement: LIVETERM-02 — Il ramo è un'opzione, acceso di serie

L'opzione «Mostra i terminali vivi nei menu «+» e Topics» SHALL stare nel menu Vista, accesa di
serie. Spenta, il ramo NON SHALL esserci; riaccesa, SHALL tornare senza ricaricare.

#### Scenario: spegnere e riaccendere

- **WHEN** spengo l'opzione in Vista
- **THEN** il menu «+» non ha più il ramo, e riaccesa lo ritrova

### Requirement: LIVETERM-03 — Gli agenti pilotano gli stessi terminali

`GET /api/live-terminals`, `GET /api/live-terminals/:id/screen` e `POST /api/live-terminals/:id/send`
SHALL esporre gli stessi terminali della tendina, e gli strumenti MCP `session_list`,
`session_read`, `session_send` SHALL usarli. Un id che non ha la forma della sua sorgente NON SHALL
raggiungere tmux né osascript. Un `tell application "Terminal"` NON SHALL partire se Terminal non è
già aperto. Un terminale che c'è ma non accetta quell'invio (Terminal.app senza Invio) SHALL rispondere
422 con il motivo: il 404 dice «sparito», e lì il terminale c'è.

#### Scenario: un id storto

- **WHEN** un client scrive a `tmux:-t`
- **THEN** la risposta è 404 e tmux non viene chiamato

#### Scenario: un terminale che c'è ma rifiuta l'invio

- **GIVEN** una tab di Terminal.app aperta
- **WHEN** un client scrive `ciao` senza Invio a `terminal:<tty>`
- **THEN** la risposta è 422 con il motivo, e non 404
