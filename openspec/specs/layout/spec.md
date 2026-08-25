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

### Requirement: CHROME-01 — Le righe di chrome NON dipingono: la continuità è il vetro

Le righe di chrome NON SHALL dipingere uno sfondo proprio: fra contenuto e barre
ci deve essere CONTINUITÀ, e uno sfondo proprio produce un gradino visibile —
misurato su entrambi i temi e su entrambi i gusci, fino a quattordici livelli di
differenza.

La tinta SHALL venire dalla superficie SOTTO, attraverso la sfocatura.

Sotto il guscio nativo SHALL dipingere UNA SOLA superficie — il guscio della
finestra — e NESSUNA riga, né la prima né quella annidata.

La barra delle schede SHALL essere FUORI dal flusso, e la conversazione SHALL
cominciare SOTTO di lei: il varco in cima SHALL valere ESATTAMENTE l'altezza della
barra, e scorrendo i messaggi SHALL passare davvero dietro. Risalendo in cima, il
primo messaggio SHALL fermarsi al fondo della barra.

#### Scenario: una riga di chrome
- **GIVEN** una qualunque riga di chrome, in entrambi i temi
- **THEN** NON SHALL avere uno sfondo opaco proprio

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
