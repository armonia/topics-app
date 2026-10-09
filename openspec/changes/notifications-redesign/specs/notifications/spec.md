# Notifiche: uno stato di attenzione solo, sul server

## ADDED Requirements

### Requirement: ATTN-01 — Ogni soggetto ha UNO stato di attenzione, e lo compone il server

Ogni chat (`topic:<id>`), terminale (`terminal:<id>`) e card (`task:<id>`) SHALL avere
uno e un solo stato di attenzione: `idle`, `working`, `needs-you` (con
motivo `question`, `permission`, `plan`, `review` o `parked`) o `finished` (con esito
`done` o `error`), più un'epoca e l'ultima epoca vista. Un soggetto è **acceso** quando è
`needs-you`, o quando è `finished` e la sua epoca non è stata vista.

Lo stato SHALL comporlo il server da turno, lavoro in background, attesa di una persona,
ultimo turno, stato della card, archiviazione e chiusura, con questa precedenza:
archiviato, cancellato o terminale chiuso → `idle`; topic di un agente di board → `idle`;
attesa aperta → `needs-you`;
card in review o parcheggiata → `needs-you`; turno aperto → `working`; ultimo turno in
errore non visto → `finished(error)`; compiti in background → `working`; ultimo turno
finito non visto → `finished(done)`; altrimenti `idle`.

Un soggetto che aspetta il lavoro che ha lanciato È al lavoro (modifica del 2026-10-04):
non esiste uno stato `background` a parte, e ogni superficie lo mostra «in corso» come un
turno aperto. Un processo fatto per restare acceso (un server avviato con `run_script`, o
con `run_command` senza sveglia, che ascolta su una porta) NON SHALL essere un compito che
conta: è un server della chat (BGVIS-08), con un segno suo sulla riga della sidebar, che
non conta come lavoro in corso e non accende niente. Una riga salvata come `background`
prima della modifica SHALL caricarsi come `working`.

Un'attesa aperta nella sessione di una card in volo SHALL essere un ingresso del soggetto
`task:<id>` di quella card, non del suo topic. L'attesa resta un fatto transitorio come
oggi (`task:awaiting-human`, non scritto in `dispatch_state`): dopo un riavvio le mappe dei
bridge sono vuote e l'attesa non esiste più.

Un solo modulo SHALL scrivere lo stato e trasmetterlo (`attention:init`,
`attention:updated`). Tab di pane, riga della sidebar (anche la sua presenza e il suo
ordine), riga e tab di progetto, card del gruppo, tab board e riga Board, vista per stato,
coda di ⌘J e porta «In attesa» del telefono, menu agenti, anello di lavoro, inbox,
Dock, tray e badge PWA SHALL derivare solo da quello stato, con le stesse due funzioni per
soggetto e per insieme di soggetti. Nessuna superficie SHALL leggere la fase Claude, le
righe del registro, il poll di `GET /api/topics/streaming` o un segno in memoria per
decidere se accendersi o se mostrare il lavoro in background.

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

#### Scenario: nessuna chat è insieme al lavoro e finita
- **GIVEN** una chat con un Agent in background
- **WHEN** si compone il menu agenti
- **THEN** la chat SHALL stare fra quelle al lavoro e NON SHALL stare fra le finite

#### Scenario: un server acceso non è lavoro in corso
- **GIVEN** una chat il cui agente ha avviato un dev server con `run_script`, che ascolta su una porta
- **THEN** il suo stato NON SHALL essere `working`, la riga della sidebar SHALL avere il segno del server (`row-server-sign`) col suo indirizzo e nessun anello
- **AND** la riga quieta della inbox NON SHALL contarla

#### Scenario: il topic di un agente di board
- **GIVEN** il topic di una card dispatchata che finisce un turno
- **THEN** il suo stato SHALL essere `idle`, e la consegna SHALL comparire come `needs-you(review)` della card

#### Scenario: l'agente di board chiede a metà turno
- **GIVEN** una card `in_progress` la cui sessione apre un permesso dal permission bridge, o una domanda dall'ask bridge
- **THEN** il soggetto `task:<id>` SHALL essere `needs-you(permission)` o `needs-you(question)`, nella inbox sotto «Ti aspettano», contato in campanella, Dock e tab board
- **AND** il topic della card SHALL restare `idle`
- **WHEN** la persona risponde
- **THEN** il soggetto della card SHALL tornare spento

#### Scenario: un terminale chiuso
- **GIVEN** un terminale `finished(done)` non visto
- **WHEN** la persona chiude la sua tab, o la sua pane viene rimossa
- **THEN** il soggetto SHALL essere `idle`, la sua riga di cronologia vista, e campanella e Dock SHALL calare di uno

### Requirement: ATTN-02 — Il lavoro in background è lavoro in corso, non chiede niente, e la fine vera avvisa una volta

Un turno che finisce lasciando compiti in volo (Bash o Agent con `run_in_background`,
Workflow, Monitor, CronCreate non ricorrente, `run_command` di Topics) SHALL portare il
soggetto in `working`, come un turno aperto: niente fill, niente numero, niente banner,
niente spinta, niente riga di cronologia, e nessun conto in campanella, Dock, tray o vista
«Ti aspetta». L'anello di lavoro in corso SHALL essere il suo segno, lo stesso di un turno.

`stream:end` SHALL portare `background: { count, kinds }`, calcolato prima del frame da
una funzione dell'attenzione (`attentionBackground`) che conta i compiti vivi, la CLI che
si sta già svegliando (`wake-queued`) e i cron non ricorrenti. NON SHALL venire da
`backgroundState`/`backgroundOfTurn` del goal loop, che contano anche un cron ricorrente
armato per due ore: quelli restano al goal loop, invariati.

