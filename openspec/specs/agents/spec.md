## Purpose

Specifies behavioral scenarios for agent monitoring including profile management, session tracking, heartbeat timelines, topic assignment, session history viewing, and status indicators.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- The agent management pane is visible (via sidebar or add-pane menu)
- At least one agent profile exists in the roster
## Requirements
### Requirement: AGENT-01 — Profiles, Sessions & Heartbeats

**Status: NOT BUILT** — The agent roster shipped out on 2026-08-05 together with the panes that showed it (see `tests/unit/ws-outbound-coverage.test.ts`). Nothing in the client lists or edits agent profiles today. The cure is deleting this requirement, not writing a test for it; the marker keeps the coverage gate from counting it as debt, and the gate fails if a test ever claims it.

The system SHALL support viewing agent sessions with status indicators, managing agent profiles via CRUD operations, tracking heartbeat timelines, and filtering the roster by search and status.

#### Scenario: Sessions tab shows Live and History sections
- **GIVEN** the agent pane is open on the Sessions tab
- **WHEN** the sessions list loads
- **THEN** a "Live" section header is visible showing currently active sessions
- **AND** a "History" section header is visible showing past sessions

#### Scenario: Session rows display agent name and status badge
- **GIVEN** the Sessions tab is showing session entries
- **WHEN** the user views a session row
- **THEN** the agent name associated with the session is displayed
- **AND** a status badge shows the session state (e.g., "Active" or "Completed")

#### Scenario: Session metadata shows token count
- **GIVEN** a session entry exists with recorded token usage
- **WHEN** the session row is displayed in the list
- **THEN** the token count is shown in abbreviated form (e.g., "32K tok")

#### Scenario: Heartbeat timeline opens from profile Sessions button
- **GIVEN** the user is on the Roster tab viewing agent profile cards
- **WHEN** the user clicks the "Sessions" button on a profile card
- **THEN** a heartbeat timeline modal opens showing "Session History" as the heading

#### Scenario: Session count displayed in timeline modal
- **GIVEN** the heartbeat timeline modal is open for an agent
- **WHEN** the modal content loads
- **THEN** the total number of sessions is displayed (e.g., "3 sessions")

#### Scenario: Timeline shows active and completed sessions
- **GIVEN** the heartbeat timeline modal is open
- **WHEN** session entries are listed in the timeline
- **THEN** active sessions display an "active" status indicator
- **AND** completed sessions display a "completed" status indicator

#### Scenario: Close timeline modal via X button
- **GIVEN** the heartbeat timeline modal is open
- **WHEN** the user clicks the X close button on the modal header
- **THEN** the modal closes and is no longer visible
- **AND** the roster view returns to focus

#### Scenario: Edit existing agent profile name
- **GIVEN** the user is on the Roster tab viewing profile cards
- **WHEN** the user clicks "Edit" on a profile card
- **THEN** an "Edit Agent Profile" modal opens
- **AND** the user can clear the name field and enter a new name
- **AND** clicking save closes the modal and the updated name appears in the roster

#### Scenario: Create new agent profile
- **GIVEN** the user is on the Roster tab
- **WHEN** the user clicks the create agent button
- **THEN** a "Create Agent Profile" modal opens
- **AND** the user fills in a name and clicks the create button
- **AND** the new agent appears in the roster

#### Scenario: Roster search filters profiles by name
- **GIVEN** the Roster tab shows multiple agent profile cards
- **WHEN** the user types a name fragment into the search input
- **THEN** only profile cards matching the search text are displayed
- **AND** clearing the search input restores all profile cards

#### Scenario: Status filter shows only Available agents
- **GIVEN** the Roster tab shows agents with different statuses
- **WHEN** the user clicks the "Available" status filter button
- **THEN** only agents with available status are shown
- **AND** other agents are hidden from the list

#### Scenario: Status filter shows only Offline agents
- **GIVEN** the Roster tab shows agents with different statuses
- **WHEN** the user clicks the "Offline" status filter button
- **THEN** only agents with offline status are shown
- **AND** other agents are hidden from the list

#### Scenario: All status filter resets to show every agent
- **GIVEN** a status filter is currently active (e.g., Available or Offline)
- **WHEN** the user clicks the "All" status filter button
- **THEN** all agent profile cards are displayed regardless of status

