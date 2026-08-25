## Purpose

Specifies behavioral scenarios for the Kanban board system including board rendering, task CRUD, drag-drop reordering, approval workflows, filters, agent assignment, board settings, and multi-board views.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- A topic with a linked project folder exists and is selected
- The kanban board pane is visible with columns loaded
## Requirements
### Requirement: KANBAN-01 — Board Rendering, Task CRUD & Drag-Drop

The system SHALL render a kanban board with five status columns, support creating, viewing, editing, and deleting tasks, and allow drag-drop to move or reorder tasks.

#### Scenario: Board renders with all five columns
- **GIVEN** the kanban board is loaded for a project
- **WHEN** the board finishes loading
- **THEN** five columns are visible: Backlog, Todo, In Progress, Review, and Done

#### Scenario: Column headers show labels and task counts
- **GIVEN** the board has tasks distributed across multiple columns
- **WHEN** the board renders
- **THEN** each column header displays its label
- **AND** each column header shows a count of tasks in that column

#### Scenario: Create new task via inline input
- **GIVEN** a column is visible on the board
- **WHEN** the user clicks the Add button in the column
- **THEN** an inline text input appears in that column
- **AND** after typing a task description and pressing Enter the new task appears in the column

#### Scenario: Task card displays summary information
- **GIVEN** a task exists in a column
- **WHEN** the board renders
- **THEN** the task card shows the task description text

#### Scenario: Task card shows priority indicator
- **GIVEN** a task has a priority level assigned
- **WHEN** the board renders
- **THEN** the task card displays a visual priority indicator

#### Scenario: Task card shows assigned agent badge
- **GIVEN** a task is assigned to an agent
- **WHEN** the board renders
- **THEN** the task card displays the assigned agent name or badge

> Note: Agent assignment on task cards is also relevant to AGENT-02 (topic assignment and status indicators).

#### Scenario: Task detail panel opens on card click
- **GIVEN** a task card is visible on the board
- **WHEN** the user clicks on the task card
- **THEN** a detail panel opens showing the full task information
- **AND** the panel contains the task description

#### Scenario: Edit task description in detail panel
- **GIVEN** the task detail panel is open
- **WHEN** the user clicks on the description area and types a new description
- **AND** clicks the Save button
- **THEN** the updated description is saved and visible in the detail panel

#### Scenario: Delete task from detail panel
- **GIVEN** the task detail panel is open for a task
- **WHEN** the user clicks the delete or archive action
- **THEN** the task is removed from the board column

#### Scenario: Drag task between columns changes status
- **GIVEN** a task is in the Todo column
- **WHEN** the user drags the task card to the In Progress column
- **THEN** the task moves to the In Progress column
- **AND** the task is no longer visible in the Todo column

#### Scenario: Drag reorder tasks within a column
- **GIVEN** a column contains multiple tasks
- **WHEN** the user drags a task above another task in the same column
- **THEN** the task order within the column changes to reflect the new position

#### Scenario: Loading state while board fetches data
- **GIVEN** the user navigates to a project board
- **WHEN** the board data is being fetched
- **THEN** a loading indicator is displayed until the board renders

#### Scenario: Error state when board fails to load
- **GIVEN** the board data fetch encounters a network or server error
- **WHEN** the board attempts to render
- **THEN** an error message or empty state is displayed instead of columns

> Note: Error state behavior has limited E2E test coverage; may be a gap.

#### Scenario: Real-time update when another user creates a task
- **GIVEN** the board is open and connected via WebSocket
- **WHEN** another user or agent creates a task in the same project
- **THEN** the new task appears on the board without requiring a manual refresh

#### Scenario: Real-time update when another user moves a task
- **GIVEN** the board is open and connected via WebSocket
- **WHEN** another user or agent moves a task to a different column
- **THEN** the board reflects the new column placement without requiring a manual refresh

> Note: WebSocket broadcast for board updates is also relevant to real-time sync behavior across the app.

#### Scenario: Task card has drag handle for reordering
- **GIVEN** a task card is visible on the board
- **WHEN** the user looks at the task card
- **THEN** a drag handle element is visible for initiating drag operations

### Requirement: KANBAN-02 — Workflows -- Approvals, Filters, Agent Assignment & Settings

The system SHALL support approval workflows for task transitions, filtering tasks by status/priority/agent, managing board settings, board memory entries, and viewing tasks across multiple project boards.

#### Scenario: Approval banner visible on tasks pending approval
- **GIVEN** a task has a pending approval for a status transition
- **WHEN** the board renders
- **THEN** the task card displays an approval required banner

#### Scenario: Review button opens approval modal
- **GIVEN** a task card shows an approval required banner
- **WHEN** the user clicks the Review button on the banner
- **THEN** an approval review modal opens

#### Scenario: Approval modal shows confidence score and justification
- **GIVEN** the approval review modal is open
- **WHEN** the modal content loads
- **THEN** the modal displays the confidence score as a percentage
- **AND** the modal displays the justification text

