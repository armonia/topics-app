## Purpose

Che cosa fa un riavvio PIANIFICATO quando qualcuno sta ancora lavorando: chi
aspetta, chi viene tagliato, e chi viene avvisato.

Questa spec copre il cancello di quiescenza — `/__daemon/restart-when-idle`, il
riavvio deciso dall'app su se stessa — non il SIGTERM dell'utente o del sistema,
che resta veloce di proposito.

## Background

DUE SORTI, E UNA SOLA DOMANDA CHE LE SEPARA: dove vive il turno. Un turno di un
provider a riga di comando gira in un processo FIGLIO che lo spegnimento non
tocca; al riavvio il broker lo ritrova e lo riadotta, e chi guardava vede una
pausa. Un turno del runtime NATIVO gira dentro il processo del server: quando il
processo muore, muore il turno.

Da questa differenza discende tutto il resto. Chi torna può essere tagliato dopo
un minuto — aspettarlo di più ucciderebbe il ricaricamento a caldo per chiunque
abbia una conversazione aperta. Chi non torna non si taglia affatto: l'invariante
del 28/08 è che **un orologio non uccide lavoro che non torna**, pagata con una
chat lasciata con «turno interrotto da un riavvio del server» dopo venticinque
minuti di attesa inutile.

IL TETTO NON DECIDEVA PIÙ NIENTE, E NON LO SAPEVA. Per il lavoro che non torna
il verdetto non è MAI «scaduto»: qualunque sia il tetto, l'esito è lo stesso. Il
tetto decideva quindi una cosa sola — QUANDO il rinvio veniva dichiarato — e per
venticinque minuti non lo dichiarava a nessuno: né allo script di produzione, che
senza il battito su file manda il proprio SIGTERM e taglia esattamente ciò che
questo cancello esiste per non tagliare, né alla persona, che è l'unica in grado
di sbloccare la situazione. Misure: 2026-09-04 00:12, un turno nativo su
`topic:a4d19786` trattiene il riavvio e la notifica è prevista dopo quindici
minuti; 2026-08-30, un riavvio rinviato per 4599 secondi con l'unica traccia in
un log che nessuno guarda, sbloccato in cinque secondi appena l'utente lo ha
saputo.

E UNO STREAM MORTO TRATTENEVA COME UNO VIVO. Il 2026-09-03 l'attesa è durata
2160 secondi su `topic:6b9605e5`, il cui turno era già finito con un `400 prompt
is too long`: la voce era rimasta nel registro degli stream in memoria, e il
cancello contava quella voce, non il turno.

## La decisione, e l'alternativa scartata

Le due strade erano:

**A) trattare un turno nativo come recuperabile** — visto che dopo lo spegnimento
la ripresa all'avvio rimanda il messaggio alla route della chat («la ripresa»,
`server/lib/ripresa-boot.ts`) — e quindi tagliarlo dopo un minuto come una chat
qualsiasi.

**B) lasciarlo non recuperabile, e spostare la notifica dove serve.**

**Si sceglie B.** La ripresa rimanda il MESSAGGIO, non riprende il TURNO: gli
strumenti già eseguiti vengono eseguiti di nuovo, dal primo. «Non perso» non è
«ripreso»: un comando che ha già scritto file, spostato un ramo o pubblicato
qualcosa lo rifà, e nessuno glielo ha chiesto. Con un tetto di un minuto, sui
numeri misurati fra il 18 e il 20/08 (94 blocchi di attività nativa continua),
**quattro turni nativi su cinque** venivano tagliati: la strada A non sarebbe
stata un taglio raro con un recupero, sarebbe stata la norma con una ripetizione
di effetti collaterali. Rendere la ripresa idempotente per `tool_use_id` è un
lavoro vero e utile, ma è un'altra card: finché non esiste, A è più cara di B.

Quello che resta di A è la sua osservazione giusta — l'attesa non è più muta come
sembrava — e infatti la si spende dove costa zero: nel dire subito che il riavvio
è rinviato.

IL TASTO «TAGLIA E RIAVVIA» NON SI AGGIUNGE. La notifica nomina il topic e il
click lo APRE, e nel topic il tasto per fermare il turno c'è già; il cancello
riparte da solo entro mezzo secondo. Un verbo nuovo nelle azioni delle notifiche
sarebbe una seconda semantica da tenere allineata a quella della chat, e la
regola di quel modulo è che un tasto della notifica è un tasto che esiste già
sulla superficie.

## Requirements

### Requirement: RGATE-01 — Ciò che non torna si RINVIA subito, non dopo un tetto