#### Scenario: Session search filter matches by display name
- **GIVEN** the Sessions tab shows multiple live session entries
- **WHEN** the user types a display name fragment into the session search input
- **THEN** only sessions whose agent display name matches are shown
- **AND** non-matching sessions are hidden

#### Scenario: Session search filter matches by session key
- **GIVEN** the Sessions tab shows multiple live session entries
- **WHEN** the user types a session key fragment into the session search input
- **THEN** only sessions whose key matches are shown
- **AND** non-matching sessions are hidden

#### Scenario: Session search with no matches hides all sessions
- **GIVEN** the Sessions tab shows live session entries
- **WHEN** the user types a term that matches neither display name nor key
- **THEN** no live session entries are visible

### Requirement: AGENT-02 — Assignment, Session History & Status Indicators

**Status: NOT BUILT** — Same removal as AGENT-01. What lives under "agents" now is the sub-agent orchestrator — five routes, covered by `topics-mcp-server.test.ts` — which is a different feature wearing the same word. The cure is deleting this requirement, not writing a test for it; the marker keeps the coverage gate from counting it as debt, and the gate fails if a test ever claims it.

The system SHALL support assigning agents to topics, viewing session transcripts with messages and tool calls, navigating session detail views, and displaying status indicators throughout the agent UI.

#### Scenario: Assign button opens topic input modal
- **GIVEN** the user is on the Roster tab viewing agent profile cards
- **WHEN** the user clicks the "Assign" button on a profile card
- **THEN** a topic input modal appears showing the agent name in the heading

#### Scenario: Enter topic ID and click Continue
- **GIVEN** the topic input modal is open for agent assignment
- **WHEN** the user enters a topic ID in the input field and clicks "Continue"
- **THEN** the topic input modal transitions to the agent assignment panel

#### Scenario: Agent assignment panel shows available agents
- **GIVEN** the agent assignment panel is open for a topic
- **WHEN** the panel content loads
- **THEN** an "Available" section header is visible with an agent count
- **AND** available agents are listed for assignment

#### Scenario: Click Worker role button to assign agent
- **GIVEN** the agent assignment panel shows available agents
- **WHEN** the user clicks the "Worker" role button next to an agent
- **THEN** the agent moves from the Available section to the Assigned section

#### Scenario: Assigned section shows agent with role badge
- **GIVEN** an agent has been assigned to a topic
- **WHEN** the assignment panel updates
- **THEN** the "Assigned" section header is visible with a count
- **AND** the assigned agent displays a "worker" role badge

#### Scenario: Remove button visible for unassigning agent
- **GIVEN** an agent is listed in the Assigned section
- **WHEN** the user views the assigned agent entry
- **THEN** a "Remove" button is visible to unassign the agent

> Note: Agent assignment from the Kanban board (assigning agents to tasks) is also relevant here but owned by the Kanban spec where the action starts.

#### Scenario: Session transcript shows message bubbles with content
- **GIVEN** the user has clicked a session row to open the session detail view
- **WHEN** the session detail loads with chat history
- **THEN** user messages appear as message bubbles with their text content
- **AND** assistant messages appear as message bubbles with their response text

#### Scenario: Timestamps visible on session messages
- **GIVEN** the session detail view shows message bubbles
- **WHEN** the user views a message entry
- **THEN** a timestamp is visible indicating when the message was sent

#### Scenario: Tool calls indicator on assistant messages
- **GIVEN** an assistant message in the session detail includes tool call results
- **WHEN** the message is displayed
- **THEN** a tool calls indicator shows the count (e.g., "2 tool calls")

#### Scenario: Heartbeat entry shows token delta
- **GIVEN** the session detail timeline includes heartbeat events
- **WHEN** a heartbeat entry is displayed
- **THEN** the token usage delta is shown in abbreviated form (e.g., "+1K tok")

#### Scenario: Action entries show label and description
- **GIVEN** the session detail timeline includes action events
- **WHEN** an action entry is displayed
- **THEN** the action label text is visible (e.g., "Task completed")
- **AND** the action description is shown below (e.g., "Auth module finished")

#### Scenario: Click session row to view session detail
- **GIVEN** the Sessions tab shows a list of session entries
- **WHEN** the user clicks on a session row
- **THEN** the session detail view opens showing the agent name in the header

