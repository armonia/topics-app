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
