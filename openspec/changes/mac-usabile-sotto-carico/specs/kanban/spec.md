# Delta: kanban (mac-usabile-sotto-carico)

## MODIFIED Requirements

### Requirement: KANBAN-15 — Prima della review i comandi girano, e un rosso che non ha misurato niente non è un rosso

Una board SHALL poter dichiarare fino a `MAX_CHECKS` comandi che una consegna
deve far passare prima di entrare in review. I comandi SHALL essere DICHIARATI da
una persona nelle impostazioni della board: nessun default SHALL essere dedotto
dal progetto. SHALL girare nel worktree DELLA CONSEGNA, in sequenza e
nell'ordine dichiarato, e SHALL fermarsi al primo rosso.

Una riga dichiarata può essere un check di EVIDENZA invece di un comando: le righe
`github-ci:e2e` (`E2E_CI_CHECK`) e `github-ci:unit` (`UNIT_CI_CHECK`). Quelle righe
NON SHALL essere passate a una shell, SHALL essere misurate DOPO tutti i comandi,
qualunque sia la loro posizione nell'elenco, e solo se sono tutti verdi, secondo
KANBAN-84. Il loro esito entra nel verdetto come quello di un comando: il «non
misurato» è `unknown`, il rosso è `fail`, e un elenco di esiti che non ne contiene
una è più corto dei comandi dichiarati.

Quando al worktree mancano le dipendenze, il sistema SHALL installarle PRIMA dei
comandi dichiarati. Senza, i cancelli morivano su un'uscita 127 indistinguibile
da un rosso vero — otto task in un giorno, il 13/08/2026.

Il verdetto SHALL avere TRE valori e mai due: `pass`, `fail`, `unknown`. Un
comando SCADUTO, uno che NON È PARTITO, e un elenco di esiti più corto dei
comandi dichiarati SHALL dare `unknown`. Misurato il 18/08/2026 sul database
vivo: sei card su quindici marcate `fail` erano soltanto scadute — il 40% dei
rossi accusava il codice per un guasto della macchina.

Un rosso VERO accanto a uno scaduto SHALL restare `fail`: il dubbio non
cancella una prova.

Il cancello NON SHALL vivere dentro la richiesta HTTP. Una suite può durare più
del tempo che una socket resta aperta, e quando quel tempo scadeva lo stato
restava «in corso» per sempre. Mentre i comandi girano la richiesta SHALL
rispondere «in corso» con un codice proprio, e la card SHALL restare dov'era.
Un rosso SHALL rifiutare la transizione con un codice proprio, e la card SHALL
tornare all'agente.

Le corse SHALL essere condivise per chiave: N richieste sullo stesso task
producono UN giro di comandi. Un commit diverso SHALL far rimisurare. Una corsa
che esplode SHALL liberare la chiave invece di avvelenare la successiva. Il
numero di corse simultanee SHALL avere un tetto, e il default SHALL essere UNO:
il 18/08/2026 sei barre in parallelo hanno portato il carico a 78,83 su dodici
core.

Il tetto conta le corse che eseguono COMANDI. Una corsa che, finiti i comandi,
aspetta soltanto la rete SHALL restituire il suo posto: la prima corsa in coda
SHALL partire subito, e la corsa restituita NON SHALL contare fra le corse che il
dispatcher somma al carico. SHALL restare viva per tutto il resto: le richieste
sulla sua chiave rispondono «in corso», e chi aspetta il suo verdetto lo riceve.

Il verdetto SHALL sopravvivere alla richiesta che l'ha chiesto per una finestra
dichiarata.

Il tetto di tempo di un comando SHALL contare dal momento in cui il comando
PARTE, non da quando è stato lanciato: i comandi passano da `scripts/slot.ts`,
che prima aspetta uno slot libero della macchina (core/4), e quell'attesa non
è tempo del comando. Fino al 05/09/2026 il board la contava: sotto una flotta
la sola coda superava i dieci minuti, `test:unit` veniva ucciso mentre ancora
aspettava di partire, e la card leggeva «timeout» di una suite che non aveva
eseguito un test. `slot.ts` SHALL scrivere su stderr una riga riconoscibile
quando ottiene lo slot, con i secondi di coda; il runner dei check SHALL
leggere stderr man mano e da quella riga far ripartire il tetto; il commento
sulla card SHALL dire il tempo di esecuzione e, a parte, quello di coda.

Il semaforo dei cancelli NON SHALL spegnersi per i check della board. I comandi
girano con `CI=1` (Playwright lo legge), e `CI` senza un conteggio esplicito
spegneva il semaforo: il 15/09/2026 due `test:unit:shards` di due card hanno
girato affiancati per 741 e 744 secondi, entrambi «0 s in coda». Il runner dei
check SHALL quindi passare il numero di slot in modo esplicito (quello
dell'ambiente del server se c'è, altrimenti il default della macchina), e un
valore esplicito, `0` compreso, SHALL arrivare intatto.

Un comando NUOVO NON SHALL partire con la memoria libera sotto il pavimento
(`DISPATCH_MEM_FLOOR_NATIVE_GB`, 6 GB). Nessun freno davanti a un check leggeva
la memoria, e l'ammissione non ne vede il costo: la card entra a memoria libera
e consegna decine di minuti dopo un albero unit da 4-11 GB. Il comando SHALL
aspettare PRIMA di partire, e l'attesa NON SHALL consumare il suo tetto. La
memoria SHALL essere la lettura più bassa della finestra di 2 minuti di KANBAN-75,
non l'istante: il 15/09/2026 typecheck, lint e deadcode sono partiti ciascuno alla
prima lettura sopra 6 GB (5,0-6,0 prima), e quattro comandi di consegne diverse
sono partiti sullo stesso giro. Il comando SHALL quindi aspettare anche:
- lo swap sostenuto (KANBAN-75), SENZA fallire aperto finché dura: un giro ripartito
  dopo un'interruzione non deve ripartire dentro lo swap che l'ha interrotto;
