## Purpose

Specifies performance and visual quality requirements for the Topics App, including layout stability (CLS), load times, and absence of visual artifacts like white flash during transitions.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- The main application layout is visible with a sidebar on the left and a content area on the right
- At least one topic exists with messages

## Requirements

### Requirement: PERF-01 — Layout Stability & Visual Quality

The system SHALL maintain visual stability during all user interactions, with Cumulative Layout Shift (CLS) below 0.1, and SHALL prevent white flash artifacts during page load and topic transitions.

#### Scenario: A reload moves nothing that was already painted
- **GIVEN** a chat the user was reading, with its local copy of the history, and a reply that landed on the server while they were away (it carries an image)
- **WHEN** the user reloads the app
- **THEN** the conversation is revealed only once its TAIL is painted, authoritative and whole (the first page of the server history applied - see CHAT-HIST-01 - first item painted, images in view loaded), and the Cumulative Layout Shift of the return is at most 0.01
- **AND** the rest of the history is not merged into the list while the reader is looking at it: it waits for the pane to be hidden or for the reader to ask
- **AND** the tab badges, the goal bar, the identity row and the pinned tiles are drawn from what the device last saw, so their first frame is their final frame

#### Scenario: A pane whose numbers have not landed draws the layout they will land in
- **GIVEN** a pane whose content comes from a fetch (the dashboard: nine KPI cards and a time-series chart, from `/api/dashboard/kpis` and `/api/dashboard/timeseries`)
- **WHEN** it mounts before either answer has arrived
- **THEN** it SHALL draw its final geometry with the cards in the "no source" state they already speak, never a centred spinner that is later replaced by the whole layout
- **AND** on a RETURN the numbers SHALL come from the device's local copy, together with the metric and range they were drawn for, so the first frame is the frame the reader left
- **AND** an indicator that comes and goes on its own clock (a refresh glyph, a liveness dot) SHALL keep its box, or sit where nothing follows it

#### Scenario: Topic switch has no visible layout shift
- **GIVEN** a topic is selected
- **WHEN** user clicks another topic
- **THEN** Cumulative Layout Shift (CLS) is less than 0.1
- **AND** no white flash occurs during transition

#### Scenario: Initial page load has no white flash
- **GIVEN** the app loads for the first time
- **WHEN** the page renders
- **THEN** no background color change from white to dark is visible (dark background applied before first paint)

#### Scenario: Sidebar toggle does not cause content shift
- **GIVEN** the sidebar is visible
- **WHEN** user toggles sidebar
- **THEN** main content resizes smoothly without jumping

#### Scenario: Panel split does not cause layout shift
- **GIVEN** a single panel view
- **WHEN** user splits right/down
- **THEN** no visible content jump occurs during split animation

#### Scenario: UI is visually stable after topic switch
- **GIVEN** a topic is loaded
- **WHEN** 2 seconds pass after the switch
- **THEN** less than 2% of pixels change between screenshots
- **AND** no text content flickers or changes

#### Scenario: No DOM thrashing during initial load
- **GIVEN** the app has finished loading (networkidle)
- **WHEN** 3 seconds pass
- **THEN** fewer than 50 DOM mutations occur
- **AND** no "Connecting" or loading text appears and disappears repeatedly

#### Scenario: UI is visually stable after sidebar toggle
- **GIVEN** the sidebar has been toggled
- **WHEN** 2 seconds pass
- **THEN** less than 2% of pixels change between screenshots

#### Scenario: Chat message list does not shift on new message
- **GIVEN** user is reading messages at bottom
- **WHEN** a new message arrives
- **THEN** existing messages do not shift position

### Requirement: PERF-02 — Load Performance

The system SHALL load within acceptable time thresholds and SHALL NOT block the main thread with long tasks during normal user interaction.

#### Scenario: App loads within 3 seconds
- **GIVEN** a fresh page load
- **WHEN** navigation completes
- **THEN** DOMContentLoaded fires within 3000ms

#### Scenario: Topic switch completes within 500ms
- **GIVEN** a topic exists with messages
- **WHEN** user clicks the topic
- **THEN** the chat content is visible within 500ms

#### Scenario: No render-blocking resources after initial load
- **GIVEN** the app is loaded
- **WHEN** user interacts
- **THEN** no long tasks (>50ms) block the main thread during normal interaction

Il codice di una pane APERTA non è un chunk pigro. Ogni corpo di pane è un
`React.lazy`, giusto per una pane mai aperta; per quella che si sta guardando al
ricarico il chunk SHALL essere chiesto al boot, dallo snapshot locale, prima che
React monti — e questo SHALL valere anche per i TILE di un project window
(terminale, browser, albero dei file, git, dashboard, log di processo), che il
pane-store non elenca: stanno nel record locale del progetto
(`topics-project-panes-<hash>`). Misurato il 05/09/2026 sullo stato reale del
desktop: ogni tile di ogni project window disegnava uno spinner per 220-240 ms a
ogni ricarico, perché nessuno aveva chiesto il suo chunk. Il ripiego HTTP dello
snapshot del pane-store SHALL leggere la SOLA chiave che gli serve
(`/api/ui-state/pane-store-v2`), non l'intero store (413 chiavi, 276 KB).