#### Scenario: Session detail shows status badge
- **GIVEN** the session detail view is open
- **WHEN** the header area is displayed
- **THEN** a status badge is visible indicating the session state (e.g., "Active")

#### Scenario: Pane button visible in session detail header
- **GIVEN** the session detail view is open for a session
- **WHEN** the user views the detail header
- **THEN** a "Pane" button is visible to open the session in a separate pane

#### Scenario: Back button returns to session list
- **GIVEN** the session detail view is open
- **WHEN** the user clicks the back arrow button
- **THEN** the session list view is restored
- **AND** session rows are visible again

#### Scenario: Status badges distinguish Active and Completed sessions
- **GIVEN** the session list contains both active and completed sessions
- **WHEN** the user views the session entries
- **THEN** active sessions display an "Active" badge
- **AND** completed sessions display a "Completed" badge

### Requirement: AGENT-03 — Profile Editor

**Status: NOT BUILT** — Same removal as AGENT-01: the agent-profile editor no longer exists. The cure is deleting this requirement, not writing a test for it; the marker keeps the coverage gate from counting it as debt, and the gate fails if a test ever claims it.

The system SHALL provide a modal form for creating new agent profiles and editing existing ones, with fields for name, avatar emoji, role, model preference, max concurrent tasks, and capabilities, including validation that prevents saving without a name.

#### Scenario: Create profile modal opens with empty fields
- **GIVEN** the user is on the Roster tab
- **WHEN** the user clicks the create agent button
- **THEN** a modal opens with the heading "Create Agent Profile"
- **AND** the name field is empty
- **AND** the role defaults to "Worker"
- **AND** the avatar defaults to the first emoji option
- **AND** the submit button label reads "Create"

#### Scenario: Edit profile modal opens with pre-filled fields
- **GIVEN** the user is on the Roster tab viewing an existing agent profile
- **WHEN** the user clicks the "Edit" button on the profile card
- **THEN** a modal opens with the heading "Edit Agent Profile"
- **AND** the name field contains the current profile name
- **AND** the role selection reflects the current role
- **AND** the avatar shows the current emoji
- **AND** the submit button label reads "Save"

#### Scenario: Avatar emoji selection updates the chosen avatar
- **GIVEN** the profile editor modal is open
- **WHEN** the user clicks a different emoji in the avatar grid
- **THEN** the clicked emoji receives primary ring styling indicating selection
- **AND** the previously selected emoji loses the ring styling

#### Scenario: Role selector toggles between Lead, Worker, and Specialist
- **GIVEN** the profile editor modal is open
- **WHEN** the user clicks the "Lead" role button
- **THEN** the Lead button shows active primary styling
- **AND** the previously selected role button returns to default styling

#### Scenario: Empty name prevents form submission
- **GIVEN** the profile editor modal is open
- **WHEN** the name field is empty or contains only whitespace
- **THEN** the submit button is disabled with reduced opacity
- **AND** clicking the button has no effect

#### Scenario: Saving a new profile calls the create API
- **GIVEN** the "Create Agent Profile" modal is open
- **WHEN** the user fills in the name and clicks "Create"
- **THEN** the button text changes to "Saving..." during the request
- **AND** the agentProfilesApi.create method is called with the form data
- **AND** the modal closes on success and the onSave callback is invoked

#### Scenario: Saving an edited profile calls the update API
- **GIVEN** the "Edit Agent Profile" modal is open for an existing profile
- **WHEN** the user modifies the name and clicks "Save"
- **THEN** the agentProfilesApi.update method is called with the profile ID and updated data
- **AND** the modal closes on success

#### Scenario: API error displays error message in modal
- **GIVEN** the profile editor modal is open
- **WHEN** the save request fails with an error
- **THEN** an error message appears in a red-styled banner inside the modal
- **AND** the submit button returns to its normal enabled state

#### Scenario: Cancel button closes modal without saving
- **GIVEN** the profile editor modal is open with unsaved changes
- **WHEN** the user clicks the "Cancel" button
- **THEN** the modal closes
- **AND** no API call is made

#### Scenario: Close X button dismisses the modal
- **GIVEN** the profile editor modal is open
- **WHEN** the user clicks the X button in the modal header
- **THEN** the modal closes without saving

