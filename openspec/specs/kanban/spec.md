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

#### Scenario: il chip «in coda» non sopravvive all'uscita da Todo
- **GIVEN** una card con `dispatch_state = 'queued'`, cioè la promessa «il dispatcher ti prende fra poco»
- **WHEN** la card viene spostata FUORI da Todo, verso qualunque altra colonna
- **THEN** il chip e il suo motivo (`dispatch_error`, la frase che il badge dice a voce alta) SHALL spegnersi ENTRAMBI nella STESSA scrittura che sposta la card, e comparire già spenti nel task che quella scrittura restituisce
- **AND** il motivo non SHALL sopravvivere al chip: una riga che porta «tetto agenti pieno» senza più una coda dietro è la stessa bugia in corpo minore
- **AND** questo SHALL valere anche dopo un riavvio del server, perché la regola sta nella scrittura e non in un timer tenuto in memoria
- **AND** `todo → todo` NON è un'uscita: una PATCH che ripassa lo stesso stato lascia la card in coda

#### Scenario: un turno vivo non si nasconde
- **GIVEN** una card con `dispatch_state` `starting` o `working`, cioè un agente che può essere davvero partito
- **WHEN** la card viene trascinata in un'altra colonna
- **THEN** il chip SHALL restare, e con lui il comando «Ferma», che è l'unico che serve
- **AND** lo stesso SHALL valere per i chip che descrivono un parcheggio (`waiting`, `failed`, `blocked`, `stopped`): non sono una coda

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

### Requirement: KANBAN-13 — Il fan-out apre N strade sullo stesso task, e nessuna delle N è privilegiata

Quando la board lo chiede, il sistema SHALL far partire fino a `MAX_FANOUT`
tentativi PARALLELI sullo stesso task, ciascuno con il proprio worktree e la
propria chat, e tutti sulla stessa card. Un tentativo è un'ALTERNATIVA, non un
pezzo: sono mutuamente esclusivi, e per questo non sono dei sottotask — una
checklist va completata tutta, e renderebbe il task non approvabile per
costruzione.

Tutti i tentativi di un fan-out SHALL girare sullo STESSO modello. Variarlo
renderebbe il confronto un esperimento su due variabili insieme: il fan-out
confronta STRADE, non fornitori.

Il contratto di un tentativo SHALL vietargli di scrivere sul filo condiviso e di
muovere lo stato della card, e il divieto SHALL essere scritto nel suo primo
messaggio. Il contratto normale e quello del fan-out sono opposti, e due
contratti nello stesso prompt fanno scegliere al modello quello che gli pare.

Mentre un tentativo è vivo, il filo e lo stato della card SHALL essere CHIUSI
anche agli agenti, e il rifiuto SHALL dire perché.

Il fan-out NON SHALL partire quando manca ciò che gli serve — nessun registro
dei tentativi, nessuna creazione di worktree — e in quel caso il dispatch SHALL
comportarsi ESATTAMENTE come un lancio singolo. Su una board che lavora IN
PLACE, il fan-out SHALL essere rifiutato e la card SHALL dirlo.

Quando il tetto di concorrenza STRINGE un fan-out senza azzerarlo, il sistema
SHALL dichiarare i due numeri: quanti erano chiesti, quanti ne partono, e quale
tetto ha deciso.

Un giro nuovo SHALL potare worktree e chat del giro precedente PRIMA di aprirne
altri.

La fotografia di un tentativo SHALL essere scattata SEMPRE, fallimento e timeout
compresi: un turno andato in timeout può aver committato lavoro buono.

Quando NESSUN tentativo ha prodotto un commit, il fan-out SHALL essere raccolto
per intero e la card SHALL tornare in coda dicendo che nessuno ha prodotto
modifiche committate — non SHALL arrivare in review.

#### Scenario: un ospite senza registro dei tentativi
- **GIVEN** un host senza il registro dei tentativi o senza creazione di worktree
- **THEN** SHALL partire un agente solo, e il comportamento SHALL essere quello
  di prima byte per byte

#### Scenario: una board in place
- **GIVEN** una board che non usa worktree e un fan-out maggiore di uno
- **THEN** SHALL partire un agente solo, e la card SHALL portarne la nota

#### Scenario: la card è chiusa mentre si corre
- **GIVEN** un tentativo ancora in corsa
- **WHEN** un agente prova a commentare o a muovere lo stato
- **THEN** SHALL essere rifiutato, e il rifiuto SHALL nominare il fan-out vivo

#### Scenario: nessuno ha committato
- **GIVEN** un fan-out i cui tentativi finiscono tutti senza un commit
- **THEN** i worktree e le chat SHALL essere raccolti
- **AND** la card SHALL tornare in coda, non in review

### Requirement: KANBAN-14 — Il vincitore lo sceglie una persona, e la scelta è definitiva

La scelta fra i tentativi SHALL essere UMANA. Il confronto che il sistema
presenta SHALL essere senza punteggio, senza «consigliato» e senza vincitore
suggerito: ordinare per righe cambiate o per velocità darebbe a un numero
l'autorità di un giudizio di merito.

Un tentativo SHALL vivere in uno di cinque stati — `running`, `delivered`,
`failed`, `selected`, `discarded` — e SHALL passare da `running` a `delivered` o
`failed` alla fine del turno, e da lì a `selected` o `discarded` per mano di chi
sceglie.

`selected` e `discarded` SHALL essere TERMINALI: un turno zombie che si sveglia
dopo la decisione NON SHALL poterne riscrivere l'esito, altrimenti il fan-out si
riaprirebbe dopo che una persona ha già deciso.

Scegliere SHALL essere una transazione sola: un vincitore e tutti gli altri
scartati insieme. Una seconda scelta SHALL poter ribaltare la prima, e in nessun
istante SHALL esistere due vincitori.

Scegliere SHALL essere RIFIUTATO mentre un tentativo lavora ancora, su un
tentativo che non è mai partito, e su un tentativo che appartiene a un'altra
card.

Ai perdenti SHALL essere tolto il worktree e archiviata la chat: restano la loro
riga e la loro fotografia, non le loro risorse.

#### Scenario: il confronto non consiglia
- **GIVEN** più tentativi conclusi
- **THEN** il testo del confronto NON SHALL contenere un punteggio, un
  «consigliato», un «migliore» o un «vincitore»

#### Scenario: uno zombie dopo la decisione
- **GIVEN** un tentativo già scelto o già scartato
- **WHEN** il suo turno prova a chiudersi
- **THEN** lo stato SHALL restare quello deciso

#### Scenario: si sceglie a corsa finita
- **GIVEN** un tentativo ancora in corsa
- **THEN** la scelta SHALL essere rifiutata

### Requirement: KANBAN-15 — Prima della review i comandi girano, e un rosso che non ha misurato niente non è un rosso

Una board SHALL poter dichiarare fino a `MAX_CHECKS` comandi che una consegna
deve far passare prima di entrare in review. I comandi SHALL essere DICHIARATI da
una persona nelle impostazioni della board: nessun default SHALL essere dedotto
dal progetto. SHALL girare nel worktree DELLA CONSEGNA, in sequenza e
nell'ordine dichiarato, e SHALL fermarsi al primo rosso.

Quando al worktree mancano le dipendenze, il sistema SHALL installarle PRIMA dei
comandi dichiarati. Senza, i cancelli morivano su un'uscita 127 indistinguibile
da un rosso vero — otto task in un giorno, il 13/08/2026.

Il verdetto SHALL avere TRE valori e mai due: `pass`, `fail`, `unknown`. Un
comando SCADUTO, uno che NON È PARTITO, e un elenco di esiti più corto dei
comandi dichiarati SHALL dare `unknown`. Misurato il 18/08/2026 sul database
vivo: sei card su quindici marcate `fail` erano soltanto scadute — il 40% dei
rossi accusava il codice per un guasto della macchina.

Un rosso VERO accanto a uno scaduto SHALL restare `fail`: il dubbio non
cancella una prova.

Il cancello NON SHALL vivere dentro la richiesta HTTP. Una suite può durare più
del tempo che una socket resta aperta, e quando quel tempo scadeva lo stato
restava «in corso» per sempre. Mentre i comandi girano la richiesta SHALL
rispondere «in corso» con un codice proprio, e la card SHALL restare dov'era.
Un rosso SHALL rifiutare la transizione con un codice proprio, e la card SHALL
tornare all'agente.

Le corse SHALL essere condivise per chiave: N richieste sullo stesso task
producono UN giro di comandi. Un commit diverso SHALL far rimisurare. Una corsa
che esplode SHALL liberare la chiave invece di avvelenare la successiva. Il
numero di corse simultanee SHALL avere un tetto, e il default SHALL essere UNO:
il 18/08/2026 sei barre in parallelo hanno portato il carico a 78,83 su dodici
core.

Il verdetto SHALL sopravvivere alla richiesta che l'ha chiesto per una finestra
dichiarata.

Sulla card SHALL essere scritto lo stato, gli esiti parziali e il commit
misurato. Il commento del VERDE SHALL essere una riga sola e di specie servizio:
l'elenco completo su ogni consegna verde erano 92 copie identiche in sette
giorni. Il commento del ROSSO SHALL essere per esteso e di specie ordinaria — è
la sola cosa che l'agente deve leggere.

Il progresso SHALL essere «fatti su totale» fin dal primo istante, e numeri
incoerenti SHALL essere scartati invece che mostrati.

Una configurazione illeggibile SHALL spegnere il cancello, non sollevare un
errore.

#### Scenario: un comando che non è mai partito
- **GIVEN** un worktree in cui un comando non può nemmeno avviarsi
- **THEN** l'esito SHALL essere `unknown`, non `fail`
- **AND** il testo SHALL dire che non è partito, e NON SHALL parlare di tempo massimo

#### Scenario: dieci richieste sullo stesso task
- **GIVEN** dieci richieste concorrenti sulla stessa chiave
- **THEN** SHALL girare un solo giro di comandi

#### Scenario: la configurazione è rotta
- **GIVEN** impostazioni di board illeggibili
- **THEN** il cancello SHALL essere spento, e la consegna SHALL procedere come
  su una board che non ne dichiara

### Requirement: KANBAN-16 — Un task pesante aspetta il carico NOSTRO, e non aspetta per sempre

Un task dichiarato PESANTE SHALL partire solo quando la macchina è libera, e la
misura di «libera» SHALL essere il carico prodotto DAI NOSTRI agenti — non il
carico di sistema. Il carico di sistema comprende le applicazioni di chi possiede
la macchina: la notte del 12/08/2026 stava fra 37 e 48 mentre la flotta usava
0,75 core, e frenava noi per colpa di altri.

Quando la sonda propria non risponde, il sistema SHALL ricadere sulla misura di
sistema; quando NESSUNA delle due risponde, il cancello SHALL essere DISATTIVATO.
«Non lo so» non è «no»: un cancello che si chiude senza sonda diventa una
trappola permanente su ogni host che non ne ha una.

Un pesante in attesa SHALL fermare la coda dietro di sé, e questo è voluto: se i
leggeri passassero avanti alzerebbero il carico, e la macchina non risulterebbe
mai scarica.

L'attesa SHALL avere un TETTO, superato il quale il pesante parte comunque. Un
freno senza scadenza è un task perso.

L'attesa per «un altro pesante sta lavorando» SHALL essere contata SEPARATAMENTE
da quella per il carico: sommarle farebbe scadere il tetto del carico prima che
sia mai stato valutato.

La card SHALL dire perché è ferma, e SHALL distinguere «sono io il tappo, con N
dietro» da «un altro pesante sta lavorando».

#### Scenario: carico esterno alto, flotta ferma
- **GIVEN** una macchina carica di lavoro altrui e nessun agente nostro attivo
- **THEN** il pesante SHALL partire

#### Scenario: nessuna sonda
- **GIVEN** un host senza sonde di carico
- **THEN** il cancello SHALL essere disattivato, non chiuso

#### Scenario: l'attesa è troppo lunga
- **GIVEN** un pesante fermo oltre il tetto
- **THEN** SHALL partire comunque, e la card SHALL dirlo

### Requirement: KANBAN-17 — Le etichette hanno un vocabolario chiuso, e un agente può solo alzare la mano

Un task SHALL portare etichette da un vocabolario CHIUSO di sette, divise in due
famiglie: chi CHIUDE la card (`visibile`, `decisione`, `invisibile`) e che GENERE
di lavoro è (`bugfix`, `feature`, `chore`, `misura`). Ogni etichetta SHALL
portare la propria SORGENTE — dedotta, umana, o dell'agente.

Le classi di chiusura SHALL essere TRE e non due. Con due, sette piani su
ventinove finivano nella classe che si chiude da sola: misurato l'11/08/2026 su
una coda vera, la ripartizione giusta è 21 visibili, 6 decisioni, 2 invisibili.