Un chunk già CALDO SHALL renderizzare senza confine di Suspense: `React.lazy`
sospende al primo montaggio anche quando il modulo è in cache (l'`import()`
della factory si risolve in un microtask, il confine committa il fallback, il
corpo arriva al giro dopo). Misurato: chunk chiesti a 110 ms e in cache, primo
frame del guscio a 224 ms, e i tile disegnavano comunque lo spinner per 136 ms.
Il preload SHALL ricordare il modulo risolto per identità del loader, e il
wrapper (`lazyWarm`) SHALL leggerlo al montaggio: caldo → corpo nello stesso
passaggio; freddo → `React.lazy` come prima. La scelta SHALL essere presa una
volta per istanza montata, per non rimontare una pane quando il chunk si scalda.
Poiché un chunk in cache si risolve comunque in un task SUCCESSIVO al primo
render di React, il primo render SHALL aspettare che i chunk caldi si risolvano,
con un tetto (300 ms): oltre il tetto l'app renderizza lo stesso e i confini
fanno il loro mestiere. Senza snapshot locale non c'è niente da aspettare.

#### Scenario: i tile di un project window non mostrano lo spinner al ricarico
- **GIVEN** un project window con un terminale e un browser nel suo record locale
- **WHEN** la pagina si ricarica
- **THEN** i chunk del terminale e del browser sono chiesti al boot, insieme a quelli delle pane del pane-store
- **AND** un record locale illeggibile lascia il project window ai suoi chunk pigri, senza fermare il boot

#### Scenario: un chunk caldo non passa dal fallback
- **GIVEN** un chunk di pane già risolto dal preload
- **WHEN** la pane monta
- **THEN** il corpo è nel primo passaggio di render, senza fallback
- **AND** un chunk freddo passa ancora da `React.lazy` e il confine mostra il suo fallback

### Requirement: LEAK-01 — Una sessione lunga non accumula, e c'è un cancello che se ne accorge

Topics è una sessione lunga per costruzione: resta aperta per giorni, le pane si
aprono e si chiudono, i topic si cambiano, i messaggi arrivano in streaming. Un
leak è una **derivata**, e ogni altro cancello di questo repository misura un
punto — i byte del bundle a build time, la latenza di un gesto, i frame di uno
scroll. Per costruzione nessuno di loro può vederlo.

Il sistema DEVE:

1. **liberare le strutture per-socket alla chiusura.** Le due mappe dei client
   WebSocket (`wsClients`, `browserWsClients`) perdono la loro voce nel gestore
   di `close`, e la voce esterna della mappa sparisce quando il suo insieme si
   svuota;
2. **non dipendere solo da `close`.** Una rottura TCP semi-aperta (laptop che
   dorme, rete che cade) non fa scattare `close`: un heartbeat DEVE mietere i
   socket senza pong, altrimenti la pulizia non gira mai;
3. **annullare i timer che ha creato** — il timer di riconnessione
   dell'EventSource del browser remoto, e i tre timer di stream (soft, grace,
   hard);
4. **misurare la crescita nel tempo** su un banco che ripete cicli di
   interazione, e giudicarla contro un budget per heap, nodi DOM e listener;
5. **liberare le strutture per-contesto quando una pane browser se ne va**, e
   per OGNI via d'uscita, non solo per quella esplicita. `BrowserService` tiene
   sette registri chiavati per `contextId`, e il richiamo `onDestroy` è l'unico
   modo in cui i registri che vivono in ALTRI moduli (la cache degli elementi di
   `browser_observe`, l'istantanea dei riferimenti, il contatore delle chiamate
   di visione) possono rimpicciolirsi. Un contesto ricreato con lo STESSO id su
   una cache non svuotata non è solo memoria: è un `browser_act` che risolve un
   riferimento della pagina morta.

Il cancello DEVE poter diventare rosso: un banco che non ha mai fallito non è un
banco.

> Nota su cosa esisteva già, perché questo requisito non introduce
> comportamento. Il banco (`tests/e2e/long-session-growth.spec.ts`) e il cancello
> (`scripts/check-session-growth.ts`) erano scritti, funzionanti e **senza
> requisito che li nominasse** — la terza volta che questa forma compare in una
> sola notte. Verificato il 25/08/2026: sulla misura registrata la sessione resta
> piatta (heap x1.32 su budget x1.51, DOM x1.13 su x1.3, listener x1.10 su x1.2),
> e su una misura sintetica con un leak il cancello esce rosso nominando heap e
> listener.

#### Scenario: un socket chiuso non lascia la sua voce

- **GIVEN** un client WebSocket registrato in una delle due mappe
- **WHEN** il socket si chiude
- **THEN** la sua voce è rimossa, e la voce esterna sparisce se l'insieme si svuota

#### Scenario: un contesto browser che se ne va svuota anche le cache di fuori

- **GIVEN** un contesto browser vivo, con le sue voci nei registri per `contextId`
- **WHEN** il contesto se ne va, sia per chiusura esplicita sia perché la sua
  pagina è morta e `getOrCreate` scarta la voce
- **THEN** tutti i registri per-contesto tornano dov'erano e `onDestroy` scatta
  una volta per contesto, così una ricreazione con lo stesso id non trova
  un'istantanea vecchia

#### Scenario: un socket semi-aperto viene mietuto

- **GIVEN** un socket che non risponde al ping oltre la soglia
- **WHEN** l'heartbeat gira
- **THEN** il socket è rimosso dalla mappa e chiuso

#### Scenario: la crescita oltre il budget è rossa e dice dove guardare

- **GIVEN** una misura in cui heap o listener crescono oltre il budget
- **WHEN** il cancello la giudica
- **THEN** esce non-zero, nomina la grandezza sfondata e indica dove cercare

#### Scenario: una sessione sana resta piatta

- **GIVEN** una misura di cicli ripetuti entro i budget
- **WHEN** il cancello la giudica
- **THEN** esce zero

