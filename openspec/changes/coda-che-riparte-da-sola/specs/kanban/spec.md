# Delta: kanban (coda-che-riparte-da-sola)

## MODIFIED Requirements

### Requirement: KANBAN-75 — Il tetto sa contare gli agenti O dare a Topics una fetta del PC, e sono due domande diverse

Il requisito resta quello che e'. Cambia UNA frase: «il pavimento resta sopra a
tutto ... il secondo aspetta una persona» valeva per il disco e per la RAM
insieme, e per la RAM era sbagliata.

**Il disco aspetta una persona. La memoria no.** Un disco pieno non si riassorbe
da solo: nessuna esenzione, nessun tetto di attesa, il motivo resta
`resource_floor` con tono `stalled`. La memoria si riassorbe eccome — sono le
altre applicazioni a tenerla, e la riaprono quando finiscono — ma il pavimento
non aveva nessuna uscita, e su un Mac che qualcuno sta usando questo NON produce
un'attesa: produce una coda che non riparte mai.

Misurato il 16-17/09/2026 su 1455 righe `[memsig]`, 25,7 ore: `held2m >= 6 GB`
**zero volte**, `avail` istantaneo sopra 6 GB 11 volte su 1444 (0,76%) e mai due
di fila, mentre il pavimento pretende il minimo di 12-13 letture consecutive.
Sette card ferme fra 45 e 51 ore, 314 commenti «Memoria quasi finita», una sola
ripartenza in 26 ore e per merito di una persona che ha chiuso delle app. In ogni
campione `inFlight = 0` e `checkRuns = 0`: la RAM non era di Topics.

Quando NESSUN lavoro di Topics e' in volo — zero agenti vivi e zero corse di
check pre-review, lo stesso «zero» che `firstAgentExempt` conta gia' per l'asse
budget — il pavimento sulla MEMORIA SHALL ammettere UNA card, e il verdetto SHALL
dichiararlo come lo dichiara il budget. Con anche un solo agente o una sola corsa
di check in volo il pavimento SHALL valere pieno: l'incidente del 10/09 erano
sette card ammesse insieme, non una.

L'esenzione SHALL valere sia per le ammissioni nuove sia per il `resume` di una
card gia' al lavoro, perche' oggi il pavimento e' valutato prima del budget e
trattiene entrambi.

#### Scenario: a Topics fermo una card parte anche sotto il pavimento
- **GIVEN** il minimo su 2 minuti a 4,8 GB, sotto il pavimento nativo di 6 GB
- **AND** zero agenti vivi e zero corse di check pre-review
- **WHEN** il dispatcher valuta la prima card in coda
- **THEN** la card SHALL essere ammessa, e il motivo SHALL dire che e' passata perche' Topics non stava facendo niente

#### Scenario: con un agente al lavoro il pavimento vale pieno
- **GIVEN** il minimo su 2 minuti a 4,8 GB e un agente vivo
- **WHEN** il dispatcher valuta la card successiva
- **THEN** la card NON SHALL essere ammessa, e il motivo SHALL restare quello del pavimento

#### Scenario: il disco non ha esenzione
- **GIVEN** meno di 12 GB liberi sul disco delle worktree e zero lavoro in volo
- **WHEN** il dispatcher valuta la prima card in coda
- **THEN** la card NON SHALL essere ammessa

## ADDED Requirements

### Requirement: KANBAN-82 — La finestra di memoria sopravvive a un ricarico breve

Il minimo su 2 minuti nasce da una lista di campioni che vive nel processo. Con
`TOPICS_SERVER_WATCH=1` il server riparte a ogni salvataggio in `server/`, e per
120 secondi `heldMemory()` non ha una risposta: ogni ammissione e ogni `resume`
sono bloccati, a macchina libera come a macchina piena. Misurate 28 finestre
azzerate in 25,7 ore su 44 riavvii, circa 56 minuti al giorno di coda ferma che
non dipende dalla memoria.

I campioni del segnale di memoria SHALL sopravvivere al riavvio del processo, e
al boot SHALL essere ricaricati applicando lo STESSO taglio che vale fra due
campioni vivi (`MEM_SAMPLE_GAP_MS`, 30 s): un processo tornato su in pochi
secondi eredita una finestra valida, uno fermo dieci minuti riparte da zero come
oggi. La regola «non parto su una lettura sola» NON cambia.

#### Scenario: un riavvio di tre secondi non azzera la finestra
- **GIVEN** tredici campioni buoni scritti fino a tre secondi fa
- **WHEN** il processo riparte e chiede il minimo su 2 minuti
- **THEN** la risposta NON SHALL essere «la sto misurando», e il minimo SHALL essere quello dei campioni ereditati

#### Scenario: una pausa lunga riparte da zero
- **GIVEN** campioni vecchi di dieci minuti
- **WHEN** il processo riparte e chiede il minimo su 2 minuti
- **THEN** la risposta SHALL essere «la sto misurando»

