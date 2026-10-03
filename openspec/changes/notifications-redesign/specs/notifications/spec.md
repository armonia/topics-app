# Notifiche: uno stato di attenzione solo, sul server

## ADDED Requirements

### Requirement: ATTN-01 — Ogni soggetto ha UNO stato di attenzione, e lo compone il server

Ogni chat (`topic:<id>`), terminale (`terminal:<id>`) e card (`task:<id>`) SHALL avere
uno e un solo stato di attenzione: `idle`, `working`, `background`, `needs-you` (con
motivo `question`, `permission`, `plan`, `review` o `parked`) o `finished` (con esito
`done` o `error`), più un'epoca e l'ultima epoca vista. Un soggetto è **acceso** quando è
`needs-you`, o quando è `finished` e la sua epoca non è stata vista.

Lo stato SHALL comporlo il server da turno, lavoro in background, attesa di una persona,
ultimo turno, stato della card e archiviazione, con questa precedenza: archiviato o
cancellato → `idle`; topic di un agente di board → `idle`; attesa aperta → `needs-you`;
card in review o parcheggiata → `needs-you`; turno aperto → `working`; ultimo turno in
errore non visto → `finished(error)`; compiti in background → `background`; ultimo turno
finito non visto → `finished(done)`; altrimenti `idle`.

Un solo modulo SHALL scrivere lo stato e trasmetterlo (`attention:init`,
`attention:updated`). Tab di pane, riga della sidebar, riga e tab di progetto, card del
gruppo, vista per stato, menu agenti, inbox, Dock, tray e badge PWA SHALL derivare solo
da quello stato, con le stesse due funzioni per soggetto e per insieme di soggetti.
Nessuna superficie SHALL leggere la fase Claude, le righe del registro o un segno in
memoria per decidere se accendersi.

#### Scenario: la precedenza, a tabella
- **GIVEN** ogni combinazione di archiviato, agente di board, attesa, card, turno aperto, esito dell'ultimo turno, visto e compiti in background
- **WHEN** si compone lo stato
- **THEN** il risultato SHALL essere quello della prima regola dell'elenco che si applica

#### Scenario: una chat e un terminale con hook finiti contano uguale
- **GIVEN** una chat finita e un terminale claude-code con hook finito, nessuno dei due visto
- **WHEN** si leggono tab, riga, menu agenti, campanella e Dock
- **THEN** entrambi SHALL essere blu con un numero sulla tab e sulla riga
- **AND** il menu agenti, la campanella e il Dock SHALL dire 2

#### Scenario: un terminale senza hook finito si accende dappertutto o da nessuna parte
- **GIVEN** un terminale senza hook dentro un gruppo che ha finito e non è stato visto
- **WHEN** si leggono la sua tab, la sua riga, la riga di progetto e la card del gruppo
- **THEN** tutte e quattro SHALL avere `data-attention="done"`

#### Scenario: nessuna chat è insieme in background e finita
- **GIVEN** una chat con un Agent in background
- **WHEN** si compone il menu agenti
- **THEN** la chat SHALL stare fra le attive in background e NON SHALL stare fra le finite

#### Scenario: il topic di un agente di board
- **GIVEN** il topic di una card dispatchata che finisce un turno o arriva a un permesso
- **THEN** il suo stato SHALL essere `idle`, e ciò che serve alla persona SHALL comparire come `needs-you` della card

### Requirement: ATTN-02 — Il lavoro in background non chiede niente, e la fine vera avvisa una volta

Un turno che finisce lasciando compiti in volo (Bash o Agent con `run_in_background`,
Workflow, Monitor, CronCreate non ricorrente, `run_command` di Topics) SHALL portare il
soggetto in `background`: niente fill, niente numero, niente banner, niente spinta,
niente riga di cronologia, e nessun conto in campanella, Dock, tray o vista «Ti aspetta».
Il glifo grigio «in background» SHALL restare l'unico segno.

`stream:end` SHALL portare `background: { count, kinds }`, calcolato prima del frame
dallo stesso dato che usa il goal loop. La CLI che si sta già svegliando (`wake-queued`)
conta come compito in volo.

Un turno risvegliato che chiude con altri compiti ancora in volo SHALL lasciare il
soggetto in `background`, senza avvisi. Quando l'ultimo compito è tornato e il turno che
lo porta chiude, il soggetto SHALL passare a `finished(done)` con un'epoca nuova: un
avviso solo per tutta l'attesa. Se l'ultimo compito torna e nessun turno si apre entro
5 s, il soggetto SHALL passare a `finished(done)` se l'ultimo turno non era stato visto,
altrimenti a `idle`.

Un turno in errore SHALL dare `finished(error)` anche con compiti in volo.

#### Scenario: una chat lancia i verifier e aspetta
- **GIVEN** una chat non a fuoco il cui turno lancia un Agent e un Bash in background e risponde «Lanciati, aspetto»
- **WHEN** arriva `stream:end`
- **THEN** il frame SHALL portare `background.count = 2`
- **AND** lo stato SHALL essere `background`, senza riga di cronologia, senza spinta e senza banner
- **AND** la tab e la riga NON SHALL avere fill né numero, e campanella e Dock NON SHALL cambiare

