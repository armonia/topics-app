## ADDED Requirements

### Requirement: BRW-REL-01 — Un browser per contesto, niente steal in standalone

Nel gruppo standalone, una richiesta di apertura browser con `contextId` esplicito
SHALL riusare il pane `browser:<contextId>` se esiste e altrimenti crearne uno nuovo
con quell'id; SHALL NOT ri-puntare/rinominare il pane browser di un altro contesto.

#### Scenario: due chat standalone aprono ciascuna il proprio browser
- **GIVEN** due chat standalone A e B, con A che ha già il suo pane browser aperto
- **WHEN** B chiede l'apertura del browser (contextId = B)
- **THEN** nasce un pane `browser:B` distinto e il pane di A resta intatto

#### Scenario: riuso del proprio pane
- **GIVEN** la chat A col suo pane `browser:A` già aperto
- **WHEN** A chiede una nuova navigazione
- **THEN** il pane `browser:A` esistente viene riusato e navigato

### Requirement: BRW-REL-02 — Fallimenti di navigazione visibili sul path web

Sul path web/screencast, un fallimento di `goto` o del launch del browser server-side
SHALL produrre uno stato errore visibile nel pane (messaggio + azione Riprova) al
posto di spinner infiniti o della pagina precedente senza segnale.

#### Scenario: navigazione a host irraggiungibile
- **GIVEN** un pane browser web-mode attivo
- **WHEN** l'utente naviga verso una URL che rifiuta la connessione
- **THEN** il pane mostra una strip d'errore con il motivo e un bottone Riprova

#### Scenario: launch del browser fallito
- **GIVEN** il servizio browser non riesce ad avviare Chromium
- **WHEN** l'utente apre/naviga il pane web-mode
- **THEN** entro un tempo massimo il pane esce da "Starting browser…" e mostra la
  strip d'errore (mai attesa infinita)

### Requirement: BRW-REL-03 — UpdaterToast nel viewport e senza rumore ACL

Il toast dell'updater SHALL essere interamente visibile nel viewport in ogni stato
della sidebar; un `updater_check` negato dall'ACL Tauri (webview non-main) SHALL
essere trattato come updater non disponibile senza mostrare alcun toast d'errore.

#### Scenario: sidebar collassata
- **GIVEN** la sidebar collassata (version-chip nella rail)
- **WHEN** l'updater ha qualcosa da mostrare
- **THEN** il toast è interamente dentro il viewport (clamp o fallback corner)

#### Scenario: client caricato in un pane browser
- **GIVEN** il client Topics caricato in una webview pane (ACL senza updater_check)
- **WHEN** parte il boot-check updater
- **THEN** nessun toast d'errore appare (updater silenziosamente non disponibile)

### Requirement: BRW-REL-04 — Chiusura remota del pane browser

Un agente (o il server) SHALL poter chiudere un pane browser per contextId in
tutti i client vivi che lo mostrano, tramite il flusso di chiusura NORMALE del
client (semantica del bottone X: tombstone, persist, teardown nativo) — mai via
edit server-side dello stato (documenti LWW che i client vivi ri-persistono).
Il tool MCP `close_browser_pane` è il simmetrico di `open_browser_pane`.

#### Scenario: chiusura remota su client vivo
- **GIVEN** un pane browser aperto in una finestra viva (ctx noto)
- **WHEN** il server riceve POST browser/close-pane per quel ctx
- **THEN** ogni finestra che renderizza `browser:<ctx>` lo chiude via flusso normale
- **AND** le finestre che non lo possiedono ignorano il broadcast (idempotente)

#### Scenario: risoluzione di sessione
- **GIVEN** una sessione chat (ctx = topic.id) o terminale (ctx = term-<id>)
- **WHEN** l'agente chiama `close_browser_pane` senza argomenti
- **THEN** viene chiuso il pane della propria sessione