Un turno risvegliato che chiude con altri compiti ancora in volo SHALL lasciare il
soggetto in `working`, senza avvisi. Quando l'ultimo compito è tornato e il turno che
lo porta chiude, il soggetto SHALL passare a `finished(done)` con un'epoca nuova: un
avviso solo per tutta l'attesa. Se l'ultimo compito torna e nessun turno si apre entro
5 s, il soggetto SHALL passare a `finished(done)` se l'ultimo turno non era stato visto,
altrimenti a `idle`. Un turno è visto quando la persona ha guardato il soggetto dopo che è
chiuso, anche mentre aspetta i suoi compiti (ATTN-06, `seen_at`), o quando è chiuso davanti a lei.

Nessun messaggio dentro un turno e nessun turno risvegliato SHALL alzare un banner su
nessuna finestra, nemmeno sulla finestra principale nascosta nella tray: il ramo dei
banner di `message:new` SHALL sparire, e l'unico banner SHALL essere l'annuncio della
transizione (ATTN-11).

Un turno in errore SHALL dare `finished(error)` anche con compiti in volo.

#### Scenario: una chat lancia i verifier e aspetta
- **GIVEN** una chat non a fuoco il cui turno lancia un Agent e un Bash in background e risponde «Lanciati, aspetto»
- **WHEN** arriva `stream:end`
- **THEN** il frame SHALL portare `background.count = 2`
- **AND** lo stato SHALL essere `working`, senza riga di cronologia, senza spinta e senza banner
- **AND** la tab e la riga NON SHALL avere fill né numero, e campanella e Dock NON SHALL cambiare

#### Scenario: uno di tre è tornato
- **GIVEN** la chat in attesa del suo lavoro (`working`) con tre compiti
- **WHEN** il primo torna, la CLI si sveglia e il turno chiude con «1 di 3 arrivato»
- **THEN** lo stato SHALL restare `working` senza epoca nuova, e il non-letto SHALL salire di uno senza che nessuna superficie lo mostri

#### Scenario: l'ultimo torna
- **GIVEN** la chat in attesa del suo lavoro (`working`) con un solo compito, e due messaggi non letti dei turni risvegliati
- **WHEN** l'ultimo compito torna e il turno che lo porta chiude senza altro in volo
- **THEN** lo stato SHALL essere `finished(done)` con un'epoca nuova
- **AND** SHALL partire un banner solo, e la riga e la tab SHALL mostrare 3

#### Scenario: il compito torna e la CLI non si sveglia
- **GIVEN** una chat in attesa del suo lavoro (`working`) il cui ultimo turno non era stato visto
- **WHEN** l'ultimo compito torna e per 5 s non si apre nessun turno
- **THEN** lo stato SHALL essere `finished(done)`

#### Scenario: guardata mentre aspettava il suo lavoro
- **GIVEN** una chat in attesa del suo lavoro (`working`), guardata dalla persona per la soglia dopo la fine del turno
- **WHEN** l'ultimo compito torna e per 5 s non si apre nessun turno
- **THEN** lo stato SHALL essere `idle`, senza epoca nuova né banner

#### Scenario: la finestra principale è nella tray
- **GIVEN** la finestra principale nascosta nella tray, e una chat in attesa del suo lavoro (`working`) con tre compiti
- **WHEN** tornano i primi due, ciascuno con un turno risvegliato che scrive un messaggio
- **THEN** NON SHALL partire nessun banner
- **WHEN** torna il terzo e il turno chiude senza altro in volo
- **THEN** SHALL partire UN banner, uno solo fra tutte le finestre

#### Scenario: un cron ricorrente in una chat
- **GIVEN** una chat headless il cui turno crea un cron ricorrente e risponde
- **WHEN** arriva `stream:end`
- **THEN** `background.count` SHALL essere 0 e lo stato `finished(done)`
- **AND** il goal loop SHALL continuare a rimandare il giudizio finché il cron è armato, come oggi

#### Scenario: un Monitor armato
- **GIVEN** una chat che ha armato un Monitor e chiude il turno
- **THEN** lo stato SHALL essere `working`, con l'anello di lavoro, e la tab NON SHALL essere blu né contata in campanella

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
il transcript. Un CronCreate ricorrente SHALL stare fra i compiti, segnato ricorrente,
perché la riga del background e lo Stop lo mostrino, ma NON SHALL contare né per lo stato
di attenzione né per `watching`, in chat e nei terminali.

I compiti di un soggetto SHALL avere un detentore solo, lo stato di attenzione: le fonti
(lo snapshot della CLI per le chat, hook e transcript per i terminali, il registro dei
processi per `run_command`) lo alimentano, e la macchina delle fasi legge da lì il numero
di compiti allo `Stop`.

La macchina delle fasi SHALL mettere `watching` allo `Stop` quando la sessione ha almeno
un compito in volo, qualunque sia il tool che l'ha lanciato, e `awaiting-user` quando non
ne ha.

L'avviso di fine SHALL valere anche quando la CLI lo assorbe a metà turno: dalla 2.1.292
non diventa una riga utente, e lo nomina solo il record di coda `queue-operation`
`enqueue`, che la CLI scrive per ogni avviso, consegnato o assorbito.

L'avviso SHALL chiudere il compito sotto qualunque id la mappa lo tenga: anche sotto il
`tool-use-id` della chiamata che l'avviso nomina, finché il `PostToolUse` non l'ha ri-chiavato.
Gli hook sono asincroni e arrivano anche secondi dopo: un hook arrivato dopo l'avviso NON
SHALL rimettere nella mappa il compito che quell'avviso ha chiuso, neanche dopo la
ricomposizione di avvio, né dopo una lettura tardiva che ripercorre più avvisi di quanti
se ne ricordano; se quell'hook toglie
l'ultimo compito di un turno già parcheggiato in `watching`, la fase SHALL scendere a
`awaiting-user`, come avrebbe detto lo `Stop`. Un Monitor SHALL chiudersi solo con le
parole della CLI: uno `<status>`, la sua scadenza, il suo timeout, il suo arresto da parte
della CLI (`[Monitor stopped …]`, per troppo output o per un TaskStop). Il resto di un suo
evento è il testo del programma che guarda: «stopped» lì non è il Monitor.