#### Scenario: uno di tre è tornato
- **GIVEN** la chat in `background` con tre compiti
- **WHEN** il primo torna, la CLI si sveglia e il turno chiude con «1 di 3 arrivato»
- **THEN** lo stato SHALL tornare `background` senza epoca nuova, e il non-letto SHALL salire di uno senza che nessuna superficie lo mostri

#### Scenario: l'ultimo torna
- **GIVEN** la chat in `background` con un solo compito, e due messaggi non letti dei turni risvegliati
- **WHEN** l'ultimo compito torna e il turno che lo porta chiude senza altro in volo
- **THEN** lo stato SHALL essere `finished(done)` con un'epoca nuova
- **AND** SHALL partire un banner solo, e la riga e la tab SHALL mostrare 3

#### Scenario: il compito torna e la CLI non si sveglia
- **GIVEN** una chat in `background` il cui ultimo turno non era stato visto
- **WHEN** l'ultimo compito torna e per 5 s non si apre nessun turno
- **THEN** lo stato SHALL essere `finished(done)`

#### Scenario: un Monitor armato
- **GIVEN** una chat che ha armato un Monitor e chiude il turno
- **THEN** lo stato SHALL essere `background`, e la tab NON SHALL essere blu né contata in campanella

#### Scenario: un errore con compiti in volo
- **GIVEN** una chat con un Bash in background
- **WHEN** il turno successivo finisce in errore
- **THEN** lo stato SHALL essere `finished(error)`, rosso, contato

### Requirement: ATTN-03 — I compiti in background si contano per id e si chiudono col loro avviso

Il server SHALL tenere per ogni sessione i compiti in background per id: entra un id per
ogni lancio, esce quando arriva l'avviso di fine di quell'id (`<task-notification>` nel
transcript, consegna o fine del Monitor anche per scadenza, primo scatto o CronDelete di
un cron non ricorrente, uscita del processo di un `run_command`). Per le chat headless la
fonte SHALL essere lo snapshot dei compiti che la CLI stampa; per i terminali gli hook e
il transcript. Un CronCreate ricorrente NON SHALL contare.

La macchina delle fasi SHALL mettere `watching` allo `Stop` quando la sessione ha almeno
un compito in volo, qualunque sia il tool che l'ha lanciato, e `awaiting-user` quando non
ne ha.

La mappa dei compiti di un terminale SHALL sopravvivere a un ricarico del server.
`SessionEnd`, l'uscita del PTY o del figlio CLI SHALL svuotarla. Un riavvio del server
che trova una sessione senza processo vivo SHALL portarla a `idle` senza avvisi.

#### Scenario: Bash, Agent e Workflow in un terminale
- **GIVEN** un terminale claude-code con hook
- **WHEN** un turno lancia un Bash con `run_in_background`, oppure un Agent con `run_in_background`, oppure un Workflow, e poi arriva `Stop`
- **THEN** la fase SHALL essere `watching` e lo stato di attenzione `background`

#### Scenario: il Monitor scaduto di un terminale
- **GIVEN** un terminale in `watching` per un solo Monitor
- **WHEN** il transcript dice che il Monitor è scaduto e arriva lo `Stop` del turno dopo
- **THEN** la fase SHALL essere `awaiting-user` e lo stato `finished(done)`

#### Scenario: un cron ricorrente
- **WHEN** un turno crea un cron ricorrente e finisce
- **THEN** il cron NON SHALL entrare nei compiti e lo stato SHALL essere `finished(done)`

#### Scenario: il server si ricarica con un terminale in attesa
- **GIVEN** un terminale con un Agent in volo e il bridge PTY vivo
- **WHEN** il server si ricarica
- **THEN** il terminale SHALL essere ancora `background` con lo stesso id in volo

#### Scenario: il server riparte e il processo non c'è più
- **GIVEN** una chat in `working` o `background` e nessun processo vivo dopo il riavvio
- **THEN** lo stato SHALL essere `idle`, senza banner, spinta né riga

### Requirement: ATTN-04 — Una persona in mezzo è «ti serve», da qualunque porta arrivi

Un soggetto SHALL essere `needs-you` quando aspetta una persona: una domanda
(`mcp__topics__ask_user_question` del bridge, `AskUserQuestion`), un permesso (permission
bridge, `awaiting-approval`, `paused`), un piano da approvare, una card in `review`, una
card parcheggiata. Lo stato di attenzione SHALL ascoltare gli eventi di attesa dei bridge
come il dispatcher.

`needs-you` SHALL restare acceso finché l'attesa finisce: risposta data, permesso deciso,
piano approvato o respinto, card uscita da review, card rimessa in coda, cancellata o
archiviata. Il visto NON SHALL spegnerlo. Un piano da approvare NON SHALL essere
annunciato come turno finito.