Un agente SHALL poter scrivere solo etichette che ALZANO la mano. `invisibile` è
la sola che toglie la revisione umana, e un agente NON SHALL potersela dare né
poter TOGLIERE una classe di chiusura già presente, nemmeno di sponda. Un
tentativo vietato SHALL far cadere l'INTERO gruppo, non solo l'etichetta
proibita: applicarne metà sarebbe obbedire a metà di una richiesta rifiutata.

Le etichette SHALL essere dedotte dai file dei commit PROPRI del task e non da
tutto il ramo, per non ereditare il lavoro di un checkout condiviso.

Una correzione UMANA su una famiglia NON SHALL essere sovrascritta dalla
consegna successiva: basta una sola etichetta non dedotta in quella famiglia
perché la deduzione lasci stare.

Il ricalcolo SHALL cancellare l'INTERA famiglia prima di riscrivere, e quando
non c'è niente da cambiare NON SHALL scrivere.

Filtrare per più etichette SHALL essere una congiunzione, e un'etichetta ignota
NON SHALL filtrare nulla — non SHALL filtrare tutto.

#### Scenario: un agente prova a nascondersi
- **GIVEN** un agente che scrive `invisibile` insieme a `bugfix`
- **THEN** SHALL essere rifiutato
- **AND** NEMMENO `bugfix` SHALL essere scritta

#### Scenario: una correzione umana e una nuova consegna
- **GIVEN** una classe di chiusura corretta a mano
- **WHEN** arriva una nuova consegna
- **THEN** la deduzione NON SHALL sovrascriverla

### Requirement: KANBAN-18 — Archiviare scende, ripristinare scende E risale

Archiviare un task SHALL archiviare tutto il suo sottoalbero: un sottotask
orfano di un padre archiviato sarebbe irraggiungibile.

Ripristinare SHALL andare in DUE direzioni — giù per tutto il sottoalbero, e SU
per tutta la catena degli antenati. Riportare un figlio senza il padre lo
riporterebbe dove nessuno lo vede.

Il ripristino SHALL riportare lo stato ORIGINALE della card: non è una
riapertura, e una card che era in review ci torna.

Archiviare SHALL chiudere anche l'eventuale richiesta di revisione pendente: una
card archiviata non deve lasciarne una in attesa per sempre.

Il ripristino SHALL essere ambito al progetto: un identificativo valido ma di
un altro progetto SHALL non fare NIENTE, e la card SHALL restare in archivio.

> Archiviare aveva una porta sola: l'elenco inchiodava il filtro, la modifica
> rifiutava il campo, e nessuna scrittura riportava indietro. Settantaquattro
> task erano usciti dalla board senza un modo di rivederli.

#### Scenario: un ramo intero
- **GIVEN** un padre con figli e nipoti
- **WHEN** lo si archivia e lo si ripristina
- **THEN** SHALL tornare tutta la checklist annidata

#### Scenario: un figlio ripristinato da solo
- **GIVEN** un figlio archiviato sotto un padre archiviato
- **WHEN** si ripristina il figlio
- **THEN** SHALL tornare anche il padre

#### Scenario: il progetto sbagliato
- **GIVEN** un identificativo valido chiesto da un altro progetto
- **THEN** NON SHALL essere scritto niente

### Requirement: KANBAN-19 — Fermo sui sottotask: si CHIEDE, e non si chiede due volte la stessa cosa

Quando un task resta fermo perché i suoi sottotask non li lavorerà nessuno, il
sistema SHALL portarlo in revisione con una DOMANDA e delle scelte, invece di
lasciarlo in una colonna dove non succede niente.

La domanda NON SHALL essere posta mentre il padre ha un turno VIVO, salvo che sia
il turno stesso a finire: senza questa guardia un passo di checklist spuntato
tagliava il turno in corso.

La domanda NON SHALL ripetersi: due giri producono una domanda sola. E l'opzione
«rimettili in coda» NON SHALL essere offerta una SECONDA volta — quello è
l'anello che si è chiuso su sé stesso tre volte in una notte. Il conteggio SHALL
essere fatto su ciò che è stato SCRITTO, non sull'etichetta di un bottone.

Una domanda SHALL essere riconosciuta come tale solo se l'ha scritta il SISTEMA e
solo all'inizio di una riga: un agente che ripete la frase NON SHALL poterla far
sparire, e citarla dentro un altro messaggio NON SHALL contare.

Una domanda SHALL potersi considerare risolta quando i sottotask si sono
sbloccati, e questa asimmetria è voluta: si può spegnere una domanda superata,
mai accenderne una già risolta.

Il rastrello periodico NON SHALL toccare chi ha un turno addosso o in arrivo, chi
è già in revisione, e chi è appena stato rimesso in coda.

La nota di contabilità SHALL essere scritta PRIMA della domanda: appesa dopo, la
seppellisce.

#### Scenario: un passo spuntato mentre l'agente lavora
- **GIVEN** un padre con un turno vivo e sottotask fermi
- **THEN** SHALL comparire una riga nel filo, e il turno NON SHALL essere tagliato

#### Scenario: la seconda volta
- **GIVEN** una card già rimessa in coda una volta e di nuovo ferma
- **THEN** le scelte offerte NON SHALL comprendere «rimettili in coda»

### Requirement: KANBAN-20 — Non si dispaccia in un repo dove c'è una persona al lavoro

Prima di affidare un task a un agente il sistema SHALL guardare se una sessione
ESTERNA sta lavorando nella stessa cartella. Quando c'è, e la board lavora IN
PLACE, i task SHALL restare in coda con il chip di attesa e NESSUN turno SHALL
partire.

La guardia NON SHALL scattare quando la board usa worktree isolati: lì non ci si
pesta i piedi, ed è la ragione per cui i worktree esistono.

Solo una sessione ATTIVA SHALL contare. Un transcript fermo da un'ora non è
qualcuno che sta scrivendo adesso, e bloccare su quello incastrerebbe la board
per sempre dopo una qualunque finestra lasciata aperta.

L'appartenenza SHALL essere per percorso reale e non per prefisso di stringa: una
cartella che comincia con lo stesso nome NON è dentro.

Una scansione FALLITA SHALL lasciare in piedi il censimento precedente e NON
SHALL mai essere letta come «la cartella è libera». Un errore transitorio del
filesystem non è un permesso.

L'attesa SHALL essere annunciata una volta per episodio e non a ogni giro, e
SHALL sciogliersi da sola quando la sessione esterna tace: nessun gesto umano
SHALL essere necessario.

#### Scenario: una persona nel repo, board in place
- **GIVEN** una sessione esterna attiva nella cartella del progetto
- **THEN** nessun task SHALL essere dispacciato, e i todo SHALL portare il chip di attesa

#### Scenario: la stessa persona, board a worktree
- **GIVEN** la stessa sessione esterna e una board che isola in worktree
- **THEN** il dispatch SHALL procedere

#### Scenario: la scansione non risponde
- **GIVEN** una scansione che fallisce
- **THEN** SHALL valere il censimento precedente, e NON SHALL essere dedotto che non c'è nessuno

### Requirement: KANBAN-21 — Un task nuovo propone un legame solo quando il legame è evidente

Alla creazione di un task il sistema SHALL poter proporre un legame con una card
esistente, e la proposta SHALL essere LESSICALE e deterministica: nessun modello
decide, e la stessa coppia dà sempre la stessa risposta.

La proposta SHALL viaggiare CON la creazione. Proporre dopo aprirebbe una
finestra in cui il legame non voluto esiste già.

SHALL essere considerata solo una card APERTA, e mai la card stessa.

La proposta SHALL richiedere DUE condizioni insieme: un numero minimo di termini
condivisi, e un punteggio sopra una soglia dichiarata. Una parola sola in comune
NON basta, e sotto soglia il default silenzioso SHALL restare «è un task nuovo».

Il genere del legame SHALL discendere dallo STATO del bersaglio: una card già in
lavorazione o in revisione rende il nuovo un SEGUITO, altrimenti un
sottotask.

A parità di punteggio la scelta SHALL essere deterministica — prima il più
recente, poi l'identificativo — così che l'ordine con cui arrivano i candidati
non cambi il risultato.

La proposta SHALL portare il PERCHÉ in parole: il testo del bersaglio, il suo
stato, e i termini che i due hanno in comune.

Il riconoscimento dei DOPPIONI SHALL essere separato dalla proposta e SHALL avere
una guardia sugli identificatori: due testi molto simili che nominano
identificatori DIVERSI NON SHALL essere doppioni, per quanto alto sia il
punteggio. Un testo troppo corto SHALL essere doppione solo se identico.

#### Scenario: una parola in comune
- **GIVEN** un task nuovo che condivide un solo termine con una card aperta
- **THEN** NON SHALL essere proposto nessun legame

#### Scenario: candidati in ordine diverso
- **GIVEN** gli stessi candidati passati in ordine invertito
- **THEN** la proposta SHALL essere la stessa

#### Scenario: identificatori diversi
- **GIVEN** due card molto simili che nominano file o simboli diversi
- **THEN** NON SHALL essere dichiarate doppioni

### Requirement: KANBAN-22 — Il titolo si taglia sulle parole, e un errore non è un titolo

Il titolo di un task SHALL essere ricavato dalla prima riga del testo, e quando
quella riga è più lunga del massimo SHALL essere accorciata senza MAI spezzare
una parola: prima su una fine di frase, poi sull'ultimo spazio utile, e solo per
un testo senza spazi — un indirizzo, per esempio — con un taglio secco.

Il resto del testo SHALL diventare la descrizione, e NON SHALL essere perduto.

Una riscrittura assistita da un modello SHALL essere tentata SOLO quando serve:
NON SHALL toccare un titolo che non è stato troncato ed è già corto — quello
l'ha scelto una persona — né quando la descrizione non aggiunge niente.

La risposta del modello SHALL passare una guardia prima di diventare un titolo, e
la guardia SHALL RIFIUTARE: un testo troppo corto o troppo lungo, una frase
intera con più periodi, e — nominatamente — un messaggio di ERRORE del
fornitore. La riga di comando non solleva un'eccezione quando esce male: risolve
con un testo che comincia per «Error», e senza questo controllo quel testo
diventa il nome della card. È successo.

Un fallimento qualunque SHALL lasciare il titolo com'era: `null` significa «non
toccare», mai «cancella».

#### Scenario: una riga lunghissima senza spazi
- **GIVEN** una prima riga fatta di un solo indirizzo lungo
- **THEN** SHALL essere troncata con un segno di continuazione, e nessuna parola
  SHALL risultare spezzata a metà

#### Scenario: il fornitore esce male
- **GIVEN** una risposta che è un messaggio di errore del fornitore
- **THEN** NON SHALL diventare un titolo

### Requirement: KANBAN-23 — Un'anteprima è evidenza di QUESTA card, o non è un'anteprima

Prima di allegare un'immagine come risultato, il sistema SHALL verificare DUE
cose distinte: che la porta che sta fotografando sia SUA, e che quello che si
vede sia una pagina vera.

L'appartenenza SHALL essere decisa per identità del processo, e in mancanza per
cartella di lavoro CANONICA — con i collegamenti simbolici risolti, perché due
scritture dello stesso percorso non sono due percorsi. Quando non si può sapere,
il sistema SHALL accettare e DIRLO, invece di rifiutare in silenzio.

Un indirizzo locale già registrato SHALL essere riusato solo se risulta ancora
proprio; altrimenti SHALL essere azzerato.

Il CONTENUTO SHALL essere respinto quando la risposta è un errore o quando la
pagina è un segnaposto — un bundle non costruito, una rotta che non esiste, una
connessione rifiutata, un corpo vuoto.

Uno screenshot RIUSCITO ma BIANCO NON SHALL essere evidenza, e questo controllo
SHALL essere separato da quello sul contenuto.

Quando l'anteprima viene respinta, il sistema SHALL RITIRARLA con un motivo
scritto, e NON SHALL semplicemente svuotare il campo: un'assenza senza motivo non
si può verificare.

Il peso della nota SHALL dipendere da CHI ha aperto la porta: se l'ha aperta il
sistema è una riga di servizio, se l'ha messa una persona è una nota da leggere.

La nota SHALL occupare uno SLOT, comprese le sue formulazioni vecchie, così che
non se ne accumulino.

Le porte SHALL essere PRENOTATE fra la scelta e l'avvio, per non essere raccolte
dalla spazzata durante il proprio boot; e la chiusura SHALL abbattere l'ALBERO di
processi e non il solo processo capo — con il solo capo, il pool di porte si
esauriva.

Solo quando una PERSONA chiede di ricatturare, il sistema SHALL scrivere il
motivo anche quando non c'è niente da ritirare: a una consegna normale quel ramo
resta muto.