Quando a trattenere un riavvio pianificato c'è lavoro che un riavvio NON
recupererebbe — un turno di card della board, una chat su un runtime che non sa
riadottare, una chat ferma su una domanda — il cancello SHALL dichiarare il
rinvio dal PRIMO giro dell'attesa, e NON SHALL servire prima nessun tetto.

Dichiarare il rinvio significa due cose insieme: il battito che dice allo script
di produzione di non mandare il proprio SIGTERM, e la riga di log che dice CHE
COSA trattiene.

Il riavvio NON SHALL essere eseguito finché quel lavoro è in volo: non esiste un
secondo tetto oltre il rinvio, perché sarebbe lo stesso taglio con un numero più
grande sopra.

Una chat che il riavvio RIADOTTA resta fuori da questa regola: la sua attesa
corta (un minuto) e il suo taglio restano, o il ricaricamento a caldo non
scatterebbe mai mentre si sviluppa.

#### Scenario: un turno nativo trattiene il riavvio
- **GIVEN** una chat in streaming su un runtime che non sa riadottare
- **THEN** il verdetto SHALL essere «rinvia» al primo giro, non dopo il tetto lungo
- **AND** il turno NON SHALL essere tagliato, per quanto l'attesa duri

#### Scenario: una chat riadottabile
- **GIVEN** una chat in streaming su un runtime che al riavvio viene riadottato
- **THEN** SHALL essere attesa un minuto e poi il riavvio SHALL procedere

### Requirement: RGATE-02 — Si avvisa quando la decisione è presa, non quando scade un tetto

Oltre una soglia di attesa il cancello SHALL mandare UNA notifica che nomina chi
trattiene, e SHALL puntarla al topic che trattiene, così che il click porti dove
la decisione si prende.

La soglia SHALL dipendere da CHI trattiene:

- una CHAT (turno nativo in corso, turno adottato dal broker, domanda aperta):
  **60 secondi**, la stessa soglia con cui il cancello decide la sorte di una
  chat riadottabile. È l'istante in cui la sorte è già decisa: da lì in poi
  l'attesa non ha più una fine propria, e a finirla può essere solo una persona.
- una CARD della board: il tetto lungo, invariato. Un turno di card ha già un
  limite suo (`dispatchTimeoutMin`, venti minuti) oltre il quale è il dispatcher
  a chiuderlo, quindi quell'attesa finisce da sola e svegliare qualcuno al primo
  minuto sarebbe rumore.

La notifica SHALL essere UNA per attesa: una decisione ripetuta ogni minuto è
rumore, non informazione. E SHALL chiedere il gesto GIUSTO — fermare un turno,
rispondere a una domanda — perché fermare una chat in attesa di risposta
distrugge proprio il turno che il cancello stava proteggendo.

#### Scenario: un turno nativo trattiene da un minuto
- **GIVEN** un riavvio rinviato da una chat non riadottabile
- **WHEN** l'attesa raggiunge i 60 secondi
- **THEN** SHALL partire una notifica che nomina quella chat, una sola volta

#### Scenario: una card trattiene da un minuto
- **GIVEN** un riavvio rinviato da un turno di card della board
- **WHEN** l'attesa raggiunge i 60 secondi
- **THEN** NON SHALL partire nessuna notifica: quella soglia è il tetto lungo

### Requirement: RGATE-03 — Uno stream il cui turno è FINITO non trattiene niente

Il cancello SHALL contare uno stream solo se il suo turno è ancora aperto. Uno
stream la cui riga di risposta è già stata finalizzata — finita bene, finita con
un errore del fornitore, chiusa da un cane da guardia — NON SHALL trattenere il
riavvio, nemmeno se la sua voce è rimasta nel registro in memoria.

La domanda si fa alla riga sul disco, non al registro: il registro è ciò che si
è dimostrato capace di mentire, la riga finalizzata no. E il dubbio protegge il
turno: se la riga non si riesce a leggere, lo stream CONTA ancora.

#### Scenario: un turno morto di «prompt is too long»
- **GIVEN** uno stream la cui riga è già finalizzata con un errore del fornitore
- **THEN** il cancello NON SHALL contarlo fra le chat in streaming
- **AND** se non trattiene altro, il riavvio SHALL procedere

### Requirement: RGATE-04 — La porta del dispatch si chiude solo quando l'attesa è delimitata

Un riavvio pianificato chiude la porta del dispatcher (`drain`) perché, con una
coda dietro un tetto pieno, un turno nuovo parte appena uno finisce e l'attesa
non arriva mai (04/09/2026, 18.482 s). Quella chiusura ha senso finché ad
attendere sono CARD: un turno di card ha un limite suo (`dispatchTimeoutMin`),
quindi porta chiusa vuol dire «il riavvio è a minuti».