La mappa dei compiti SHALL sopravvivere a un ricarico del server finché il processo che
la tiene è vivo. La fine del processo SHALL svuotarla (ATTN-15). Un terminale riattaccato
dopo un ricarico SHALL rileggere dal suo transcript gli avvisi dei compiti ancora in
volo, senza ripercorrere la fase: un avviso scritto mentre nessun server leggeva il file
chiude il suo compito come gli altri. Ciò che chiude è finito prima del riavvio, quindi si
ricompone come ogni riavvio: senza riga, senza annuncio, senza push e senza un'epoca nuova.
Un turno chiuso dal vivo dopo il riavvio, anche mentre il riattacco sta ancora leggendo, SHALL
essere annunciato come sempre. La fine letta dopo il fatto SHALL restare senza epoca anche se
un turno dal vivo si apre mentre il riattacco legge e chiude senza esito. Se dopo la lettura
resta in volo un compito lanciato prima del riavvio, dal turno chiuso o da un turno messo a riposo
senza esito, il lavoro di prima non è finito: la fine di quel compito, letta dal vivo, SHALL essere
annunciata come lo sarebbe stata senza il riavvio. Un compito lanciato dopo il riavvio è di un
turno dal vivo e non trattiene la fine letta dopo il fatto, in qualunque ordine arrivino i suoi
hook rispetto alla lettura. Un compito di prima del riavvio che teneva il turno (un cron ricorrente no) ed esce dal vivo (la sua fine letta
dalla coda viva, o un cron una tantum consumato dal prompt dopo) rende dal vivo la fine di quel
lavoro: la lettura tardiva che toglie gli altri SHALL annunciarla come sempre, anche quando
l'uscita dal vivo arriva mentre il riattacco sta ancora leggendo. Un compito di prima del
riavvio ancora sotto l'id della chiamata, con un avviso che non la nomina, SHALL uscire col suo
`PostToolUse` nel modo in cui la sua fine è stata letta: dal vivo o dopo il fatto.

#### Scenario: Bash, Agent e Workflow in un terminale
- **GIVEN** un terminale claude-code con hook
- **WHEN** un turno lancia un Bash con `run_in_background`, oppure un Agent con `run_in_background`, oppure un Workflow, e poi arriva `Stop`
- **THEN** la fase SHALL essere `watching` e lo stato di attenzione `working`

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
- **THEN** il terminale SHALL essere ancora `working` con lo stesso id in volo

#### Scenario: un cron ricorrente in un terminale
- **GIVEN** un terminale claude-code con hook
- **WHEN** un turno crea un cron ricorrente e arriva `Stop`
- **THEN** la fase SHALL essere `awaiting-user` e lo stato `finished(done)`

#### Scenario: l'avviso assorbito a metà turno
- **GIVEN** un terminale o una chat con un Bash in background in volo
- **WHEN** il compito finisce mentre un turno gira, la CLI scrive solo i record di coda (`enqueue`, poi `remove` con `absorbed_mid_turn`) e arriva lo `Stop`
- **THEN** il compito SHALL uscire dalla mappa e la fase SHALL essere `awaiting-user`

#### Scenario: l'avviso letto prima del PostToolUse
- **GIVEN** un terminale o una chat con un Bash in background appena lanciato, nella mappa dal suo `PreToolUse`
- **WHEN** il transcript ne porta l'avviso di fine prima del `PostToolUse`, poi arriva il `PostToolUse` e poi lo `Stop`
- **THEN** il compito SHALL restare fuori dalla mappa e la fase SHALL essere `awaiting-user`

#### Scenario: un evento di Monitor che dice «stopped»
- **GIVEN** un terminale con un Monitor in volo
- **WHEN** arriva un suo evento il cui testo dice «stopped»
- **THEN** il Monitor SHALL restare nella mappa, e il suo timeout lo SHALL chiudere

#### Scenario: un Monitor fermato dalla CLI
- **GIVEN** un terminale in `watching` per un Monitor
- **WHEN** la CLI lo ferma e lo dice con un evento `[Monitor stopped …]`, senza `<status>`, e arriva lo `Stop`
- **THEN** il Monitor SHALL uscire dalla mappa e la fase SHALL essere `awaiting-user`

#### Scenario: l'avviso che non nomina la chiamata, prima dello Stop e del PostToolUse
- **GIVEN** un terminale o una chat con un Agent in background, nella mappa dal suo `PreToolUse`
- **WHEN** il transcript ne porta l'avviso di fine senza `<tool-use-id>`, poi arriva lo `Stop` e dopo lo `Stop` il `PostToolUse`, partito prima
- **THEN** il compito SHALL uscire dalla mappa e la fase SHALL essere `awaiting-user`

#### Scenario: l'avviso scritto mentre il server non leggeva
- **GIVEN** un terminale in `watching` per un Bash in background
- **WHEN** il server si ricarica e il transcript contiene già l'avviso di fine di quel compito
- **THEN** al riattacco il compito SHALL uscire dalla mappa, lo stato non SHALL essere `working` e la fase SHALL restare `dormant`
- **AND** la fine di quel turno NON SHALL essere annunciata: nessuna riga, nessun push, la stessa epoca

#### Scenario: un turno dal vivo mentre il riattacco legge ancora
- **GIVEN** un terminale in `watching` per un Bash in background, il server ricaricato e il transcript con già l'avviso di fine
- **WHEN** un turno dal vivo chiude mentre il riattacco sta ancora leggendo
- **THEN** al riattacco il compito SHALL uscire dalla mappa e lo stato SHALL essere `finished(done)`
- **AND** la fine di quel turno SHALL essere annunciata come sempre: una riga, un push, un'epoca nuova