### Requirement: LEAK-04 — Una callback che pulisce DEVE scattare una volta per ogni contesto che se ne va

`BrowserService` riceve un `onDestroy(contextId)`, e il server ci appende lo
svuotamento di tutto ciò che tiene per `contextId`: la cache degli elementi di
`browser_observe`, la cache degli snapshot dei ref, il contatore delle chiamate
vision. Quelle mappe vivono in altri moduli e **non hanno altro modo di
rimpicciolire**: se la callback non scatta, non le pulisce nessuno.

Quindi la domanda che conta non è «la callback è scritta giusta», è «scatta
tutte le volte». Un contesto può andarsene in più modi, e la chiusura pulita è
solo uno di quelli.

Il sistema DEVE far scattare `onDestroy` **una volta per ogni contesto che
lascia il servizio, qualunque sia la strada** — chiusura esplicita, sfratto,
disconnessione del browser sottostante — e la prova DEVE essere un conteggio, non
un'ispezione: N cicli per ciascuna strada, e il numero di callback osservate
confrontato col numero di contesti usciti. Una callback che scatta zero volte e
una che ne scatta due sono difetti diversi, e un contatore li distingue
entrambi; leggere il codice non distingue nessuno dei due.

### Requirement: LEAK-05 — `window.matchMedia` è un'ALLOCAZIONE, e va chiesta una volta per query

`window.matchMedia(q)` sembra una lettura e non lo è: il `MediaQueryList` che
restituisce viene registrato presso il media query matcher del documento, che
lo tiene. Chiamarla dentro un render vuol dire coniare una lista nuova a ogni
giro, e nessuno le raccoglie.

Misurato su questa app: gli oggetti `MediaQueryList` vivi sono passati da 379 a
1120 in 104 minuti con la macchina ferma e nessuno che la toccasse.

Il sistema DEVE tenere **una sola lista per query per l'intera sessione**
(`client/src/lib/mediaQuery.ts`), e ogni chiamante DEVE passare di lì invece di
chiamare `window.matchMedia` inline.

Il cancello DEVE misurare la PENDENZA, non il totale: si sostituisce
`window.matchMedia` con un finto che conta, si montano e smontano i hook N
volte, e si asserisce che il conteggio smetta di crescere coi cicli. Un totale
assoluto passerebbe anche con un leak lento, che è esattamente la forma del
difetto che questo requisito esiste per prendere.

### Requirement: COALESCE-01 — Il primo evento NON aspetta, la raffica costa DUE letture

Chi ha appena mosso qualcosa NON SHALL aspettare: il primo evento di una raffica
SHALL far partire la lettura SUBITO. Gli eventi che arrivano nella stessa finestra
SHALL costare UNA seconda lettura in coda, non una per evento.

La lettura finale SHALL avvenire sempre DOPO l'ultimo evento della finestra:
altrimenti è la penultima verità a restare sullo schermo. Nessun evento durante la
finestra SHALL significare nessuna lettura in coda. Chiusa la finestra, un evento
nuovo SHALL ripartire subito.

Una risposta SUPERATA NON SHALL scrivere sopra una più recente: due letture che
tornano invertite SHALL lasciare nello store quella emessa per ULTIMA. È il difetto
che non si vede — lo schermo mostra un dato vecchio e sembra solo lento.

Lo smontaggio SHALL spegnere la coda e ogni evento successivo: un lettore smontato
NON SHALL scrivere.

Un errore in una lettura NON SHALL bloccare quelle successive.

#### Scenario: ventiquattro eventi nella stessa finestra
- **GIVEN** una raffica di eventi ravvicinati
- **THEN** SHALL costare due letture, non una per evento

#### Scenario: due letture che tornano invertite
- **GIVEN** la risposta più vecchia che arriva per ultima
- **THEN** nello store SHALL restare quella emessa per ultima

### Requirement: STORAGE-WAL-01 — Una cache di localStorage non si riscrive uguale, e non si riscrive a ogni cambiamento

Il costo di `localStorage` in WebKit non è quanto ci tieni, è **quante volte lo
riscrivi**: il database sta in modalità WAL e WebKit non fa checkpoint finché la
sessione della webview vive, quindi ogni `setItem` appende al giornale tutte le
pagine che sporca. Misurato sulla macchina di chi usa la app il 2026-09-05:
`localstorage.sqlite3-wal` a **5,92 GB**, in crescita di circa 100 MB al giorno,
con `topics-cache` (~1 MB) riscritta a ogni cambiamento dello stato dei topic.

Una cache che serve solo a dipingere il primo fotogramma del prossimo
caricamento SHALL essere scritta attraverso uno scrittore che:

- COALESCE una raffica di scritture in UNA sola, con finestra FISSA dalla prima
  scrittura della raffica. Una finestra scorrevole NON SHALL essere usata:
  mentre un agente aggiorna lo stato di continuo non scatterebbe mai, ed è
  proprio l'ora che va persistita.
- SALTA la scrittura quando i byte sono identici a quelli già memorizzati. Il
  confronto SHALL passare da `getItem` e non da una variabile in memoria: la
  chiave è condivisa fra le finestre, e una memoria locale non vede la
  scrittura dell'altra finestra.
- SCARICA il pendente su `pagehide` e quando il documento diventa nascosto, così
  che chiudere la finestra non perda l'ultimo stato.

La LETTURA al boot NON SHALL cambiare: il primo fotogramma continua a leggere la
cache dal dispositivo, e il ritardo della scrittura non SHALL introdurre nessuno
spostamento di layout al ricarico (vedi PERF-01).