Non ha senso finché ad attendere è una CHAT. Un turno nativo non si taglia e
non ha un limite nostro: il 05/09/2026 un turno a 211 giri di tool su 300 ha
trattenuto `restart-when-idle` per più di un'ora, e dietro la porta chiusa sei
agenti di card sono rimasti «in attesa di uno slot» per tutto il tempo, con
altre sette card in todo. La porta chiusa non comprava niente al riavvio, che
non aspettava card: congelava la board per la durata della chat di una persona.

La porta SHALL seguire chi trattiene: APERTA finché trattiene almeno una chat
(le card scorrono: ognuna è delimitata, e il riavvio comunque non arrivava),
CHIUSA appena a trattenere restano solo card, o niente. Prima di procedere col
riavvio la porta SHALL essere chiusa e le fonti rilette una volta ancora, così
nessuna card parte nel varco fra «niente trattiene» e lo spegnimento. Il
dispatcher SHALL dire nel log quando la porta si riapre e perché.

Lo stream di un turno di CARD non è una chat e NON SHALL contare fra chi tiene
aperta la porta. Misura del 14/09/2026: un turno di card passa da `/api/chat` come una chat, quindi
la sua sessione compare fra gli stream vivi. Contata come chat, ogni card in volo
riapriva la porta da sola: «drain: 3 in volo» seguito subito da «drain tolto»,
con i soli tre topic delle card in streaming, e altre card partite dietro un
riavvio in attesa (4, 8, poi 15 turni a 208, 268 e 328 s) che quel riavvio ha
poi tagliato.

#### Scenario: trattiene una chat nativa
- **GIVEN** un riavvio in attesa, nessuna card in volo, una chat del runtime nativo in streaming
- **THEN** la porta SHALL essere aperta e le card in coda SHALL partire

#### Scenario: la chat finisce, restano card
- **GIVEN** la stessa attesa dopo la fine della chat, con due card in volo
- **THEN** la porta SHALL richiudersi, e il riavvio SHALL seguire la fine di quelle due card

#### Scenario: trattengono solo card, e ognuna sta streammando
- **GIVEN** un riavvio in attesa, tre card in volo, e nel registro degli stream esattamente le sessioni di quelle tre card
- **THEN** la porta SHALL restare chiusa: lo stream di un turno di card è la card stessa, non una chat
- **AND** una chat di una persona accanto a quelle card, da qualunque fonte, SHALL riaprirla

### Requirement: RGATE-05 — Lo script di produzione non taglia ciò che il server protegge

Il rinvio del server vale solo se chi manda il SIGTERM lo legge. Lo script che
chiede il riavvio (`scripts/server-watch.sh`) SHALL rispettare il battito di
rinvio su OGNI strada per cui la sua richiesta ha ricevuto 202, qualunque sia il
tentativo che l'ha ottenuto, anche in un sorvegliante appena ripartito. Il
14/09/2026 il terzo ramo aspettava 1560 s fissi senza guardarlo, e ha tagliato
dodici card mentre il server scriveva «RINVIATO da 1557s».

Il battito SHALL restare valido per una finestra misurata sugli STALLI del
server, non sulla sua cadenza: sotto swap il ciclo che lo scrive si è fermato
fino a 87 s, e un battito invecchiato da uno stallo non SHALL essere letto come
fine del rinvio. Un server morto lo scopre già il controllo sul processo.

Un server che non risponde a `restart-when-idle` SHALL essere RICHIESTO di nuovo
a intervalli, con un tempo di risposta adatto a un ciclo in stallo, per tutta la
finestra che il server stesso si concederebbe (il suo tetto più il margine di
spegnimento). Solo dopo quella finestra SHALL partire il SIGTERM, e il SIGKILL
SHALL aspettare almeno cinque minuti che `gracefulShutdown` finisca. Il 14/09 un
server fermo 87 s per swap ha preso il SIGTERM dopo circa 140 s di richieste da
3-5 s, con tre card tagliate, e il SIGKILL 54 s dentro uno spegnimento che stava
ancora girando.

#### Scenario: il 202 arriva a un tentativo successivo e il server rinvia
- **GIVEN** le prime richieste scadute, un 202 ottenuto più tardi, e un battito di rinvio invecchiato da uno stallo lungo
- **THEN** oltre la finestra dello script il server NON SHALL ricevere nessun SIGTERM

