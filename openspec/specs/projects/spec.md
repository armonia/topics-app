# Projects

First-class project entities owning worktrees.

### Requirement: PROJECT-01 — Project Entity Lifecycle

The system SHALL persist a first-class `Project` entity representing a registered codebase or working directory, supporting create, read, update (rename + metadata), archive, restore, and delete operations. Projects are user-global and not space-scoped in this phase.

#### Scenario: Create a project from a directory path
- **GIVEN** the user opens the Project creation flow
- **WHEN** the user provides a name and an absolute filesystem path
- **THEN** the system SHALL persist a new row in the `projects` table with a generated UUID id, a slug derived from the name, and the provided path
- **AND** SHALL broadcast `project:new` over the WebSocket channel to all connected clients
- **AND** the new project SHALL appear in the project list returned by `GET /api/projects`

#### Scenario: Project slug is unique
- **GIVEN** a project named "Topics App" already exists with slug `topics-app`
- **WHEN** another project named "Topics App" is created
- **THEN** the system SHALL reject the request with HTTP 409 and an error payload describing the slug collision
- **AND** the user SHALL be offered an editable slug field to disambiguate

#### Scenario: Project path validation
- **GIVEN** the user is creating a project
- **WHEN** the provided path does not exist on the filesystem at create time
- **THEN** the system SHALL reject the request with HTTP 400 and a clear error message naming the missing path
- **AND** no row SHALL be persisted

#### Scenario: Lookup project by path
- **GIVEN** a project exists at path `/Users/x/code/foo`
- **WHEN** a client calls `GET /api/projects?path=/Users/x/code/foo`
- **THEN** the system SHALL return the matching project record
- **AND** if no match exists, SHALL return HTTP 200 with body `null` (not 404)

#### Scenario: Update project metadata
- **GIVEN** a project exists
- **WHEN** the user issues `PATCH /api/projects/:id` with a new name, color, or icon
- **THEN** the system SHALL persist the update with a new `updated_at` timestamp
- **AND** SHALL broadcast `project:updated` to all clients
- **AND** changing the name SHALL NOT change the slug (slug is immutable)

#### Scenario: Archive project hides it from active list
- **GIVEN** a project is active
- **WHEN** the user archives the project via `POST /api/projects/:id/archive`
- **THEN** the project SHALL be marked `archived=1` in the database
- **AND** SHALL no longer appear in `GET /api/projects` (which defaults to non-archived)
- **AND** SHALL appear in `GET /api/projects?archived=true`
- **AND** SHALL broadcast `project:archived` to all clients

#### Scenario: Restore archived project
- **GIVEN** a project is archived
- **WHEN** the user issues `POST /api/projects/:id/restore`
- **THEN** the project's `archived` flag SHALL flip back to 0
- **AND** SHALL reappear in the default `GET /api/projects` list
- **AND** SHALL broadcast `project:updated`

#### Scenario: Delete project with confirmation
- **GIVEN** a project has zero worktrees and zero topics referring to its path
- **WHEN** the user issues `DELETE /api/projects/:id`
- **THEN** the system SHALL remove the row and SHALL broadcast `project:deleted`

#### Scenario: Delete project blocked when worktrees exist
- **GIVEN** a project has at least one worktree
- **WHEN** the user issues `DELETE /api/projects/:id`
- **THEN** the system SHALL respond HTTP 409 with body listing the dependent worktrees
- **AND** the project SHALL remain unchanged
- **AND** the user SHALL be guided to delete worktrees first

### Requirement: PROJECT-02 — Backward Compatibility With `project_path` Strings

The system SHALL allow existing topics, tasks, and boards that reference a project via the legacy `project_path` / `project_id` string columns to continue functioning without any forced migration to the new `projects` table. Auto-creation of project records is optional and never destructive.

#### Scenario: Legacy topic without a project record
- **GIVEN** a topic exists with `project_path = '/Users/x/code/foo'` and no `projects` row matches that path
- **WHEN** the user opens that topic
- **THEN** all chat, tool, file, and git operations SHALL behave exactly as before this change
- **AND** the topic settings panel SHALL NOT show a Project or Worktree section

