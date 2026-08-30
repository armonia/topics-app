## Purpose

Specifies behavioral scenarios for the application layout system including panel grid splitting, resizing, persistence, sidebar navigation, pane tab management, add-pane menu, and mobile responsiveness.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- The main application layout is visible with a sidebar on the left and a content area on the right
- At least one topic exists and is open as a chat pane in the tab bar

## Requirements

### Requirement: LAYOUT-01 — PanelGrid, Split, Resize & Persistence

The system SHALL support splitting the panel grid horizontally and vertically, resizing split panels via drag dividers, moving panes between groups, and persisting layout state across page reloads. The system SHALL fetch the latest state from the server on load and re-render with fresh data when it differs from the cached localStorage state, ensuring stale browser sessions display current state. This applies to both the top-level grid layout (PanelGrid) and project-internal layouts (ProjectWindow).

#### Scenario: Top-level grid split layout restored from server on fresh session
- **GIVEN** the user had a split grid layout (e.g., two panels side by side)
- **AND** the layout was saved to the server
- **WHEN** the user opens the app from a different browser session with no localStorage
- **THEN** the server's grid layout is fetched and applied
- **AND** the split layout is displayed correctly

#### Scenario: Split Right creates correct horizontal multi-column layout
- **GIVEN** a chat pane is open in the tab bar
- **WHEN** the user right-clicks the tab and selects Split Right
- **THEN** a vertical col-resize divider appears between the two panels
- **AND** both panels have their own independent tab bars
- **AND** the divider can be dragged to resize

#### Scenario: Split Down creates correct vertical multi-row layout
- **GIVEN** a chat pane is open in the tab bar
- **WHEN** the user right-clicks the tab and selects Split Down
- **THEN** a horizontal row-resize divider appears between the two panels
- **AND** both panels are stacked vertically
- **AND** the divider can be dragged to resize

#### Scenario: Project-internal split layout restored from server
- **GIVEN** a project window had a split layout (e.g., Files + Terminal side by side)
- **AND** the layout was saved to the server
- **WHEN** the user reloads the page
- **THEN** the project window restores with the same split layout and pane arrangement

#### Scenario: Mixed project and chat panels in multi-column split
- **GIVEN** a project panel and a chat panel are both open
- **WHEN** they are displayed in a multi-column layout (side by side)
- **THEN** both panels render with their own independent tab bars
- **AND** a col-resize divider separates them

#### Scenario: Project window nested multi-row multi-column splits
- **GIVEN** a project window is open with multiple panes
- **WHEN** the user performs Split Right and Split Down within the project window
- **THEN** the project window displays 3+ panes in a grid layout
- **AND** both row-resize and col-resize dividers are functional

#### Scenario: Mixed layout persists across reload
- **GIVEN** the user has a project panel and a chat panel in a multi-column split
- **AND** the layout was saved to the server
- **WHEN** the user reloads the page
- **THEN** both the project and chat panels are restored in the same multi-column layout

#### Scenario: Multi-row multi-column top-level grid
- **GIVEN** the user has performed Split Down (creating 2 rows) and Split Right within one row
- **WHEN** the grid renders
- **THEN** both row-resize and col-resize dividers are visible
- **AND** each cell has its own independent tab bar

#### Scenario: Stale project layout is replaced by fresh server state on load
- **GIVEN** a project window was previously opened with a specific tab layout
- **AND** the layout was changed on another device (or the server state was updated directly)
- **WHEN** the user opens a browser tab with stale localStorage referencing the old layout
- **THEN** the project window initially renders with the cached layout
- **AND** within a short time the project window re-renders with the server's current layout
- **AND** the final displayed state matches the server state

#### Scenario: User edits during fetch window are preserved
- **GIVEN** the app loads with stale localStorage and the server fetch is in flight
- **WHEN** the user adds or closes a pane before the server response arrives
- **THEN** the user's local changes are preserved
- **AND** the server response does not overwrite the user's changes

#### Scenario: Split Right via tab context menu creates side-by-side panels
- **GIVEN** at least two chat panes are open in the tab bar
- **WHEN** the user right-clicks a tab and selects Split Right from the context menu
- **THEN** a vertical column-resize divider appears between two panel groups
- **AND** both panel groups display their own tab bars

#### Scenario: Split Down via tab context menu creates above/below panels
- **GIVEN** at least two chat panes are open in the tab bar
- **WHEN** the user right-clicks a tab and selects Split Down from the context menu
- **THEN** a horizontal row-resize divider appears between two panel groups
- **AND** the panels are arranged vertically with one above the other

#### Scenario: Resize split panels by dragging col-resize divider
- **GIVEN** the panel grid has been split horizontally with a column-resize divider visible
- **WHEN** the user drags the column-resize divider to the right
- **THEN** the left panel group becomes wider and the right panel group becomes narrower
- **AND** the divider position updates to follow the drag

#### Scenario: Resize split panels by dragging row-resize divider
- **GIVEN** the panel grid has been split vertically with a row-resize divider visible
- **WHEN** the user drags the row-resize divider downward
- **THEN** the top panel group becomes taller and the bottom panel group becomes shorter
- **AND** the divider position updates to follow the drag

#### Scenario: Split layout persists after page reload
- **GIVEN** the user has split the panel grid and a resize divider is visible
- **WHEN** the user reloads the page
- **THEN** the split layout is restored with the same divider arrangement
- **AND** the panel groups reappear with their tabs

#### Scenario: Splitting works in project windows
- **GIVEN** a project window is open with at least one tab in its tab bar
- **WHEN** the user right-clicks a tab in the project window
- **THEN** a context menu appears with available actions

#### Scenario: Move pane between groups removes it from the source group
- **GIVEN** the panel grid has two groups with multiple tabs each
- **WHEN** a pane is moved from the source group to the target group
- **THEN** the pane is removed from the source group's tab bar
- **AND** the pane appears in the target group's tab bar
- **AND** the target group activates the moved pane

#### Scenario: Move last pane from group collapses that group
- **GIVEN** the panel grid has two groups where one group contains only a single tab
- **WHEN** the last pane is moved from that group to the other group
- **THEN** the now-empty group is removed from the layout
- **AND** the remaining group expands to fill the available space

#### Scenario: No duplicate tabs in initial state
- **GIVEN** the user opens the application
- **WHEN** the tab bar renders with open panels
- **THEN** no tab label appears more than once in the tab bar

#### Scenario: Main area has sufficient dimensions
- **GIVEN** the application is loaded in a standard desktop viewport
- **WHEN** the main content area renders
- **THEN** the main area width is greater than 400 pixels
- **AND** the main area height is greater than 300 pixels

#### Scenario: Tab bar height remains compact
- **GIVEN** a panel group is visible with a tab bar
- **WHEN** the tab bar renders
- **THEN** the tab bar height is less than 60 pixels

#### Scenario: Grid rows and columns respect maximum limits
- **GIVEN** the panel grid has existing splits
- **WHEN** the user attempts to split beyond the maximum allowed columns or rows
- **THEN** the grid does not exceed 4 columns or 4 rows

> Note: Maximum grid limits are enforced in source code but have limited direct E2E test coverage for the boundary case.

#### Scenario: Drag no-op when dropping tab on same position
- **GIVEN** a tab is being dragged within the same tab bar
- **WHEN** the user drops the tab at the same position it started from
- **THEN** no layout change occurs
- **AND** the tab order remains unchanged

#### Scenario: Layout state saved to server via API
- **GIVEN** the user has open panels in the application
- **WHEN** the panel state changes
- **THEN** the open panels list is saved to the server via the panels API endpoint
- **AND** the panel order is saved to the server via the panel-order API endpoint

#### Scenario: Layout state restored from persistence on load
- **GIVEN** panel state was previously saved to the server
- **WHEN** the user navigates to the application
- **THEN** the previously open panels are restored in the tab bar
- **AND** the main content area renders the restored panels

#### Scenario: StandaloneChatGroup renders with tab bar and chat content
- **GIVEN** the user opens a topic from the sidebar
- **WHEN** the chat pane loads
- **THEN** a tab bar is visible above the chat content
- **AND** the message input textbox is visible below the message list

#### Scenario: Closing all panels produces a clean empty state
- **GIVEN** multiple panels are open
- **WHEN** all panels are closed
- **THEN** no tabs remain in the tab bar
- **AND** reloading the page does not restore any stale panels

#### Scenario: Closing a split panel removes it without ghost panels
- **GIVEN** the panel grid has been split with a solo panel visible
- **WHEN** the user closes the tab in the solo panel
- **THEN** the solo panel group is removed from the layout
- **AND** the number of panel tab bars decreases

### Requirement: LAYOUT-02 — Sidebar, Pane Tabs, Add-Pane Menu & Mobile

The system SHALL support sidebar toggle, pane tab bar interactions including close and context menu, add-pane menu for inserting new pane types, project window sub-panels, tab drag reorder, connection status display, and mobile responsive layout.

#### Scenario: Sidebar toggle via keyboard shortcut
- **GIVEN** the sidebar is currently visible
- **WHEN** the user presses the keyboard shortcut to toggle the sidebar
- **THEN** the sidebar becomes hidden
- **AND** pressing the shortcut again makes the sidebar visible

#### Scenario: Sidebar toggle via toggle button
- **GIVEN** the sidebar toggle button is visible in the interface
- **WHEN** the user clicks the sidebar toggle button
- **THEN** the sidebar visibility toggles between visible and hidden

#### Scenario: Pane tab bar shows close button on each tab
- **GIVEN** a panel group has tabs in its tab bar
- **WHEN** the user views the tab bar
- **THEN** each tab displays a close button

#### Scenario: Right-click tab opens context menu with Close and Split options
- **GIVEN** a chat pane tab is visible in the tab bar
- **WHEN** the user right-clicks the tab
- **THEN** a context menu appears
- **AND** the menu includes a Close option
- **AND** the menu includes a Split Right option
- **AND** the menu includes a Split Down option

#### Scenario: Close tab via context menu
- **GIVEN** a tab's context menu is open
- **WHEN** the user clicks the Close option
- **THEN** the tab is removed from the tab bar
- **AND** the context menu is dismissed

#### Scenario: Add pane button opens dropdown menu
- **GIVEN** a panel group has a tab bar with an add pane button
- **WHEN** the user clicks the add pane button
- **THEN** a dropdown menu appears with pane type options

#### Scenario: Add pane menu lists available pane types
- **GIVEN** the add pane dropdown menu is open
- **WHEN** the user views the menu options
- **THEN** the menu includes options such as Files, Terminal, Git, Browser, Board, and Agents

#### Scenario: Select pane type from add pane menu adds new tab
- **GIVEN** the add pane dropdown menu is open
- **WHEN** the user selects a pane type from the menu
- **THEN** a new tab of that type is added to the tab bar

#### Scenario: ProjectWindow opens with sub-panels and tab bar
- **GIVEN** a project exists in the sidebar
- **WHEN** the user clicks the project entry in the sidebar
- **THEN** a project window opens with at least one tab in its tab bar

#### Scenario: ProjectWindow add-pane menu shows utility pane types
- **GIVEN** a project window is open
- **WHEN** the user clicks the add pane button in the project window
- **THEN** the dropdown menu shows utility types including Terminal, Git, and Browser

#### Scenario: Tab drag reorder within tab bar
- **GIVEN** multiple tabs are visible in a single tab bar
- **WHEN** the user drags a tab to a different position within the same tab bar
- **THEN** the tab order is rearranged to reflect the new position

> Note: Tab drag reorder uses HTML5 draggable attribute. E2E tests verify tabs are draggable but full reorder assertion is limited due to pointer event interaction complexity.

#### Scenario: Connection status indicator shows connected state
- **GIVEN** the application is loaded and the WebSocket connection is established
- **WHEN** the user views the connection status indicator
- **THEN** the indicator displays a connected status
- **AND** the indicator has an accessible label indicating the connection state

#### Scenario: Mobile viewport renders content at 375px width
- **GIVEN** the viewport is set to 375 pixels wide
- **WHEN** the application loads
- **THEN** meaningful content is rendered on the page
- **AND** the layout adapts to the narrow viewport

#### Scenario: Mobile sidebar may start hidden
- **GIVEN** the viewport is at mobile width
- **WHEN** the application loads
- **THEN** the sidebar may be initially hidden to maximize content area
- **AND** the main content or a navigation element is visible

#### Scenario: Project window internal pane layout persists across reload
- **GIVEN** a project window is open with a custom pane arrangement
- **WHEN** the user adds a non-chat pane and the layout is saved to the server
- **AND** the user reloads the page and reopens the project
- **THEN** the project window restores the previously saved pane arrangement
- **AND** the server layout data matches what was saved before the reload

#### Scenario: Cross-device panel sync updates without stale overwrites
- **GIVEN** the application is connected via WebSocket
- **WHEN** another device updates the panel state via the server API
- **THEN** the local panel list is updated to include the new panels
- **AND** the per-device focused panel is not overwritten by the sync

> Note: Cross-device sync is also relevant to the broader real-time collaboration system.

#### Scenario: Close Others removes all other tabs at once
- **GIVEN** three or more tabs are open in the tab bar
- **WHEN** the user right-clicks a tab and selects Close Others from the context menu
- **THEN** all other tabs are removed
- **AND** only the right-clicked tab remains

#### Scenario: Clicking tabs updates focus correctly
- **GIVEN** multiple tabs are visible in the tab bar
- **WHEN** the user clicks on different tabs in sequence
- **THEN** each clicked tab becomes the active tab
- **AND** the content area updates to show the selected pane
- **AND** the total tab count remains stable

### Requirement: CHROME-01 — Le righe di chrome NON dipingono e NON sfocano: le schede galleggiano

Le righe di chrome NON SHALL dipingere uno sfondo proprio: fra contenuto e barre
ci deve essere CONTINUITÀ, e uno sfondo proprio produce un gradino visibile —
misurato su entrambi i temi e su entrambi i gusci, fino a quattordici livelli di
differenza.