#### Scenario: una domanda MCP in una chat
- **GIVEN** una chat headless che chiama `mcp__topics__ask_user_question`
- **WHEN** il bridge apre l'attesa
- **THEN** lo stato SHALL essere `needs-you(question)` con la domanda in `detail`, ambra su tab, riga, card del gruppo e progetto
- **AND** la fase NON SHALL essere `tool-running`

#### Scenario: un permesso dal permission bridge
- **WHEN** il permission bridge apre un'attesa per un comando Bash
- **THEN** lo stato SHALL essere `needs-you(permission)` col comando in `detail`

#### Scenario: un piano da approvare
- **GIVEN** una chat in plan mode il cui turno chiude con un piano
- **WHEN** si apre il pannello di approvazione
- **THEN** lo stato SHALL essere `needs-you(plan)`
- **AND** NON SHALL esserci una riga «Claude ha finito di rispondere» né un `finished`

#### Scenario: la risposta
- **GIVEN** una chat in `needs-you(question)`
- **WHEN** la persona risponde e il turno riprende
- **THEN** lo stato SHALL essere `working`, e la chat NON SHALL più contare

#### Scenario: il permesso scaduto
- **WHEN** un `awaiting-approval` scade in `paused`
- **THEN** lo stato SHALL restare `needs-you(permission)` senza epoca nuova

#### Scenario: guardare non spegne l'ambra
- **GIVEN** una chat `needs-you(question)` a fuoco con la finestra sveglia
- **WHEN** passa la soglia del visto
- **THEN** SHALL restare ambra e contata

#### Scenario: la card parcheggiata rimessa in coda
- **GIVEN** una card parcheggiata, contata in campanella e Dock
- **WHEN** la persona la rimette in coda
- **THEN** il soggetto della card SHALL tornare spento e la campanella e il Dock SHALL calare di uno

#### Scenario: la card esce da review
- **WHEN** una card in review viene approvata, cancellata o archiviata
- **THEN** il suo soggetto SHALL spegnersi

### Requirement: ATTN-05 — «Finito» vale una volta, solo con qualcosa dentro, e si spegne guardandolo

Un turno che finisce con un messaggio visibile e nessun compito in volo SHALL portare il
soggetto in `finished(done)` con un'epoca nuova. Un turno in errore SHALL portarlo in
`finished(error)`. Uno stop della persona o del watchdog SHALL portarlo in `idle` senza
avvisi.

Un turno risvegliato scartato perché vuoto NON SHALL alzare il non-letto né creare
un'epoca. Il non-letto SHALL salire solo per un turno che lascia un messaggio visibile.

`finished` SHALL spegnersi col visto (ATTN-06) e restare spento finché non arriva
un'epoca nuova: una chat letta e ferma su `awaiting-user` NON SHALL contare su nessuna
superficie.

#### Scenario: un turno pulito
- **GIVEN** una chat non a fuoco
- **WHEN** il turno finisce con una risposta e niente in volo
- **THEN** lo stato SHALL essere `finished(done)`, epoca +1, blu con numero su tab e riga, +1 in campanella e Dock

#### Scenario: un tick di Monitor a cui il modello non risponde
- **GIVEN** una chat in `background` per un Monitor
- **WHEN** arriva un turno risvegliato che viene scartato perché vuoto
- **THEN** il non-letto NON SHALL cambiare e NON SHALL nascere un'epoca

#### Scenario: un errore
- **WHEN** un turno finisce in errore
- **THEN** lo stato SHALL essere `finished(error)`, rosso, contato

#### Scenario: uno stop della persona
- **WHEN** la persona ferma il turno
- **THEN** lo stato SHALL essere `idle` senza banner, spinta né riga

#### Scenario: la chat letta non torna a «1»
- **GIVEN** una chat `finished(done)` con la fase `awaiting-user`
- **WHEN** la persona la guarda per la soglia e poi passa a un'altra pane
- **THEN** né la tab né la riga SHALL avere un numero, e campanella e Dock NON SHALL contarla

### Requirement: ATTN-06 — Il «visto» è della persona, sta sul server e vale per un'epoca

Il visto SHALL essere uno solo per soggetto e per persona, salvato sul server come
ultima epoca vista. Una porta sola (`POST /api/attention/seen` con `{subject, epoch}`)
SHALL alzarlo, azzerare il non-letto del topic, segnare viste le righe di cronologia del
soggetto fino a quell'epoca e trasmettere `attention:updated` a ogni finestra e
dispositivo della persona, SEMPRE, anche quando non ha cambiato niente.

Un visto per un'epoca NON SHALL spegnere un'epoca più nuova.

Il frame `focus` SHALL portare il soggetto a fuoco e se la finestra è sveglia, e la
chiusura della socket SHALL cancellarlo. Un'epoca che nasce mentre il suo soggetto è a
fuoco in una finestra sveglia della persona SHALL nascere vista: niente numero, niente
riga non vista, niente spinta.

Le socket degli ospiti NON SHALL scrivere il visto né ricevere `attention:*`.

#### Scenario: letta sul Mac, spenta ovunque
- **GIVEN** una chat `finished(done)` accesa nella finestra A, nella finestra B e sul telefono
- **WHEN** la persona la guarda in A per la soglia
- **THEN** in B e sul telefono la tab, la riga e il numero SHALL spegnersi senza nessun gesto

