## Purpose

Specifies behavioral scenarios for topic lifecycle management and organizational features including creation, hierarchy, search, and collaboration indicators.

## Background

Common preconditions shared across scenarios:

- The user is logged into Topics App at http://localhost:3333
- The sidebar is visible with the topic tree
- At least one topic exists in the sidebar

## Requirements

### Requirement: TOPIC-01 — CRUD & Lifecycle

The system SHALL support creating, renaming, archiving, deleting, and restoring topics with full lifecycle management including settings, hierarchy, and templates.

#### Scenario: Create topic via new topic button
- **GIVEN** the sidebar is visible with the topic tree
- **WHEN** the user clicks the new topic button in the sidebar header
- **THEN** a new topic dialog appears with a name input field and template options

#### Scenario: Create topic via keyboard shortcut
- **GIVEN** the application is open
- **WHEN** the user presses Cmd+Shift+N
- **THEN** a new topic dialog appears with a name input field

#### Scenario: Create topic with custom name
- **GIVEN** the new topic dialog is open
- **WHEN** the user enters a topic name and clicks Create Topic
- **THEN** the dialog closes
- **AND** the new topic appears in the sidebar

#### Scenario: Create topic from template
- **GIVEN** the new topic dialog is open
- **WHEN** the user selects the "Code Review" template
- **THEN** the name input is pre-filled with "Code Review"
- **AND** clicking Create Topic creates a topic with that name

#### Scenario: Rename topic via context menu
- **GIVEN** a topic exists in the sidebar
- **WHEN** the user right-clicks the topic and selects Rename
- **THEN** an input field appears with the current name
- **AND** entering a new name and clicking Save updates the topic name in the sidebar

#### Scenario: Rename updates displayed name immediately
- **GIVEN** a topic has been renamed via the context menu
- **WHEN** the save action completes
- **THEN** the old name is no longer visible in the sidebar
- **AND** the new name appears in its place

#### Scenario: Delete topic with confirmation
- **GIVEN** a topic exists in the sidebar
- **WHEN** the user right-clicks the topic and selects Archive / Delete
- **THEN** a confirmation prompt appears showing the topic name
- **AND** clicking Delete removes the topic from the sidebar

#### Scenario: Cancel delete preserves topic
- **GIVEN** the delete confirmation prompt is showing for a topic
- **WHEN** the user clicks Cancel
- **THEN** the confirmation prompt closes
- **AND** the topic remains visible in the sidebar

#### Scenario: Archive topic removes from active list
- **GIVEN** a topic exists in the sidebar
- **WHEN** the user archives the topic via the context menu
- **THEN** the topic disappears from the active topics list

#### Scenario: Restore archived topic
- **GIVEN** a topic has been archived
- **WHEN** the user restores the topic from the archive view
- **THEN** the topic reappears in the active topics list in the sidebar

#### Scenario: Switch between topics updates main panel
- **GIVEN** two topics exist with different names
- **WHEN** the user clicks a different topic in the sidebar
- **THEN** the main panel updates to show the selected topic's content

#### Scenario: Topic settings modal opens from context menu
- **GIVEN** a topic is open as the active panel
- **WHEN** the user opens the context menu on the topic tab and selects Settings
- **THEN** a settings dialog appears with system prompt and context file options

#### Scenario: System prompt save persists across sessions
- **GIVEN** the topic settings dialog is open
- **WHEN** the user enters a system prompt and clicks Save
- **THEN** the prompt is saved
- **AND** reopening the settings dialog shows the saved system prompt

#### Scenario: Context files add and persist
- **GIVEN** the topic settings dialog is open
- **WHEN** the user adds a context file path and presses Enter
- **THEN** the file appears in the context files list
- **AND** the file remains in the list after saving and reopening settings

#### Scenario: Topic hierarchy with nesting
- **GIVEN** multiple topics exist in the sidebar
- **WHEN** the user drags a topic onto another topic
- **THEN** the dragged topic becomes a child nested under the target topic

#### Scenario: Newly created topic becomes active
- **GIVEN** the user has just created a new topic via the dialog
- **WHEN** the topic creation completes
- **THEN** the new topic is automatically selected in the sidebar
- **AND** the main panel displays the new topic's empty chat

