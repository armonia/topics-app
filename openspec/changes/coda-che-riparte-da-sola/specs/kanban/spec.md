# Delta: kanban (coda-che-riparte-da-sola)

> **STATO DELL'ARCHIVIAZIONE (17/09/2026).** Le sezioni **MODIFIED** di questo
> delta sono gia' state fuse nella spec canonica (`openspec/specs/kanban/spec.md`):
> KANBAN-15 e KANBAN-75 la' dentro dicono adesso quello che dice il codice
> atterrato. Le sezioni **ADDED** NON sono state fuse, e il motivo non e' pigrizia:
> gli id si scontrano. `KANBAN-83` esiste gia' nella spec canonica con un altro
> significato («Un allegato durevole valido precede la fotografia automatica»), e
> `KANBAN-84` e `KANBAN-85` sono rivendicati con significati diversi ANCHE dalla
> change `mac-usabile-sotto-carico`, anch'essa non archiviata — la' KANBAN-84 e'
> «l'e2e lo misura la CI della PR» e KANBAN-85 e' il congelamento sotto swap.
> Nel codice atterrato ci sono gia' annotazioni `@covers` per entrambi i
> significati. Rinumerare richiede una passata coordinata sulle due change piu' le
> annotazioni di una quarantina di file, ed e' un lavoro deliberato, non un
> effetto collaterale di un'archiviazione.


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

CORREZIONE A QUEL NUMERO, e vale la pena tenerla perche' rende il requisito piu'
preciso, non meno. Una verifica avversaria ha rimisurato sul log INTERO (1584
campioni, 16/09 07:27 - 17/09 12:28) e ha trovato `held2m >= 6 GB` **241 volte,
il 15,2%**, di cui 238 a swap calmo. Le due misure non si contraddicono: lo zero
descrive le 25,7 ore in cui altre applicazioni tenevano otto gigabyte, il 15%
arriva dopo che una persona — non Topics — ha chiuso un server UAT parcheggiato
da 3,3 GB e il compressore e' sceso da 12,1 a 7,0 GB. Il pavimento quindi NON e'
strutturalmente irraggiungibile: e' raggiungibile solo quando qualcuno libera
memoria a mano, che e' esattamente la frase «la coda aspetta una persona» scritta
in un numero. Il tratto piu' lungo senza una sola lettura sopra la riga misura
16,2 ore.

Quando NESSUN lavoro di Topics e' in volo — zero agenti vivi e zero corse di
check pre-review, lo stesso «zero» che `firstAgentExempt` conta gia' per l'asse
budget — il pavimento sulla MEMORIA SHALL ammettere UNA card, e il verdetto SHALL
dichiararlo come lo dichiara il budget. Con anche un solo agente o una sola corsa
di check in volo il pavimento SHALL valere pieno: l'incidente del 10/09 erano
sette card ammesse insieme, non una.

L'esenzione SHALL valere sia per le ammissioni nuove sia per il `resume` di una
card gia' al lavoro, perche' oggi il pavimento e' valutato prima del budget e
trattiene entrambi.

**Due domande, due censimenti, e ognuno decide la sua riga per intero.** «C'e'
del nostro VIVO qui?» decide l'esenzione, e una card parcheggiata sulla CI di
GitHub conta: la sessione e' viva e residente. «C'e' del nostro che deve ancora
SPENDERE qui?» decide la riga del pavimento, e quella stessa card non conta: ha
gia' finito i suoi check locali, i suoi ~240 MB sono residenti adesso e sono
gia' dentro la lettura, e non c'e' nessuna fiammata futura da coprire. Il RAMO
della riga (pavimento da solo, oppure pavimento + prezzo di una card + riserva)
e la sua CIFRA SHALL uscire dallo STESSO elenco: prendere il ramo dal censimento
e la cifra dal listino chiedeva `pavimento + prezzo + 0` = 10 GB a una macchina
su cui nessuno stava spendendo niente, cioe' la coda ferma per tutti i quindici
minuti in cui una consegna aspetta la CI. Misurato con due card off-lane in volo
e una terza in coda: `held2m` a 7,0 / 8,0 / 9,9 GB tratteneva, a 12,0 GB no.

