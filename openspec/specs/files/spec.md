## Purpose

Specifies behavioral scenarios for file explorer tree navigation, file editing and tabs, file search, breadcrumb navigation, script runner, process management, git status indicators, diff viewer, and version control operations.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- A topic exists with a linked project folder containing files and a git repository
- The file explorer pane is visible in the layout
## Requirements
### Requirement: FILE-01 — Explorer Tree, File CRUD & Editor

The system SHALL support browsing files in a hierarchical tree, opening files in an editor with tabs, searching across files, navigating via breadcrumbs, running scripts, and managing processes.

#### Scenario: File tree renders hierarchical directory and file structure
- **GIVEN** a topic has a linked project folder with files and subdirectories
- **WHEN** the file explorer pane loads
- **THEN** the file tree displays root-level files and directories
- **AND** subdirectories are shown as expandable nodes

#### Scenario: Expand directory node to reveal nested files
- **GIVEN** the file tree shows a collapsed directory node
- **WHEN** the user clicks on the directory node
- **THEN** the directory expands to reveal its child files and subdirectories

#### Scenario: Collapse expanded directory node
- **GIVEN** a directory node is currently expanded in the file tree
- **WHEN** the user clicks on the expanded directory node
- **THEN** the directory collapses and its children are hidden

#### Scenario: Clicking a file opens it in the editor pane
- **GIVEN** a file is visible in the file tree
- **WHEN** the user clicks on the file
- **THEN** the file opens in the editor pane
- **AND** a tab appears in the tab bar showing the filename
- **AND** the breadcrumb navigation shows the file path

#### Scenario: Editor displays code content with syntax highlighting
- **GIVEN** a source code file has been opened in the editor
- **WHEN** the editor pane renders
- **THEN** the file content is displayed with syntax-appropriate highlighting
- **AND** whitespace and formatting are preserved

#### Scenario: Single-click opens file as preview tab
- **GIVEN** no file is currently open in the editor
- **WHEN** the user single-clicks a file in the tree
- **THEN** the file opens as a preview tab indicated by italic text
- **AND** opening another file replaces the preview tab

#### Scenario: Double-click pins a preview tab
- **GIVEN** a file is open as a preview tab with italic styling
- **WHEN** the user double-clicks on the tab
- **THEN** the tab becomes pinned and the italic styling is removed
- **AND** opening another file creates a new preview tab instead of replacing the pinned one

#### Scenario: Multiple editor tabs open simultaneously
- **GIVEN** one file is already pinned in the editor
- **WHEN** the user clicks a second file in the tree
- **THEN** both files appear as separate tabs in the tab bar
- **AND** the user can see both tab labels

#### Scenario: Switching between editor tabs shows correct content
- **GIVEN** two or more files are open in separate tabs
- **WHEN** the user clicks on a different tab
- **THEN** the editor displays the content of the selected file
- **AND** the breadcrumb navigation updates to show the selected file path

#### Scenario: Closing an editor tab removes it from the tab bar
- **GIVEN** multiple files are open in the tab bar
- **WHEN** the user hovers over a tab and clicks the close button
- **THEN** the tab is removed from the tab bar
- **AND** the editor switches to the next available tab

#### Scenario: File search opens with keyboard shortcut
- **GIVEN** the file explorer pane is active
- **WHEN** the user presses Cmd+Shift+F
- **THEN** a file search panel opens with a text input field

#### Scenario: File search returns matching results
- **GIVEN** the file search panel is open
- **WHEN** the user types a search query that matches content in project files
- **THEN** search results appear listing files and matching lines
- **AND** each result shows the filename and matched text

#### Scenario: Selecting a search result opens the file
- **GIVEN** file search results are displayed
- **WHEN** the user selects a result using keyboard navigation and presses Enter
- **THEN** the corresponding file opens in the editor
- **AND** the file search panel closes

#### Scenario: Invalid regex in file search shows error feedback
- **GIVEN** the file search panel is open with regex mode enabled
- **WHEN** the user enters an invalid regex pattern
- **THEN** an error indicator appears below the search input
- **AND** no results are displayed
- **AND** the search panel remains functional

#### Scenario: Valid regex clears previous error feedback
- **GIVEN** an invalid regex error is displayed in file search
- **WHEN** the user replaces the pattern with a valid search query
- **THEN** the error indicator disappears
- **AND** matching results appear normally

#### Scenario: Breadcrumb navigation shows current file path
- **GIVEN** a nested file is open in the editor
- **WHEN** the breadcrumb bar renders
- **THEN** each directory segment of the file path is shown as a clickable element
- **AND** the filename appears as the final breadcrumb segment

#### Scenario: Clicking breadcrumb segment opens directory dropdown
- **GIVEN** a breadcrumb navigation bar is showing a file path
- **WHEN** the user clicks on a directory segment in the breadcrumb
- **THEN** a dropdown appears listing sibling files and directories at that level