#### Scenario: Approve action closes modal and moves task
- **GIVEN** the approval review modal is open with Approve and Reject buttons visible
- **WHEN** the user clicks the Approve button
- **THEN** the modal closes
- **AND** the task transitions to the target status column

#### Scenario: Reject action closes modal and returns task
- **GIVEN** the approval review modal is open
- **WHEN** the user clicks the Reject button
- **THEN** the modal closes
- **AND** the task remains in its current column

#### Scenario: Status filter narrows visible tasks
- **GIVEN** the board has tasks in multiple columns
- **WHEN** the user selects a specific status from the status filter dropdown
- **THEN** only tasks matching that status are visible
- **AND** tasks in other columns are hidden

#### Scenario: Priority filter shows only matching priority
- **GIVEN** the board has tasks with different priority levels
- **WHEN** the user selects a priority level from the priority filter dropdown
- **THEN** only tasks with the matching priority are visible
- **AND** tasks with other priorities are hidden

#### Scenario: Agent filter shows only assigned tasks
- **GIVEN** the board has tasks assigned to different agents and some unassigned
- **WHEN** the user types an agent name in the assigned-to filter input
- **THEN** only tasks assigned to that agent are visible
- **AND** unassigned tasks and tasks assigned to other agents are hidden

#### Scenario: Clear filters button resets all filters
- **GIVEN** one or more filters are active on the board
- **WHEN** the user clicks the Clear filters button
- **THEN** all filters are reset
- **AND** all tasks across all columns become visible again

#### Scenario: Board settings panel opens via gear button
- **GIVEN** the board is rendered
- **WHEN** the user clicks the settings gear button
- **THEN** the board settings panel opens

#### Scenario: Toggle require approval setting
- **GIVEN** the board settings panel is open
- **WHEN** the user toggles the "Require approval to mark as Done" checkbox
- **THEN** the checkbox state changes to reflect the new value

#### Scenario: Board settings persist after close and reopen
- **GIVEN** the user has toggled a setting and saved
- **WHEN** the user closes and reopens the board settings panel
- **THEN** the previously toggled setting retains its saved value

#### Scenario: Cancel settings discards changes
- **GIVEN** the board settings panel is open with unsaved changes
- **WHEN** the user clicks the Cancel button
- **THEN** the settings panel closes without saving the changes

#### Scenario: Board memory panel shows entries
- **GIVEN** a board has memory entries stored
- **WHEN** the user opens the Board Memory pane
- **THEN** the memory entries are listed with their content

#### Scenario: Add new memory entry with tags
- **GIVEN** the Board Memory pane is open
- **WHEN** the user types a memory entry in the textarea and fills in comma-separated tags
- **AND** clicks the Save button
- **THEN** the new memory entry appears in the memory list

#### Scenario: AllBoardsPane shows tasks across multiple projects
- **GIVEN** multiple projects have kanban boards with tasks
- **WHEN** the user navigates to the All Boards view
- **THEN** tasks from all projects are visible in a combined view

#### Scenario: Project label badges on cards in AllBoardsPane
- **GIVEN** the All Boards view is showing tasks from multiple projects
- **WHEN** the user views task cards
- **THEN** each task card displays a project label badge indicating which project it belongs to

#### Scenario: Task escalation indicator on card
- **GIVEN** a task has been escalated
- **WHEN** the board renders
- **THEN** the task card displays an escalation indicator

> Note: Task escalation feature exists in the source code but has limited E2E test coverage; may be a gap.

#### Scenario: Dismiss escalation on task
- **GIVEN** a task card shows an escalation indicator
- **WHEN** the user dismisses the escalation
- **THEN** the escalation indicator is removed from the task card

> Note: Escalation dismissal exists in the source code but has limited E2E test coverage; may be a gap.

### Requirement: KANBAN-03 — Board Memory & Tags

The system SHALL provide a board memory panel that lists stored memory entries with tags, supports adding new entries with comma-separated tags, displays entry metadata with timestamps and source, synchronizes in real-time via WebSocket, and shows an empty state when no entries exist.

#### Scenario: Board memory panel displays entry count in header
- **GIVEN** the board memory panel is open for a project
- **WHEN** memory entries exist
- **THEN** the header shows "Board Memory" with a count in parentheses (e.g., "(5)")

#### Scenario: Memory entries display content and tags
- **GIVEN** memory entries are loaded in the board memory panel
- **WHEN** the entries render
- **THEN** each entry shows its text content in a bordered card
- **AND** each entry displays its tags as colored badges above the content
- **AND** tag colors are assigned based on tag name (decision=amber, plan=blue, handoff=purple, summary=green)

#### Scenario: Memory entries show relative timestamp and source
- **GIVEN** memory entries are displayed
- **WHEN** the user views an entry
- **THEN** a relative timestamp appears (e.g., "5m ago", "2h ago")
- **AND** the source label (e.g., "user") is displayed if present

