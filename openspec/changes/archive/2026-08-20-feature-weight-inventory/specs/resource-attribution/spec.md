# Delta: resource-attribution — inventario del peso per funzionalità

## ADDED Requirements

### Requirement: RES-ATTR-06 — Ogni funzionalità dichiara cosa trattiene

Il sistema SHALL mantenere un registro in cui ogni funzionalità che trattiene stato
dichiara la propria estensione, e SHALL esporne l'inventario aggregato per funzionalità.

Ogni voce SHALL portare un'etichetta che nomina la funzionalità come la riconosce chi
usa l'app — non il nome del modulo che la implementa.

I conteggi dichiarati (voci, elementi) SHALL essere esatti. Una stima in byte PUÒ
accompagnarli, e quando c'è SHALL essere dichiarata come stima.

#### Scenario: Una funzionalità che non trattiene niente non compare
- **GIVEN** una funzionalità registrata il cui stato è vuoto
- **WHEN** l'inventario viene raccolto
- **THEN** quella voce NON SHALL comparire nel recap mostrato
- **AND** un elenco di funzionalità a zero NON SHALL essere presentato

#### Scenario: Un proprietario che fallisce non azzera gli altri
- **GIVEN** una funzionalità la cui funzione di dichiarazione solleva un errore
- **WHEN** l'inventario viene raccolto
- **THEN** le altre funzionalità SHALL comparire regolarmente
- **AND** quella in errore SHALL essere dichiarata non misurata, mai zero

#### Scenario: L'ordine è stabile fra due letture
- **GIVEN** un inventario con più funzionalità di pari peso
- **WHEN** viene raccolto due volte senza cambiamenti
- **THEN** l'ordine SHALL essere identico

### Requirement: RES-ATTR-07 — Misurato e trattenuto non si sommano

L'inventario SHALL tenere separate due nature:

- **misurato** — MB che vengono da un processo reale (sessioni terminale, pane browser,
  lato server), nelle stesse unità della status bar;
- **trattenuto** — conteggi esatti di stato che vive nel renderer condiviso, dove
  nessuna lettura di sistema può separare il costo di due funzionalità.

Il sistema NON SHALL produrre un totale che sommi le due nature, né SHALL convertire un
conteggio in MB per poterlo sommare. Una quota del renderer ripartita per funzionalità —
per numero di elementi, per byte stimati, per superficie — SHALL essere considerata un
numero inventato e NON SHALL essere mostrata, coerentemente con RES-ATTR-05.

#### Scenario: Una funzionalità di solo stato non riceve MB
- **GIVEN** i task della kanban caricati in memoria, che non hanno un processo proprio
- **WHEN** il loro peso viene riportato
- **THEN** SHALL essere espresso in conteggi
- **AND** NON SHALL essere espresso in MB, nemmeno stimati

#### Scenario: Le due nature restano distinte nel recap
- **GIVEN** un inventario con sia funzionalità misurate sia funzionalità trattenute
- **WHEN** il recap viene mostrato
- **THEN** le due nature SHALL essere distinguibili
- **AND** NON SHALL comparire un unico totale che le comprende entrambe

#### Scenario: Una funzionalità misurata usa le unità della barra
- **GIVEN** le sessioni terminale, che hanno processi propri
- **WHEN** il loro peso viene riportato
- **THEN** SHALL usare la stessa metrica di memoria e la stessa scala di CPU della status bar

### Requirement: RES-ATTR-08 — Il recap si vede all'hover e nel dropdown

Il recap dell'inventario SHALL essere disponibile su due superfici: al passaggio del
mouse sul totale della status bar, e nel dropdown di stato.

Nel tooltip SHALL comparire un estratto — le voci che pesano di più — perché un tooltip
lungo quanto un pannello non si legge. Nel dropdown SHALL comparire l'inventario
completo.

Le due superfici SHALL derivare dallo stesso inventario e dalle stesse regole di
ordinamento: due superfici che rispondono alla stessa domanda con due esiti diversi si
contraddicono.

#### Scenario: Il tooltip della barra porta le voci principali
- **GIVEN** un inventario con più funzionalità che trattengono
- **WHEN** l'utente passa il mouse sul totale nella status bar
- **THEN** SHALL comparire un estratto delle voci maggiori
- **AND** l'estratto SHALL essere limitato in lunghezza

#### Scenario: Il dropdown porta l'inventario completo
- **GIVEN** lo stesso inventario
- **WHEN** l'utente apre il dropdown di stato
- **THEN** SHALL comparire ogni voce non vuota

#### Scenario: La raccolta avviene quando qualcuno guarda
- **GIVEN** la status bar montata e nessun pannello aperto
- **WHEN** nessuno passa il mouse e nessun dropdown è aperto
- **THEN** le funzioni di dichiarazione NON SHALL essere invocate a intervalli fissi

#### Scenario: Un inventario vuoto non mostra una sezione vuota
- **GIVEN** nessuna funzionalità che trattenga qualcosa
- **WHEN** il recap viene mostrato
- **THEN** NON SHALL comparire né una sezione vuota né un elenco di zeri