#### Scenario: un terminale guardato senza righe
- **GIVEN** un terminale senza hook finito, senza nessuna riga di cronologia
- **WHEN** la persona lo guarda in A
- **THEN** SHALL partire `attention:updated` e in B il terminale SHALL spegnersi

#### Scenario: un'epoca più nuova della lista
- **GIVEN** la inbox mostra una chat all'epoca 4
- **WHEN** arriva l'epoca 5 e poi la persona preme «Segna tutte viste»
- **THEN** la chat SHALL restare accesa per l'epoca 5

#### Scenario: la chat davanti finisce
- **GIVEN** una chat a fuoco in una finestra sveglia
- **WHEN** finisce cinque turni
- **THEN** ogni epoca SHALL nascere vista, nessuna spinta SHALL partire e il numero del Dock NON SHALL cambiare

#### Scenario: la finestra è dietro un'altra app
- **GIVEN** una chat a fuoco in una finestra non sveglia
- **WHEN** il turno finisce
- **THEN** l'epoca SHALL nascere non vista e contare, e SHALL spegnersi quando la finestra torna davanti e passa la soglia

#### Scenario: un ospite
- **WHEN** una socket ospite manda un visto
- **THEN** il server SHALL scartarlo e lo stato NON SHALL cambiare

### Requirement: ATTN-07 — Aprire, ricaricare o riconnettere non riaccende e non suona

A ogni apertura della socket della persona il server SHALL mandare `attention:init` con
ogni soggetto non `idle` e ogni `finished` non visto, e il client SHALL sostituire il suo
stato per intero. `GET /api/attention` SHALL dare la stessa istantanea.

Un banner SHALL partire solo da un `attention:updated` dal vivo con un'epoca più grande
dell'ultima annunciata per quel soggetto in quella finestra; l'istantanea NON SHALL mai
annunciare.

Al primo avvio con la tabella vuota il server SHALL comporre i soggetti dagli ingressi
veri di quel momento (attese salvate, card in review o parcheggiate, processi vivi) senza
annunciarli, e NON SHALL accendere chat finite prima del rilascio.

#### Scenario: un ricarico
- **GIVEN** tre chat lette ferme su `awaiting-user`
- **WHEN** la finestra si ricarica
- **THEN** nessuna delle tre SHALL essere blu o contata, e nessun banner SHALL partire

#### Scenario: il telefono si risveglia
- **GIVEN** il telefono addormentato mentre la persona legge sul Mac una chat che il telefono contava
- **WHEN** il telefono riconnette la socket
- **THEN** il suo numero e la sua inbox SHALL non contarla più, senza aprire il pannello

#### Scenario: una finestra nuova
- **WHEN** si apre una finestra di gruppo con due chat accese
- **THEN** SHALL mostrarle accese e NON SHALL alzare banner

#### Scenario: il primo avvio dopo il rilascio
- **GIVEN** la tabella vuota, una card in review e 50 chat finite nei giorni prima
- **WHEN** il server parte
- **THEN** la inbox SHALL elencare la card e nessuna delle 50 chat, e nessun banner SHALL partire

### Requirement: ATTN-08 — Un numero, una mano che lo scrive

Il numero di campanella, Dock, tray e badge PWA SHALL essere il numero di soggetti
accesi non archiviati, calcolato dallo stato di attenzione e da nient'altro. Sul desktop
SHALL scriverlo solo la finestra principale: `set_app_status` chiamato da un'altra
finestra NON SHALL cambiare Dock né tray.

#### Scenario: due finestre
- **GIVEN** la finestra principale e una finestra di gruppo aperte
- **WHEN** una chat della finestra di gruppo finisce e poi viene vista lì
- **THEN** la cronologia delle chiamate che arrivano al Dock SHALL avere solo i valori della finestra principale, +1 e poi -1

#### Scenario: la finestra di gruppo chiama da sola
- **WHEN** una finestra che non è la principale chiama `set_app_status`
- **THEN** il Dock e la tray NON SHALL cambiare

### Requirement: ATTN-09 — Il tasto della sidebar è una inbox di cose vere

Il tasto della sidebar SHALL aprire un pannello «Da guardare» con due linguette, «Ora» e
«Cronologia». «Ora» SHALL elencare i soggetti accesi in due sezioni: «Ti aspettano»
(`needs-you`, dal più vecchio) e «Finite» (`finished` non visti, dal più recente), ogni
riga con icona del motivo, nome, progetto, tempo e una seconda linea con la domanda, il
permesso, il motivo, l'inizio dell'ultimo messaggio o l'errore. Sotto, una riga quieta
SHALL dire quanti soggetti sono in background e al lavoro, senza entrare nel numero.

Aprire il pannello NON SHALL segnare niente. Aprire una voce SHALL portare al soggetto nel
punto (la chat sulla domanda, la card nel cassetto) e, per una `Finite`, segnarla vista.
«Segna visto» su una riga e «Segna tutte viste» in fondo alle `Finite` SHALL mandare le
epoche mostrate. «Ti aspettano» NON SHALL avere un'azione che la spegne senza rispondere.

