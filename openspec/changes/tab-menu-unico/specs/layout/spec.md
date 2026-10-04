# Spec delta: tab-menu-unico (layout)

## ADDED Requirements

### Requirement: TABSHEET-01 — Una tab ha UNA superficie di comandi, ed è la tab che si espande

Ogni tab di una barra di tab SHALL avere una sola superficie di comandi: il
**foglio della tab**. Il tasto destro, la pressione lunga col dito, Shift+F10 e il
tasto menu su una tab SHALL aprire il foglio di quella tab. Nessuna tab della
barra SHALL aprire un menu a tendina o un menu al cursore.

**La forma.** Mentre il foglio è aperto la tab e il foglio SHALL essere una sola
superficie: la tab SHALL essere dipinta con lo stesso fondo del foglio e portare
`data-sheet-open`, il foglio SHALL partire dal bordo inferiore della tab, allineato
al suo bordo sinistro (al destro quando a destra non c'è posto), e fra i due NON
SHALL esserci un bordo. Se la tab si sposta o cambia larghezza col foglio aperto,
il foglio SHALL riposarsi su di lei.

**Da dove si parte.** Le porte dell'indirizzo di una tab browser (clic sulla tab
attiva, tre puntini, ⌘L) SHALL aprire il foglio con il campo indirizzo a fuoco, il
testo selezionato e i suggerimenti sotto. La porta dei comandi (tasto destro,
pressione lunga, Shift+F10, tasto menu) SHALL aprire lo stesso foglio con il fuoco
sulla prima voce del primo livello, l'indirizzo visibile ma senza fuoco e nessun
suggerimento.

Un tasto destro sulla tab il cui foglio è aperto SHALL chiuderlo; un tasto destro
su un'altra tab SHALL chiudere questo foglio e aprire quello. Esc e un clic fuori
SHALL chiuderlo, e il clic fuori SHALL arrivare comunque a ciò che ha colpito.
Alla chiusura il fuoco SHALL tornare sulla tab.

#### Scenario: tasto destro su una tab browser
- **GIVEN** una pane browser su `https://example.com/a`, la sua tab nella barra
- **WHEN** l'utente fa clic col tasto destro sulla tab
- **THEN** il foglio `tab-sheet` della tab è aperto e nessun menu `role="menu"` al cursore è nel DOM
- **AND** il fuoco è sulla prima voce del primo livello e il campo indirizzo non ha il fuoco
- **AND** non c'è nessun suggerimento

#### Scenario: clic sulla tab browser attiva
- **GIVEN** la stessa pane, la sua tab attiva
- **WHEN** l'utente fa clic sull'etichetta della tab
- **THEN** il foglio è aperto, il campo indirizzo ha il fuoco e tutto il testo è selezionato
- **AND** sotto l'indirizzo ci sono i suggerimenti, e sotto i suggerimenti le stesse voci che apre il tasto destro

#### Scenario: la tab e il foglio sono una superficie
- **GIVEN** il foglio aperto su una tab, da una qualunque porta
- **THEN** la tab porta `data-sheet-open`
- **AND** il bordo superiore del foglio sta a 1 px dal bordo inferiore della tab, e il suo bordo sinistro coincide con quello della tab
- **AND** il colore di fondo della tab e quello del foglio sono lo stesso

#### Scenario: la porta si richiude
- **GIVEN** il foglio aperto dal tasto destro su una tab
- **WHEN** l'utente fa di nuovo tasto destro sulla stessa tab
- **THEN** il foglio è chiuso e non si riapre
- **WHEN** l'utente fa tasto destro su un'altra tab
- **THEN** è aperto solo il foglio di quella tab

#### Scenario: col dito
- **GIVEN** un dispositivo touch, una tab nella barra
- **WHEN** l'utente tiene premuta la tab
- **THEN** si apre lo stesso foglio del tasto destro

### Requirement: TABSHEET-02 — I comandi stanno su due livelli, e il primo si legge in un colpo

Il foglio della tab SHALL avere un primo livello e dei livelli che si aprono di
lato dalla loro riga. Il primo livello SHALL contenere, in quest'ordine: le voci
contestuali che esistono per quella tab in quel momento, Cerca, le righe dei
livelli nell'ordine Pagina, Strumenti, Sessione, Tab, Disposizione, e le
chiusure. Sotto la testata il primo livello NON SHALL superare 11 righe.

Una riga di livello SHALL portare la freccia e, quando il livello ha uno stato,
SHALL dirlo in coda senza aprirlo (lo zoom e il dispositivo della pagina, il
numero di errori e di download, lo stato della condivisione). Un livello con una
sola voce NON SHALL esistere: la voce SHALL stare al primo livello. Un livello
senza voci NON SHALL essere disegnato.

