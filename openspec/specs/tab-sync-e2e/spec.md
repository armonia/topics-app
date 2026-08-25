## ADDED Requirements

### Requirement: TAB-SYNC-01 — Tab State Persistence Across Reload

The system SHALL persist open tabs to the server and restore them after page reload, ensuring no tab loss.

#### Scenario: Open tabs survive page reload
- **GIVEN** the user has multiple tabs open in the tab bar
- **WHEN** the user reloads the page
- **THEN** all previously open tabs reappear in the tab bar
- **AND** the active tab is restored to the one that was active before reload

#### Scenario: Closing a tab persists after reload
- **GIVEN** the user closes a tab from the tab bar
- **WHEN** the user reloads the page
- **THEN** the closed tab does not reappear
- **AND** only the remaining tabs are shown

#### Scenario: Tab order persists after reload
- **GIVEN** the user has reordered tabs via drag-and-drop
- **WHEN** the user reloads the page
- **THEN** the tabs appear in the reordered sequence

#### Scenario: Server receives tab state update via API
- **GIVEN** the user opens a new tab
- **WHEN** the debounced sync fires
- **THEN** a PUT request is sent to `/api/ui-state` with the updated panel state

### Requirement: TAB-SYNC-02 — WebSocket Cross-Client Tab Sync

The system SHALL broadcast tab state changes via WebSocket so that other connected clients receive updates.

#### Scenario: Tab opened in one context appears in another
- **GIVEN** two browser contexts are connected to the app
- **WHEN** context A opens a new pane tab
- **THEN** context B receives a `ui-state:updated` WebSocket message
- **AND** context B's tab bar reflects the new tab

#### Scenario: Tab closed in one context is removed in another
- **GIVEN** two browser contexts are connected to the app with the same tabs open
- **WHEN** context A closes a tab
- **THEN** context B receives the updated state via WebSocket
- **AND** context B no longer shows the closed tab

### Requirement: TAB-SYNC-03 — Preview (Transient) Tab Behavior

The system SHALL support preview tabs that are replaced when opening another item, and can be pinned by double-clicking.

#### Scenario: Single-click opens a preview tab
- **GIVEN** the user single-clicks a topic in the sidebar
- **WHEN** the topic opens as a tab
- **THEN** the tab appears with italic styling indicating it is a preview tab

#### Scenario: Preview tab is replaced by next single-click
- **GIVEN** a preview tab is open for topic A
- **WHEN** the user single-clicks topic B in the sidebar
- **THEN** the preview tab switches to topic B
- **AND** topic A's tab is no longer visible

#### Scenario: Double-click pins a preview tab
- **GIVEN** a preview tab is open for a topic
- **WHEN** the user double-clicks the tab
- **THEN** the tab loses its italic preview styling
- **AND** opening another topic creates a new preview tab instead of replacing the pinned one

### Requirement: PRESENCE-10 — «Aperto altrove» esclude ME, e una finestra non è mai vuota

L'elenco di ciò che è aperto ALTROVE SHALL ESCLUDERE questa finestra: un discorso
aperto QUI non è aperto altrove.

L'esclusione SHALL avvenire per identificativo E per ETICHETTA: l'identificativo
vive in una memoria che si svuota, e la stessa finestra può annunciarsi con
identificativi diversi — è così che la sezione delle finestre ne mostrava quattro
dove ce n'era una. Un'etichetta assente o vuota NON SHALL filtrare niente, o
tutto collasserebbe.

Una finestra SHALL essere descritta da OGNI scheda che annuncia, non solo dalle
chat: alcune finestre annunciavano zero discorsi e la riga si disegnava come un
titolo sopra il nulla. Una finestra che NON annuncia schede SHALL ripiegare sui
suoi discorsi, non sul nulla; un elenco di schede VUOTO SHALL valere «non ha
annunciato», non «finestra vuota».

L'insieme annunciato SHALL SOSTITUIRE il precedente, non fondersi.

Quando lo stesso discorso è aperto in due altre finestre SHALL vincere la prima
vista. Una finestra senza etichetta NON SHALL essere raggiungibile.

#### Scenario: la stessa finestra con due identificativi
- **GIVEN** un annuncio con la mia etichetta e un altro identificativo
- **THEN** NON SHALL essere considerata un'altra finestra

#### Scenario: una finestra di soli terminali
- **GIVEN** una finestra che non annuncia chat
- **THEN** SHALL comunque essere descritta

### Requirement: PRESENCE-11 — Due avvisi in pagina con lo STESSO segnale si sostituiscono

Due avvisi in pagina che portano lo STESSO segnale SHALL SOSTITUIRSI, e il nuovo
SHALL andare in fondo: sono UNA cosa da guardare — la stessa regola che le
notifiche di sistema applicano — e senza la sostituzione una conversazione lunga
lascia in pagina una colonna di cartelli identici.

Segnali DIVERSI SHALL restare avvisi diversi. Senza segnale ogni avviso SHALL
essere suo: due anonimi NON SHALL mangiarsi a vicenda.

Chiudere un avviso SHALL togliere SOLO quello.

#### Scenario: due fine-turno dello stesso discorso
- **GIVEN** lo stesso segnale due volte
- **THEN** SHALL restare un avviso solo, in fondo

#### Scenario: due avvisi anonimi
- **GIVEN** nessun segnale dichiarato
- **THEN** SHALL restare entrambi

### Requirement: PRESENCE-12 — Quattro socket con la stessa etichetta sono UNA finestra

I socket che non hanno mai ANNUNCIATO un identificativo di finestra SHALL essere
saltati. Identificativi DUPLICATI — la corsa di una riconnessione — SHALL
collassare sul primo. Ogni voce SHALL portare il client, l'etichetta, se è
staccata, i suoi argomenti e il fuoco. Togliere un socket dall'ingresso SHALL
toglierlo dall'istantanea: si guarisce da sé.

Un socket NON VIVO NON SHALL essere una finestra.

**Più socket vivi con la STESSA etichetta di finestra SHALL essere UNA finestra
sola**, e fra gli omonimi SHALL vincere quello dichiarato. Il collasso SHALL
tenere i dati del sopravvissuto, e un socket MORTO NON SHALL tenere in vita
l'etichetta di uno vivo.

**Il ramo web NON SHALL collassare**: senza etichetta, più schede SONO più
finestre davvero. Etichette DIVERSE SHALL restare finestre diverse — una staccata
è una finestra vera.

Le tab SHALL attraversare l'istantanea INTATTE, e un socket che non ne annuncia
nessuna SHALL riportare «non dichiarato», non un elenco vuoto: sono due cose
diverse.

#### Scenario: quattro socket, una etichetta
- **GIVEN** quattro socket vivi con la stessa etichetta
- **THEN** SHALL uscire una finestra sola

#### Scenario: più schede web senza etichetta
- **GIVEN** socket senza etichetta di finestra
- **THEN** SHALL restare finestre distinte
