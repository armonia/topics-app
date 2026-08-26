## Why

La board Kanban di Topics ha **già** tutto ciò che serve per essere il registro-task
condiviso uomo↔agenti — ma l'interfaccia MCP verso Claude è cieca a metà, e alcune parti
sono rotte.

Audit su `main` (2.1.6):

- **Storage completo, feature smontata.** Esistono `tasks` (status enum
  `backlog|todo|in_progress|review|done`, `priority`, `assigned_to`, `kanban_order`,
  `claude_task_id` UNIQUE), `task_comments` (author/content/mentions), `task_events`,
  `task_dependencies`, `task_tags`, `approvals` (`approval_type ∈ status_change|completion|review`,
  `reviewed_by`, `review_comment`), `board_settings.require_approval_for_done`. **MA la
  board (client + route server) è stata RIMOSSA** nel refactor `42e92c1d` ("remove
  Master/Board subsystem"): cancellati `KanbanBoard`, `KanbanColumn`, `TaskCard`,
  `AllBoardsPane`, `ApprovalReviewModal`, `BoardSettingsPanel`, `BoardMemoryPanel` + la
  boards route. Le tabelle sono state **tenute dormienti** ("so Dashboard/Agents still
  boot"), non droppate — ecco perché DB e spec sembrano dire "c'è tutto" mentre la feature
  non esiste. La rimozione era voluta: il peso era il **Master/orchestration** (ingest,
  autopilot, proposals), non il Kanban-task in sé.
- **MCP thin e monco.** `server/mcp/topics-mcp-server.ts` è un adapter HTTP
  (`--base-url` + `--session-key`). Espone solo `list_tasks` (GET
  `/api/sessions/:key/tasks`) e `update_task` (→ `/api/boards/:pid/tasks/:tid`, **solo
  cambio stato**). Nessun create, get, comment. Claude quindi **non può creare task né
  partecipare alla discussione**, pur avendo DB e UI pronti.
- **Endpoint rotti.** Gli handler REST `/api/sessions/:key/tasks` e
  `/api/boards/:pid/tasks/:tid` **non esistono nei sorgenti** (verosimilmente rimossi in
  `refactor-master-into-kanban`). `list_tasks` risponde 404 → i due tool esistenti sono di
  fatto non funzionanti.
- **Creazione task duplicata inline.** L'unico percorso di create vivo è un
  `db.prepare("INSERT INTO tasks …")` hard-coded in `server/routes/chat.ts:214`, non un
  service riusabile.

Obiettivo: rendere la Kanban un **sistema completo** in cui Claude, per ogni contesto
(progetto), legge i task, li crea, ci discute e li fa avanzare — ma **il passaggio a
`done` resta un gate umano** (colonna Review, approvazione di Attilio). E, opzionale,
un task appena creato può **partire da solo** (auto-dispatch a un agente).

## What Changes

1. **`server/services/tasks.ts`** — service unico (create / get+thread / addComment /
   listComments / update / move) su SQLite, con idempotenza via `claude_task_id`. La
   `INSERT` inline di `chat.ts` viene rifattorizzata per usarlo (single source of truth).

2. **Endpoint REST session-scoped** (routing manuale come il resto del server), che
   ripristinano e ampliano ciò che l'MCP già chiama:
   `GET/POST /api/sessions/:key/tasks`, `GET/POST /api/sessions/:key/tasks/:id/comments`,
   `PATCH /api/sessions/:key/tasks/:id`, con `?scope=project|all`. Ogni mutazione fa il
   broadcast WebSocket esistente → board live.

3. **Tool MCP** (naming unprefixed, coerente con l'esistente; il client li namespacea
   `mcp__topics__`):
   - `create_task` — scoping automatico sul progetto della sessione; `idempotency_key`.
   - `get_task` — task + **thread commenti** + eventi.
   - `comment_task` — aggiunge un commento firmato agente.
   - `update_task` **esteso** — oltre a `status` anche `priority`, `assignee`, `tags`,
     `dependencies` (rimane il gate su `done`, vedi §4).
   - `list_tasks` **esteso** — `scope: project` (default) | `all` (feed piatto globale,
     badge progetto).

   Backend prima del client: service + route + MCP rendono il sistema pilotabile e
   testabile headless, indipendentemente dalla UI.

4b. **Board client lean, Master-free (ricostruzione).** Poiché la board è stata rimossa,
   la ricostruiamo pulita: 5 colonne + drag-drop (`@dnd-kit`, ancora installato), TaskCard
   essenziale, detail panel con **thread commenti**, `ApprovalReviewModal` per il gate
   Review→Done, feed globale piatto. Riciclo i pezzi rimossi già puliti (`KanbanColumn`,
   `ApprovalReviewModal` — 0 ref Master) e **riscrivo** quelli incrostati di Master-mode
   (`KanbanBoard`/`TaskCard`/`AllBoards`: Crown/lead, proposal cards, autopilot → fuori).

4. **Gate di Review umano.** Un agente **non può** portare un task a `done`: il completamento
   agente sposta il task in `review` e crea una `approvals(approval_type='review')`. Solo
   un umano transita `review → done` (rispettando `board_settings.require_approval_for_done`).
   Un reject aggiunge un commento e riporta a `in_progress`. Le mutazioni MCP sono firmate
   con l'identità agente/sessione (author ≠ `user`).

5. **Contesto pull-on-demand.** Skill + convenzione `CLAUDE.md` per progetto: a inizio
   lavoro l'agente chiama `list_tasks(scope:project)` quando serve — nessuna injection
   automatica ogni turno (coerente col recall pull-based). Hook `SessionStart` di
   auto-inject resta opzionale, default off (vedi design D6).

6. **Auto-dispatch reattivo (Phase 4, flag-gated, default OFF).** Con
   `board_settings.autodispatch` attivo, un task che entra in `todo` assegnato a un agente
   fa spawn (riuso infra `spawn_agent`) di un worker che lo lavora, posta commenti di
   avanzamento e lo consegna in `review`. Ships dietro flag, separabile.

**Non-goal:** **nessun ritorno del Master/orchestration** (ingest, autopilot, proposal
cards, Crown/lead) — è ciò che era stato tagliato apposta; nessun tracker esterno
(Linear/GitHub); nessun cambio allo schema colonne DB; il gate `done` non diventa mai
automatico. La board ricostruita resta un Kanban-task **semplice**.