#### Scenario: Empty state shown when no memory entries exist
- **GIVEN** the board memory panel is open
- **WHEN** no memory entries have been stored
- **THEN** an italic placeholder message is displayed: "No memory entries yet. Agents will store decisions, plans, and handoffs here."

#### Scenario: Adding a memory entry with content and tags
- **GIVEN** the board memory panel is open
- **WHEN** the user types content in the textarea and enters comma-separated tags in the tags input
- **AND** clicks the "Save" button
- **THEN** the entry is created via boardMemoryApi.create with the content, parsed tags, and source "user"
- **AND** the textarea and tags input clear after successful save
- **AND** a "Saved" confirmation appears briefly

#### Scenario: Save button is disabled when content is empty
- **GIVEN** the board memory panel add form is visible
- **WHEN** the content textarea is empty
- **THEN** the Save button is disabled with reduced opacity
- **AND** clicking it has no effect

#### Scenario: Keyboard shortcut submits memory entry
- **GIVEN** the content textarea has text entered
- **WHEN** the user presses Cmd+Enter (or Ctrl+Enter)
- **THEN** the memory entry is submitted without clicking the Save button

#### Scenario: Save error displays temporary error message
- **GIVEN** the user submits a new memory entry
- **WHEN** the API call fails
- **THEN** a red "Failed to save memory" error message appears
- **AND** the error message disappears after 3 seconds

#### Scenario: WebSocket message adds new entry in real-time
- **GIVEN** the board memory panel is open and connected via WebSocket
- **WHEN** a "board:memory_added" WebSocket message arrives for the same project
- **THEN** the new memory entry appears at the top of the memory list without a manual refresh

#### Scenario: Refresh button reloads memory entries
- **GIVEN** the board memory panel is open
- **WHEN** the user clicks the refresh button in the header
- **THEN** the memory entries are reloaded from the server
- **AND** the refresh icon spins during loading

### Requirement: KANBAN-04 — Extended Approvals

**Status: NOT BUILT** — The extended approval modal does not exist: no `rubricScores`, `confidenceScore` or `justification` anywhere in the client, and no `/api/approvals` route. The cure is deleting this requirement, not writing a test for it; the marker keeps the coverage gate from counting it as debt, and the gate fails if a test ever claims it.

The system SHALL provide an approval review modal that displays task information, status transition, confidence score as a percentage bar, rubric scores, justification text, an optional reviewer comment field, and Approve/Reject action buttons with metadata.

#### Scenario: Approval modal displays task information
- **GIVEN** the approval review modal is open
- **WHEN** the modal content renders
- **THEN** the task text or task ID is displayed under a "Task" heading
- **AND** the modal title reads "Review Approval"

#### Scenario: Approval modal shows status transition
- **GIVEN** the approval has fromStatus and toStatus fields
- **WHEN** the modal renders
- **THEN** a "Status Change" section shows the transition as "fromStatus -> toStatus"
- **AND** the target status is displayed in bold

#### Scenario: Confidence score renders as percentage bar
- **GIVEN** the approval has a confidenceScore value
- **WHEN** the modal renders
- **THEN** a horizontal progress bar fills to the confidence percentage width
- **AND** the rounded percentage number is displayed next to the bar (e.g., "85%")

#### Scenario: Rubric scores display category ratings
- **GIVEN** the approval has rubricScores with multiple categories
- **WHEN** the modal renders
- **THEN** each rubric category is listed with its name and score out of 5
- **AND** a "Rubric Scores" section header with a bar chart icon is visible

#### Scenario: Justification text is displayed in formatted area
- **GIVEN** the approval has justification text
- **WHEN** the modal renders
- **THEN** the justification appears under a "Justification" heading
- **AND** the text preserves whitespace and wrapping in a styled container

#### Scenario: Reviewer can add an optional comment
- **GIVEN** the approval review modal is open
- **WHEN** the user types text in the comment textarea
- **THEN** the comment text is captured
- **AND** the comment is passed to the approve or reject callback when an action is taken

#### Scenario: Approve button calls onApprove with ID and comment
- **GIVEN** the approval review modal is open
- **WHEN** the user clicks the "Approve" button
- **THEN** the onApprove callback is invoked with the approval ID and the optional comment
- **AND** the button displays a shield-check icon next to "Approve"

#### Scenario: Reject button calls onReject with ID and comment
- **GIVEN** the approval review modal is open
- **WHEN** the user clicks the "Reject" button
- **THEN** the onReject callback is invoked with the approval ID and the optional comment
- **AND** the button displays a shield-x icon with red styling

#### Scenario: Escape key closes the approval modal
- **GIVEN** the approval review modal is open
- **WHEN** the user presses the Escape key
- **THEN** the modal closes via the onClose callback

#### Scenario: Clicking backdrop closes the approval modal
- **GIVEN** the approval review modal is open
- **WHEN** the user clicks on the dark overlay outside the modal content
- **THEN** the modal closes via the onClose callback