#### Scenario: un server lento che per molte richieste non risponde
- **GIVEN** un server vivo che non risponde per più richieste di quante ne facesse la vecchia ultima spiaggia
- **THEN** SHALL essere richiesto di nuovo, non tagliato
- **AND** la richiesta che arriva SHALL portare all'attesa paziente

#### Scenario: un server che non risponde mai
- **GIVEN** un server vivo che non risponde per tutta la finestra
- **THEN** SHALL ricevere un SIGTERM, e il SIGKILL solo dopo almeno cinque minuti

### Requirement: RGATE-06 — Lo script chiede un riavvio solo per codice che il server non ha caricato

Un riavvio chiesto per niente trattiene la board quanto uno vero. Lo script SHALL
chiedere un riavvio solo quando esiste un sorgente del server NON più vecchio
dell'istante in cui il processo corrente è nato (il pidfile, scritto subito dopo
lo spawn): tutto ciò che è più vecchio il server l'ha caricato. Il 15/09/2026
alle 01:51 un server nato otto secondi prima di scrivere il proprio stato ha
ricevuto un riavvio per due merge più vecchi della sua nascita, e quel riavvio
teneva le card che il boot aveva appena ripreso.

I sorgenti del server SHALL comprendere, oltre a `server/` e `server.ts`, i file
di `shared/` che il grafo dei moduli del server importa, e solo quelli: una
correzione atterrata soltanto in `shared/machine-budget.ts` non arrivava al
server, mentre un file di `shared/` che usa solo il client non SHALL chiedere
riavvii che tagliano turni.

#### Scenario: il server è nato dopo l'ultima modifica
- **GIVEN** un contenuto cambiato, ma ogni sorgente più vecchio del pidfile del server vivo
- **THEN** NON SHALL partire nessuna richiesta di riavvio
- **AND** una modifica più nuova del pidfile SHALL invece chiederlo

#### Scenario: una modifica in shared/
- **GIVEN** un file di `shared/` che il server importa e uno che non importa
- **THEN** cambiare il primo SHALL chiedere il riavvio, cambiare il secondo NON SHALL

### Requirement: RGATE-07 — Il SIGTERM arriva sempre a `gracefulShutdown`

Tutto il cancello poggia su un'ipotesi: il SIGTERM che chiude il server fa girare
`gracefulShutdown`. Nessuna libreria dentro il server SHALL poter togliere quel
gestore. Dal 16/09 al 24/09/2026 11 uscite su 92 sono state code 143, morte per
l'azione di default del segnale: nessuna riga «[Shutdown]», lock stantio al boot
dopo, e il 24/09 alle 16:48 sei tool orfani e un turno interrotto senza
spiegazione. Tutte e 11 avevano un Chromium lanciato in quella vita: il `launch()`
di Playwright installa di suo gestori SIGTERM, SIGINT e SIGHUP e li toglie quando
il browser esce, e in Bun togliere un listener di un segnale smonta il gestore
nativo di quel segnale anche se quello del server è ancora registrato.

Il browser del server SHALL essere lanciato senza i gestori di segnale di
Playwright: lo chiude già `gracefulShutdown`, e uno lasciato da un crash lo
raccoglie la spazzata al boot.

#### Scenario: il browser è stato lanciato e poi chiuso
- **GIVEN** un processo col gestore SIGTERM del server che lancia il browser del server e lo vede uscire
- **WHEN** riceve SIGTERM
- **THEN** il gestore del server SHALL girare e il processo uscire 0, non 143

### Requirement: RGATE-08 — Si può chiedere «c'è un turno in volo?» senza impegnarsi a riavviare

`POST /__daemon/restart-when-idle` risponde a quella domanda, ma apre un'attesa
e poi manda il SIGTERM: chi voleva solo SAPERE (l'hub che decide se riavviare il
Mac, un operatore) non aveva un cammino che non cambiasse lo stato. Il server
SHALL esporre `GET /__daemon/idle`, di SOLA LETTURA, dietro lo stesso loopback e
lo stesso bearer degli altri `/__daemon/*`.