#### Scenario: Legacy topic gains a project on user action
- **GIVEN** a topic with `project_path = '/Users/x/code/foo'` and no matching `projects` row
- **WHEN** the user explicitly creates a Project at that path via the new UI
- **THEN** the new `projects` row SHALL be created
- **AND** the existing topic's `project_path` SHALL remain set unchanged
- **AND** subsequent topics opened against that path MAY display the new Project in the topic settings

#### Scenario: Tasks `project_id` string is unaffected
- **GIVEN** the `tasks` table holds rows with `project_id` as a string (often a project path)
- **WHEN** any project is created, modified, or deleted
- **THEN** the `tasks.project_id` column SHALL remain a string with no FK constraint to `projects.id`
- **AND** all existing board APIs SHALL continue to work exactly as today

### Requirement: PROJECT-03 — WebSocket Broadcast Hygiene

All project-mutating endpoints SHALL emit a typed WebSocket broadcast immediately after a successful database commit, using the existing `broadcastToAll` helper, and the broadcast envelope SHALL contain the project's full row plus a `payload_version: 1` field for forward compatibility.

#### Scenario: Broadcast follows the database commit
- **WHEN** any project mutation succeeds
- **THEN** the WebSocket broadcast SHALL be sent within 50 ms of the commit
- **AND** the broadcast envelope SHALL be `{ type: 'project:<verb>', project: <row>, payload_version: 1 }`
- **AND** clients receiving the broadcast SHALL be able to update their cache without a follow-up REST call

#### Scenario: Broadcast does not fire on validation failure
- **GIVEN** a project mutation request is rejected by validation
- **WHEN** the request is processed
- **THEN** no `project:*` broadcast SHALL be emitted
- **AND** no row SHALL be persisted

### Requirement: PROJECT-04 — A Shared Project Says So On Its Tab

A project tab SHALL carry the organisation's mark when, and only when, that project is visible to someone other than the person looking at it. The mark SHALL name the organisation it is shared with, SHALL be anchored by a stable `data-testid` rather than a styling class, and SHALL appear and disappear as the sharing changes, without a reload.

The condition is deliberately narrower than `projects.org_id != null`: every project created on an installation is stamped with that installation's own organisation, so the column is set on projects nobody else can see. The mark follows the warning — "other people can read this" — not the column.

#### Scenario: A project shared with an organisation of several people
- **GIVEN** a project whose `org_id` names a live organisation with more than one live member
- **AND** the project is not marked `incognito`
- **WHEN** its tab is rendered
- **THEN** the tab SHALL show the organisation mark
- **AND** the mark's tooltip SHALL name the organisation

#### Scenario: An organisation whose only member is me is not "shared"
- **GIVEN** a project whose `org_id` names an organisation with exactly one live member
- **WHEN** its tab is rendered
- **THEN** the tab SHALL show no organisation mark
- **AND** the same SHALL hold for a project with `org_id` NULL, for a project marked `incognito`, and for an `org_id` the client cannot resolve to a name

#### Scenario: The mark follows the sharing live
- **GIVEN** a tab showing a shared project
- **WHEN** the project is marked `incognito` and the server emits `project:updated`
- **THEN** the mark SHALL disappear without a page reload
- **AND** clearing `incognito` again SHALL bring it back the same way

### Requirement: PROJECT-05 — L'icona di un progetto si serve solo per cartelle già conosciute

La rotta che serve l'icona di un progetto SHALL accettare un percorso scelto dal
client, e per questo SHALL servirla SOLO per cartelle che il server già conosce
per altra via. Senza quel vincolo la rotta è un modo per enumerare il disco di
chi ospita il server.

L'elenco delle cartelle conosciute SHALL essere l'UNIONE di ogni sorgente in cui
un progetto può comparire — l'indice dei progetti, i percorsi dei topic, i
worktree, le cartelle di lavoro dei terminali, i riferimenti nello stato
dell'interfaccia, e i progetti del workspace che portano un marcatore. Un
cancello sul solo indice dei progetti negherebbe quasi tutto: quasi nessun
progetto è registrato lì.

Il confronto SHALL essere ESATTO e mai per prefisso: «dentro un progetto noto»
aprirebbe ogni discendente all'enumerazione.

L'elenco SHALL essere ricalcolato a ogni richiesta e mai messo in cache: una
cache che memorizza un DINIEGO lo cristallizza, e una cartella appena aperta è
già legittima.