#### Scenario: con solo card sulla CI in volo la riga e' il pavimento
- **GIVEN** due card in volo i cui check aspettano solo la CI della pull request
- **AND** il minimo su 2 minuti a 7 GB, sopra il pavimento di 6 GB
- **WHEN** il dispatcher valuta la card successiva
- **THEN** la card SHALL essere ammessa, e NON per esenzione
- **AND** con la stessa lettura e un turno che sta ancora girando comandi qui la card NON SHALL essere ammessa

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

### Requirement: KANBAN-15 — Prima della review i comandi girano, e un rosso che non ha misurato niente non è un rosso

Il requisito resta quello che e'. Cambia la condizione con cui il freno davanti a
un comando trattiene: oggi e' il pavimento da solo, e su questa macchina il
pavimento e' sempre rosso.

Il freno nasce per non far partire una suite da 4-11 GB su un Mac che sta gia'
annaspando, e quella e' la cosa giusta. Ma «annaspare» lo misura il verdetto
sullo swap, che il freno ha gia' accanto: il pavimento misura un numero assoluto
che qui non arriva mai. Osservato il 17/09 sulla prima consegna che passa dalle
righe CI: i quattro comandi locali hanno impiegato 32 minuti dei quali circa 30
di sola attesa, mentre `[memsig]` scriveva `swap=calm` per tutta la durata e la
lettura oscillava fra 4,8 e 5,9 GB contro una riga a 6. Il giro e' uscito dalla
valvola dei 30 minuti, non dalla condizione: un freno che spara sempre la sua
valvola e' un timer travestito.

PRIMA STESURA SBAGLIATA, e la correzione e' il punto. Avevo scritto «a swap calmo
il pavimento non trattiene, a swap sostenuto vale pieno». Una verifica avversaria
l'ha smentita eseguendola: sotto swap SOSTENUTO il freno gia' usciva prima di
guardare il pavimento, quindi l'unico momento in cui il pavimento aveva forza era
proprio lo swap calmo. Quella regola non lo indeboliva, lo CANCELLAVA — provato
su 160 stati, con `floorGB` a 0 contro `floorGB` a 1000 il comportamento non
cambia in nessuno. E il pavimento serve ancora a qualcuno: e' montato una volta
per tutto il server, non per board, e un'altra board di questa macchina
(`dancerooms-intq6i`) ha come unico check locale una suite unit, cioe' proprio
l'albero da 4-11 GB che il freno esiste per non far partire su un Mac vuoto.

Quindi il pavimento SHALL restare in vigore com'e', a swap calmo come a swap
sostenuto. Cio' che cambia e' la VALVOLA, e solo quando lo swap e' calmo.

Un giro che aspetta il pavimento con lo swap calmo NON SHALL aspettare piu' di
tre minuti prima di partire comunque; con lo swap sostenuto SHALL restare la
valvola dei trenta minuti che c'e' oggi. La ragione e' che le due attese non
comprano la stessa cosa: sotto thrash la macchina sta davvero restituendo memoria
e aspettare serve, mentre a swap calmo la lettura migliora solo se qualcuno
libera memoria a mano — su questa macchina il minimo su 2 minuti ha superato i
6 GB il 15,2% delle volte (241 su 1584 campioni), ma in un tratto continuo di
16,2 ore non ci e' mai arrivato, e a riaprirlo e' stata una persona che ha chiuso
un server parcheggiato. Dentro quel tratto i trenta minuti e i tre finiscono
identici tranne che per ventisette minuti buttati. Misurato sulla consegna del
17/09: ottanta secondi di esecuzione dentro un giro di trentadue minuti.