#### Scenario: Breadcrumb dropdown refreshes when navigating to a different directory
- **GIVEN** a breadcrumb dropdown was previously opened for one directory
- **WHEN** the user opens a file in a different directory and clicks a breadcrumb segment
- **THEN** the dropdown shows the contents of the new directory
- **AND** does not display stale content from the previous directory

#### Scenario: Rapid file opens resolve to the correct final content
- **GIVEN** the file tree is visible with multiple files
- **WHEN** the user clicks several files in quick succession
- **THEN** the editor settles on displaying the content of the last file clicked
- **AND** the breadcrumb and tab reflect the last file opened

#### Scenario: Script runner lists scripts from package.json
- **GIVEN** the project folder contains a package.json with defined scripts
- **WHEN** the user expands the Processes section in the sidebar
- **THEN** the script runner displays each script name from the package.json

#### Scenario: Stop button terminates a running script and updates UI
- **GIVEN** a script is currently running with a visible status indicator
- **WHEN** the user clicks the Stop button on the running script
- **THEN** the script process is terminated
- **AND** the running status indicator disappears
- **AND** the script returns to its idle state

#### Scenario: Processes section toggles between expanded and collapsed
- **GIVEN** the Processes section is visible in the sidebar
- **WHEN** the user clicks the Processes header
- **THEN** the section toggles between expanded and collapsed states
- **AND** collapsing hides the script runner content

#### Scenario: Header "New File" button creates a file at the project root
- **WHEN** the user clicks the "New File" button in the Files panel header
- **THEN** an inline text input SHALL appear at the top of the file tree
- **AND** after the user types a name and presses Enter, a new file SHALL be created in the project root directory

#### Scenario: Header "New Folder" button creates a folder at the project root
- **WHEN** the user clicks the "New Folder" button in the Files panel header
- **THEN** an inline text input SHALL appear at the top of the file tree
- **AND** after the user types a name and presses Enter, a new directory SHALL be created in the project root directory

#### Scenario: Sidebar toolbar "New File" button creates a file at the project root
- **WHEN** the user clicks the "New File" button in the sidebar toolbar
- **THEN** an inline text input SHALL appear at the top of the file tree
- **AND** after the user types a name and presses Enter, a new file SHALL be created in the project root directory

#### Scenario: Sidebar toolbar "New Folder" button creates a folder at the project root
- **WHEN** the user clicks the "New Folder" button in the sidebar toolbar
- **THEN** an inline text input SHALL appear at the top of the file tree
- **AND** after the user types a name and presses Enter, a new directory SHALL be created in the project root directory

### Requirement: FILE-02 — Git Status, Diff Viewer & Version Control

The system SHALL display git status indicators on files, provide a diff viewer for changed files, and support staging, committing, and branch operations.

#### Scenario: Modified file shows M status indicator
- **GIVEN** a file in the project has been modified after the last commit
- **WHEN** the file tree renders
- **THEN** the modified file displays an M status indicator next to its name

#### Scenario: Untracked file shows U status indicator
- **GIVEN** a new file exists in the project that has not been committed
- **WHEN** the file tree renders
- **THEN** the untracked file displays a U status indicator next to its name

#### Scenario: Deleted file shows D status indicator
- **GIVEN** a previously committed file has been deleted from the working directory
- **WHEN** the git changes section renders
- **THEN** the deleted file displays a D status indicator

> Note: Deleted file indicators are inferred from git status integration. Direct E2E test coverage for deletion status may be limited.

#### Scenario: Git changes section lists modified files
- **GIVEN** files have been modified in the project repository
- **WHEN** the user views the Git section in the sidebar
- **THEN** changed files are listed grouped by their staging status

#### Scenario: Diff viewer opens for a changed file
- **GIVEN** the Git section shows a list of changed files
- **WHEN** the user clicks on a changed file entry
- **THEN** a diff viewer opens in the editor pane
- **AND** the viewer displays the file changes using a merge view

#### Scenario: Diff viewer shows added lines with distinct styling
- **GIVEN** the diff viewer is open for a file with additions
- **WHEN** the diff renders
- **THEN** newly added lines are highlighted with a visually distinct style

#### Scenario: Diff viewer shows removed lines with distinct styling
- **GIVEN** the diff viewer is open for a file with deletions
- **WHEN** the diff renders
- **THEN** removed lines are highlighted with a visually distinct style

#### Scenario: Staging a file moves it to the staged section
- **GIVEN** the Git section shows an unstaged changed file
- **WHEN** the user stages the file
- **THEN** the file moves from the unstaged section to the staged section

> Note: Staging interaction (button click vs. drag) depends on the UI. Direct staging E2E test coverage may be limited -- verify during test implementation.