#### Scenario: la porta è di qualcun altro
- **GIVEN** un indirizzo locale servito da un processo che non è nostro
- **THEN** NON SHALL essere fotografato

#### Scenario: uno screenshot bianco
- **GIVEN** uno screenshot riuscito ma vuoto
- **THEN** l'anteprima SHALL essere ritirata CON un motivo

### Requirement: KANBAN-24 — Il modello si sceglie a maggioranza, e non si scende sotto il pavimento

La scelta del modello per un task SHALL essere presa a più VOTI indipendenti e
risolta per mediana. Un voto solo non basta: misurato il 10/08/2026 su venti
task, due giudizi indipendenti sullo stesso task davano sforzo diverso nel 33,7%
dei casi e piano diverso nel 54,2%; con la mediana di tre voti il disaccordo
sullo sforzo scende al 10,0%.

Su un numero pari di voti SHALL essere scelto il più economico dei due centrali.

Il livello più economico SHALL essere solo un GIUDICE e mai un bersaglio di
esecuzione: SHALL essere tolto dai candidati prima della risoluzione.

Lo sforzo scelto NON SHALL poter scendere sotto quello già impostato sulla board:
la scelta automatica può alzare, mai abbassare.

Il testo dato ai giudici SHALL essere tagliato a CONFINE DI RIGA quando possibile
e SHALL dichiarare di essere un estratto: un taglio a metà frase rendeva due
risposte su tre illeggibili.

Un voto ILLEGGIBILE NON SHALL contare né come astensione né come valore di
mezzo, e il verdetto SHALL essere nullo solo quando nessun voto è leggibile.

Qualunque fallimento — classificatore muto, tempo scaduto, risposta non
interpretabile, livello non disponibile — SHALL ricadere sul modello di ripiego e
NON SHALL mai bloccare il dispatch.

#### Scenario: due voti su tre illeggibili
- **GIVEN** tre voti di cui due non interpretabili
- **THEN** il verdetto SHALL essere quello dell'unico leggibile

#### Scenario: il classificatore non risponde
- **GIVEN** un classificatore che va in errore
- **THEN** SHALL essere usato il modello di ripiego, e il task SHALL partire

### Requirement: KANBAN-25 — Riscrivere il titolo di una card è l'unica volta che un modello tocca ciò che hai scritto

Il sistema SHALL poter proporre un titolo migliore per una card, e questa SHALL
essere l'unica strada per cui un modello riscrive un testo scritto da una
persona. Ogni rifiuto SHALL lasciare il titolo originale ESATTAMENTE dov'era.

Il rifiuto SHALL essere DISTINTO nel motivo: nessun modello collegato, oppure il
titolo va già bene. Un motivo solo non permette di capire se la funzione è rotta
o se ha fatto il suo lavoro.

Sotto una lunghezza minima il modello NON SHALL nemmeno essere interpellato:
riscrivere un titolo già breve costa un turno per non cambiare niente.

Una riscrittura accettata SHALL essere PERSISTITA sulla card, e SHALL restituire
anche il titolo di PRIMA. I due modi di sbagliare qui sono entrambi silenziosi —
una card il cui titolo diventa qualcosa che nessuno ha scritto, e una risposta
che annuncia il titolo nuovo senza averlo salvato — e nessuno dei due produce un
errore a schermo.

#### Scenario: nessun modello collegato
- **GIVEN** una card con un titolo lungo e nessun modello disponibile
- **THEN** SHALL rifiutare dichiarando il motivo, e il titolo SHALL restare quello di prima

#### Scenario: la riscrittura riesce
- **GIVEN** una card riscritta con successo
- **THEN** la card riletta SHALL portare il titolo nuovo, e la risposta SHALL nominare quello vecchio

### Requirement: KANBAN-26 — Un legame si legge dal LEGAME, non cercandolo fra le card disegnate

Un legame di dipendenza fra task SHALL essere risolto dal SERVER, sul database, e
consegnato con la card. NON SHALL essere ricavato cercando l'altro capo fra le
card già scaricate: quell'elenco è tagliato — un progetto, solo le radici, non
archiviati — e un capo fuori dal taglio, tipicamente un SOTTOTASK che per
contratto non è mai una card, non si trova.

Il chip che dichiara l'attesa SHALL comparire anche quando chi blocca non è a
schermo, e SHALL spegnersi quando quello chiude.

Il contatore di chi aspetta SHALL contare anche i dipendenti che non sono card:
altrimenti chi blocca si presenta LIBERO proprio da dove si decide se chiudere il
lavoro.

La stessa regola SHALL valere per i comandi di una notifica: un tasto che deve
risolvere il progetto di un task NON SHALL cercarlo nel feed globale, che è
anch'esso solo radici. Per qualunque sottotask quella ricerca non trova niente, e
il comando ripiega in silenzio su «apri il task» invece di fare ciò che
prometteva.

#### Scenario: chi blocca è un sottotask
- **GIVEN** una card bloccata da un task che non è una card
- **THEN** il chip dell'attesa SHALL comparire lo stesso

#### Scenario: un comando di notifica su un sottotask
- **GIVEN** un tasto di notifica riferito a un sottotask
- **THEN** SHALL eseguire la propria azione, non ripiegare sull'apertura

### Requirement: KANBAN-27 — L'ultimo scambio si legge sulla card, e la contabilità non si spaccia per la consegna

Una card in review SHALL mostrare l'ULTIMO SCAMBIO del suo filo — la domanda in
attesa o la cronaca dichiarata — direttamente a schermo: una domanda che sparisce
senza risposta è lavoro fermo che nessuno vede.

Il riconoscimento di ciò che è uno scambio NON SHALL escludere per tipo alcune
risposte legittime: un predicato troppo stretto fa sparire proprio le risposte
che contano.

La CONTABILITÀ dell'automatismo — quanti tentativi, quanti con modifiche — NON
SHALL essere presentata come la CONSEGNA: è la registrazione di un meccanismo, e
occupare con essa la riga che dovrebbe dire cosa è stato fatto è come una card si
presenta muta.

#### Scenario: una domanda in attesa
- **GIVEN** una card il cui filo si chiude con una domanda
- **THEN** la domanda SHALL essere leggibile sulla card

#### Scenario: una riga di contabilità
- **GIVEN** un messaggio che registra i tentativi dell'automatismo
- **THEN** NON SHALL occupare il posto della consegna

### Requirement: KANBAN-28 — La colonna ha un PAVIMENTO, una crescita e un SOFFITTO

La larghezza di una colonna SHALL essere elastica fra un pavimento e un soffitto,
non fissa: con larghezze fisse l'avanzo su uno schermo largo resta un vuoto morto
a destra.

Il contratto SHALL reggere a OGNI larghezza di finestra. Su una finestra larga le
colonne SHALL crescere e il soffitto SHALL essere davvero applicato; su una
stretta il pavimento SHALL reggere e la riga SHALL tornare a scorrere.

Sul TELEFONO la colonna su cui si decide SHALL valere UNA SCHERMATA INTERA, non
una larghezza pensata per il desktop, e sopra la soglia SHALL tornare alla propria
misura.

Una colonna NON SHALL uscire dalla riga: un elemento flessibile senza minimo
esplicito prende come minimo il proprio contenuto, che può spingere oltre la base
dichiarata. Il rimedio SHALL essere verificabile TOGLIENDOLO — rimetterlo com'era
SHALL far tornare lo sfondamento — e NON SHALL ridurre la colonna sul desktop.

#### Scenario: una finestra molto larga
- **GIVEN** una finestra oltre il soffitto
- **THEN** le colonne SHALL crescere fino al soffitto e non oltre

#### Scenario: il telefono
- **GIVEN** una finestra da telefono
- **THEN** la colonna della decisione SHALL valere una schermata, senza uscire dalla riga

### Requirement: KANBAN-29 — Le colonne d'ARCHIVIO paginano, quelle di LAVORO restano intere

Una colonna che raccoglie ciò che è CHIUSO SHALL disegnare una PAGINA per volta,
non l'intero volume. Misurato sulla macchina viva: su 467 task radice, 449 erano
chiusi, e la colonna li disegnava tutti — un sottoalbero pagato a ogni ridisegno
e dentro ogni trascinamento.

Il conteggio in testa SHALL continuare a dichiarare il TOTALE: paginare non è
nascondere. Il comando che tira su la pagina successiva SHALL dichiarare QUANTI
ne restano, e il numero SHALL calare a ogni pagina.

Le colonne di LAVORO SHALL restare INTERE, senza tetto: sono poche card e ci si
lavora sopra. La card in fondo a una colonna di lavoro SHALL restare
trascinabile.

#### Scenario: trecento task chiusi
- **GIVEN** una colonna d'archivio con molte più card di una pagina
- **THEN** SHALL esserne disegnata una pagina, e il totale SHALL essere dichiarato

#### Scenario: una colonna di lavoro
- **GIVEN** una colonna di lavoro con molte card
- **THEN** SHALL essere disegnata intera, senza comando di paginazione

### Requirement: KANBAN-30 — Il composer non si smonta perché il fuoco è andato altrove

Il campo di scrittura della bacheca NON SHALL essere smontato — perdendo ciò che
è scritto dentro — perché il fuoco è finito su un altro campo del documento. La
condizione SHALL guardare SOLO dentro le colonne: la ricerca, la tavolozza dei
comandi e gli altri campi non gli stanno sopra.

Aprire una card NON SHALL smontarlo su una finestra larga, dove il pannello è un
FRATELLO nel flusso e non lo copre.

Dove il campo va nascosto — un campo dentro una colonna, una finestra stretta —
SHALL essere nascosto per stile e NON SHALL essere DISTRUTTO: alla riapertura il
testo SHALL essere ancora lì.

#### Scenario: la ricerca della bacheca
- **GIVEN** il fuoco su un campo fuori dalle colonne
- **THEN** il testo scritto SHALL sopravvivere

#### Scenario: un campo dentro una colonna
- **GIVEN** un campo che apre dentro una colonna
- **THEN** il composer SHALL essere nascosto ma non distrutto

### Requirement: KANBAN-31 — La dettatura ha DUE gesti, e il microfono sta in OGNI ingresso

La voce SHALL essere un modo per dare un lavoro a un agente: senza, l'unico
ingresso è la tastiera.

SHALL esistere DUE gesti distinti: il TOCCO lascia il microfono acceso finché non
lo si tocca di nuovo; la PRESSIONE TENUTA dura quanto il dito. La trascrizione
SHALL atterrare nel campo, e il testo di una seconda dettatura SHALL essere
AGGIUNTO al precedente, non sostituirlo.

Il microfono SHALL esserci in TUTTI gli ingressi verso un agente — il campo della
bacheca e il filo di un task — non solo nel primo: gli ingressi devono essere
coerenti fra loro, dalla voce ai file.

#### Scenario: il tocco
- **GIVEN** un tocco breve sul microfono
- **THEN** SHALL restare in ascolto fino al tocco successivo

#### Scenario: il filo di un task
- **GIVEN** il campo di scrittura dentro un task
- **THEN** SHALL avere il microfono come quello della bacheca

### Requirement: KANBAN-32 — Copiare un task: il TESTO e il LINK, da due strade

SHALL essere possibile copiare il CONTENUTO di un task — titolo, riga vuota,
descrizione — non solo il suo collegamento: prima esisteva solo il secondo, e
portare un task altrove significava ricopiarlo a mano.

Il gesto SHALL esistere su ALMENO due strade: il menu del pannello e il menu
contestuale sulla card. Dal menu contestuale NON SHALL aprirsi il pannello.

Il risultato SHALL essere CONFERMATO a schermo: una copia silenziosa non si
distingue da una mancata.

Il pannello di condivisione SHALL stare DENTRO la finestra e NON SHALL essere
tagliato dal contenitore che lo ospita: un posizionamento assoluto dentro una
testata che nasconde l'eccedenza lo riduce a una striscia.

#### Scenario: il menu contestuale
- **GIVEN** il tasto destro su una card
- **THEN** SHALL copiare titolo e descrizione senza aprire il pannello

#### Scenario: il pannello di condivisione
- **GIVEN** il pannello aperto
- **THEN** SHALL essere interamente dentro la finestra

### Requirement: KANBAN-33 — Una revisione riga per riga parte in UN commento solo

Ogni riga di una differenza SHALL avere un aggancio per commentarla, e le note
raccolte SHALL partire in UN SOLO commento: su un task in review OGNI commento
risveglia l'agente, e mandarne cinque è chiamarlo cinque volte.

Il commento SHALL portare le ANCORE — percorso e riga — e la riga citata, così
chi legge sa a cosa si riferisce senza aprire niente.