#### Scenario: Modal shows requester and timestamp metadata
- **GIVEN** the approval review modal is open
- **WHEN** the user views the footer area
- **THEN** the text "Requested by [name]" is displayed with the creation timestamp
- **AND** if an expiration date exists it is shown as "Expires [date]"

### Requirement: KANBAN-05 — Gate di consegna umano (Review → Done)

> Promoted verbatim from `openspec/changes/kanban-agent-authoring/`, which was never archived. It ships: `review_needs_summary` (409) is in `server/routes/tasks.ts:65`, `reviewed_by` is written on approval, and `tests/e2e/board.spec.ts` BOARD-05 covers the gate.
> The text is kept in the original Italian on purpose: promoting it is a move,
> not a rewrite, and a translation would be a second chance to drift from what
> the tests actually pin.

Un agente SHALL NOT poter portare un task a `done`. Il completamento da parte di un agente
SHALL spostare il task in `review` e registrare un'approvazione pendente. La transizione
`review → done` SHALL essere consentita solo a un attore umano. Un rifiuto SHALL riportare
il task a `in_progress` e registrare un commento.

Una consegna SHALL NOT essere muta: un agente non può portare un task in `review` se il
thread non contiene almeno un suo commento (autore ≠ `user`/`system`) — la card in review
mostra sempre l'ultima parola dell'agent (KANBAN-04) e senza commenti l'umano deciderebbe
alla cieca. Il rifiuto (`review_needs_summary`, 409) SHALL istruire l'agent a postare una
sintesi di 1-2 frasi e riprovare. Unica eccezione al gate `done`: gli **step propri**
(KANBAN-08), che l'agent chiude direttamente.

#### Scenario: la consegna muta è rifiutata
- **GIVEN** un task lavorato da un agent senza alcun suo commento nel thread
- **WHEN** l'agent chiama `update_task(status='review')`
- **THEN** l'operazione è rifiutata (`review_needs_summary`) con istruzioni per la sintesi
- **AND** dopo `comment_task(<sintesi>)` la stessa transizione riesce

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

> Promoted verbatim from `openspec/changes/kanban-agent-authoring/`. It ships: `scope: 'project' | 'all'` is an argument of the MCP `list_tasks` tool (`server/mcp/topics-mcp-server.ts:261`), covered by BOARD-07 and BOARD-19.
> The text is kept in the original Italian on purpose: promoting it is a move,
> not a rewrite, and a translation would be a second chance to drift from what
> the tests actually pin.

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

> Promoted verbatim from `openspec/changes/kanban-agent-authoring/`. It ships: the global switch lives on the reserved `project_id='*'` row behind `/api/all-boards/settings` (`server/routes/tasks.ts:1985`), covered by BOARD-06 and BOARD-08.
> The text is kept in the original Italian on purpose: promoting it is a move,
> not a rewrite, and a translation would be a second chance to drift from what
> the tests actually pin.

L'interruttore di avvio (`auto_dispatch`) SHALL essere **globale** — un solo switch per
tutte le board (riga riservata `board_settings.project_id='*'`), esposto come toggle
nell'header di ogni board **inclusa la board generale** (il click sul pill È il toggle;
`GET/PATCH /api/all-boards/settings`, broadcast `board:dispatch` a ogni client). Quando
è attivo, un task che entra in `todo` (trascinato O creato direttamente lì da un umano)
SHALL innescare, dopo una finestra di grazia anti drag-through, il claim atomico del
task e l'avvio di un agent headless dedicato in una chat tab detached, isolato in un
git worktree quando `dispatch_use_worktree` è attivo. Cap di concorrenza, effort,
worktree e timeout restano **per board**. Il numero di agent concorrenti per board
SHALL essere limitato da `max_agents`; i tentativi per task da un retry-cap. L'agent
lavora fino a `review` (mai `done`, KANBAN-05). Con il flag disattivo (default) nessuno
spawn SHALL avvenire e nessun chip di dispatch SHALL comparire. La guardia
anti-ricorsione è strutturale: gli agent creano solo in `backlog` (KANBAN-03), quindi
il lavoro accodato da un worker non è mai auto-eleggibile.

Feedback SHALL essere sempre visibile sulla card: `queued → starting → working →
needs_input | delivered` via `dispatch_state`, e ogni interruzione (worktree impossibile,
progetto non risolvibile, turno morto, retry esauriti) SHALL parcheggiare il task con il
motivo in `dispatch_error` E un commento nel thread — mai un fallimento silenzioso solo
nei log. In review i due esiti sono distinti: `needs_input` ("serve te") quando l'ultima
parola dell'agent è un question block (risposta richiesta), `delivered` ("consegnato")
quando la consegna è pulita e attende solo l'approvazione.