I livelli SHALL essere il sottomenu condiviso (`SubmenuItem`): si aprono di lato
con ribaltamento al bordo, al passaggio del puntatore e al clic, uno per
profondità; un livello aperto con un clic resta finché qualcosa di esplicito non
lo chiude. Le frecce su e giù, Home ed End SHALL muovere il fuoco nel livello;
freccia destra, Invio e Spazio su una riga di livello SHALL aprirlo e portarci il
fuoco; freccia sinistra SHALL chiuderlo e rendere il fuoco alla sua riga; Esc
SHALL chiudere un livello per pressione, e il foglio quando non ne resta nessuno.
Sotto i 768 px un livello SHALL aprirsi come foglio dal basso.

Un clic su zoom o dispositivo della pagina NON SHALL chiudere il livello: sono
comandi che si premono due volte di seguito. Un clic su una voce d'azione SHALL
chiudere il foglio ed eseguirla.

#### Scenario: il primo livello di una tab browser
- **GIVEN** una tab browser di primo livello, in un gruppo con tre tab, con split disponibili e un agente che non guida
- **WHEN** l'utente apre il foglio col tasto destro
- **THEN** sotto la testata ci sono al più 11 righe
- **AND** ci sono le righe di livello Pagina, Strumenti, Sessione, Tab e Disposizione, in quest'ordine
- **AND** la riga Pagina dice in coda lo zoom e il dispositivo

#### Scenario: tutto da tastiera
- **GIVEN** una tab col fuoco
- **WHEN** l'utente preme Shift+F10, scende con le frecce fino a Disposizione e preme freccia destra
- **THEN** il livello Disposizione è aperto di lato e il fuoco è sulla sua prima voce
- **WHEN** preme Esc
- **THEN** il livello è chiuso, il foglio è aperto e il fuoco è sulla riga Disposizione
- **WHEN** preme di nuovo Esc
- **THEN** il foglio è chiuso e il fuoco è sulla tab

#### Scenario: un livello con una voce sola
- **GIVEN** una tab il cui livello Tab avrebbe una sola voce
- **WHEN** l'utente apre il foglio
- **THEN** quella voce sta al primo livello e non c'è nessuna riga di livello Tab

#### Scenario: zoom due volte di seguito
- **GIVEN** il livello Pagina aperto, zoom al 100%
- **WHEN** l'utente preme due volte «+»
- **THEN** lo zoom è al gradino dopo il successivo e il livello è ancora aperto

### Requirement: TABSHEET-03 — Ogni voce di oggi ha UN posto, e nessuna è scritta due volte

Il foglio della tab SHALL offrire, per ogni tipo di tab, tutti i comandi che
offrivano il menu a tendina della tab e il foglio della tab browser prima di
questa modifica, ciascuno in un posto solo:

| Tipo | Testata | Primo livello | Livelli |
|------|---------|---------------|---------|
| browser | indirizzo; Indietro, Avanti, Ricarica, Copia indirizzo, Apri nel browser di sistema; suggerimenti solo dalle porte dell'indirizzo | Riprendi il controllo, Riporta nella chat, Apri nel progetto, Torna alla chat che ha aperto questo browser (ognuna solo dove esiste); Cerca nella pagina; Chiudi; Chiudi le altre | Pagina: Zoom della pagina, Dispositivo, Dimentica questo sito… · Strumenti: Console, Download, DevTools · Sessione: Condivisione, Motore, Resa · Tab: Rinomina, Fissa, Copia link alla tab · Disposizione |
| chat | nome e stato | Interrompi il turno (solo mentre lavora), Cerca nella chat, Impostazioni della chat, Chiudi, Chiudi le altre | Tab · Disposizione, con in più Sposta in una nuova finestra |
| terminale | nome | Ricarica, Cerca, Chiudi, Chiudi le altre | Tab · Disposizione |
| progetto e utilità | nome | Cerca (se la pane ha un cercatore), Chiudi, Chiudi le altre | Tab: Fissa il progetto, Fissa questa tab, Copia link · Disposizione |

Disposizione SHALL contenere, dove hanno effetto: Ingrandisci o Riduci,
Ingrandisci solo questa, Dividi a destra, Dividi in basso, Reimposta pannelli,
Sposta nel gruppo (un livello con i gruppi e Nuovo gruppo), Sposta in una cella
separata o Riporta nel pannello principale, Stacca il gruppo in una nuova
finestra.

«Copia indirizzo» SHALL essere l'unico comando che copia l'indirizzo della
pagina. «Chiudi» SHALL chiudere subito; la chiusura con il conto alla rovescia
SHALL restare solo sulla X della tab. Lo zoom della pagina SHALL chiamarsi «Zoom
della pagina» e quello della cella «Ingrandisci».