«Cronologia» SHALL elencare le ultime 100 righe del registro per giorno, in sola lettura,
senza numero sulla linguetta.

Il tasto SHALL mostrare il numero dei soggetti accesi, ambra se almeno uno è
`needs-you`, e nessun numero a zero. Il pannello SHALL funzionare da tastiera (scorciatoia
rimappabile per aprirlo, ↑/↓, Invio, `E`, ⇧`E`, ←/→ per le linguette, Esc che rende il
fuoco al tasto) e al tocco (righe da almeno 44 px, foglio dal basso sotto i 768 px,
scorrimento a sinistra per «Segna visto» solo sulle `Finite`). Icone lucide, nessuna
emoji.

#### Scenario: aprire non spegne
- **GIVEN** due chat `Finite` e una domanda in «Ti aspettano»
- **WHEN** si apre il pannello e lo si chiude
- **THEN** il numero SHALL essere ancora 3

#### Scenario: una voce aperta
- **WHEN** si preme Invio su una `Finite`
- **THEN** la chat SHALL aprirsi, la voce SHALL sparire dalla lista e il numero SHALL calare di uno su ogni dispositivo

#### Scenario: la domanda si apre sul punto
- **WHEN** si apre una voce `needs-you(question)`
- **THEN** la chat SHALL aprirsi scorsa sulla domanda, e la voce SHALL restare finché non si risponde

#### Scenario: segna tutte viste
- **GIVEN** tre `Finite` e due in «Ti aspettano»
- **WHEN** si preme «Segna tutte viste»
- **THEN** il numero SHALL essere 2

#### Scenario: niente da guardare, due al lavoro in background
- **GIVEN** nessun soggetto acceso e due chat in `background`
- **WHEN** si apre il pannello
- **THEN** SHALL dire «Niente da guardare» e «2 in background», e il tasto NON SHALL avere numero

#### Scenario: solo tastiera
- **WHEN** la persona apre il pannello con la scorciatoia, scende con ↓, segna con `E` e chiude con Esc
- **THEN** la voce SHALL risultare vista e il fuoco SHALL tornare sul tasto

#### Scenario: telefono
- **GIVEN** uno schermo largo 390 px
- **WHEN** si tocca il tasto
- **THEN** il pannello SHALL aprirsi come foglio dal basso con righe alte almeno 44 px, e uno scorrimento a sinistra su una `Finite` SHALL segnarla vista

### Requirement: ATTN-10 — Gli avvisi di infrastruttura non accendono una chat

Gli avvisi di swap-freeze (congelato, scongelato), di riavvio trattenuto e del GC dei
worktree SHALL essere righe di cronologia di tipo «Sistema», con un soggetto `system:` e
non `topic:`, una per ciclo. NON SHALL accendere nessun soggetto né entrare in nessun
numero.

#### Scenario: un comando in background congelato e scongelato
- **GIVEN** una chat in `background` col comando che lo swap congela e poi scongela
- **THEN** la chat SHALL restare `background`, spenta, e la cronologia SHALL avere UNA riga «Sistema» per quel ciclo

#### Scenario: un riavvio trattenuto
- **WHEN** il server trattiene un riavvio per una chat al lavoro
- **THEN** la riga SHALL essere «Sistema» e campanella e Dock NON SHALL cambiare

### Requirement: ATTN-11 — Banner, spinte e righe nascono dalle transizioni del server

Ogni epoca nuova dal vivo SHALL scrivere UNA riga di cronologia, scritta dal server,
nata vista se il soggetto è nato visto, anche quando nessuna spinta parte. Il client NON
SHALL scrivere righe per fine turno, attesa o terminale.

Solo l'ingresso in `needs-you` e in `finished` SHALL annunciare. L'annuncio NON SHALL
partire per un soggetto silenziato (o nel progetto silenziato), archiviato, di un agente
di board, o con Non disturbare acceso; la riga sì, tranne che per l'archiviato. I testi e
i tasti SHALL seguire PUSH-04.

Il banner di una finestra desktop SHALL partire se l'epoca non è nata vista, o se è nata
vista e «notifica anche se a fuoco» è acceso; due finestre SHALL consegnarne uno solo
(claim su `subject#epoch`).

La spinta al telefono SHALL partire solo se nessuna finestra desktop della persona è
stata sveglia negli ultimi 2 minuti e l'epoca non è nata vista.

#### Scenario: nessun dispositivo iscritto
- **GIVEN** zero iscrizioni push e una chat non a fuoco
- **WHEN** il turno finisce
- **THEN** SHALL esserci una riga sola, non vista, e il log SHALL dire che nessun dispositivo era iscritto

#### Scenario: la chat a fuoco con «notifica anche se a fuoco» spento
- **GIVEN** una chat con hook a fuoco in una finestra sveglia, e l'impostazione spenta
- **WHEN** il turno finisce
- **THEN** NON SHALL partire nessun banner, e la riga SHALL nascere vista