#### Scenario: Unstaging a file returns it to the unstaged section
- **GIVEN** a file is in the staged section
- **WHEN** the user unstages the file
- **THEN** the file moves back to the unstaged section

> Note: Unstaging interaction has limited direct E2E test coverage. Verify mechanism during test implementation.

#### Scenario: Commit with message creates a new commit
- **GIVEN** one or more files are staged in the Git section
- **WHEN** the user enters a commit message and submits the commit
- **THEN** a new git commit is created with the staged files
- **AND** the staged files section clears

> Note: Commit flow E2E coverage is limited. The commit UI exists but end-to-end commit creation may not be fully tested.

#### Scenario: Branch indicator shows current branch name
- **GIVEN** the project has a git repository with branches
- **WHEN** the Git section renders
- **THEN** the current branch name is displayed as a branch indicator

> Note: Branch display is inferred from git integration UI. Dedicated branch indicator E2E test may be a gap.

#### Scenario: Branch switching changes the active branch
- **GIVEN** the branch indicator shows the current branch
- **WHEN** the user selects a different branch from the branch selector
- **THEN** the active branch changes to the selected branch
- **AND** the file tree and git status update to reflect the new branch

> Note: Branch switching E2E test coverage is likely a gap. The feature may exist but lacks dedicated test scenarios.

#### Scenario: Git section expands and collapses
- **GIVEN** the Git section header is visible in the sidebar
- **WHEN** the user clicks the Git header
- **THEN** the section toggles between expanded and collapsed states
- **AND** collapsing hides the changed files list

#### Scenario: Staged and unstaged sections display separately
- **GIVEN** the Git section is expanded and files have been modified
- **WHEN** the git changes render
- **THEN** staged files appear in a separate Staged section
- **AND** unstaged files appear in a separate section below

### Requirement: FILE-03 — Reveal in Finder

The system SHALL allow users to reveal any file or folder in macOS Finder directly from the file tree context menu.

#### Scenario: Context menu shows "Show in Finder" option for a file
- **GIVEN** a file is visible in the file tree
- **WHEN** the user right-clicks on the file
- **THEN** the context menu SHALL include a "Show in Finder" option

#### Scenario: Context menu shows "Show in Finder" option for a folder
- **GIVEN** a directory is visible in the file tree
- **WHEN** the user right-clicks on the directory
- **THEN** the context menu SHALL include a "Show in Finder" option

#### Scenario: Clicking "Show in Finder" reveals the file in Finder
- **GIVEN** the context menu is open on a file
- **WHEN** the user selects "Show in Finder"
- **THEN** the system SHALL open macOS Finder with the file selected and highlighted

#### Scenario: Clicking "Show in Finder" reveals the folder in Finder
- **GIVEN** the context menu is open on a directory
- **WHEN** the user selects "Show in Finder"
- **THEN** the system SHALL open macOS Finder with the directory selected and highlighted

### Requirement: FILE-04 — Process & Script Runner

The system SHALL list scripts from the project's package.json, allow starting and stopping script execution with live status indicators, display running process information with session details, support spawning new agents via a dialog, and show port links for running scripts.

#### Scenario: Script runner lists scripts from package.json
- **GIVEN** the project folder contains a package.json with defined scripts
- **WHEN** the script runner component loads
- **THEN** each script name from the package.json is displayed as a clickable row
- **AND** a Play icon appears next to each idle script name

#### Scenario: Script names are color-coded by type
- **GIVEN** scripts are listed in the script runner
- **WHEN** the user views the script names
- **THEN** dev/start/serve scripts display with green icon color
- **AND** build/compile scripts display with blue icon color
- **AND** test/spec/e2e scripts display with yellow icon color
- **AND** lint/format scripts display with purple icon color

#### Scenario: Clicking an idle script starts execution
- **GIVEN** a script is in idle state with a Play icon
- **WHEN** the user clicks the script row
- **THEN** the Play icon changes to a spinning indicator
- **AND** the script name styling changes to indicate starting state

#### Scenario: Running script shows green pulsing indicator
- **GIVEN** a script has been started and is actively running
- **WHEN** the script runner refreshes its state
- **THEN** the script row shows a green pulsing dot indicator
- **AND** the script name appears in green with bold styling

#### Scenario: Stop button appears on running script hover
- **GIVEN** a script is running with a green pulsing indicator
- **WHEN** the user hovers over the script row
- **THEN** a Stop (square) button becomes visible on the right side of the row
- **AND** clicking the Stop button initiates script termination

#### Scenario: Stopping a script shows termination indicator
- **GIVEN** a running script exists in the script runner
- **WHEN** the user clicks the Stop button
- **THEN** a red spinning indicator replaces the green dot
- **AND** the script name shows in a faded red style
- **AND** the row becomes non-interactive until termination completes