La risposta SHALL dire `idle` (niente LAVORA: vedi RGATE-12), `inFlight`
(`taskDispatcher.busyCount()`), `holding` (la frase di `whatIsStillWorking`,
`null` se niente trattiene, comprese le chat ferme su una persona),
`unrecoverable` (card in volo più chat non riadottabili: la somma che il
cancello passa a `quiescenceVerdict`), `waitingOnPerson` (quante chat aspettano
una persona) e `alreadyWaiting` (se un'attesa di riavvio è già in corso). SHALL
leggere gli stessi predicati del cancello e NON SHALL avviare un'attesa, toccare
la porta del dispatcher (`drain`/`undrain`) né mandare segnali.

#### Scenario: server a riposo
- **GIVEN** un server senza turni in volo e senza attese di riavvio
- **WHEN** arriva `GET /__daemon/idle` con il token del daemon
- **THEN** la risposta SHALL essere 200 con `idle: true`, `holding: null`, `waitingOnPerson: 0`, `alreadyWaiting: false`
- **AND** il server SHALL essere ancora in vita dopo la risposta, senza attesa avviata

#### Scenario: senza token
- **WHEN** arriva `GET /__daemon/idle` senza il bearer del daemon
- **THEN** la risposta SHALL essere 401

### Requirement: RGATE-09 — Un land riavvia a zero turni, un salvataggio no

L'attesa corta di una chat riadottabile (RGATE-01) esiste per il ricaricamento a
caldo mentre qualcuno salva sotto `server/`. Un LAND non è quel caso: nessuno lo
aspetta al secondo. Il 26/10/2026 alle 20:41 l'approve della card 405071b3 ha
portato il checkout di produzione a origin/main più il merge commit, il
sorvegliante ha chiesto `restart-when-idle` e il server 49004 era su alle 20:42:
le chat in volo tagliate dopo il loro minuto. L'hub riavvia già su un cambio di
fseventsd solo a zero turni; il land SHALL fare lo stesso.

Lo script SHALL riconoscere un land da un salvataggio dal commit: un land sposta
`HEAD` del checkout, un salvataggio no. Su un land SHALL chiedere
`POST /__daemon/restart-when-idle?zeroTurns=1`; su un salvataggio la richiesta
resta quella di sempre.

Chiesto a zero turni, il cancello SHALL contare fra chi non torna anche ogni
chat con un turno IN CORSO (stream o broker), riadottabile o no: il riavvio si
rinvia e non la taglia, per quanto duri. Una chat ferma su una DOMANDA resta
fuori: non è un turno in volo e la domanda sopravvive al riavvio. La richiesta
a zero turni SHALL valere anche se si unisce a un'attesa già in corso.

#### Scenario: il land sposta HEAD
- **GIVEN** un cambio dei sorgenti del server arrivato con un commit nuovo nel checkout
- **THEN** lo script SHALL chiedere `restart-when-idle?zeroTurns=1`
- **AND** una chat riadottabile in volo SHALL rinviare il riavvio, non essere tagliata

#### Scenario: un salvataggio senza commit
- **GIVEN** un cambio dei sorgenti del server con `HEAD` fermo
- **THEN** lo script SHALL chiedere `restart-when-idle` senza `zeroTurns`, con il minuto delle chat di sempre

### Requirement: RGATE-10 — Una consegna che sta solo ASPETTANDO non trattiene il riavvio

Un turno di card in volo il cui unico lavoro è ASPETTARE i nostri check
pre-review — l'attesa di memoria, la spaziatura fra i rilasci, lo swap
sostenuto, la coda del cancello dei check, il sondaggio fuori corsia della CI
della pull request — NON SHALL trattenere un riavvio pianificato. Non trattiene
neanche il suo stream: un turno di card passa da `/api/chat`, quindi la sua
sessione è anche una chiave degli stream vivi, e lasciata lì tratterrebbe il
riavvio una seconda volta come chat non riadottabile.

«Solo aspettando» si legge da due registri, mai dalla riga della card: il
cancello dei check dice che una corsa è VIVA, il registro del governatore dice
se un comando di quella corsa è stato davvero lanciato. Corsa viva e nessun
comando lanciato = sta aspettando. Una corsa con un comando IN CORSO trattiene
il riavvio come oggi: quei minuti sono una misura, e tagliarli la butta via. Il
dubbio — un registro che non risponde — SHALL trattenere, come ogni altro dubbio
di questo cancello.

Perché è lecito tagliarla: la consegna è RICORDATA e riemessa dal processo dopo
(vedi sotto). Perché è necessario: il 15/09/2026 le due attese si tenevano a
vicenda. La card cdc9f39b aveva consegnato, il suo `update_task` era fermo sui
nostri check, e i check erano fermi nell'attesa di memoria su un Mac in swap —
niente di nostro stava girando. Il cancello ha contato «1 turno/i di card della
board non tornerebbe se lo tagliassi» e ha rinviato il riavvio per 31 minuti
(«riavvio RINVIATO da 1924s»), mentre il drain teneva in coda sette altre card
su «Riavvio del server in arrivo». Il riavvio aspettava i check, i check
aspettavano memoria che un Mac in swap non restituiva, e al fallimento aperto
dell'attesa (30 minuti) sarebbero partiti comandi pesanti su quello stesso Mac.
A finirla è stato un SIGTERM a mano.

#### Scenario: una consegna ferma nell'attesa di memoria
- **GIVEN** un riavvio pianificato, una card in volo la cui corsa di check è viva senza nessun comando lanciato, e altre card in coda
- **THEN** il cancello NON SHALL contarla fra ciò che trattiene, né come card né come chat
- **AND** il riavvio SHALL procedere senza aspettare

#### Scenario: un comando dei check sta girando
- **GIVEN** la stessa card con un comando dei check effettivamente lanciato
- **THEN** il riavvio SHALL essere rinviato come oggi
- **AND** oltre il tetto lungo SHALL partire la notifica di riavvio trattenuto: un'attesa senza fine può essere accettabile, muta no

#### Scenario: una consegna ferma sul sondaggio della CI
- **GIVEN** una corsa che ha restituito la corsia e aspetta solo la CI della pull request
- **THEN** il riavvio NON SHALL essere trattenuto da quella card

### Requirement: RGATE-11 — La consegna tagliata da un riavvio torna da sola, ed è la STESSA consegna

Il server SHALL ricordare, fuori dalla memoria del processo, la consegna a cui
ha risposto «i check stanno ancora girando», con il corpo della richiesta come
l'agente l'ha mandata e il commit che la corsa stava misurando. Al boot SHALL
riemettere quella richiesta a se stesso per ogni card ancora in lavorazione.

«Ancora in lavorazione» SHALL voler dire `in_progress`, e nient'altro. Review e
done sono oltre la consegna; backlog e todo sono una card che qualcuno si è
ripreso — il bottone «Ferma» la parcheggia in backlog, il reconcile del boot
rimette in coda l'orfano del processo ucciso. Per quelle la riga SHALL essere
solo DIMENTICATA, senza lanciare niente: riemetterla faceva girare la barra
intera (tsc, eslint, `bun test`, vite) subito dopo un riavvio avvenuto perché la
memoria era sotto il pavimento, scriveva `checks_state = 'pass'` e il commento
di servizio su una card ferma, e si fermava solo alla transizione finale con un
409 — la suite era già girata e il badge verde era già lì. Lo stato SHALL essere
riletto anche al momento della riemissione, non solo quando la riga viene
caricata: il giro di ripresa gira mentre il router si costruisce, il reconcile
del dispatcher rimette in coda più tardi e in asincrono.

La consegna riemessa SHALL essere la STESSA: nessun riallineamento in più su
main (il worktree è già sull'albero che il primo riallineamento ha prodotto, e
un secondo `git merge main` scriverebbe un merge che nessuno ha chiesto),
nessun verdetto rosso, nessun tentativo consumato. Il commit ricordato SHALL
essere quello che QUESTO giro stava misurando — il checkout letto dopo il
riallineamento — e non l'ultima misura scritta sulla card: una consegna tagliata
prima di arrivare al checkout non ha riallineato niente, e prendendo in prestito
il commit vecchio (che su una riconsegna senza commit nuovo è proprio l'HEAD del
worktree) il boot la leggeva come «stessa consegna» e saltava l'unico
riallineamento che le serviva, misurando una base che main si era lasciata
indietro.

Senza questo, il taglio di RGATE-10 non sarebbe gratuito: il turno dell'agente
muore col processo e con lui il suo `update_task`, quindi nessuno tornerebbe a
chiedere e la card resterebbe `in_progress` con la spia dei check spenta al boot.

#### Scenario: il riavvio taglia una consegna in attesa
- **GIVEN** una consegna la cui corsa di check è stata interrotta dallo spegnimento
- **WHEN** il processo dopo riparte
- **THEN** la consegna SHALL essere riemessa dal server sullo stesso commit
- **AND** i check SHALL girare una volta sola in più, senza un secondo riallineamento
- **AND** la card SHALL entrare in review se sono verdi, senza righe rosse nel thread

#### Scenario: la card è stata fermata o rimessa in coda mentre il server era giù
- **GIVEN** una consegna ricordata la cui card è uscita da `in_progress` (parcheggiata in backlog dal bottone «Ferma», o rimessa in `todo` dal reconcile del boot)
- **WHEN** il processo dopo riparte
- **THEN** la riga SHALL essere cancellata senza riemettere niente
- **AND** nessun comando dei check SHALL partire, e `checks_state` SHALL restare quello che era

#### Scenario: il riavvio taglia la consegna prima del riallineamento
- **GIVEN** una consegna a cui il cancello ha risposto «ancora in corso» senza aver mai risolto un checkout, su una card che porta il commit di una misura precedente
- **WHEN** il processo dopo riparte
- **THEN** la consegna riemessa SHALL riallinearsi su main prima di misurare

### Requirement: RGATE-12 — Un turno che aspetta una PERSONA non LAVORA

Una chat bloccata su una domanda (`ask_user_question`) a schermo è viva: il suo
processo interroga il bridge ogni 25 secondi, la sua riga è `partial = 1`, e per
la domanda non c'è nessun orologio che la chiuda. Ma non sta lavorando: aspetta.
Il cancello SHALL contarla fra le chat ferme su una domanda e NON SHALL contarla
anche fra gli stream o i turni aperti del broker.

Contata due volte, vinceva la voce sbagliata: il 24/11/2026 una domanda lasciata
senza risposta alle 02:06 teneva `GET /__daemon/idle` a `idle: false` alle
11:58, con «3 chat in streaming», e uno script che decide il sonno del Mac
doveva ignorare a mano ogni chat senza messaggi da un'ora. Non c'era niente da
ripulire: il turno era davvero aperto, la domanda davvero senza risposta. Era
sbagliata l'ETICHETTA, e con lei ogni conto che ne discende — la frase che
nomina cosa trattiene, `unadoptable`, `workingChats` e `lostWorkingChats`.
Quest'ultimo è il guasto che RGATE-09 vieta già a parole («una chat ferma su
una DOMANDA resta fuori»): un riavvio a zero turni si sarebbe fermato dietro una
domanda per tutto il tempo in cui nessuno rispondeva.