Un turno che termina senza raggiungere `review` con il task ancora `in_progress` e il
topic ancora legato (tipicamente il timeout wall-clock che taglia un agent al lavoro)
SHALL **continuare sulla stessa sessione**: bump del tentativo (stesso retry-cap),
commento di sistema nel thread, e resume dello stesso topic/worktree con un nudge di
continuazione ("riprendi da dove eri, non ricominciare") — MAI un release+re-claim che
scarta la conversazione e fa ripartire l'agent da zero. Il parcheggio in `backlog`
avviene solo a cap esaurito. Il topic dell'agent SHALL nascere **background**
(archiviato = chiuso nel modello 2-stati): visibile in sidebar, MAI una tab che si
apre da sola su ogni client; la tab si apre solo dal bottone del task (che de-archivia)
e chiuderla non ferma la sessione.

Ogni task SHALL poter portare un **override di modello** (`tasks.model`, NULL = auto =
default del provider) scelto dal composer; il dispatcher lo copia sul topic alla
creazione insieme all'effort per-board.

Un input umano (risposta, reject) che arriva mentre il turno dell'agent sta ancora
terminando SHALL essere bufferizzato e consegnato sullo **stesso tab** al turn-end —
mai scartato (il task resterebbe orfano e il requeue spawnerebbe un agent nuovo senza
il contesto della conversazione). Rinominare task o step SHALL essere sempre sicuro:
il loop è id-based (kickoff, tool MCP e resume referenziano gli id, mai i titoli).

L'umano SHALL poter **fermare** un dispatch in corso (stop): il task è parcheggiato
(backlog + motivo nel thread) PRIMA del taglio del turno, così il turn-end trova il
task già spostato e NON ri-accoda un nuovo tentativo. Un task creato con
**plan_first** SHALL istruire l'agent a consegnare un piano sintetico in review
(question block "Approva il piano"/"Da rivedere") PRIMA di implementare; l'agent
implementa solo al resume con l'approvazione.

#### Scenario: stop umano di un dispatch in corso
- **GIVEN** un task con un agent al lavoro (chip working)
- **WHEN** l'umano preme Ferma
- **THEN** il task va in backlog con "Fermato da te" nel thread, il turno è abortito
- **AND** nessun nuovo tentativo parte da solo

#### Scenario: plan first
- **GIVEN** un task creato con plan_first
- **WHEN** l'agent parte
- **THEN** consegna un piano in review con quick-reply (senza implementare nulla)
- **AND** implementa solo dopo l'approvazione del piano

#### Scenario: task in todo parte da solo (flag on)
- **GIVEN** una board con `auto_dispatch` attivo
- **WHEN** un task entra in `todo` e vi resta oltre la finestra di grazia
- **THEN** il task è claimato (`in_progress`, chip `working`) e un agent lavora in una
  tab dedicata raggiungibile dalla card ("apri tab")
- **AND** alla consegna il task è in `review` con chip `serve te`

#### Scenario: nessun dispatch con flag off
- **GIVEN** l'interruttore globale `auto_dispatch` disattivo (default)
- **WHEN** un task viene creato o trascinato in `todo` su qualsiasi board
- **THEN** nessun agente viene spawnato automaticamente
- **AND** l'header della board mostra che l'auto-dispatch è spento

#### Scenario: il toggle è globale
- **GIVEN** l'interruttore spento e due board aperte (una di progetto e la generale)
- **WHEN** l'umano clicca il pill "agent: off" su una qualsiasi delle due
- **THEN** l'interruttore si accende per TUTTE le board e ogni header aperto si aggiorna
  (broadcast, non refresh)

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

#### Scenario: timeout a metà lavoro = continuazione, non restart
- **GIVEN** un task `in_progress` il cui turno viene tagliato dal timeout wall-clock
- **WHEN** il turn-end trova il task ancora in_progress col topic legato
- **THEN** il tentativo è incrementato e l'agent riprende SULLA STESSA sessione
  (stesso topic, stesso worktree) con un nudge di continuazione
- **AND** il thread mostra "l'agent continua sulla stessa sessione (tentativo n/cap)"
- **AND** solo a cap esaurito il task è parcheggiato in backlog

#### Scenario: la sessione agent non apre tab da sola
- **GIVEN** un dispatch che crea il topic dell'agent
- **WHEN** il topic nasce
- **THEN** nasce archiviato (background): nessuna tab spunta nella tabbar di alcun client
- **AND** il bottone "apri tab" del task lo de-archivia e apre la tab on demand

### Requirement: KANBAN-08 — Task annidati (subtask a cascata)

> Promoted verbatim from `openspec/changes/kanban-agent-authoring/`. It ships: `parent_task_id` arrived with migration 034 and the board columns list root tasks only (`server/services/tasks.ts:456`), covered by BOARD-10.
> The text is kept in the original Italian on purpose: promoting it is a move,
> not a rewrite, and a translation would be a second chance to drift from what
> the tests actually pin.