Resta invariato tutto il resto: la spaziatura fra due rilasci, la regola che una
lettura non disponibile non fa aspettare, e il fatto che la valvola si conta per
GIRO e non per comando.

Ma le due valvole SHALL avere un orologio ciascuna. Con un contatore solo, il
tempo passato ad aspettare una condizione paga l'altra: un giro fermo dieci
minuti sotto swap sostenuto, con la lettura immobile a 5,2 GB sotto un pavimento
di 6, partiva NELL'ISTANTE in cui il verdetto tornava calmo — i dieci minuti
spesi sullo swap avevano gia' coperto la valvola da tre, e il pavimento non
l'aveva trattenuto per un secondo. Un episodio di thrash comprava cosi'
l'esenzione dal pavimento per tutto il resto del giro, che e' il contrario di
cio' che servono a fare i due freni. Il tempo SHALL essere addebitato alla
condizione in vigore MENTRE passava, non a quella su cui l'attesa finisce.

DUE CONSEGUENZE DEI DUE OROLOGI, dichiarate qui perche' nessuna delle due si
legge nel requisito di prima. **Il tetto di un giro diventa la somma delle due
valvole**, non piu' la sola valvola lunga: un giro puo' aspettare i trenta minuti
su tutto il resto E i tre del pavimento a Mac calmo sopra, cioe' trentatre' minuti
in produzione, dove il pavimento e' montato una volta per tutto il server senza un
tetto suo. E' il prezzo di non far pagare una condizione all'altra: uno swap che
finisce al ventinovesimo minuto lascia un pavimento che non ha trattenuto il giro
un secondo, e addebitargli l'attesa dello swap sarebbe di nuovo l'esenzione che i
due orologi tolgono. **E il tetto del chiamante puo' solo ACCORCIARE la valvola
calma, mai allungarla**: la valvola vale `min(3 minuti, tetto del chiamante)`, non
c'e' un seam per alzarla e nessuno ne ha chiesto uno — il pavimento e' montato una
volta sola, e i tre minuti rispondono a «quanto vale aspettare un Mac calmo», che
non cambia da chiamante a chiamante.

E l'ORDINE con cui si sceglie la condizione SHALL mettere la spaziatura prima del
pavimento, perche' con due orologi quell'ordine decide il BUDGET e non piu' solo
l'etichetta del log. Un giro sotto il pavimento mentre gira il comando di un ALTRO
giro SHALL essere trattenuto dalla spaziatura, sulla valvola lunga che non ha
speso: misurato come pavimento verrebbe pesato sui tre minuti che quello stesso
giro ha appena finito di spendere aspettando il pavimento, e partirebbe
ATTRAVERSO i 120 secondi di spaziatura — che e' la mandria del 15/09, quattro
comandi di consegne diverse rilasciati sullo stesso poll.

E la riga che annuncia il fail-open SHALL dire quale delle due condizioni ha
tenuto il comando fermo — «non c'e' spazio» su un Mac che ha scambiato per
mezz'ora e' l'unica traccia che sopravvive, ed e' falsa — e SHALL dire quanto ha
aspettato DAVVERO quel comando, non il budget del giro. Il log degli errori non
ha timestamp: una riga che scrive «dopo 3 minuti» per tre comandi che hanno
atteso zero, zero e tre minuti non traccia la meta' temporale di niente. Il
budget del giro resta un fatto utile e SHALL comparire accanto, come quello che
e': cio' che il GIRO ha speso, non cio' che il comando ha atteso.

#### Scenario: a swap calmo si aspetta tre minuti, non trenta
- **GIVEN** il minimo su 2 minuti a 5,2 GB, sotto il pavimento di 6 GB
- **AND** il verdetto sullo swap calmo per tutta l'attesa
- **WHEN** un comando di check chiede di partire
- **THEN** SHALL aspettare, e SHALL partire comunque dopo tre minuti di giro