La BOZZA di revisione SHALL sopravvivere a un ricaricamento della pagina, e il
pannello SHALL riaprirsi da sé: una revisione a metà persa è lavoro rifatto.

#### Scenario: tre note su tre righe
- **GIVEN** più note in una sola revisione
- **THEN** SHALL partire un solo commento, con tutte le ancore

#### Scenario: un ricaricamento a metà revisione
- **GIVEN** una bozza non ancora inviata
- **THEN** SHALL sopravvivere, e il pannello SHALL riaprirsi

### Requirement: KANBAN-34 — Done si ordina per CRONOLOGIA, e l'arrivo si vede

La colonna di ciò che è chiuso SHALL essere ordinata per QUANDO è stato chiuso,
l'ultimo in cima: l'ordine manuale a un task chiuso non dice niente, e la card
conservava la posizione della colonna da cui veniva.

L'approvazione SHALL produrre qualcosa di VISIBILE: chiudere il pannello e basta
non dice che è successo. La card SHALL LAMPEGGIARE, e il lampo SHALL prendere il
COLORE della colonna di DESTINAZIONE — è così che si legge dove è andata.

Il lampo SHALL stare DENTRO lo spazio della colonna: un alone più largo del
margine viene tagliato, e il taglio si vede come una riga netta ai lati.

La curva SHALL SALIRE, TENERE e SCENDERE: accesa a piena intensità dal primo
fotogramma non è un lampo, è uno stacco. Al primo istante SHALL essere quasi
spenta, in cima quasi piena, e alla fine spenta.

La card che arriva SHALL essere DENTRO la finestra: se la colonna di
destinazione è fuori schermo, il lampo lo vede solo chi scorre.

#### Scenario: una card approvata
- **GIVEN** un'approvazione
- **THEN** la card SHALL andare in cima a Done e lampeggiare, dentro la finestra

#### Scenario: il primo fotogramma
- **GIVEN** l'inizio del lampo
- **THEN** SHALL essere quasi spento, non a piena intensità

### Requirement: KANBAN-35 — Nel pannello c'è UN SOLO contenitore che scorre, e la decisione resta in vista

Nel pannello di un task SHALL esistere UN SOLO contenitore che scorre in
verticale. Quando nessuno possiede l'altezza, ogni sezione si mette un tetto
addosso, e il primo pezzo tagliato è l'ULTIMO figlio — cioè proprio i comandi
della decisione.

I comandi della decisione SHALL restare DENTRO la finestra, PRIMA e DOPO lo
scorrimento, anche nel caso peggiore: un'evidenza altissima, decine di commenti,
tutte le sezioni aperte.

L'anteprima SHALL avere un tetto proporzionato al pannello, non un'altezza che se
lo mangia.

Chiudere una sezione SHALL nascondere ciò che le appartiene e NON SHALL muovere i
comandi della decisione.

In modo LARGO la sessione dell'agente SHALL stare da una parte e il resto
dall'altra, con l'intestazione a piena larghezza sopra entrambe, e nessuna delle
due colonne SHALL essere annidata nell'altra. La sessione dell'agente SHALL
essere una SCHEDA, presente solo quando c'è davvero una sessione.

#### Scenario: il caso peggiore
- **GIVEN** un'evidenza altissima, molti commenti e tutte le sezioni aperte
- **THEN** i comandi della decisione SHALL restare dentro la finestra

#### Scenario: chiudere una sezione
- **GIVEN** una sezione chiusa
- **THEN** i comandi della decisione NON SHALL spostarsi

### Requirement: KANBAN-36 — CHIUSO non è VUOTO, e uno stato scritto come messaggio non invecchia

Una sezione CHIUSA NON SHALL leggersi come ASSENTE: chiusa una volta, una
descrizione lunga si legge come «non c'è niente di utile». Il sommario di una
sezione chiusa SHALL DICHIARARE quanto c'è dentro e darne un assaggio LEGGIBILE,
senza la punteggiatura del formato.

Uno STATO NON SHALL essere scritto come un MESSAGGIO nel filo: un messaggio non
invecchia. Una nota che dichiara un'assenza SHALL SPARIRE DALLA VISTA quando
l'assenza finisce, e SHALL restare nel registro: si toglie dagli occhi, non dalla
storia.

#### Scenario: una descrizione lunga con l'accordion chiuso
- **GIVEN** una descrizione di migliaia di caratteri, sezione chiusa
- **THEN** il sommario SHALL dichiarare la sua misura e darne un assaggio

#### Scenario: l'assenza che finisce
- **GIVEN** una nota che dichiarava l'assenza di un'evidenza, e l'evidenza che torna
- **THEN** la nota SHALL sparire dalla vista e restare nel registro

### Requirement: KANBAN-37 — Un feedback nuovo genera una PROPOSTA, e il legame si vede da entrambe le parti

Un feedback scritto sullo stesso tema di un lavoro già in corso SHALL produrre
una PROPOSTA di collegamento, MAI un'attribuzione automatica: finché non è
accettata la bacheca NON SHALL cambiare.

Accettata, il legame SHALL essere visibile su ENTRAMBE le card — quella che
aspetta e quella che è aspettata — e SHALL essere spiegato nel filo.

Il feedback collegato NON SHALL essere assegnato a nessun discorso: è agganciato
a un lavoro, non a una conversazione.

#### Scenario: il tema coincide
- **GIVEN** un feedback nuovo sullo stesso tema di una card aperta
- **THEN** SHALL comparire una proposta, e la bacheca NON SHALL cambiare

#### Scenario: la proposta accettata
- **GIVEN** l'accettazione
- **THEN** il legame SHALL essere visibile su entrambe le card

### Requirement: KANBAN-38 — Le etichette si vedono e filtrano, e una un agente non se la può dare

Le etichette SHALL comparire sulle card, e il filtro SHALL lasciare esattamente
quelle che le portano. È l'alternativa all'aprire una per una decine di
differenze a mano.

Un agente NON SHALL potersi assegnare l'etichetta che lo rende invisibile: il
rifiuto SHALL essere ESPLICITO, con il proprio codice, non un silenzio. Le
etichette LECITE SHALL continuare a passare.

#### Scenario: un agente che si marca invisibile
- **GIVEN** una richiesta di un agente per quell'etichetta
- **THEN** SHALL essere rifiutata con il proprio codice

#### Scenario: il filtro
- **GIVEN** un filtro su un'etichetta
- **THEN** SHALL restare solo le card che la portano

### Requirement: KANBAN-39 — Una consegna che fa conflitto porta la RAGIONE e la firma del SISTEMA

Quando la fusione fallisce, la card SHALL tornare in lavorazione — è giusto — ma
la riga di storico NON SHALL essere identica a quella che scrive una persona
quando ritira una consegna a mano.

La transizione SHALL portare la RAGIONE del ritorno, e SHALL essere FIRMATA dal
SISTEMA: chi legge lo storico deve poter distinguere una decisione umana da un
conflitto tecnico.

La card NON SHALL essere promossa PRIMA di aver fuso: promuovere e poi fondere ha
lasciato card chiuse con i rami mai arrivati a destinazione.

#### Scenario: un conflitto in fusione
- **GIVEN** una fusione che fallisce
- **THEN** la transizione SHALL portare la ragione ed essere firmata dal sistema

#### Scenario: l'ordine fra promozione e fusione
- **GIVEN** una consegna
- **THEN** la card NON SHALL essere promossa prima che la fusione sia riuscita

### Requirement: KANBAN-40 — Un'anteprima si muove SOLO in vista, e il suo tetto è un RAPPORTO

Un'anteprima in movimento su una card SHALL essere in moto SOLO quando è nel
campo visivo, e SHALL fermarsi quando ne esce. Altrimenti ogni card con una clip
tiene un ciclo di decodifica aperto per sempre: N clip in moto per UNA che
qualcuno sta guardando.

Ciò che non è MAI stato guardato NON SHALL essere stato SCARICATO.

Il moto SHALL SEGUIRE lo sguardo: scorrendo, ciò che esce si ferma e ciò che
entra riparte.

Il tetto dell'anteprima sulla card SHALL essere un RAPPORTO rispetto alla card,
NON un'altezza fissa: la colonna ha una larghezza elastica, quindi un numero
fisso di pixel è vero in UNA configurazione e falso in tutte le altre — e falso
proprio nella colonna su cui si decide. Il rapporto SHALL essere lo STESSO a ogni
larghezza, e SHALL essere quello che il protocollo promette agli agenti.

#### Scenario: una clip fuori dal campo visivo
- **GIVEN** una card lontana dalla vista
- **THEN** la sua clip SHALL essere ferma e non scaricata

#### Scenario: due larghezze di colonna
- **GIVEN** la stessa card a due larghezze
- **THEN** il rapporto dell'anteprima SHALL essere lo stesso

### Requirement: KANBAN-41 — Ricatturare l'evidenza non consuma tentativi e non inventa foto

SHALL essere possibile RIFARE l'evidenza di una card in review con un gesto, senza
farla uscire e rientrare: la preparazione avveniva solo al bordo d'ingresso, e una
card che l'evidenza l'aveva PERSA poteva riaverla solo spendendo un turno di
agente per una foto.

La ricattura NON SHALL consumare tentativi di dispacciamento, NON SHALL muovere la
card, e NON SHALL scrivere un commento nel filo — che risveglierebbe l'agente.

Se non c'è NIENTE da avviare, NON SHALL essere prodotta una foto FINTA: SHALL
essere lasciata una NOTA col MOTIVO.

#### Scenario: una ricattura riuscita
- **GIVEN** una card senza evidenza
- **THEN** l'anteprima SHALL comparire, senza consumare tentativi né muovere la card

#### Scenario: niente da avviare
- **GIVEN** nessun modo di produrre l'evidenza
- **THEN** SHALL essere lasciata una nota col motivo, non una foto finta

### Requirement: KANBAN-42 — Una card approvata la riapre una PERSONA, e la board lo dice

Una card che esce da CHIUSO SHALL portare un segno che dichiara CHI l'ha riaperta
e QUANDO: in sei ore undici card erano uscite da chiuso, quasi tutte per mano di
agenti, e chi guardava pensava che il lavoro fatto si stesse perdendo.

Un AGENTE NON SHALL poter riaprire una card approvata da una persona: SHALL essere
rifiutato con il proprio codice, e il tentativo NON SHALL lasciare il segno della
riapertura.

Il segno SHALL sparire quando la card torna chiusa.

#### Scenario: un agente che riapre
- **GIVEN** un agente che tenta di riaprire una card approvata
- **THEN** SHALL essere rifiutato, e nessun segno SHALL comparire

#### Scenario: una persona che riapre
- **GIVEN** la riapertura da parte di una persona
- **THEN** il segno SHALL dichiarare chi e quando

### Requirement: KANBAN-43 — «Modifiche» elenca i file DELLA CARD, e sopravvive alla consegna

Il pannello delle modifiche SHALL elencare i file di QUESTA card. Il ramo nasce da
un altro ramo e porta commit che non sono suoi: un confronto con l'antenato comune
li conta, e la card si intesta il lavoro di un'altra sessione.

Il totale in testa SHALL corrispondere all'elenco sotto.

Dopo la CONSEGNA il pannello SHALL RESTARE, leggendo dalla fusione, e SHALL
DICHIARARE da dove legge: sparire proprio quando serve di più è il comportamento
peggiore possibile.

Quando non c'è NIENTE da cui ricostruire, SHALL essere DETTO, non fatto sparire il
pannello.

#### Scenario: un commit ereditato
- **GIVEN** un ramo nato da un altro ramo con lavoro altrui
- **THEN** SHALL essere elencato solo il file della card

#### Scenario: dopo la consegna
- **GIVEN** un ramo già fuso e la copia di lavoro rimossa
- **THEN** il pannello SHALL restare, dichiarando da dove legge

### Requirement: KANBAN-44 — Il riferimento a un task è un GLIFO, con un bersaglio da dito

Il riferimento a un task sulla card SHALL essere un GLIFO COMPATTO, non
l'identificativo per esteso: un chip che non si comprime mai si prende una fetta
della riga e costringe il nome del progetto a troncare.

Il glifo SHALL stare DENTRO la riga e SHALL essere CENTRATO sul testo, e
l'allineamento SHALL REGGERE anche con un altro carattere tipografico: centrare
sulla scatola invece che sul glifo produce uno scarto che cambia con il font.

Col PUNTATORE l'area sensibile SHALL essere quella del glifo; col DITO SHALL
essere allargata almeno alla misura minima raccomandata, restando un glifo
piccolo a schermo.

Il gesto SHALL copiare l'identificativo PIENO e confermarlo, e NON SHALL aprire la
card.

