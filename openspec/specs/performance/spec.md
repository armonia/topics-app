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
   interazione, e giudicarla contro un budget per heap, nodi DOM e listener.

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