#### Scenario: sotto swap sostenuto la valvola resta a trenta minuti
- **GIVEN** il minimo su 2 minuti a 5,2 GB e il verdetto sullo swap sostenuto
- **WHEN** un comando di check chiede di partire
- **THEN** SHALL aspettare, e SHALL partire comunque dopo trenta minuti di giro

#### Scenario: la riga del fail-open nomina la condizione vera
- **GIVEN** un giro rilasciato dalla valvola con lo swap sostenuto
- **WHEN** la riga viene scritta
- **THEN** SHALL nominare lo swap, non la mancanza di spazio

#### Scenario: il tempo speso sullo swap non paga la valvola del pavimento
- **GIVEN** un giro fermo dieci minuti sotto swap sostenuto, con il minimo su 2 minuti immobile a 5,2 GB sotto il pavimento di 6 GB
- **WHEN** il verdetto sullo swap torna calmo e la memoria non cambia
- **THEN** il comando NON SHALL partire in quell'istante, e SHALL partire tre minuti dopo, cioe' al tredicesimo

#### Scenario: sotto il pavimento e dentro la spaziatura di un altro giro, tiene la spaziatura
- **GIVEN** un giro che ha gia' speso i tre minuti della valvola calma, con il minimo su 2 minuti a 4,8 GB sotto il pavimento di 6 GB
- **AND** il comando di un ALTRO giro rilasciato trenta secondi fa e ancora in esecuzione
- **WHEN** il giro chiede di partire
- **THEN** NON SHALL partire, e la condizione che lo trattiene SHALL essere la spaziatura sulla valvola da trenta minuti
- **AND** quando quel comando esce, la stessa lettura SHALL essere di nuovo il pavimento, sulla valvola calma gia' spesa

#### Scenario: il tetto del giro e' la somma delle due valvole
- **GIVEN** un giro sotto swap sostenuto con il minimo su 2 minuti immobile a 5,2 GB, e un tetto di trenta minuti
- **WHEN** il verdetto torna calmo a un poll dalla fine di quei trenta minuti
- **THEN** il comando SHALL partire dopo altri tre minuti, cioe' al trentatreesimo, e la riga del fail-open SHALL nominare il pavimento

#### Scenario: un tetto piu' lungo non allunga la valvola calma
- **GIVEN** un chiamante che monta il pavimento con un tetto di un'ora
- **WHEN** un giro a Mac calmo sotto il pavimento ha aspettato tre minuti
- **THEN** SHALL partire comunque

#### Scenario: la riga del fail-open dice l'attesa di quel comando
- **GIVEN** un giro di tre comandi a swap calmo sotto il pavimento, dove il primo esaurisce la valvola e gli altri due non aspettano un poll
- **WHEN** le tre righe vengono scritte
- **THEN** la prima SHALL dire tre minuti e le altre due SHALL dire zero secondi, e tutte e tre SHALL riportare accanto i tre minuti spesi dal GIRO

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

**E nemmeno su un commento che ha scritto una macchina.** `MAX(created_at) FROM
task_comments` (`worktree-gc-runner.ts`) non filtra autore ne' `kind`, quindi
ogni nota di servizio (`author = 'system'`) azzera l'orologio esattamente come
farebbe una parola d'agente. Non e' teorico: le note che KANBAN-86 e KANBAN-87
aggiungono nascono proprio sulle card che nessuno sta piu' lavorando — una
consegna che ha smesso di ripartire, una coda ferma dietro il muro di un
provider — cioe' le uniche che l'abbandono dovrebbe raggiungere. Il segno di vita
SHALL essere una parola di un agente o di una persona; una riga scritta dal
server NON SHALL contare.

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