Un titolo lungo SHALL andare a capo AL BORDO, non rientrato sotto il glifo: un
titolo che si incolonna sotto un simbolo diventa una colonna stretta.

#### Scenario: un altro carattere tipografico
- **GIVEN** un font diverso montato
- **THEN** il glifo SHALL restare centrato sul testo

#### Scenario: il dito
- **GIVEN** un dispositivo a tocco
- **THEN** l'area sensibile SHALL raggiungere la misura minima, e il glifo restare piccolo

### Requirement: KANBAN-45 — Il testo scritto NON fa atterrare niente

Premere invio con del TESTO scritto su una card in review SHALL RIMANDARE
all'agente, MAI fondere il ramo.

L'incidente per cui questa regola esiste: qualcuno scrisse un commento e premette
invio; invio eseguiva la PRIMA delle scelte disponibili, e su una card consegnata
la prima scelta è la fusione. Il ramo finì sul principale e il task si chiuse da
solo.

Il comando primario, con del testo scritto, SHALL DICHIARARSI come il rinvio
all'agente e NON SHALL portare l'etichetta della fusione.

Dopo il gesto la card SHALL essere in lavorazione, e il ramo principale SHALL
essere ESATTAMENTE dove era — verificato sul repository, non sull'interfaccia.

#### Scenario: invio con del testo scritto
- **GIVEN** una card consegnata e del testo nel campo
- **THEN** SHALL essere rimandata all'agente, e il ramo principale NON SHALL cambiare

#### Scenario: l'etichetta del comando
- **GIVEN** del testo scritto
- **THEN** il comando primario SHALL dichiarare il rinvio, non la fusione

### Requirement: KANBAN-46 — La board si legge in ENTRAMBI i temi, e il rialzo si vede

Ogni superficie della bacheca — card, superfici rialzate, albero dei file,
barra di stato — SHALL raggiungere il contrasto minimo di leggibilità in
ENTRAMBI i temi.

La bacheca era l'unico pezzo scritto su una tavolozza scura cablata: in chiaro il
testo arrivava a poco più di uno a uno, cioè quasi-bianco su bianco. Non «poco
elegante»: ILLEGGIBILE.

Il RIALZO di una superficie SHALL essere PERCEPIBILE dove deve esserlo, e SHALL
essere verificato anche il caso NEGATIVO — una superficie che nel tema chiaro non
si distingue dallo sfondo SHALL essere riconosciuta come invisibile, o il banco
non sa distinguere i due casi.

Le tinte che portano uno STATO — le lettere dello stato di un file, i segnali
della barra — SHALL essere leggibili in entrambi i temi: una tinta scelta sul
tema scuro può scendere sotto due a uno su quello chiaro.

#### Scenario: il tema chiaro
- **GIVEN** la bacheca in tema chiaro
- **THEN** ogni testo SHALL raggiungere il contrasto minimo

#### Scenario: una superficie che non si distingue
- **GIVEN** un rialzo invisibile nel tema chiaro
- **THEN** il banco SHALL riconoscerlo come tale

### Requirement: KANBAN-47 — Ciò che scorre lo DICHIARA, e una colonna ha UNA barra sola

Una striscia che SCORRE in orizzontale con la barra nascosta SHALL dichiararlo con
un segno visibile, e il segno SHALL SPARIRE quando si è arrivati in fondo. Su ogni
finestra da telefono provata la striscia eccedeva la larghezza e NIENTE lo
segnalava.

Su desktop, dove non scorre, il segno NON SHALL comparire mai.

Una colonna SHALL avere UNA sola barra di scorrimento: due implementazioni
sovrapposte ne disegnano due, e si vedono entrambe al passaggio del puntatore.

#### Scenario: una striscia che scorre su telefono
- **GIVEN** contenuto più largo della finestra
- **THEN** SHALL comparire il segno, e sparire a fine scorrimento

#### Scenario: la colonna
- **GIVEN** una colonna che scorre
- **THEN** SHALL avere una sola barra

### Requirement: KANBAN-48 — Sul telefono nessun testo di card scende sotto il minimo leggibile, e le icone non stipano

A larghezza da TELEFONO nessun testo di una card SHALL scendere sotto il minimo
di leggibilità: il testo secondario toccava il fondo proprio sui dati che
servono a riconoscere una card. Su DESKTOP i valori compatti SHALL restare.

Un'icona piccola NON SHALL stipare più disegno di quanto il suo lato regga: il
difetto segnalato come «sgranata» era una questione di DENSITÀ di tratto, non di
risoluzione. SHALL esistere un rapporto massimo fra lunghezza del tratto e lato, e
la misura SHALL essere LETTA DAL DISEGNO, non da una costante — o il controllo
diventa un non-fare silenzioso.

#### Scenario: una card su telefono
- **GIVEN** una finestra da telefono
- **THEN** nessun testo SHALL scendere sotto il minimo

#### Scenario: un'icona troppo densa
- **GIVEN** un'icona il cui tratto supera il rapporto
- **THEN** il banco SHALL fallire

### Requirement: KANBAN-49 — Il pacchetto della differenza include i file NUOVI, e un rinominato compare UNA volta

Una consegna fatta di soli file NUOVI NON SHALL apparire come una differenza
VUOTA: i file non ancora tracciati SHALL essere INCLUSI nel pacchetto. È il caso
in cui la review non aveva niente da leggere pur essendoci tutto il lavoro.

Le esclusioni dichiarate del repository SHALL essere RISPETTATE: ciò che è
ignorato resta fuori.

I percorsi con SPAZI SHALL sopravvivere: la separazione SHALL usare il
terminatore che non compare mai in un nome.

Un file RINOMINATO SHALL avere lo STESSO percorso nell'elenco e nel corpo della
differenza: da quando l'elenco si costruisce dalle statistiche, un disallineamento
elenca lo stesso file DUE volte. La forma abbreviata del rinominato SHALL essere
risolta al percorso di DESTINAZIONE, senza doppie separazioni, e una freccia che
fa parte del NOME NON SHALL essere scambiata per un rinominato.

#### Scenario: una consegna di soli file nuovi
- **GIVEN** una copia di lavoro con solo file non tracciati
- **THEN** la differenza NON SHALL essere vuota

#### Scenario: un file rinominato
- **GIVEN** un rinominato nella consegna
- **THEN** SHALL comparire una volta sola, col percorso di destinazione

### Requirement: KANBAN-50 — Il fronte di review scatta SOLO alla transizione, e dichiara se è una domanda

L'avviso dedicato all'arrivo in review SHALL essere emesso SOLO alla TRANSIZIONE
verso quello stato: emetterlo a ogni aggiornamento produrrebbe una tempesta di
banner. Uno stato già in review NON SHALL riemetterlo, e uno stato diverso NON
SHALL emetterlo affatto. Un task visto per la PRIMA volta già in review SHALL
notificare.

Il fronte SHALL DICHIARARE se la consegna è una DOMANDA, e il campo SHALL esserci
SEMPRE — esplicitamente vuoto quando non lo è. Con il campo OMESSO, un client
nuovo su un server vecchio offrirebbe «approva» su un task che sta aspettando una
risposta.

La domanda SHALL essere l'ULTIMA parola dell'agente, non una già superata, e le
righe di TRANSIZIONE NON SHALL contare come parola di nessuno: il servizio ne
scrive una a ogni cambio di stato, e senza il filtro quella — che arriva sempre
per ultima — seppellirebbe ogni domanda. Una domanda SENZA opzioni resta una
domanda.

Il filo NON SHALL essere letto quando il fronte non scatta, e una lettura che
FALLISCE NON SHALL mangiarsi il banner.

#### Scenario: un aggiornamento su un task già in review
- **GIVEN** un task che era già in review
- **THEN** il fronte NON SHALL essere riemesso

#### Scenario: una consegna che non è una domanda
- **GIVEN** una consegna normale
- **THEN** il campo della domanda SHALL essere presente ed esplicitamente vuoto

### Requirement: KANBAN-51 — Un vincolo del database diventa un messaggio, e il messaggio non porta SQL

Una violazione di un vincolo del database SHALL essere tradotta in un rifiuto
LEGGIBILE, e la traduzione SHALL essere provata sugli errori VERI prodotti dal
database, non su stringhe inventate.

Il messaggio SHALL nominare il CAMPO e dire cosa è ammesso — l'intervallo, o
l'elenco dei valori — e NON SHALL contenere SQL: chi lo legge è una persona
davanti a un modulo.

Un vincolo che la traduzione NON CONOSCE SHALL comunque produrre un rifiuto senza
SQL. Un errore che NON è una violazione di vincolo NON SHALL essere tradotto:
resta un guasto del server, e travestirlo da errore dell'utente manda a
correggere la cosa sbagliata.

#### Scenario: un valore fuori dall'intervallo
- **GIVEN** un campo numerico fuori dai limiti
- **THEN** il rifiuto SHALL nominare il campo e l'intervallo, senza SQL

#### Scenario: un errore che non è un vincolo
- **GIVEN** un guasto diverso
- **THEN** NON SHALL essere tradotto in un rifiuto dell'utente

### Requirement: KANBAN-52 — Il pannello non LEGGE quando nessuno lo guarda, e la sessione si taglia in UNA passata

Il pannello di un task interroga la cronologia a intervalli. NON SHALL farlo
quando non ha un posto nel layout, e SHALL SALTARE il giro quando la finestra non
è in vista — senza smontare il proprio orologio. Congelare i DISEGNI di una
superficie nascosta non ferma gli effetti di un sottoalbero già montato: un
pannello parcheggiato dietro un'altra superficie continuava a leggere.

Al ritorno in vista SHALL RECUPERARE, e SHALL farlo sullo STESSO ascoltatore, non
su uno nuovo per giro.

Il taglio della sessione fra i commenti SHALL essere UNA passata, non un filtro
PER RIGA: quello percorreva l'intera cronologia una volta per ogni commento —
centinaia di letture per giro, ogni pochi secondi. Il costo SHALL essere
LIMITATO, e il banco SHALL misurarlo.

Un intervallo il cui contenuto NON è cambiato SHALL restituire lo STESSO oggetto:
la lettura ricostruisce i messaggi da zero a ogni giro, quindi solo un confronto
di VALORE può tenere stabile ciò che non è cambiato — e un messaggio CRESCIUTO a
metà stream ha lo stesso istante e un corpo più lungo, quindi riusare il vecchio
lì congelerebbe l'anteprima viva.

I confini fra i tratti di sessione NON SHALL aprire né chiudere l'elenco, e una
serie di confini consecutivi SHALL COLLASSARE in uno: con decine di commenti e
due turni di agente non si disegnano decine di separatori. I turni umani iniettati
nella sessione SHALL essere tolti: il filo li mostra già.

#### Scenario: la finestra in secondo piano
- **GIVEN** il pannello aperto e la finestra non in vista
- **THEN** il giro di lettura SHALL essere saltato

#### Scenario: un messaggio cresciuto a metà stream
- **GIVEN** lo stesso istante e un corpo più lungo
- **THEN** l'intervallo SHALL essere ricostruito, non riusato

### Requirement: KANBAN-53 — La stessa forma su due lati non può divergere in silenzio

Le forme che esistono in DUE copie su lati che non possono condividere il
dizionario — il riassunto di un tentativo scritto nel filo e la riga mostrata a
schermo — SHALL produrre lo STESSO testo, e il banco SHALL confrontarle
direttamente. Una copia che diverge è come il commento nel filo e lo schermo
iniziano a raccontare due cose diverse dello stesso tentativo.

Nella seconda lingua il PLURALE SHALL essere corretto, e gli stati SENZA numeri
SHALL comunque avere una parola.

Il riassunto di una descrizione SHALL prendere la prima riga di PROSA, senza i
marcatori del formato; le righe di sola DECORAZIONE NON SHALL essere un accenno.
Il taglio SHALL essere alla lunghezza dichiarata, senza spazio penzolante prima
dei puntini. Senza descrizione NON SHALL essere inventato un accenno.

I separatori delle migliaia SHALL esserci anche a quattro cifre — la
localizzazione predefinita li salterebbe — e gli ordini di grandezza SHALL
restare coerenti fra loro.

Copiare un task SHALL produrre titolo e descrizione separati da una riga vuota,
senza righe vuote in coda e senza gli spazi ai bordi.

#### Scenario: le due copie della stessa forma
- **GIVEN** lo stesso tentativo reso dai due lati
- **THEN** il testo SHALL essere identico

#### Scenario: un numero a quattro cifre
- **GIVEN** un conteggio di migliaia
- **THEN** SHALL portare il separatore

### Requirement: KANBAN-54 — Gli allegati di un task sono UNA lista, e l'anteprima ne fa parte