#### Scenario: Running script shows port links
- **GIVEN** a running script has detected open ports
- **WHEN** the script row is displayed
- **THEN** port number links appear inline (e.g., ":3333")
- **AND** each port link opens in a new browser tab when clicked

#### Scenario: Hovering idle script shows command preview
- **GIVEN** an idle script is listed in the script runner
- **WHEN** the user hovers over the script row
- **THEN** the underlying npm command text appears on the right side of the row

#### Scenario: Script runner returns null when no scripts exist
- **GIVEN** the project package.json has no scripts defined
- **WHEN** the script runner component renders
- **THEN** the component renders nothing (no script list visible)

#### Scenario: Clicking a running script opens process log
- **GIVEN** a script is running with an active process
- **WHEN** the user clicks the running script row
- **THEN** the onOpenProcessLog callback is invoked with the process ID and script name

#### Scenario: Process list displays running and completed processes
- **GIVEN** a topic has spawned sub-agent processes
- **WHEN** the process list loads
- **THEN** each process row shows a status icon, label, and duration
- **AND** running processes show a running indicator with "(running)" suffix
- **AND** completed processes show a checkmark icon

#### Scenario: Process list empty state shows launch prompt
- **GIVEN** no sub-processes exist for the current topic
- **WHEN** the process list renders
- **THEN** a "No sub-processes" message is displayed
- **AND** a "Launch Agent" button is visible below the message

#### Scenario: Stop button on process terminates the agent
- **GIVEN** a running process is displayed in the process list
- **WHEN** the user clicks the Stop (square) button on the process row
- **THEN** the button enters a disabled state while stopping
- **AND** the process list refreshes after a brief delay

#### Scenario: Expanding a process row shows session details
- **GIVEN** a process row is visible in the process list
- **WHEN** the user clicks the process row
- **THEN** an expanded section appears showing the session key and start timestamp
- **AND** completed processes also show the completion timestamp

#### Scenario: New Agent dialog opens from plus button
- **GIVEN** the process list header is visible
- **WHEN** the user clicks the Plus (+) button in the header
- **THEN** a "New Agent" spawn dialog overlay appears
- **AND** the dialog contains Task, Label, and Model fields


### Requirement: GIT-ID-01 — Firmare un commit è un RIPIEGO, mai una sostituzione

Ogni comando git che SCRIVE un commit — commit, cherry-pick, revert, merge,
rebase, applicazione di patch, accantonamento — SHALL ricevere un ambiente che
garantisca un'identità utilizzabile. Senza, il comando muore con un errore secco
ovunque manchi una configurazione utente, e ciò che stava per essere consegnato
non parte.

L'identità configurata sulla macchina o sul repo SHALL VINCERE sempre.
L'identità di ripiego SHALL entrare in gioco SOLO quando git dichiara di non
saperne nessuna. **Un'applicazione che si intesta i merge di una persona è un
guasto peggiore di quello che sta rimediando.**

Il ripiego SHALL essere passato come AMBIENTE e non come opzione della riga di
comando: una variabile d'ambiente vuota batte l'opzione, quindi l'opzione non
protegge dal caso che conta.

L'ambiente passato al sondaggio SHALL essere quello CORRENTE e non quello
fotografato all'avvio del processo.

Se git non parte affatto, NON SHALL essere dedotto nessun ripiego: non è una
domanda sull'identità.

Il risultato SHALL essere memorizzato PER CARTELLA: una consegna lancia decine di
comandi git, e un sottoprocesso in più per ciascuno è un costo che nessuno ha
chiesto.

#### Scenario: la macchina ha già un'identità
- **GIVEN** un repo con un'identità configurata
- **THEN** SHALL essere usata quella, e il ripiego NON SHALL comparire

#### Scenario: git non parte
- **GIVEN** un ambiente in cui git non è eseguibile
- **THEN** NON SHALL essere imposto nessun ripiego

### Requirement: GIT-ID-02 — La regola si applica a TUTTI i punti di chiamata, e il banco lo verifica sul codice

L'applicazione della regola precedente SHALL essere verificata SCANDENDO IL
CODICE: ogni punto che lancia git con un verbo che scrive un commit SHALL
passare un ambiente.

Non è pedanteria: **un rimedio applicato a un solo punto di chiamata non è un
rimedio, è un precedente.** Lo stesso guasto è ricomparso due volte in due giorni
consecutivi, in due file diversi, dopo essere stato «risolto».

La finestra in cui si cerca l'ambiente SHALL essere di più righe, non la riga
secca: l'ambiente sta nelle opzioni dopo gli argomenti e la formattazione può
spezzare la riga.

Il banco SHALL portare la propria prova di NON VACUITÀ: SHALL verificare di aver
riconosciuto almeno un punto di chiamata reale. Senza, un cambio di forma dello
spawn lo renderebbe verde per ASSENZA di controlli invece che per correttezza —
e un banco verde che non guarda niente è peggio di nessun banco.