#### Scenario: il Mac davanti
- **GIVEN** una finestra desktop sveglia da 30 s e un telefono iscritto
- **WHEN** una chat dietro arriva a una domanda
- **THEN** SHALL partire il banner sul Mac e NON SHALL partire la spinta

#### Scenario: il Mac lontano
- **GIVEN** nessuna finestra desktop sveglia da 10 minuti e un telefono iscritto
- **WHEN** una chat finisce davvero
- **THEN** SHALL partire una spinta, con l'etichetta della chat

#### Scenario: una chat archiviata si risveglia
- **GIVEN** una tab chiusa, che ha archiviato la chat, col suo lavoro in background
- **WHEN** il lavoro torna e il turno risvegliato chiude
- **THEN** NON SHALL partire banner né spinta, e NON SHALL nascere una riga

#### Scenario: due finestre, un banner
- **GIVEN** due finestre che ricevono la stessa epoca
- **THEN** una sola SHALL consegnare il banner

### Requirement: ATTN-12 — Pane, tab, riga, progetto e gruppo mostrano lo stesso tier

Ogni superficie SHALL disegnare il tier del soggetto così: `working` spinner; `background`
glifo grigio senza fill né numero; `needs-you` fill ambra; `finished(done)` non visto fill
blu; `finished(error)` non visto fill rosso; visto o `idle` niente. Le superfici accese
SHALL esporre `data-attention` col tier (`needs-you`, `done`, `error`) e il numero
`max(1, non-letti)`. Riga e tab di progetto e card del gruppo SHALL mostrare il tier più
alto dei figli accesi (`needs-you` sopra `error` sopra `done`) e il numero dei figli
accesi. La vista per stato della sidebar SHALL avere le sezioni «Ti aspetta», «Finite»,
«In background», «Al lavoro», dallo stesso tier.

#### Scenario: la chat in background nella vista per stato
- **GIVEN** una chat in `background`
- **THEN** nella vista per stato SHALL stare sotto «In background» e NON sotto «Ti aspetta»

#### Scenario: il progetto con una domanda e una chat finita
- **GIVEN** un progetto con una chat `needs-you` e una `finished(done)` non vista
- **THEN** la riga del progetto SHALL essere ambra con il numero 2

#### Scenario: glifo e fill insieme non esistono più
- **GIVEN** una qualunque chat
- **THEN** la sua riga NON SHALL mostrare insieme il glifo «in background» e un fill blu

### Requirement: ATTN-13 — Archiviare o cancellare spegne il soggetto e le sue righe, dove si scrive

Archiviare o cancellare un topic SHALL portare il suo soggetto in `idle` e segnare viste
le sue righe di cronologia nello stesso passo, sul server. Un topic archiviato NON SHALL
contare su nessuna superficie, e NON SHALL prendere epoche nuove finché resta archiviato.

#### Scenario: chiudere la tab prima di leggere
- **GIVEN** una chat `finished(done)` non vista con la sua riga di cronologia non vista
- **WHEN** la persona chiude la tab e la chat si archivia
- **THEN** campanella, Dock e tray SHALL calare di uno, e la tray SHALL elencare lo stesso numero di chat che conta

#### Scenario: cancellata
- **WHEN** si cancella una chat `needs-you`
- **THEN** il soggetto SHALL sparire da ogni numero e dalla inbox

## MODIFIED Requirements

### Requirement: CHAT-DONE-01 — Una chat che ha finito resta segnata come un terminale che ha finito

Una chat il cui turno finisce con un messaggio visibile, senza compiti in background e
fuori da un'attesa (ATTN-02, ATTN-04, ATTN-05) SHALL entrare in `finished(done)`,
qualunque sia il runtime, con o senza hook Claude Code. Il segno SHALL dipingersi sulla
riga della sidebar e sulla tab con lo stesso tier `done` di un terminale che ha finito, e
le due superfici SHALL esporlo come `data-attention="done"`.

Il segno è lo stato di attenzione del server, non una memoria della finestra: SHALL
essere uguale in ogni finestra e dispositivo e dopo un ricarico. SHALL spegnersi col
visto (ATTN-06): la chat a fuoco per la soglia, il clic sulla sua riga quando la tiene
un'altra finestra, l'apertura dalla inbox. Un turno nuovo lo porta in `working`.

Se la chat è a fuoco in una finestra sveglia quando il turno finisce, l'epoca SHALL
nascere vista: niente numero, niente riga non vista, niente movimento del Dock. Una chat
a fuoco in una finestra dietro un'altra app non è davanti a nessuno: SHALL accendersi e
contare, e spegnersi quando la finestra torna davanti e passa la soglia.

#### Scenario: chat senza hook che finisce dietro un'altra tab
- **GIVEN** una chat senza hook aperta in una tab, e un'altra tab attiva
- **WHEN** il suo turno finisce pulito, senza compiti in background
- **THEN** la sua tab e la sua riga SHALL avere `data-attention="done"`