#### Scenario: un turno dal vivo senza esito mentre il riattacco legge ancora
- **GIVEN** un terminale in `watching` per un Bash in background, il server ricaricato e il transcript con già l'avviso di fine
- **WHEN** un turno dal vivo si apre mentre il riattacco sta ancora leggendo e chiude senza esito
- **THEN** al riattacco il compito SHALL uscire dalla mappa e lo stato SHALL essere `finished(done)`
- **AND** la fine del turno di prima NON SHALL essere annunciata: nessuna riga, nessun push, la stessa epoca

#### Scenario: un turno dal vivo lancia un suo compito mentre il riattacco legge
- **GIVEN** un terminale in `watching` per un Bash in background, il server ricaricato e il transcript con già l'avviso di fine
- **WHEN** un turno dal vivo si apre mentre il riattacco legge, lancia un suo Bash in background (gli hook arrivano prima o dopo la lettura), si interrompe senza esito e più tardi il suo Bash finisce
- **THEN** la fine del turno di prima NON SHALL essere annunciata, in nessuno dei due ordini: nessuna riga, nessun push, la stessa epoca

#### Scenario: un compito ancora in volo dopo la lettura del riattacco
- **GIVEN** un terminale in `watching` per un Bash e un Agent in background, e il server ricaricato
- **AND** il transcript con l'avviso di fine del Bash, scritto mentre nessun server leggeva
- **WHEN** il riattacco toglie il Bash, e più tardi l'Agent finisce e la coda viva ne legge l'avviso
- **THEN** dopo il riattacco lo stato SHALL restare `working`
- **AND** la fine dell'Agent SHALL essere annunciata una volta: una riga, un push, un'epoca nuova

#### Scenario: un compito di prima del riavvio finisce dal vivo mentre il riattacco legge
- **GIVEN** un terminale con un turno chiuso su un Bash e un Agent in background, e il server ricaricato
- **AND** il transcript con l'avviso di fine del Bash, scritto mentre nessun server leggeva
- **WHEN** la coda viva legge la fine dell'Agent mentre il riattacco sta ancora leggendo, e poi il riattacco toglie il Bash
- **THEN** lo stato SHALL essere `finished` e la fine del turno SHALL essere annunciata una volta: una riga, un push, un'epoca nuova
- **AND** lo stesso SHALL valere per un cron una tantum consumato dal prompt dopo, prima o dopo la lettura
- **AND** un cron ricorrente di prima del riavvio cancellato dal vivo, che il turno non lo teneva, SHALL lasciare la guarigione muta

#### Scenario: l'avviso senza chiamata di un compito di prima del riavvio
- **GIVEN** un terminale con un turno chiuso su un Bash e un Agent ancora sotto l'id della chiamata, il cui `PostToolUse` arriva solo al server ricaricato
- **AND** il transcript con la fine di tutti e due, quella dell'Agent senza `<tool-use-id>`, scritto mentre nessun server leggeva
- **WHEN** il `PostToolUse` dell'Agent arriva prima o dopo la lettura tardiva
- **THEN** lo stato SHALL essere `finished` e la guarigione SHALL restare muta, nei due ordini
- **AND** se la fine dell'Agent la legge la coda viva, la lettura tardiva che toglie il Bash SHALL annunciare il turno una volta

#### Scenario: un hook dopo la ricomposizione di avvio
- **GIVEN** un compito la cui fine è già stata letta, dalla coda viva o dalla lettura tardiva, prima del suo `PostToolUse`
- **WHEN** la ricomposizione di avvio rilegge la tabella e poi arriva il `PostToolUse`
- **THEN** il compito NON SHALL tornare nella mappa, e il terminale SHALL arrivare a `finished`

#### Scenario: una storia lunga letta dal riattacco
- **GIVEN** un terminale riattaccato con un Agent di prima del riavvio ancora in volo, e 40 avvisi di fine vecchi nel transcript
- **AND** un turno dal vivo che lancia un Bash, la cui fine la coda viva legge prima del suo `PostToolUse`, mentre la lettura tardiva legge ancora
- **WHEN** arrivano il `PostToolUse` e lo `Stop`, e più tardi l'Agent finisce
- **THEN** il Bash NON SHALL tornare nella mappa, e il terminale SHALL arrivare a `finished` con un solo annuncio, come senza riavvio

#### Scenario: un compito di un turno messo a riposo prima del riavvio
- **GIVEN** un terminale con un turno chiuso sul suo Bash in background, poi un turno che lancia un altro Bash e si interrompe senza esito, e il server ricaricato
- **AND** il transcript con l'avviso di fine del primo Bash, scritto mentre nessun server leggeva
- **WHEN** il riattacco toglie il primo Bash, e più tardi il secondo finisce e la coda viva ne legge l'avviso
- **THEN** dopo il riattacco lo stato SHALL restare `working`
- **AND** la fine del secondo Bash SHALL essere annunciata una volta, come senza il riavvio: una riga, un push, un'epoca nuova, anche se il suo `PostToolUse` arriva solo al server ricaricato

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
`finished(error)`, anche quando a chiudere il turno è la macchina (watchdog, stall judge,
rifiuto, limite di uscita): oggi lo stesso turno porta `reason: "error"` e la spinta di
errore, ed è un fatto che la persona deve vedere. Fa eccezione un errore che il sistema
riprende da solo (il rinvio di `resumesByItself`): resta `working` senza epoca finché il
turno riparte. Solo uno stop della PERSONA o un turno dispatchato SHALL portarlo in `idle`
senza avvisi.

Il numero sulla tab e sulla riga SHALL venire dal frame di attenzione, che SHALL partire
anche quando cambia solo il non-letto di un soggetto acceso; `unread:updated` NON SHALL
essere una seconda fonte del numero.

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
- **GIVEN** una chat in attesa del suo lavoro (`working`) per un Monitor
- **WHEN** arriva un turno risvegliato che viene scartato perché vuoto
- **THEN** il non-letto NON SHALL cambiare e NON SHALL nascere un'epoca

#### Scenario: un errore
- **WHEN** un turno finisce in errore
- **THEN** lo stato SHALL essere `finished(error)`, rosso, contato