I punti che passano da un esecutore iniettato SHALL restare fuori: lì la
responsabilità è di chi costruisce quell'esecutore.

#### Scenario: un punto di chiamata nuovo senza ambiente
- **GIVEN** un nuovo comando git che scrive un commit, senza ambiente
- **THEN** il banco SHALL fallire

#### Scenario: il matcher non riconosce più niente
- **GIVEN** una forma di chiamata che il banco non sa più riconoscere
- **THEN** SHALL fallire invece di passare a vuoto

### Requirement: GIT-MSG-01 — Il messaggio si scrive imitando il repo, e un errore non finisce nella casella

Il messaggio di un commit proposto SHALL essere modellato sugli ESEMPI REALI del
repo — lingua, lunghezza, stile — e non su una convenzione dichiarata. Qui non
esiste nessuno strumento che imponga un formato: la convenzione è solo uso, e
inventare un prefisso che nessuno usa è aggiungere rumore.

La prima riga SHALL dire cosa CAMBIA il commit, in una frase, e NON SHALL essere
l'elenco dei file. Il corpo SHALL esistere solo se serve, e solo per il perché.

Il pezzo di diff mandato al modello SHALL avere un BUDGET diviso PER FILE, non
«i primi N caratteri»: un file grosso in testa affama tutti gli altri. Misurato su
trenta commit, il diff mediano è di 10.295 caratteri e 24 su 30 superano i 4.000.
La quota SHALL essere UGUALE per tutti, con l'avanzo di chi non la usa
redistribuito a chi sfora.

Il taglio SHALL avvenire a FINE RIGA: mezza riga di diff confonde più di quanto
aiuti.

Ciò che è «in stage» SHALL essere deciso sulla prima colonna del codice di stato,
e le voci non tracciate o ignorate SHALL restare fuori per definizione. La
lettura NON SHALL ripulire gli spazi dell'intera uscita: il primo carattere della
prima riga è significativo, e toglierlo sposta ogni stato di una colonna.

**Una risposta che è un ERRORE del fornitore NON SHALL finire nella casella del
messaggio.** Un contenuto vuoto o un errore SHALL essere scartato, e un messaggio
avvolto in un blocco di codice SHALL essere spogliato. La regola SHALL vivere in
un punto solo: ha più di un chiamante, e due copie divergono.

#### Scenario: il fornitore risponde con un errore
- **GIVEN** una risposta che comincia dichiarando un errore
- **THEN** NON SHALL essere usata come messaggio

#### Scenario: un file enorme davanti a tutti
- **GIVEN** un diff in cui il primo file supera da solo il budget
- **THEN** gli altri file SHALL comunque ricevere la propria quota

### Requirement: GIT-HUNK-01 — Mettere in stage un blocco solo: il lato VECCHIO non si tocca, il NUOVO scorre

Un diff SHALL poter essere messo in stage, tolto dall'indice o scartato UN BLOCCO
ALLA VOLTA.

La patch ricostruita SHALL lasciare INTATTO il lato vecchio di ogni intestazione —
deve combaciare con l'indice — e SHALL far scorrere il lato nuovo con il delta
dei soli blocchi TENUTI, non di quelli saltati. Sbagliare questo calcolo produce
un rifiuto secco della patch oppure, peggio, uno spostamento SILENZIOSO dello
stage quando si prova a farla ricontare.

La patch SHALL terminare con un a-capo, o viene rifiutata per riga troncata.

Se il diff contiene PIÙ file, SHALL essere tenuto solo il primo: mettere in stage
pezzi scelti da un file diverso da quello che la persona sta guardando è il
guasto peggiore di questa superficie.

Senza nessun blocco scelto SHALL essere restituito NIENTE, non una patch vuota:
una patch vuota fa lavorare git per applicare il nulla. Un indice fuori portata
SHALL essere ignorato, non far fallire l'operazione.

Un blocco senza il secondo numero SHALL valere UNA riga. Un diff senza blocchi
NON SHALL essere un errore. La nota di fine file senza a-capo NON SHALL sballare
i totali.

Il riassunto per l'interfaccia NON SHALL portarsi dietro le righe del diff.

Il banco SHALL applicare le patch a un repo VERO e confrontare l'esito con quello
del comando diretto, e SHALL verificare che la propria copia del diff sia ancora
quella che git produce.

#### Scenario: solo l'ultimo blocco
- **GIVEN** una selezione del solo ultimo blocco, con blocchi saltati prima che spostano il conteggio
- **THEN** la patch SHALL applicarsi senza essere rifiutata

#### Scenario: scartare un blocco
- **GIVEN** un blocco scartato fra molti
- **THEN** gli altri blocchi del file NON SHALL essere toccati

### Requirement: GIT-COUNT-01 — «Quanto» è un'altra domanda da «cosa», e «non lo so» non è zero