#### Scenario: Capabilities field accepts comma-separated values
- **GIVEN** the profile editor modal is open
- **WHEN** the user types "coding, testing, research" in the capabilities field
- **THEN** the values are parsed as three separate capabilities on save
- **AND** empty segments between commas are ignored

#### Scenario: Max concurrent tasks accepts numeric input
- **GIVEN** the profile editor modal is open
- **WHEN** the user sets the max concurrent tasks field to 3
- **THEN** the value is stored as the integer 3
- **AND** the field enforces a minimum of 1 and maximum of 10

#### Scenario: Profile card displays name, status, role badge, and actions
- **GIVEN** an agent profile exists in the roster
- **WHEN** the profile card renders
- **THEN** the card shows the avatar emoji, profile name, and a colored status dot
- **AND** a role badge (Lead, Worker, or Specialist) is displayed below the name
- **AND** Edit, Assign, and Sessions action buttons appear in the card footer

#### Scenario: Profile card shows capabilities as tags
- **GIVEN** an agent profile has capabilities defined
- **WHEN** the profile card renders
- **THEN** each capability appears as a small tag below the role badge

#### Scenario: Profile card shows max tasks count
- **GIVEN** an agent profile has a max concurrent tasks setting
- **WHEN** the profile card renders
- **THEN** the text "Max tasks: N" appears in the footer area


### Requirement: AGENT-04 — «Consenti sempre» scrive una regola, e nessuna regola nega

Il consenso su uno strumento SHALL poter essere ricordato: un canale di permesso
senza memoria non si può usare, perché la stessa chat chiede tre volte di fila
per lo stesso strumento e al quarto pannello la persona preme «consenti» senza
leggere — che è il modo in cui una domanda di sicurezza smette di essere una
domanda.

Le regole SHALL vivere nel database di Topics e NON in un file di configurazione
del repository. Una capacità NON SHALL dipendere da in quale cartella è nata la
chat né da un file che nessuno versiona: lo stesso identico strumento passava
dentro il repo e moriva muto altrove.

Un pattern SHALL avere due forme sole — il nome esatto, e un prefisso che
termina con l'asterisco. Un asterisco NUDO, o in mezzo, NON SHALL essere un
pattern: trasformerebbe una lista di consensi in una modalità «fai pure» scritta
di traverso, e per quella esiste già un nome scelto in chiaro nel selettore di
autonomia.

La decisione SHALL avere DUE esiti — concedi, oppure chiedi — e NON SHALL
esistere un ramo che NEGA da solo. Una regola che nega in silenzio riprodurrebbe
esattamente il guasto che le regole chiudono: uno strumento che sparisce senza
che nessuno lo veda. Un no lo dice una persona, e si vede.

Gli strumenti che sono LE MANI DI TOPICS dentro la chat — aprire un pannello,
aggiornare un task, fare una domanda all'umano — NON SHALL essere mai chiesti.
Il 07/08/2026 è arrivata una richiesta di permesso proprio sullo strumento che
serve a FARE una domanda: per mostrare una domanda serviva il permesso di
mostrare una domanda. Un'applicazione non chiede il permesso di essere sé stessa,
e cosa quegli strumenti possono fare l'ha già deciso chi ha installato Topics.

Quando l'elenco delle regole non è leggibile — tabella assente, database non
raggiungibile — il canale SHALL CHIEDERE. Il guasto deve cadere dal lato in cui
si domanda, mai dal lato in cui si concede.

Scrivere una regola SHALL essere idempotente e NON SHALL spostare la data della
prima concessione: quando è stato concesso è la cosa che si vuole sapere
guardando l'elenco.

#### Scenario: un asterisco nudo
- **GIVEN** un pattern fatto del solo asterisco
- **THEN** NON SHALL essere accettato come regola, e NON SHALL coprire niente

#### Scenario: la tabella non c'è
- **GIVEN** un server partito prima della migration che crea le regole
- **THEN** ogni strumento SHALL essere CHIESTO

#### Scenario: le mani di Topics
- **GIVEN** uno strumento del ponte di Topics
- **THEN** SHALL essere concesso senza chiedere, anche senza nessuna regola scritta

#### Scenario: due volte «consenti sempre»
- **GIVEN** una regola già scritta
- **WHEN** la si scrive di nuovo
- **THEN** NON SHALL comparire un duplicato
- **AND** la data della prima concessione SHALL restare
