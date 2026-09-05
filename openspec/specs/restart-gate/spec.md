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

#### Scenario: trattiene una chat nativa
- **GIVEN** un riavvio in attesa, nessuna card in volo, una chat del runtime nativo in streaming
- **THEN** la porta SHALL essere aperta e le card in coda SHALL partire

#### Scenario: la chat finisce, restano card
- **GIVEN** la stessa attesa dopo la fine della chat, con due card in volo
- **THEN** la porta SHALL richiudersi, e il riavvio SHALL seguire la fine di quelle due card