Gli allegati di un task — l'anteprima e quelli del filo — SHALL formare UNA lista
UNIVOCA e ORDINATA, con l'anteprima per PRIMA. Arrivando da un campo suo e non da
un commento, l'anteprima restava FUORI dalla lista e quindi fuori dalle schede.

Un allegato che è ANCHE l'anteprima SHALL avere UNA sola voce.

Ogni percorso SHALL produrre un identificativo di superficie STABILE.

Il TIPO SHALL essere deciso dal SUFFISSO: una clip di consegna è un VIDEO, non
un'immagine — disegnarla come immagine produce un'icona rotta e un visore che non
la conosce. La verifica SHALL tollerare i parametri e i frammenti di un indirizzo
già costruito, e una sottostringa a metà percorso NON SHALL contare.

Senza percorso NON SHALL esserci nessun tipo.

#### Scenario: una clip di consegna
- **GIVEN** un allegato con il suffisso di un video
- **THEN** SHALL essere trattato come video

#### Scenario: l'anteprima allegata anche al filo
- **GIVEN** lo stesso file in entrambi i posti
- **THEN** SHALL comparire una volta sola

### Requirement: KANBAN-55 — Ciò che si è aperto DA SOLO si richiude, ciò che hai aperto a mano resta

Le superfici aperte AUTOMATICAMENTE entrando in un task SHALL essere richiuse
uscendo; quelle aperte A MANO SHALL restare. Il contratto è quello, e vale in
entrambi i versi.

Un task mai registrato NON SHALL avere niente da chiudere, e una registrazione a
VUOTO NON SHALL creare una voce.

Ri-registrare lo STESSO task SHALL aggiornare il suo elenco senza sfrattare sé
stesso; gli identificativi ripetuti SHALL contare una volta sola.

Oltre un tetto di task ricordati SHALL essere sfrattato il PIÙ VECCHIO,
restituendo le sue superfici, e ri-registrare il più vecchio SHALL riportarlo in
cima.

#### Scenario: uscire da un task
- **GIVEN** superfici aperte automaticamente e una aperta a mano
- **THEN** SHALL essere richiuse solo le prime

#### Scenario: oltre il tetto
- **GIVEN** più task ricordati del tetto
- **THEN** SHALL essere sfrattato il più vecchio, restituendo le sue superfici

### Requirement: KANBAN-56 — L'indice discorso→task si SOSTITUISCE, e sveglia solo chi è cambiato

L'indice che lega un discorso al suo task SHALL essere SOSTITUITO a ogni lettura,
non FUSO: un task che perde il legame — o che viene archiviato — sparisce dal
feed, e fondendo resterebbe a puntare per sempre a una scheda che non c'è.

Un aggiornamento IDENTICO NON SHALL svegliare nessuno e NON SHALL cambiare
identità: il feed si rilegge a ogni evento, a raffica durante un dispatch, e ogni
rilettura produce oggetti nuovi quasi sempre uguali.

Un cambiamento VERO SHALL svegliare SOLO il discorso cambiato, e anche la
SPARIZIONE SHALL svegliare: la riga che ne dipendeva deve poter smettere.

#### Scenario: un task che esce dal feed
- **GIVEN** un legame che sparisce
- **THEN** l'indice SHALL perderlo, e chi lo guardava SHALL essere svegliato

#### Scenario: una rilettura identica
- **GIVEN** lo stesso contenuto riletto
- **THEN** nessuno SHALL essere svegliato

### Requirement: KANBAN-57 — Ogni chip della riga di dettaglio è coperto dalla condizione che disegna la riga

OGNI elemento disegnato dentro la riga condizionale di una card SHALL essere
compreso nella condizione che decide se quella riga esiste. Un elemento fuori
dalla condizione non compare MAI, e il difetto è invisibile a ogni misura: il
database, il feed e la condizione compilata dicevano tutti la cosa giusta mentre
a schermo non c'era niente — tre giri di diagnosi.

Il banco SHALL rilevare da sé gli elementi NON mappati, o si limita a confermare
la mappa che qualcuno ha scritto e resta verde mentre la prova a schermo diventa
rossa.

Il predicato di un elemento SHALL essere UNO SOLO, dichiarato una volta: due copie
divergono, e nel caso vero una delle due faceva comparire il chip su un valore
ZERO.

#### Scenario: un chip nuovo non aggiunto alla condizione
- **GIVEN** un elemento dentro la riga ma fuori dal predicato
- **THEN** il banco SHALL fallire

#### Scenario: un valore zero
- **GIVEN** un conteggio pari a zero
- **THEN** il chip NON SHALL comparire

### Requirement: KANBAN-58 — Fondere due card non perde NIENTE, e non crea anelli

La fusione di due card SHALL portare sulla superstite il FILO della card
assorbita, con l'AUTORE di ogni commento invariato, i SOTTOTASK — e i loro
discendenti — VIVI: la cascata dell'archiviazione NON SHALL portarseli via.

La card assorbita SHALL essere ARCHIVIATA, non cancellata, ed ENTRAMBE SHALL DIRE
dove è finito il lavoro.

I puntatori di BLOCCO SHALL passare alla superstite, e il blocco SHALL TENERE:
archiviare il bloccante lo farebbe contare come finito, e il dipendente
partirebbe mentre il lavoro è ancora da fare. La superstite NON SHALL diventare
bloccante di sé stessa, e chi la bloccava NON SHALL ripuntare su di lei: sarebbe
un anello.

La ricevuta SHALL dire QUANTO è stato spostato, e senza dipendenti NON SHALL
inventare niente.

NON SHALL essere fusa una card con sé stessa, una di un'altra bacheca, una con un
agente VIVO — il suo spazio di lavoro resterebbe orfano — una GIÀ archiviata, né
una superstite che è SOTTOTASK di quella che sparisce.

I possibili doppioni SHALL essere cercati sulla PROPRIA bacheca, e una card
ARCHIVIATA NON SHALL contare come doppione.

#### Scenario: i sottotask della card assorbita
- **GIVEN** una fusione
- **THEN** SHALL restare vivi sotto la superstite

#### Scenario: chi bloccava la superstite
- **GIVEN** un puntatore di blocco che verrebbe spostato
- **THEN** NON SHALL ripuntare sulla superstite

### Requirement: KANBAN-59 — Il documento del protocollo e l'envelope dicono le STESSE regole

Il documento che descrive il protocollo della bacheca e il messaggio di apertura
che un agente riceve SHALL portare le STESSE regole, e il banco SHALL verificarlo
regola per regola: ne portava la metà, e due — l'ultimo miglio, e non toccare
l'ambiente di una persona senza il suo consenso — non c'erano proprio.

Il documento NON SHALL promettere PIÙ di quanto l'envelope porti: un documento che
dice il falso SU SÉ STESSO costa più di un documento assente, perché lo si crede.

#### Scenario: una regola tolta dall'envelope
- **GIVEN** il documento che la dichiara ancora
- **THEN** il banco SHALL fallire

#### Scenario: una regola aggiunta al documento
- **GIVEN** nessuna regola corrispondente nell'envelope
- **THEN** il banco SHALL fallire

### Requirement: KANBAN-60 — Un collegamento consegnato si SONDA, e il dubbio non lo mostra

Un indirizzo consegnato SHALL essere SONDATO prima di essere mostrato come vivo.
Una risposta positiva SHALL valere VIVO; un errore del servizio, un rifiuto e
un'assenza di risposta SHALL valere MORTO — e un collegamento morto NON SHALL
essere mostrato.

L'esito SHALL essere tenuto in cache per una finestra: indirizzi identici nella
stessa finestra NON SHALL essere sondati più volte, e indirizzi diversi SHALL
essere sondati separatamente.

Un indirizzo MAI sondato NON SHALL avere una voce in cache: sarà la prossima sonda
a valutarlo.

#### Scenario: un servizio che non risponde
- **GIVEN** nessuna risposta entro il tempo
- **THEN** il collegamento NON SHALL essere mostrato

#### Scenario: lo stesso indirizzo due volte
- **GIVEN** due richieste ravvicinate
- **THEN** SHALL essere sondato una volta sola

### Requirement: KANBAN-61 — La scheda di consegna dice COSA è stato fatto, e non occupa la card per dire che non lo sa

La scheda di consegna SHALL riportare i numeri della consegna quando ci sono, e
quando NON ci sono NON SHALL mostrare uno zero muto né un rimando: una frase che
dice che l'informazione è altrove occupava la maggior parte della figura.

Senza codice consegnato SHALL essere scritto COSA è stato fatto quando il filo ha
una parola, e quando non ce l'ha SHALL essere DETTO, col MOTIVO.

Il testo SHALL andare a capo sulle PAROLE, SHALL dichiarare il troncamento, e una
parola più lunga della riga SHALL essere TAGLIATA invece di sforare. Un riassunto
lungo SHALL spezzarsi in righe entro un tetto.

Il rapporto fra altezza e larghezza SHALL restare sotto la soglia della card.

Il testo SHALL essere reso sicuro per il formato: caratteri speciali, a-capo e
spazi multipli NON SHALL rompere il file né il disegno.

Le etichette mostrate SHALL avere un tetto, e i passi chiusi SHALL comparire solo
se esistono dei sottotask.

La scheda SHALL riconoscere SÉ STESSA, e non confondersi con un'evidenza
qualunque.

#### Scenario: nessun codice consegnato
- **GIVEN** una consegna senza modifiche
- **THEN** NON SHALL comparire uno zero né un rimando, ma cosa è stato fatto

#### Scenario: un titolo con caratteri speciali
- **GIVEN** un testo che contiene caratteri del formato
- **THEN** il file SHALL restare valido

### Requirement: KANBAN-62 — Lampeggia l'ATTRAVERSAMENTO, non lo stato

Una card SHALL lampeggiare quando ATTRAVERSA un confine di colonna, e NON SHALL
lampeggiare per il fatto di TROVARSI in quella colonna: è la transizione a essere
l'informazione.

Il PRIMO caricamento NON SHALL far lampeggiare niente — una lista appena arrivata
non è una lista che si è mossa — e una card mai vista prima NON SHALL lampeggiare.

Una card ferma nella propria colonna NON SHALL rilampeggiare a ogni rilettura.

OGNI confine SHALL contare, non solo l'ultimo: e una card riaperta che poi torna
SHALL lampeggiare a ogni attraversamento.

Più card mosse insieme — da una diramazione o da un altro dispositivo — SHALL
lampeggiare TUTTE.

Il lampeggio SHALL dichiarare la colonna di arrivo.

#### Scenario: il primo caricamento
- **GIVEN** la lista appena arrivata
- **THEN** niente SHALL lampeggiare

#### Scenario: una card ferma
- **GIVEN** riletture successive senza movimenti
- **THEN** la card NON SHALL rilampeggiare

### Requirement: TASKLINK-01 — Il permalink di un task è un PERCORSO, e la forma vecchia continua a funzionare

Il collegamento a un task SHALL essere un PERCORSO pulito, senza query e senza
caratteri codificati, e SHALL fare il giro completo costruzione → lettura. Una
barra finale SHALL essere tollerata; un percorso malformato SHALL essere
rifiutato.

Davanti all'identificativo il percorso SHALL poter portare il TITOLO del task in
forma leggibile, e quel prefisso SHALL essere DECORATIVO: la lettura SHALL
ignorarlo del tutto e risolvere sul solo identificativo finale. Un prefisso
sbagliato, o rimasto indietro rispetto a un titolo cambiato, SHALL aprire lo
stesso task di un percorso senza prefisso. Una URL già ferma su quel task NON
SHALL essere riscritta per aggiornarne la decorazione.

La forma storica con la query SHALL continuare a essere LETTA, e SHALL essere
spezzata sul PRIMO separatore. Un collegamento che porta entrambe le forme SHALL
far vincere il percorso.

Il bersaglio SHALL essere riconosciuto solo sulla PROPRIA origine: un'origine
estranea, o un indirizzo che non è un task, SHALL valere NIENTE — e chi chiama
ripiega sull'apertura fuori dall'app.

L'apertura SHALL riflettersi nella URL con una SOSTITUZIONE quando la forma
storica va aggiornata, e con un'aggiunta altrimenti; già riflessa NON SHALL essere
ripetuta a vuoto, e in una finestra-gruppo NON SHALL ripetersi. La chiusura SHALL
tornare alla radice, e già alla radice SHALL essere un non-fare. La riflessione NON
SHALL cancellare ciò che non le appartiene.

Il ritorno indietro e avanti del browser SHALL riportare il bersaglio a chi
ascolta, e la disiscrizione SHALL staccare davvero.

Un collegamento aperto dal service worker SHALL aprire il cassetto del task; SHALL
accettare anche la forma assoluta e quella storica; SHALL restare MUTO su tutto ciò
che non è un collegamento profondo; e senza service worker SHALL essere un
non-fare, non un errore. Un collegamento a un topic SHALL aprire la tab del topic.