#### Scenario: uno stop della persona
- **WHEN** la persona ferma il turno
- **THEN** lo stato SHALL essere `idle` senza banner, spinta né riga

#### Scenario: il watchdog taglia il turno
- **WHEN** un turno viene chiuso dalla macchina con `reason: "error"` e il sistema non lo rimanda da solo
- **THEN** lo stato SHALL essere `finished(error)` con un'epoca nuova

#### Scenario: un messaggio nuovo su una chat già accesa
- **GIVEN** una chat `finished(done)` non vista con 2 non letti
- **WHEN** il server alza il non-letto a 3 senza cambiare stato
- **THEN** SHALL partire `attention:updated` e la riga e la tab SHALL mostrare 3

#### Scenario: la chat letta non torna a «1»
- **GIVEN** una chat `finished(done)` con la fase `awaiting-user`
- **WHEN** la persona la guarda per la soglia e poi passa a un'altra pane
- **THEN** né la tab né la riga SHALL avere un numero, e campanella e Dock NON SHALL contarla

### Requirement: ATTN-06 — Il «visto» è della persona, sta sul server e vale per un'epoca

Il visto SHALL essere uno solo per soggetto e per persona, salvato sul server come
ultima epoca vista e come istante fin dove i turni del soggetto sono stati visti
(`seen_at`). Una porta sola (`POST /api/attention/seen` con `{subject, epoch, turnAt}`)
SHALL alzarli, azzerare il non-letto del topic, segnare viste le righe di cronologia del
soggetto fino a quell'epoca e trasmettere `attention:updated` a ogni finestra e
dispositivo della persona, SEMPRE, anche quando non ha cambiato niente.

Un visto per un'epoca NON SHALL spegnere un'epoca più nuova, e un `turnAt` vecchio NON
SHALL coprire un turno più nuovo. Una pane a fuoco SHALL mandare il visto anche quando il
soggetto aspetta i suoi compiti (`working`) con un turno chiuso non visto.

Il frame `focus` SHALL portare il soggetto a fuoco e se la finestra è sveglia, e la
chiusura della socket SHALL cancellarlo. Un'epoca che nasce mentre il suo soggetto è a
fuoco in una finestra sveglia della persona SHALL nascere vista: niente numero, niente
riga non vista, niente spinta.

Le socket degli ospiti NON SHALL scrivere il visto né ricevere `attention:*`, e il loro
frame `focus` NON SHALL far nascere visto niente.

Sul telefono il visto SHALL spegnere numero e righe dal vivo con la PWA aperta; con la PWA
chiusa, alla sua apertura o al ritorno in primo piano SHALL ritirare le notifiche
consegnate dei soggetti non più accesi e riscrivere il badge. Ogni spinta SHALL portare il
numero corrente, che il service worker scrive sul badge.

#### Scenario: letta sul Mac, spenta ovunque
- **GIVEN** una chat `finished(done)` accesa nella finestra A, nella finestra B e nella PWA aperta sul telefono
- **WHEN** la persona la guarda in A per la soglia
- **THEN** in B e sul telefono la tab, la riga e il numero SHALL spegnersi senza nessun gesto

#### Scenario: il telefono con la PWA chiusa
- **GIVEN** una spinta consegnata per una chat, e la PWA chiusa
- **WHEN** la persona guarda la chat sul Mac e poi apre la PWA
- **THEN** la notifica consegnata SHALL essere ritirata e il badge SHALL non contarla più

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

#### Scenario: il fuoco di un ospite
- **GIVEN** una socket ospite sveglia col fuoco su una chat condivisa, e nessuna finestra della persona su quella chat
- **WHEN** il turno della chat finisce
- **THEN** l'epoca SHALL nascere non vista, contare e partire come annuncio

### Requirement: ATTN-07 — Aprire, ricaricare o riconnettere non riaccende e non suona

A ogni apertura della socket della persona il server SHALL mandare `attention:init` con
ogni soggetto non `idle` e ogni `finished` non visto, e il client SHALL sostituire il suo
stato per intero. Non SHALL esserci una seconda porta per la stessa istantanea.

Un banner SHALL partire solo da un `attention:updated` dal vivo con un'epoca più grande
dell'ultima annunciata per quel soggetto in quella finestra; l'istantanea NON SHALL mai
annunciare.

A ogni avvio del server, anche un ricarico del watcher, lo stato SHALL ricomporsi
dall'ultimo turno, dal visto e dai compiti salvati nella riga e dagli ingressi riletti da
dove già vivono (card, archiviati, terminali chiusi, dispatch, attese salvate), senza
annunciare e senza epoche nuove: un'epoca nasce solo per un fatto nuovo (un turno,
un'attesa, uno stato della card), mai per una ricomposizione degli stessi fatti.

Al primo avvio con la tabella vuota il server SHALL accendere solo ciò che è vero in quel
momento (attese salvate, card in review o parcheggiate, processi vivi), e NON SHALL
accendere chat finite prima del rilascio.

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

#### Scenario: un ricarico del server con una chat finita non vista
- **GIVEN** una chat `finished(done)` all'epoca 7, non vista, e una card in review
- **WHEN** il watcher ricarica il server
- **THEN** la chat SHALL essere ancora `finished(done)` all'epoca 7, la card ancora `needs-you(review)`, e nessun banner né riga SHALL nascere

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
SHALL dire quanti soggetti sono al lavoro (un turno aperto o un lavoro in background che
aspettano: un conto solo), senza entrare nel numero.

Aprire il pannello NON SHALL segnare niente. Aprire una voce SHALL portare al soggetto nel
punto (la chat sulla domanda, la card nel cassetto) e, per una `Finite`, segnarla vista.
«Segna visto» su una riga e «Segna tutte viste» in fondo alle `Finite` SHALL mandare le
epoche mostrate. «Ti aspettano» NON SHALL avere un'azione che la spegne senza rispondere.

«Cronologia» SHALL elencare le ultime 100 righe del registro per giorno, in sola lettura,
senza numero sulla linguetta.