#### Scenario: la chat davanti che finisce non muove il numero del Dock
- **GIVEN** una chat senza hook a fuoco, in una finestra sveglia
- **WHEN** finiscono cinque suoi turni
- **THEN** le righe di cronologia SHALL essere già viste e il Dock NON SHALL cambiare
- **WHEN** la finestra passa dietro un'altra app e un turno finisce
- **THEN** il numero SHALL salire di uno, e SHALL tornare giù quando la finestra torna davanti

#### Scenario: aprire la chat spegne il segno
- **WHEN** la tab della chat segnata viene attivata e resta a fuoco per la soglia
- **THEN** tab e riga NON SHALL avere più `data-attention`

#### Scenario: la riga di una chat tenuta da un'altra finestra si spegne al clic
- **GIVEN** una chat tenuta da un'altra finestra, segnata `done` sulla riga di questa
- **WHEN** si clicca la sua riga, che porta avanti l'altra finestra senza aprire niente qui
- **THEN** la riga NON SHALL avere più `data-attention`, in nessuna finestra

#### Scenario: una chat con gli hook non perde il segno dopo 15 minuti
- **GIVEN** una chat con hook finita e mai vista
- **WHEN** la fase passa da `awaiting-user` a `completed`
- **THEN** il segno SHALL restare finché la chat non viene vista

#### Scenario: aperta in una finestra, si spegne anche nell'altra
- **GIVEN** due finestre, e in entrambe una chat segnata `done`
- **WHEN** la chat viene vista nella finestra A
- **THEN** la sua riga NON SHALL avere più `data-attention` né in A né in B

#### Scenario: il ricarico non riaccende
- **GIVEN** una chat finita e già vista
- **WHEN** la finestra si ricarica
- **THEN** la chat NON SHALL avere `data-attention`

#### Scenario: un turno che lascia lavoro in background non è finito
- **WHEN** arriva `stream:end` con `background.count > 0`
- **THEN** NON SHALL accendersi nessun segno

#### Scenario: un turno fermato non è un turno finito
- **WHEN** arriva `stream:end` con `reason: user_abort` o `dispatched: true`
- **THEN** NON SHALL accendersi nessun segno

### Requirement: NOTIF-ONE-01 — Un solo «visto» per soggetto, e vederlo ovunque lo spegne ovunque

Una chat, un terminale e una card SHALL avere un solo stato di «visto», l'ultima epoca
vista sul server (ATTN-06). Guardare la pane a fuoco per la soglia, aprire una voce della
inbox, «Segna visto» e «Segna tutte viste» SHALL passare dalla stessa porta, che alza
l'epoca vista, azzera il non-letto della chat, segna viste le sue righe di cronologia e
lo annuncia a ogni finestra e dispositivo con `attention:updated`.

Aprire la inbox NON SHALL segnare niente. «Segna tutte viste» SHALL spegnere esattamente
le `Finite` che la inbox mostrava, alle epoche mostrate: NON SHALL spegnere un'epoca
arrivata dopo, e NON SHALL spegnere un `needs-you`.

#### Scenario: una notifica di chat vista nel pannello
- **WHEN** si apre dalla inbox una chat finita con 4 non letti
- **THEN** il non-letto della chat SHALL essere zero, e la sua riga, la sua tab e il numero globale SHALL calare insieme su ogni dispositivo

#### Scenario: una notifica più nuova della lista letta
- **WHEN** un'epoca nuova arriva dopo che la inbox ha mostrato la lista
- **THEN** «Segna tutte viste» NON SHALL spegnerla

#### Scenario: il pannello aperto su una chat ferma
- **GIVEN** una chat finita con 3 non letti e nessuna riga non vista
- **WHEN** si apre la inbox e la si chiude senza toccare niente
- **THEN** il suo non-letto SHALL restare 3, e la chat SHALL restare nelle `Finite` e contata

#### Scenario: una chat silenziata che il pannello non ha mostrato
- **GIVEN** la inbox aperta, e il suo «Segna tutte viste» non ancora premuto
- **WHEN** una chat silenziata finisce un turno (nessun banner)
- **THEN** «Segna tutte viste» NON SHALL spegnerla, perché la sua epoca è arrivata dopo la lista
- **AND** una chat silenziata già mostrata nelle `Finite` SHALL spegnersi come le altre

#### Scenario: aprire una chat con il non-letto già a zero
- **WHEN** si guarda una chat `finished` con non-letto zero
- **THEN** il visto SHALL partire lo stesso e la chat SHALL spegnersi ovunque

### Requirement: NOTIF-ONE-02 — I numeri globali contano soggetti, non messaggi

Il numero globale (Dock, tray, badge PWA) e il numero della inbox SHALL essere LO STESSO
numero: i soggetti accesi (ATTN-01), ognuno una volta sola, qualunque sia il numero dei
suoi messaggi o delle sue righe di cronologia. Una card in review o parcheggiata vale 1.
Le righe di cronologia NON SHALL entrare nel numero. Le righe e le tab POSSONO mostrare il
numero dei messaggi della chat accesa.

La inbox SHALL elencare ogni soggetto contato, e SHALL dire «Niente da guardare» solo
quando non ce n'è nessuno.