Il numero di righe cambiate SHALL essere letto SEPARATAMENTE dallo stato dei
file: lo stato dice COSA è cambiato, non QUANTO.

I due lati — ciò che è in stage e ciò che non lo è — SHALL restare DUE mappe
distinte e NON SHALL essere sommati: lo stesso file può avere righe da una parte
e righe dall'altra, e un totale unico nasconde proprio la differenza che la
persona sta guardando.

Chi non ha conteggi SHALL risultare SCONOSCIUTO, mai ZERO. Un file non tracciato
SHALL restare senza numeri: «0 modifiche» su un file nuovo è falso.

Un file BINARIO NON SHALL apparire come «nessuna modifica»: SHALL essere marcato
come tale.

Una RINOMINA SHALL agganciare i conteggi al percorso NUOVO, e i due percorsi che
porta con sé NON SHALL far slittare i record successivi — l'ordine dei campi è
INVERTITO fra i due comandi che il sistema usa, ed è esattamente lì che il numero
finisce sul file sbagliato.

I percorsi SHALL essere letti con il separatore che sopravvive ai caratteri non
inglesi.

Oltre una soglia di file i conteggi SHALL essere SALTATI e la lista SHALL restare
INTERA: su una lista enorme quel calcolo costa quanto tutto il resto della
risposta, e nessuno legge il «+3» della quattromillesima riga.

Un repo senza cronologia NON SHALL essere un guasto.

Quando un progetto è aperto su una SOTTOCARTELLA, il percorso SHALL essere
ricomposto: altrimenti la colonna dei numeri resta vuota per tutti.

#### Scenario: un file per metà in stage
- **GIVEN** un file con righe in stage e righe fuori
- **THEN** SHALL portare due numeri diversi, non la loro somma

#### Scenario: lista enorme
- **GIVEN** più file della soglia
- **THEN** la lista SHALL restare intera e i numeri SHALL mancare

### Requirement: GIT-COMMIT-VIEW-01 — I file di UN commit: due comandi, e il formato non è quello dello stato

I file toccati da un singolo commit SHALL essere letti con DUE comandi — cosa è
successo a ciascuno, e quante righe — perché nessuno dei due basta da solo, e
insieme costano comunque meno di un diff intero.

Il formato NON è quello dell'elenco di stato: qui la lettera dello stato è un
CAMPO A SÉ. Riusare il lettore dell'altro formato produce una lista VUOTA senza
nessun errore — il modo peggiore di sbagliare.

Il punteggio di una rinomina NON SHALL finire dentro lo stato, e i campi che una
rinomina porta con sé NON SHALL far slittare i record successivi.

Un file senza conteggi — un cambio di soli permessi — SHALL restare a ZERO invece
di sparire: sparire lo farebbe sembrare non toccato dal commit. Un binario SHALL
essere marcato tale.

Con un progetto aperto su una sottocartella SHALL essere tenuto solo ciò che le
appartiene, e i percorsi SHALL essere accorciati — ma una rinomina che VIENE da
fuori SHALL conservare il percorso di provenienza INTERO, o punterebbe a un
percorso che non esiste.

Un commit vuoto SHALL dare una lista vuota.

#### Scenario: cambio di soli permessi
- **GIVEN** un file toccato senza righe cambiate
- **THEN** SHALL comparire con zero, non sparire

#### Scenario: rinomina da fuori la sottocartella
- **GIVEN** un file rinominato da fuori dello scopo
- **THEN** il percorso di provenienza SHALL restare intero

### Requirement: GIT-IGNORE-01 — Le regole di esclusione si applicano come le applica git, non come somigliano

Il riconoscimento di un percorso escluso SHALL seguire la semantica vera delle
regole, e NON SHALL essere approssimato sul solo nome del file. Tre difetti
misurati dall'approssimazione precedente:

1. una regola ANCORATA nascondeva le cartelle omonime in profondità — file
   TRACCIATI diventati invisibili nell'esploratore;
2. una NEGAZIONE veniva letta come un nome che comincia col punto esclamativo,
   quindi non riapriva niente;
3. una wildcard IN MEZZO al nome non corrispondeva MAI, perché erano gestiti solo
   i casi in cui stava all'inizio o alla fine.

Una regola ancorata SHALL valere solo dalla propria radice; una senza separatore
SHALL valere a QUALUNQUE profondità. Una wildcard semplice NON SHALL attraversare
le cartelle, quella doppia SÌ.

Fra regole in conflitto SHALL vincere l'ULTIMA che corrisponde, non la prima.

Una regola che finisce col separatore SHALL valere solo per le CARTELLE, e
escludere una cartella SHALL escludere i suoi discendenti.

Commenti, righe vuote e spazi in coda NON SHALL diventare regole.

Un file di regole ANNIDATO SHALL valere solo dalla propria cartella in giù.