E il tetto SHALL valere solo su una serie ANCORA IN CORSO. Un turno che e'
ripartito dopo la dichiarazione e ha smesso di aspettare chiude la serie, e
nessuna rimessa in coda del dispatcher azzera `wait_since` — solo umano→todo,
review e done — quindi la colonna sopravvive proprio al turno che ha smesso.
Misurato contro `origin/main` sulla forma che il DB vivo porta (`c4d48d3e`:
`wait_streak` 1, `wait_since` di cinque ore fa, `dispatch_deferred_until` NULL):
main la manda `in_progress` con un turno partito, il giudice di fuori la
parcheggiava `backlog` / `waited_out` con zero turni, cioe' il contrario di cio'
che questo requisito serve a fare. Il segno SHALL essere la finestra di rinvio:
`deferForWait` la scrive a ogni dichiarazione e il claim la azzera, quindi su una
riga che porta ancora `wait_since` una finestra NULL dice esattamente «un turno e'
gia' ripartito e non ha ridichiarato l'attesa». NON SHALL essere l'istante
dell'ultimo turno (`task_attempts.created_at`, `in_progress_at`) confrontato con
`wait_since`: su una serie di due o piu' attese quell'istante e' SEMPRE successivo
a `wait_since` — e' cio' che una serie e' — quindi quel confronto spegnerebbe il
backstop invece di delimitarlo.

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

#### Scenario: una nota del server non e' un segno di vita
- **GIVEN** la stessa card, con una nota di servizio scritta dal server un minuto fa
- **WHEN** il giro delle worktree la valuta
- **THEN** l'inattivita' SHALL restare di nove giorni

#### Scenario: la serie di attese sfonda il tetto senza un turno nuovo
- **GIVEN** una card con `wait_since` a cinque ore fa e nessun turno partito da allora
- **WHEN** il giro periodico la valuta
- **THEN** la card SHALL essere parcheggiata con lo stato `waited_out`

#### Scenario: un'attesa sola e lunga non e' una serie sfondata
- **GIVEN** una card che ha dichiarato UNA attesa di 480 minuti, quattro ore fa
- **WHEN** il giro periodico la valuta
- **THEN** la card NON SHALL essere parcheggiata, perche' la sveglia che ha chiesto e' ancora davanti

#### Scenario: un turno gia' ripartito chiude la serie, e la card parte
- **GIVEN** una card con `wait_streak` 1, `wait_since` a cinque ore fa e `dispatch_deferred_until` NULL perche' un turno l'ha gia' reclamata
- **WHEN** il giro la valuta
- **THEN** la card NON SHALL essere parcheggiata, e il giro successivo del dispatcher SHALL farla partire

#### Scenario: un turno che RIDICHIARA l'attesa lascia la serie in corso
- **GIVEN** la stessa card, il cui turno ha dichiarato di nuovo la stessa attesa
- **WHEN** la serie supera le quattro ore e la sveglia e' passata
- **THEN** la card SHALL essere parcheggiata con lo stato `waited_out`

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

NON MISURATO su quel ramo rimanda la consegna all'agente invece di farla entrare
in review, e questo e' voluto. Pesato il 17/09/2026, quando tre card vere di
quella notte avevano esattamente questa forma (lavoro gia' dentro `main`, niente
da landare): da qui dentro quella forma e' indistinguibile da un commit fatto sul
ramo sbagliato, da una worktree riportata su `main` o da un ramo che un rebase ha
svuotato, e due verdi sull'unico ingresso in cui NON si e' misurato niente sono
la bugia che queste righe esistono per non dire. Sbagliata era la ragione: «serve
un commit nuovo» e' l'unica uscita che un agente puo' prendere, e per una card
gia' dentro main quel commit non esiste. La ragione SHALL nominare ENTRAMBE le
uscite, quella di una persona per prima.

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
- **THEN** SHALL essere non misurate, e il referto SHALL nominare sia l'uscita della persona (lavoro gia' in `main`, card da chiudere) sia quella dell'agente (un commit nuovo)

### Requirement: KANBAN-86 — Una card non dice «verde» su un commit la cui CI e' rossa

Le due righe CI leggono una FETTA della prova: `unit-ci` il passo «Unit +
integration tests» del job `check`, `e2e-ci` i quattro shard. E' la lettura
giusta per quello che devono misurare, ma produce una frase piu' larga di cio'
che sa: la card scrive «i check pre-review sono verdi» mentre la run della sua
stessa pull request e' rossa per un passo che nessuna delle sei righe guarda.