La barra delle schede NON SHALL nemmeno SFOCARE ciò che le passa sotto
(«volevo senza sfondo non blurrato», l'utente 29/08): una banda smerigliata si
legge come uno sfondo tanto quanto una tinta, e ciò che questa barra deve
mostrare sono le CARD delle schede appoggiate sul trascritto, senza niente in
mezzo.

IL VETRO SHALL essere la SCHEDA, non la barra: la card di ogni scheda SHALL
sfocare ciò che le sta dietro, così che quello che galleggia sul trascritto
siano le schede e non una banda. Le due cose sono UNA: un elemento con un
`backdrop-filter` è un BACKDROP ROOT per i suoi discendenti, quindi finché
filtra la barra il filtro sulla card NON SHALL avere alcun effetto (misurato
identico a sedici decimali). Rimettere la sfocatura sulla barra spegne quella
della scheda, in silenzio.

La leggibilità dei nomi sopra il testo in movimento SHALL essere retta dal FONDO
DELLA SCHEDA, preso dalla superficie che il design system usa per ciò che
galleggia su contenuto denso (`--popover-bg`), e NON da un'ombra sull'etichetta.

Un'ombra sul testo NON SHALL essere usata. Era il rimedio a un terreno che
mancava — la scheda portava un velo al 5-30% e il trascritto ci passava
attraverso — e con un fondo vero diventa una seconda risposta a una domanda che
non esiste più, che si legge come una sbavatura attorno alle lettere. Misurato:
col velo e senza ombra il caso peggiore era 1,05:1; col fondo del design system
e senza ombra è 14,44:1 in chiaro e 11,58:1 in scuro.

Il fondo SHALL avere alpha, non essere opaco: è un solo materiale con la
sfocatura della scheda, e un fondo opaco renderebbe quel filtro inerte.

Il fondo SHALL essere DERIVATO dal token, non ricopiato: il giorno in cui la
superficie dei popover viene ritarata, le schede SHALL seguirla.

Sotto il guscio nativo SHALL dipingere UNA SOLA superficie — il guscio della
finestra — e NESSUNA riga, né la prima né quella annidata.

La barra delle schede SHALL essere FUORI dal flusso, e la conversazione SHALL
cominciare SOTTO di lei: il varco in cima SHALL valere ESATTAMENTE l'altezza della
barra, e scorrendo i messaggi SHALL passare davvero dietro. Risalendo in cima, il
primo messaggio SHALL fermarsi al fondo della barra.

#### Scenario: una riga di chrome
- **GIVEN** una qualunque riga di chrome, in entrambi i temi
- **THEN** NON SHALL avere uno sfondo opaco proprio

#### Scenario: la barra delle schede
- **GIVEN** la barra delle schede, in entrambi i temi
- **THEN** il suo `backdrop-filter` SHALL essere `none`
- **AND** quello della card di una scheda SHALL contenere una sfocatura

#### Scenario: la conversazione che scorre
- **GIVEN** una chat che scorre sotto la barra
- **THEN** i messaggi SHALL passare dietro, e il varco in cima SHALL valere l'altezza della barra

### Requirement: CHROME-02 — Fra due righe impilate passa UN passo, e uno split le allinea

Fra due righe di chrome impilate SHALL passare UN SOLO passo, non due sommati:
sono state segnalate come «troppo lontane».

L'altezza della riga figlia e la variabile che il resto della pagina usa per
scostarsene SHALL COINCIDERE, o sotto la barra resta un vuoto.

In uno SPLIT le barre della STESSA riga SHALL essere ALLINEATE: stessa altezza,
stessa posizione, stesse schede alla stessa quota.

Col DITO la riga NON SHALL stringersi, e il varco SHALL restare quello della riga.

#### Scenario: due righe impilate
- **GIVEN** la riga dell'applicazione e quella del progetto
- **THEN** fra loro SHALL passare un solo passo

#### Scenario: uno split
- **GIVEN** due barre affiancate
- **THEN** SHALL avere la stessa altezza e la stessa quota

### Requirement: CHROME-03 — Il comando e la scheda hanno la STESSA misura, e la stessa aria

I comandi ai capi della barra e le schede SHALL avere la STESSA misura: comandi
più grandi delle schede nella stessa riga producono arie diverse, ed è stato
segnalato due volte.

L'aria sopra e sotto SHALL essere la stessa per entrambi, e ogni comando SHALL
stare alla STESSA distanza dal proprio bordo, specchiata ai due capi. La striscia
delle schede SHALL fermarsi alla stessa distanza prima del comando, ai due capi, e
a inizio scorrimento la prima scheda NON SHALL toccarlo.

La misura SHALL cambiare col MODO D'USO — puntatore o dito — e la coerenza SHALL
valere in entrambi.

Su TELEFONO la striscia SHALL sparire e al suo posto SHALL comparire il NOME della
superficie; l'unico comando SHALL avere la misura da dito e la stessa aria, e la
riga svuotata NON SHALL spostarsi.

#### Scenario: un comando e una scheda nella stessa riga
- **GIVEN** entrambi
- **THEN** SHALL avere la stessa misura e la stessa aria

#### Scenario: il telefono
- **GIVEN** una finestra da telefono
- **THEN** SHALL restare un comando solo, con la misura da dito

### Requirement: CHROME-04 — Il cerchio di chiusura cade dove cadeva il segno che sostituisce

Il comando che chiude una scheda SHALL atterrare ESATTAMENTE dove stava il segno
che sostituisce: se compare spostato, l'occhio vede il contenuto saltare.

Nessuna riga di testo SHALL nascere su una FRAZIONE di pixel: ereditare
l'interlinea del corpo del documento produce quote frazionarie, e il testo si vede
sfocato.

Un numero dentro un pallino SHALL essere centrato sui DUE assi, e la centratura
SHALL reggere con un carattere tipografico OSTILE: centrare sulla scatola del
testo invece che sui glifi produce uno scarto che cambia col font, e il banco
SHALL provarlo con un riferimento costruito apposta.

Il glifo di caricamento SHALL nascere su coordinate INTERE.

Col DITO l'area del comando di chiusura SHALL raggiungere la misura minima, il
glifo disegnato SHALL restare piccolo, e il tocco SHALL chiudere e poter ANNULLARE
senza colpire la scheda sottostante.

#### Scenario: un carattere tipografico ostile
- **GIVEN** un font con metriche diverse
- **THEN** il numero SHALL restare centrato

#### Scenario: il dito sul comando di chiusura
- **GIVEN** un tocco
- **THEN** SHALL chiudere, e l'annullamento SHALL essere raggiungibile

### Requirement: CHROME-05 — Le tre facce di una scheda sono la STESSA superficie

Una scheda ha tre facce — la tessera fissata, la riga nell'elenco, la scheda nella
barra — e SHALL condividere fondo, margini interni, corpo del testo e raggio: le
spaziature e i colori sono stati segnalati come incoerenti, e le misure lo
confermavano su tutti e tre gli assi.

Una riga SELEZIONATA SHALL distinguersi da una a riposo: entrambe dipinte, e con
fondi DIVERSI.

Fra due righe adiacenti SHALL passare lo stesso varco che passa fra due tessere, e
il filo che separa i fissati SHALL avere lo stesso spazio SOPRA e SOTTO.

Una tessera fissata SHALL essere alta esattamente quanto una riga.

Il comando di riga SHALL cadere alla stessa distanza dal bordo su riga e su
scheda, SHALL essere sempre l'ULTIMO elemento — nessun segnale alla sua destra —
e i segnali quieti che copre NON SHALL SPOSTARSI al passaggio del puntatore: SHALL
solo sbiadire.

#### Scenario: tessera e riga
- **GIVEN** la stessa scheda nelle due forme
- **THEN** SHALL avere lo stesso fondo, gli stessi margini e lo stesso corpo

#### Scenario: il passaggio del puntatore
- **GIVEN** i segnali quieti coperti dal comando
- **THEN** NON SHALL spostarsi, SHALL solo sbiadire

### Requirement: CHROME-06 — Un permalink apre IN-APP, e uno morto lo dice

Il collegamento permanente a una superficie SHALL essere lo STESSO da OGNI strada
che lo offre — il menu della scheda, il menu nell'elenco, la tavolozza dei
comandi — e SHALL identificare il SOGGETTO, non la finestra che lo mostra.

Un collegamento verso QUESTA applicazione, aperto dalla chat, SHALL aprirsi
DENTRO, senza passare dal navigatore di sistema e senza cambiare l'indirizzo della
pagina. La regola SHALL valere per TUTTE le forme: intercettarne una sola era
un'asimmetria.

Un collegamento MORTO SHALL ricadere sul navigatore esterno invece di restare
MUTO, e NON SHALL coniare una superficie fantasma.

A FREDDO un collegamento SHALL aprire la superficie giusta e LASCIARLE il fuoco,
anche quando l'idratazione della pagina arriva dopo e proverebbe a riprenderselo.
L'indirizzo SHALL essere CONSUMATO.

Una superficie GIÀ APERTA ma non a fuoco SHALL riceverlo.

Un soggetto INESISTENTE SHALL essere DICHIARATO tale. Una CARTELLA che esiste sul
disco SHALL essere un soggetto valido anche se non è mai stata registrata: la
risoluzione è asimmetrica fra ciò che vive sul disco e ciò che vive nel database.

Il gesto di copia SHALL scrivere negli appunti VERI.

#### Scenario: un collegamento verso questa applicazione
- **GIVEN** un permalink self-origin in chat
- **THEN** SHALL aprirsi dentro, senza navigatore esterno

#### Scenario: un soggetto inesistente
- **GIVEN** un permalink verso qualcosa che non c'è
- **THEN** SHALL essere dichiarato, senza coniare niente

### Requirement: CHROME-07 — I tre stati di una superficie si distinguono, e si raggruppano

Gli stati di una sessione — chi ASPETTA una decisione, chi ASPETTA una risposta,
chi LAVORA — SHALL essere distinguibili sulla scheda e nella riga, per segno E per
testo.

SHALL esistere una vista che li RAGGRUPPA: chi aspetta te, chi sta lavorando, il
resto.

La differenza fra chi aspetta e chi lavora SHALL essere visibile come TINTA e
RITMO, non solo come attributo: un esito verde non la dimostra a nessuno.

#### Scenario: le tre sessioni insieme
- **GIVEN** una in attesa di decisione, una in attesa di risposta, una al lavoro
- **THEN** SHALL essere distinguibili per segno e per testo

#### Scenario: la vista per stato
- **GIVEN** più sessioni
- **THEN** SHALL essere raggruppate per chi aspetta e chi lavora

### Requirement: PANE-01 — Il crollo di UNA superficie non porta giù le altre

Ogni superficie della griglia SHALL avere il PROPRIO recinto d'errore. Con un
recinto solo attorno all'INTERA griglia, insieme alla superficie rotta sparivano
quelle sane: terminali attaccati, chat in streaming, navigatori.

La superficie rotta SHALL mostrare il proprio errore e un modo per RIPROVARE; la
barra delle schede SHALL restare viva; le altre superfici SHALL continuare a
funzionare.

Una superficie il cui SOGGETTO non esiste più NON SHALL abbattere la finestra:
la barra SHALL restare, il corpo SHALL DEGRADARE dichiarando che non si trova, e
si SHALL poter navigare altrove.

SHALL esistere la CONTROPROVA: senza guasti, NESSUNA superficie SHALL mostrare un
errore.

#### Scenario: un pezzo di codice che non carica
- **GIVEN** una superficie il cui codice fallisce il caricamento
- **THEN** solo quella SHALL mostrare l'errore

#### Scenario: un soggetto che non esiste
- **GIVEN** una superficie attiva il cui soggetto non risolve
- **THEN** la finestra SHALL restare viva

### Requirement: CHROME-08 — La zona di trascinamento la mette il DISEGNO, e nessuna resta scoperta

L'attributo che rende una zona trascinabile SHALL essere messo dal DISEGNO della
pagina, non da un osservatore delle modifiche: con molti terminali attivi quello
produceva migliaia di eventi al secondo.

Spostato il costo, il rischio diventa la DIMENTICANZA: NESSUNA zona dichiarata
SHALL restare senza il proprio attributo, comprese quelle montate DOPO l'avvio.

Le SCHEDE NON SHALL trascinare la finestra.

Sotto la preferenza di MOTO RIDOTTO i comandi NON SHALL spostarsi, e l'angolo
della barra SHALL restare raggiungibile: un comando incollato a mezzo pixel dal
bordo intercetta il gesto e fa scadere ciò che ci prova.

#### Scenario: una zona montata dopo l'avvio
- **GIVEN** chrome che compare dopo il primo disegno
- **THEN** SHALL portare il proprio attributo

#### Scenario: il moto ridotto
- **GIVEN** la preferenza attiva
- **THEN** i comandi NON SHALL spostarsi, e l'angolo SHALL restare raggiungibile

### Requirement: CHROME-09 — Il vetro c'è anche su Windows, ed è di FINESTRA INTERA

Sotto il guscio nativo la finestra SHALL avere un fondo smerigliato NATIVO su
entrambe le piattaforme, non solo su macOS: vibrancy per-regione sul Mac, tenda
DWM su Windows 11.

Su Windows la tenda SHALL essere **Acrylic**, non Mica: Mica campiona soltanto lo
sfondo del desktop, quindi con un'altra finestra dietro non mostrerebbe nulla di
ciò che c'è davvero sotto — che è esattamente l'intento del disegno sul Mac. La
scelta SHALL restare UNA costante sola, così passare a Mica costa una riga.

La tenda SHALL seguire il tema chiaro/scuro dalla STESSA porta che già
sincronizza il cromo nativo (il comando che riceve la MODALITÀ, non il tema
risolto), e la modalità «sistema» SHALL leggere l'OS invece di pinnare un tema.

Il fondo della webview SHALL essere TRASPARENTE: un fondo opaco viene steso
sopra la tenda prima che la pagina disegni, e annulla qualunque backdrop DWM.
Per la stessa ragione la pagina SHALL dipingere traslucida dietro una classe
CONDIVISA fra le piattaforme, non dietro la classe di macOS: senza quella classe
il vetro nativo c'è e non si vede.

IL LIMITE È PARTE DEL CONTRATTO, non un difetto da inseguire. Le tende DWM sono
di FINESTRA INTERA e non esiste un equivalente per-regione: su Windows i varchi
fra le carte SHALL essere smerigliati anche loro, e NON trasparenti come sul
Mac, dove cadono sul desktop vero. Le chiamate per-regione (le IPC della
vibrancy) NON SHALL partire fuori da macOS.

Quando la preferenza di sistema «effetti di trasparenza» è SPENTA, Windows
appiattisce ogni backdrop: l'assenza di vetro in quel caso NON SHALL essere
letta come un difetto dell'applicazione, ed è il primo valore da rileggere prima
di toccare il codice.

#### Scenario: la finestra su Windows 11
- **GIVEN** il guscio desktop su Windows 11, con gli effetti di trasparenza attivi
- **THEN** la finestra SHALL portare la tenda Acrylic, e il fondo della webview SHALL essere trasparente

#### Scenario: il tema cambia
- **GIVEN** l'utente sceglie chiaro, scuro o «sistema»
- **THEN** la tinta della tenda SHALL seguire, dalla stessa porta del cromo nativo

#### Scenario: i varchi fra le carte
- **GIVEN** la finestra smerigliata su Windows
- **THEN** i varchi SHALL essere smerigliati, NON trasparenti, e nessuna IPC per-regione SHALL partire

### Requirement: SHEET-01 — Il foglio SEGUE il dito, e il tocco che chiude non aziona

Un foglio che entra dal basso SHALL SEGUIRE il dito durante il gesto: il bordo
SHALL stare dove è il dito, entro una tolleranza stretta.

Al RILASCIO SHALL decidere il GESTO, non solo la posizione: una corsa BREVE e
LENTA NON SHALL chiudere niente, e il foglio SHALL tornare al suo posto.

Con un pannello aperto, il PRIMO tocco fuori SHALL solo CHIUDERE, e il SECONDO
SHALL azionare: prima si chiude quello che sta davanti, perché non si vede
nemmeno dove si sta toccando.

#### Scenario: il gesto in corso
- **GIVEN** un dito che trascina il foglio
- **THEN** il bordo SHALL seguirlo entro la tolleranza

#### Scenario: un pannello aperto
- **GIVEN** un tocco fuori dal pannello
- **THEN** SHALL chiudere soltanto, senza azionare ciò che c'è sotto

### Requirement: PREVIEW-01 — Più evidenze si sfogliano, e la scheda di consegna non si ripete sulla card

Quando le evidenze sono più di una SHALL essere SFOGLIABILI: puntini che dicono
QUANTE sono, la ROTELLA che le muove — con il gestore NON passivo, o la pagina
scorre invece — un puntino che porta dritto alla sua, e il click che apre la vista
ingrandita SENZA aprire il pannello del task.

Nella vista ingrandita SHALL essere possibile navigare da TASTIERA, con un
contatore che dice dove si è.

La scheda riassuntiva della consegna NON SHALL comparire sulla card, dove
ripeterebbe ciò che c'è già — misurata sulla bacheca vera, quasi metà delle card
in review ne mostrava una. Il controllo SHALL essere accompagnato dalla
CONTROPROVA che le anteprime VERE restano.

I file della consegna SHALL stare in un elenco APRIBILE: chiuso mostra il
CONTEGGIO, aperto i PERCORSI. Aprirlo NON SHALL aprire il pannello del task, e non
SHALL restare in uno stato di attesa perpetua.

#### Scenario: tre evidenze
- **GIVEN** più evidenze sulla stessa card
- **THEN** SHALL essere sfogliabili, e i puntini SHALL dire quante sono

#### Scenario: l'elenco dei file
- **GIVEN** l'elenco chiuso
- **THEN** SHALL mostrare il conteggio, e aprirlo NON SHALL aprire il pannello

### Requirement: TYPO-01 — Nessun glifo viene tagliato dalla propria riga

Nessuna coda e nessun accento SHALL essere TAGLIATO dalla riga che lo contiene:
un'interlinea pari esatta al corpo del testo crea una riga alta quanto il
carattere, ma i glifi vivono nella scatola del FONT e ne escono sopra e sotto — a
tagliare è il contenitore che nasconde l'eccedenza.

La verifica SHALL guardare i glifi VERI — code discendenti e lettere accentate —
non l'altezza dichiarata.

#### Scenario: una coda discendente
- **GIVEN** un testo con lettere che scendono sotto la linea di base
- **THEN** NON SHALL essere tagliato

#### Scenario: una lettera accentata
- **GIVEN** un accento sopra la linea del corpo
- **THEN** NON SHALL essere tagliato

### Requirement: TOOLTIP-01 — Il suggerimento nostro sostituisce quello nativo, e lo RIMETTE

Il suggerimento dell'applicazione SHALL sostituire quello nativo al passaggio del
puntatore, e SHALL RIMETTERE l'attributo nativo quando il puntatore esce: toglierlo
e non rimetterlo è una regressione di accessibilità SILENZIOSA — a schermo sembra
tutto a posto, anzi meglio, e intanto chi legge con un lettore di schermo ha perso
il testo.

Un click SHALL chiuderlo SUBITO, invece di lasciarlo appeso.

SHALL essere MULTIRIGA: è metà della ragione per cui esiste. E NON SHALL mostrare
una chiave di traduzione grezza.

#### Scenario: il puntatore esce
- **GIVEN** un elemento che aveva un suggerimento nativo
- **THEN** l'attributo nativo SHALL tornare

#### Scenario: un click
- **GIVEN** il suggerimento aperto
- **THEN** SHALL chiudersi subito

### Requirement: CONTRAST-01 — Il contrasto si CALCOLA, e un token vale in TUTTI e due i temi

Il rapporto di contrasto del testo sui token dell'interfaccia SHALL essere
CALCOLATO contro una soglia, non giudicato a occhio. E' la classe di difetti che
una passata visiva non trova e un conto trova sempre: misurato il 2026-08-26 su
Topics installata, `--text-muted` dava **4,42** contro il fondo del chrome e
`--kbd-text` **4,44** contro il fondo del tasto — sotto il 4,5 che il testo
normale richiede, e di un margine che l'occhio non vede. Le sei voci sotto soglia
erano tutte tipo piccolo (11-12px): «No active items», «Persone», il numero di
versione in fondo alla colonna, le didascalie dei tasti.

Ogni token SHALL avere un valore VALIDO in ENTRAMBI i temi, e la prova SHALL
guardarli tutti e due. Un token con un valore del tema scuro dentro il tema
chiaro non degrada: sparisce. `--bg-panel` era `#1e1e1e` anche in chiaro, e il
suggerimento risultava testo `rgb(26,27,28)` su `rgb(30,30,30)` — un rapporto di
**1,03 su 21**, cioe' un rettangolo nero vuoto, mentre ogni altra proprieta'
(opacita', posizione, dimensione) diceva che era a posto.

#### Scenario: un token di testo sotto soglia
- **GIVEN** un token di testo il cui rapporto calcolato e' sotto 4,5
- **THEN** il banco SHALL fallire e SHALL nominare il token

#### Scenario: un token valido in un tema solo
- **GIVEN** un token che nel tema opposto porta il valore dell'altro
- **THEN** il banco SHALL fallire

### Requirement: EMPTY-01 — Il vuoto è una PRIMITIVA, leggibile nelle sue varianti e nei due temi

Lo stato VUOTO SHALL essere una primitiva condivisa, non scritto a mano da ogni
pannello.

Le sue varianti SHALL essere LEGGIBILI in ENTRAMBI i temi, raggiungendo il
contrasto minimo per il loro ruolo.

#### Scenario: le due varianti insieme
- **GIVEN** una ricerca senza risultati che mostra entrambe
- **THEN** entrambe SHALL raggiungere il contrasto minimo

#### Scenario: il tema chiaro
- **GIVEN** il tema chiaro
- **THEN** il vuoto SHALL restare leggibile

### Requirement: RELOAD-01 — Un ricaricamento CHIESTO si annuncia, uno non chiesto resta muto

Un ricaricamento marcato dal guscio nativo SHALL ANNUNCIARSI a schermo: il difetto
non era il ricaricamento, era il SILENZIO — l'applicazione aveva obbedito, e
nessuno dei due lo sapeva.

Un ricaricamento NON marcato SHALL restare MUTO.

Il segno SHALL valere UNA volta sola.

#### Scenario: un ricaricamento chiesto dal guscio
- **GIVEN** il segno lasciato dal guscio
- **THEN** SHALL comparire l'annuncio

#### Scenario: un secondo ricaricamento
- **GIVEN** nessun segno nuovo
- **THEN** NON SHALL comparire niente

### Requirement: LAYOUT-20 — Le tessere fissate stanno in RIGHE, e nessun gesto perde o duplica una tessera

La disposizione delle tessere fissate SHALL essere a RIGHE, e OGNI operazione —
spostare, inserire una riga, riordinare dentro una riga, fondere ciò che arriva
da un altro dispositivo — SHALL essere INVARIANTE sull'insieme delle chiavi:
nessuna persa, nessuna duplicata, a nessun indice.

La riconciliazione SHALL essere IDEMPOTENTE anche quando l'elenco dei fissati
arriva con un DOPPIONE: il ramo dei mancanti lo accodava due volte e solo il giro
dopo lo raddrizzava, cioè la funzione dichiarata idempotente non lo era.

Uno spostamento verso DESTRA dentro la stessa riga NON SHALL scavalcare di uno, e
l'anteprima mostrata durante il gesto SHALL coincidere con il risultato del
rilascio. L'UNICA tessera di una riga, rilasciata sulla PROPRIA riga, NON SHALL
muoversi: togliendola prima, la riga svuotata spariva e l'indice puntava a quella
dopo — rimetterla dov'era FONDEVA due righe, in modo persistente e senza
annullamento.

Una tessera che occupa GIÀ una riga intera NON SHALL avere come bersaglio una
riga nuova sopra o sotto. Ogni bersaglio PERMESSO SHALL cambiare davvero
qualcosa: nessun bersaglio che accetta il rilascio e non fa niente.

La fusione con ciò che arriva da fuori SHALL rimettere ogni tessera NASCOSTA
accanto al vicino con cui stava, e una riga interamente nascosta SHALL rinascere
al suo posto, non in coda. Un riordino fatto con un filtro attivo SHALL RESTARE:
bastava riordinare due tessere con una ricerca attiva per appiattire su una riga
sola una disposizione fatta a mano, senza annullamento.

Le larghezze di una riga SHALL restare EQUE: una tessera aggiunta a una riga
equa NON SHALL nascere più stretta delle altre, e togliere una tessera SHALL
lasciare le altre uguali fra loro. Una riga arrivata STORTA da un client vecchio
SHALL essere raddrizzata. Le proporzioni salvate NON SHALL essere conservate:
nessuno può averle volute, non esiste un gesto per ridimensionare una tessera.

Il rilascio SHALL posare la tessera nella CELLA indicata, non in coda, e su una
riga NUOVA esattamente dove è stato lasciato.

#### Scenario: la tessera unica della sua riga
- **GIVEN** un rilascio sulla propria riga
- **THEN** NON SHALL succedere niente, e le righe NON SHALL fondersi

#### Scenario: un riordino con un filtro attivo
- **GIVEN** una ricerca che nasconde alcune tessere
- **THEN** la disposizione fatta a mano SHALL sopravvivere

### Requirement: LAYOUT-21 — Una tessera è alta quanto una riga, e l'aria del comando la lascia il CENTRAGGIO

Una tessera fissata SHALL essere alta ESATTAMENTE quanto una riga, su ENTRAMBI i
modi d'uso: l'invariante ha retto finora per INTERVENTO MANUALE — quando il
riquadro del comando è cresciuto, lo spazio interno è stato schiacciato a mano per
tenere ferma la tessera.

Il rientro del comando SHALL essere DERIVATO — la metà della differenza fra
tessera e comando — non SCELTO, e SHALL essere INTERO: un valore che produce mezzo
pixel è già stato un difetto. Lo spazio riservato SHALL essere largo quanto il
comando che vi si appoggia, e il rientro SHALL essere POSITIVO su entrambi i
rami, o i tre spazi coincidono e l'invariante smette di dire qualcosa.

I valori dichiarati nelle classi SHALL corrispondere ai numeri usati per il
calcolo: un valore scritto a mano da una parte e non dall'altra è come la riga è
diventata di un'altra misura senza che la tessera lo sapesse.

#### Scenario: la misura del comando cambia
- **GIVEN** un riquadro di comando più grande
- **THEN** il rientro SHALL riderivarsi, e la tessera SHALL restare alta come la riga

#### Scenario: un rientro frazionario
- **GIVEN** una differenza dispari
- **THEN** il banco SHALL fallire

### Requirement: LAYOUT-22 — Il tetto di una sezione si DERIVA dal numero di sezioni

Il tetto di altezza di una sezione di colonna SHALL essere DERIVATO dal numero di
sezioni che la colonna monta davvero, non scritto come frazione fissa: aggiungerne
una lasciando il tetto fermo darebbe a tre sezioni piene tutto lo spazio e
all'ultima zero.

Il tetto SHALL essere una PERCENTUALE del contenitore, non dell'altezza della
finestra: richiede un contenitore con un'altezza definita, ed è quello il
contratto.

#### Scenario: una sezione in più
- **GIVEN** un numero di sezioni diverso
- **THEN** il tetto SHALL cambiare di conseguenza

#### Scenario: l'unità del tetto
- **GIVEN** il valore calcolato
- **THEN** SHALL essere relativo al contenitore, non alla finestra

### Requirement: PANE-02 — L'identificativo di una superficie si COSTRUISCE, e ciò che è indirizzabile lo dichiara

L'identificativo di una superficie SHALL essere costruito dal suo TIPO e dalla sua
chiave, in forma STABILE dove una chiave esiste, e con un valore sorteggiato solo
dove non esiste. Ogni forma SHALL avere il proprio riconoscitore e il proprio
estrattore, e i due SHALL fare andata e ritorno.

Una chiave che porta un percorso SHALL essere CODIFICATA nell'identificativo e
GREZZA nella chiave di fissaggio: fissare nel contratto la forma codificata era
fissare il difetto per cui la colonna non trovava mai il progetto fissato da una
scheda. La normalizzazione SHALL essere IDEMPOTENTE e NON SHALL esplodere su una
codifica illeggibile.

La chiave di SESSIONE di una chat NON SHALL essere l'identificativo nudo: era
proprio quello a farsi passare per una sessione. Un discorso SCONOSCIUTO SHALL
dare «niente», non l'identificativo nudo.

Ciò che compare nei menu di creazione SHALL essere deciso da una DICHIARAZIONE
sull'ambito, non da un filtro scritto a mano nel menu: perdendolo, una superficie
comparirebbe anche dove il suo motore non c'è e aprirebbe una superficie vuota. I
tipi FISSI NON SHALL comparire mai, e un tipo singolo già presente SHALL essere
escluso.

L'indirizzabilità SHALL essere DICHIARATA: i tipi il cui identificativo è
sorteggiato a ogni apertura NON SHALL essere indirizzabili, e quel «niente» È il
cancello della voce di menu. Per una differenza il progetto SHALL essere quello
del CONTENUTO, non quello della finestra che lo ospita: altrimenti il collegamento
copiato ricompone un percorso che non esiste.

Un tipo senza una propria configurazione SHALL ricadere su quella predefinita.

#### Scenario: un progetto fissato da una scheda
- **GIVEN** la chiave di fissaggio
- **THEN** SHALL essere la forma grezza, non quella codificata

#### Scenario: una differenza ospitata da un altro progetto
- **GIVEN** un file di un progetto aperto dentro un altro
- **THEN** l'indirizzo SHALL portare il progetto del file

### Requirement: PANE-13 — Lo scorrimento ripristinato si CLAMPA dentro ciò che è davvero scorribile

Un offset di scorrimento ripristinato SHALL essere limitato all'intervallo
REALMENTE disponibile: un dispositivo che aveva più contenuto lascia un valore che
sull'altro non esiste.

Un valore assente, negativo o non finito SHALL valere zero. Un contenuto più
corto della finestra SHALL dare zero, non un valore negativo.

#### Scenario: contenuto più corto della finestra
- **GIVEN** nessuno scorrimento possibile
- **THEN** l'offset SHALL essere zero

#### Scenario: un offset più grande del massimo
- **GIVEN** un valore ripristinato troppo grande
- **THEN** SHALL essere limitato al massimo

### Requirement: PANE-04 — Il registro delle mutazioni è un anello LIMITATO che avvisa tutti

Le azioni sul deposito delle superfici SHALL essere registrate in ORDINE, in un
anello di dimensione LIMITATA: oltre il tetto escono le più vecchie.

Ogni registrazione SHALL avvisare OGNI iscritto, e l'iscrizione SHALL restituire
il modo per disdirsi.

#### Scenario: oltre il tetto
- **GIVEN** più azioni della capacità
- **THEN** SHALL restare le più recenti, in ordine

#### Scenario: più iscritti
- **GIVEN** più ascoltatori
- **THEN** SHALL essere avvisati tutti

### Requirement: PANE-05 — Uno Spazio cancellato NON RESUSCITA, e lo spazio predefinito non è un record

Gli Spazi SHALL essere creati, rinominati e cancellati in modo SOFT — con una
lapide DENTRO il record — e le superfici che vi appartenevano SHALL tornare al
predefinito.

Lo spazio PREDEFINITO NON SHALL MAI essere un record: l'appartenenza a esso SHALL
essere codificata come ASSENZA, e la creazione o la cancellazione del predefinito
SHALL essere rifiutata. Un'appartenenza assente vuol dire PREDEFINITO, non
«ignoto»: riaprire una superficie NON SHALL teletrasportarla nello spazio attivo
solo perché quello è attivo.

Cancellare lo spazio ATTIVO SHALL riportare la finestra al predefinito.
Cancellare uno spazio che localmente non si conosce SHALL comunque coniare una
lapide, o la cancellazione non si propaga.

La fusione fra dispositivi SHALL essere PER IDENTIFICATIVO, mai in blocco:
creazioni DISGIUNTE da due dispositivi SHALL sopravvivere ENTRAMBE. Fra due
versioni dello stesso vince la più recente — ma la CANCELLAZIONE è ASSORBENTE: una
rinomina con un istante PIÙ ALTO, per corsa o per orologio sfasato, NON SHALL
resuscitare uno spazio cancellato.

Il conteggio che governa il tetto SHALL ignorare le lapidi, o dopo abbastanza
cicli di creazione e cancellazione il comando di creazione sparirebbe per sempre.

Uno spazio ignoto, cancellato o assente SHALL risolversi sul predefinito. Lo
spazio ATTIVO SHALL restare locale al dispositivo: l'idratazione NON SHALL
toccarlo.

#### Scenario: una rinomina che corre con la cancellazione
- **GIVEN** una rinomina con un istante più alto della lapide
- **THEN** lo spazio NON SHALL resuscitare

#### Scenario: molti cicli di creazione e cancellazione
- **GIVEN** più cicli del tetto
- **THEN** il comando di creazione SHALL restare disponibile

### Requirement: LAYOUT-23 — La disposizione del navigatore di un task si riconcilia con le schede vere

La disposizione a gruppi, righe e colonne delle schede del navigatore di un task
SHALL essere RICONCILIATA con le schede realmente aperte: una scheda nuova SHALL
essere accodata al gruppo a fuoco e attivata; una tolta SHALL sparire dal suo
gruppo; chiudere quella attiva SHALL dare il fuoco a una superstite; un gruppo che
si svuota SHALL sparire con la sua colonna.

La riconciliazione SHALL essere IDEMPOTENTE e SHALL restituire lo STESSO oggetto
quando non cambia niente.

Le divisioni SHALL comportarsi come dichiarato: a destra una seconda colonna con
la larghezza dimezzata, in basso una pila, a riga intera una riga che si estende
con le altezze divise. Dividere l'ULTIMA superficie di un gruppo solo SHALL essere
un non-fare.

Una superficie ORFANA SHALL poter prendere il posto attivo solo se è del tipo
giusto: una che non lo è NON SHALL rubarlo.

Il banco SHALL esercitare la regola VERA, non una copia riscritta a mano: quella
prova la riconciliazione e non prova la regola.

Quando il server ha CANCELLATO la riga, la scrittura ancora in coda SHALL essere
ANNULLATA: senza, la riga torna in vita qualche centinaio di millisecondi dopo —
ed è così che questi record diventavano immortali. Il caso di CONTROLLO — senza
l'annullamento la scrittura parte davvero — SHALL esistere, o il banco non
potrebbe fallire.

Un carico malformato SHALL essere rifiutato, e uno valido SHALL fare andata e
ritorno.

#### Scenario: il server ha cancellato la riga
- **GIVEN** una scrittura ancora in coda
- **THEN** SHALL essere annullata

#### Scenario: una superficie orfana di un altro tipo
- **GIVEN** un'orfana che non è del tipo atteso
- **THEN** NON SHALL prendere il posto attivo

### Requirement: A11Y-01 — Un comando fatto di sola icona ha un NOME

Un comando che contiene SOLO un'icona SHALL portare un nome accessibile. Al
momento del rilievo erano diciassette, e quasi tutte erano CHIUSURE: le
impostazioni, l'ispettore, il dettaglio di un task, le scorciatoie, l'avviso
temporaneo, la scheda dell'editor, i due cartelli di esito.

Il setaccio SHALL essere STRETTO: la prima versione segnalava qualunque comando
senza testo letterale e ne trovava quasi novanta, metà dei quali falsi positivi.
La regola SHALL guardare i comandi il cui unico contenuto è un componente-icona.

L'elenco dei sorgenti esaminati SHALL essere verificato non vuoto.

#### Scenario: un comando con la sola icona
- **GIVEN** nessun nome accessibile dichiarato
- **THEN** il banco SHALL fallire

#### Scenario: un comando con del testo accanto all'icona
- **GIVEN** un contenuto che non è solo l'icona
- **THEN** NON SHALL essere segnalato

### Requirement: LAYOUT-24 — Le superfici a schermo intero prendono il piano da una COSTANTE

Una superficie che copre lo SCHERMO INTERO NON SHALL scriversi il proprio piano a
mano: i valori trovati andavano da poche decine a quasi diecimila, scelti uno per
volta. È la forma esatta del difetto per cui una tavolozza finiva migliaia di
livelli SOTTO un menu già aperto, e sembrava che aprisse tutto.

Il piano SHALL venire da una COSTANTE condivisa, e le superfici già riparate SHALL
prenderlo da lì.

Le eccezioni dichiarate SHALL esistere ancora dove sono dichiarate, e il debito
noto SHALL essere STRETTO e non crescere.

Il setaccio SHALL essere visto riconoscere sia la forma arbitraria sia quella
della scala predefinita, e SHALL lasciare stare i piani PICCOLI interni a un
componente.

#### Scenario: una superficie nuova a schermo intero
- **GIVEN** un piano scritto a mano
- **THEN** il banco SHALL fallire

#### Scenario: un piano piccolo dentro una card
- **GIVEN** un valore locale non a schermo intero
- **THEN** NON SHALL essere segnalato

### Requirement: DEEPLINK-01 — Un link che non porta da nessuna parte deve almeno DIRLO

Il clic su un collegamento della propria origine dentro un testo formattato SHALL
avere tre esiti, e NESSUNO dei tre SHALL essere il silenzio.

Un vicolo cieco con niente di aperto SHALL aprire FUORI dall'app, in silenzio: è
un ripiego che si vede.

**Aperto a metà e poi arreso SHALL AVVISARE**, e NON SHALL aprire anche fuori. Era
il terzo esito, ed era muto: la rotta interna apriva la finestra di progetto, il
secondo salto si arrendeva, e non succedeva più niente — nessuna pane, nessun
avviso, nessun ripiego.

Una rotta riuscita NON SHALL produrre né avvisi né aperture esterne.

Un collegamento a un task appartiene al proprio cassetto: NON SHALL produrre né
avvisi né ripieghi da qui.

Ciò che non è della propria origine — o una finestra staccata — SHALL andare al
browser esterno.

#### Scenario: la rotta si arrende dopo aver aperto qualcosa
- **GIVEN** un primo salto riuscito e un secondo che fallisce
- **THEN** SHALL comparire un avviso, e NON SHALL aprirsi niente fuori

#### Scenario: un collegamento estraneo
- **GIVEN** un collegamento a un'altra origine
- **THEN** SHALL aprirsi nel browser esterno

### Requirement: MODAL-01 — Con un modale aperto, Escape NON arriva al turno

La regola che decide se Escape può interrompere il turno SHALL leggere il DOM, non
un elenco scritto a mano: con un modale che quell'elenco non nominava — le
impostazioni, l'elenco degli agenti, l'editor di profilo, la lente delle anteprime
— Escape cadeva nel ramo «niente da chiudere» e ammazzava il turno in streaming
dietro al modale.

Nessun modale nel DOM SHALL lasciare Escape libero di interrompere il turno. UNO
solo VISIBILE SHALL bastare a fermarlo, anche in mezzo a molti nascosti.

Un modale montato ma NON disegnato NON SHALL contare.

**Il velo di sfondo NON SHALL essere la superficie**: conta la card, non il velo.

I popover e i menu NON SHALL essere modali: hanno il proprio Escape.

Ogni marcatore di modale SHALL essere anche un marcatore di copertura nativa: è il
legame che tiene insieme questa regola e quella delle viste native.

#### Scenario: un modale nascosto
- **GIVEN** un modale montato ma non disegnato
- **THEN** Escape SHALL restare libero di interrompere il turno

#### Scenario: un modale visibile
- **GIVEN** almeno un modale disegnato
- **THEN** Escape NON SHALL raggiungere l'interruzione del turno

### Requirement: MOTION-01 — Le due copie della tabella del movimento restano UGUALI

Durate e curve del movimento vivono in DUE posti — nel modulo, perché le
animazioni scritte in codice lo importano, e come proprietà personalizzata nel
foglio di stile, perché un fotogramma chiave non può importare un modulo. Due
copie sono un debito: si cambia un numero di qua, si dimentica di là, e da quel
momento la stessa cosa si muove a due velocità a seconda di chi la anima.

OGNI durata del modulo SHALL esistere nel foglio di stile con lo STESSO numero, e
ogni curva SHALL esistere con la STESSA definizione.

Le durate SHALL stare in SCALA: un riscontro, una comparsa, uno spostamento, un
viaggio, in quest'ordine crescente.

L'animazione di un elemento SHALL essere un non-fare — senza sollevare — dove
l'interfaccia di animazione non esiste, e chi ha chiesto MENO movimento NON SHALL
vederne.

#### Scenario: una durata cambiata in un solo posto
- **GIVEN** un numero modificato nel modulo ma non nel foglio di stile
- **THEN** la verifica SHALL fallire

#### Scenario: chi ha chiesto meno movimento
- **GIVEN** la preferenza di movimento ridotto
- **THEN** NON SHALL essere animato niente

### Requirement: MOTION-02 — La preferenza di movimento si chiede UNA volta, e si legge SEMPRE aggiornata

Il punto NON è il valore restituito: è QUANTE VOLTE si costruisce un osservatore
di media query. Il difetto misurato era più di settecento oggetti vivi in poco più
di un'ora a schermo FERMO, e nasceva da una costruzione dentro un effetto senza
dipendenze — cioè a ogni ridisegno. Una verifica sul solo valore sarebbe restata
verde con il difetto dentro.

SHALL essere costruito UN SOLO osservatore anche su migliaia di chiamate.

La lettura SHALL restituire la preferenza CORRENTE, non quella dell'istante in cui
l'osservatore è stato memorizzato: una cache del valore trasformerebbe un
risparmio in un bug.

La query interrogata SHALL essere quella giusta.

Senza l'interfaccia delle media query SHALL rispondere «nessuna preferenza» e NON
SHALL RITENTARE a ogni chiamata. Fuori dal browser SHALL rispondere lo stesso:
chi non ha un sistema operativo non ha una preferenza.

#### Scenario: mille chiamate
- **GIVEN** mille letture consecutive
- **THEN** SHALL essere costruito un solo osservatore

#### Scenario: la preferenza cambia dopo la memorizzazione
- **GIVEN** un cambio di preferenza a osservatore già costruito
- **THEN** la lettura SHALL riportare il valore nuovo

### Requirement: EXTERNAL-01 — Aprire fuori una volta sola

L'apertura di un indirizzo fuori dall'app SHALL avvenire UNA volta per gesto. Una
ripetizione RAVVICINATA dello STESSO indirizzo SHALL essere ingoiata: è la guardia
contro il doppio clic, che altrimenti apre due finestre.

Indirizzi DIVERSI NON SHALL essere mai deduplicati fra loro, e lo stesso indirizzo
SHALL essere di nuovo apribile una volta trascorsa la finestra.

Un indirizzo vuoto SHALL essere ignorato.

L'apertura SHALL passare per la porta unica che conosce sia il guscio nativo sia
il browser.

#### Scenario: un doppio clic
- **GIVEN** due aperture ravvicinate dello stesso indirizzo
- **THEN** SHALL aprirsi una sola volta

#### Scenario: due indirizzi diversi
- **GIVEN** due aperture ravvicinate di indirizzi diversi
- **THEN** SHALL aprirsi entrambe

### Requirement: LAYOUT-25 — La tinta di una cella la decide il TIPO della pane, non il posto nell'albero

Il fondo di una cella SHALL dipendere dal TIPO della pane che ospita, e NON dalla
sua posizione nell'albero del riquadro.

La pane del browser SHALL stare nel livello smerigliato insieme a chat e bacheca:
l'unica parte che si vede è la striscia di comandi in cima — nessuna delle due
barre ha un fondo proprio — e il contenuto web dipinge il proprio opaco per conto
suo.

Le pane che si dipingono il chrome da sole SHALL restare trasparenti.

Il fondo OPACO SHALL restare dove c'è testo denso da tenere nitido.

NESSUNA regola di foglio di stile SHALL decidere più questa tinta: la decisione sta
in un posto solo.

#### Scenario: una pane browser
- **GIVEN** una cella che ospita una pane browser
- **THEN** SHALL stare nel livello smerigliato

#### Scenario: testo denso
- **GIVEN** una cella che ospita testo denso
- **THEN** il fondo SHALL restare opaco

### Requirement: LAYOUT-26 — La colonna dell'accordion è UNA, e la riservano anche le righe che non hanno un accordion

Nella sidebar lo spazio del chevron SHALL essere riservato da OGNI riga, anche da
quelle che non hanno niente da aprire: una riga senza accordion che non lo riserva
fa cominciare il proprio contenuto 20px (il riquadro del chevron più il passo
della riga) prima di quello della riga sorella che ce l'ha, e nella stessa colonna
convivono due incolonnamenti.

Vale per la riga di chat senza figli, per il terminale, per il browser, per le
righe di utilità e per la riga della bacheca, e per la tessera fissata in forma di
RIGA. In forma di GRIGLIA la tessera NON SHALL riservarlo: lì l'identità sta al
centro e un riquadro vuoto in testa la sposterebbe.

Il riquadro riservato SHALL essere lo STESSO del chevron, non una seconda misura.

La verifica NON SHALL essere a occhio: le `left` delle etichette della colonna
SHALL avere UN solo valore per ciascun livello di profondità.

Il passo di rientro per profondità resta fuori: lì due valori diversi sono voluti.

#### Scenario: due righe sorelle, una con accordion e una senza
- **GIVEN** una chat con figli e una chat senza figli allo stesso livello
- **THEN** le due etichette SHALL cominciare allo STESSO pixel

#### Scenario: la tessera fissata in griglia
- **GIVEN** una tessera che non si apre, in forma di griglia
- **THEN** NON SHALL riservare il riquadro dell'accordion

### Requirement: LAYOUT-27 — La colonna dei NOMI è UNA: lo slot del glifo di testa lo riservano anche le righe senza glifo

Misurato sulla card 018fd91f, sidebar alla larghezza di default: il nome di una
chat partiva a 34px dal bordo, quello di un progetto a 56 (la favicon stava in una
scatola sua da 14px, l'ultimo glifo fuori dallo slot condiviso), quello della
bacheca, delle utilità, dei terminali e dei browser a 60. Tre incolonnamenti nella
stessa lista, e nessuna riga sbagliata da sola.

**RIBALTATO IL 29/08/2026.** «Vedo ancora spazio prima delle label nelle tab
della sidebar» (l'utente): la colonna unica si comprava con una scatola VUOTA
davanti a ogni nome di chat, e quella scatola E' lo spazio di cui si parla. Il
baratto era fra un incolonnamento che si legge scorrendo l'occhio in verticale e
dell'aria morta che si guarda tutto il giorno: adesso vince l'aria.

Una riga che NON disegna un glifo di testa NON SHALL riservarne la scatola: il
suo nome comincia al padding della riga. Una chat NON SHALL guadagnare un
marchio proprio per riempirla — i marchi (Claude / Codex) restano delle sessioni
agente vere.

Ogni glifo di testa SHALL stare nello STESSO slot, favicon di progetto compresa:
una scatola scritta a mano accanto allo slot condiviso rifà lo stesso difetto più
piccolo. Il DISEGNO può restare più stretto dello slot: allinea la scatola, non
l'inchiostro.

La verifica NON SHALL essere a occhio, e NON SHALL limitarsi alle righe con
`role="treeitem"`: la riga di progetto non lo è, e la coppia che il difetto
riguarda resterebbe fuori dalla misura.

#### Scenario: una chat e un progetto allo stesso livello
- **GIVEN** una chat di primo livello e un progetto di primo livello
- **THEN** il nome della chat SHALL cominciare a SINISTRA di quello del progetto

#### Scenario: una riga di chat
- **GIVEN** una chat, che non porta nessun glifo di testa
- **THEN** NON SHALL riservare il riquadro del glifo

#### Scenario: due righe che un glifo ce l'hanno
- **GIVEN** un progetto e un terminale di primo livello
- **THEN** i due nomi SHALL cominciare dallo STESSO pixel

### Requirement: POPOVER-01 — Uno alla volta, ma un FIGLIO non caccia il genitore

L'apertura di un popover ESCLUSIVO SHALL chiudere i FRATELLI e NON SHALL chiudere
il GENITORE: se il trigger del nuovo vive DENTRO il pannello del vecchio, il
vecchio è il suo contenitore e chiuderlo chiuderebbe anche il nuovo.

Senza un trigger noto SHALL chiudere TUTTO: chi non ha un ancoraggio non può essere
figlio di nessuno. Un riferimento non montato NON SHALL contare come contenitore.

Un popover NON esclusivo NON SHALL cacciare nessuno e SHALL restare accanto agli
altri.

La registrazione SHALL contare, e la funzione restituita SHALL deregistrare. Un
secondo popover esclusivo SHALL prendere il posto del primo, lasciandone UNO. Lo
sfrattato SHALL uscire dal registro PRIMA di essere chiuso, e deregistrare uno già
sfrattato NON SHALL scalare il conto di chi lo ha sostituito.

Le sotto-superfici SHALL essere esposte separatamente. La chiusura di tutti SHALL
svuotare il registro e chiudere tutto, sotto-superfici comprese.

#### Scenario: un popover aperto da dentro un altro
- **GIVEN** un trigger che vive nel pannello del popover già aperto
- **THEN** il genitore NON SHALL essere chiuso

#### Scenario: deregistrare uno già sfrattato
- **GIVEN** un popover sostituito e poi deregistrato
- **THEN** il conto di chi lo ha sostituito NON SHALL essere scalato

### Requirement: SCROLLDELTA-01 — Si scorre di quel tanto che basta, e non si scorre se è già dentro

Il calcolo dello scorrimento verso un bersaglio SHALL restituire ZERO quando il
bersaglio è già dentro la finestra, e SHALL contare come dentro anche il bersaglio
a FILO dei due bordi, senza margine.

Oltre il bordo finale SHALL portare AVANTI quel tanto che basta; prima del bordo
iniziale SHALL portare INDIETRO, cioè un valore negativo.

Il margine SHALL STACCARE dal bordo invece di appoggiarci sopra il bersaglio.

Un bersaglio più grande della finestra SHALL essere allineato al suo inizio,
invece di restare irraggiungibile.

I numeri SHALL essere quelli del riquadro visibile, che NON SHALL essere assunto
partire da zero.

#### Scenario: il bersaglio è già visibile
- **GIVEN** un bersaglio interamente dentro la finestra
- **THEN** lo scorrimento SHALL essere zero

#### Scenario: un bersaglio più alto della finestra
- **GIVEN** un bersaglio che non ci sta
- **THEN** SHALL essere allineato al suo inizio

### Requirement: CHROME-METRIC-01 — Le misure della striscia di comandi le dice UNA fonte

Le misure della riga di chrome SHALL uscire tutte dalle stesse costanti, e la
costante che dichiara i pixel SHALL dire DAVVERO i pixel della classe
corrispondente: due fonti per la stessa misura si separano al primo ritocco.

Il comando in coda SHALL lasciare alla riga la stessa aria della tab accanto, e
il comando in testa SHALL avere lo STESSO incasso di quello in coda. Gli incassi
orizzontali SHALL cadere su pixel INTERI.

La riserva della striscia SHALL essere bordo più box più la stessa aria del bordo,
e la riserva a SINISTRA SHALL essere quella specchiata.

La riga subordinata SHALL essere box più UN solo incasso, e i due numeri SHALL
uscire dalla stessa fonte. Il comando SHALL starci dentro la riga.

Il margine di una card SHALL essere METÀ del passo di colonna, e SHALL stare
scritto nella classe; il passo ORIZZONTALE SHALL essere lo stesso, dalla stessa
costante; e mezzo passo SHALL essere un numero INTERO di pixel.

Il box del comando in coda SHALL avere la stessa misura su entrambi i rami.

Le due famiglie di altezza SHALL restare DUE, e NON SHALL sovrapporsi. La tab SHALL
restare della misura del dito, e il soffitto SHALL uscire dal conto. Lo stile
dell'etichetta SHALL essere il tipo più il colore, e NON una seconda scala.

#### Scenario: mezzo passo di colonna
- **GIVEN** il passo di colonna dichiarato
- **THEN** la metà SHALL essere un numero intero di pixel

#### Scenario: due famiglie di altezza
- **GIVEN** l'altezza di riga e quella di card
- **THEN** SHALL restare distinte

### Requirement: TABOPEN-01 — Un permalink NON conia una pane: apre ciò che ESISTE

Il collegamento a una superficie SHALL nascere sull'origine del SERVER quando è
dichiarata, e su quella della pagina altrimenti. Un percorso di progetto NON SHALL
mai finire NUDO nella URL. Un bersaglio incoerente NON SHALL produrre un
collegamento: è il cancello della voce di menu.

Il bersaglio SHALL essere riconosciuto solo sulla PROPRIA origine, in forma
assoluta o relativa, e SHALL leggere anche gli alias storici — è un SOVRAINSIEME
del bersaglio dei soli task. Un'origine estranea, o spazzatura, SHALL valere
NIENTE, e chi chiama apre nel browser esterno.

Ogni tipo SHALL avere il proprio ramo, tutti su eventi che l'app già gestisce: la
chat porta il TOPIC e mai l'identificativo della pane; il terminale passa dalla
porta che guarda ENTRAMBE le superfici; il progetto apre o mette a fuoco la propria
finestra; il task delega al cassetto, che è già l'unico proprietario di quella
rotta. Una chiave vuota o un tipo ignoto SHALL AVVISARE e NON SHALL materializzare
niente.

**Un soggetto NON CONFERMATO NON SHALL MAI diventare una pane.** Un topic, un
progetto, una sessione di terminale che il server non conosce NON SHALL emettere
niente e NON SHALL rubare il fuoco; un file SHALL essere verificato sul PROGETTO
che lo ospita. Un SÌ SHALL essere ricordato, un NO NO: la domanda non si ripete a
ogni riasserzione.

**La guardia SHALL rifiutare il NOTO-CATTIVO, non ciò che non ha potuto
verificare.** Server irraggiungibile, risposta non riuscita, corpo illeggibile:
SHALL instradare LO STESSO e DIRLO. Un «non ho potuto chiedere» NON SHALL
sedimentarsi in cache come un sì, e il ritentativo NON SHALL applicarsi a un «non
esiste» — è una risposta, ripeterla non la cambia.

Un file o un confronto SHALL fare DUE salti, e il secondo SHALL aspettare la
finestra; una finestra che non si monta mai SHALL esaurire il ritentativo e
AVVISARE — e quell'avviso NON SHALL valere «non ho aperto niente», perché il primo
salto è già scattato. Senza il progetto ospite un file NON è indirizzabile.

L'intento di FUOCO NON SHALL essere armato per un bersaglio privo di
identificativo di pane deterministico. Una pane browser esiste già e va TROVATA,
non coniata: il fuoco lo dà lo store; se nessuna superficie la possiede ma
appartiene a un TASK SHALL essere aperto il task; senza superficie e senza indizio
SHALL essere AVVISATO; e un riquadro persistito che la contiene senza saperla
nominare NON SHALL produrre un falso allarme.

Il consumo della rotta dalla URL SHALL aprire il bersaglio e poi RIPULIRE la
rotta per SOSTITUZIONE, mai per aggiunta; una rotta illeggibile SHALL essere
consumata comunque, per non ripresentarsi; NON SHALL toccare gli alias; senza
permalink SHALL essere un non-fare; e SHALL restituire l'annullatore SOLO se ha
armato qualcosa. In una finestra STACCATA NON SHALL toccare la URL, NON SHALL
instradare e NON SHALL persistere niente: il collegamento va al browser esterno.

L'apertura dopo l'idratazione NON SHALL instradare NIENTE finché lo stato non è
arrivato; con l'idratazione già avvenuta SHALL aprire subito senza aspettare il
ripiego; un'idratazione che non arriva MAI SHALL comunque far scattare il ripiego
a tempo; e SHALL aprirsi UNA volta sola. Annullato NON SHALL aprire nemmeno quando
l'idratazione arriva.

#### Scenario: un topic che il server non conosce
- **GIVEN** un permalink verso un soggetto inesistente
- **THEN** NON SHALL essere emesso niente e NON SHALL nascere nessuna pane

#### Scenario: il server non risponde
- **GIVEN** la verifica del soggetto impossibile
- **THEN** SHALL essere instradato lo stesso, dichiarando che non si è potuto chiedere

### Requirement: MORPH-01 — Si animano solo le lettere NUOVE, dentro un BUDGET

Quando una frase viene riscritta SHALL essere animato SOLO il pezzo cambiato: il
prefisso e il suffisso in comune sono la parte che dice «è sempre lo stesso», e NON
SHALL muoversi.

Un testo identico NON SHALL avere niente da animare. Una coda aggiunta SHALL
animare solo la coda. Una parola cambiata in mezzo SHALL lasciare fermi i due capi.
Una riscrittura che ha solo TOLTO NON SHALL avere lettere da far entrare. Un testo
che compare per la PRIMA volta NON SHALL essere trattato come una riscrittura.

La durata SHALL essere un BUDGET: una parola e una riga intera SHALL costare lo
STESSO tempo, perché oltre una soglia il passo si stringe da sé. Senza questo, la
stessa animazione sarebbe elegante su una parola e interminabile su una frase.

La scomposizione in parole SHALL tenere le parole INTERE e trattare gli spazi come
pezzi a sé. Senza niente da spezzare SHALL uscire vuota.

#### Scenario: una parola cambiata in mezzo
- **GIVEN** due frasi che differiscono solo al centro
- **THEN** i due capi NON SHALL muoversi

#### Scenario: una riga intera
- **GIVEN** una riscrittura molto lunga
- **THEN** SHALL restare dentro lo stesso budget di tempo

### Requirement: TABREF-01 — Un permalink resta LEGGIBILE, e ciò che non lo è non diventa un link a metà

Un segmento SICURO SHALL restare in chiaro — il collegamento si legge a occhio —
e qualunque altra cosa SHALL essere codificata in una forma che NON contiene mai
un punto né una barra: sono i due caratteri che fanno leggere un percorso come
un'altra cosa.

Una codifica CORROTTA SHALL valere NIENTE, mai un'eccezione.

La costruzione e la lettura SHALL fare il giro completo per ogni tipo. Il tipo
pannello SHALL ammettere SOLO i tipi che si sanno davvero aprire. Il browser
SHALL portare il proprio contesto, con o senza gli indizi di proprietà. Un file e
un confronto SHALL portare SEMPRE il progetto ospite. Una chiave VUOTA NON SHALL
produrre un collegamento.

Gli alias storici SHALL restare LEGGIBILI, e tutto ciò che non è un permalink
SHALL valere NIENTE.

La lettura SHALL accettare sia un indirizzo assoluto sia un percorso nudo, la
query SHALL sopravvivere al giro attraverso un indirizzo intero, e la spazzatura
SHALL valere NIENTE.

Il collegamento SHALL essere costruito sull'origine dichiarata; NESSUN punto SHALL
comparire nel percorso nemmeno per un progetto che ha un'estensione nel nome; e un
bersaglio non costruibile SHALL valere NIENTE — non un indirizzo a metà.

La descrizione di un bersaglio SHALL dire il TIPO e la CHIAVE.

#### Scenario: un progetto con un punto nel nome
- **GIVEN** un percorso che contiene un'estensione
- **THEN** il collegamento NON SHALL contenere punti nel percorso

#### Scenario: una codifica corrotta
- **GIVEN** un segmento illeggibile
- **THEN** SHALL valere niente, senza sollevare

### Requirement: TABRES-01 — Risolvere un permalink DICE lo stato, non lo cambia, e non esplode mai

Un riferimento che la grammatica non riconosce SHALL valere NIENTE, non un
errore. SHALL essere accettato sia un percorso nudo sia un indirizzo assoluto, e
gli alias storici SHALL risolvere.

Per una CHAT: una pane viva al livello dell'app SHALL essere APERTA, col titolo
dell'ARGOMENTO; aperta dentro una finestra di progetto SHALL risolvere anche
quando non è una pane; una nella pila delle chiuse SHALL essere CHIUSA anche se
il record porta titolo e indirizzo; una lapide STANTÌA NON SHALL chiudere una
pane VIVA; solo lapidi SHALL valere chiusa; un argomento che esiste ma che
nessuna superficie mostra SHALL essere chiuso; uno ARCHIVIATO SHALL essere
archiviato anche con la tab aperta; e uno INESISTENTE SHALL essere sconosciuto —
col titolo NON inventato.

La cartella di lavoro SHALL seguire la copia di lavoro PRONTA, non il percorso
del progetto, e una funzione iniettata SHALL avere la precedenza sul ripiego.

Per un TERMINALE: una pane viva con elenco VUOTO SHALL restare aperta con un
titolo neutro; con l'elenco, titolo e cartella SHALL venire da lì; senza né pane
né elenco SHALL essere SCONOSCIUTO — «sconosciuto» e «non esiste» sono due
risposte diverse.

Per un BROWSER: dentro una finestra di progetto il titolo SHALL venire dal
contesto VIVO; la tab di un TASK SHALL avere la propria superficie; la presenza
nel riquadro di un task SHALL bastare anche senza inventario; una pane NATIVA
registrata senza istantanea SHALL essere viva lo stesso; nessuna traccia SHALL
essere sconosciuto, e il passo successivo SHALL essere dichiarato.

Per FILE e CONFRONTO: la pane SHALL essere trovata per PERCORSO e non per
identificativo; confronto e file SHALL essere DUE tab distinte sullo stesso
percorso; senza tab aperta SHALL essere CHIUSO e mai sconosciuto — il percorso è
il soggetto; e un percorso di progetto con un PUNTO SHALL sopravvivere al giro
completo.

Per un PROGETTO: finestra aperta SHALL dare titolo dal registro e il passo
successivo; progetto noto con finestra chiusa SHALL essere chiuso; percorso ignoto
SHALL essere sconosciuto.

Per un TASK: la forma storica SHALL continuare a risolvere; la cartella di un task
dispacciato SHALL essere la COPIA DI LAVORO del suo argomento; archiviato SHALL
essere archiviato, inesistente sconosciuto.

**L'esistenza SHALL essere ASIMMETRICA.** Una CARTELLA che sta sul disco SHALL
essere un soggetto valido — chiusa, NON sconosciuta — anche se nessuna tabella la
conosce; una cartella che NON esiste SHALL essere sconosciuta, ed è il caso che
chi chiama deve rifiutare; un FILE non è un progetto, solo una directory conta; un
progetto REGISTRATO SHALL restare noto anche se la cartella non è montata; e una
CHAT inventata SHALL continuare a essere rifiutata.

**Il perimetro della domanda al filesystem SHALL essere stretto**: SHALL passare
solo un percorso assoluto e GIÀ NORMALIZZATO, e una traversata NON SHALL MAI
diventare una domanda al disco.

La chiave di progetto NON SHALL essere presa per buona: una riga il cui compendio
non inverte su nessun percorso noto SHALL uscire dichiarata tale, e in una
collisione REALE il percorso che il collegamento porta con sé SHALL disambiguare.

**La risoluzione NON SHALL MAI SCRIVERE**: nessuna riga di stato SHALL cambiare —
né valore né contatore di revisione — dopo un numero qualunque di risoluzioni.

E SHALL DEGRADARE, non esplodere: un database privo di ogni tabella SHALL
rispondere lo stesso.

#### Scenario: una cartella sul disco che nessuna tabella conosce
- **GIVEN** un percorso esistente e non registrato
- **THEN** SHALL essere «chiuso», non «sconosciuto»

#### Scenario: dieci risoluzioni di fila
- **GIVEN** più chiamate consecutive
- **THEN** nessuna riga di stato SHALL cambiare

### Requirement: SPAFB-01 — Il guscio si serve alle NAVIGAZIONI, e non maschera un 404

Il guscio SHALL essere servito per un collegamento profondo alla bacheca e per un
percorso di navigazione nudo.

**Una rotta di interfaccia SCONOSCIUTA NON SHALL essere mascherata**: resta un
«non trovato», o ogni errore di indirizzo diventa una pagina bianca che sembra
funzionare. Lo stesso vale per un ARTEFATTO mancante — un percorso con
un'estensione — e per il canale del socket, che NON SHALL MAI essere il guscio.

I metodi che non LEGGONO NON SHALL MAI ricevere il guscio. Il metodo di sola
intestazione SHALL comportarsi come quello di lettura: stessa decisione su ogni
percorso.

Un cliente che NON dichiara di volere una pagina NON SHALL ricevere il guscio.

I permalink SHALL contare come navigazioni, compresi quelli con due segmenti
codificati; uno scritto A MANO che contiene un PUNTO SHALL ricevere comunque il
guscio — è un permalink, non un artefatto; e gli alias storici SHALL restare
navigazioni.

#### Scenario: una rotta di interfaccia sconosciuta
- **GIVEN** un percorso di interfaccia inesistente
- **THEN** SHALL restare «non trovato»

#### Scenario: un permalink con un punto nella chiave
- **GIVEN** un permalink scritto a mano
- **THEN** SHALL ricevere il guscio

### Requirement: STATIC-01 — Gli artefatti si classificano per FORMA, non per un elenco scritto a mano

Il caso che ha rotto l'installazione per un mese: un file di radice non era
nell'elenco di nomi scritto a mano, quindi rispondeva «non trovato» mentre il
documento principale lo caricava.

I file di RADICE che ci sono SHALL essere serviti, e un artefatto NUOVO alla
radice NON SHALL richiedere di aggiornare nessun elenco: la classificazione è per
FORMA.

Le cartelle degli artefatti SHALL essere servite anche IN PROFONDITÀ.

NON SHALL passare di qui: le rotte di interfaccia; una rotta di client senza
estensione, che resta al ripiego del guscio; un permalink, MAI — nemmeno con un
punto nella chiave; una traversata fuori dal pacchetto; e una cartella di secondo
livello non dichiarata.

Le cartelle con nomi versionati o stabili SHALL essere dichiarate IMMUTABILI,
mentre i file di RADICE NON SHALL essere fissati nella memoria del browser:
decidono cosa viene servito dopo, e fissarli congela il prossimo dispiegamento.

#### Scenario: un artefatto nuovo alla radice
- **GIVEN** un file aggiunto alla radice del pacchetto
- **THEN** SHALL essere servito senza toccare nessun elenco

#### Scenario: un permalink con un punto
- **GIVEN** una chiave che contiene un punto
- **THEN** NON SHALL essere trattato come artefatto

### Requirement: RAILGAP-01 — Una barra riservata DUE volte lascia una fascia vuota

«C'era però una riga extra a caso». Non era una riga: era l'altezza della barra
di chrome riservata DUE volte.

Fra i comandi del progetto e il contenuto NON SHALL restare una fascia vuota.

Da APERTA, fra il comando che apre e la prima voce SHALL passare UN passo solo.

Da APERTA il contenuto NON SHALL risalire SOTTO la barra di vetro: sparire sotto
una superficie traslucida è peggio che stare troppo in basso.

#### Scenario: la fascia sotto i comandi
- **GIVEN** i comandi di progetto e il contenuto
- **THEN** fra i due NON SHALL restare spazio vuoto

#### Scenario: la sezione aperta
- **GIVEN** una sezione espansa
- **THEN** il contenuto NON SHALL passare sotto la barra

### Requirement: AUTOH-01 — Le sezioni aperte si adattano al contenuto, fino a un tetto

Le sezioni aperte SHALL adattare la propria altezza al CONTENUTO, con un TETTO
proporzionale al numero di sezioni.

Con poco contenuto una sezione NON SHALL tenersi più spazio di quanto le serve.

Il tetto SHALL reggere: nessuna sezione SHALL schiacciarne un'altra fino a
farla sparire.

#### Scenario: una sezione con due righe
- **GIVEN** poco contenuto
- **THEN** NON SHALL occupare più dello spazio che le serve

#### Scenario: una sezione con molto contenuto
- **GIVEN** contenuto oltre il tetto
- **THEN** SHALL fermarsi al tetto, senza schiacciare le altre

### Requirement: PRAIL-01 — Chiusa, la colonna di progetto NON è una seconda superficie

CHIUSA era una guida verticale stretta con un bordo che scendeva per tutta la
finestra a contenere tre icone: una SECONDA superficie accanto alla riga di
chrome, con una tinta sua e un filo suo.

Chiusa, la barra SHALL essere una FILA DI CARD DENTRO la riga delle tab, non una
colonna a sé.

La riga chiusa SHALL avere il proprio bordo, e la sezione che si apre SHALL
aprirsi su QUALCOSA — non su un vuoto.

La barra SHALL ridimensionarsi dal bordo, e un doppio gesto SHALL riportarla al
valore predefinito.

In modalità FLUTTUANTE la maniglia SHALL restare trasparente, e i divisori veri
NO: una maniglia che si vede dove non c'è niente da dividere è rumore.

#### Scenario: la barra chiusa
- **GIVEN** la colonna collassata
- **THEN** SHALL essere una fila di card dentro la riga delle tab

#### Scenario: il doppio gesto sul bordo
- **GIVEN** una larghezza modificata
- **THEN** SHALL tornare al valore predefinito

### Requirement: PRESIZE-01 — Tirando un divisore cresce ciò che gli sta SOTTO, e la coppia è CONSERVATA

«Se provo a ridimensionare i processi verso l'alto non si ridimensiona, anzi si
sposta git.» Il difetto era esattamente quello: il gesto muoveva il vicino
sbagliato.

Tirando in ALTO un divisore SHALL crescere ciò che gli sta SOTTO; tirando in
BASSO SHALL succedere l'opposto.

**La coppia SHALL essere CONSERVATA**: la sezione che non partecipa al gesto NON
SHALL muoversi.

Al MINIMO ci si SHALL FERMARE: nessuno SHALL spingere fuori il vicino.

Contro la sezione di coda il fermo SHALL essere la sezione stessa: NON SHALL
essere possibile cancellarla tirando.

#### Scenario: tirare in alto il divisore
- **GIVEN** un divisore fra due sezioni
- **THEN** SHALL crescere quella sotto, e la terza NON SHALL muoversi

#### Scenario: tirare fino al minimo
- **GIVEN** una sezione già al minimo
- **THEN** il gesto SHALL fermarsi

### Requirement: SEAMLINE-01 — Fra colonna e contenuto c'è un FILO, non una sfumatura

Su schermo largo la colonna sta SOPRA il contenuto e proiettava un'ombra larga —
venticinque pixel di sfumatura stesi sul contenuto. Finché le due superfici
avevano tinte diverse quella sfumatura si leggeva come profondità; con tinte
vicine si legge come sporco.

Senza pane fluttuanti la colonna SHALL portare un FILO, non un'ombra.

#### Scenario: nessuna pane fluttuante
- **GIVEN** il riquadro normale
- **THEN** la giunzione SHALL essere un filo

### Requirement: HDRGAP-01 — Lo stacco sotto l'intestazione si misura fra due cose DIPINTE

«Sotto la barra della colonna sembra esserci una doppia spaziatura, forse perché
prima c'era il bordo sotto.» La diagnosi era esatta.

Lo stacco sotto l'intestazione della colonna SHALL essere misurato fra due
elementi DIPINTI, non fra due scatole: una scatola che non dipinge niente non è
il bordo che si vede, e misurarla dà un numero che non corrisponde all'occhio.

Lo stacco SHALL essere quello dichiarato a OGNI larghezza.

#### Scenario: più larghezze di finestra
- **GIVEN** una serie di larghezze
- **THEN** lo stacco misurato fra elementi dipinti SHALL essere sempre quello dichiarato

### Requirement: PINTILE-01 — Le tessere fissate stanno affiancate, e il click apre SOTTO la loro riga

Le tessere SHALL stare AFFIANCATE e non impilate, e NESSUNA intestazione SHALL
annunciarle: sono già riconoscibili.

Il gesto su una tessera SHALL aprire una fascia SOTTO la riga GIUSTA, non in
fondo alla sezione.

La disposizione a più righe SHALL sopravvivere a un ricaricamento, e uno stato
salvato SENZA disposizione NON SHALL rompere niente.

Togliere il fissaggio SHALL togliere la tessera lasciando le altre DOVE SONO.

La tessera SHALL portare la chiave che apre la propria pane, e quella di un
progetto SHALL portare il proprio riferimento.

Gli accordion SHALL stare su UNA sola colonna, senza spazio prima, e il comando
che apre NON SHALL spostare ciò che gli sta accanto — il centraggio NON SHALL
dipendere dal carattere.

#### Scenario: il gesto su una tessera della prima riga
- **GIVEN** più righe di tessere
- **THEN** la fascia SHALL aprirsi sotto quella riga

#### Scenario: uno stato salvato senza disposizione
- **GIVEN** uno stato di una versione precedente
- **THEN** NON SHALL rompersi niente

### Requirement: PINTILE-02 — Fissare, sfissare e riordinare: il gesto MOSTRA dove finisce

Trascinare un progetto sui fissati SHALL MOSTRARE dove finirà, e SHALL finirci.
Lasciare una tessera CHIUSA su un gruppo SHALL portarla DENTRO quel gruppo, e
lasciare una tab sui fissati SHALL fissarla.

Riordinare dentro una riga SHALL mostrare dove la tessera andrà, in entrambi i
versi, e le celle SHALL attraversare lo spazio invece di saltare. Chi ha chiesto
MENO movimento NON SHALL riceverlo.

Spostare una tessera su un'altra riga SHALL mostrarlo sulla riga di PARTENZA —
che quella tessera se ne sta andando — e lasciarla nello SPAZIO fra due righe
SHALL aprirne una nuova.

Trascinare una tessera sulla lista SHALL SFISSARLA, mostrando dove finirà; dentro
il blocco dei fissati il rilascio SHALL restare un RIORDINO e non uno sfissaggio.

Sfissare trascinando NON SHALL ARCHIVIARE: la riga SHALL restare nella lista, e
il giro completo SHALL potersi rifare.

#### Scenario: rilascio dentro il blocco dei fissati
- **GIVEN** una tessera trascinata su un'altra tessera
- **THEN** SHALL essere un riordino, non uno sfissaggio

#### Scenario: sfissare trascinando
- **GIVEN** una tessera portata sulla lista
- **THEN** la riga SHALL restare nella lista, non archiviata

### Requirement: PINTILE-03 — Una tessera dice cosa fa, ci sta dentro, e la bacheca è una di loro

Il segno di apertura SHALL stare accanto al titolo, e a zero tab NON SHALL
esserci. Il comando che crea una tab SHALL stare dal bordo quanto ogni altro
comando, e respirare quanto la sua riga.

Icona e titolo SHALL stare DENTRO la tessera in ogni sua forma; quando la tessera
diventa un QUADRATO il titolo SHALL andarsene e NIENTE SHALL dipingersi fuori;
da quadrata SHALL centrare ciò che le resta; e al ricaricamento il titolo NON
SHALL lampeggiare prima dell'assestamento.

Senza colore la cornice SHALL esserci comunque, e chiusa SHALL comportarsi come
dichiarato.

La riga della BACHECA e il filo divisore SHALL stare sulla STESSA colonna delle
altre. La bacheca SHALL potersi fissare, diventare tessera e mostrare i task PER
STATO; la sua riga SHALL dire QUANTI task e in QUALE colonna, senza aprire
niente.

Bacheca, righe di tessere e separatore SHALL stare a UNA sola distanza fra loro.

#### Scenario: una tessera ridotta a quadrato
- **GIVEN** la tessera alla misura minima
- **THEN** il titolo SHALL sparire e niente SHALL dipingersi fuori

#### Scenario: la riga della bacheca
- **GIVEN** la bacheca fra i fissati
- **THEN** SHALL dire quanti task e in quale colonna

### Requirement: ROWALIGN-01 — Le righe della colonna partono dalla STESSA x

Segnalato: le rotte dovevano essere allineate, e i progetti dovevano avere
un'icona come le chat.

Il nome di un progetto SENZA icona SHALL partire dalla STESSA coordinata
orizzontale di uno che ce l'ha: una riga che parte più a sinistra perché le manca
un'icona fa sembrare storta tutta la colonna, senza che nessuna riga sia
sbagliata.

#### Scenario: un progetto senza icona
- **GIVEN** due progetti, uno con icona e uno senza
- **THEN** i due nomi SHALL partire dalla stessa x

### Requirement: PINALIGN-01 — Il blocco dei fissati ha UN allineamento per forma, e nessuno spinto a destra

Segnalato il 27/08/2026: le tessere fissate sembrano spostate a destra quando
alla sidebar avanza larghezza, e impilate in colonna non si leggono centrate.

La forma e l'allineamento SHALL essere la STESSA decisione: una tessera sola
sulla sua riga è una RIGA e SHALL partire dalla stessa x delle righe normali
della colonna; due o più sulla stessa riga sono una GRIGLIA e SHALL centrare ciò
che le identifica. Nessuna soglia di larghezza SHALL decidere un terzo
allineamento.

Il blocco SHALL avere margine sinistro e destro UGUALI dentro la sidebar, a ogni
larghezza e in ogni forma, e dentro una tessera l'aria a sinistra NON SHALL
superare quella a destra.

#### Scenario: una tessera sola, a tre larghezze di sidebar
- **GIVEN** una tessera fissata e le righe normali della colonna
- **THEN** l'inchiostro della tessera SHALL partire dalla x delle righe

#### Scenario: tessere impilate in colonna
- **GIVEN** più tessere, una per riga
- **THEN** i margini sinistro e destro del blocco SHALL coincidere entro 1px

### Requirement: HEADPAR-01 — Il metodo di sola intestazione risponde come quello di lettura

Misurato l'11/08 sul server vivo: una richiesta di sola intestazione su un
artefatto non rispondeva come la lettura corrispondente.

Il guscio e un artefatto con nome versionato SHALL avere PARITÀ fra i due
metodi. Una navigazione di client SHALL rispondere alla sola intestazione come
alla lettura.

**La sola intestazione NON SHALL inventare un successo**: un artefatto
inesistente SHALL restare «non trovato», come sulla lettura.

#### Scenario: un artefatto inesistente
- **GIVEN** una richiesta di sola intestazione
- **THEN** SHALL restare «non trovato»

#### Scenario: il guscio
- **GIVEN** le due richieste
- **THEN** SHALL rispondere con le stesse intestazioni, senza corpo

### Requirement: PENDSYNC-01 — La colonna e la barra vedono la STESSA azione in sospeso

Una conferma avviata dalla colonna SHALL essere vista dalla barra, e una avviata
dalla barra SHALL essere vista dalla colonna: se divergessero, lo stesso gesto
sembrerebbe in corso da una parte e mai iniziato dall'altra.

Per un ARGOMENTO SHALL contare sia la chiave dell'archiviazione sia quella della
chiusura della tab; quando entrambe sono in coda SHALL vincere
l'ARCHIVIAZIONE, che è l'intento più forte. Un argomento GIÀ archiviato NON SHALL
proporre l'archiviazione, perché il gesto inverso è immediato.

Per un TERMINALE e per un BROWSER SHALL contare le rispettive due chiavi, e SHALL
vincere quella della colonna.

Le chiavi di UN soggetto NON SHALL essere raccolte da un altro.

La risoluzione per TIPO di pane SHALL essere dichiarata: la chat porta chiusura e
archiviazione, il terminale chiusura e chiusura sessione, il browser chiusura e
chiusura contesto, e i tipi senza gesto proprio solo la chiusura. Fra le due
SHALL vincere quella della barra.

#### Scenario: entrambe le chiavi in coda su un argomento
- **GIVEN** archiviazione e chiusura tab
- **THEN** SHALL vincere l'archiviazione

#### Scenario: un argomento già archiviato
- **GIVEN** lo stato archiviato
- **THEN** NON SHALL essere proposta l'archiviazione

### Requirement: LAYOUT-28 — Chiudere e riaprire la sidebar non SCOPRE una banda che nessuno dipinge

Lo scorrimento della sidebar SHALL essere animato con una trasformata, non
animando il padding: il padding e' una proprieta' di LAYOUT, e cambiarla a ogni
frame ristringe la larghezza del contenuto, che a cascata rifa' il layout di
ogni terminale visibile. Il rimedio storico — far scattare il padding di colpo
quando ci sono molti terminali — spegneva l'animazione proprio sotto carico,
cioe' curava il sintomo togliendo la cosa.

Il layer spostato dalla trasformata SHALL essere ALLARGATO dello stesso
spostamento mentre scorre. Il layer e' un figlio flex: committare il padding lo
stringe, quindi la trasformata scopre una striscia larga quanto lo spostamento —
la «banda grigia» segnalata riaprendo la sidebar. Una trasformata non puo'
dipingere cio' che non e' dentro la scatola.

La larghezza aggiunta SHALL essere azzerata PRIMA della misura successiva: un
ciclo rapido chiudi-riapri misurerebbe altrimenti un layer che indossa ancora
l'extra del giro precedente, e l'errore si accumulerebbe a ogni giro.

Un RIDIMENSIONAMENTO della sidebar — larghezza diversa, stato aperto invariato —
SHALL assestarsi subito e NON SHALL essere animato: arriva come un solo commit a
fine trascinamento, e animarlo farebbe scivolare la pagina duecento millisecondi
dopo che la maniglia e' stata rilasciata.

Una nuova commutazione SHALL annullare quella in volo: senza, il frame della
precedente atterra dopo che la nuova ha gia' ri-misurato, e il layer resta
spostato di una quantita' che non corrisponde a nessuno stato.

#### Scenario: si riapre la sidebar
- **GIVEN** la sidebar chiusa e un layer allineato al padding del contenuto
- **WHEN** la sidebar si riapre
- **THEN** il layer SHALL essere spostato della differenza misurata
- **AND** SHALL essere allargato della stessa quantita'

#### Scenario: due cicli di fila
- **GIVEN** una riapertura che ha allargato il layer
- **WHEN** si richiude
- **THEN** la larghezza aggiunta SHALL essere tornata a zero

#### Scenario: si trascina la maniglia
- **GIVEN** la sidebar aperta
- **WHEN** cambia solo la sua larghezza
- **THEN** non SHALL esserci nessuna trasformata da animare

### Requirement: WINCTL-01 — I comandi finestra escono dallo STESSO posto sui due sistemi

Su Windows la barra del titolo di sistema e' spenta e la app disegna la propria,
quindi senza comandi propri una finestra non si potrebbe piu' minimizzare,
massimizzare o chiudere se non dalla barra delle applicazioni. Quei tre comandi
SHALL uscire dal bottone «Topics», che e' dove il Mac fa uscire le sue tre
pastiglie (`trafficLightPosition` { x: 12, y: 12 }, con la parola «Topics» che
diventa invisibile quando il menu si apre). Stavano in fondo alla stessa riga,
dopo «Cerca» e «+»: la stessa app chiudeva la finestra a sinistra su un sistema
e a destra sull'altro, e chi passa dall'uno all'altro doveva reimpararlo.

L'ORDINE SHALL essere quello del Mac — chiudi, minimizza, massimizza — e non
quello di Windows 11. Ancora e ordine sono una decisione sola: tenere l'ordine
di Windows sotto l'ancora del Mac metterebbe la chiusura esattamente dove sul
Mac si minimizza, cioe' sotto il puntatore di chi conosce l'altro sistema.

I tre comandi SHALL essere FUORI DAL FLUSSO della riga. La riga del chrome e'
`h-10` e deriva la propria altezza dai propri bottoni: in flusso, i tre comandi
possono alzarla, spostare il titolo, oppure — misurato — riservare la propria
larghezza da SPENTI e spingere la campanella sotto al gruppo `z-50`, rendendola
non cliccabile. Fuori dal flusso non riservano niente, accesi o spenti.

Su macOS e sul web il componente NON SHALL montare niente: li' la cornice esiste
gia' (sul Mac sono le tre pastiglie che Tauri dipinge sopra la nostra riga con
`TitleBarStyle::Overlay`), e un secondo gruppo sarebbe lo stesso errore
speculare.

#### Scenario: si apre il menu Topics su Windows
- **GIVEN** il guscio Tauri su Windows
- **WHEN** il menu «Topics» si apre
- **THEN** i tre comandi SHALL comparire sopra il bottone
- **AND** SHALL essere nell'ordine chiudi, minimizza, massimizza

#### Scenario: la riga non cambia altezza
- **GIVEN** la riga del chrome alta `h-10`
- **WHEN** i comandi passano da spenti ad accesi
- **THEN** l'altezza della riga NON SHALL cambiare
- **AND** nessun altro elemento della riga SHALL spostarsi

FRA I DUE GRUPPI CI SHALL essere respiro, e la misura SHALL essere dichiarata,
non ereditata da un font. I tre comandi sono assoluti, quindi non riservano
niente: lo spazio fra loro e il chevron del bottone «Topics» era quello che
avanzava dalla parola sotto, e la parola e' nel font di SISTEMA. Su Windows 11
(Segoe UI) avanzavano due o tre pixel e i due gruppi si leggevano come uno solo.
L'etichetta SHALL quindi portare una larghezza minima calcolata dall'ancora e
dalla dimensione delle celle, tale da lasciare almeno 12px — due volte
`ROW_INSET` — fra il bordo destro del gruppo e il bordo sinistro del chevron.

Quella larghezza SHALL valere nei DUE stati del menu, aperto e chiuso: riservarla
solo a comandi accesi sposterebbe il chevron nell'istante in cui il menu si apre,
cioe' sotto il puntatore che l'ha appena cliccato.

#### Scenario: i due gruppi non si toccano
- **GIVEN** il guscio Tauri su Windows, col menu «Topics» aperto
- **WHEN** si misura fra il gruppo dei comandi e il chevron del bottone
- **THEN** la distanza SHALL essere di almeno 12px

### Requirement: WINMENU-01 — Su Windows la finestra NON SHALL avere una barra dei menu

Il menu nativo (Topics / Edit / View / Window / Help) su macOS e' la striscia in
cima allo SCHERMO e li' SHALL restare: senza, un guscio WKWebView non ha ne'
Cmd+C/V/X/A/Z ne' Reload. Su Windows lo stesso menu e' una riga dentro la
FINESTRA, subito sopra il chrome che la app disegna da se' (la cornice di sistema
e' spenta, `set_decorations(false)`): e' una seconda barra in una finestra che ne
ha gia' una propria. Non compra nemmeno le scorciatoie, perche' nel message loop
non chiama nessuno `TranslateAcceleratorW` — a farle funzionare e' il gancio
`menu_chords_win` — e ogni voce che elenca e' raggiungibile dalla app.

Il menu su Windows NON SHALL essere costruito affatto: non nascosto. Un
`hide_menu()` lascia il menu attaccato alla finestra, quindi un `set_menu` o uno
`show_menu` successivo, o una finestra creata dopo che eredita il menu di app,
riportano la riga. Un menu che non esiste non puo' tornare da solo.

Nella finestra NON SHALL comparire nessuna riga di menu: nemmeno una riga vuota
alta zero.

#### Scenario: si apre la finestra su Windows
- **GIVEN** il guscio Tauri su Windows
- **WHEN** la finestra principale si mostra
- **THEN** NON SHALL esistere nessuna barra dei menu nella finestra

#### Scenario: le scorciatoie del menu continuano a funzionare
- **GIVEN** la finestra su Windows senza menu
- **WHEN** si preme Ctrl+R, Ctrl+0, Ctrl+= o Ctrl+-
- **THEN** l'azione SHALL partire lo stesso, dal gancio delle scorciatoie

#### Scenario: sul Mac non montano
- **GIVEN** il guscio Tauri su macOS
- **WHEN** il menu «Topics» si apre
- **THEN** il componente NON SHALL rendere nessun bottone

### Requirement: LAYOUT-29 — Lo schema dello split sta su OGNI voce della sidebar che rappresenta una pane aperta

Lo schema proporzionale che dice in quale cella della griglia sta una pane
(`SplitMiniMap`) era scritto tre volte in tre righe diverse: chat, terminale e
progetto. Le altre voci della colonna non lo avevano. Misurato: un browser
aperto in una cella, una pane di utilità e la riga della bacheca non dicevano
niente sulla propria posizione mentre la riga accanto lo diceva, e la copia del
progetto aveva un margine in coda (`mr-1.5`) che le sorelle non avevano.

Ogni voce della sidebar che rappresenta una pane aperta SHALL mostrare lo schema
quando la griglia è divisa: riga di chat, terminale, browser, utilità, bacheca,
progetto e tessera fissata in forma di RIGA.

In forma di GRIGLIA la tessera fissata NON SHALL mostrarlo: lì la tessera porta
solo l'identità su 40-100px di larghezza, ed è la stessa regola che già toglie
la subline, il tempo e il nome del progetto.

Con UNA sola cella nessuna voce SHALL mostrarlo: non c'è niente rispetto a cui
orientarsi.

La decisione — sorgente, tono e posto nella riga — SHALL stare in UN solo
componente: una seconda copia è ciò che ha prodotto il margine divergente della
riga di progetto.

#### Scenario: due celle, una chat fissata e una in lista
- **GIVEN** due pane aperte in due celle affiancate
- **THEN** la riga in lista SHALL mostrare lo schema
- **AND** la tessera fissata in forma di riga SHALL mostrarlo

#### Scenario: una cella sola
- **GIVEN** una griglia non divisa
- **THEN** nessuna voce della sidebar SHALL mostrare lo schema

### Requirement: CHROME-10 — Un'attesa che non finirà da sola SHALL dire perché, e nominare la via d'uscita

Il guscio nativo può decidere deliberatamente di NON avviare un server locale:
quando il marcatore dice che questa macchina possiede un server vero e nessuno
risponde, aspettare è giusto — biforcare un universo vuoto sopra un server lento
ma vivo è il guasto peggiore, ed è già costato task e schede una volta.

Quella scelta SHALL restare. Ciò che NON è ammesso è che sia MUTA.

Misurato il 28/08/2026 su Windows: l'unica cosa a schermo era il pallino rosso
della fascia di stato. La spiegazione del guscio viveva sulla pagina che il proxy
serve al posto di una navigazione di DOCUMENTO, ma la finestra carica il proprio
bundle dallo schema dell'app e a quella pagina non ci arriva nessuno. L'attesa
era totale, muta, e la via d'uscita era un file che nessuno nomina.

Quando il guscio è in quello stato, la fascia di stato SHALL mostrare la causa e
il PERCORSO COMPLETO del file che la rimuove. Il percorso SHALL andare a capo ed
essere selezionabile: un percorso che non si può leggere né copiare non è una via
d'uscita.

Il verdetto SHALL venire dal guscio, non dal server: il server è precisamente ciò
che manca. E SHALL comparire SOLO su quel verdetto esplicito — una disconnessione
ordinaria resta il pallino e basta, o l'avviso diventa rumore che si impara a
ignorare.

#### Scenario: la macchina possiede un server che oggi non c'è
- **GIVEN** il marcatore presente e nessun server che risponde
- **THEN** la fascia di stato SHALL portare la causa e il percorso del marcatore

#### Scenario: una disconnessione qualunque
- **GIVEN** nessun marcatore, e il server semplicemente non risponde adesso
- **THEN** la fascia SHALL mostrare solo lo stato, senza alcun avviso aggiuntivo

Nominare la via d'uscita era la prima metà. La seconda: l'avviso SHALL offrire un
comando che la PERCORRE — il guscio elimina il marcatore e si rilancia — perché
«chiudi l'app, apri il gestore file, entra in AppData, cancella questo file,
riapri» è una via d'uscita solo sulla carta, e viene chiesta proprio sulla
macchina dove la cosa che non funziona è l'app. Il percorso SHALL restare stampato
sopra il comando: un guscio troppo vecchio per quel comando ha ancora solo quello.

Il comando SHALL essere subordinato al VERDETTO DI AVVIO del guscio, non a un
argomento che sceglie chi chiama: su un avvio sano non tocca niente. È reversibile
per costruzione — il marcatore viene riscritto appena un server vero risponde di
nuovo — quindi il caso peggiore di un click sbagliato è un rilancio che avvia un
server locale.

La spiegazione SHALL comparire mentre l'attesa e' in corso, non alla sua fine.
Misurato due volte il 28/08/2026 su Windows, col cronometro avviato dentro la
sessione utente: il giro di sonde impiega 141 e 142 secondi a concludere, non i
«~42s» che il messaggio calcola assumendo rifiuti istantanei, e per tutto quel
tempo a schermo c'era solo il pallino rosso. Nulla nella frase dipende pero' dal
verdetto: il marcatore esiste gia' all'avvio, e «questa macchina ha un marcatore
e sto aspettando la porta» e' vero dal primo tentativo fallito. Il verdetto
decide se AVVIARE un server, non se la frase e' vera.

Di conseguenza il fatto SHALL essere RITRATTABILE: se il server risponde a un
giro qualunque, il guscio lo ritira, cosi' una disconnessione ordinaria piu'
tardi non mostra una frase che offre di eliminare un marcatore che sta facendo il
suo lavoro.

#### Scenario: la macchina possiede un server lento
- **GIVEN** il marcatore presente e la spiegazione gia' pubblicata durante l'attesa
- **WHEN** il server risponde prima della fine del giro di sonde
- **THEN** il guscio SHALL ritirare la spiegazione, e una disconnessione
  successiva SHALL mostrare solo lo stato

#### Scenario: la via d'uscita si percorre da lì
- **GIVEN** la fascia mostra l'avviso perché questo avvio è quello degradato
- **WHEN** si usa il comando offerto dall'avviso
- **THEN** il marcatore SHALL essere eliminato e il guscio SHALL rilanciarsi

#### Scenario: lo stesso comando su un avvio sano
- **GIVEN** un avvio in cui il guscio NON ha concluso lo stato degradato
- **THEN** il comando SHALL non eliminare niente e non rilanciare

### Requirement: DNDSPLIT-01 — La tabella dei casi: sorgente x destinazione x albero atteso

Il trascinamento di una scheda vive oggi in piu' posti — la barra delle schede di
una pane, la griglia dei pannelli, i divisori, la sidebar — e ogni posto aveva
imparato le sue regole per conto suo. Questo requisito e' la MAPPA: l'elenco
numerato dei casi, cosi' che «tutti i comportamenti» sia una lista che si conta e
non un aggettivo.

Ci sono DUE superfici affiancate, e la regola generale e' che si comportino allo
stesso modo dove la domanda e' la stessa:

- **STD** — la griglia della finestra autonoma (`PanelGrid`), con i divisori di
  inserimento fra celle (`InsertDividers`);
- **PRJ** — la griglia dentro un progetto (`GroupLayout`), che disegna gruppi.

Entrambe rendono attraverso `SplitTree`. L'esito di ogni caso SHALL essere
verificato sull'ALBERO del risultato — quante foglie, con quale contenuto, sotto
quale asse di split — e non sull'aspetto: l'albero SHALL essere leggibile dal DOM
tramite `[data-split-surface]`, `[data-split-node]` (l'asse: `row` o `col`) e
`[data-split-leaf]` (l'identita' della foglia).

**La tabella.** Sorgente: una scheda trascinata dalla sua barra, salvo dove detto.

| # | Sorgente | Destinazione | Esito atteso sull'albero |
|---|---|---|---|
| 1 | scheda | altra posizione della PROPRIA barra | stesse foglie, stesso albero; cambia solo l'ordine dentro la foglia |
| 2 | scheda | barra di un'ALTRA pane, stessa superficie | la scheda lascia la foglia d'origine ed entra in quella di arrivo all'indice puntato; nessuna foglia nuova |
| 3 | scheda | fascia di bordo sinistro/destro del corpo di una pane | nasce una foglia accanto: split `row` di arieta' +1 |
| 4 | scheda | fascia di bordo alto/basso del corpo di una pane | nasce una foglia sopra/sotto la SOLA colonna puntata: split `col` di arieta' +1 |
| 5 | scheda | centro del corpo di una pane | nessuna foglia nuova: la scheda si unisce al gruppo di quella foglia |
| 6 | scheda | divisore fra due celle | la scheda entra come foglia FRA le due, sull'asse di quel divisore |
| 7 | scheda | striscia a tutta larghezza (estremo alto/basso) | nasce una riga che copre TUTTE le colonne: arieta' +1 sullo split radice `col` |
| 8 | scheda | area vuota della griglia | la scheda si apre nella griglia; nessuna foglia perduta |
| 9 | scheda | fuori dalla finestra | la pane si stacca; la superficie d'origine resta coerente (nessuna foglia vuota) |
| 10 | scheda di un progetto | qualunque bersaglio di UN'ALTRA superficie | rifiutata: nessun disegno di anteprima, nessun cambio d'albero da nessuna delle due parti |
| 11 | riga della sidebar | corpo di una pane | l'argomento si apre e si unisce a quella foglia |
| 12 | tessera fissata | griglia | come 11 |

Il numero del caso vale su ENTRAMBE le superfici: `STD-3` e `PRJ-3` sono la
stessa domanda posta due volte, e SHALL avere lo stesso esito.

**La regola che tiene insieme la tabella**: un gesto OFFERTO SHALL riuscire, e un
gesto che sara' rifiutato SHALL non essere offerto. In termini di eventi: se il
`dragover` di un bersaglio disegna l'anteprima, il `drop` sullo stesso bersaglio
SHALL produrre il cambio d'albero promesso. La condizione «si puo' splittare?»
SHALL essere UNA sola funzione (`splitRules.ts`), interrogata sia dai menu sia
dai percorsi di trascinamento.

#### Scenario: l'albero e' leggibile dal DOM
- **GIVEN** una superficie di tiling qualunque disegnata
- **THEN** ogni nodo di split SHALL portare `data-split-node` con il suo asse e
  `data-split-arity` con il numero di figli, e ogni foglia `data-split-leaf` con
  la sua identita'

#### Scenario: anteprima e esito non divergono
- **GIVEN** un bersaglio che durante il `dragover` accende la sua anteprima
- **WHEN** la scheda viene rilasciata su quel bersaglio
- **THEN** l'albero SHALL cambiare come l'anteprima prometteva

### Requirement: DNDSPLIT-02 — Dentro un progetto lo split parte anche da UNA sola pane

Il guasto segnalato. Un progetto si apre con un gruppo solo, che contiene una
pane sola: e' la prima cosa che chiunque vede. Trascinando quella scheda sulla
fascia di bordo del proprio corpo, l'anteprima si accendeva e il rilascio non
faceva niente — perche' il gestore del drop rifiutava di sua iniziativa ogni
rilascio in cui il gruppo di partenza aveva una pane sola, mentre il MENU offriva
lo stesso split e `handleSplitGroup` lo sapeva gia' eseguire (crea una bozza
compagna nel gruppo d'origine, come fa la superficie autonoma).

Il rifiuto SHALL essere tolto: la domanda «questo rilascio deve splittare?» SHALL
essere posta a `splitRules.canDropSplit`, che per un rilascio sul PROPRIO gruppo
risponde esattamente quello che `canSplitPane` risponde al menu. Un rilascio su
un ALTRO gruppo SHALL sempre splittare, qualunque cosa contenesse il gruppo di
partenza.

Resta rifiutato UN solo caso, ed e' rifiutato perche' non cambierebbe niente: il
rilascio a tutta larghezza dell'unica pane dell'unico gruppo, che finirebbe in
una riga nuova mentre il suo gruppo svuotato viene tolto — lo stesso albero,
ridisegnato. Quel bersaglio SHALL quindi non accendersi affatto.

#### Scenario: progetto con una pane sola, split sul bordo
- **GIVEN** un progetto con un gruppo che contiene una pane
- **WHEN** la sua scheda viene rilasciata sulla fascia di bordo destro del corpo
- **THEN** l'albero SHALL avere due foglie sotto uno split `row`, e il gruppo
  d'origine SHALL conservare una pane visibile (una bozza compagna)

#### Scenario: il gesto a tutta larghezza che non cambierebbe niente
- **GIVEN** lo stesso progetto con un gruppo e una pane
- **WHEN** la scheda passa sopra la striscia a tutta larghezza
- **THEN** la striscia SHALL non accendersi, e il rilascio SHALL non cambiare l'albero

### Requirement: LAYOUT-30 — L'aria a sinistra del nome di una riga si paga UNA VOLTA, non una per colonna riservata

La sidebar riserva due colonne che molte righe lasciano vuote: quella
dell'accordion (LAYOUT-26) e quella del glifo di testa (LAYOUT-27). Una chat non
disegna ne' l'uno ne' l'altro, ed e' la famiglia di righe piu' numerosa.

`ROW_GAP` e' l'aria fra due PEZZI che devono respirare. Pagarla intera attorno a
una scatola che non contiene niente la trasforma in rientro: sommata al rientro,
al padding della riga e alle due scatole, portava la prima lettera a 60px dal
bordo, misurati nel DOM vivo con un rect di `Range` sul nodo di testo.

Una riga della sidebar SHALL quindi far cominciare l'inchiostro del nome entro
`SIDEBAR_LABEL_GUTTER_MAX` dal bordo della sidebar, alla profondita' zero. Le
colonne riservate SHALL chiudersi verso destra di META' gap e non di tutto: dove
le due scatole disegnano davvero qualcosa — un progetto mostra chevron e poi
favicon — a gap zero i due inchiostri arriverebbero a 2px e si leggerebbero come
uno solo.

Il rientro per profondita' NON e' compreso in questo tetto: e' una differenza
VOLUTA, ed e' il modo in cui si legge la gerarchia. `SIDEBAR_INDENT_STEP` SHALL
restare vivo e maggiore di zero.

#### Scenario: la prima lettera alla profondita' zero
- **GIVEN** la sidebar aperta con almeno una riga di chat alla profondita' zero
- **WHEN** si misura la distanza fra il bordo sinistro della sidebar e il primo
  inchiostro del nome, con un rect di `Range` sul nodo di testo
- **THEN** quella distanza SHALL essere entro `SIDEBAR_LABEL_GUTTER_MAX`

#### Scenario: la gerarchia si legge ancora
- **GIVEN** due righe a profondita' diverse
- **WHEN** si confrontano le due partenze del nome
- **THEN** la differenza SHALL essere almeno `SIDEBAR_INDENT_STEP`, cioe' il
  tetto sul rientro costante SHALL non aver spianato l'albero

### Requirement: LAYOUT-31 — Chiudere una vista di progetto la chiude anche dopo un ricaricamento

Le viste SINGLETON di una finestra di progetto (bacheca, git, file, processi,
cruscotto, attivita') SHALL lasciare una LAPIDE quando vengono chiuse, come gia'
fanno terminali e browser.

Non e' una precauzione: l'istantanea `nonChatPanes` sopravvive a una chiusura
che si consuma allo scaricamento della pagina — dove l'effetto di persistenza di
React non gira piu' per toglierla — e l'idratazione del progetto e' una UNIONE.
Senza lapide la tab tornava al ricaricamento successivo. Il buco restava
nascosto perche' l'unione salta gia' una vista remota il cui genere il client
tiene ancora: si vedeva solo chiudendo l'ULTIMA del suo genere, cioe' esattamente
il gesto di una persona.

La lapide SHALL essere per PROGETTO e per GENERE: una vista singleton nasce con
un uuid casuale, quindi l'id non puo' essere la chiave, e sbagliarla
chiuderebbe la bacheca di tutti i progetti insieme.

Riaprire la vista SHALL togliere la lapide, da OGNI porta di apertura: una
lapide che sopravvive al clic successivo trasforma «chiusa» in «sparita».

#### Scenario: la bacheca chiusa e la pagina ricaricata
- **GIVEN** la bacheca di un progetto chiusa
- **WHEN** la pagina viene ricaricata
- **THEN** la bacheca NON SHALL ricomparire

#### Scenario: un altro progetto
- **GIVEN** la bacheca chiusa in un progetto
- **THEN** la bacheca di un ALTRO progetto SHALL restare aperta

#### Scenario: riaprirla
- **GIVEN** una vista chiusa e poi riaperta dal menu
- **THEN** SHALL restare aperta anche dopo un ricaricamento

### Requirement: LAYOUT-32 — Accendere i pannelli fluttuanti SHALL cambiare i vuoti, non il fondo della finestra

I pannelli fluttuanti staccano gli split in schede con un vuoto fra loro. Su
macOS il guscio diventa trasparente di proposito: la vibrancy per-regione
dipinge dietro le schede, quindi nei vuoti si vede il desktop. Su Windows quella
vibrancy non esiste — i backdrop DWM sono per FINESTRA e non hanno un
equivalente per-regione — e togliere lo sfondo al guscio non apre i vuoti: fa
cadere l'intera finestra sulla sfocatura del desktop.

Quindi il fondo del guscio SHALL restare quello che era quando la preferenza si
accende, su ogni piattaforma priva di vibrancy per-regione; e SHALL diventare
trasparente dove quella vibrancy c'è. Una preferenza di disposizione non sposta
il terreno.

#### Scenario: su Windows il fondo non si muove
- **GIVEN** il guscio con la classe di piattaforma `windows-acrylic`
- **WHEN** si accende `floating-splits`
- **THEN** il `background-color` calcolato del guscio è identico a prima
- **AND** i vuoti fra le schede restano smerigliati, non trasparenti

#### Scenario: su macOS il fondo diventa trasparente
- **GIVEN** il guscio con la classe di piattaforma `tauri-mac` o `electron-mac`
- **WHEN** si accende `floating-splits`
- **THEN** il `background-color` calcolato del guscio è completamente trasparente
- **AND** i vuoti mostrano la vibrancy nativa