Un task SHALL poter contenere sottotask a profondità illimitata (`parent_task_id`
self-referential, FK). Il parent SHALL essere impostato solo alla creazione (niente
re-parenting), rendendo i cicli impossibili per costruzione. Il parent SHALL vivere sulla
stessa board del figlio. Un task con sottotask aperti SHALL NOT poter passare a `done`
(qualsiasi attore, update o approvazione). L'archiviazione di un parent SHALL archiviare
ricorsivamente l'intero sottoalbero. I sottotask NON SHALL comparire come card sulle
colonne (né board di progetto né board generale: il feed è root-only) — vivono
nell'albero del dettaglio del padre e nel contatore di card (`↳ fatti/totali`); il
detail SHALL mostrare i sottotask come **albero** (espansione lazy, profondità
illimitata) con quick-add e navigazione padre↔figlio. Il dispatcher NON SHALL mai
claimare uno step come task indipendente (un sottotask in `todo` non accoda niente e
non mostra chip): il lavoro di uno step appartiene all'agent del suo root.

I sottotask del task assegnato a un agent sono la sua **checklist di step**: l'agent
dispatched SHALL crearli come piano visibile e SHALL poterli marcare `done` lui stesso
— unico carve-out al gate KANBAN-05, ristretto ai **discendenti stretti** del task
legato al suo topic (`assigned_topic_id`). Il deliverable (il task assegnato) resta
dietro il gate umano; il gate `open_subtasks` sull'approve garantisce che alla consegna
tutti gli step risultino smarcati.

Ogni sottotask ha il **proprio thread** di discussione (agent e umano possono
commentare lo step specifico). Un commento umano su un task il cui root di dispatch
(il più vicino antenato — o il task stesso — con `assigned_topic_id`) è in `review`
SHALL ri-kickare lo stesso agent con il testo e il riferimento allo step — stessa
semantica della risposta sul task principale: la risposta specifica non è mai un
commento passivo mentre il chip dice "serve te".

#### Scenario: gli step non sono card
- **GIVEN** un task con sottotask
- **WHEN** l'umano guarda le colonne (progetto o board generale)
- **THEN** vede solo il task root col contatore `↳ n/m`; gli step compaiono solo
  nell'albero del dettaglio
- **AND** uno step trascinato in `todo` non avvia nessun agent e non mostra chip

#### Scenario: sottotask annidati a più livelli
- **GIVEN** un task A
- **WHEN** viene creato B con parent A, e C con parent B
- **THEN** `get_task(A)` elenca B e `get_task(B)` elenca C

#### Scenario: il parent non si chiude con figli aperti
- **GIVEN** un task con un sottotask non-done
- **WHEN** qualcuno tenta `done` (update o approve)
- **THEN** l'operazione è rifiutata (`open_subtasks`) finché i figli non sono completati
  o archiviati

#### Scenario: archive a cascata
- **GIVEN** un albero A → B → C
- **WHEN** A viene archiviato
- **THEN** B e C risultano archiviati

#### Scenario: l'agente spezza un task grande
- **GIVEN** un agent che lavora il task T
- **WHEN** chiama `create_task(text=..., parent_task_id=T)`
- **THEN** il sottotask nasce in `backlog` sotto T (l'umano decide se e quando mandarlo
  in lavorazione)

#### Scenario: l'agente smarca i propri step
- **GIVEN** il task T assegnato all'agent A (topic bound) con step S figlio di T
- **WHEN** A chiama `update_task(task_id=S, status='done')`
- **THEN** S passa a `done` (carve-out: S è un discendente stretto di T)
- **AND** lo stesso update su T stesso resta rifiutato (`agent_cannot_complete`)

#### Scenario: il carve-out non attraversa i task altrui
- **GIVEN** un task U non discendente del task assegnato all'agent A
- **WHEN** A tenta `update_task(task_id=U, status='done')`
- **THEN** l'operazione è rifiutata (`agent_cannot_complete`)

#### Scenario: rispondere sul thread di uno step ri-kicka l'agent
- **GIVEN** il task T assegnato all'agent A, in `review`, con step S figlio di T
- **WHEN** l'umano commenta sul thread di S
- **THEN** T torna `in_progress` e A riparte con il testo e il riferimento a S
- **AND** lo stesso commento con T già `in_progress` resta una nota nel thread di S

#### Scenario: aggiungere uno step a un task in review È l'assegnazione
- **GIVEN** il task T assegnato all'agent A, in `review`
- **WHEN** l'umano crea un sottotask sotto T (o sotto un suo step)
- **THEN** T torna `in_progress` e A riparte con il riferimento al nuovo step —
  nessun commento "fai anche X" richiesto
- **AND** con T in lavorazione il nuovo step atterra nell'albero e il resume prompt
  istruisce A a rileggere il task (get_task) prima di riprendere

### Requirement: KANBAN-09 — L'anteprima del risultato nel pannello di review