### Requirement: KANBAN-83 — Due blocchi diversi non condividono la chiave di dedup

La chiave che evita di riscrivere la stessa attesa e' la prima parola del motivo.
«Memoria: la sto misurando da 11 s su 120» e «Memoria quasi finita: la lettura
piu' bassa degli ultimi 2 minuti e' 4,8 GB» hanno la stessa prima parola, quindi
la seconda non viene MAI scritta: e' uno stato di 120 secondi garantito a ogni
boot che zittisce per sempre il motivo vero. Misurati 80 commenti su 80 dopo il
15/09 17:49 con la frase di riscaldamento e zero con quella vera, mentre la
colonna `dispatch_error` accanto veniva rinfrescata ogni 60 secondi col testo
giusto: chip e conversazione dicevano due cose diverse.

Il riscaldamento della finestra SHALL essere un blocco a se' ai fini della
chiave, oppure NON SHALL essere scritto affatto sulla conversazione della card,
visto che dura 120 secondi e il chip lo dice gia'. Quando il motivo CAMBIA, la
card SHALL riceverlo: un registro «gia' detto» SHALL decadere al cambio della
frase, non solo alla fine del blocco.

#### Scenario: il motivo vero arriva sulla card
- **GIVEN** una card trattenuta al boot, con la finestra ancora vuota
- **WHEN** la finestra si riempie e il blocco diventa quello del pavimento
- **THEN** la conversazione della card SHALL portare il motivo del pavimento

### Requirement: KANBAN-84 — Gli orologi che reclamano una card non guardano cio' che il dispatcher riscrive

Tre backstop esistono per reclamare una card che nessuno sta lavorando, e tutti e
tre oggi non scattano.

`taskIdleDays` prende il massimo fra `tasks.updated_at`, l'ultimo commento e
l'ultimo messaggio. Ma `setDispatchState` riscrive `updated_at` ogni 60 secondi
proprio mentre trattiene la card, quindi l'inattivita' e' sempre circa zero e
`decideWorktreeReap` risponde `keep` per sempre: misurato su 7 card su 7, e zero
abbandoni in tutta la storia del log. L'inattivita' di un task SHALL essere
misurata solo su segni che il LAVORO lascia — commenti d'agente, messaggi del
topic, tentativi, mtime del transcript — mai su una colonna che il dispatcher
riscrive mentre aspetta.

Il tetto sulla DURATA di una serie di attese (`WAIT_SERIES_MAX_MS`, 4 ore) e'
letto in un solo punto, dentro `deferForWait`, cioe' solo se un altro turno parte
e ridichiara l'attesa. Se il dispatcher non ammette piu' nessuno la serie cresce e
nessuno la guarda: misurate 2 card oltre il tetto da 45 e 31 ore, zero parcheggi
`waited_out`, zero notifiche. Il tetto SHALL essere valutato anche da fuori, in un
giro che passa comunque card per card, e oltre il tetto la card SHALL essere
parcheggiata come farebbe `deferForWait`.

Quel giudice di fuori NON SHALL scavalcare la sveglia che l'agente ha chiesto.
`deferForWait` accetta fino a 1440 minuti e la produzione li usa — fra le 78 note
«riprovo tra ~N min» ci sono 240, 180 e 120 — quindi una singola attesa piu' lunga
di quattro ore e' una card normale, non una card ferma. Finche'
`dispatch_deferred_until` e' nel futuro nessun turno ha potuto guardare se la
condizione e' arrivata, e li' il giudice SHALL tacere. Il tetto sulla DURATA resta
un tetto su una SERIE: con una sola attesa dichiarata l'orologio SHALL partire
dalla sveglia, non dalla dichiarazione, perche' il tempo in cui nessuno ha guardato
la card comincia li'.

Una card che un umano ha bocciato riparte oggi con «il tuo turno e' stato
interrotto, continua il lavoro rimasto»: il testo del rifiuto viveva in una Map in
memoria e muore al primo riavvio, mentre `tasks.reopened_actor` dice sulla riga
chi ha riaperto. Misurate 3 card bocciate il 15/09, ferme da 45 ore, ognuna
passata per 44 riavvii. Quando `reopened_actor` e' `human` e la riapertura e'
successiva alla fine dell'ultimo turno, il messaggio di ripresa SHALL essere
composto con i commenti umani da quella riapertura in poi, mai col sollecito da
turno interrotto.

#### Scenario: una card trattenuta invecchia davvero
- **GIVEN** una card il cui ultimo commento d'agente ha nove giorni e il cui chip e' stato riscritto un minuto fa
- **WHEN** il giro delle worktree la valuta
- **THEN** l'inattivita' SHALL essere di nove giorni

#### Scenario: la serie di attese sfonda il tetto senza un turno nuovo
- **GIVEN** una card con `wait_since` a cinque ore fa e nessun turno partito da allora
- **WHEN** il giro periodico la valuta
- **THEN** la card SHALL essere parcheggiata con lo stato `waited_out`