Chi aspetta una persona SHALL essere riconosciuto dal registro del bridge, che
dice «aspetta» nell'istante in cui è vero e smette nell'istante in cui qualcuno
risponde, e non da una sonda in cache. Ma il registro è memoria e può
mentire: una voce che il bridge non interroga più da oltre due minuti e mezzo
(`ASK_POLL_LIVE_MS`: la gamba più lunga più la finestra di ritentativo) è un
residuo, e un residuo NON SHALL mai nascondere un turno che lavora. Un
predicato che non si riesce a leggere lascia il turno fra quelli che LAVORANO:
il dubbio protegge il turno.

Vale per le DOMANDE e non per i permessi. La decisione di un permesso muore col
turno (`endStream` lo chiude come interrotto), quindi tagliare quel turno la
perde: resta fra chi lavora, e trattiene come prima.

`GET /__daemon/idle` SHALL rispondere `idle: true` quando l'unica cosa che
trattiene sono chat ferme su una persona, e SHALL contarle in `waitingOnPerson`.
Una chat che le righe dicono ferma ma che il registro non ha ancora confermato
(subito dopo un boot, prima della gamba successiva del suo figlio) SHALL contare
come lavoro e non anche come ferma.

Il riavvio tratta una chat ferma su una domanda come ogni chat: se il suo
processo torna dopo il riavvio non aspetta, altrimenti ha il minuto delle chat
(`chatGraceMs`) e poi parte, perché la domanda sopravvive sulla sua riga. Uno
stream fermo su una domanda SHALL contare nel calcolo del minuto, o un turno
nativo che gira in questo processo verrebbe tagliato al primo giro senza il
tempo di scrivere la risposta. Una riga rimasta `partial = 1` senza una domanda
aperta e senza un processo che la regga NON SHALL essere contata da nessuna
fonte: da sola non è un turno.