#### Scenario: Delete last topic shows empty state
- **GIVEN** only one topic remains in the sidebar
- **WHEN** the user deletes that topic
- **THEN** the sidebar shows an empty state or prompt to create a new topic

#### Scenario: Duplicate topic names are allowed
- **GIVEN** a topic named "My Topic" exists in the sidebar
- **WHEN** the user creates another topic also named "My Topic"
- **THEN** both topics appear in the sidebar with the same name

### Requirement: TOPIC-02 — Organization

The system SHALL provide organizational features for topics including drag-and-drop reordering, search and filtering, unread indicators, color customization, and project folder grouping.

#### Scenario: Search filters topics by name
- **GIVEN** multiple topics exist in the sidebar
- **WHEN** the user types a search term in the topic search field
- **THEN** only topics whose names match the search term are displayed

#### Scenario: Search is case-insensitive
- **GIVEN** a topic named "My Project" exists in the sidebar
- **WHEN** the user types "my project" in lowercase in the search field
- **THEN** the "My Project" topic is displayed in the filtered results

#### Scenario: Clear search restores all topics
- **GIVEN** the search field contains a filter term with some topics hidden
- **WHEN** the user clears the search field
- **THEN** all topics are displayed again in the sidebar

#### Scenario: Search with no matches shows empty state
- **GIVEN** topics exist in the sidebar
- **WHEN** the user types a search term that matches no topic names
- **THEN** a no-results indicator is shown in the sidebar

#### Scenario: Drag-reorder changes topic position
- **GIVEN** multiple topics are visible in the sidebar
- **WHEN** the user drags a topic above or below another topic
- **THEN** the topic list updates to reflect the new position

#### Scenario: Drag-reorder persists after reload
- **GIVEN** the user has reordered topics via drag-and-drop
- **WHEN** the user reloads the page
- **THEN** the topics appear in the reordered position

#### Scenario: Unread badge appears on new message
- **GIVEN** a topic is not currently selected
- **WHEN** a new message arrives for that topic via the server
- **THEN** an unread badge with the message count appears on the topic

#### Scenario: Unread badge clears when topic is focused
- **GIVEN** a topic has an unread badge showing a message count
- **WHEN** the user clicks on that topic to select it
- **THEN** the unread badge disappears

#### Scenario: Color customization via context menu
- **GIVEN** a topic exists in the sidebar
- **WHEN** the user right-clicks the topic and selects Change color
- **THEN** a color picker submenu appears
- **AND** selecting a color applies a visual color indicator to the topic

#### Scenario: Color persists after reload
- **GIVEN** a topic has been assigned a custom color
- **WHEN** the user reloads the page
- **THEN** the topic retains its color indicator

#### Scenario: Project folder expand and collapse
- **GIVEN** a project folder section exists in the sidebar
- **WHEN** the user clicks the project folder header to collapse it
- **THEN** the folder's contents are hidden
- **AND** clicking the header again expands the folder to show its contents

#### Scenario: Sidebar sections toggle visibility
- **GIVEN** the sidebar contains multiple collapsible sections
- **WHEN** the user clicks a section header to collapse it
- **THEN** that section's items are hidden
- **AND** the section can be expanded again by clicking the header

#### Scenario: Topic with messages retains history on switch
- **GIVEN** a topic contains previous messages
- **WHEN** the user switches to another topic and then switches back
- **THEN** the original topic's message history is still visible

#### Scenario: Drag to nest topic under parent
- **GIVEN** two topics exist at the same level in the sidebar
- **WHEN** the user drags one topic directly onto another topic
- **THEN** the dragged topic becomes a nested child of the target topic

### Requirement: TOPIC-WT-01 — Optional Worktree Binding

> Promoted from `2026-05-16-add-project-worktree-domain`; the scenarios about the New Topic dialog's worktree picker, the settings-modal Worktree section and slash-command cwd resolution were dropped because the covering test exercises the topic API only. What is stated here is what that test proves: the binding round-trip and the fallback when the worktree disappears.

> Reread 27/08/2026 against the code, unchanged: migration 018 still adds a NULLABLE `worktree_id` with `ON DELETE SET NULL`, and the delete route still purges the id from the `ui_state` snapshots in the same transaction, so a deleted worktree cannot come back through a sync.

