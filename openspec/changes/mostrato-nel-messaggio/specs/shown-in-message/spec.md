## ADDED Requirements

### Requirement: SHOWN-01 — Il segno dell'apertura porta ciò che è stato mostrato

Il segno nel messaggio che c'è già per ogni `open_browser_pane` SHALL portare la cosa aperta: il file (immagine, video, PDF) oppure una foto della pagina scattata all'apertura. Il media SHALL nascere dal risultato dello strumento, quindi esistere subito, anche mentre il turno è fermo su una domanda, ed essere salvato nel messaggio (visibile su ogni dispositivo, col pannello chiuso e dopo un riavvio). Lo stesso file scritto anche come `MEDIA:` SHALL comparire una sola volta.

#### Scenario: apro un'immagine e poi chiedo
- **WHEN** un turno apre un'immagine in una sottocartella di media e poi pone una domanda
- **THEN** a domanda ancora aperta il messaggio contiene già l'immagine nel segno

#### Scenario: pagina web
- **WHEN** l'agente apre una pagina web che carica
- **THEN** il risultato dello strumento cita una foto scattata all'apertura e il segno la mostra, una per apertura e non una per client

#### Scenario: pagina che non carica
- **WHEN** la pagina non carica
- **THEN** non c'è nessuna foto vuota e il risultato lo dice

#### Scenario: file fuori dalle cartelle servite
- **WHEN** l'agente apre un file fuori dalle cartelle servite
- **THEN** l'errore dice di copiarlo sotto `~/.topics/media`

#### Scenario: percorso con spazi e doppione MEDIA
- **WHEN** il percorso contiene spazi, oppure l'agente scrive anche `MEDIA:` per lo stesso file
- **THEN** il file è reso correttamente e mostrato una volta sola

### Requirement: SHOWN-02 — Indirizzi giusti

Un URL assoluto verso un'origine di questo server che punta a `/api/media` SHALL valere come il riferimento relativo; un loopback con un'altra porta SHALL restare invariato. Il pannello nativo NON SHALL prendere per caricata la pagina precedente sulla stessa origine, dopo un reindirizzamento l'URL raggiunto SHALL restare quello vero, e l'annuncio ai client SHALL portare l'URL chiesto.

#### Scenario: URL assoluto verso questo server
- **WHEN** l'agente passa `http://127.0.0.1:<porta del server>/api/media?path=…`
- **THEN** viene trattato come il riferimento relativo

#### Scenario: altra porta
- **WHEN** l'URL punta al loopback con un'altra porta
- **THEN** non viene toccato

#### Scenario: A e poi B sulla stessa origine
- **WHEN** nel pannello nativo si apre A e poi B sulla stessa origine
- **THEN** la risposta dice B e l'annuncio porta B

#### Scenario: reindirizzamento
- **WHEN** la pagina reindirizza
- **THEN** resta l'URL raggiunto

### Requirement: SHOWN-03 — Chi non scrive dove la persona legge lo sa

In un topic di sottoagente, di card o in una sessione di terminale il risultato di `open_browser_pane` SHALL nominare la strada che funziona, qualunque cosa dica `visible`.

#### Scenario: sottoagente, card, terminale
- **WHEN** l'apertura avviene in un topic di sottoagente, di card o in una sessione di terminale
- **THEN** il risultato dice di restituire il percorso a chi ha lanciato, di allegarlo alla card, o che resta solo il pannello, anche con `visible` vero

### Requirement: SHOWN-04 — Le frasi date all'agente

Le istruzioni dello strumento SHALL dire che mostrare è lasciare nel messaggio e che il pannello è in più; che per un file locale si passa il percorso; che un file fuori dalle cartelle servite va copiato sotto `~/.topics/media`; e NON SHALL dire di non nominare lo strumento alla persona.

#### Scenario: testo fissato
- **WHEN** si legge la descrizione dello strumento e il contesto del browser
- **THEN** contengono le frasi nuove e non contengono «Do not mention the tool to the user»