Osservato il 17/09/2026 su due delle tre consegne con lavoro vero arrivate in
review quella notte. Su `topics/clumsy-wren` (run 35168540957) e
`topics/imperial-canal` (run 35169547221) il job `check` e' fallito allo step
«Bundle size budget» — `entry_eager.gz` di 314 e 28 byte oltre il tetto — mentre
lo step «Unit + integration tests» era `success` e i quattro shard e2e verdi.
Risultato: `checks_state = 'pass'`, chip verde, e la run della PR
`completed/failure`.

Prima del PATCH questa prova non esisteva affatto e la card non poteva
contraddirla. Adesso esiste, e' a due chiamate di distanza, ed e' rossa: guardarne
una fetta e chiamarla verde e' peggio che non averla, perche' la card AFFERMA
qualcosa che la CI smentisce.

Quando la run che le righe CI hanno letto e' rossa, il giro NON SHALL chiudere
con tutte le righe verdi. SHALL aggiungere al referto il fatto, nominando il job
e il passo che hanno fallito e il link alla run, e il verdetto complessivo della
card NON SHALL essere `pass`. Le singole righe restano quello che sono — il passo
unit era verde e dirlo e' corretto — ma la CARD non puo' dichiararsi verde su una
CI rossa.

«ROSSA» SHALL essere letto dai JOB, non solo dalla conclusione della run. La
chiusura tutta-verde non aspetta la run: scatta appena l'ultima riga dichiarata
ha un verdetto, e li' `run.conclusion` puo' essere ancora `null`. Sonda del
17/09/2026 contro la guardia che leggeva solo la run: run `in_progress` con un
job ancora vivo, `check` GIA' `completed/failure` al passo «Bundle size budget»,
passo unit verde e quattro shard verdi davano `rows.ok = [true, true]` e
`ciRunRed = [null, null]`, cioe' la card verde che KANBAN-86 vieta. La variante
piu' probabile e' la stessa chiusura con tutti i job finiti e la run non ancora
girata a `completed` fra la chiamata `runs()` e la `jobs()` dello stesso poll:
sulle 33 run di `ci.yml` misurate quel giorno l'ultimo job e' sempre uno shard
e2e e `check` finisce da 2,8 a 10,7 minuti prima, quindi oggi quella finestra e'
di secondi e si allarga appena `check`, o `tauri` con la cache Rust fredda,
superano gli shard. Quando invece la run E' conclusa, la sua conclusione SHALL
prevalere: GitHub la calcola su tutti i job.

Questo NON SHALL diventare un sesto cancello che rifa' in locale cio' che la CI
misura: la lettura e' la stessa gia' fatta, un campo dello stesso oggetto.

#### Scenario: la run e' rossa altrove
- **GIVEN** un commit la cui run ha il passo unit verde, gli shard e2e verdi e il job `check` fallito a un passo successivo
- **WHEN** il giro chiude
- **THEN** il verdetto della card NON SHALL essere `pass`, e il referto SHALL nominare il job e il passo falliti con il link alla run

#### Scenario: il job e' gia' rosso e la run non e' ancora conclusa
- **GIVEN** lo stesso commit, con la run ancora `in_progress`, un job che le righe CI non leggono gia' fallito e gli altri ancora vivi
- **WHEN** il giro chiude perche' tutte le righe dichiarate hanno un verdetto verde
- **THEN** il verdetto della card NON SHALL essere `pass`, e il referto SHALL nominare il job e il passo gia' falliti

### Requirement: KANBAN-89 — La spia «check in corso» la accende il registro vivo, non la riga

Una corsa di check vive nel processo (`checks-gate.ts`). La riga dice
`checks_state = 'running'` per tutta la sua durata, e a spegnerla c'era un solo
chiamante: la costruzione della rotta, cioe' l'unico istante in cui il registro
del cancello e' vuoto per costruzione e ogni spia nel database e' quindi di un
processo morto.