A topic MAY optionally be bound to a single worktree through the `worktree_id` foreign key. A topic with no binding SHALL behave exactly as it did before the column existed, operating inside its own `project_path`. When the bound worktree is deleted the binding SHALL be cleared, and the topic SHALL keep working against `project_path` with no user-visible error.

#### Scenario: Topic created without a worktree keeps the legacy behaviour
- **GIVEN** the user creates a topic without naming a worktree
- **WHEN** the topic is persisted
- **THEN** the created topic SHALL come back with `worktreeId` null
- **AND** it SHALL be listed by `GET /api/topics` like any other topic

#### Scenario: Topic created bound to a ready worktree
- **GIVEN** a project has a worktree that reached `status: 'ready'`
- **WHEN** the user creates a topic passing that worktree's id
- **THEN** the created topic SHALL carry that `worktreeId`

#### Scenario: Topic falls back to the project path when the worktree is deleted
- **GIVEN** a topic bound to worktree W
- **WHEN** `DELETE /api/worktrees/:id` removes W
- **THEN** the topic SHALL still exist
- **AND** its `worktreeId` SHALL be null
- **AND** its `projectPath` SHALL be unchanged

### Requirement: TOPIC-09 — Project folder expand and collapse

The system SHALL give a project row in the sidebar a chevron control, separate from the
project name, that only expands and collapses the folder — it never moves focus. The
folder's children SHALL be removed from the tree while it is collapsed and returned when
it is expanded, with `aria-expanded` reporting the current state.

> A project row exists while the project has an open pane, and a project chat is listed
> as a child only when it has an open pane inside the project, a pending attention, or is
> pinned — the test raises an unread on the child to make it listable.

#### Scenario: Collapsing the folder hides its child, expanding brings it back
- **GIVEN** a project row is visible in the sidebar with a chat inside it that has a pending unread
- **AND** the project's chevron reports `aria-expanded="true"`
- **THEN** the child chat's row is visible in the sidebar
- **WHEN** the user clicks the chevron
- **THEN** `aria-expanded` becomes `"false"` and the child's row is no longer present
- **WHEN** the user clicks the chevron again
- **THEN** `aria-expanded` returns to `"true"` and the child's row is visible again

### Requirement: STATUSLINE-01 — La fascia in fondo alla sidebar è UNA fascia, e dice la verità su chi c'è

Claude Code ha una status line configurabile; l'equivalente in Topics è la fascia
in fondo alla sidebar (`SidebarStatusBar.tsx`). È coperta da otto file di test —
e fino al 25/08/2026 **nessun requisito la nominava**. È il caso peggiore da
trovare: la copertura c'è e il documento di riferimento tace, così chi legge le
spec crede che la funzionalità non esista e chi guarda i test crede che sia
descritta.

Il sistema DEVE:

1. **tenere la fascia leggibile come UNA fascia.** I tre soggetti che ci stanno
   (io, le mie organizzazioni, chi è in giro) si distinguono per il **primo
   glifo** di ciascuno, non per una riga di separazione;
2. **non contare sé stessi.** La riga di presenza risponde a «chi ALTRO c'è»:
   chi lavora da solo su due macchine deve leggere «nessuno», non «1 online»;
3. **non dire il ferro al posto della persona.** Con una persona nota su una
   sessione loopback la riga nomina la persona, non «Questo computer»;
4. **lasciare fuori qualcosa quando i posti finiscono.** Il chip dei segnali ha
   tre posti e cinque candidati: uno zero non occupa mai un posto, perché è il
   modo più largo di non dire niente;
5. **dichiarare le soglie del verdetto come decisioni di prodotto**, fuori dalla
   JSX, dove possano essere contraddette da un test;
6. **chiamare le cose col nome della relazione che disegnano.** Il terzo
   soggetto sono gli AMICI, cioè il grafo delle amicizie (FRIEND-01), non la
   rubrica di chi divide con te un'organizzazione: quella è una lista che
   nessuno ha scelto, e chiamarla «Persone» era onesto sul dato e muto sulla
   domanda. Una richiesta di amicizia che aspetta una risposta si vede a
   pannello chiuso e si risponde nel pannello;