Una card può portare un `outputUrl`: l'indirizzo di ciò che il lavoro ha
prodotto, mostrato **dentro un iframe** nel pannello di review, così che chi
approva veda il risultato invece di doverselo andare a cercare.

Il sistema DEVE accettare **solo** schemi `http` e `https`. Il valore finisce in
un iframe, quindi non è un campo di testo qualunque: `file://` sarebbe una
lettura di file locale, `javascript:` sarebbe esecuzione di codice nella pagina
della board. Un valore che non è un URL http(s) DEVE essere rifiutato con un
errore che dice perché.

Una stringa vuota (o `null`) DEVE cancellare il campo, non salvare la stringa
vuota: «nessuna anteprima» è l'assenza del riquadro, non un iframe su niente.

Il valore DEVE sopravvivere alla lettura: quello che torna da `get()` è quello
che è stato scritto.

> Nota su come questo requisito è stato ritrovato. Non era stato mai scritto —
> era stato **tolto**: `server/services/tasks.test.ts` contiene
> `describe("outputUrl (KANBAN-09 review panel)")` e la spec saltava da
> `KANBAN-08` a `KANBAN-10`. Il test ha continuato a provarlo per tutto il
> tempo. È emerso il 25/08/2026 dalla passata di tracciabilità che lega i test
> ai requisiti, ed è il caso limite di ciò che quel lavoro cerca: non una
> funzionalità senza requisito, ma un requisito **cancellato** sotto un test
> ancora vivo.

#### Scenario: un URL http(s) si salva e si rilegge

- **GIVEN** una card
- **WHEN** le si assegna `outputUrl` = `http://localhost:5173/preview`
- **THEN** il valore torna identico dalla lettura della card

#### Scenario: uno schema diverso da http(s) viene rifiutato

- **GIVEN** una card
- **WHEN** le si assegna `file:///etc/passwd`, `javascript:alert(1)`, `ftp://x`
  o una stringa che non è un URL
- **THEN** la scrittura fallisce e l'errore nomina http(s)

#### Scenario: la stringa vuota cancella l'anteprima

- **GIVEN** una card con un `outputUrl` impostato
- **WHEN** le si assegna la stringa vuota
- **THEN** il campo torna nullo

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

### Requirement: KANBAN-11 — Le rivendicazioni di un rapporto di consegna SI VERIFICANO

Un audit di tutti i task `done` raggiungibili (2026-08-25) ha trovato **14 carte
chiuse senza che il lavoro esistesse**, con una firma che si ripete: migration
"rinumerate" su slot occupati da altre feature, commit di consegna che rispondono
`fatal: bad object`, e verifiche indipendenti che confermano nel dettaglio cose
che non ci sono. La causa non è che l'agente non abbia lavorato: è che **nessun
punto del flusso apre un file per controllare**.

Il sistema DEVE poter verificare meccanicamente le rivendicazioni contenute in un
rapporto di consegna, senza esprimere giudizi sulla qualità del lavoro:

1. ogni sha citato DEVE risolvere a un commit esistente in un qualsiasi ref;
2. ogni migration citata DEVE esistere, e il suo contenuto DEVE nominare almeno
   uno dei simboli che il rapporto dichiara di aver scritto — il solo numero non
   basta, perché lo slot può appartenere a un'altra feature;
3. ogni percorso citato DEVE esistere, e una riga citata (`file:riga`) DEVE
   contenere almeno uno dei simboli dichiarati;
4. almeno uno dei simboli dichiarati DEVE comparire in un commit di tutta la
   storia (`git log --all -S`).

Un rapporto che non cita **niente di verificabile** NON DEVE essere trattato come
un rapporto che ha superato i controlli: "niente da controllare" e "controllato e
a posto" sono fatti diversi, e confonderli è il modo in cui un cancello diventa
decorazione.

I controlli NON DEVONO esprimersi su completezza, qualità o significato dei test.
Rispondono a una domanda sola: **l'evidenza che il rapporto cita esiste?**

I controlli catturano le carte che hanno MENTITO sull'evidenza. NON catturano
una carta chiusa su un'intenzione (un piano approvato, una sonda armata e mai
letta), perché lì non c'è niente da cercare. Quella metà della firma richiede
uno strumento diverso, e fingere il contrario qui sarebbe la terza forma del
difetto: una verifica che conferma ciò che non ha esaminato.

> Nota sul banco: la barra di questo requisito non è un esempio inventato. I
> rapporti storici delle carte riaperte sono conservati in
> `tests/fixtures/delivery-reports-reopened.json`, testualmente come furono
> scritti. Delle 14 carte riaperte, **sette** hanno nel thread una
> rivendicazione di consegna (uno sha, o un numero di migration): quelle sono
> il banco, e vanno bocciate tutte e sette. Le altre sette ne restano fuori con
> una ragione dichiarata, non perché assolte. Un primo giro allargava il banco
> a chiunque nominasse un percorso e arrivava a «13 su 13»: sembrava più forte
> e valeva meno, perché due di quelle carte venivano bocciate per ragioni che
> non le riguardavano.