Una gamba che ritira una risposta dal buffer SHALL chiudere la domanda che
aveva riaperto (ogni gamba apre la domanda): una risposta data fra due gambe
lasciava la domanda «aperta» per sempre, e un turno che ha ripreso a lavorare
sarebbe sembrato fermo su una persona.

#### Scenario: la domanda lasciata aperta tutta la notte
- **GIVEN** una chat il cui turno è bloccato su una domanda senza risposta da ore, il cui bridge continua a interrogare
- **WHEN** arriva `GET /__daemon/idle`
- **THEN** la risposta SHALL avere `idle: true` e `waitingOnPerson: 1`
- **AND** `holding` SHALL nominare «chat ferma su una domanda», non «chat in streaming»

#### Scenario: accanto a una chat che lavora
- **GIVEN** una chat ferma su una domanda e un'altra che sta streammando
- **THEN** `idle` SHALL essere `false` e `holding` SHALL nominare solo quella che lavora
- **AND** la chat ferma SHALL essere contata in `waitingOnPerson`

#### Scenario: la risposta arriva
- **GIVEN** una chat ferma su una domanda
- **WHEN** la persona risponde e il turno riprende
- **THEN** la chat SHALL tornare fra quelle che lavorano al giro successivo, senza etichetta rimasta

#### Scenario: un residuo del registro
- **GIVEN** una voce di domanda aperta che il bridge non interroga da più di `ASK_POLL_LIVE_MS`
- **THEN** il turno su quella sessione SHALL essere contato come lavoro, non come fermo su una persona