7. **rispondere a «con quale account sono entrato».** Il primo soggetto apre un
   pannello ACCOUNT: dice l'indirizzo con cui si è collegati e, quando non c'è
   nessun collegamento e l'installazione ha un servizio a cui chiedere
   (ACCOUNT-01), permette di accedere o registrarsi lì dentro, senza passare
   dalle impostazioni. Dove un servizio degli account non c'è, il pannello non
   ne parla affatto: il piano gratuito non è una versione mutilata di cui
   scusarsi in un menu a tendina.

> Nota: i punti da 1 a 5 NON introducono comportamento nuovo. Descrivono ciò che
> otto file di test già verificano, e li legano a un id perché la copertura sia
> auditabile invece che solo presente.

#### Scenario: la fascia si spezza in due

- **GIVEN** i tre soggetti della fascia
- **WHEN** si distinguono per una riga di separazione invece che per il glifo
- **THEN** il vincolo è violato

#### Scenario: la presenza conta chi guarda

- **GIVEN** una persona sola collegata da due macchine
- **WHEN** la riga di presenza mostra «1 online»
- **THEN** il vincolo è violato: doveva dire «nessuno»

#### Scenario: la riga nomina la macchina invece della persona

- **GIVEN** una persona nota su una sessione loopback
- **WHEN** la riga dice «Questo computer»
- **THEN** il vincolo è violato

#### Scenario: uno zero occupa un posto nel chip

- **GIVEN** il chip dei segnali con più candidati che posti
- **WHEN** un conteggio a zero prende un posto
- **THEN** il vincolo è violato

#### Scenario: il terzo soggetto mostra i colleghi al posto degli amici

- **GIVEN** una persona che divide un'organizzazione con te e non è tua amica
- **WHEN** la sua faccia compare sul chip degli amici
- **THEN** il vincolo è violato: quel chip disegna il grafo delle amicizie

#### Scenario: nessun account collegato e nessun modo di entrare

- **GIVEN** un'installazione con un servizio degli account e nessun collegamento
- **WHEN** il pannello del primo soggetto non offre nessun modo di accedere
- **THEN** il vincolo è violato

### Requirement: TOPIC-PREVIEW-01 — Le due gemelle della potatura hanno UNA testata sola

La potatura del testo di anteprima esiste su DUE lati — quello che scrive e
quello che disegna — e SHALL produrre lo STESSO risultato. Finché solo una delle
due aveva un banco, potevano divergere in silenzio: un caso corretto di là e non
di qua, e la stessa conversazione diceva due cose diverse a seconda di quale
canale l'aveva riempita.

SHALL sparire ciò che è impalcatura e non messaggio: i blocchi di codice — anche
una recinzione APERTA, cioè un turno tagliato a metà, che SHALL portarsi via la
coda — i marcatori di struttura, il grassetto, il corsivo, le immagini, e il
contesto iniettato.

NON SHALL sparire ciò che è CONTENUTO: gli underscore dentro una parola, una
moltiplicazione, l'etichetta di un collegamento.

Gli a-capo SHALL diventare UNA riga con gli spazi compressi. Una riga
ORIZZONTALE NON SHALL diventare il primo carattere che si legge.

Un messaggio di solo codice NON SHALL lasciare niente.

Il taglio SHALL avvenire a una lunghezza massima, puntini compresi, senza
superarla; un testo corto NON SHALL essere toccato.

La potatura SHALL essere IDEMPOTENTE: il secondo lato ripassa su ciò che il primo
ha già potato.

#### Scenario: una recinzione di codice aperta
- **GIVEN** un turno tagliato a metà dentro un blocco di codice
- **THEN** la coda SHALL essere rimossa

#### Scenario: una moltiplicazione
- **GIVEN** un testo con dei simboli che somigliano a formattazione
- **THEN** NON SHALL essere trattati come formattazione

### Requirement: TOPIC-CTRL-01 — I comandi di sessione distinguono «non c'è» da «c'è ma è archiviata», e non legano MAI la radice

Gli endpoint che una sessione usa per governare sé stessa SHALL distinguere i
modi di fallire: un bersaglio ARCHIVIATO SHALL essere un rifiuto DIVERSO da uno
INESISTENTE — confonderli manda a cercare qualcosa che c'è.

Creare un progetto il cui nome ESISTE GIÀ SHALL essere un CONFLITTO dichiarato,
che NOMINA la collisione, e NON SHALL legare in silenzio la cartella esistente:
creare non è un ri-aggancio idempotente. Il conflitto SHALL reggere da OGNI
strada, e NON SHALL sovrascrivere l'impalcatura né spostare niente.