#### Scenario: un collegamento nella forma storica
- **GIVEN** un indirizzo con la query di una volta
- **THEN** SHALL essere letto, e l'apertura SHALL aggiornarlo al percorso pulito

#### Scenario: il titolo davanti all'identificativo non è più quello
- **GIVEN** un collegamento con un prefisso leggibile sbagliato
- **THEN** SHALL aprire lo stesso task di un collegamento senza prefisso

#### Scenario: un'origine estranea
- **GIVEN** un collegamento a un'altra origine
- **THEN** NON SHALL essere riconosciuto come bersaglio interno

### Requirement: STRIPMD-01 — L'anteprima di un piano è TESTO, e non perde le parole

La riduzione a testo semplice SHALL togliere i marcatori — titoli, grassetto,
corsivo, barrato, elenchi, citazioni — e CONSERVARE le parole. I collegamenti e le
immagini SHALL essere ridotti al loro testo o alla loro descrizione, mai
cancellati.

I recinti di codice SHALL sparire CONSERVANDO il contenuto del codice in linea:
un'anteprima che perde il nome di un comando non è più un'anteprima di quel piano.

Su un testo già semplice, e sul testo vuoto, SHALL essere un non-fare.

#### Scenario: un collegamento
- **GIVEN** un collegamento in formato markdown
- **THEN** SHALL restare il suo testo

#### Scenario: testo già semplice
- **GIVEN** un testo senza marcatori
- **THEN** SHALL uscire identico

### Requirement: KANBAN-63 — L'identità di una bacheca e le righe di transizione non si derivano a occhio

L'identificativo di una bacheca SHALL nascere dal percorso con una forma
DETERMINISTICA e DICHIARATA — nome della cartella più un suffisso derivato — e
SHALL essere inchiodato a un vettore noto: qualunque copia che lo riderivi da sé
nega quel vettore. Una barra finale SHALL cambiare il risultato, perché cambia il
percorso.

L'evento di cambio di stato SHALL dire da dove a dove, e con una ragione SHALL
aggiungerla senza spostare il confine: senza ragione il contenuto SHALL restare
IDENTICO a prima, o le righe già scritte diventano illeggibili. Una ragione che
contiene la stessa freccia o un altro separatore NON SHALL spostare il confine. La
ragione SHALL essere UNA riga con un TETTO: è una riga di cronologia, non un
thread.

Ciò che non è una transizione NON SHALL essere letto come tale.

#### Scenario: una ragione che contiene una freccia
- **GIVEN** un testo di ragione con dentro il separatore
- **THEN** il confine della transizione NON SHALL spostarsi

#### Scenario: una transizione senza ragione
- **GIVEN** nessuna ragione
- **THEN** il contenuto SHALL essere identico alla forma precedente

### Requirement: KANBAN-64 — Perché una card è ferma: una frase per ogni motivo, e il buco si DICHIARA

OGNI motivo per cui una card non si muove SHALL avere una frase, e la frase SHALL
dire COSA SUCCEDE DOPO. Quando la ragione NON si sa SHALL essere DICHIARATO il
buco: NON SHALL essere scritto «in coda», che è un'affermazione sull'ordine.

NESSUNA frase SHALL usare la parola che sulla card significa il CONTRARIO.

In revisione con la checklist APERTA la card è FERMA e SHALL dirlo; con la
checklist chiusa non c'è niente da dire. «Rinviata» in revisione SHALL essere
riconosciuta come falsa: da quella colonna non dispaccia nessuno. La checklist
aperta SHALL battere una promessa di rinvio, perché è la mossa più utile delle
due. Con una domanda aperta la ragione SHALL TACERE: la mossa è la persona. Una
consegna pulita con la checklist aperta NON è pulita: SHALL vincere «ferma».

In backlog «rinviata» SHALL diventare «ferma» — da lì non riparte niente — e una
finestra di rinvio scaduta SHALL restare una bugia. Senza NESSUNA promessa SHALL
tacere: il parcheggio si vede dalla colonna.

In corso SENZA agente SHALL essere detto, invece di sembrare in movimento; con un
agente dentro, o una persona sopra, non c'è niente da dire.

L'attesa di uno slot SHALL dire QUANTI ce ne sono davanti, col tono di una coda
che scorre. Un lavoro pesante TRATTENUTO SHALL dire che è LUI il tappo, non «in
coda, zero davanti». Un pesante IN VOLO SHALL avere una frase propria — non quella
del carico — e SHALL fermare OGNI card, non solo le pesanti. Né il pesante in volo
né il tappo SHALL coprire le ragioni proprie della card. «Aspetta uno slot» e «non
partirà mai» NON SHALL essere la stessa parola.

Il rinvio e il bloccante SHALL venire PRIMA del budget dei tentativi. Un bloccante
chiuso o archiviato NON SHALL bloccare più, con lo STESSO predicato del cancello
di dispatch. Interruttore spento e bacheca senza cartella SHALL essere due «non
partirà» detti in modo DIVERSO.

Uno step NON SHALL MAI essere «in coda»: la sua ragione è sempre il padre.

Il debito di consegna SHALL essere dichiarato solo quando è VERO — consegna
registrata e verdetto misurato — e senza l'identificativo della consegna NON è
stato verificato niente: SHALL tacere. «Non lo so» NON SHALL essere presentato
come un fatto. E vale solo su una card CHIUSA: in revisione non essere sul ramo
principale è la norma.

I plurali SHALL essere corretti: nessuna frase SHALL dire «uno … aperti».

#### Scenario: un pesante in volo
- **GIVEN** un lavoro pesante in corso
- **THEN** ogni card SHALL dirlo con la frase propria, senza coprire le proprie ragioni

#### Scenario: una ragione ignota
- **GIVEN** nessun motivo determinabile
- **THEN** SHALL essere dichiarato il buco, non «in coda»

### Requirement: KANBAN-65 — Chi lavora uno step senza agente suo, e cosa chiede una domanda

La forma AMBIGUA SHALL essere UNA sola: in corso, figlio, senza topic e senza
chip. È quella che finora non diceva niente.

Un antenato SHALL contare come «al lavoro» solo se è VIVO, in corso e con un
agente dentro. Il padre che lo lavora nel proprio turno SHALL essere detto sulla
card, con CHI. Se NESSUN antenato è al lavoro SHALL essere detto, così il triage
lo vede. SHALL vincere il PRIMO antenato al lavoro, non il padre diretto.

Una nota di servizio dopo una domanda NON SHALL mangiarsela; una parola vera dopo
la domanda SHALL chiuderla.

Una domanda le cui opzioni sono TUTTE azioni che la bacheca sa eseguire NON è una
domanda: è una CONSEGNA. Un'etichetta decorata SHALL sopravvivere al filtro e
restare un'azione. Un insieme MISTO SHALL restare una domanda: un'opzione che la
bacheca non può eseguire ha bisogno di una persona. Nessuna opzione SHALL restare
una domanda; nessun blocco NON è una domanda.

L'insieme delle azioni riconosciute SHALL coincidere con quelle che il server
esegue davvero, e con nient'altro.

#### Scenario: opzioni tutte eseguibili dalla bacheca
- **GIVEN** una domanda le cui opzioni sono tutte azioni di bacheca
- **THEN** SHALL essere trattata come consegna, non come domanda

#### Scenario: uno step figlio senza agente
- **GIVEN** uno step in corso, senza topic e senza chip
- **THEN** SHALL essere detto chi lo lavora, o che non lo lavora nessuno

### Requirement: CAUTHOR-01 — Un titolo tagliato a metà parola NON è un nome

Sulla bacheca viva, il 13/08/2026, quattrocentoquattro autori distinti erano NOMI
DI TOPIC — e il nome del topic di un agente dispacciato è il titolo del task
tagliato a sessanta caratteri. Una frase mozzata al posto di un nome è ciò che
questa etichetta esiste per correggere.

I ruoli riservati SHALL restare sé stessi e portare la propria natura, SHALL
essere riconosciuti dopo aver tolto gli spazi e le maiuscole, e SHALL tornare in
forma canonica.

Un identificativo di agente SHALL diventare un identificativo CORTO leggibile, e
quello completo SHALL sopravvivere altrove: l'etichetta NON SHALL MAI portare
l'identificativo intero. La forma abbreviata della sessione SHALL risolversi
allo stesso modo. Due agenti diversi sullo stesso task NON SHALL collassare in
un'etichetta sola. Il prefisso senza niente dietro SHALL essere l'agente generico.

Un autore a FORMA DI FRASE SHALL leggersi come l'agente; uno a forma di NOME
SHALL essere TENUTO, perché buttarlo via perderebbe un nome vero. Le due soglie
SHALL essere l'intera regola, e ciascuna da sola SHALL decidere. Un autore su più
righe NON SHALL MAI essere un nome, per quanto corto; gli spazi collassati NON
SHALL trasformare una frase in un nome.

Un autore vuoto SHALL essere l'agente, mai un'etichetta vuota; un autore che non è
testo NON SHALL far cadere la card; e NESSUNA etichetta SHALL essere più lunga
dello spazio che la ospita.

#### Scenario: un titolo tagliato a sessanta caratteri
- **GIVEN** un autore che è una frase mozzata
- **THEN** SHALL leggersi come l'agente

#### Scenario: un autore su due righe
- **GIVEN** un autore che contiene un a capo
- **THEN** NON SHALL essere trattato come un nome

### Requirement: TRAY-01 — Nel menu di sistema un gruppo VUOTO non compare

Un gruppo senza righe NON SHALL comparire: una voce che dice zero si legge come
un difetto, non come «niente da fare».

Le colonne di partenza e di arrivo NON SHALL entrare nel menu, e questo SHALL
essere DICHIARATO, non lasciato dedurre.

Il CONTEGGIO SHALL essere di TUTTI, mentre le righe mostrate SHALL essere solo le
prime: sono due numeri diversi e vanno detti come tali.

Ogni riga SHALL portare il PROGETTO: due card omonime su bacheche diverse
capitano.

Il glifo SHALL contare chi aspetta una DECISIONE, non tutto il lavoro aperto.

Un titolo corto SHALL restare intero; uno lungo SHALL essere tagliato su uno
SPAZIO e non a metà parola; una parola sola lunghissima SHALL essere spezzata,
perché tagliata è meglio che sparita. Gli a capo e gli spazi doppi SHALL
diventare uno spazio: una riga di menu è una riga.

#### Scenario: una colonna senza card
- **GIVEN** un gruppo vuoto
- **THEN** NON SHALL comparire nel menu

#### Scenario: un titolo lungo
- **GIVEN** un titolo che non ci sta
- **THEN** SHALL essere tagliato su uno spazio

### Requirement: DURAB-BOARD-01 — Cosa della bacheca sopravvive a un ricaricamento, e DOVE vive

Un ricaricamento NON SHALL far ricominciare da capo il lavoro impostato sulla
bacheca.

SHALL restare, e restare APPLICATO, il filtro di testo. SHALL restare CHIUSO
ciò che era chiuso — i pannelli del cassetto, lo spazio di lavoro — e LARGO ciò
che era largo.

**La bozza del campo di scrittura dei task SHALL restare, e SHALL vivere SUL
SERVER**, non nel browser: una bozza nel browser si perde cambiando dispositivo,
ed è esattamente quando serve.

Sezioni e larghezza della colonna di progetto SHALL restare nella STESSA scheda,
e una SECONDA scheda SHALL EREDITARLE invece di ripartire dal predefinito.

Il file aperto SHALL restare aperto.

#### Scenario: una seconda scheda
- **GIVEN** la colonna configurata nella prima
- **THEN** la seconda SHALL ereditarla

#### Scenario: la bozza del campo di scrittura
- **GIVEN** un ricaricamento
- **THEN** SHALL restare, e SHALL essere stata scritta sul server

### Requirement: TASKSYNC-01 — La sincronia con l'elenco esterno normalizza, e a parità vince l'esterno

Le voci senza identificativo SHALL essere RIFIUTATE. I sinonimi di stato SHALL
essere mappati su quelli noti. Le priorità testuali SHALL essere ristrette alla
scala numerica, e l'assenza SHALL cadere sul valore predefinito dichiarato. Un
istante fornito SHALL essere preservato nella forma standard.

La risoluzione del conflitto SHALL essere: si prende l'esterno se non esiste
riga locale; si prende l'esterno se è PIÙ NUOVO; si tiene il locale se è
STRETTAMENTE più nuovo; e a PARITÀ vince l'ESTERNO — la regola dev'essere
dichiarata, perché a parità qualcuno deve vincere e il silenzio produce
comportamenti diversi su due macchine.