#### Scenario: una raffica di scritture nella stessa finestra
- **GIVEN** cento scritture consecutive della stessa chiave
- **THEN** SHALL raggiungere il giornale UNA sola volta, con l'ultimo valore

#### Scenario: lo stesso identico contenuto
- **GIVEN** un valore uguale byte per byte a quello già memorizzato
- **THEN** nessun `setItem` SHALL essere eseguito

### Requirement: FPS-01 — Il numero dei fotogrammi è VERO, e a riposo la sonda DORME

Il frame rate riportato SHALL essere quello VERO, senza lo scarto di uno che nasce
dal contare i confini invece degli intervalli: se il numero mente, ogni diagnosi
che ci si appoggia parte storta.

A RIPOSO la sonda SHALL DORMIRE fra una raffica e l'altra — è tutto il punto di non
contare i fotogrammi a tempo pieno. In modalità attiva le finestre consecutive
SHALL concatenarsi senza perdere un fotogramma al cambio.

Lo smontaggio SHALL fermare il ciclo.

La sonda NON SHALL misurare quando la finestra è visibile ma NON a fuoco. Senza il
modo di sapere se la finestra è a fuoco SHALL CONTINUARE a misurare, invece di
spegnersi in silenzio: una sonda spenta che sembra accesa è peggio di una sonda
che misura di più.

#### Scenario: schermo fermo
- **GIVEN** nessun cambiamento sullo schermo
- **THEN** la sonda SHALL dormire fra una raffica e l'altra

#### Scenario: finestra visibile ma non a fuoco
- **GIVEN** la finestra in secondo piano ma visibile
- **THEN** NON SHALL essere misurato niente

### Requirement: FOOTPRINT-01 — Due metà non misurate NON fanno zero

L'impronta di memoria SHALL sommare il lato del dispositivo e il lato del server, e
quando UNA delle due non è misurabile il totale SHALL essere dichiarato PARZIALE,
non ridotto in silenzio.

**Quando NESSUNA delle due è misurata NON SHALL uscire un numero.** Zero megabyte e
zero per cento sono affermazioni, e sono false: dicono «non consuma niente» dove la
verità è «non lo so». Un'app FERMA invece misura zero davvero, e quello zero SHALL
restare, non sparire.

Gli script SHALL essere esclusi dal totale.

Lo smorzamento SHALL attenuare l'oscillazione del lato server. Un campione MANCANTE
NON SHALL entrare nella media come zero, e lo stesso campione letto due volte NON
SHALL far avanzare la media: sono i due modi in cui una media si racconta una
storia.

L'etichetta della metrica SHALL dichiarare COSA è stato misurato.

#### Scenario: nessuna delle due metà misurata
- **GIVEN** né il dispositivo né il server misurabili
- **THEN** NON SHALL uscire nessun numero

#### Scenario: lo stesso campione due volte
- **GIVEN** una lettura ripetuta identica
- **THEN** la media NON SHALL avanzare

### Requirement: LAT-AI-01 — Il banco della latenza AI dichiara COSA ha misurato, e cosa no

Il riassunto SHALL riportare la MEDIANA, l'INTERVALLO e il numero di campioni, e
SHALL RIFIUTARE di fare la media di niente.

La tratta del modello SHALL DIRE che la modalità predefinita non ha chiamato
nessun modello, invece di riportare zero millisecondi: zero è un'affermazione, e
in quel caso è falsa. Quando il modello vero era richiesto e nessuno ha risposto,
SHALL essere NOMINATO il modello sintetico usato al suo posto. Se un modello ha
risposto alla sonda ma nessun campione ha prodotto un pezzo, SHALL essere detto.

Il rapporto SHALL scrivere un record che il giudice legge e accetta, SHALL
nominare la modalità, SHALL deduplicare i modelli visti, e SHALL tenere il corpo
della richiesta come una MISURA di dimensione.

**Il rapporto SHALL portare gli inceppamenti INIETTATI**, o una corsa di
falsificazione — fatta apposta per essere lenta — verrebbe letta come una linea di
partenza. E una corsa che HA chiamato un modello SHALL dirlo nel proprio output.

#### Scenario: la modalità predefinita
- **GIVEN** una corsa che non chiama nessun modello
- **THEN** SHALL dichiararlo, e NON SHALL riportare zero millisecondi

#### Scenario: una corsa di falsificazione
- **GIVEN** degli inceppamenti iniettati
- **THEN** il rapporto SHALL portarli

### Requirement: LAT-AI-02 — Il giudice della latenza AI diventa rosso per il motivo GIUSTO

Il giudice SHALL passare quando ogni tratta sta dentro il proprio budget, e SHALL
fallire NOMINANDO la tratta e i campioni. SHALL fallire sulla mediana, e SHALL
fallire anche su UN SOLO campione cattivo con la mediana a posto.

**Una tratta NON MISURATA SHALL essere un fallimento, MAI un passaggio**, e lo
stesso vale per una tratta ASSENTE dal file: sono i due modi in cui un banco di
latenza si racconta di essere veloce.

Il modello NON SHALL far fallire una corsa ordinaria solo perché nessun modello è
stato chiamato; SHALL uscire con un codice PROPRIO quando il modello vero era
richiesto e nessuno ha risposto; e un numero del modello NON SHALL MAI essere
dichiarato fuori budget, perché un budget non ce l'ha.

Il corpo della richiesta SHALL essere giudicato per DIMENSIONE, non per durata, e
SHALL passare esattamente AL tetto.

