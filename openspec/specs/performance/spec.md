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