Un boot non e' mai stato l'unico modo di lasciarne una accesa. Se `measure()`
finisce senza scrivere lo stato terminale — il freno dello swap,
`throwIfStopping()`, una qualunque eccezione che il cancello registra come
`corsa … esplosa` — il cancello lascia la chiave e la riga continua a dire
«running». Misurato il 17/09/2026: 89 boot hanno trovato almeno una spia gia'
accesa (71 volte 1, 16 volte 2, una volta 4, una volta 6). Fra due boot quella
riga mentiva a tutti i suoi lettori: 1253 riarmi del giudice di stallo, e una
passata StaleStream che rispondeva `extend` a ogni turno muto di quella sessione,
quindi un turno morto non veniva mai finalizzato.

Il predicato che dice «questa sessione aspetta i NOSTRI check» SHALL leggere il
registro vivo del cancello, e la riga SHALL essere una conferma, non una fonte.

Una passata periodica SHALL riconciliare le due, tenendo in mano il registro
vivo: spegne le spie che il cancello non conosce piu', e NON SHALL toccare una
corsa viva ne' una in coda dietro la corsa di un'altra card. Finche' la rotta non
esiste — nessun registro da incrociare — la passata NON SHALL spegnere niente:
li' ogni spia e' ancora affare della passata del boot.

Spegnere la spia non basta: la card resta ferma senza giro, perche' in-processo
solo un `ChecksInterruptedError` con motivo `swap` fa ripartire la consegna, e il
boot ormai ci rinuncia dopo tre giri (KANBAN-87). Per ogni spia spenta la passata
SHALL riemettere la consegna che questo processo sta ancora tenendo per quella
card, se ne tiene una, e SHALL annunciare la card alle board che ce l'hanno
aperta.

#### Scenario: una riga «running» senza corsa viva non trattiene nessun orologio
- **GIVEN** una card `in_progress` con `checks_state = 'running'` e il cancello che non conosce piu' quella corsa
- **WHEN** il giudice di stallo chiede se la sessione aspetta i nostri check
- **THEN** la risposta SHALL essere no

#### Scenario: la passata spegne l'orfana e lascia stare la viva
- **GIVEN** due card con la spia accesa, di cui una con la corsa ancora nel registro
- **WHEN** la passata periodica gira
- **THEN** SHALL spegnere solo quella che il registro non conosce, annunciarla, e riemetterne la consegna

#### Scenario: prima che la rotta esista non si spegne niente
- **GIVEN** una spia accesa e nessun registro del cancello ancora disponibile
- **WHEN** la passata periodica gira
- **THEN** NON SHALL spegnere niente

### Requirement: KANBAN-87 — Lo stesso giro di consegna non riparte all'infinito, e i giri si contano per consegna

Riemettere una consegna al boot vale solo finche' il giro che avvia puo' arrivare
a un verdetto. Con `TOPICS_SERVER_WATCH=1` un SIGTERM arriva a ogni salvataggio
sotto `server/` — 6 riavvii nell'ora 14/09T23, 4 nell'ora T20, 1-2 all'ora per
tutto il 16/09 — mentre un giro con le righe CI costa minuti di comandi locali
piu' fino a 65 minuti di attesa della CI. Senza un conteggio lo stesso giro
ripartiva da zero a ogni boot, senza misurare niente e senza dirlo.

I giri di una consegna SHALL essere contati sulla riga che la ricorda, e oltre un
tetto il boot NON SHALL rifare il giro: SHALL scriverlo sulla card, una volta, e
dimenticare la riga. Nient'altro SHALL essere toccato — la card resta
`in_progress`, il ramo e il commit dove l'agente li ha lasciati — perche' a
sbloccarla e' una persona o una consegna nuova.