La corsa SHALL dire ad alta voce se ha SPESO: libera o a pagamento, nominando il
modello, e SHALL dichiarare quando i numeri vengono da una corsa di
falsificazione.

Il rapporto SHALL nominare la MACCHINA: un numero di latenza senza macchina non
significa niente. Gli argomenti SHALL avere ogni inceppamento a zero per difetto,
e un inceppamento che non è un numero positivo SHALL essere RIFIUTATO invece di
far girare in silenzio una linea di partenza.

#### Scenario: una tratta mai misurata
- **GIVEN** una tratta assente dalla misura
- **THEN** SHALL essere un fallimento

#### Scenario: un solo campione oltre il budget
- **GIVEN** mediana dentro il budget e un campione fuori
- **THEN** SHALL fallire

### Requirement: LAT-UI-01 — Un banco che non ha misurato lo DICE, e uno zero è una bugia

Il rapporto SHALL pubblicare ogni gesto su una misura sana, SHALL marcare come
LETTI — non misurati qui — i gesti che vengono da un'altra fonte, SHALL dire
quando due gesti sono lo STESSO gesto, e SHALL scrivere di cosa è FATTA
l'apertura a freddo, non solo quanto dura. Quando la costante del sipario non si
trova, SHALL ammetterlo invece di indovinare.

I volumi della bacheca SHALL essere ordinati per DIMENSIONE e non per stringa, e
accanto a ogni numero SHALL essere detto quante card sono davvero arrivate a
schermo.

**Senza misura SHALL uscire NON MISURABILE, non un rapporto coi buchi.** Uno ZERO
SHALL essere chiamato BUGIA, non un'app velocissima. Un gesto MANCANTE SHALL
essere un'accusa, non un silenzio.

Una misura presa PRIMA di questa corsa SHALL essere RIFIUTATA, e così una senza
istante quando la freschezza è richiesta; una presa dopo l'inizio SHALL essere
accettata.

La corsa SHALL dire quando i numeri vengono da una corsa DELIBERATAMENTE
rallentata, e SHALL stampare la MACCHINA: un tempo di avvio senza macchina è un
numero che non parla di niente.

Il confronto con la corsa inceppata SHALL essere verde quando OGNI gesto ha
notato il difetto iniettato, e rosso sull'UNICO che non si è mosso. SHALL
rifiutare un riferimento che era esso stesso inceppato, una corsa inceppata che
non porta l'inceppamento richiesto, e SHALL NOMINARE un gesto SPARITO invece di
saltarlo.

La lettura di una misura SHALL rifiutare un documento valido di FORMA sbagliata.

#### Scenario: nessuna misura
- **GIVEN** nessun artefatto di misura
- **THEN** SHALL uscire «non misurabile», non un rapporto con dei buchi

#### Scenario: un gesto sparito dalla corsa inceppata
- **GIVEN** un gesto presente nel riferimento e assente nell'inceppata
- **THEN** SHALL essere nominato

### Requirement: MEM-BENCH-01 — Il banco della memoria sbaglia in SILENZIO, e questi sono i tre modi

Un banco fallisce rumorosamente quando non riesce ad accendere un server.
Fallisce in SILENZIO quando la camminata sull'albero perde un ramo, quando il
controllo di piattaforma ricade su una metrica che nessuno ha nominato, e quando
la pendenza è calcolata da punti che non stanno su una retta: in ognuno di quei
casi un numero viene stampato lo stesso, ed è sbagliato.

La metrica SHALL essere quella che ciascuna piattaforma può rispondere
ONESTAMENTE, e SHALL essere restituito NIENTE invece di una metrica che non si
può difendere.

La lettura della tabella dei processi SHALL conservare l'intera riga di comando,
spazi compresi, e SHALL saltare ciò che non è una riga di processo.

La camminata SHALL raggiungere i NIPOTI — è lì che la memoria sta davvero — SHALL
unire radici sovrapposte senza contare due volte lo stesso processo, SHALL
scartare una radice assente dalla tabella invece di inventarla, SHALL TERMINARE su
un ciclo, NON SHALL mai contare il processo iniziale, e SHALL trovare il ponte
staccato dal suo socket senza contare chi lo cerca.

**La pendenza è il numero per cui il banco esiste.** SHALL recuperare il costo
marginale da punti su una retta, SHALL riportare una qualità di adattamento BEN
SOTTO il massimo quando i punti non stanno su una retta, SHALL pubblicare i passi
CONSECUTIVI e non solo la retta adattata, SHALL ORDINARE i punti prima di
adattare — così l'ordine di misura non cambia la risposta — e SHALL dire NIENTE
invece di zero quando le prove non bastano. Un insieme piatto SHALL essere
pendenza zero con adattamento perfetto, non una divisione per zero.

La mediana SHALL resistere a un campione cattivo; i conteggi SHALL essere letti,
ordinati e deduplicati; e l'ambiente SHALL essere ripulito dalle variabili degli
strumenti, così i due lati del confronto partono puliti.

#### Scenario: punti che non stanno su una retta
- **GIVEN** misure disperse
- **THEN** la qualità dell'adattamento SHALL essere ben sotto il massimo

#### Scenario: un ciclo nell'albero dei processi
- **GIVEN** una tabella con un ciclo
- **THEN** la camminata SHALL terminare

### Requirement: BENCHREP-01 — Un buco non si stampa MAI come un numero

