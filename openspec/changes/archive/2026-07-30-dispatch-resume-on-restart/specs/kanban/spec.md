## ADDED Requirements

### Requirement: KANBAN-10 — Ripresa del dispatch al riavvio del server

Un riavvio del server (deploy, hot-reload, crash) SHALL essere trasparente per i task in
lavorazione: un task `in_progress` con chip `working` e un topic ancora esistente SHALL
essere **ripreso sulla stessa sessione** (stesso topic, stesso worktree, conversazione
CLI ripresa via `--resume`) con un nudge di continuazione lean — MAI un release+re-claim
che crea un topic e un worktree nuovi e fa ripartire l'agent da zero (stesso principio
del post-timeout in KANBAN-07, esteso al riavvio). La ripresa SHALL lasciare un commento
di sistema nel thread e NON SHALL consumare un tentativo del retry-cap: il riavvio non è
mai colpa dell'agent.

Il requeue da zero (release + ritorno in `todo` con rollback del tentativo) resta SOLO
per gli orfani che non hanno una sessione da riprendere: binding assente (crash tra
claim e bind), topic morto (ripulito durante il downtime), chip `starting` (kickoff mai
partito). Con l'interruttore globale `auto_dispatch` spento nessuna ripresa SHALL
avvenire: l'orfano torna in `todo` senza chip (su una board che non dispatcha un chip
`queued` non deve strandare). La riconciliazione SHALL essere idempotente sotto il poll
periodico: un turno già ripreso non viene mai raddoppiato.

#### Scenario: riavvio con agent al lavoro → riprende, non riparte
- **GIVEN** un task `in_progress` chip `working` legato a un topic esistente, board con auto-dispatch attivo
- **WHEN** il server riparte e la riconciliazione gira
- **THEN** il task resta `in_progress` legato allo STESSO topic e un turno di continuazione parte sulla stessa sessione
- **AND** i tentativi non aumentano e nel thread compare un commento di sistema sul riavvio

#### Scenario: orfano senza sessione riprendibile → requeue senza consumare tentativi
- **GIVEN** un task `in_progress` mid-dispatch il cui topic non esiste più (o mai legato)
- **WHEN** la riconciliazione gira
- **THEN** il task torna in `todo` senza binding e il tentativo interrotto è rimborsato

#### Scenario: auto-dispatch spento durante il downtime
- **GIVEN** un task `in_progress` chip `working` e l'interruttore globale spento
- **WHEN** la riconciliazione gira
- **THEN** il task torna in `todo` senza chip di dispatch e nessun agent riparte

#### Scenario: poll di riconciliazione non raddoppia i turni
- **GIVEN** un task appena ripreso con il turno ancora in corso
- **WHEN** la riconciliazione periodica rigira
- **THEN** nessun secondo turno parte per quel task