L'ingestione SHALL scrivere o aggiornare OGNI voce, SHALL accettare entrambe le
forme del carico, SHALL TOLLERARE un documento malformato, e SHALL SALTARE le
voci che perdono il conflitto.

La sorveglianza SHALL ingerire più progetti alla prima scansione, ri-ingerire
alla modifica di un file, e gestire con grazia una radice assente.

#### Scenario: istanti identici
- **GIVEN** locale ed esterno con lo stesso istante
- **THEN** SHALL vincere l'esterno

#### Scenario: un documento malformato
- **GIVEN** un file illeggibile
- **THEN** NON SHALL far cadere la sincronia

### Requirement: DIFFSTAT-01 — La review deve dire COSA si sta approvando

Misurato sulla bacheca vera il 16/08: cinque card in revisione, e su tutte e
cinque il gesto di approvazione senza UN SOLO dato su cosa entrerebbe. Nessun
file, nessuna riga, nessun esito dei controlli.

Una consegna MISURATA SHALL portare i file e le righe fino al task, e la LISTA
SHALL portarli — non solo il dettaglio: si decide guardando la colonna.

**Senza misura SHALL restare NIENTE, non zero.** Una consegna VUOTA ma misurata
SHALL dire zero, e quello zero è un dato.

Una consegna NUOVA NON SHALL ereditare la misura di quella vecchia.

Entrare in revisione SHALL TIMBRARE l'istante, e il timbro SHALL RINNOVARSI a
ogni ingresso, non solo al primo. Ri-scrivere lo stato su una card che è GIÀ in
revisione, e restare in revisione, NON SHALL ri-timbrare. Anche questo istante
SHALL essere portato dalla LISTA.

Con un RIFIUTO la misura e gli esiti dei controlli SHALL CADERE, per entrambe le
strade che rifiutano, e da qualunque colonna si torni indietro: una misura che
sopravvive al rifiuto descrive una consegna che non esiste più.

#### Scenario: una consegna non misurata
- **GIVEN** nessuna misura disponibile
- **THEN** SHALL restare niente, non zero

#### Scenario: un rifiuto
- **GIVEN** una consegna rifiutata
- **THEN** misura ed esiti SHALL cadere

### Requirement: PREVENV-01 — La regola dell'anteprima vive nell'ENVELOPE, non nel thread di chi rivede

Prima, la promozione dell'anteprima scriveva a ogni ingresso in revisione senza
allegati — cioè nel thread di chi deve DECIDERE, che non è chi deve produrre
l'anteprima.

La regola SHALL essere referenziata dal messaggio di avvio e da quello di
ripresa dell'agente — l'envelope è l'unico posto che un agente dispacciato legge
davvero.

La promozione NON SHALL più scrivere quel testo nel thread.

#### Scenario: un ingresso in revisione senza allegati
- **GIVEN** una consegna senza anteprima
- **THEN** NON SHALL essere scritto niente nel thread

#### Scenario: l'avvio di un agente
- **GIVEN** il messaggio di avvio
- **THEN** SHALL contenere la regola dell'anteprima

### Requirement: REVAGE-01 — Da quanto una card aspetta una risposta

La colonna della revisione chiedeva di approvare senza dire DA QUANTO quella
richiesta fosse lì. L'istante di aggiornamento era nascosto apposta, e faceva
bene: si muove a ogni commento e a ogni etichetta, quindi non dice l'attesa.

L'attesa SHALL essere espressa in ore sotto la giornata, e in GIORNI oltre.

Senza istante NON SHALL essere inventata un'attesa, e un istante nel FUTURO NON
SHALL diventare un'attesa negativa o enorme.

#### Scenario: nessun istante
- **GIVEN** una card senza timbro
- **THEN** NON SHALL essere mostrata un'attesa

#### Scenario: un istante nel futuro
- **GIVEN** un timbro successivo ad adesso
- **THEN** NON SHALL produrre un'attesa assurda

### Requirement: EMPTYTHREAD-01 — Il vuoto di un task dice a CHI TOCCA

Fino al 16/08 i thread vuoti dicevano tutti la stessa identica frase, in ogni
colonna: cioè niente. La differenza che conta è fra una card che aspetta TE e una
che aspetta la macchina.

Il vuoto SHALL dire a chi tocca la mossa. I quattro stati SHALL avere QUATTRO
frasi distinte, e uno stato SCONOSCIUTO SHALL tornare alla frase neutra invece di
inventarne una.

La colonna di partenza SHALL nominare il GESTO che sblocca, non solo lo stato:
dire dove si è non dice cosa fare.

Ogni chiave SHALL esistere in ENTRAMBE le lingue.

#### Scenario: uno stato sconosciuto
- **GIVEN** una colonna non prevista
- **THEN** SHALL comparire la frase neutra

#### Scenario: la colonna di partenza
- **GIVEN** un task in attesa di essere messo in lavorazione
- **THEN** SHALL essere nominato il gesto che lo sblocca

### Requirement: KANBAN-66 — Una card che ha GIÀ consegnato non torna in lavorazione quando l'ultimo sottotask si chiude

«Libera ciò che aspettava questo task» vale per un blocco fra pari: quello
aspettava di COMINCIARE. Un padre che ha già consegnato no, e il sistema SHALL
distinguere i due casi invece di trattarli uguale.

Misurato il 28/08/2026: un padre già consegnato E atterrato restava in `review`
solo per il blocco dei sottotask aperti. Chiudere l'ultimo con
`PATCH {status:"done"}` rispondeva 200 e in due secondi il padre passava a
`in_progress` con un agente sopra.

I danni SHALL essere considerati due, e il secondo è quello che non si vede:
l'agente riparte su lavoro già su main dentro un worktree nuovo e vuoto; e il
rimettere in coda azzera `landing_state`, così la card smette di dire di essere
atterrata mentre git continua a dire che lo è.

Le porte che raggiungono il padre da un suo sottotask SHALL essere chiuse
entrambe: il PATCH che chiude il sottotask, e il COMMENTO lasciato su di esso.
Il segno che una card ha già prodotto SHALL essere letto da ciò che il record
già porta — lo scatto della consegna, il verdetto di atterraggio, o la colonna
`review` — senza indovinare.

#### Scenario: si chiude l'ultimo sottotask di un padre atterrato
- **GIVEN** un padre con `landingState` atterrato e un solo sottotask aperto
- **WHEN** quel sottotask passa a `done`
- **THEN** il padre SHALL restare in `review`
- **AND** `landingState` SHALL restare atterrato

#### Scenario: un blocco fra pari continua a sbloccare
- **GIVEN** un task in `todo` che non ha mai consegnato, fermo su una dipendenza
- **WHEN** quella dipendenza si chiude
- **THEN** il task SHALL essere dispacciato come prima

### Requirement: KANBAN-67 — L'anteprima ha uno spigolo che dice da che parte viene la luce

L'anteprima di una card SHALL portare il riflesso di bordo dell'app (`edge-lit`),
lo stesso delle tessere e dei comandi flottanti, e NON una copia a mano del
vestito del composer. Il filo alto SHALL leggere PIU' CHIARO dei lati in
entrambi i temi: e' la sola prova che il riflesso e' stato DIPINTO e non solo
dichiarato, perche' un'ombra `inset` su un elemento rimpiazzato (`img`, `video`)
non dipinge nulla mentre `getComputedStyle` la riporta parola per parola.
Misurato: prima 44/44 in scuro e 232/232 in chiaro, dopo 67/53 e 235/222.

L'anteprima SHALL conservare il proprio confine su qualunque contenuto: una
schermata bianca su una card bianca SHALL restare delimitata. Il bordo del media
NON SHALL essere tolto lasciando solo il riflesso: al 4% quel perimetro chiude
una forma, non ne disegna il confine.

L'anteprima NON SHALL proiettare ombra sulla card che la contiene: la card e'
l'oggetto che galleggia, e un figlio piu' pesante del genitore inverte
l'elevazione.

#### Scenario: una schermata bianca su una card bianca
- **GIVEN** una card con anteprima tutta bianca, in tema chiaro
- **THEN** il confine dell'anteprima SHALL essere distinguibile dal suo interno

#### Scenario: la luce viene da sopra
- **GIVEN** una card con anteprima, in tema chiaro e in tema scuro
- **THEN** il filo superiore SHALL leggere piu' chiaro dei fili laterali
- **AND** i pixel della card sopra l'anteprima SHALL restare piatti

### Requirement: KANBAN-68 — Il fuoco su un filtro resta DENTRO il filtro

L'app ha una sola regola di fuoco (`index.css`, `@layer base`): `outline: 2px
solid var(--primary)` con `outline-offset: 2px`. Su un controllo alto 24px
quell'anello viene disegnato FUORI dal rettangolo arrotondato, e attorno al
bottone da 12px che toglie un token sborda dal campo: e' il bordo segnalato il
29/08.

Un controllo della riga dei filtri NON SHALL far disegnare a nessuno dei propri
discendenti l'outline globale, e SHALL invece portare un anello `inset`: un
anello e' una `box-shadow`, quindi non sposta il layout, e `inset` gli vieta di
sporgere per costruzione.

L'anello SHALL esserci davvero. Togliere l'outline e basta lascerebbe un
controllo SENZA nessun segno di fuoco, che e' peggio del bordo: la verifica
SHALL misurare entrambe le meta'.

L'affordance da tastiera NON SHALL essere tolta per ottenere il risultato: il
bottone che rimuove un token SHALL restare raggiungibile col Tab e portare il
proprio anello. Un rimedio per sottrazione (`tabIndex=-1`) soddisferebbe le
prime due meta' cancellando questa.

#### Scenario: il campo dei filtri a fuoco
- **GIVEN** il campo dei filtri con un token, messo a fuoco
- **THEN** nessun suo discendente SHALL disegnare un outline
- **AND** il guscio SHALL portare una `box-shadow` `inset`

#### Scenario: il bottone che toglie un token
- **GIVEN** quel bottone messo a fuoco
- **THEN** NON SHALL disegnare un outline
- **AND** SHALL portare il proprio anello `inset`

### Requirement: KANBAN-69 — I filtri della board sono UN campo, e il campo non contraddice mai la board

La ricerca, la priorita', chi chiude, il genere e l'assegnatario SHALL vivere in
UN SOLO campo. Il filtro per PROGETTO NON SHALL entrarci: ha gia' una ricerca
propria e una striscia di chip in linea.

Il valore dell'input SHALL essere il testo di ricerca, sempre, senza sintassi a
prefissi: la board si restringe scrivendo esattamente come prima.

IL PANNELLO NON SHALL MAI CONTRADDIRE LA BOARD. Le righe SHALL essere sempre
filtrate dallo stesso testo, e il pannello SHALL essere montato solo se c'e'
almeno una riga: lo stato «nessun risultato» e' cosi' IRRAGGIUNGIBILE, perche' un
pannello che dice «niente» sopra una board che si e' ristretta sullo stesso
testo e' una bugia che si legge prima della board. Poiche' una riga puo' stare a
schermo solo PERCHE' la query l'ha prodotta, consumare la query quando la riga
viene scelta e' corretto per costruzione.

A RIPOSO il campo SHALL mostrare il catalogo: cliccandolo, senza aver scritto
niente, SHALL comparire cosa si puo' filtrare, raggruppato. Ogni gruppo SHALL
mostrarne alcuni e dichiarare quanti ne restano: un tetto che tronca in silenzio
si legge come «non c'e' altro». Una query SHALL togliere il tetto — cio' verso
cui si sta scrivendo non puo' essere la cosa nascosta dietro il «+N».

Il cursore da tastiera SHALL partire da NESSUNA riga: con il testo vivo, un
Invio su una riga preselezionata trasformerebbe in token cio' che si sta
scrivendo, e con le righe scelte che restano in lista potrebbe anche TOGLIERE un
filtro gia' acceso.

Ogni token attivo SHALL essere disegnato, e il suo bottone di rimozione SHALL
restare una fermata di Tab: un contatore «+N» toglierebbe i token dal DOM, e una
board ristretta su cinque condizioni si annuncerebbe come una ricerca vuota.

#### Scenario: il catalogo a riposo
- **GIVEN** il campo dei filtri cliccato, senza testo
- **THEN** SHALL mostrare i gruppi con le loro intestazioni
- **AND** ogni gruppo troncato SHALL dichiarare quanti ne restano

#### Scenario: una query che non trova niente
- **GIVEN** un testo che non corrisponde a nessuna voce del catalogo
- **THEN** il pannello NON SHALL essere montato
- **AND** la board SHALL restare ristretta su quel testo

#### Scenario: scegliere una voce
- **GIVEN** una voce raggiunta con le frecce e applicata
- **THEN** SHALL diventare un token
- **AND** il testo SHALL essere consumato
