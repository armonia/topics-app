## ADDED Requirements

### Requirement: KANBAN-03 — Authoring task da agente via MCP

Il sistema SHALL permettere a un agente, tramite MCP, di creare e aggiornare task sulla
board del **progetto legato alla sua sessione**, senza dover conoscere `project_id`. Le
mutazioni SHALL passare da un unico task-service ed essere riflesse live sulla board via
broadcast WebSocket. La creazione SHALL essere idempotente rispetto a un
`idempotency_key` opzionale. Un task creato da un agente SHALL entrare in `backlog`
(intake): solo un umano lo sposta in `todo`, che è ciò che lo rende eleggibile
all'auto-dispatch — simmetrico al gate `review → done` (KANBAN-05) e guardia
anti-ricorsione (un worker non può accodare lavoro che spawna altri worker).

#### Scenario: create_task crea sul progetto della sessione
- **GIVEN** una sessione agente legata al progetto P
- **WHEN** l'agente chiama `create_task` con un testo e nessun `project_id`
- **THEN** un nuovo task compare nella colonna `backlog` della board di P
- **AND** la board aperta si aggiorna senza refresh manuale

#### Scenario: create_task è idempotente
- **GIVEN** un `create_task` già andato a buon fine con `idempotency_key = K`
- **WHEN** l'agente ripete `create_task` con lo stesso `K` e stessi campi
- **THEN** nessun task duplicato viene creato
- **AND** viene restituito il task esistente

#### Scenario: update_task estende oltre lo stato
- **GIVEN** un task esistente
- **WHEN** l'agente chiama `update_task` con `priority`, `assignee`, `tags` o `dependencies`
- **THEN** il task riflette i nuovi campi sulla card e nel detail panel

### Requirement: KANBAN-04 — Discussione (thread commenti) via MCP

Il sistema SHALL esporre lettura e scrittura del thread di discussione di un task via MCP.
`get_task` SHALL restituire il task con i suoi commenti (ordine cronologico) e gli eventi
di ciclo-vita. `comment_task` SHALL aggiungere un commento. L'autore SHALL essere risolto
**dal server** dall'identità di sessione dell'agente e non dal parametro del tool.

#### Scenario: get_task restituisce il thread
- **GIVEN** un task con commenti
- **WHEN** l'agente chiama `get_task`
- **THEN** riceve il testo del task, la lista dei commenti e gli eventi di stato

#### Scenario: comment_task firma l'agente
- **GIVEN** una sessione agente A
- **WHEN** l'agente chiama `comment_task` su un task
- **THEN** il commento appare nel detail panel con `author` = identità di A (≠ `user`)

#### Scenario: l'autore non è spoofabile dal client
- **GIVEN** un `comment_task` che passa un `author` arbitrario nei parametri
- **WHEN** il commento viene salvato
- **THEN** l'`author` persistito è quello risolto dal server, non quello passato

### Requirement: KANBAN-05 — Gate di consegna umano (Review → Done)

Un agente SHALL NOT poter portare un task a `done`. Il completamento da parte di un agente
SHALL spostare il task in `review` e registrare un'approvazione pendente. La transizione
`review → done` SHALL essere consentita solo a un attore umano. Un rifiuto SHALL riportare
il task a `in_progress` e registrare un commento.

#### Scenario: l'agente consegna in Review, non in Done
- **GIVEN** un task `in_progress` lavorato da un agente
- **WHEN** l'agente chiama `update_task` con `status = done`
- **THEN** l'operazione è rifiutata
- **AND** l'agente può invece portarlo a `review`, creando un'approvazione pendente

#### Scenario: solo l'umano chiude
- **GIVEN** un task in `review` con approvazione pendente
- **WHEN** l'umano approva dalla approval modal
- **THEN** il task passa a `done` con `reviewed_by` valorizzato
- **AND** lo stesso passaggio richiesto da un agente resta rifiutato

#### Scenario: reject rimanda in lavorazione
- **GIVEN** un task in `review`
- **WHEN** l'umano rifiuta con un commento
- **THEN** il task torna in `in_progress` e il commento è visibile nel thread

### Requirement: KANBAN-06 — Feed globale multiprogetto via MCP

`list_tasks` SHALL accettare `scope: project | all`. Con `scope = all` il sistema SHALL
restituire un feed piatto dei task di tutti i progetti, ciascuno etichettato con il proprio
progetto, paginato a cursore. `scope = project` (default) SHALL limitare al progetto della
sessione.

#### Scenario: scope all attraversa i progetti
- **GIVEN** task in due progetti diversi
- **WHEN** l'agente chiama `list_tasks` con `scope = all`
- **THEN** riceve task di entrambi i progetti, ognuno con l'etichetta del progetto

#### Scenario: scope project è il default
- **GIVEN** una sessione legata al progetto P
- **WHEN** l'agente chiama `list_tasks` senza `scope`
- **THEN** riceve solo i task di P

### Requirement: KANBAN-07 — Auto-dispatch reattivo (opt-in)

Quando `board_settings.auto_dispatch` è attivo per una board, un task che entra in `todo`
(trascinato O creato direttamente lì da un umano) SHALL innescare, dopo una finestra di
grazia anti drag-through, il claim atomico del task e l'avvio di un agent headless
dedicato in una chat tab detached, isolato in un git worktree quando
`dispatch_use_worktree` è attivo. Il numero di agent concorrenti per board SHALL essere
limitato da `max_agents`; i tentativi per task da un retry-cap. L'agent lavora fino a
`review` (mai `done`, KANBAN-05). Con il flag disattivo (default) nessuno spawn SHALL
avvenire e nessun chip di dispatch SHALL comparire. La guardia anti-ricorsione è
strutturale: gli agent creano solo in `backlog` (KANBAN-03), quindi il lavoro accodato da
un worker non è mai auto-eleggibile.

Feedback SHALL essere sempre visibile sulla card: `queued → starting → working →
needs_input` via `dispatch_state`, e ogni interruzione (worktree impossibile, progetto
non risolvibile, turno morto, retry esauriti) SHALL parcheggiare il task con il motivo
in `dispatch_error` E un commento nel thread — mai un fallimento silenzioso solo nei log.

#### Scenario: task in todo parte da solo (flag on)
- **GIVEN** una board con `auto_dispatch` attivo
- **WHEN** un task entra in `todo` e vi resta oltre la finestra di grazia
- **THEN** il task è claimato (`in_progress`, chip `working`) e un agent lavora in una
  tab dedicata raggiungibile dalla card ("apri tab")
- **AND** alla consegna il task è in `review` con chip `serve te`

#### Scenario: nessun dispatch con flag off
- **GIVEN** una board con `auto_dispatch` disattivo (default)
- **WHEN** un task viene creato o trascinato in `todo`
- **THEN** nessun agente viene spawnato automaticamente
- **AND** l'header della board mostra che l'auto-dispatch è spento

#### Scenario: drag-through non spawna
- **GIVEN** una board con `auto_dispatch` attivo
- **WHEN** un task attraversa `todo` e ne esce prima della finestra di grazia
- **THEN** nessun claim avviene e il chip `in coda` viene rimosso

#### Scenario: interruzione visibile, mai silenziosa
- **GIVEN** una board con `auto_dispatch` attivo il cui progetto non è risolvibile o il
  cui worktree non può essere creato
- **WHEN** un task tenta il dispatch
- **THEN** il task è parcheggiato in `backlog` con il motivo in `dispatch_error` e nel
  thread commenti