Il tasto SHALL mostrare il numero dei soggetti accesi, ambra se almeno uno è
`needs-you`, e nessun numero a zero. Il pannello SHALL funzionare da tastiera (una voce
del registro delle scorciatoie di oggi, `shared/shortcuts.ts`, per aprirlo, ↑/↓, Invio, `E`, ⇧`E`, ←/→ per le linguette, Esc che rende il
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
- **GIVEN** nessun soggetto acceso e due chat in attesa del suo lavoro (`working`)
- **WHEN** si apre il pannello
- **THEN** SHALL dire «Niente da guardare» e «2 al lavoro», e il tasto NON SHALL avere numero

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
- **GIVEN** una chat in attesa del suo lavoro (`working`) col comando che lo swap congela e poi scongela
- **THEN** la chat SHALL restare `working`, spenta, e la cronologia SHALL avere UNA riga «Sistema» per quel ciclo

#### Scenario: un riavvio trattenuto
- **WHEN** il server trattiene un riavvio per una chat al lavoro
- **THEN** la riga SHALL essere «Sistema» e campanella e Dock NON SHALL cambiare

### Requirement: ATTN-11 — Banner, spinte e righe nascono dalle transizioni del server

Ogni epoca nuova dal vivo SHALL scrivere UNA riga di cronologia, scritta dal server,
nata vista se il soggetto è nato visto, anche quando nessuna spinta parte. Il client NON
SHALL scrivere righe per fine turno, attesa o terminale.

Solo l'ingresso in `needs-you` e in `finished` SHALL annunciare. Il server NON SHALL
annunciare per un soggetto silenziato (o nel progetto silenziato), archiviato o di un
agente di board; la riga sì, tranne che per l'archiviato. I testi e i tasti SHALL seguire
PUSH-04.

Il banner di una finestra desktop SHALL partire se l'epoca non è nata vista, o se è nata
vista e «notifica anche se a fuoco» è acceso, e poi SHALL passare il cancello di Non
disturbare del client (QUIET-01), che resta dove vive la lettura della concentrazione;
due finestre, anche la principale nascosta nella tray, SHALL consegnarne uno solo (claim su
`subject#epoch`). Nessun altro ramo del client SHALL alzare banner per turni o messaggi.

La spinta al telefono SHALL partire per ogni annuncio la cui epoca non è nata vista, e NON
SHALL leggere la concentrazione del Mac.

#### Scenario: nessun dispositivo iscritto
- **GIVEN** zero iscrizioni push e una chat non a fuoco
- **WHEN** il turno finisce
- **THEN** SHALL esserci una riga sola, non vista, e il log SHALL dire che nessun dispositivo era iscritto

#### Scenario: la chat a fuoco con «notifica anche se a fuoco» spento
- **GIVEN** una chat con hook a fuoco in una finestra sveglia, e l'impostazione spenta
- **WHEN** il turno finisce
- **THEN** NON SHALL partire nessun banner, e la riga SHALL nascere vista

#### Scenario: un telefono iscritto
- **GIVEN** un telefono iscritto e la chat non a fuoco in nessuna finestra sveglia
- **WHEN** una chat finisce davvero
- **THEN** SHALL partire una spinta, con l'etichetta della chat e il numero corrente

#### Scenario: Non disturbare sul Mac
- **GIVEN** la concentrazione del sistema accesa e letta dal guscio
- **WHEN** una chat arriva a una domanda
- **THEN** NON SHALL partire il banner sul Mac, la riga SHALL nascere e la chat SHALL contare

#### Scenario: una chat archiviata si risveglia
- **GIVEN** una tab chiusa, che ha archiviato la chat, col suo lavoro in background
- **WHEN** il lavoro torna e il turno risvegliato chiude
- **THEN** NON SHALL partire banner né spinta, e NON SHALL nascere una riga

#### Scenario: due finestre, un banner
- **GIVEN** due finestre che ricevono la stessa epoca
- **THEN** una sola SHALL consegnare il banner

### Requirement: ATTN-12 — Pane, tab, riga, progetto e gruppo mostrano lo stesso tier

Ogni superficie SHALL disegnare il tier del soggetto così: `working` (un turno aperto o un
lavoro in background che aspetta) l'anello di lavoro, senza fill né numero; `needs-you` fill ambra; `finished(done)` non visto fill
blu; `finished(error)` non visto fill rosso; visto o `idle` niente. Le superfici accese
SHALL esporre `data-attention` col tier (`needs-you`, `done`, `error`) e il numero
`max(1, non-letti)`. Riga e tab di progetto e card del gruppo SHALL mostrare il tier più
alto dei figli accesi (`needs-you` sopra `error` sopra `done`) e il numero dei figli
accesi. La vista per stato della sidebar SHALL avere le sezioni «Ti aspetta», «Finite»,
«Al lavoro», dallo stesso tier. Un server acceso (BGVIS-08) NON SHALL accendere l'anello:
la riga ha il suo segno del server.

L'anello di lavoro, l'indicatore di lavoro e la riga del background della chat
SHALL leggere il tier e i compiti dello stato di attenzione, dallo stesso frame del fill;
lo Stop del lavoro in background SHALL leggere i compiti in volo, anche col tier `error`.

Il numero su tab e riga SHALL esserci solo per un soggetto acceso: una chat spenta con
non-letti (al lavoro, vista, o con un messaggio di sistema) NON SHALL avere numero.

#### Scenario: la chat in background nella vista per stato
- **GIVEN** una chat in attesa del suo lavoro (`working`)
- **THEN** nella vista per stato SHALL stare sotto «Al lavoro» e NON sotto «Ti aspetta»

#### Scenario: la chat in background in sidebar e sulla tab
- **GIVEN** una chat il cui turno ha lasciato un Bash in background
- **THEN** la sua riga e la sua tab SHALL avere `[data-loader-state="working"]`, senza `data-attention`
- **WHEN** il Bash torna e il turno che lo riporta chiude
- **THEN** la riga SHALL avere `data-attention="done"` e nessun anello

#### Scenario: il progetto con una domanda e una chat finita
- **GIVEN** un progetto con una chat `needs-you` e una `finished(done)` non vista
- **THEN** la riga del progetto SHALL essere ambra con il numero 2

#### Scenario: anello e fill insieme non esistono più
- **GIVEN** una qualunque chat, anche `finished(error)` con un Bash ancora in volo
- **THEN** la sua riga NON SHALL mostrare insieme l'anello di un lavoro in background e un fill
- **AND** con il Bash in volo il composer SHALL offrire lo Stop del lavoro in background

### Requirement: ATTN-13 — Archiviare, cancellare o chiudere spegne il soggetto e le sue righe, dove si scrive

Archiviare o cancellare un topic, e chiudere o rimuovere un terminale, SHALL portare il
soggetto in `idle`, segnare viste la sua epoca, il suo ultimo turno e le sue righe di
cronologia nello stesso passo, sul server. Un topic archiviato NON SHALL contare su
nessuna superficie, e NON SHALL prendere epoche nuove finché resta archiviato.

Riaprire un topic archiviato NON SHALL riaccendere niente di prima: lo stato SHALL
ricomporsi senza `archived`, e un turno già finito prima dell'archiviazione NON SHALL dare
un'epoca né un annuncio.

#### Scenario: chiudere la tab prima di leggere
- **GIVEN** una chat `finished(done)` non vista con la sua riga di cronologia non vista
- **WHEN** la persona chiude la tab e la chat si archivia
- **THEN** campanella, Dock e tray SHALL calare di uno, e la tray SHALL elencare lo stesso numero di chat che conta

#### Scenario: cancellata
- **WHEN** si cancella una chat `needs-you`
- **THEN** il soggetto SHALL sparire da ogni numero e dalla inbox

#### Scenario: riaperta
- **GIVEN** una chat archiviata mentre era `finished(done)` non vista
- **WHEN** la persona la riapre
- **THEN** la chat SHALL essere `idle`, senza riga, banner né numero

### Requirement: ATTN-14 — La sidebar tiene e ordina le righe per stato acceso

Una chat o un terminale senza tab SHALL restare in sidebar se il suo soggetto è acceso,
oltre alle eccezioni di oggi (fissata, aperta in un'altra finestra, sotto-agenti vivi).
Le righe accese SHALL stare sopra le altre, fra loro dalla più recente per ingresso nello
stato; le spente SHALL ordinarsi per attività. Né il non-letto né la fase NON SHALL
tenere una riga in cima.

#### Scenario: la chat letta non galleggia più
- **GIVEN** due chat finite e accese, A più recente di B
- **THEN** A SHALL stare sopra B, ed entrambe sopra le chat spente
- **WHEN** la persona guarda A per la soglia
- **THEN** A SHALL tornare al suo posto per attività, su ogni finestra

#### Scenario: una chat senza tab che ti aspetta
- **GIVEN** una chat senza tab aperta, non fissata, che arriva a un permesso
- **THEN** la sua riga SHALL comparire in sidebar, ambra
- **WHEN** la persona risponde e il turno finisce davanti a lei
- **THEN** la riga SHALL sparire

### Requirement: ATTN-15 — La fine del processo chiude il lavoro in volo, e lo dice una volta

Quando il processo di un soggetto finisce (fine della sessione, uscita del PTY o del figlio
CLI, reaper per inattività, tetto di vita, crash, uccisione da parte dello swap, o
assenza del processo a un riavvio del server) i suoi compiti in background SHALL
svuotarsi.

Se c'erano un turno aperto o compiti che contano e la fine non l'ha chiesta la persona, il
soggetto SHALL passare a `finished(error)` con un'epoca nuova e la causa nel `detail`, salvo
un turno che il sistema riprende da solo. Altrimenti lo stato SHALL ricomporsi senza
epoche: un turno già visto NON SHALL riaccendersi, uno non visto SHALL restare com'era.

#### Scenario: il reaper chiude una chat ferma
- **GIVEN** una chat `idle`, già vista, senza compiti in volo
- **WHEN** il reaper ne chiude la CLI dopo 15 minuti
- **THEN** lo stato SHALL restare `idle`, senza epoca, riga né banner

#### Scenario: il tetto di vita chiude una chat in background
- **GIVEN** una chat in attesa del suo lavoro (`working`) con un Agent in volo
- **WHEN** il tetto di vita chiude la CLI
- **THEN** lo stato SHALL essere `finished(error)` con un'epoca nuova, rosso e contato

#### Scenario: un terminale con hook va in crash
- **GIVEN** un terminale claude-code in `working`
- **WHEN** il PTY esce con un codice diverso da zero senza che la persona l'abbia chiuso
- **THEN** lo stato SHALL essere `finished(error)`

#### Scenario: il server riparte e il processo non c'è più
- **GIVEN** una chat in attesa del suo lavoro (`working`) con un compito in volo, e nessun processo vivo dopo il riavvio
- **THEN** lo stato SHALL essere `finished(error)`, contato, senza banner né spinta

### Requirement: ATTN-16 — La tab board conta le card accese

Il numero della tab board e della riga Board SHALL essere il numero di soggetti `task:`
accesi del progetto (tutti i progetti per la board generale): card in review,
parcheggiate, o con un'attesa a metà turno. L'anello delle card in corso resta com'è. Il
numero NON SHALL venire da una cache locale.

#### Scenario: una card parcheggiata
- **GIVEN** una card in review e una parcheggiata nello stesso progetto
- **THEN** la tab board del progetto SHALL dire 2, come la inbox

#### Scenario: la card rimessa in coda
- **WHEN** la card parcheggiata viene rimessa in coda
- **THEN** la tab board SHALL dire 1

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
(`working`, anche quando aspetta un lavoro in background) non entra, un topic archiviato non entra mai, e le righe di
cronologia non entrano.

Il numero SHALL coincidere con le righe di sidebar che mostrano un tier acceso più il
numero della tab board generale (ATTN-16), per gli stessi soggetti, provato calcolandolo
dagli stessi aiutanti. Il menu della tray SHALL elencare i soggetti che il suo numero
conta: chat e terminali fino a otto righe, e le card nei gruppi della board. Sul desktop
lo SHALL scrivere solo la finestra principale (ATTN-08).

#### Scenario: la tray elenca la chat finita che conta
- **GIVEN** una chat `finished(done)`, una `finished(error)` e una `needs-you(permission)`
- **WHEN** si compone il menu della tray
- **THEN** SHALL avere tre righe di chat, come il numero

#### Scenario: le due superfici sullo stesso stato
- **WHEN** un insieme di chat, terminali e card produce il conteggio del chrome
- **THEN** quel numero SHALL essere uguale alle righe di sidebar con un tier acceso più il numero della tab board generale

#### Scenario: la tray elenca anche il terminale e la card
- **GIVEN** un terminale `finished(done)` e una card parcheggiata
- **THEN** il numero SHALL essere 2, e la tray SHALL elencare il terminale e, nel gruppo della board, la card

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

### Requirement: TAB-BADGE-01 — Unread badge on an inactive chat tab

The system SHALL render a numeric badge on an inactive chat tab only while the topic's
attention subject is lit (`needs-you`, or `finished` not seen: ATTN-01), and its text
SHALL be `max(1, unread)`, both read from the same `attention:*` frame. A topic that is
not lit (`idle`, `working` with or without a job left running, seen) SHALL NOT have a badge, whatever its
unread count: unread raised by a woken turn in background, a system message or an edit
waits for the subject to light up.

#### Scenario: Unread count paints a badge on the inactive tab
- **GIVEN** two topics A and B are open as pane tabs and B is the active tab
- **WHEN** the server sends `attention:updated` for topic A as `finished(done)` with an unread count of 3
- **THEN** A's pane tab shows a badge whose text is exactly "3"

#### Scenario: A lit topic with no unread still shows one
- **WHEN** topic A is `needs-you(question)` with an unread count of 0
- **THEN** A's inactive pane tab shows a badge whose text is exactly "1"

#### Scenario: Unread in background paints nothing
- **WHEN** topic A is `working` on a job left running, with an unread count of 2
- **THEN** no badge element is rendered inside A's tab

### Requirement: PARITY-01 — Same count on the tab bar and the sidebar row

The system SHALL show the same number for a topic on its pane tab and on its sidebar row,
computed by the same `attentionOf` from the same frame, and SHALL NOT render the retired
per-Claude phase dot on any surface — the phase signal is folded into the attention tier.

#### Scenario: One unread event paints both surfaces with the same number
- **GIVEN** topics A and B are open as pane tabs and B is active, leaving A unfocused on both surfaces
- **WHEN** the server sends `attention:updated` for topic A as `finished(done)` with an unread count of 2
- **THEN** A's pane tab shows a badge of "2"
- **AND** A's sidebar row shows a badge of "2"

#### Scenario: No legacy phase dot survives anywhere
- **GIVEN** the app is rendered with the badge above in place
- **WHEN** the page is searched for the retired `ClaudePhaseDot` tooltips ("Awaiting your approval", "Claude is generating…", "Claude is running a tool", "Claude replied — waiting for you", "Approval timed out — still waiting on you", "Session error", "Finished a turn — click to open")
- **THEN** none of them is present

### Requirement: SEEN-01

Il pallino di attenzione su una card di GRUPPO SHALL spegnersi quando la chat
che l'ha acceso viene letta, senza aspettare il messaggio successivo.

La card del gruppo SHALL derivare da `rollupAttention` dei suoi figli, come la riga
e la tab di progetto: il «visto» che la spegne è quello del server (ATTN-06), non un
cancello `seenSubjects` della finestra, che resta solo come ottimismo locale.

#### Scenario: la chat letta non tiene acceso il gruppo

- **WHEN** una chat dentro un gruppo finisce il turno e la card prende il
  pallino, e poi quella chat viene aperta e letta
- **THEN** la card del gruppo torna neutra insieme alla riga e alla tab, e non
  resta un'intestazione accesa sopra righe tutte calme, in ogni finestra

#### Scenario: il gruppo principale e' una card come le altre

- **WHEN** la chat letta sta nel gruppo principale invece che in uno spazio
- **THEN** vale la stessa regola: nessun ramo esente

### Requirement: SEEN-02

Il segno «finito» di un terminale, con o senza hook, SHALL essere lo stato di
attenzione `finished` del suo soggetto, e SHALL spegnersi col visto del server
(ATTN-06), sulla tab, sulla riga, sul rollup di progetto e sulla card del gruppo
insieme. Una richiesta di permesso (`needs-you(permission)`) SHALL invece tenerli
accesi anche se il terminale è stato visto. Nessun cancello per finestra SHALL
filtrare il segno, quindi il secondo turno finito di una sessione senza hook SHALL
riaccenderlo con un'epoca nuova.

#### Scenario: il ramo dei terminali resta acceso per ciò che nessuno ha visto

- **WHEN** un terminale dentro un gruppo ha un turno finito non ancora visto
  e le chat dello stesso gruppo sono tutte lette
- **THEN** la card del gruppo resta accesa per il terminale

#### Scenario: un terminale fermo su una fase, già guardato

- **WHEN** un terminale claude-code del gruppo ha finito il turno ed è stato visto
- **THEN** la card del gruppo torna neutra insieme alla sua tab e alla sua riga,
  e una richiesta di permesso (`awaiting-approval`) la tiene invece accesa

#### Scenario: il secondo turno di un terminale senza hook

- **GIVEN** un terminale senza hook il cui primo turno finito è stato visto
- **WHEN** finisce un secondo turno, con la pane non a fuoco
- **THEN** tab, riga e card del gruppo SHALL riaccendersi blu