Un riferimento fatto di soli caratteri non ammessi NON SHALL MAI legare la
sessione alla RADICE dello spazio di lavoro: uno slug che si svuota, unito alla
cartella base, restituisce la cartella base.

I percorsi grezzi proposti da un agente NON SHALL essere fidati.

Aprire un progetto SHALL essere IDEMPOTENTE: la stessa superficie spostata due
volte nello stesso progetto SHALL lasciare UNA sola appartenenza.

Un comando rivolto a una sessione di TERMINALE SHALL arrivare fino alla sua
superficie. Un rifiuto SHALL essere STRUTTURATO e SHALL nominare il comando
giusto da usare al posto di quello sbagliato. Una funzione assente nella build
SHALL essere dichiarata come tale, non come una rotta inesistente, e un endpoint
sconosciuto NON SHALL essere ingoiato da un ramo generico.

#### Scenario: un progetto che esiste già
- **GIVEN** una creazione con un nome in collisione
- **THEN** SHALL essere un conflitto dichiarato, senza legare né sovrascrivere

#### Scenario: un riferimento di soli caratteri non ammessi
- **GIVEN** un riferimento che si svuota
- **THEN** NON SHALL essere legata la radice dello spazio di lavoro

### Requirement: TOPIC-PURGE-01 — Una chat rimossa sparisce da OGNI forma dello stato, e lascia una LAPIDE

Una chat archiviata o cancellata SHALL essere rimossa da OGNI forma in cui lo
stato dell'interfaccia è conservato, compresa quella GLOBALE che NON ha il campo
degli elenchi aperti: la vecchia pulizia la saltava in silenzio, e restava una
scheda fantasma che ricompariva sugli altri dispositivi.

SHALL essere riconosciuta anche la forma in cui la superficie porta un
identificativo composto.

Per ogni superficie rimossa SHALL essere lasciata una LAPIDE DUREVOLE: senza,
la pulizia viene ANNULLATA dal client, che all'idratazione unisce le proprie
superfici locali con quelle in arrivo. La mappa delle lapidi SHALL avere un
TETTO.

Il registro di ANNULLAMENTO della chiusura NON SHALL essere cancellato: SHALL
essere marcato con una lapide invece. La catena è: si chiude la scheda, il
riduttore crea il registro dell'annullamento, la cascata del ritiro archivia il
discorso — e il registro appena creato spariva.

L'operazione SHALL essere un NON-FARE dichiarato quando il discorso non c'è, e
NON SHALL sollevare su ingressi che non sono oggetti.

Il ritiro SHALL essere il ROVESCIO esatto: archiviare marca, ripristinare
ritira, e i vicini SHALL restare intatti.

#### Scenario: lo stato globale delle superfici
- **GIVEN** una chat presente solo nello snapshot globale
- **THEN** SHALL essere rimossa, e SHALL restare una lapide

#### Scenario: il registro dell'annullamento
- **GIVEN** una chiusura appena annullabile
- **THEN** il registro NON SHALL essere cancellato

### Requirement: STATUSLINE-02 — Quel che si disegna non sborda MAI dallo spazio misurato

I riquadri dei progetti e i conteggi per colonna SHALL stare DENTRO lo spazio
MISURATO della riga, a QUALUNQUE larghezza: l'invariante SHALL essere verificata
su tutto l'intervallo, non su un caso.

Un conteggio SHALL contare il lavoro APERTO: ciò che è chiuso non si annuncia.

«Non ancora misurato» e «misurato ZERO» SHALL essere DUE cose: il primo TACE del
tutto; il secondo SHALL ANNUNCIARSI — nessun riquadro, ma il riepilogo dice che ne
mancano. Appiccicare l'ultima larghezza buona rimetterebbe il silenzio.

O la coppia icona-conteggio si vede INTERA, o il riquadro NON SHALL essere
disegnato: un'icona senza il suo numero non si mostra. Il predicato di
leggibilità SHALL essere UNO, non ricopiato.