IL CONTO E' DELLA CONSEGNA, NON DELLA CARD. Una consegna su un commit DIVERSO
SHALL ripartire da zero: l'agente che ha committato una correzione sta facendo
lavoro nuovo, ed ereditare i giri bruciati lo zittirebbe prima del suo primo
giro. Un commit memorizzato NULL vuol dire «non l'abbiamo mai saputo», non
«stessa consegna» — ed e' proprio il caso che brucia i giri piu' facilmente,
perche' la gamba interrotta scrive la riga prima che il checkout sia risolto.

La tabella SHALL degradare come se il conteggio non esistesse quando la colonna
non c'e' (un database ripristinato da un backup precedente alla migration): la
riga SHALL essere scritta lo stesso, e il conteggio SHALL rispondere zero.
Perdere la riga costa un riallineamento, perdere la scrittura costa la consegna.

#### Scenario: oltre il tetto la card riceve una riga invece di un giro muto
- **GIVEN** una consegna il cui giro e' stato tagliato dal riavvio tre volte
- **WHEN** il boot successivo la riprende
- **THEN** NON SHALL partire nessun comando, la riga SHALL essere dimenticata, e la card SHALL dire che serve un commit nuovo o una persona

#### Scenario: una consegna su un commit nuovo non eredita i giri bruciati
- **GIVEN** una riga che ha bruciato tre giri senza mai conoscere il suo commit
- **WHEN** arriva una consegna con un commit
- **THEN** il conto SHALL tornare a zero

#### Scenario: senza la colonna dei giri la consegna si ricorda lo stesso
- **GIVEN** un database senza la colonna del conteggio
- **WHEN** una consegna viene ricordata
- **THEN** la riga SHALL esserci, e il conteggio SHALL rispondere zero

### Requirement: KANBAN-88 — Un muro di giorni si dichiara come tale, e lo dice UNA volta per card

L'etichetta di un hold del provider era la sola ora locale, e un'ora sola non
distingue sei ore da sei giorni. Misurato il 17/09/2026: `provider-hold.json`
portava un muro Codex scritto il 13/09 alle 17:39 e in scadenza il 19/09 alle
14:45, mentre il log ripeteva «resumes at 14:45» 43 volte fra il 13/09T15:38 e il
16/09T22:28 — e la board manda ogni card a quel provider.

L'etichetta SHALL portare anche la data quando l'attesa non finisce oggi. Oltre
un giorno l'attesa NON SHALL essere raccontata come il reset di una finestra: e'
un piano esaurito, e a muovere le card e' una persona che cambia il modello della
board o l'account. La card SHALL riceverlo nel suo thread, non solo nel chip.

UNA VOLTA PER CARD, E ATTRAVERSO I RIAVVII. Un registro «gia' detto» che vive nel
processo non e' una difesa qui: il processo riparte ogni ~35 minuti (44 riavvii
in 25,7 ore) mentre l'attesa dura giorni, e la finestra di dedup dei commenti e'
di 10 secondi. Con 7 card in coda dietro un muro di 6 giorni fanno circa 300
paragrafi identici al giorno, cioe' la stessa pila che KANBAN-83 esiste per
chiudere. E la frase CAMBIA da sola — conta i giorni che restano — quindi la
difesa sul testo identico non basta: la nota SHALL occupare uno slot nel thread,
e quella nuova SHALL sostituire la vecchia invece di aggiungersi.

#### Scenario: cinque boot su tre giorni lasciano un paragrafo, non cinque
- **GIVEN** una card in coda dietro un muro di sei giorni
- **WHEN** il server riparte cinque volte, due a 35 minuti e due a un giorno di distanza
- **THEN** il thread SHALL portare una sola nota, e SHALL essere quella corrente

#### Scenario: un muro di ore resta un'attesa
- **GIVEN** un hold che finisce fra un'ora
- **WHEN** il dispatcher valuta la card
- **THEN** il chip SHALL dire l'ora del reset, e il thread NON SHALL ricevere niente