Una cartella conosciuta ma senza icona SHALL rispondere «niente da mostrare»,
non «non esiste»: sono due fatti diversi e il secondo sarebbe falso.

#### Scenario: una cartella che diventa nota
- **GIVEN** una cartella rifiutata perché sconosciuta
- **WHEN** diventa nota per una qualunque delle sorgenti
- **THEN** l'icona SHALL essere servita, senza bisogno di ricostruire niente

#### Scenario: una sottocartella
- **GIVEN** un progetto noto e una sua sottocartella
- **THEN** il progetto SHALL essere servito e la sottocartella SHALL essere rifiutata

#### Scenario: nota ma senza icona
- **GIVEN** una cartella nota che non porta nessuna icona
- **THEN** la risposta SHALL dire «niente», non «non trovato»

### Requirement: PROJECT-06 — Il percorso di un progetto si ri-deduce, e non si indovina mai

L'identificativo di un progetto SHALL essere ricondotto al suo percorso
ri-calcolando l'identificativo di ogni candidato, e NON tenendo una mappa
inversa: una mappa è una seconda verità che un giorno diverge.

Il riconoscimento di una cartella come progetto SHALL richiedere un MARCATORE, e
l'elenco delle cartelle nascoste da escludere SHALL essere dichiarato per nome —
con l'eccezione, esplicita, della cartella di lavoro dell'agente, i cui figli
sono progetti legittimi.

Dedurre un percorso da una CONVERSAZIONE SHALL avvenire in due giri: prima si
cerca un percorso che ESISTE ed è una cartella, su tutto il testo; poi, solo sui
messaggi di una PERSONA, un percorso che ancora non esiste ma il cui genitore sì
— è il caso di «creami un progetto in…».

Il secondo giro NON SHALL poter contraddire il primo: un percorso che esiste ma
NON è una cartella SHALL essere saltato, mai restituito. Senza questa regola un
eseguibile da sedici kilobyte è diventato un progetto fantasma.

Senza nessun riscontro la risposta SHALL essere «non lo so», mai un default.

La cartella in cui NASCE un progetto nuovo SHALL essere dedotta dal genitore
comune dei progetti già noti, SHALL richiedere una maggioranza di almeno due, e
il genitore scelto SHALL esistere. Le cartelle nascoste e la home nuda NON SHALL
essere candidate.

Le chiavi derivate da un percorso SHALL essere calcolate in UN punto solo. Erano
in tre copie indipendenti, e una derivazione fuori sincrono fa sparire una pane
senza nessun errore.

#### Scenario: un file che sembra un progetto
- **GIVEN** un testo che nomina un percorso esistente che è un file
- **THEN** NON SHALL essere restituito come progetto

#### Scenario: un solo progetto conosciuto
- **GIVEN** un solo progetto noto
- **THEN** la cartella per i nuovi NON SHALL essere dedotta dal suo genitore

### Requirement: PROJECT-07 — Incognito vuol dire NESSUNO, e chi non vede riceve solo l'identificativo

La visibilità di un progetto SHALL essere decisa per OSSERVATORE. Un progetto
marcato INCOGNITO SHALL essere visibile SOLO a chi l'ha marcato — nemmeno ai
compagni della stessa organizzazione, e nemmeno al proprietario
dell'installazione se il progetto appartiene a un'altra persona.

Due identità ASSENTI NON SHALL valere come la stessa persona: il vuoto non è un
identificativo.

La macchina stessa SHALL vedere tutto, incogniti compresi.

**Chi NON vede un progetto SHALL ricevere un annuncio col SOLO identificativo** —
niente nome, niente percorso. Un annuncio completo mandato a tutti rivela, con i
suoi campi, esattamente ciò che l'incognito doveva nascondere. La regola SHALL
valere su TUTTI gli annunci che riguardano un progetto, quello di creazione
compreso: proteggere solo la modifica lascia aperta la nascita.

Un progetto senza organizzazione SHALL restare visibile a chi lo possiede e al
proprietario dell'installazione, com'era prima che esistessero le colonne della
condivisione.

#### Scenario: un compagno di organizzazione
- **GIVEN** un progetto incognito e una persona della stessa organizzazione
- **THEN** NON SHALL vederlo

#### Scenario: annuncio a chi non vede
- **GIVEN** un annuncio di progetto verso chi non ha visibilità
- **THEN** SHALL contenere il solo identificativo