Il riepilogo «più N» SHALL prendersi il proprio posto PRIMA di contare quanti ne
restano. La CODA SHALL arrotolarsi e la TESTA restare: si perde ciò che è
lontano, mai ciò su cui si decide. Lo spazio minimo dei riquadri SHALL essere
riservato PRIMA: sono i CONTEGGI a cedere — con più colonne aperte i conteggi si
prendevano tutto e ai progetti restava meno di uno, cioè ZERO progetti senza
nemmeno un riepilogo a dirlo. Un conteggio SOLO NON SHALL arrotolarsi mai.

Senza riquadri da mostrare NON SHALL essere riservato nessuno spazio minimo.

Un progetto che l'indice non conosce SHALL restare CONTATO, col nome ripulito e
senza il percorso.

#### Scenario: quattro colonne aperte su una riga stretta
- **GIVEN** lo spazio misurato di una colonna stretta
- **THEN** SHALL restare almeno un progetto, e il resto SHALL essere dichiarato

#### Scenario: misurato zero
- **GIVEN** una larghezza misurata pari a zero
- **THEN** SHALL essere annunciato, non taciuto

### Requirement: STATUSLINE-03 — Il numero di versione dice quale CODICE è a schermo

Il chip di versione preferisce `/api/version` — il numero che il server rilegge
fresco dal package.json — così un bump si vede subito invece di aspettare una
ricostruzione. `public/` però è un artefatto di deploy che si muove SOLO quando
qualcuno lancia `bun run build:client` (decisione misurata in
`docs/build-watch-decision.md`). Quando il bundle resta indietro, quel chip
mostra il numero del REPO mentre a schermo gira il codice vecchio: misurato il
29/08/2026, bundle fermo alla 2.2.211 col repo alla 2.2.215.

I due fatti stanno GIÀ nel client: `__APP_VERSION__` è cotto nel bundle al
`vite build`, `/api/version` è letto vivo dal server. Il sistema SHALL
CONFRONTARLI e SHALL dichiarare la divergenza dove si legge il numero, con il
gesto che la chiude.

Un fatto MANCANTE NON SHALL essere una divergenza: senza server raggiungibile,
o quando il server risponde `0.0.0` perché non ha potuto leggere niente, il
segnale SHALL tacere. Sotto il server di sviluppo (HMR) il segnale SHALL tacere
comunque: lì il codice a schermo è vivo e la define cotta è ferma all'avvio, e
la loro differenza non è una deriva.

#### Scenario: il bundle è indietro rispetto al repo
- **GIVEN** un bundle cotto alla 2.2.211 e un server che risponde 2.2.215
- **THEN** la divergenza SHALL essere dichiarata, con entrambi i numeri

### Requirement: STATUSLINE-03b — Un fatto MANCANTE non è una divergenza

Il rovescio di STATUSLINE-03, e sta in un requisito suo perché è la metà che
un cancello di regressione dimentica per prima: il confronto ha due termini, e
quando il secondo non c'è il segnale SHALL tacere invece di inventare una
deriva.

Vale in tre modi: server irraggiungibile, server che risponde `0.0.0` perché
non ha potuto leggere niente, e server di sviluppo (HMR) — lì il codice a
schermo è vivo mentre la define cotta è ferma all'avvio, e la loro differenza
non è una deriva ma il funzionamento normale.

#### Scenario: nessun server da interrogare
- **GIVEN** un bundle cotto e nessuna versione di repo
- **THEN** NON SHALL essere dichiarata nessuna divergenza

### Requirement: STATUSLINE-03c — Il numero in evidenza dice anche quale GUSCIO aggiorna l'updater