Ogni parola del foglio SHALL venire dai cataloghi delle due lingue, compresi i
nomi dei livelli e le code di stato.

#### Scenario: niente si perde su una tab browser
- **GIVEN** una tab browser di primo livello con split disponibili e più tab nel gruppo
- **WHEN** l'utente apre il foglio col tasto destro e apre un livello alla volta
- **THEN** Fissa, Cerca, Rinomina, Copia link alla tab, Copia indirizzo, Chiudi, Chiudi le altre, Ingrandisci, Dividi a destra, Dividi in basso, Reimposta pannelli, Sposta nel gruppo, Indietro, Avanti, Ricarica, Console, Zoom della pagina, Dispositivo e Dimentica questo sito… sono ciascuno raggiungibile
- **AND** nessuna voce che copia l'indirizzo della pagina compare due volte

#### Scenario: una chat che lavora
- **GIVEN** una tab di chat il cui turno è in corso
- **WHEN** l'utente apre il foglio col tasto destro
- **THEN** «Interrompi il turno» è al primo livello
- **WHEN** il turno finisce e l'utente riapre il foglio
- **THEN** «Interrompi il turno» non c'è

#### Scenario: chiudere dal foglio
- **GIVEN** il foglio aperto su una tab
- **WHEN** l'utente sceglie «Chiudi»
- **THEN** la tab sparisce dalla barra senza conto alla rovescia e il foglio è chiuso
- **AND** il foglio non offre nessuna voce di chiusura col conto alla rovescia

#### Scenario: in inglese
- **GIVEN** la lingua dell'app è l'inglese
- **WHEN** l'utente apre il foglio di una tab chat e il livello Tab
- **THEN** nessuna voce, nome di livello o coda è in italiano

### Requirement: TABSHEET-04 — La finestrella della topic e il titolo sul telefono aprono lo stesso foglio

Le schede della barra della finestra browser della topic (`TOPIC-BROWSER-01`)
SHALL aprire il foglio della tab browser: un clic sulla scheda attiva dalle porte
dell'indirizzo, il tasto destro e la pressione lunga dalla porta dei comandi. In
quel foglio «Apri come tab» SHALL stare al primo livello al posto di «Riporta
nella chat», e i livelli Tab e Disposizione NON SHALL esserci. «Chiudi» SHALL
chiudere la scheda.

Sotto i 768 px la pressione lunga e il tasto destro sul titolo della superficie
in primo piano SHALL aprire il foglio di quella superficie come foglio dal basso,
con le voci del suo tipo tranne Disposizione, e bersagli di almeno 44 px.

#### Scenario: una scheda della finestrella
- **GIVEN** una topic con la finestra browser minimizzata su due schede
- **WHEN** l'utente fa tasto destro sulla seconda scheda
- **THEN** il foglio della tab di quella scheda è aperto, con «Apri come tab» al primo livello e senza Disposizione
- **WHEN** sceglie «Apri come tab»
- **THEN** compare una pane `[data-browser-pane]` nel layout con lo stesso `contextId` e la finestra elenca solo la prima scheda

#### Scenario: il titolo sul telefono
- **GIVEN** un viewport largo 390 px con una chat in primo piano
- **WHEN** l'utente tiene premuto il titolo
- **THEN** il foglio della chat si apre dal basso a tutta larghezza, con Chiudi, Impostazioni della chat e il livello Tab
- **AND** nessun bersaglio è più basso di 44 px e non c'è Disposizione

## MODIFIED Requirements

### Requirement: LAYOUT-02 — Sidebar, Pane Tabs, Add-Pane Menu & Mobile

The system SHALL support sidebar toggle, pane tab bar interactions including close and the tab sheet (`TABSHEET-01`), add-pane menu for inserting new pane types, project window sub-panels, tab drag reorder, connection status display, and mobile responsive layout.

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
- **THEN** the tab sheet opens from the tab
- **AND** its first level includes a Close option
- **AND** its Disposizione level includes a Split Right option
- **AND** its Disposizione level includes a Split Down option

#### Scenario: Close tab via context menu
- **GIVEN** a tab's sheet is open
- **WHEN** the user clicks the Close option
- **THEN** the tab is removed from the tab bar without a countdown
- **AND** the tab sheet is dismissed

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
- **WHEN** the user right-clicks a tab and selects Close Others from the tab sheet
- **THEN** all other tabs are removed
- **AND** only the right-clicked tab remains

#### Scenario: Clicking tabs updates focus correctly
- **GIVEN** multiple tabs are visible in the tab bar
- **WHEN** the user clicks on different tabs in sequence
- **THEN** each clicked tab becomes the active tab
- **AND** the content area updates to show the selected pane
- **AND** the total tab count remains stable