Copiare l'insieme delle regole NON SHALL permettere alla copia di sporcare
l'originale.

#### Scenario: una cartella omonima in profondità
- **GIVEN** una regola ancorata alla radice e una cartella con lo stesso nome più in basso
- **THEN** quella in basso NON SHALL essere esclusa

#### Scenario: due regole in conflitto
- **GIVEN** una regola che esclude e una successiva che riapre
- **THEN** SHALL valere la seconda

### Requirement: TRASH-01 — Cancellare vuol dire spostare nel cestino, e due file con lo stesso nome non si sovrascrivono

Cancellare dall'interfaccia SHALL significare SPOSTARE NEL CESTINO del sistema,
mai rimuovere dal disco. Il contenuto SHALL essere ancora lì dopo l'operazione: è
la differenza fra un errore recuperabile e un lavoro perso.

La regola SHALL valere per TUTTI i punti di chiamata, incluso lo scarto di un
file NON TRACCIATO: sta accanto allo scarto di un file tracciato, dietro lo
stesso comando, e per quello il sistema di versione è la rete di sicurezza —
per questo NON c'è nessun'altra rete.

La destinazione SHALL essere quella prevista dal sistema in uso. Senza una
cartella personale NON SHALL essere inventato un percorso: SHALL essere un
errore.

Su COLLISIONE di nome il file SHALL essere numerato PRIMA dell'estensione, e il
conteggio SHALL proseguire finché non trova posto: due file con lo stesso nome
NON SHALL sovrascriversi dentro il cestino. Un nome senza estensione NON SHALL
guadagnarne una.

Un file che NON ESISTE SHALL essere un errore, non un successo silenzioso: «l'ho
cestinato» detto su niente nasconde il vero motivo per cui il file non c'è più.

Una CARTELLA SHALL arrivare intera, con dentro il suo contenuto.

#### Scenario: due file con lo stesso nome
- **GIVEN** un file il cui nome esiste già nel cestino
- **THEN** SHALL essere numerato prima dell'estensione, e nessuno dei due SHALL essere perso

#### Scenario: un file che non c'è
- **GIVEN** un percorso inesistente
- **THEN** SHALL essere un errore, non un successo silenzioso

### Requirement: MEDIA-01 — Il contenuto ATTIVO non entra, e il tipo si misura come lo misura il RUNTIME

Le porte che accettano allegati SHALL RIFIUTARE il contenuto ATTIVO — ciò che un
navigatore eseguirebbe — e AMMETTERE gli allegati inerti.

La verifica SHALL usare i valori di tipo REALI che il runtime consegna, non una
copia locale: una copia diceva sì a un tipo che la rotta vera riceveva con il
parametro di codifica attaccato e rifiutava — un allegato di testo era rotto in
produzione con il banco tutto verde. Il runtime, inoltre, IGNORA il tipo dichiarato
dal client e lo RI-DERIVA dal nome del file: è quello che va misurato.

Il tipo SHALL essere NORMALIZZATO — parametri, spazi, maiuscole — prima del
confronto, e il rifiuto SHALL mostrare il tipo NORMALIZZATO: il parametro non è la
colpa.

Ogni tipo attivo SHALL avere la sua ESTENSIONE nell'insieme gemello, e il
rifiuto SHALL reggere anche se la derivazione del tipo è CIECA: l'estensione basta
da sola.

L'elenco dei tipi permessi in generale CONTIENE contenuto attivo: NON SHALL essere
lui la guardia. Chi «sistemasse» un rifiuto allargandolo riaprirebbe l'esecuzione
di contenuto senza che niente diventi rosso, quindi il banco SHALL dichiararlo.

Oltre il tetto di dimensione SHALL essere un rifiuto dichiarato, e la cartella
SHALL restare VUOTA. Sotto il tetto SHALL passare ed essere scritto — il controllo
positivo.

Un formato che può portare script NON SHALL entrare nella cartella del contesto, e
quando viene servito SHALL essere SABBIATO e dichiarato non interpretabile per
indovinare il tipo. Le stesse guardie SHALL valere sulla risposta PARZIALE, o
basta chiedere un intervallo per aggirarle.

#### Scenario: un allegato di testo con il parametro di codifica
- **GIVEN** un tipo con il parametro attaccato
- **THEN** SHALL essere normalizzato e ammesso

#### Scenario: una richiesta a intervalli
- **GIVEN** una risposta parziale su un formato che può portare script
- **THEN** SHALL portare le stesse guardie della risposta intera

### Requirement: MEDIA-02 — La durata di una clip si LEGGE, e la scala dei tempi non si dà per scontata

La durata di una clip SHALL essere letta dalla propria intestazione, applicando la
SCALA dei tempi dichiarata: i valori nell'intestazione sono in unità del
contenitore, non in millisecondi, e sbagliare la scala di un fattore due lascia
passare una clip lunga il doppio dicendo la metà. In assenza di scala dichiarata
SHALL valere l'unità predefinita.