#### Scenario: un permesso a schermo
- **GIVEN** un turno bloccato su un permesso
- **THEN** il turno SHALL restare fra quelli che lavorano e trattenere come prima

### Requirement: RGATE-13 — Chi altro legge «LAVORA»: la card ferma su una persona, l'auto-land, il vacuum

RGATE-12 dice che un turno fermo su una persona non lavora, e lo dice per ogni
lettore del cancello, non solo per `GET /__daemon/idle`. Tre lettori leggevano
ancora il conteggio vecchio, quello che nomina anche le domande aperte.

**La card.** Un turno di card fermo su una domanda il cui bridge interroga ancora
(`askStillPolled`, lo stesso registro di RGATE-12) NON SHALL contare come lavoro:
`working` è falso e `workingBusy` non lo nomina, quindi `idle` risponde `true`. SHALL
però restare in `cards`, e il riavvio lo rinvia come oggi. Non è la regola delle
chat, e la differenza è la RIPRESA: una chat tagliata su una domanda non viene
ripresa (`resumeVerdict`: aspettare una persona non è un'interruzione da
riparare), mentre il dispatcher riprende subito una card tagliata a metà turno
con il sollecito del turno interrotto, che non guarda se la sua domanda è ancora
aperta. Il modello la ripone in un secondo pannello o va avanti senza la
risposta, che arriva dopo come messaggio. Per questo il rinvio della card resta
finché la ripresa non rispetterà una domanda aperta: è lavoro a parte, e quel
giorno la card potrà uscire da `cards` come la chat.

Una card il cui turno TORNA dopo il riavvio (claude-code sotto il broker, un
turno nativo staccato) non è in `cards`, e si parcheggia come ogni chat. È il caso
di fatto: su 459 card degli ultimi 30 giorni 28 hanno interpellato una persona,
21 su claude-code e 7 sul nativo, nessuna su Codex né su ACP. Resta a cards solo
una card il cui turno vive nel processo del server. Una card senza sessione, una
domanda che nessuno interroga più e un permesso restano lavoro: il dubbio
protegge il turno.

**L'auto-land.** `autoLandTurnCount` SHALL non contare le chat ferme su una
persona, né come stream né come turni del broker: la domanda sopravvive sulla
riga, e il land di un diff del server aspettava per tutto il tempo in cui nessuno
rispondeva, fino alle sue tre ore, e poi rinunciava. SHALL contare ogni stream che
lavora e ogni card in `cards`, ferma o no: il cancello la rinvierebbe.

**Il vacuum.** Il giro del vacuum incrementale SHALL leggere `workingBusy` e non
`busy`: `busy` è la frase del riavvio e nomina le domande, quindi una domanda
lasciata aperta di notte saltava ogni giro. Il vacuum libera pagine su disco e
tiene il lock di scrittura per pochi millisecondi: gli serve sapere se qualcosa
CALCOLA, non se un riavvio sarebbe trattenuto.

#### Scenario: una card che non torna, ferma su una domanda
- **GIVEN** un turno di card nel processo del server bloccato su una domanda senza risposta, il cui bridge interroga
- **WHEN** arriva `GET /__daemon/idle`
- **THEN** la risposta SHALL avere `idle: true`
- **AND** il cancello SHALL contarla in `cards` e rinviare il riavvio, come oggi

#### Scenario: un land e una card ferma
- **GIVEN** la stessa card ferma e un land in corso
- **THEN** `working` SHALL essere `true`: il land riscrive main e non aspetta nessuno

#### Scenario: la domanda lasciata aperta di notte e il vacuum
- **GIVEN** una chat e una card ferme su una domanda da ore, niente altro in volo, pagine libere nel database
- **WHEN** parte il giro del vacuum incrementale
- **THEN** SHALL liberare le pagine
- **AND** con una chat che streamma SHALL fermarsi come prima

#### Scenario: il land di un diff del server accanto a una domanda
- **GIVEN** una chat ferma su una domanda e nient'altro
- **THEN** il conteggio dell'auto-land SHALL essere zero
- **AND** SHALL restare positivo con una chat che lavora, o con una card che non torna anche se ferma