#### Scenario: due chat, sei messaggi
- **WHEN** una chat finita ha 4 non letti e un'altra 2
- **THEN** il numero globale e la inbox SHALL dire 2

#### Scenario: una card in review senza notifica
- **WHEN** una card entra in review e nessuna riga del registro la nomina
- **THEN** il numero globale e la inbox SHALL contarla 1, e la card SHALL comparire sotto «Ti aspettano»

#### Scenario: una chat che ha finito, senza righe e senza non-letti
- **WHEN** una chat senza hook finisce il turno, senza riga né non-letti
- **THEN** il numero globale e la inbox SHALL contarla 1, e «Segna tutte viste» SHALL spegnerla su ogni dispositivo

#### Scenario: una chat che ti aspetta, con le righe già viste
- **WHEN** una chat è ferma su una domanda (`needs-you(question)`) e tutte le sue righe sono viste
- **THEN** il numero globale e la inbox SHALL contarla 1, e la inbox SHALL elencarla sotto «Ti aspettano»

#### Scenario: una chat letta ferma su `awaiting-user`
- **WHEN** una chat finita è stata vista e la sua fase resta `awaiting-user`
- **THEN** il numero globale e la inbox NON SHALL contarla

#### Scenario: righe vecchie non viste
- **GIVEN** 300 righe non viste nel registro di soggetti già spenti
- **THEN** il numero SHALL essere quello dei soggetti accesi, e le righe SHALL stare solo in «Cronologia»

### Requirement: CHROME-COUNT-01 — Un numero solo per il dock, la tray e l'icona, ed e' quello della sidebar

Il numero che Topics dipinge sul sistema operativo (badge dell'icona, glifo nella barra
dei menu, Badging API della PWA) SHALL essere il risultato di UNA funzione pura sullo stato
di attenzione: il numero di soggetti accesi non archiviati. Il lavoro che gira da solo
(`working`, `background`) non entra, un topic archiviato non entra mai, e le righe di
cronologia non entrano.

Il numero SHALL coincidere con il numero di righe di sidebar e card della board che
mostrano un tier acceso per gli stessi soggetti, provato calcolandolo dagli stessi
aiutanti per riga. Il menu della tray SHALL elencare le chat che il suo numero conta,
fino a otto righe. Sul desktop lo SHALL scrivere solo la finestra principale (ATTN-08).

#### Scenario: la tray elenca la chat finita che conta
- **GIVEN** una chat `finished(done)`, una `finished(error)` e una `needs-you(permission)`
- **WHEN** si compone il menu della tray
- **THEN** SHALL avere tre righe di chat, come il numero

#### Scenario: le due superfici sullo stesso stato
- **WHEN** un insieme di chat, terminali e card produce il conteggio del chrome
- **THEN** quel numero SHALL essere uguale al numero di righe di sidebar e card con un tier acceso

#### Scenario: la chat letta
- **WHEN** una chat accesa viene vista
- **THEN** il totale SHALL calare di uno, senza toccare gli altri

#### Scenario: un topic archiviato con non letti
- **GIVEN** un topic archiviato con non letti e una riga non vista
- **THEN** SHALL contare zero, e la tray NON SHALL elencarlo

#### Scenario: archiviato in vista, con «mostra archiviati» acceso
- **WHEN** la riga di un topic archiviato con non letti compare in sidebar
- **THEN** SHALL portare badge zero e nessun `data-attention`, come il chrome

#### Scenario: una chat in background
- **THEN** SHALL contare zero

#### Scenario: niente da mostrare
- **WHEN** non c'e' nessun soggetto acceso
- **THEN** il totale SHALL essere zero, che e' il badge spento

### Requirement: NOTIF-SEEN-01 — Una notifica il cui soggetto e' andato avanti NON SHALL restare accesa

Una riga di cronologia SHALL risultare vista quando il suo soggetto non è più acceso per
l'epoca che l'ha scritta: la card uscita da review, la card parcheggiata rimessa in coda,
cancellata o archiviata, la chat vista, il topic archiviato. Lo fa la porta del visto e la
transizione del soggetto, sul server, nello stesso passo. Le righe NON SHALL entrare in
nessun numero (NOTIF-ONE-02): il pallino in «Cronologia» è l'unico segno che danno.

Ciò che è ancora acceso NON SHALL essere spento da un automatismo.

#### Scenario: la card e' stata approvata tre settimane fa
- **WHEN** una riga `task-review` punta a una card approvata tre settimane fa
- **THEN** SHALL risultare vista, segnata dalla transizione dell'approvazione, e NON SHALL contare

#### Scenario: la card parcheggiata e' ripartita
- **WHEN** una card parcheggiata viene rimessa in coda
- **THEN** la sua riga `task-parked` SHALL risultare vista

#### Scenario: il comando e' appena finito
- **GIVEN** un terminale che ha appena finito, non visto
- **THEN** la sua riga NON SHALL essere spenta finché il terminale non viene visto

#### Scenario: la card e' ancora in attesa
- **WHEN** una riga `task-review` punta a una card ancora in `review`
- **THEN** NON SHALL essere toccata