- 120 secondi dalla partenza di un comando di un ALTRO giro ancora vivo: un rilascio
  per finestra, fra i giri; il comando successivo dello stesso giro non aspetta il
  suo predecessore, che è finito, ma cede il turno a un giro che aspettava già da
  prima (altrimenti un giro di tre comandi si riprende il rilascio a ogni uscita e
  l'altro aspetta tutta la sua fase locale).
Non c'è un prezzo per comando: con la suite unit letta dalla CI della PR
(`github-ci:unit`, KANBAN-84) nessun comando di consegna di topics-app supera 1 GB
(tsc 460 MB, build vite 316 MB, misurati il 15/09), e la riga è il pavimento. SHALL
fallire aperto solo sulla memoria: un giro aspetta al massimo 30 minuti IN TOTALE,
poi i comandi rimasti partono comunque, mai con lo swap sostenuto; una memoria che
non si misura (fuori da macOS) non fa aspettare. Il rilascio dopo un'attesa SHALL
comparire nel log con i secondi aspettati, e ogni cambio di motivo di attesa una volta.

Con lo swap sostenuto (KANBAN-75) il server SHALL interrompere DA SOLO il giro di
check più giovane fra quelli di una card il cui albero tiene almeno 1 GB, al massimo
uno ogni 120 secondi e al massimo 2 volte per consegna (`taskId@commit`): dopo la
seconda il giro va fino in fondo, e un commit nuovo è una consegna nuova. Risposta
del proprietario (15/09/2026): lo fa Topics da solo, interrotto e mai rosso, e
riparte da solo. Un albero sotto 1 GB (tsc, build vite, rail statici) NON SHALL
essere interrotto: non restituisce niente e costa un giro. Il comando ucciso NON
SHALL diventare un esito: il giro SHALL lanciare l'interruzione con motivo `swap`
prima di registrarlo, nessun comando successivo SHALL partire, nessun verdetto,
nessun picco di memoria della card. La consegna SHALL rispondere 202
`review_checks_running`, SHALL restare ricordata dal server, e il server SHALL
riemetterla da solo quando la corsa è finita, senza riallineare di nuovo il ramo
(la ripartenza è la stessa consegna: due `git merge main` nello stesso worktree si
contendono `index.lock`). La card SHALL ricevere un commento di servizio per ogni
interruzione, con swap-in, debito di memoria, il comando e i GB del suo albero, e
che è l'interruzione N di 2. Un verdetto registrato SHALL azzerare il conto delle
interruzioni della card.

Uno spegnimento del server SHALL portarsi via gli alberi dei check in corso, e
NON SHALL scriverne un verdetto. `slot.ts` lancia il comando in un gruppo di
processi suo, e al riavvio l'albero restava vivo figlio di pid 1 mentre il
server nuovo rilanciava i check delle stesse card: il 15/09/2026 alle 02:04
quattro alberi unit vivi insieme, due orfani. Un comando ucciso dallo
spegnimento non ha misurato niente: il giro SHALL interrompersi senza esito e
nessun comando successivo SHALL partire. «Senza esito» NON è «nessun check»: il
cancello lo riportava come `null`, la stessa parola di una board senza comandi,
e la consegna passava in review con i check ancora «in corso» a ogni reload del
watcher. La consegna in attesa di quel giro SHALL rispondere come una gamba
ancora in volo (202 `review_checks_running`), NON con un errore, e la card NON
SHALL muoversi. L'agente non SHALL ritentare a mano: il client (`update_task`)
richiama da solo, trova il socket chiuso dall'uscita e ritenta quel silenzio
dentro la sua grazia di trasporto, e dopo il riavvio un giro nuovo rimisura la
consegna. Un 503 arrivava invece all'agente come errore, e l'agente richiamava
subito dentro il server morto. Una consegna che arriva mentre il server si sta
spegnendo SHALL aspettare la sua gamba prima della stessa risposta, senza
riallineare il ramo: risposta subito, il client richiamerebbe a raffica per
tutta l'uscita, spendendo una gamba a chiamata.

#### Scenario: con CI il semaforo resta acceso
- **GIVEN** due check della board sullo stesso cancello, con `CI=1` e nessun conteggio nell'ambiente del server
- **THEN** SHALL girare uno dopo l'altro, e uno dei due SHALL riportare il tempo di coda

#### Scenario: sotto il pavimento di memoria il comando aspetta
- **GIVEN** memoria libera sotto il pavimento per 1,5 s e un tetto di 1 s
- **THEN** il comando SHALL partire solo dopo, e finire verde e non scaduto
- **AND** con la memoria sempre sotto, il giro SHALL aspettare il suo limite UNA volta e poi far partire tutti i comandi

#### Scenario: una lettura sola non rilascia un comando
- **GIVEN** due minuti a 5,2 GB e poi una lettura a 6,0
- **THEN** il comando NON SHALL partire su quella lettura, e SHALL partire quando la finestra intera sta sopra il pavimento, con la riga di log del rilascio

#### Scenario: un rilascio per finestra fra i giri
- **GIVEN** due giri che aspettano con 11 GB nella finestra
- **THEN** parte un comando solo, e l'altro parte quando il primo finisce o 120 s dopo il suo rilascio, anche se il primo giro ha altri comandi dietro

#### Scenario: i magazzini pieni contano da soli
- **GIVEN** 60 secondi di campioni con 956 pagine rilette al secondo e il debito fermo a +0,4 GB al minuto, compressore e swap quasi pieni
- **THEN** il verdetto SHALL essere swap sostenuto
- **AND** con 199 pagine al secondo e il debito fermo SHALL restare calmo

#### Scenario: lo swap sostenuto vince sul fallire aperto
- **GIVEN** un limite di 5 minuti, 5 GB per tutto il tempo e lo swap sostenuto dal minuto 4 al minuto 9
- **THEN** niente parte prima del minuto 9, e al minuto 9 il comando parte comunque con la riga «starts anyway»

#### Scenario: il freno sotto swap interrompe il giro più giovane
- **GIVEN** tre giri con alberi da 8 GB, 2 GB e 0,4 GB, partiti in quest'ordine, e lo swap sostenuto
- **THEN** SHALL essere ucciso il giro da 2 GB, con il commento «Check interrotti, non rossi» e «Interruzione 1 di 2»
- **AND** 60 s dopo non si uccide niente, 121 s dopo il giro da 8 GB
- **AND** una consegna interrotta due volte va fino in fondo, e un commit nuovo conta di nuovo

#### Scenario: il giro interrotto per swap riparte da solo e non è rosso
- **GIVEN** una consegna con un check `sleep 120` in corso e il freno che ne uccide l'albero
- **THEN** la gamba SHALL rispondere 202, nessun commento «ROSSI» o «Consegna fermata» SHALL comparire, e senza altre gambe del client il server SHALL rifare il giro e portare la card in review
- **AND** il ramo SHALL essere riallineato una volta sola

#### Scenario: lo spegnimento non inventa un rosso
- **GIVEN** un check in corso e un secondo in attesa
- **WHEN** il server si spegne
- **THEN** l'albero del primo SHALL essere ucciso, il secondo NON SHALL partire, e il giro SHALL finire senza verdetto

#### Scenario: lo spegnimento non manda in review una consegna senza check
- **GIVEN** una card in lavorazione che consegna con `PATCH status=review`, e la sua gamba in volo su un check `sleep 120` (oppure su un giro fermo nell'attesa di memoria)
- **WHEN** il server ferma i check
- **THEN** la risposta SHALL essere 202 `review_checks_running`, la stessa di una gamba in volo, e la card SHALL restare `in_progress`
- **AND** una consegna che arriva prima dell'uscita SHALL aspettare la sua gamba prima della stessa risposta, senza riallineare il ramo

#### Scenario: il client di update_task attraversa il riavvio da solo
- **GIVEN** una consegna con i check in corso e il client MCP `update_task` in attesa
- **WHEN** le gambe ricevono in fila 202, 202 interrotta dallo spegnimento, `ECONNREFUSED` e poi 200 dal server nuovo
- **THEN** `update_task` SHALL risolversi con la card in `review`, senza errori per l'agente

#### Scenario: la coda per lo slot non consuma il tetto
- **GIVEN** un comando che aspetta 1,5 s uno slot, stampa la riga di `slot.ts` e poi lavora 1,5 s, sotto un tetto di 2 s
- **THEN** il comando SHALL finire verde, non ucciso, e l'esito SHALL riportare il tempo di coda

#### Scenario: senza la riga il tetto conta dal lancio
- **GIVEN** lo stesso comando senza la riga di `slot.ts`
- **THEN** SHALL essere ucciso al tetto, come prima

Il tetto SHALL seguire anche un rallentamento che il comando DICHIARA prima di
cominciare. Sotto carico il runner della suite unit dimezza gli shard (4 → 2)
perché aggiungere processi a una macchina già piena li rallenta tutti: la stessa
suite ci mette circa il doppio, e quel doppio è la decisione, non un guasto. Il
comando SHALL poter scrivere su stderr una riga riconoscibile col fattore di
rallentamento; il runner dei check SHALL moltiplicare il tetto per quel fattore,
UNA volta, con un massimo dichiarato; il commento sulla card SHALL nominare il
piano ridotto, così che un verde da mezz'ora non sembri un tetto mai applicato.
Misurato sulla card `40dc7674` il 05/09/2026: verde in 7m59s a 4 shard, oltre i
20 minuti del tetto fisso a 2 shard con la flotta attiva, e una consegna
corretta rifiutata tre volte per una ragione che col suo codice non c'entrava.

Il massimo SHALL restare: oltre quello il comando non è lento, è appeso.

#### Scenario: il rallentamento dichiarato allunga il tetto
- **GIVEN** un comando che dichiara la riga di rallentamento e poi lavora più del tetto base
- **THEN** SHALL finire verde, e l'esito SHALL riportare il fattore dichiarato

#### Scenario: nessuna dichiarazione, nessuno sconto
- **GIVEN** lo stesso comando senza quella riga
- **THEN** SHALL essere ucciso al tetto base

Sulla card SHALL essere scritto lo stato, gli esiti parziali e il commit
misurato. Il commento del VERDE SHALL essere una riga sola e di specie servizio:
l'elenco completo su ogni consegna verde erano 92 copie identiche in sette
giorni. Il commento del ROSSO SHALL essere per esteso e di specie ordinaria — è
la sola cosa che l'agente deve leggere.

Il progresso SHALL essere «fatti su totale» fin dal primo istante, e numeri
incoerenti SHALL essere scartati invece che mostrati.

Una configurazione illeggibile SHALL spegnere il cancello, non sollevare un
errore.

#### Scenario: mentre i comandi girano, la chat dell'agente lo dice
- **GIVEN** una consegna a cui il cancello ha risposto «in corso» e un tool `update_task` ancora aperto nel turno dell'agente
- **WHEN** il client richiama e il cancello risponde di nuovo «in corso»
- **THEN** il tool in corso SHALL mostrare quanti comandi sono passati, quale gira, quali aspettano e da quanto, e SHALL dire che l'attesa è del cancello e non dell'agente
- **AND** in coda dietro un'altra card SHALL dirlo, senza inventare un comando in corso

#### Scenario: un comando che non è mai partito
- **GIVEN** un worktree in cui un comando non può nemmeno avviarsi
- **THEN** l'esito SHALL essere `unknown`, non `fail`
- **AND** il testo SHALL dire che non è partito, e NON SHALL parlare di tempo massimo

#### Scenario: dieci richieste sullo stesso task
- **GIVEN** dieci richieste concorrenti sulla stessa chiave
- **THEN** SHALL girare un solo giro di comandi

#### Scenario: la riga di evidenza non va a una shell e viene dopo i comandi
- **GIVEN** una board che dichiara `github-ci:e2e` PRIMA di `true`
- **WHEN** una card consegna e la CI risponde verde
- **THEN** `true` SHALL girare per primo, la riga `github-ci:e2e` NON SHALL essere eseguita da `sh`, e la consegna SHALL entrare in review con due esiti verdi

#### Scenario: una corsa che aspetta la rete restituisce il posto
- **GIVEN** un tetto di UNA corsa, la card A che ha finito i comandi e aspetta la CI, la card B in coda
- **THEN** B SHALL partire mentre A aspetta
- **AND** A SHALL contare zero fra le corse del dispatcher, e le richieste di A SHALL rispondere «in corso»

#### Scenario: la configurazione è rotta
- **GIVEN** impostazioni di board illeggibili
- **THEN** il cancello SHALL essere spento, e la consegna SHALL procedere come
  su una board che non ne dichiara


### Requirement: KANBAN-75 — Il tetto sa contare gli agenti O dare a Topics una fetta del PC, e sono due domande diverse

Il freno globale del dispatch SHALL avere DUE modalità, e la scelta fra le due
SHALL essere esplicita e persistente per macchina (riga riservata
`board_settings['*']`, la stessa del tetto di oggi).

1. **Per numero** (`count`) — quella di sempre, e SHALL restare il DEFAULT:
   quanti agenti insieme (`auto`, numero fisso, nessun tetto).
2. **A budget** (`resources`) — UNA manopola: «Topics può usare il N% di ciò
   che è libero» (default 60%). La percentuale SHALL valere su ENTRAMBI gli
   assi: tetto di CPU = `N% × core` in core-unità, tetto di RAM = `N% × RAM`, e
   dentro quel tetto la parte usabile è la quota del libero (sotto).
   In questa modalità il tetto NUMERICO non si applica: è l'alternativa, non un
   secondo freno sovrapposto.

**COSA SI MISURA: il nostro albero, non il carico della macchina.** La misura
SHALL essere l'uso dei processi di Topics — server, sidecar, ponte PTY, ogni
agente e i suoi figli (tsc, eslint, bun test, vite, il Chromium degli e2e) —
campionato per differenza di CPU, mai un load average. Il `load1` descrive
soprattutto le app di chi sta al computer e non dice quanto stiamo prendendo noi.

**IL BUDGET È UN TETTO, NON UN DIRITTO, E LA QUOTA È SUL LIBERO.** L'usabile
SHALL essere `min(N% × core, N% × (core − CPU altrui))`, e per la memoria
`min(N% × RAM, memoria nostra + N% × memoria libera)`: chi non è di Topics tiene
sempre la sua fetta di ciò che avanza, quindi la parte che lasciamo cresce con
quella che gli altri prendono (deciso il 14/09/2026). La CPU altrui entra
smussata sulla mediana delle ultime letture, perché un picco di un secondo non
chiuda la porta. Su una macchina ferma usabile e tetto coincidono; su una
macchina occupata da altri la nostra fetta si stringe, e l'interfaccia SHALL
dirlo invece di promettere un numero che nessuno può avere.

**AMMISSIONE UNA ALLA VOLTA, CON ISTERESI.** Si ammette UN agente alla volta, e
solo se `uso + costo stimato di un agente ≤ usabile`; il costo SHALL essere la
MEDIANA degli ultimi misurati, mai una costante. «Una alla volta» SHALL valere
per TUTTO il dispatcher e per ogni porta: fra due partenze passano almeno 9
secondi (`ADMISSION_SPACING_MS`), che la partenza sia un dispatch nuovo, una
ripresa (riavvio, rifiuto in review, risposta a una domanda) o venga da un'altra
board. Un resume che trova la rampa chiusa aspetta nella coda delle attese di
slot, col chip `queued` e senza nota nel thread. Il giro di `reconcile` SHALL
essere uno solo alla volta: chi arriva a giro in corso riceve quel giro. Prima la
rampa era un contatore del singolo `tick(progetto)`: tre board ammettevano tre
card per giro, tre giri sovrapposti ne prendevano tre, e un riavvio con sedici
turni tagliati ne faceva ripartire dodici nello stesso istante. Una volta trattenuta, la coda
SHALL ripartire sotto l'80% del budget e non alla soglia stessa: fra un dispatch
e la lettura che lo vede passano secondi, e senza quel salto la coda si svuota
tutta contro una misura vecchia (misurato il 07/09/2026: otto card in un tick a
load 12 su 12 core, e dieci minuti dopo load 155 con 13,4 GB di swap).

**IL PREZZO DELLA MEMORIA È QUELLO DI UNA CARD, E SI TIENE PER TUTTO IL TURNO.**
Il costo in memoria di un agente SHALL essere la mediana dei picchi delle ultime
9 card, e il picco di una card è il footprint massimo dell'albero di processi dei
suoi check pre-review in un giro, un numero per card. Non il footprint delle
sessioni: col runtime nativo una card non ha un processo suo, e i suoi tool e i
suoi check sono figli del server, quindi la mediana girava sui terminali della
persona e restava sul pavimento mentre un `test:unit:shards` teneva 11 GB. Senza
campioni (dopo ogni riavvio del server) una card vale 4 GB, con un tetto di 6.
La prenotazione degli agenti ammessi SHALL durare 90 secondi sull'asse CPU e
TUTTO il turno sull'asse memoria: i cancelli di un agente arrivano da due a sei
minuti dopo la partenza (mediana 160 s, misurata il 14/09/2026), e una
prenotazione che scade prima fa entrare la coda contro una lettura che sta per
cambiare. Sul rigioco di quella notte (24 GB liberi, 20 card, quota 80%) erano
20 partenze in 4 minuti; con prezzo e prenotazione sono al massimo 5 in 5 minuti.

**IL CONTROLLO DINAMICO: si congela l'eccesso.** Rifiutare il prossimo agente non
fa niente per una macchina che è già oltre. Quando l'uso supera il budget per DUE
letture di fila SHALL essere congelato (SIGSTOP all'albero) UN solo bersaglio per
lettura, dal meno costoso da perdere: i check runner, il più recente per primo.
Si scongela (SIGCONT) in ordine inverso dopo due letture sotto il 70% del budget.
NON SHALL essere congelato niente altro: server, sidecar, ponte PTY e i browser
dell'utente restano vivi sempre. Un check congelato SHALL fermare anche il PROPRIO
orologio, perché un'attesa nostra non è uno stallo, e SHALL essere detto nel
thread della card («congelata per carico, riprende da sola»).

**La lettura del controllo è SOLO la CPU, e la memoria NON SHALL congelare
niente** — con l'unica eccezione di KANBAN-85, che sotto swap sostenuto congela
un COMANDO di un agente (mai una corsa di check, mai un CLI) con regole sue di
scongelamento, di durata e di registro. Il 15/09/2026 si è provato l'asse memoria (il peggiore fra la CPU sul
budget e il pavimento sulla memoria libera), perché sotto thrash la CPU legge
quasi zero, e un congelamento per memoria non ha via d'uscita: un SIGSTOP non
restituisce la memoria che l'albero congelato tiene, quindi la lettura che l'ha
congelato non rientra da sola, e il congelamento ferma anche la scadenza del
check e il timer di `slot.ts` nello stesso albero. Misurato col governatore
vero: due corse congelate a 5,5 GB restavano congelate dopo 1080 letture, e
dopo altre 1080 a 8,0 GB, sopra il pavimento a cui il dispatcher ammette. Due
corse congelate tengono entrambe le corsie del cancello dei check, nessuna card
viene più misurata e il freno non si apre mai, contro la regola che ogni freno
fallisce aperto. Le leve della memoria sono l'attesa PRIMA che un check parta
(KANBAN-15), che ha un limite, e sotto swap sostenuto l'interruzione del giro di
check più giovane (KANBAN-15), che uccide invece di congelare. Un check
congelato per la CPU SHALL scongelarsi quando la CPU scende, qualunque cosa
dica la memoria.

I CLI DEGLI AGENTI non si congelano con un segnale, ed è una decisione: un CLI
fermato a metà stream API può perdere la connessione, e la CPU non è lì — con otto agenti in
volo gli agenti stessi valevano il 5,7% della macchina mentre i loro cancelli
tenevano il resto. Quello che li trattiene è l'ammissione.

**L'ECCEZIONE, e sta nel contratto.** A zero agenti vivi si ammette SEMPRE, per
quanto carica sia la macchina, e il verdetto lo DICHIARA (`firstAgentExempt`).
Senza, chi lavora sul proprio Mac tiene il budget superato da solo, la coda non
parte mai, e il modo in cui lo si scopre è che qualcuno guarda dodici card ferme
e conclude che il dispatcher è rotto. «Zero» SHALL contare anche le corse di
check pre-review in volo: una coda ferma dietro uno shard da 11 GB non è una coda
che non parte mai, parte quando lo shard finisce.

**Il pavimento resta sopra a tutto.** `dispatchResourceBlock` (disco e RAM sotto
il pavimento) vale in ENTRAMBE le modalità e vince sul budget: un disco pieno non
si riassorbe da solo, il carico sì. Per questo il motivo di coda del budget è un
tipo A SÉ (`resource_pressure`, tono `waiting`) e non il pavimento
(`resource_floor`, tono `stalled`): il primo riparte da solo, il secondo aspetta
una persona, e chiamarli con la stessa parola è la bugia che il chip esiste per
non dire. Lo stesso motivo SHALL comparire su una card In corso il cui `resume`
è trattenuto da pavimento, spesa delle 24 ore o budget (chip `queued`): il motivo
SHALL viaggiare anche sulla riga (`dispatch_error`), e un «in coda» senza perché
su una card che non partirà è la stessa bugia in un'altra colonna. Quel motivo
SHALL essere il blocco della SUA attesa, scritto da `resume` quando la trattiene e
creduto solo finché la riga dice la stessa frase, MAI il blocco pubblicato dal
tick: il tick gira solo sulle board con todo in coda ed esce prima di pubblicare a
board in pausa, quindi svuotata la coda a mano o messa in pausa la board il
blocco pubblicato resta un pavimento rientrato. Il resume trattenuto solo dal
tetto, quello che parte e ogni altra scrittura del chip lo tolgono. Non dice
l'interruttore: `resume` rivaluta la sua attesa a ogni giro anche a dispatch
spento, e riparte appena il blocco rientra.

Quella scrittura SHALL avvenire solo quando l'attesa CAMBIA: un altro tipo di
blocco, oppure altre parole a numeri esclusi. Per il pavimento della macchina le
parole non contano, conta la risorsa (Memoria, Disco): un episodio di memoria
passa per tre frasi («sotto il pavimento», «tenuti per chi parte», «in
risalita»), e con l'isteresi il compositore passa dall'una all'altra proprio a
6,0 GB, dove oscillavano le letture del 15/09. La stessa attesa con un'altra
lettura o un'altra di quelle frasi SHALL rinfrescare riga e chip al massimo una
volta ogni 60 secondi. Il 15/09 ogni
ritentativo (ogni 5-6,75 s) riscriveva `dispatch_error` con i GB del momento
(5,7, 5,9, 6,0), toccava `updated_at` e mandava `task:updated` a ogni client:
sette card ferme facevano circa 70 frame al minuto, e ognuno rifaceva l'albero
dell'app e il menu della barra. Saltata la scrittura resta intatto anche il tipo
dell'attesa, perché la card lo crede solo finché combacia con la frase della riga.

Il pavimento di memoria SHALL leggere una FINESTRA, non un istante: la lettura
più bassa degli ultimi 2 minuti (`server/services/mem-signal.ts`, un campione ogni
10 s sul battito del dispatcher). Il 15/09/2026 si è riaperto tre volte su una
lettura sola (14,5 GB con 12 GB di swap, poi 10,4 fra due 5,5) e si è richiuso
entro 19-115 s. La finestra SHALL essere vuota al boot, e un buco di più di 30 s
fra due campioni (il loop fermo, succede solo sotto thrash) SHALL svuotarla: a
finestra non piena la coda aspetta, e la card dice da quanti secondi misura. Fuori
da macOS la memoria non si misura e il pavimento di memoria non trattiene.

La riga SHALL essere una sola nei due versi, e il tempo è l'isteresi: si ferma
appena il minimo dei 2 minuti scende sotto la riga, riparte solo quando l'intera
finestra resta sopra. La riga è il pavimento quando niente di nostro è sulla
macchina, e il pavimento più il prezzo di una card quando c'è un turno locale in
volo o una corsa di check: questa macchina legge 6,1-11,7 GB senza lavoro di
Topics, e «pavimento più prezzo» (10-12 GB) terrebbe ferma per sempre una board
vuota. La prenotazione per la VITA del turno SHALL contare una volta sola: in
modalità «per risorse» la tiene l'asse del budget (che legge anch'esso il minimo
della finestra, non l'istante), e il pavimento non aggiunge niente; in modalità
«per numero» il pavimento è l'unico freno di memoria e aggiunge il prezzo di ogni
turno locale in volo. Contata su tutti e due gli assi, un turno in volo portava la
riga a 6 + 4 + 4 = 14 GB, sopra ogni lettura di questa macchina.

La frase del pavimento, che va nel log e nel thread della card, SHALL cominciare
con «Memoria», SHALL dire la lettura più bassa degli ultimi 2 minuti, «sotto il
pavimento» solo quando quella lettura è sotto il pavimento, i GB che servono per
una card in più quando è sopra il pavimento ma sotto la riga, la memoria tenuta
per gli agenti al lavoro solo quando il pavimento la conta, e che riparte quando
la memoria resta sopra la riga per 2 minuti di fila. Il prezzo citato è quello che
il cancello usa. Le frasi sono un solo episodio: «coda ferma» si scrive una volta.
La riga del log del riavvio SHALL contare le riprese partite davvero e, a parte,
quelle rimaste in attesa di un posto.

Ogni 60 secondi, anche a board ferma, il server SHALL scrivere nel suo log una riga
`[memsig]` con lettura, minimo dei 2 minuti, copertura, swap-in al secondo, debito
di memoria al minuto, compressore, swap usato, carico, verdetto di swap, turni in
volo, corse di check e l'albero di check più pesante (`?` dove manca il valore):
non decide niente, è lo strumento con cui si misurano le soglie e l'esito.

Lo swap SHALL dirsi SOSTENUTO solo quando, su 60 secondi di campioni, le pagine
rilette dal disco sono almeno 10 al secondo E il debito di memoria (compressore più
swap usato) cresce di almeno 0,5 GB al minuto. Le pagine rilette da sole non
separano il recupero (65/s alle 11:23 del 15/09, debito in calo) dal thrash
(12,8-33,6/s alle 14:06, debito +8,8/+14 GB al minuto); lo swap usato sta nella
somma perché un compressore saturo sposta segmenti su disco. Il livello di
pressione del kernel NON SHALL essere usato: è un rapporto del compressore, e i
picchi del 10/09 e del 15/09 stavano al livello 1. Le soglie sono provvisorie, e
l'esito si misura sulle righe `[memsig]` e `[LAG]` 72 ore dopo il land.

Lo swap SHALL dirsi sostenuto ANCHE con le sole pagine rilette dal disco, quando
sono almeno 200 al secondo, qualunque cosa faccia il debito. La prima regola si
chiude proprio nel caso peggiore: il 16/09 alle 14:41, con la board ferma, il Mac
rileggeva 956 pagine al secondo con carico 92,7, swap 15,5 GB su 16 e compressore
a 15,1 GB, e il verdetto diceva ancora «calmo» perché il debito non poteva più
CRESCERE, essendo pieni tutti e due i magazzini. La soglia sta a tre volte il
recupero più veloce mai letto qui (65/s) e a un quinto di quel 956/s.

**UN CANCELLO PER NOME, non solo per numero.** Il semaforo dei check
(`scripts/gate-slot.ts`) SHALL ammettere UNA sola corsa per NOME di check su
tutta la macchina, oltre al conteggio degli slot: tre worktree che consegnano
insieme facevano partire tre `eslint` (1,3 GB in due, misurato), e serializzare
due corse dello stesso cancello non costa lavoro in più.

L'attesa per il PROPRIO nome SHALL essere più lunga di quella per uno slot
(30 minuti, `TOPICS_GATE_NAME_MAX_WAIT_MS`: con i 10 dello slot resta sotto i 50 che `update_task` aspetta i check) e restare un limite: dieci minuti
erano meno di una suite unit intera su una macchina carica, e il 14/09/2026 alle
01:08 due `test:unit:shards` da 11 GB l'uno giravano insieme perché il secondo
aveva finito la sua attesa ed era partito «accanto». Mentre un cancello aspetta
se stesso il suo orologio NON SHALL correre: `slot.ts` stampa la riga di attesa
e i check pre-review fermano la scadenza fino alla riga di slot acquisito.
Il cancello per nome SHALL valere anche per i check della board, che girano con
`CI=1`: il runner passa il numero di slot esplicito (KANBAN-15), e senza
strozzatura `slot.ts` NON SHALL stampare la riga di slot acquisito, che su una
card si leggeva come «0 s in coda» di un semaforo mai partito.

**L'INTERFACCIA parla in core a disposizione, una volta sola.** Nelle
impostazioni restano a vista: quanti agenti lavorano con l'anello accanto, la
manopola «N% del libero», e UNA riga «Topics usa X dei Y core a disposizione»
col verdetto. Il verdetto SHALL essere quello del cancello (`admission` sulla
lettura della capacità: stesso campione, stesso costo misurato, stessa isteresi,
e dice quale asse trattiene), mai ricalcolato nel client; senza `admission` non
si disegna. Il verdetto SHALL seguire l'ordine del tick: un riavvio in arrivo e
il PAVIMENTO (`dispatchResourceBlock`) vengono prima del budget, in ENTRAMBE le
modalità, e in «per numero» sono gli unici verdetti che la lettura porta (la
notte del 14/09/2026 il pavimento dei 6 GB era l'unico freno che teneva, e il
pannello diceva in verde «un agent nuovo partirebbe»). Il verdetto SHALL nominare
l'asse CON i due numeri che quell'asse ha confrontato: la CPU col costo di un
agent (o, quando l'agent starebbe sotto il tetto, la linea sotto cui l'USO deve
scendere perché riparta: l'80% dell'usabile meno il costo di un agent, perché il
cancello confronta uso più costo con quell'80%), la
memoria con «servono X GB, liberi per Topics Y GB» quando non ci sta nella quota
del libero e con «Topics tiene X GB su un tetto di Y GB» quando è l'impronta a
superare il tetto, il pavimento con la sua prima frase. Lo stesso vale per la
riga scritta sulla card: le due clausole della memoria hanno due frasi, perché
quella della quota stampata quando scatta l'impronta si contraddice da sola. I
numeri della riga viva SHALL essere quelli del cancello (misura più i turni
ammessi negli ultimi 90 secondi, detti come «N appena partiti»), non la sonda
nuda. Spiegazione, tetto a macchina ferma, portata per macchina e check
congelati stanno sotto «Come funziona», chiuso. L'anello della colonna si
riempie con `uso / usabile`, e un usabile misurato a zero è pieno e oltre, non
un tetto assente. Il popover dice la quota, agenti e core in una riga, la
memoria che il cancello ha confrontato, i check congelati quando ce ne sono e la
spesa. Il chip «Fermane N» risponde a una domanda sul NUMERO e in «per risorse»
NON SHALL comparire. Il motivo scritto sulla card in coda usa le stesse parole.

**Le impostazioni della board stanno in UN dropdown**, ancorato al ⚙ della
toolbar e coerente con gli altri dropdown dell'app (stessa primitiva `Menu`:
flip/clamp, Escape, esclusività fra popover). Resta valido KANBAN-12: una sola
porta alle impostazioni, e nessuna riga sotto la toolbar.

MISURA: `shared/machine-budget.test.ts` per il controllore puro (budget contro
libero, ammissione uno per tick con isteresi, ordine di congelamento, due
letture per decidere, e il rigioco delle otto card del 07/09);
`server/services/budget-governor.test.ts` per il congelamento vero;
`server/services/task-dispatcher-pressure.test.ts` per i due versi dentro il
dispatcher; `server/services/task-dispatcher-admission.test.ts` per le porte
(rigioco della notte del 14/09, rampa fra board e riprese, un giro di reconcile
alla volta, esenzione con check in volo, finestra di memoria sul pavimento e sul
budget); `server/services/mem-signal.test.ts` per la finestra e il verdetto di swap;
`server/lib/card-memory-peaks.test.ts` per il prezzo per card dal picco dei
check; `tests/unit/gate-slot-one-per-name.test.ts` per il cancello per nome;
`bun run probe:budget` come banco sintetico su processi veri (bruciatore, `ps
-o stat` che dice `T`); e2e sul dropdown e sull'anello.

#### Scenario: sopra il budget il secondo agente aspetta
- **GIVEN** la modalità «a budget» al 50% su 12 core (6 core-unità)
- **AND** un agente già in volo mentre Topics tiene 5,8 core-unità
- **WHEN** il dispatcher fa il suo giro
- **THEN** nessun dispatch nuovo parte
- **AND** le card in coda portano il motivo `resource_pressure` con i core usati su quelli a disposizione, la quota e il costo di un agente, e il tono dice che riparte da sola

#### Scenario: non si riparte dove ci si è fermati
- **GIVEN** la coda trattenuta dal budget
- **WHEN** l'uso scende sotto il budget ma resta sopra l'80% di esso
- **THEN** non parte ancora niente: si riprende solo sotto la linea di rientro

#### Scenario: a coda vuota il primo parte comunque
- **GIVEN** la stessa macchina carica e ZERO agenti vivi
- **WHEN** il dispatcher fa il suo giro
- **THEN** un agente parte, e il verdetto dichiara l'esenzione invece di sostenere che la macchina è libera
- **AND** con una corsa di check pre-review in volo non parte, perché la macchina ha già lavoro nostro

#### Scenario: la notte del 14/09 non riparte
- **GIVEN** la modalità «a budget» all'80%, 24 GB liberi, 20 card in Todo e un giro ogni 10 secondi
- **AND** agenti che per 160 s costano un decimo di core e poi 2 core e 2 GB
- **THEN** nei primi 5 minuti partono al massimo 5 agenti

#### Scenario: la rampa è del dispatcher, non della board
- **GIVEN** tre board con card in Todo, oppure un riavvio con sei turni tagliati
- **WHEN** il dispatcher fa il suo giro
- **THEN** parte UNA card, le altre aspettano col chip `queued` e partono una per giro
- **AND** un giro fermo sulla sonda del commit di consegna mentre un'altra board fa partire la sua non ne fa partire una seconda
- **AND** la riga del log del riavvio dice «1 da capo» e «5 in attesa di un posto»

#### Scenario: una lettura sola non riapre il pavimento
- **GIVEN** la modalità «per risorse», tre card in coda e dieci minuti di letture a 5,8 GB
- **WHEN** arriva una lettura a 14,5 GB e poi di nuovo 5,5 (oppure 5,5, 10,4, 5,5)
- **THEN** non parte niente, e la card legge la lettura più bassa degli ultimi 2 minuti

#### Scenario: al boot la finestra è vuota
- **GIVEN** un server appena partito, tre card in coda e letture a 12 GB ogni 10 s
- **THEN** non parte niente prima di 120 s, e la card dice da quanti secondi misura
- **AND** la prima card parte appena la finestra è piena

#### Scenario: un turno in volo non affama la coda
- **GIVEN** la modalità «per risorse», un turno in volo da 10 minuti senza check e il prezzo di una card a 4 GB
- **WHEN** la memoria scende a 5,5 GB e poi resta fra 10,2 e 11,7
- **THEN** una card parte fra 120 e 130 s dopo l'ultima lettura a 5,5
- **AND** con letture fra 9,5 e 11,7 non ne parte nessuna

#### Scenario: un'apertura della finestra ammette al massimo quanto regge il budget
- **GIVEN** la modalità «per risorse», nessun turno in volo, tre card e una finestra fra 10,4 e 11,7 dopo un morso
- **THEN** partono esattamente due card, la terza la trattiene l'asse del budget, e nessun nuovo episodio di memoria si scrive dopo la prima

#### Scenario: per numero il pavimento tiene il turno in volo
- **GIVEN** la modalità «per numero», un turno locale in volo da 5 minuti e 11 GB per 130 s
- **THEN** la seconda card aspetta, e la frase dice i 4,0 GB tenuti per l'agente al lavoro

#### Scenario: l'asse del budget legge la finestra
- **GIVEN** la modalità «per risorse», due turni in volo e letture che alternano 10,5 e 14 GB
- **THEN** la terza card non parte in 5 minuti

#### Scenario: quello che prendono gli altri stringe il budget
- **GIVEN** un budget dell'80% su 12 core e altri processi che ne tengono 10
- **THEN** l'usabile SHALL essere l'80% dei 2 core rimasti, 1,6 core-unità, non 9,6, e la riga sulla card SHALL dire perché

#### Scenario: sopra il budget si congela un check, e riparte da solo
- **GIVEN** due check runner vivi e l'uso sopra il budget per due letture
- **THEN** UNO solo viene congelato, il più recente, e la sua card lo dice
- **AND** quando l'uso torna sotto il 70% del budget per due letture il check viene scongelato, con l'orologio del suo timeout fermo per tutta la pausa

#### Scenario: la memoria sotto il pavimento non congela niente
- **GIVEN** la CPU a riposo (0,4 core-unità su ~3,5) e 2 GB di memoria libera, sotto il pavimento di 6 GB
- **THEN** in 1080 letture NON SHALL essere congelato nessun check
- **AND** due check congelati per la CPU SHALL scongelarsi appena la CPU scende, con la memoria ancora sotto il pavimento

#### Scenario: il verdetto del pannello è quello del cancello
- **GIVEN** la modalità «a budget», Topics a 3,4 core-unità su 3,8 a disposizione e un agente che ne costa 0,5
- **WHEN** si apre il pannello
- **THEN** la riga dice «i nuovi aspettano: CPU», perché è ciò che il cancello risponde (3,4 + 0,5 > 3,8), e non «partirebbe» come direbbe `uso < usabile`
- **AND** con la memoria a trattenere dice «i nuovi aspettano: memoria» con i GB che servono e quelli liberi per Topics, oppure con quanti ne tiene Topics contro il suo tetto

#### Scenario: il pavimento tiene la coda e il pannello lo dice
- **GIVEN** 5,5 GB disponibili sotto il pavimento nativo di 6 GB, con la CPU dentro il budget
- **WHEN** si apre il pannello, in «a budget» o in «per numero»
- **THEN** il verdetto è `floor` e dice la prima frase del pavimento, e l'anello della colonna è pieno con la parola «fermo: niente spazio»
- **AND** il chip «Fermane N» non compare in «a budget»

#### Scenario: un resume trattenuto non riscrive la card a ogni lettura
- **GIVEN** sette card In corso trattenute dal pavimento del runtime nativo, con letture di memoria che attraversano i 6,0 GB (5,7, 5,9, 6,0, 5,8, 6,1) e quindi frasi che passano da «sotto il pavimento» a «in risalita»
- **WHEN** ritentano ogni 6 secondi per due minuti
- **THEN** ogni card riceve al massimo due `task:updated` (l'attesa e il rinfresco dopo un minuto) e resta `queued` con il motivo `resource_floor`
- **AND** un cambio di tipo (pavimento, spesa delle 24 ore) o di risorsa (Memoria, Disco) arriva al ritentativo successivo, mentre il passaggio fra le frasi dello stesso episodio di memoria arriva col rinfresco

#### Scenario: la misura non presa non blocca niente
- **GIVEN** una macchina dove la sonda non risponde
- **THEN** il budget SHALL restare intero: «non lo so» non è «zero», e un governor che non misura non congela niente

#### Scenario: «per numero» non cambia comportamento
- **GIVEN** la modalità di default
- **THEN** il tetto resta quello di prima e nessun budget entra nella decisione

#### Scenario: una manopola fuori scala si stringe, non si rifiuta
- **GIVEN** un valore scritto fuori dai limiti (10%-95%), o illeggibile
- **THEN** vale il limite (o il default 60%), e la percentuale mostrata è quella applicata

## ADDED Requirements

### Requirement: KANBAN-84 - L'e2e di una consegna lo misura la CI della PR sul commit consegnato, mai un browser su questa macchina

Una board SHALL poter dichiarare fra i suoi check la riga `github-ci:e2e`
(`E2E_CI_CHECK`). Fino al 15/09/2026 il check e2e della board era
`bun run check:e2e-touched`, che lancia Playwright con Chromium nel worktree
dell'agente: quella notte gli agenti hanno scaricato `chromium-1217` nella cache di
questo Mac per farlo girare, contro la regola della postazione. La stessa misura, e
di più, gira già nella CI di ogni pull request.

**La suite unit.** Una board SHALL poter dichiarare anche la riga `github-ci:unit`
(`UNIT_CI_CHECK`, nome `unit-ci`) al posto di `test:unit`. Il 15/09/2026 una card
dentro `test:unit:shards` teneva sul Mac un albero da 2,4 a 11 GB, e la stessa suite
gira nel job `check` di ogni pull request. Il suo verdetto SHALL venire dalla stessa
run che legge la riga e2e, e SOLO dalla conclusione del passo `Unit + integration
tests` del job `check`: VERDE solo con quel passo `success` su quel commit; ROSSO con
`failure`, e il referto SHALL portare il comando del log del job `check`; NON
MISURATO con il passo saltato, annullato o assente, o con il job `check` finito prima
del passo. Il passo SHALL essere letto appena è concluso, anche con il resto del job
ancora in corso. Con entrambe le righe dichiarate la consegna SHALL fare UNA spinta,
aprire o riusare UNA PR e usare UN solo giro di sondaggi per le due righe; ogni riga
SHALL avere il suo esito, e una riga ancora in attesa alla scadenza SHALL essere «non
misurato» senza toccare l'esito dell'altra. Il testo di un rosso SHALL dire che sono
rossi i test unit della CI. L'envelope di kickoff di una board con la riga SHALL dire
che la suite unit intera si legge dalla CI della PR, che su questa macchina non si
lancia `test:unit` né `test:unit:shards`, e che `bun test <file>` mirato resta
ammesso; con la sola riga unit la riga e2e dell'envelope SHALL restare quella di una
board che non misura l'e2e.

**Il commit.** La misura SHALL riguardare ESATTAMENTE il commit su cui la board ha
misurato i comandi (quello dopo il riallineamento su main). Il server, e mai
l'agente, SHALL spingere quel commit sul ramo della card
(`<sha>:refs/heads/<ramo>`, non `HEAD`) e SHALL aprire una pull request in bozza
verso main, o riusare quella aperta per quel ramo. Titolo e corpo NON SHALL
contenere il testo della card: ramo, id corto e commit corto bastano. Una spinta
rifiutata perché il ramo remoto non avanza SHALL forzare solo se la testa remota
compare nel reflog del ramo locale, con quella testa come lease; altrimenti
qualcun altro ha scritto sul ramo, il ramo remoto NON SHALL essere toccato e
l'esito SHALL essere «non misurato».

Una consegna senza commit propri oltre main NON SHALL spingere niente né aprire PR,
e SHALL essere verde con la nota «nessun commit proprio oltre main»: la domanda del
check è l'e2e di ciò che la consegna cambia, e fermarla fermerebbe le consegne che
non cambiano file (10 su 129 misurate col check di prima, che rispondeva verde).

**Il verdetto.** SHALL venire dalla run più recente (`id` più alto) del workflow
`.github/workflows/ci.yml`, evento `pull_request`, con `head_sha` uguale al commit,
e SOLO dai job `prepare-e2e` ed `e2e (N)`:
- VERDE solo se esiste almeno un job e2e e sono tutti conclusi `success`;
- ROSSO se sono tutti conclusi e almeno uno è `failure`: il referto SHALL nominare
  ogni job rosso e il comando che ne stampa il log
  (`gh run view --job <id> --log-failed -R <repo>`), insieme al link della PR e
  della run;
- NON MISURATO in ogni altro caso, con il motivo in testa al referto e l'uscita 97
  di KANBAN-15: nessuna run per quel commit, run annullata o superata,
  `prepare-e2e` non verde, un job e2e annullato, saltato o scaduto senza nessun
  `failure`, nessun job e2e nella run, una PR in conflitto con main, `git` o `gh`
  assenti o non autenticati, cinque letture di fila fallite, nessun verdetto entro
  60 minuti dalla spinta.

Un verdetto SHALL valere solo per il commit che ha misurato. Una gamba di consegna
arrivata con la testa del worktree su un altro commit, mentre la corsa del commit
precedente è ancora viva, NON SHALL portarsi via il verdetto (né il nulla) di quella
corsa: SHALL rispondere 202 `review_checks_running`, e la gamba dopo SHALL misurare la
testa attuale. L'attesa della CI arriva a 60 minuti, e senza questa regola una card
entrava in review, e poi landava, su un commit che nessun check aveva visto.

Un lettore della CI che lancia un'eccezione diversa dallo spegnimento SHALL dare
«non misurato» con il messaggio dell'eccezione: prima diventava il nulla di una corsa
esplosa, che la consegna legge come «nessun check», e la card entrava in review senza
verdetto e2e. Una risposta di GitHub che esce 0 senza l'elenco atteso
(`workflow_runs`, `jobs`) SHALL contare come lettura fallita.

La spinta SHALL passare dalla guardia `pre-push` del repository anche quando parte da
un worktree, con l'elenco dei nomi tolti dalla storia letto dal checkout principale
(il file non è tracciato, e un worktree non ne ha una copia): fino al 15/09/2026 da un
worktree la guardia non trovava l'elenco, usciva 0 e la consegna pubblicava i commit
intermedi prima della review. Una spinta fermata dalla guardia SHALL essere «non
misurato», e il ramo remoto NON SHALL riceverla.

Il testo di un «non misurato» della CI NON SHALL consigliare di installare le
dipendenze del worktree, e il testo di un rosso SHALL dire che sono rossi gli e2e
della CI invece di un codice di uscita.

**L'attesa.** Mentre aspetta la CI la corsa SHALL restituire la sua corsia (KANBAN-15),
NON SHALL avere un processo figlio vivo fra un sondaggio e l'altro, e il turno della
card NON SHALL prenotare memoria nell'ammissione del dispatcher. SHALL restare una
corsa viva: la consegna risponde 202 `review_checks_running`, il giudice del silenzio
e lo spazzino dei tool la leggono come attesa nostra, e uno spegnimento del server la
interrompe senza verdetto (fra un sondaggio e l'altro se ne accorge entro un secondo). Il client di `update_task` SHALL aspettare
più a lungo della scadenza della CI sommata al giro locale più lento misurato (29,2
minuti fra il 08/09 e il 15/09/2026). Il primo sondaggio SHALL essere immediato, così
che dopo un riavvio la run dello stesso commit si legga senza rispingere e senza
aspettare.

**I testi.** Quando la board dichiara la riga, l'envelope di kickoff SHALL dire
all'agente che: i comandi locali sono quelli elencati; l'e2e gira sulla CI dopo la
spinta del server, sul commit esatto; il ramo diventa pubblico in quel momento; su
questa macchina non si lancia Playwright né un browser e non se ne installa uno;
`bun run check:e2e-touched --list` mostra le spec toccate; un rosso torna col nome del
job e il comando del log; un «non misurato» non è un rosso ma tiene la card fuori dalla
review. La riga NON SHALL comparire fra i comandi da eseguire, né nel kickoff né in
quello di fan-out. `docs/board-protocol.md` SHALL portare la stessa regola.

**Anche senza la riga.** Ogni envelope di kickoff, di qualunque board, SHALL dire
all'agente che su questa macchina non lancia `check:e2e-touched` (tranne `--list`),
`playwright test`, build del client fatte per gli e2e, né installa o avvia un browser,
in primo piano o in background; che l'e2e lo scrive o lo cambia nella spec; e che
`bun test <file>` mirato resta ammesso. Il 15/09/2026, in 15 ore, gli agenti avevano
lanciato da sé 21 `check:e2e-touched`, 71 `playwright test` e 27 build del client, 99
su 119 in background con `&`, e la board li rifaceva alla consegna.

Chi misura quella spec SHALL dirlo una riga sola, secondo la board. Con la riga
`github-ci:e2e`: la CI del ramo, letta dalla board alla consegna. Senza: l'envelope
NON SHALL affermare che la board legge una CI, e SHALL dire che questa board non misura
l'e2e, che nessuno spinge il ramo alla consegna, e di scrivere nel commento di consegna
il percorso della spec cambiata (la misura la CI del progetto quando il ramo si
pubblica, o il PC). Il fan-out dice lo stesso nel suo resoconto finale. Il 15/09/2026
le board di quattro altri progetti non dichiaravano la riga, e la regola di
prima diceva a tutti che la board leggeva la CI del ramo.

Il ramo video della regola dell'anteprima NON SHALL nominare Playwright,
`recordVideo` o Chromium in nessuna forma, nemmeno per un'altra macchina. Una tab del
task che nessuna finestra mostra gira in un browser headless avviato su questa
macchina, e `screencapture -R` filmerebbe lo schermo di chi lavora: la clip SHALL
essere `screencapture` di una superficie già a schermo, per una pane browser solo dopo
`browser_focus_tab`; altrimenti la prova del comportamento SHALL essere la sua spec
e2e, nominata nel commento di consegna, con uno screenshot o un diagramma come
anteprima.

#### Scenario: tutti i job e2e verdi sul commit consegnato
- **GIVEN** una board con `true` e `github-ci:e2e`, e una run `pull_request` del commit consegnato con `prepare-e2e` ed `e2e (1)`..`e2e (4)` conclusi `success`
- **WHEN** la card consegna
- **THEN** la card SHALL entrare in review con `checksState: pass`
- **AND** il referto della riga SHALL portare il link della PR e della run

#### Scenario: il passo unit verde sul commit consegnato
- **GIVEN** una board con `true` e `github-ci:unit`, e il passo `Unit + integration tests` del job `check` concluso `success` nella run `pull_request` del commit
- **THEN** la riga SHALL essere verde, anche con altri passi del job ancora in corso o rossi

#### Scenario: il job check finisce prima del passo unit
- **GIVEN** il job `check` concluso `failure` nella preparazione, con il passo unit `skipped` o assente
- **THEN** la riga unit SHALL essere «non misurato», MAI verde

#### Scenario: e2e e unit dalla stessa spinta
- **GIVEN** una board con `github-ci:unit`, `true` e `github-ci:e2e`, il passo unit concluso al secondo sondaggio e i job e2e al quarto
- **THEN** il commit SHALL essere spinto una volta, la PR aperta una volta, e le due righe SHALL arrivare nell'ordine dichiarato dopo i comandi locali
- **AND** un lettore che risponde senza la riga unit SHALL dare `unknown`, mai `pass`

#### Scenario: una run verde di un altro commit non vale
- **GIVEN** una run verde il cui `head_sha` è un altro commit, oppure una run `push` verde dello stesso commit, e nessuna run `pull_request` del commit consegnato
- **THEN** l'esito NON SHALL essere verde

#### Scenario: la run più recente è annullata
- **GIVEN** due run `pull_request` dello stesso commit, la più vecchia verde e la più recente annullata
- **THEN** l'esito SHALL essere «non misurato»

#### Scenario: un job e2e rosso
- **GIVEN** `e2e (2)` concluso `failure` e gli altri `success`
- **THEN** l'esito SHALL essere `fail`, la risposta alla consegna SHALL essere 409 `review_needs_green_checks`
- **AND** il testo SHALL contenere `e2e (2)` e il comando `gh run view --job <id> --log-failed`

#### Scenario: gli shard non sono partiti
- **GIVEN** `prepare-e2e` concluso `failure` e i job e2e `skipped`
- **THEN** l'esito SHALL essere «non misurato», e il motivo SHALL nominare `prepare-e2e`

#### Scenario: GitHub non risponde o `gh` non è autenticato
- **GIVEN** `gh` che esce con un errore di autenticazione quando cerca la PR
- **THEN** l'esito SHALL essere «non misurato» subito, senza sondare le run

#### Scenario: la CI non finisce
- **GIVEN** job e2e ancora in corso per 60 minuti dalla spinta
- **THEN** l'esito SHALL essere «non misurato» con il link della run, e MAI verde

#### Scenario: la PR è in conflitto con main
- **GIVEN** nessuna run del commit dopo 5 minuti e la PR `CONFLICTING`
- **THEN** l'esito SHALL essere «non misurato» con il conflitto come motivo, prima della scadenza

#### Scenario: un ramo remoto scritto da qualcun altro
- **GIVEN** una spinta rifiutata e una testa remota che il reflog del ramo locale non contiene
- **THEN** il server NON SHALL forzare, e l'esito SHALL essere «non misurato»
- **AND** con una testa remota che il reflog contiene, il server SHALL forzare con quella testa come lease

#### Scenario: la testa cambia durante l'attesa della CI
- **GIVEN** una consegna su `abc1234` con la CI in attesa, e la testa del worktree passata a `def5678`
- **WHEN** arriva una seconda gamba e poi la CI di `abc1234` risponde verde
- **THEN** la seconda gamba SHALL rispondere 202 e la card SHALL restare `in_progress`
- **AND** la gamba dopo SHALL chiedere la CI di `def5678`, e la card SHALL entrare in review con `checksCommit` `def5678`

#### Scenario: il lettore della CI lancia un'eccezione
- **GIVEN** un lettore che lancia `TypeError`, oppure `gh api` che esce 0 con `{"total_count":0}`
- **THEN** l'esito SHALL essere «non misurato» e la consegna SHALL rispondere 409, con la card `in_progress`

#### Scenario: la guardia dei nomi ferma la spinta da un worktree
- **GIVEN** un worktree con un commit intermedio che contiene un nome dell'elenco del checkout principale, tolto dal commit dopo
- **THEN** la spinta SHALL fallire, l'esito SHALL essere «non misurato», nessuna PR SHALL essere aperta e il ramo remoto NON SHALL esistere

#### Scenario: una consegna senza commit propri
- **GIVEN** un ramo senza commit oltre main
- **THEN** il server NON SHALL spingere né aprire una PR, e la riga SHALL essere verde con la nota

#### Scenario: un rosso locale non spinge niente
- **GIVEN** un comando locale rosso
- **THEN** la CI NON SHALL essere letta e il commit NON SHALL essere spinto

#### Scenario: l'attesa non costa memoria all'ammissione
- **GIVEN** due card in attesa della CI e una terza in coda, con una prenotazione di memoria che per le prime due la terrebbe ferma
- **THEN** la terza SHALL partire

#### Scenario: lo spegnimento durante l'attesa
- **GIVEN** una consegna in attesa della CI
- **WHEN** il server ferma i check
- **THEN** la risposta SHALL essere 202 `review_checks_running`, la card SHALL restare `in_progress` e nessun verdetto SHALL essere scritto

#### Scenario: l'envelope non manda a lanciare l'e2e qui
- **GIVEN** una board che dichiara `bun run typecheck` e `github-ci:e2e`
- **THEN** il kickoff SHALL elencare `bun run typecheck` fra i comandi, NON SHALL elencare `github-ci:e2e`, e SHALL dire che l'e2e gira sulla CI e che qui non si lancia un browser

#### Scenario: l'envelope vieta l'e2e locale anche a una board senza la riga
- **GIVEN** una board che dichiara solo `bun run typecheck`
- **THEN** il kickoff SHALL dire di non lanciare `check:e2e-touched`, `playwright test` e le build del client per gli e2e su questa macchina, e che `bun test <file>` resta ammesso
- **AND** il kickoff SHALL dire che questa board non misura l'e2e e di nominare la spec nel commento di consegna, e NON SHALL dire che la board legge la CI
- **AND** il ramo video della regola dell'anteprima NON SHALL contenere `playwright`, `recordVideo` o `chromium` in nessuna forma, e SHALL legare `screencapture` a una superficie già a schermo e a `browser_focus_tab`

### Requirement: KANBAN-85 — Con lo swap sostenuto Topics congela il comando più pesante lanciato da un agente in background, mai il CLI né il server, e la sessione si copre di brina

Con lo swap sostenuto (KANBAN-75) e DOPO il freno dei check (KANBAN-15), il
server SHALL congelare (SIGSTOP) l'albero di processi del comando più pesante che
un agente ha lanciato in BACKGROUND o che il runtime nativo sta eseguendo per lui,
finché non c'è memoria. Un SIGSTOP non restituisce memoria: quello che compra è
che l'albero fermo non tocca più pagine, e quell'effetto SHALL essere misurato per
ogni congelamento (sotto).

**CHI PUÒ ESSERE CONGELATO, per prova e mai per forma.** Un `Bash` di Claude Code
SHALL essere candidato solo se il payload `PreToolUse` del suo CLI lo ha
dichiarato `run_in_background`; un comando del runtime nativo solo se
`runCommand` lo ha registrato con la sessione che lo possiede. Un comando in
PRIMO PIANO NON SHALL mai essere congelato — il suo CLI lo uccide alla scadenza
del tool su un orologio che durante il fermo continua a correre, quindi
congelarlo è ucciderlo con passi in più — e un payload assente o non riconosciuto
SHALL valere come primo piano. Un figlio che nessun record spiega SHALL essere
registrato nel log e mai segnalato.

I comandi in primo piano SHALL essere tenuti come INSIEME, uno per chiamata, e
una voce SHALL sparire solo con il `PostToolUse` della SUA chiamata: né il
`PostToolUse` di un altro strumento né l'arrivo di un `Bash` di background
SHALL cancellarla. Il confronto fra un comando registrato e la riga di `ps`
SHALL avvenire in un solo alfabeto — la riga senza le virgolette che `eval
'<cmd>'` le impone, il record con gli escape che `ps` stampa al posto dei byte
che non può scrivere (`\012` per un a capo, `\011` per un tab, `M-` per i byte
non ASCII) — perché un comando che non combacia con la propria riga è un
comando scambiato per un altro.

Senza un'identità leggibile non si congela: se `ps` non risponde, in quel
battito NESSUN albero SHALL essere candidato e nessun segnale SHALL partire (il
conteggio dei congelamenti vive per identità, e un'identità non letta non si
ritrova più allo scongelamento). Allo stesso modo un albero i cui peer di rete
non sono stati misurati — `lsof` che non risponde, che non è «nessuno è
collegato» — SHALL essere saltato per il prossimo candidato.

**CHI NON SHALL MAI RICEVERE UN SEGNALE:** il server e ogni membro del suo gruppo
di processi (il comando nativo è un figlio del server e ne condivide il gruppo:
un segnale al gruppo fermerebbe Topics, e un server fermo è l'unico che potrebbe
scongelare); i sidecar e il ponte PTY; ogni CLI di agente e i suoi MCP, LSP e
aiutanti; un albero che contiene un altro CLI; un albero con un peer di rete
ESTABLISHED fuori da sé; le pane shell di una persona. Un gruppo SHALL essere
segnalato SOLO se nessuno dei suoi membri è nell'insieme di guardia; se un pid da
segnalare finisce nell'insieme di guardia, NESSUN segnale SHALL partire e il
congelatore SHALL spegnersi per la vita del processo.

**IL PIÙ PESANTE** SHALL essere misurato sul footprint dell'albero più i servizi
XPC attribuiti (una pagina WebKit non vive nell'albero: su un runner macOS,
16/09/2026, un albero da 0,057 GB ne aveva 0,383 di WebContent, GPU e Networking),
con un pavimento di 0,5 GB e almeno 0,1 core nell'ultimo intervallo. Un servizio
XPC SHALL essere attribuito solo se il suo eseguibile sta sotto la radice di
installazione dell'app che possiede il dominio launchd.

**SCONGELAMENTO.** La CALMA DA SOLA NON SHALL scongelare (la calma è ciò che il
congelamento produce). SHALL scongelare: la memoria tornata (minimo dei 2 minuti
sopra il pavimento più il residente dell'albero), il NESSUN EFFETTO (fra 120 e
180 s, letture di pagine rilette >= 0,8 volte quelle del congelamento: il thrash
non era suo, e non SHALL essere ricongelato nello stesso episodio), i 10 MINUTI,
il padrone sparito, lo spegnimento e il registro al boot. Dopo DUE congelamenti
lo stesso albero va fino in fondo, e il conteggio SHALL sopravvivere a un riavvio
del server.

**IL REGISTRO.** Ogni pid SHALL essere scritto su disco (tmp, fsync, rename) PRIMA
del suo SIGSTOP, con l'identità (`lstart`) che distingue un pid riciclato. Al boot
ogni albero ancora in registro SHALL essere continuato prima che il segnale di
memoria riparta, saltando le identità che non corrispondono; allo spegnimento
SHALL essere scongelato prima che i check vengano uccisi, perché un processo fermo
tiene il suo SIGTERM finché non è continuato.

Un `ps` MUTO NON È UN ELENCO DI PID RICICLATI. Se al boot le identità non si
possono leggere, ogni pid registrato SHALL comunque ricevere SIGCONT (un SIGCONT
a un processo che gira non fa niente) e il registro SHALL essere TENUTO: è
l'ultima copia di quei numeri, e svuotarlo lascerebbe un albero fermo senza
nessuno che li conosca. Il registro SHALL essere svuotato solo dopo un boot in
cui `ps` ha risposto.

**GLI OROLOGI DEL SILENZIO.** Il tempo di congelamento è un'attesa NOSTRA: il
rilevatore di stallo SHALL rientrare, lo spazzino degli stream SHALL scalarlo
dall'età del tool, il timer del bash nativo SHALL fermarsi e ripartire con il
tempo che restava, il parcheggio della PTY SHALL rifiutare, e lo stop di una
sessione SHALL scongelare prima di uccidere.

**COSA VEDONO AGENTE E PERSONA.** All'agente SHALL essere detto che il comando è
stato congelato e per quanto, nel suo stesso canale (la riga del tool nativo, il
file di output della shell in background), perché un timeout scaduto durante il
fermo è un effetto del congelamento e non un difetto del codice. Alla persona:
brina sulla card, sulla riga della sidebar e sulla tab, anello e riga in flusso
sulla pane, con il comando, i GB e la ragione; una voce nella cronologia delle
notifiche per il congelamento e per la ripresa; una nota di servizio nel thread
della card. La brina NON SHALL formare cristalli sopra il testo, SHALL essere
ferma (nessun ridisegno) quando si è posata, SHALL rispettare
`prefers-reduced-motion`, SHALL esistere nei due temi e NON SHALL incrociare i
selettori di occlusione del guscio nativo.

#### Scenario: si congela il più pesante in background, non l'inerte e non il primo piano
- **GIVEN** swap sostenuto, il freno dei check senza niente da interrompere, e quattro comandi: A in background 2,1 GB e 0,5 core, B in background 3,0 GB e 0 core, C in background 0,4 GB, D in primo piano 2,6 GB
- **THEN** SHALL essere congelato A, e B, C e D NON SHALL ricevere nessun segnale
- **AND** il log SHALL dire che D è in primo piano e non si congela

#### Scenario: un albero nativo non riceve mai un segnale di gruppo
- **GIVEN** un comando del runtime nativo, figlio del server e nel gruppo del server
- **THEN** i segnali SHALL andare pid per pid, e nessun pid del server SHALL essere fra loro

#### Scenario: un CLI dentro l'albero annulla il congelamento
- **GIVEN** un albero candidato che contiene un processo `claude`
- **THEN** l'albero NON SHALL essere congelato

#### Scenario: il freno dei check agisce per primo e le due leve si danno 120 s
- **GIVEN** swap sostenuto e un giro di check pesante da interrompere
- **THEN** SHALL essere interrotto il giro e NESSUN albero SHALL essere congelato in quel battito
- **AND** dopo un congelamento il freno dei check SHALL aspettare 120 s prima di interrompere

#### Scenario: la calma da sola non scongela
- **GIVEN** un albero congelato e lo swap non più sostenuto, con il minimo dei 2 minuti sotto il pavimento
- **THEN** l'albero SHALL restare fermo

#### Scenario: si scongela per memoria, per nessun effetto, a 10 minuti, col padrone sparito
- **GIVEN** un albero congelato
- **THEN** SHALL essere continuato quando il minimo dei 2 minuti supera il pavimento più il suo residente, oppure fra 120 e 180 s se le pagine rilette non sono scese, oppure a 10 minuti, oppure quando la sua sessione non c'è più

#### Scenario: due per albero, anche attraverso un riavvio
- **GIVEN** un albero già congelato due volte, con un riavvio del server fra i due
- **THEN** il terzo episodio NON SHALL congelarlo, e il log SHALL dirlo

#### Scenario: nessun albero resta fermo dopo un crash del server
- **GIVEN** un albero congelato e il server ucciso con SIGKILL
- **THEN** al boot ogni pid ancora vivo con la stessa identità SHALL ricevere SIGCONT e, se `ps` ha risposto, il registro SHALL restare vuoto
- **AND** se `ps` non ha risposto, ogni pid registrato SHALL ricevere SIGCONT senza controllo e il registro SHALL essere tenuto per il boot dopo

#### Scenario: senza identità o senza peer misurabili non parte nessun segnale
- **GIVEN** swap sostenuto, un candidato sopra il pavimento, e `ps` che non risponde sulle identità delle radici
- **THEN** nessun albero SHALL essere congelato in quel battito, e il log SHALL dire perché
- **AND** con `ps` che risponde ma `lsof` muto sul candidato più pesante, quel candidato SHALL essere saltato e il successivo SHALL essere valutato

#### Scenario: un comando in primo piano su più righe non si congela
- **GIVEN** un comando in primo piano che contiene un a capo e un record di background di un turno precedente che ne è sottostringa
- **THEN** il comando in primo piano NON SHALL ricevere nessun segnale, e il log SHALL dire che è in primo piano
- **AND** il `PostToolUse` di un altro strumento, o un `Bash` di background nella stessa risposta, NON SHALL renderlo un candidato

#### Scenario: il timer del bash nativo si ferma col congelamento
- **GIVEN** un comando nativo con timeout 120 s, congelato al secondo 60 per 200 s
- **THEN** NON SHALL essere ucciso durante il fermo, SHALL essere ucciso dopo i 60 s che gli restavano, e la sua uscita SHALL contenere la riga del fermo

#### Scenario: gli orologi del silenzio scontano il congelamento
- **GIVEN** un tool in corso da 35 minuti di cui 10 congelati
- **THEN** lo spazzino NON SHALL dichiararlo `hung`
- **AND** una sessione con un albero congelato NON SHALL essere giudicata in stallo né parcheggiata

#### Scenario: la brina si vede e non copre le parole
- **GIVEN** un albero congelato della sessione di una card
- **THEN** la card, la riga della sidebar e la tab SHALL mostrare la brina e il comando, la pane SHALL mostrare anello e riga in flusso sopra il composer
- **AND** nessun pixel del canvas sotto una casella di testo SHALL avere alpha oltre 2/255, nei due temi e nei due motori
- **AND** a brina posata i disegni sul canvas SHALL essere zero su una finestra di 3 s
- **AND** con `prefers-reduced-motion` la brina SHALL comparire già finita e sparire senza scioglimento