#### Scenario: un'attesa sola e lunga non e' una serie sfondata
- **GIVEN** una card che ha dichiarato UNA attesa di 480 minuti, quattro ore fa
- **WHEN** il giro periodico la valuta
- **THEN** la card NON SHALL essere parcheggiata, perche' la sveglia che ha chiesto e' ancora davanti

#### Scenario: una bocciatura umana riparte col suo testo
- **GIVEN** una card con `reopened_actor = 'human'` e tre obiezioni scritte dall'umano
- **WHEN** il server riparte e la riadotta
- **THEN** il messaggio di ripresa SHALL contenere le obiezioni, e NON SHALL essere il sollecito da turno interrotto

### Requirement: KANBAN-85 — Un verdetto letto dalla CI finisce sempre in qualcosa su cui si puo' agire

Le righe `unit-ci` ed `e2e-ci` leggono la CI della pull request invece di girare
sul Mac. Il verdetto NON MISURATO e' l'esito giusto quando la prova non c'e', ma
oggi e' anche un vicolo cieco: nessuno dei suoi rami dice che cosa farebbe
uscire la card da li'. Misurato: 15 delle ultime 100 sha con una run
`pull_request` di `ci.yml` hanno come ULTIMA run una `cancelled`, cioe' sono gia'
adesso nello stato terminale che non produce mai un verdetto.

Quando l'ultima run di uno sha e' TERMINALE e senza verdetto (cancellata,
superata, oppure completata senza il job o senza il passo che la riga legge),
riconsegnare lo STESSO commit non puo' funzionare: il push esce zero perche' il
ramo e' gia' aggiornato, la bozza viene riusata, e la lettura ritrova la stessa
run morta. Il giro SHALL provare UNA volta a far ripartire quella run, e se non
puo' SHALL dire nel referto che serve un commit nuovo, invece di descrivere solo
cio' che non ha misurato.

Il giro di attesa SHALL fermarsi al primo ROSSO gia' accertato, marcando le altre
righe CI come non misurate con quella ragione: la regola «ci si ferma al primo
rosso» vale gia' per i comandi locali, e aspettare l'altra riga fino alla scadenza
di 60 minuti consegna in ritardo un rosso che era azionabile subito.

La sonda che riconosce una pull request in conflitto SHALL essere considerata
consumata solo su una risposta CONCLUSIVA: una risposta indeterminata o una
lettura fallita NON SHALL disarmarla, altrimenti l'unico modo che il giro ha di
riconoscere il conflitto si brucia al primo tentativo e restano 55 minuti di
attesa muta.

Un ramo senza commit propri oltre `main` NON SHALL produrre due righe verdi: non
c'e' niente da misurare, e il verde di una riga che non ha misurato niente e' la
bugia che queste righe esistono per non dire. SHALL essere NON MISURATO con quella
ragione.

Il contratto che fissa i nomi letti nella CI SHALL coprire anche la FORMA dei nomi
dei job e2e, non solo il nome del passo unit: oggi un secondo asse nella matrice
rinominerebbe i job e ogni consegna tornerebbe NON MISURATA con la CI verde, senza
che nessun cancello se ne accorga.

Durante l'attesa della CI — quindici minuti misurati su una run normale — la card
SHALL portare il link della pull request e quello della run appena esistono, e la
riga di attesa NON SHALL attribuire la misura al cancello della board mentre a
misurare e' GitHub.

Un verdetto NON MISURATO SHALL essere dipinto come non misurato ovunque compaia:
il chip della card lo distingue gia', il dettaglio della card lo dipinge rosso, e
due verdetti opposti sulla stessa card sono peggio di nessuno dei due.

#### Scenario: una run terminale senza verdetto non gira a vuoto
- **GIVEN** uno sha la cui ultima run `pull_request` e' completata e cancellata
- **WHEN** il giro di attesa la legge
- **THEN** SHALL provare una volta a farla ripartire, e se non puo' il referto SHALL dire che serve un commit nuovo

#### Scenario: il primo rosso chiude il giro
- **GIVEN** la riga unit gia' rossa e la riga e2e ancora in corso
- **WHEN** il giro valuta se continuare
- **THEN** SHALL uscire subito, e la riga e2e SHALL risultare non misurata con la ragione del rosso

#### Scenario: una risposta indeterminata non consuma la sonda del conflitto
- **GIVEN** nessuna run dopo la soglia di grazia e una lettura della mergeability che non conclude
- **WHEN** il giro riprova al ciclo successivo
- **THEN** la sonda SHALL essere ancora armata

#### Scenario: nessun commit proprio non e' un verde
- **GIVEN** una consegna il cui sha non ha commit propri oltre `main`
- **WHEN** le righe CI vengono valutate
- **THEN** SHALL essere non misurate, e il referto SHALL dirne la ragione