Su una macchina di sviluppo i numeri veri sono TRE e non due: il guscio nativo
installato (quello che l'updater sostituisce davvero), il bundle client in
`public/` (quello che gira a schermo) e il `package.json` del repo (quello che
`/api/version` legge). Misurati: 2.2.179, 2.2.211, 2.2.214.

Il chip SHALL continuare a seguire il CLIENT: è il segnale «il deploy è
atterrato», e sovrascriverlo con il numero del guscio faceva leggere un client
appena consegnato col numero vecchio. Ma quando guscio e client divergono il
chip SHALL DIRLO, nominando il numero del guscio, senza che si debba aprire
niente: altrimenti l'avviso di nuova versione che il guscio merita davvero
sembra un difetto dell'avviso.

L'avviso di aggiornamento del guscio NON SHALL essere zittito in modalità di
sviluppo: la consegna a caldo aggiorna il client, non il guscio, e tacerlo
toglierebbe l'unico segnale che dice a che versione è l'app installata.

Lo stato «installazione di sviluppo» (`devReload`, cioè `topics-dev.json`)
SHALL essere leggibile ACCANTO AL NUMERO e non solo dentro il pannello della
versione, perché è la ragione per cui il secondo numero resta indietro.

*(Diceva «dalla riga di stato». Quella riga sul desktop non esiste più — il suo
contenuto è nel menu «Topics», SIDEBAR-STATUS-01 — e il vincolo era sul posto
sbagliato: non contava che fosse una BARRA, contava che il fatto stesse dove si
legge il numero invece che dietro un altro gesto. Il badge accanto al chip
soddisfa questo, in tutti e due i posti in cui il chip vive.)*

#### Scenario: guscio alla 2.2.179, client alla 2.2.214
- **GIVEN** il ponte del guscio che risponde 2.2.179 e un client alla 2.2.214
- **THEN** il chip SHALL mostrare 2.2.214 e SHALL nominare anche la 2.2.179

#### Scenario: app installata e allineata
- **GIVEN** guscio e client sullo stesso numero
- **THEN** il chip SHALL restare largo un numero solo

### Requirement: TOPIC-LINK-01 — Un collegamento fra discorsi è SIMMETRICO e si scrive ATOMICAMENTE

Un collegamento fra due discorsi SHALL valere da ENTRAMBE le parti, e SHALL essere
scritto ATOMICAMENTE: un guasto a metà NON SHALL poter lasciare un verso senza
l'altro.

Ripeterlo NON SHALL duplicarlo. Toglierlo SHALL toglierlo da entrambe le parti, e
un collegamento verso un discorso SPARITO SHALL comunque potersi togliere.

Una richiesta senza bersaglio SHALL essere rifiutata come malformata; verso un
discorso inesistente SHALL essere dichiarata assente. Toglierlo da un discorso che
non esiste SHALL essere dichiarato assente.

#### Scenario: un guasto a metà scrittura
- **GIVEN** l'interruzione fra i due versi
- **THEN** NON SHALL restare un collegamento a senso unico

#### Scenario: un bersaglio già cancellato
- **GIVEN** un collegamento verso un discorso sparito
- **THEN** SHALL comunque potersi togliere

### Requirement: TOPIC-10 — La fine di un turno non SOVRASCRIVE ciò che è stato scritto DURANTE

La chiusura di un turno NON SHALL riscrivere TUTTE le colonne del discorso a
partire dall'oggetto letto quando la richiesta è ARRIVATA: ciò che è stato scritto
a metà turno — il legame con un progetto, per esempio — era ancora vuoto in quella
fotografia, e la chat si ritrovava fuori dal progetto.

L'istante di ultimo aggiornamento SHALL comunque avanzare.

Il messaggio INIZIALE di un discorso SHALL fare andata e ritorno e SHALL potersi
azzerare. Oltre una lunghezza massima SHALL essere rifiutato. I caratteri di
controllo SHALL essere tolti, e gli a-capo e le tabulazioni CONSERVATI.

#### Scenario: un progetto legato a metà turno
- **GIVEN** una scrittura durante il turno
- **THEN** SHALL sopravvivere alla chiusura

#### Scenario: un messaggio iniziale con caratteri di controllo
- **GIVEN** un testo con caratteri non stampabili
- **THEN** SHALL essere ripulito, conservando a-capo e tabulazioni

### Requirement: SIDEBAR-STATUS-01 — Lo stato sta nel menu «Topics»; fuori resta solo ciò che non può aspettare un gesto

La colonna dei topic SHALL NOT tenere una barra di stato in fondo. Ciò che quella
barra diceva — chi sei, come va la macchina, che versione è — SHALL vivere nel
menu che si apre dal titolo «Topics», che è dove lo si va a cercare e dove sul
telefono sta già dal 7 agosto.

Dentro il menu le statistiche SHALL essere RIGHE, una per fatto — prestazioni,
versione, riavvio — larghe quanto le voci che stanno sopra (cronologia,
impostazioni) e con lo stesso attacco a sinistra. NON SHALL essere una striscia
orizzontale di cifre: una striscia dice le stesse cose in un carattere che si
legge solo avvicinandosi, e in un menu fatto di righe si legge come un residuo.
E SHALL essere la STESSA implementazione su desktop e su telefono: due copie
della stessa risposta sono due copie che un giorno rispondono diverso.

Il taglio non è «tutto dentro». Un ALLARME non è una statistica: dire «sei
offline» o «mi sto riconnettendo» dietro un gesto significa che l'app è scollegata
e chi la guarda non lo sa finché non apre un menu. Quindi la riga del titolo SHALL
portare un pallino — piccolo, senza testo, senza costare altezza — che SHALL
DICHIARARE l'allarme quando c'è qualcosa che non può aspettare: WebSocket non
connesso, avvio degradato, avviso sui dati.

E' UN PALLINO SOLO, e risponde a due domande diverse. Il testo di questo
requisito ne pretendeva uno che a tutto a posto fosse INVISIBILE, e per due
giorni ce ne sono stati davvero due: quello del carico, che c'era sempre, e una
seconda spia accanto, accesa solo in allarme. Segnalato dal vivo il 31/08 —
«ora vedo due pallini nel trigger» — e la lettura era giusta: due tondi a
quattro pixel di distanza non sono due segnali, sono un segnale che sembra
rotto. Sono stati fusi. Quindi il pallino SHALL essere sempre dipinto (la sua
tinta è il carico: risponde a «quanto»), e l'allarme SHALL essere una
DICHIARAZIONE su di lui — un attributo che un test può leggere, più la
pulsazione — che SHALL scavalcare la tinta del carico: «sei offline» conta più
di «la macchina è impegnata», e dipingere le due cose sullo stesso tondo
vorrebbe dire non dirne nessuna. A tutto a posto il pallino NON SHALL dichiarare
nessun allarme e NON SHALL pulsare, perché una spia sempre accesa non è una
spia.

L'identità (persona, organizzazioni, amici) NON SHALL seguire lo stato nel menu:
resta in fondo alla colonna, dove sta. Non è inerzia, è il suo contratto — la
fascia SHALL tenere i tre soggetti su UNA riga alle larghezze di colonna 180,
256 e 400 (CHIPS-01), e il menu del desktop ha una larghezza sua che non segue
la colonna. Portarla dentro non l'avrebbe spostata: avrebbe cancellato il
contratto per cui è stata costruita. Ed è anche la metà che il 7 agosto riportò
la barra in fondo — «gli account che fine hanno fatto?» — quindi lasciarla lì
risolve due cose con lo stesso gesto.

#### Scenario: la colonna a tutto a posto
- **GIVEN** un desktop con WebSocket connesso e nessun avviso
- **WHEN** si guarda la colonna dei topic
- **THEN** in fondo NON c'è nessuna barra di stato: solo la fascia dell'identità
- **AND** il pallino nella riga del titolo NON dichiara nessun allarme e non pulsa

#### Scenario: l'allarme si legge senza aprire niente
- **GIVEN** un desktop col WebSocket non connesso, o un avvio degradato
- **THEN** in fondo alla colonna compare la riga che NOMINA il guasto
- **AND** compare SOLO in quel caso: a tutto a posto quella riga non esiste

#### Scenario: la connessione cade
- **GIVEN** la stessa colonna, col menu CHIUSO
- **WHEN** il WebSocket passa a non connesso
- **THEN** il pallino nella riga del titolo DICHIARA l'allarme e pulsa
- **AND** in fondo alla colonna compare la riga che nomina il guasto
- **AND** succede senza che nessuno abbia aperto niente

#### Scenario: i numeri si leggono dal menu
- **GIVEN** un desktop
- **WHEN** si apre il menu «Topics»
- **THEN** la prima riga dice memoria e CPU senza espandere altro
- **AND** espandendola compare il pannello delle prestazioni

#### Scenario: una riga per fatto, come le voci sopra
- **GIVEN** un desktop col menu «Topics» aperto
- **THEN** prestazioni, versione e riavvio sono tre righe distinte, una sotto
  l'altra
- **AND** ciascuna attacca dove attacca «Cronologia» ed è larga quanto lei

#### Scenario: l'identità non si muove
- **GIVEN** un desktop
- **THEN** la riga dell'identità è in fondo alla colonna, non nel menu
- **AND** i tre soggetti tengono una riga sola alle tre larghezze di CHIPS-01