Un banco marcisce in modi che uno scatto di schermo non mostra: un numero perde la
macchina su cui è stato preso, una misura assente comincia a stamparsi come zero,
una riga vecchia continua a essere ripubblicata perché nessuno guarda la data.

Un buco SHALL essere PAROLE, non uno zero; uno zero MISURATO SHALL restare uno
zero, perché è stato misurato; i valori non numerici SHALL essere buchi, non
numeri; e i decimali SHALL essere al massimo due, senza zeri in coda.

L'età SHALL contare giorni interi, e un giorno illeggibile SHALL essere NIENTE,
mai zero.

Il giudice SHALL uscire: pulito quando ogni numero porta la propria macchina e il
proprio giorno; con un codice DISTINTO quando NESSUNA fonte ha prodotto un numero;
e in errore quando un numero ha perso la macchina, ha perso il giorno, porta un
giorno che non è un giorno, o è più vecchio di quanto chiesto — e in quest'ultimo
caso **la cura SHALL stare nel messaggio**. Una riga fresca SHALL sopravvivere
allo stesso controllo.

Un artefatto che esiste ma non si è potuto leggere SHALL essere un errore. Una
fonte ASSENTE SHALL essere un buco per difetto, e un errore quando tutte sono
richieste. **Un buco SENZA MOTIVO SHALL essere un errore: un buco senza motivo si
legge come una scusa.** Una riga senza numero che non lo ammette SHALL essere un
errore, e così una riga dichiarata buco che porta comunque un numero.

La tabella stampata SHALL portare macchina, giorno e sorgente SULLA RIGA, SHALL
marcare una costante COME costante — così nessuno ottimizza una decisione — SHALL
stampare il motivo sotto un buco e mai uno spazio nudo, e SHALL nominare il
comando che rilancia ogni fonte. Il formato di testo NON SHALL lasciare che un
percorso o un separatore si mangino la riga, e SHALL portare gli STESSI fatti.

L'innesto nel documento SHALL sostituire il blocco lasciando intatta la prosa, e
SHALL RIFIUTARE quando i marcatori mancano o sono incrociati.

Il costo marginale di una card SHALL essere la pendenza fra i due disegni
misurati, e NIENTE — non zero — quando ne manca uno.

La raccolta su un albero VUOTO SHALL produrre una tabella di buchi DICHIARATI e
un codice di uscita distinto, mai un verde di niente; un artefatto malformato
SHALL essere NOMINATO, non saltato; e gli assi che nessuno ha misurato SHALL
essere dichiarati anche quando ogni artefatto è presente.

#### Scenario: un buco senza motivo
- **GIVEN** una riga senza numero e senza spiegazione
- **THEN** SHALL essere un errore

#### Scenario: un albero senza artefatti
- **GIVEN** nessuna misura sul disco
- **THEN** SHALL uscire una tabella di buchi dichiarati, non un verde

### Requirement: STREAMB-01 — La forma di una raffica si legge sull'orologio della PAGINA

La raffica SHALL essere letta sull'orologio della PAGINA, non su quello di chi
pilota: sono due tempi diversi, e quello di chi pilota non sa cosa ha fatto il
disegno.

Una raffica CHIUSA sulla scadenza SHALL essere dichiarata RIMASTA INDIETRO, con
quello che è riuscita a prendere — non silenziosamente completa.

Lo spostamento di disegno NON ATTRIBUITO SHALL essere attribuito FUORI dalla
lista. Il tempo occupato NON SHALL MAI essere riportato NEGATIVO, nemmeno quando
la sonda ha superato la propria calibrazione.

La finestra tranquilla SHALL misurare la finestra e ciò che vi si è mosso, senza
un bersaglio da raggiungere, e SHALL RIFIUTARE una finestra mai trascorsa e una
pagina già rotta in partenza.

Il riassunto SHALL prendere la MEDIANA delle raffiche, non la media, e SHALL
CONSERVARE ogni corsa. SHALL unire ciò che si è mosso attraverso le raffiche, e
SHALL pretendere il supporto della misura da TUTTE.

La mediana SHALL essere un valore MISURATO su un conteggio dispari e il punto
medio su uno pari. Un rapporto con zero sotto SHALL essere NIENTE, mai zero.

Il rapporto SHALL pubblicare l'intestazione come rapporti fra lungo e corto, SHALL
portare i testimoni su cui il giudice si blocca e la manopola che segnala, e SHALL
SOLLEVARE invece di serializzare un buco dove dovrebbe esserci uno scenario.

#### Scenario: una raffica chiusa sulla scadenza
- **GIVEN** una raffica che non si è esaurita da sé
- **THEN** SHALL essere dichiarata rimasta indietro

#### Scenario: un rapporto con denominatore zero
- **GIVEN** un denominatore nullo
- **THEN** SHALL uscire niente, non zero

### Requirement: STREAMB-02 — Un pezzo di flusso costa UGUALE in un thread lungo e in uno corto

Il giudice SHALL essere verde quando un pezzo costa uguale nelle due lunghezze, e
rosso quando il costo scala con la trascrizione — sia a orologio da parete sia sul
thread principale, che sono due misure diverse e vanno guardate entrambe. Un
rapporto appena DENTRO il limite SHALL restare verde.

Lo spostamento di disegno fuori dalla lista SHALL essere addebitato al flusso solo
SOPRA la linea di partenza tranquilla, e SHALL essere NOMINATO chi si è mosso.

**Un rapporto con uno zero sotto NON SHALL essere chiamato perfetto: SHALL essere
rifiutato.**