Senza durata nell'intestazione SHALL essere RICAVATA dall'ultimo blocco, e questo
SHALL essere DICHIARATO: è una stima, non il valore scritto.

Una durata a ZERO NON SHALL contare come dichiarata: un registratore interrotto
lascia lo zero al posto del valore.

Un file che NON è del formato atteso, o privo della propria struttura, SHALL
SOLLEVARE invece di rispondere zero: uno zero si legge come «clip vuota».

Il banco SHALL usare file COSTRUITI byte per byte, così l'attesa è un numero
DICHIARATO e non l'uscita del lettore stesso.

#### Scenario: una scala dei tempi non predefinita
- **GIVEN** un'intestazione con la propria scala
- **THEN** la durata SHALL essere convertita, non presa così com'è

#### Scenario: un file di un altro formato
- **GIVEN** un contenuto che non è del formato atteso
- **THEN** SHALL sollevare, non restituire zero

### Requirement: MEDIA-03 — La forma di un'immagine si legge dai BYTE, non dall'estensione

Le dimensioni di un'immagine SHALL essere lette dalla propria intestazione
BINARIA, e il FORMATO SHALL uscire dai byte: un file con un'estensione e un
contenuto di un altro formato SHALL essere misurato lo stesso.

Ogni formato SHALL essere letto secondo le PROPRIE regole: l'ordine dei byte del
numero, il salto dei segmenti fino a quello che porta le dimensioni, i valori
memorizzati diminuiti di uno, e la larghezza dedotta da un riquadro quando non è
dichiarata. Un segmento che NON porta le dimensioni NON SHALL essere scambiato per
quello che le porta.

Nel dubbio SHALL essere restituito «non lo so»: file assente, formato ignoto,
dimensioni a zero.

#### Scenario: un file con l'estensione sbagliata
- **GIVEN** un contenuto di un formato diverso da quello del nome
- **THEN** SHALL essere misurato secondo il contenuto

#### Scenario: un formato sconosciuto
- **GIVEN** byte non riconoscibili
- **THEN** SHALL essere restituito «non lo so»

### Requirement: TILDE-01 — La home si accorcia, ma non a metà di un nome

Il prefisso della cartella personale SHALL essere accorciato nel percorso
mostrato: è la parte uguale per tutti i progetti, e occupa spazio senza dire
niente.

La home NUDA SHALL diventare il solo simbolo, senza barra finale.

Ciò che NON è una home SHALL restare INTERO: meglio lungo che sbagliato.

L'accorciamento NON SHALL mordere a metà di un nome di cartella: un percorso che
comincia con le stesse lettere della home non sta dentro la home.

#### Scenario: una cartella che comincia come la home
- **GIVEN** un percorso che condivide il prefisso ma non il confine di cartella
- **THEN** SHALL restare intero

#### Scenario: la home nuda
- **GIVEN** esattamente il percorso della home
- **THEN** SHALL diventare il solo simbolo

### Requirement: OSOPEN-01 — I file che il sistema consegna si aprono uno alla volta, e ciò che non si apre lo DICE

La coda dei percorsi consegnati dal sistema operativo SHALL essere svuotata
aprendo ciò che il server ha RISOLTO, nell'ORDINE in cui il sistema li ha
consegnati, UNO alla volta.

Una coda vuota NON SHALL produrre né aperture né avvisi. Fuori dal guscio la coda
NON esiste, e NON SHALL essere un errore.

Un percorso che NON risolve SHALL AVVISARE, non restare muto. Un percorso che fa
fallire il server NON SHALL fermare gli altri.

SHALL esserci un TETTO alle aperture per giro: venti file consegnati insieme NON
SHALL diventare venti tab.

#### Scenario: venti file trascinati insieme
- **GIVEN** venti percorsi in coda
- **THEN** SHALL essere aperti fino al tetto, non tutti

#### Scenario: un percorso che non risolve
- **GIVEN** un percorso non risolvibile
- **THEN** SHALL comparire un avviso

### Requirement: PATHUTIL-01 — L'ultimo segmento di un percorso, anche nei casi degeneri

L'ultimo segmento di un percorso assoluto SHALL essere restituito.

Un ingresso senza separatori SHALL essere restituito INVARIATO.

Le barre finali SHALL essere ignorate, restituendo il nome della cartella che le
precede.

L'ingresso vuoto SHALL dare una stringa vuota, e la radice — come un percorso con
la sola barra iniziale — NON SHALL sollevare.

#### Scenario: una barra finale
- **GIVEN** un percorso che termina con il separatore
- **THEN** SHALL essere restituito il nome della cartella che lo precede

#### Scenario: la radice
- **GIVEN** il percorso della radice
- **THEN** NON SHALL essere sollevato niente