#### Scenario: un commit citato che non esiste viene rilevato

- **GIVEN** un rapporto che dichiara "Fatto (commit 6dc39750)"
- **AND** quello sha non risolve in nessun ref del repository
- **WHEN** il rapporto viene verificato
- **THEN** il rilievo nomina lo sha e dice che non esiste

#### Scenario: una migration esistente ma di un'altra feature viene rilevata

- **GIVEN** un rapporto che dichiara "migration rinumerata 054→055" insieme a un
  simbolo che afferma di aver introdotto
- **AND** `055-*.sql` esiste ma non nomina quel simbolo
- **WHEN** il rapporto viene verificato
- **THEN** il rilievo dice che lo slot è occupato da un'altra feature

#### Scenario: un simbolo mai comparso in nessun commit viene rilevato

- **GIVEN** un rapporto che dichiara di aver introdotto uno o più simboli
- **AND** nessuno di essi compare in un commit di tutta la storia
- **WHEN** il rapporto viene verificato
- **THEN** il rilievo dice che nessun simbolo dichiarato è mai stato scritto

#### Scenario: un rapporto senza rivendicazioni non passa in silenzio

- **GIVEN** un rapporto che dice soltanto "Fatto, tutto verde"
- **WHEN** il rapporto viene verificato
- **THEN** il rilievo dichiara che non c'era niente da verificare

#### Scenario: una consegna onesta non viene accusata

- **GIVEN** un rapporto che cita un commit esistente, un file esistente e un
  simbolo presente nella storia
- **WHEN** il rapporto viene verificato
- **THEN** non viene prodotto nessun rilievo

### Requirement: KANBAN-12 — La topbar della board ha UNA linea in meno e UNA porta sola

Tre vincoli sulla barra in cima alla board Kanban. Due sono **rimozioni**, ed è
per questo che hanno bisogno di un test: una rimozione è la cosa più facile da
reintrodurre per sbaglio, perché niente, nel codice, dice che era voluta.

1. **Sotto la barra non c'è nessuna linea.** Né sull'elemento della toolbar né
   sul contenitore che la avvolge: le strisce che compaiono sotto (filtri
   attivi, banda d'errore) portano già il proprio bordo, e una riga in più qui
   ne disegnava due attaccate.
2. **Una sola porta alle impostazioni**, il ⚙ a destra. Il menu ▾ accanto al
   titolo era un secondo ingresso alle stesse impostazioni, e teneva una copia
   PROPRIA dello stato dell'auto-dispatch: restava indietro quando l'altro
   pannello lo cambiava. Due tasti per la stessa domanda, e due risposte
   diverse. La rimozione è sicura solo perché il pannello del ⚙ contiene già
   quel blocco (`GlobalCapControl`) su ogni board, anche quella generale.
3. **I suggerimenti progetto stanno dentro il selettore progetto**, in un
   componente solo (`ProjectFilterPicker.tsx`), con un fondino dichiarato in
   **entrambi** i temi e chip di misura uniforme, dichiarata una volta sola.

> Nota su come si verifica: `KanbanBoardPane` non si monta sotto `bun test`
> (store, layout, API, una dozzina di hook), quindi i vincoli si leggono sulla
> struttura del sorgente — il metodo di casa, lo stesso di
> `slashCommandRouting.test.ts` e `kanbanChipMetrics.test.ts`. Il test ignora i
> commenti: due criteri su tre sono rimozioni, e la nota che RACCONTA una
> rimozione nomina per forza la cosa rimossa. Un test che vietasse il carattere
> `▾` nel sorgente grezzo accuserebbe proprio la documentazione che protegge il
> criterio.

#### Scenario: la barra riguadagna un bordo inferiore

- **GIVEN** l'elemento `board-toolbar`, o il contenitore che lo avvolge
- **WHEN** vi compare una classe `border-b` (o un bordo scritto a mano)
- **THEN** il vincolo è violato e il test è rosso

#### Scenario: compare un secondo ingresso alle impostazioni

- **GIVEN** la barra della board
- **WHEN** più di un elemento cambia lo stato del pannello impostazioni
- **THEN** il vincolo è violato

> Nota: le chiamate `onClose` non contano — chiudere non è una porta, e ce n'è
> una per ciascuno dei due pannelli possibili.

#### Scenario: il fondino del selettore esiste in un tema solo

- **GIVEN** la superficie sollevata del `ProjectFilterPicker`
- **WHEN** è dichiarata solo `bg-white/N` senza la metà `bg-black/N`
- **THEN** il vincolo è violato: nel tema chiaro sarebbe bianco su bianco

#### Scenario: i chip tornano a misura variabile

- **GIVEN** le larghezze massime dichiarate in `ProjectFilterPicker.tsx`
- **WHEN** sono zero, oppure sono più di una e diverse fra loro
- **THEN** il vincolo è violato