SHALL essere RIFIUTATA: una misura la cui trascrizione lunga non era lunga; una
senza NESSUN testimone della lunghezza; una il cui thread lungo non ha mai
prodotto un giro di scorrimento; una più vecchia della corsa che l'ha chiesta; una
che non sa dire quando è stata presa; e una in cui una delle due trascrizioni non
è stata misurata.

Un impedimento SHALL contare PIÙ di uno sforamento vero: prima si dice che la
misura non vale, poi si discute il numero.

Il ritmo assorbito SHALL essere dichiarato un PAVIMENTO quando il client non è
mai rimasto indietro, e il ritmo del client quando lo è; e SHALL essere riportato
il tetto trovato DAVVERO quando il client non ha tenuto il passo. Quando la misura
dei fotogrammi lunghi non è disponibile, SHALL essere detto.

Il rapporto SHALL essere NIENTE — mai zero — con denominatore nullo o con un lato
non numerico, e SHALL essere arrotondato a due decimali. La lettura SHALL
rifiutare un documento valido che non è una misura.

#### Scenario: il costo scala con la trascrizione
- **GIVEN** un pezzo che costa di più nel thread lungo
- **THEN** il giudice SHALL essere rosso

#### Scenario: una misura senza testimone della lunghezza
- **GIVEN** nessuna prova che il thread lungo fosse lungo
- **THEN** SHALL essere rifiutata

### Requirement: LAT-AI-03 — «Quanto è veloce l'AI» si spezza in ciò che è nostro e ciò che non lo è

Questa app non ha un modello: pilota agenti a riga di comando attraverso un
terminale. Quindi «quanto è veloce l'AI» è una domanda su DUE cose diverse, e
tenerle insieme produce un numero che nessuno può migliorare.

La misura SHALL separare il costo di INVIO, il costo di CONSEGNA e il tempo del
MODELLO. I primi due sono nostri e hanno un budget; il terzo non è nostro e NON
SHALL avere un budget.

#### Scenario: una corsa senza modello
- **GIVEN** la modalità che non chiama nessun modello
- **THEN** SHALL essere riportato l'overhead nostro, dichiarando l'assenza del modello

### Requirement: LAT-AI-04 — Un banco che misura un turno DICHIARA quando la macchina non può chiuderne uno

La modalità che non chiama nessun modello è gratuita, ma non è priva di
provider: ogni tratto si misura fra i fotogrammi di un turno, e un turno si
chiude solo sul fotogramma finale. Sul banco isolato quel fotogramma arriva
comunque — la CLI agente c'è, non è autenticata, e risponde «Not logged in» —
ma su una macchina che quella CLI non ce l'ha non risponde nessuno.

Su otto notti di fila il banco notturno è stato rosso per questo, prova e
ritentativo, con l'errore «il turno non è mai finito». Un cancello rosso per una
ragione ambientale insegna a ignorare i rossi, ed è precisamente quello che quel
mese dimostra.

Il banco SHALL riconoscere l'ambiente CHIEDENDOGLIELO — un invio solo, con un
budget breve — e NON SHALL dedurlo da una variabile d'ambiente o da un elenco di
provider «pronti»: pronto vuol dire configurato, non raggiungibile.

Quando il server HA ACCETTATO il messaggio e NESSUN turno si è chiuso, il banco
SHALL DICHIARARSI SALTATO con una riga che nomina la causa. Qualunque altra
forma di fallimento — l'invio che non parte, il messaggio che non torna — è
NOSTRA e SHALL restare rossa.

Il riconoscimento SHALL basarsi sui FOTOGRAMMI osservati, non sul testo
dell'errore: una formulazione non è un fatto sulla macchina.

#### Scenario: runner senza CLI agente
- **GIVEN** un messaggio accettato dal server e nessun turno che si chiude
- **THEN** il banco SHALL risultare saltato, con la causa scritta

#### Scenario: il nostro percorso di invio è rotto
- **GIVEN** un messaggio che il server non conferma mai
- **THEN** il banco SHALL restare rosso

### Requirement: STREAMB-03 — Un token che arriva costa uguale, per quanto lungo sia il trascritto

Le altre misure guardano un trascritto FERMO o cronometrano un gesto. Nessuna
guarda cosa costa un token MENTRE arriva, e se quel costo cresce con il trascritto
in cui atterra.

SHALL essere misurato l'assorbimento della STESSA raffica in un trascritto LUNGO
e in uno CORTO, e il rapporto SHALL essere pubblicato in un rapporto.

#### Scenario: la stessa raffica nelle due lunghezze
- **GIVEN** un trascritto lungo e uno corto
- **THEN** SHALL essere misurato l'assorbimento di entrambi

### Requirement: DRAGFR-01 — Il tempo di fotogramma DURANTE un trascinamento si misura, e non è il cancello

Il tempo di fotogramma MENTRE una card viene trascinata attraverso le colonne
SHALL essere misurato. Questa è la MISURA, non il cancello: il cancello è un
comando a parte, che legge ciò che questa produce.

#### Scenario: una card trascinata fra le colonne
- **GIVEN** un trascinamento completo
- **THEN** SHALL essere prodotta la misura del tempo di fotogramma

### Requirement: IDLE-01 — A riposo NON si chiedono fotogrammi a vuoto

Con l'app ferma e niente che succede NON SHALL esserci una pompa di richieste di
fotogramma né di osservatori di dimensione.

Una chat aperta e ferma SHALL assestare la lista virtualizzata e poi TACERE. Un
terminale aperto e fermo NON SHALL chiedere fotogrammi a vuoto.

Nel guscio nativo, a finestra NASCOSTA, i canali della pane browser SHALL
tacere, e al ritorno SHALL recuperare: tacere per sempre sarebbe il difetto
opposto.

#### Scenario: una chat aperta e ferma
- **GIVEN** nessuna attività
- **THEN** NON SHALL essere chiesto nessun fotogramma dopo l'assestamento

#### Scenario: la finestra nascosta e poi di nuovo visibile
- **GIVEN** un ciclo nascondi/mostra
- **THEN** i canali SHALL tacere e poi recuperare

### Requirement: PERFPANEL-01 — Il pannello dice NUMERI, e dice anche quando il numero non c'è

Il pannello SHALL aprirsi dal menu «Topics» e mostrare NUMERI, non chiavi.

*(Diceva «dalla barra di stato», e quella barra sul desktop non esiste piu': il
suo contenuto e' entrato nel menu — vedi SIDEBAR-STATUS-01. Il gesto cambia, la
regola no: si arriva ai numeri da UN posto solo, e quel posto e' dove sta scritto
il nome dell'app.)*

Quando il grosso dell'impronta è già stato compresso o mandato su disco SHALL
DIRLO, invece di lasciar credere che l'app tenga tutto in memoria. Sotto
PRESSIONE vera SHALL dire la cosa OPPOSTA — che conviene chiudere qualcosa —
perché sono due situazioni che si somigliano nei numeri e chiedono gesti opposti.

La PRIMA RIGA del menu SHALL dire quanta memoria, senza espandere il pannello.

*(Diceva «la BARRA, senza aprire niente». La meta' che contava non era «senza
aprire»: era che il numero non stesse sepolto sotto un secondo gesto, perche' un
costo che si paga per essere letto non viene letto. Quella meta' resta: la riga
chiusa del menu porta gia' il pallino del carico, la memoria e la CPU
(`metrics-total`). Cio' che si perde e' un'occhiata senza gesti, e in cambio
la colonna torna tutta ai topic; cio' che NON si perde e' l'allarme, che non e'
una statistica e SHALL restare visibile a menu chiuso — SIDEBAR-STATUS-01.)*

**Una misura PARZIALE NON SHALL produrre nessuna riga**, invece di inventarne
una: una riga con dentro mezzo dato si legge come un dato.

#### Scenario: impronta quasi tutta su disco
- **GIVEN** la maggior parte compressa o spostata
- **THEN** il pannello SHALL dirlo

#### Scenario: una misura parziale
- **GIVEN** solo una metà misurabile
- **THEN** NON SHALL comparire nessuna riga inventata

### Requirement: SCROLLFLU-01 — I fotogrammi persi scorrendo un trascritto si contano

Scorrendo un trascritto SHALL essere misurato quanti fotogrammi si perdono. È il
banco della fluidità, e produce il numero su cui il cancello decide.

#### Scenario: uno scorrimento su un trascritto lungo
- **GIVEN** un trascritto caricato
- **THEN** SHALL essere prodotto il conteggio dei fotogrammi persi

### Requirement: BOOT-NET-01 — Ogni lettura di boot parte UNA volta

Al ricarico della app, una stessa lettura (`GET` dello stesso URL) chiesta da
più componenti che montano nello stesso istante SHALL partire UNA volta sola:
chi la chiede mentre è in volo riceve la stessa risposta, e per una finestra
breve (≤ 2 s) anche chi la chiede subito dopo. Un errore o una risposta non-2xx
NON SHALL essere memorizzati: il chiamante successivo richiede alla rete.

La finestra vale per le letture di BOOT, non per una lettura che risponde a un
avviso di cambiamento: chi rilegge il feed perché un evento `task:*` glielo ha
detto, perché un lettore glielo ha chiesto o perché il socket è tornato SHALL
raggiungere il server, per quanto giovane sia l'ultima risposta. Una risposta
di prima dell'evento è la risposta sbagliata, e servita alla lettura di coda
di una raffica lascia la board indietro senza un evento successivo che la
corregga (KANBAN-06).

Il motivo è la coda: il browser tiene sei connessioni per host, e al ricarico
partivano 90 richieste `/api/*` (misurato il 05/09/2026), fino a 53 insieme —
`claude-prefs-skip` cinque volte, il roster dei terminali cinque, il feed
globale della board due, a 84 KB l'una. La `POST` della storia della chat
visibile aspettava dietro a tutte e il sipario restava su per 1,2 s.

Le scritture che ri-seminano il server alla riconnessione del socket NON SHALL
scattare alla PRIMA connessione della pagina: non è una riconnessione, e la
ri-semina ripeteva la PUT del boot, byte per byte.

Un «senza icona» verificato e persistito SHALL rinfrescare la propria data a
ogni riconferma: prima la data non si aggiornava mai, quindi dopo dodici ore
ogni ricarico ri-sondava tutti i progetti senza icona, per sempre.

#### Scenario: cinque componenti chiedono lo stesso URL nello stesso frame
- **GIVEN** cinque chiamate allo stesso `GET` prima che la prima risponda
- **THEN** SHALL partire UNA sola richiesta di rete, e ognuna delle cinque SHALL ricevere un corpo leggibile

#### Scenario: la risposta è un errore
- **GIVEN** una lettura coalescente fallita (rete o non-2xx)
- **THEN** la chiamata successiva SHALL richiedere alla rete, non ricevere l'errore memorizzato

#### Scenario: la prima connessione del socket
- **GIVEN** la pagina appena caricata che ha già scritto il proprio layout
- **THEN** l'apertura del socket NON SHALL far riscrivere lo stesso layout
