## Purpose

Le cose che tengono il server in piedi e non si vedono da nessuna schermata: la
serializzazione, la memoria che torna al sistema, la porta che qualcun altro ha
preso, e il modo di aspettare un processo senza pagarlo a turni.

## Background

TRE GUASTI MISURATI, TUTTI INVISIBILI DALL'INTERFACCIA.

Il 19/08/2026, con la segnalazione «1,8 GB», il server di produzione misurava
**936 MB di impronta, con un picco storico di 2,4 GB** — e un heap dichiarato di
**52 MB**. La memoria non era occupata dal programma: era stata scambiata su
disco e mai restituita.

Il 20/08/2026, sulla macchina di chi lo usa: il server di un ALTRO progetto,
avviato a mano sulla stessa porta, se l'era presa. **Per nove ore.** Rispondeva
200, quindi ogni controllo di raggiungibilità diceva che andava tutto bene.

E un difetto di forma che uccideva il processo: una promessa lasciata nella mappa
in stato di rifiuto senza nessuno che la gestisse. Sotto questo runtime un
rifiuto non gestito TERMINA il processo — quindi una funzione che falliva uccideva
il server.

## Requirements

### Requirement: RUNTIME-01 — Una promessa nella mappa non può MAI restare rifiutata senza gestore

La coda che serializza il lavoro per chiave NON SHALL mai conservare una promessa
in stato di rifiuto priva di gestore. Sotto questo runtime un rifiuto non gestito
TERMINA il processo: una funzione che fallisce uccideva il server.

L'errore SHALL comunque raggiungere CHI HA CHIAMATO — sopprimerlo per proteggere
il processo trasformerebbe un guasto rumoroso in uno silenzioso.

Dopo un fallimento la coda SHALL continuare a serializzare le chiavi successive.

Chiamate concorrenti sulla STESSA chiave SHALL essere strettamente serializzate;
chiavi DIVERSE SHALL poter procedere in parallelo.

La struttura interna SHALL essere liberata quando tutto il lavoro è concluso: una
coda che ricorda per sempre le chiavi già finite è una perdita che cresce con
l'uso.

La prova SHALL essere fatta in un PROCESSO FIGLIO che deve uscire con esito
zero: è l'unico modo di dimostrare che il processo non muore, perché un test che
gira nello stesso processo non può osservare la propria morte.

#### Scenario: una funzione che fallisce
- **GIVEN** un lavoro in coda che solleva
- **THEN** il processo SHALL restare vivo e l'errore SHALL arrivare al chiamante

#### Scenario: dopo il fallimento
- **GIVEN** una coda che ha appena visto fallire un lavoro
- **THEN** SHALL continuare a servire le chiavi successive

### Requirement: RUNTIME-02 — Una richiesta ripetuta si riconosce, e la memoria non cresce all'infinito

Una richiesta che modifica, RIPETUTA con la stessa chiave entro una finestra,
SHALL restituire il valore già prodotto invece di rifare il lavoro.

La finestra SHALL coprire qualunque ripetizione realistica, e il confine SHALL
essere INCLUSO: esattamente alla scadenza la voce vale ancora.

Una voce scaduta SHALL essere rimossa quando la si cerca, e la struttura SHALL
essere ripulita da sé quando cresce oltre una dimensione dichiarata — ma la
pulizia NON SHALL portare via le voci ancora valide.

Ricordare di nuovo la stessa chiave SHALL sovrascrivere il valore E rinnovare la
finestra.

Una chiave sconosciuta SHALL dare NIENTE, mai un valore.

#### Scenario: esattamente alla scadenza
- **GIVEN** una voce la cui finestra scade in questo istante
- **THEN** SHALL valere ancora

#### Scenario: la mappa cresce
- **GIVEN** più voci del limite dichiarato
- **THEN** le scadute SHALL essere rimosse e le valide SHALL restare

### Requirement: RUNTIME-03 — La memoria si restituisce quando la macchina è ferma, e mai alla cieca

La restituzione della memoria al sistema SHALL essere tentata periodicamente, e
SOLO quando l'impronta supera una soglia dichiarata. Sotto soglia NON SHALL essere
pagata nessuna pausa: una pausa gratuita è puro costo.

La soglia SHALL tenere conto di quanto occupa un server appena partito, e il
confine SHALL essere INCLUSO.

L'operazione NON SHALL fermare il sistema mentre una CARTA della board sta
lavorando. SHALL invece poter procedere mentre una chat sta scrivendo: la pausa
misurata è di pochi millisecondi, e vietarlo su ogni stream significherebbe non
farlo MAI su una macchina dove uno stream è quasi sempre aperto.

NON SHALL procedere per un turno che vive solo nel ponte: quello è un turno
adottato, e tagliarlo è esattamente il danno che si vuole evitare.

Un'impronta ILLEGGIBILE SHALL far saltare il giro, non raccogliere alla cieca:
senza misura non si sa se serviva né se è servito.

L'impronta SHALL essere riletta DOPO che il sistema ha ripreso le pagine, o il
registro riporta «zero recuperati» su un recupero che invece c'è stato.

SHALL essere registrato solo un recupero VISIBILE: una riga ogni pochi minuti che
dice «niente» è rumore che seppellisce le righe che contano.

#### Scenario: una carta al lavoro
- **GIVEN** una carta della board in lavorazione
- **THEN** NON SHALL essere fermato il sistema

#### Scenario: impronta illeggibile
- **GIVEN** una misura dell'impronta non disponibile
- **THEN** il giro SHALL essere saltato

### Requirement: RUNTIME-04 — Chi risponde sulla nostra porta si riconosce dalla FORMA, non dal codice

Il sistema SHALL verificare che chi risponde sulla propria porta sia sé stesso, e
il riconoscimento SHALL essere sulla FORMA della risposta, non sul codice di
stato. Un intruso che risponde 200 supera ogni controllo di raggiungibilità: è
esattamente quello che è successo per nove ore.

Un contenuto valido ma di un altro programma NON SHALL passare.

NESSUNO che risponde NON SHALL essere un allarme: è lo stato normale prima
dell'avvio.

Il sistema NON SHALL accusare SÉ STESSO quando il processo trovato è il proprio.

Un intruso che non si riesce a identificare SHALL essere comunque DENUNCIATO: non
sapere chi è non è una ragione per tacere.

Una sonda che FALLISCE NON SHALL diventare un allarme: un errore di rete non è
un'invasione.

SHALL essere interrogata la rotta più economica sull'indirizzo locale, provando
prima il protocollo cifrato e ripiegando sull'altro — o un server che parla solo
in chiaro viene letto come «silenzio».

#### Scenario: un altro programma che risponde 200
- **GIVEN** un server estraneo sulla stessa porta che risponde correttamente
- **THEN** SHALL essere denunciato

#### Scenario: nessuno in ascolto
- **GIVEN** nessuna risposta sulla porta
- **THEN** NON SHALL essere emesso nessun allarme

### Requirement: RUNTIME-05 — Aspettare un processo si paga una volta, non a turni

Un agente SHALL poter ASPETTARE la fine di un processo, o una riga che compare
nella sua uscita, invece di richiedere l'uscita a ripetizione. Ogni richiesta
ripetuta è un turno del modello, e un turno costa contesto.

Il tempo massimo di attesa SHALL avere un TETTO, e il tetto SHALL stare SOTTO
quello del trasporto che lo porta: superarlo significa che a scadere è il canale,
non l'attesa, e il chiamante non riceve niente. Un valore inutilizzabile SHALL
dare il valore predefinito, mai zero, e SHALL essere accettato anche come testo —
è così che arriva da una richiesta.

Il confronto con la riga attesa SHALL ignorare le maiuscole, e SHALL considerare
anche la riga PARZIALE non ancora terminata: l'ultima riga è spesso proprio
quella che porta l'errore. Un'espressione malformata SHALL dare un errore
LEGGIBILE, non un'eccezione grezza.

La condizione di uscita SHALL poter fermare l'attesa su un processo ANCORA VIVO.

**Scadere NON SHALL essere fallire**: SHALL essere un esito valido, con il punto
a cui si era arrivati, così che l'attesa possa riprendere da lì.

Le righe perse dal contenitore circolare SHALL essere SOMMATE lungo tutta
l'attesa: un conteggio che riparte a ogni giro dice il falso.

Un processo GIÀ finito NON SHALL far aspettare nessuno.

Un'attesa aperta SHALL essere visibile sul PROPRIO processo e solo su quello; due
attese sullo stesso processo SHALL contare entrambe; chiudere due volte NON SHALL
portare via l'attesa di qualcun altro.

#### Scenario: la riga arriva senza a-capo
- **GIVEN** l'uscita che termina con una riga parziale che contiene ciò che si aspetta
- **THEN** SHALL contare come corrispondenza

#### Scenario: l'attesa scade
- **GIVEN** un'attesa che raggiunge il proprio tetto
- **THEN** SHALL essere un esito valido con il punto raggiunto, non un errore

### Requirement: RUNTIME-06 — «Lento» e «morto» si distinguono, e la differenza è il moltiplicatore

Un ponte che RISPONDE LENTAMENTE NON SHALL essere dichiarato morto. La distinzione
SHALL richiedere DUE silenzi insieme: nessuna risposta al battito E nessun byte
in arrivo. Un byte recente — anche di un'ALTRA sessione sullo stesso canale — dice
che il ponte è occupato, non guasto.

Confonderli non costa un errore: costa una RAFFICA. In produzione ha prodotto
**104 scadenze in 9 raffiche, la più grossa di 51 di fila** su topic diversi.
Misurato: sei sessioni con un archivio da 7 MB che si riagganciano insieme mettono
in coda ~44 MB su UN canale, e le risposte escono a scaletta fino a oltre cinque
secondi — nessuna delle due parti è bloccata, è il canale che è pieno. Riciclarlo
lì è ciò che moltiplica il guasto invece di curarlo.

I tempi di attesa SHALL essere DIVERSI secondo il lavoro richiesto: interrogare un
elenco è un giro dentro il processo, mentre avviare un processo nuovo sotto carico
supera la stessa soglia senza che niente sia guasto.

SHALL esistere comunque un TETTO ASSOLUTO: «occupato per sempre» va chiuso lo
stesso. Ma il fallimento per tetto assoluto, arrivato MENTRE i byte scorrevano,
NON SHALL essere ritentato — ritentare un trasferimento da megabyte lo raddoppia.

Un risveglio in ritardo del proprio ciclo NON SHALL essere contato contro il
ponte: racconta noi fermi, non lui.

Un errore APPLICATIVO del processo remoto NON SHALL essere ritentato: si
ripeterebbe identico. Un canale CADUTO invece SHALL riagganciarsi subito, senza
pagare l'attesa; e un canale che sembra sano ma rifiuta la scrittura SHALL essere
buttato e riprovato.

Il secondo tentativo SHALL essere SICURO: un avvio ripetuto SHALL RIPRENDERE il
processo esistente, mai duplicarlo.

Gli avvii SHALL avere un tetto per finestra di tempo. Senza, il 13/08/2026 sono
stati prodotti **1.612 processi su un solo canale in dodici minuti: 36 GB di
scambio su disco e una macchina inutilizzabile.**

Chiudere il client mentre una richiesta è in volo NON SHALL avviare un processo
nuovo e staccato: è la classe di processi randagi già trovata **28 volte su una
sola macchina, alcuni vecchi di tre giorni.**

#### Scenario: pong vecchio, byte recenti
- **GIVEN** nessuna risposta al battito ma byte ancora in arrivo
- **THEN** il canale NON SHALL essere riciclato

#### Scenario: tetto assoluto durante un trasferimento
- **GIVEN** un'attesa che supera il tetto mentre i byte scorrevano
- **THEN** NON SHALL essere ritentata

### Requirement: RUNTIME-07 — Prima la cura economica, poi quella cara — e chi rinviene si ferma

La sorveglianza del ponte SHALL agire per GRADI: al primo silenzio completo SHALL
essere reimpostato il CANALE, non terminato il processo.

L'ordine importa e ha un prezzo misurato: fare per prima la cura cara ha pagato il
secondo costo per il primo problema **31 volte** prima del 21/08/2026 — e quella
cura uccide ogni terminale a metà turno.

Fra la cura economica e quella cara SHALL passare del tempo: un reset ha bisogno
di funzionare prima di essere dichiarato inutile.

La cura cara SHALL essere applicata SOLO se il silenzio persiste dopo il reset:
non applicarla mai lascerebbe un processo bloccato senza rimedio.

Una sorveglianza già armata che ricomincia a sentire byte SHALL FERMARSI: chi
rinviene non si termina.

#### Scenario: primo silenzio completo
- **GIVEN** un ponte muto per la prima volta
- **THEN** SHALL essere reimpostato il canale, non terminato il processo

#### Scenario: rinviene dopo l'armamento
- **GIVEN** una sorveglianza armata e byte che tornano ad arrivare
- **THEN** NON SHALL essere terminato niente

### Requirement: RUNTIME-08 — Il binario si risolve per percorso ASSOLUTO, e ciò che è dichiarato ma non esiste non si crede

Il programma esterno da eseguire SHALL essere risolto per percorso ASSOLUTO,
provando le disposizioni note dei vari modi di installarlo: NESSUNA di esse sta
nel percorso scarno di un processo lanciato dal sistema all'avvio, e affidarsi al
nome nudo significa fallire proprio nella configurazione di produzione.

Una scelta ESPLICITA SHALL vincere su tutto — ma solo se punta a un file che
ESISTE. Un percorso dichiarato e inesistente NON SHALL essere creduto sulla
parola: SHALL essere ignorato e SHALL proseguire la ricerca, altrimenti una
variabile stantia in un ambiente spegne una funzione che avrebbe funzionato.

Il percorso restituito, quando NON è nullo, SHALL esistere davvero sul disco: una
risoluzione che restituisce un candidato non verificato sposta il guasto dal
punto in cui si può spiegare al punto in cui non si può.

#### Scenario: una variabile che punta al vuoto
- **GIVEN** una scelta esplicita verso un file inesistente
- **THEN** SHALL essere ignorata e la ricerca SHALL proseguire

#### Scenario: qualcosa è stato risolto
- **GIVEN** un percorso restituito non nullo
- **THEN** SHALL esistere sul disco

### Requirement: RUNTIME-09 — Chi può vivere senza un fornitore NON SHALL chiederlo in modo che SOLLEVI

La ricerca di un fornitore SHALL avere DUE forme: una che SOLLEVA quando il nome
non è registrato, e una che restituisce «niente». Chi può funzionare SENZA quel
fornitore SHALL usare la seconda.

Il costo della forma sbagliata è stato misurato: su una macchina dove l'unico
fornitore registrato era un altro, lo spazzino dei flussi fermi ha sollevato da
un TIMER, il processo è uscito con errore, il server di prova è sparito a metà
corsa e quindici casi successivi sono falliti a zero millisecondi. Chi non ha
quella riga di comando installata avrebbe incontrato lo stesso guasto la prima
volta che un flusso restava zitto per qualche minuto.

Il banco SHALL verificarlo SUL CODICE, non su un caso: OGNI ricerca di forma
opzionale SHALL passare dalla variante che non solleva, e il timer dello spazzino
SHALL essere uno di quelli.

#### Scenario: un nome non registrato
- **GIVEN** una ricerca opzionale di un fornitore assente
- **THEN** SHALL restituire «niente», non sollevare

#### Scenario: il codice, non il caso
- **GIVEN** una nuova ricerca opzionale scritta con la forma che solleva
- **THEN** il banco SHALL fallire

### Requirement: RUNTIME-10 — La cache locale ha un TETTO, e non riscrive ciò che è già uguale

La cache dei messaggi SHALL avere un TETTO in BYTE sulla voce SERIALIZZATA, non
sul numero di messaggi. Superare la quota dello spazio locale fa fallire OGNI
scrittura dell'applicazione — compresa la coda dei messaggi scritti e non ancora
consegnati.

Un singolo messaggio più grande del tetto NON SHALL essere scritto: la voce SHALL
essere TOLTA. Senza niente in cache NON SHALL essere toccato il disco. Con molti
messaggi enormi, nemmeno la coda da uno SHALL essere scritta. Il ciclo che accorcia
la coda NON SHALL scrivere comunque quando è sceso all'ultimo elemento.

La coda SHALL essere accorciata finché entra, e ciò che entra SHALL essere scritto
INTERO. Nessun messaggio SHALL produrre una lista VUOTA, non l'elenco intero: è la
trappola di un taglio con indice zero.

Un contenuto IDENTICO a quello già in cache NON SHALL essere riscritto — e
l'identità SHALL essere valutata sul carico DOPO la potatura, non sull'elenco di
partenza. Un solo messaggio in più, o un byte cambiato nell'ultimo, SHALL far
partire la scrittura.

La potatura per rientrare nel budget SHALL buttare le voci GROSSE e tenere le
piccole, SHALL buttarne QUANTE SERVONO, e una voce più grande del budget intero
SHALL andarsene.

Il guadagno SHALL essere MISURATO da un banco comparativo, non dichiarato.

#### Scenario: la stessa storia idratata venti volte
- **GIVEN** venti idratazioni identiche
- **THEN** SHALL essere scritta una volta sola

#### Scenario: venti turni che crescono
- **GIVEN** venti scritture realmente diverse
- **THEN** SHALL essere scritte tutte

### Requirement: RUNTIME-11 — Gli orologi girano SOLO quando la finestra è viva, e una vista figlia non li ferma

Gli orologi e le letture periodiche SHALL girare quando la finestra è VISIBILE e
A FUOCO, e SHALL dormire quando non lo è.

Una vista FIGLIA che ha preso il fuoco NON SHALL contare come «la finestra non è
a fuoco»: un clic dentro una superficie nativa rende figlia la vista, e il
documento ospite legge di non avere il fuoco ESATTAMENTE mentre la persona sta
usando l'applicazione — senza questo ramo tutti i terminali visibili
precipitavano a un quarto della loro cadenza.

Una figlia viva NON SHALL sovrascrivere un documento NASCOSTO: nascosto vince su
a-fuoco.

L'assenza degli strumenti per saperlo — un contenitore vecchio, un contesto senza
documento — SHALL fallire APERTO.

#### Scenario: un clic dentro una vista figlia
- **GIVEN** il fuoco su una vista figlia viva
- **THEN** gli orologi SHALL continuare a girare

#### Scenario: la finestra nascosta
- **GIVEN** il documento nascosto e una figlia viva
- **THEN** gli orologi SHALL dormire

### Requirement: RUNTIME-12 — Il polso della connessione si misura sulla RISPOSTA, non sull'invio

Il controllo di vitalità della connessione SHALL guardare la RISPOSTA, non solo
mandare la richiesta: mandarla senza mai guardare l'esito lascia viva una
connessione mezza-aperta — nessun evento scatta, la chiusura non arriva, e la
ripresa non parte mai.

Senza risposta entro la finestra la connessione SHALL essere CHIUSA e la ripresa
SHALL ripartire. Una risposta ricevuta SHALL far RIPARTIRE il conto: è il tempo
dalla RISPOSTA che conta, non quello dall'apertura. La risposta SHALL contare come
segno di vita anche se la validazione la scartasse.

L'orologio scaduto SHALL SPEGNERSI: nessuna raffica di chiusure sulla stessa
connessione.

Chiudere NON BASTA: lo stato dichiarato SHALL LASCIARE «collegato» anche se
l'evento di chiusura non arriva MAI — misurato staccando la rete, la connessione
resta in chiusura e l'evento non scatta, quindi l'indicatore di assenza di rete
non compariva e la coda in uscita non si svuotava.

Una connessione NUOVA SHALL nascere col polso AZZERATO, non già scaduta.

#### Scenario: la rete staccata
- **GIVEN** una chiusura che non completa mai
- **THEN** lo stato SHALL comunque lasciare «collegato»

#### Scenario: una risposta ricevuta
- **GIVEN** un segno di vita
- **THEN** il conto SHALL ripartire da lì

### Requirement: RUNTIME-13 — Una funzione di riferimento INLINE non chiama un setter di stato

Una funzione passata INLINE come riferimento a un elemento NON SHALL chiamare un
setter di stato: viene ricreata a ogni disegno, quindi viene chiamata a ogni
disegno, e chiamare un setter da lì produce una raffica che porta giù la
superficie.

La forma CORRETTA — scrivere in un riferimento, o estrarre la funzione — SHALL
essere lasciata stare: il repository la usa in molti punti, e un rilevatore che la
segnala viene spento.

Un nome che SEMBRA un setter ma che il file DICHIARA come funzione propria NON
SHALL essere segnalato.

Il rilevatore SHALL leggere il corpo su PIÙ RIGHE, che è come il difetto si
scrive davvero, e il file che aveva il difetto SHALL essere verificato pulito.

#### Scenario: la forma che ha rotto la superficie
- **GIVEN** una funzione di riferimento inline che chiama un setter
- **THEN** il banco SHALL fallire

#### Scenario: una funzione già estratta
- **GIVEN** un riferimento memoizzato
- **THEN** NON SHALL essere segnalato

### Requirement: RUNTIME-14 — Il lucchetto del processo si recupera, e lo stato non esiste mai a metà

Il processo principale SHALL prendere un LUCCHETTO e scrivere il proprio stato,
e il file di stato SHALL essere leggibile SOLO dal proprietario: porta un
segreto.

Un secondo avvio con un lucchetto VIVO SHALL essere rifiutato con un errore
DISTINTO. Un lucchetto il cui processo è MORTO SHALL essere RECUPERATO, e così
uno il cui identificativo è VIVO ma PRECEDE l'ultimo avvio della macchina: gli
identificativi si riciclano.

Rilasciare SHALL togliere ENTRAMBI i file, ed essere IDEMPOTENTE quando non ci
sono.

La lettura di uno stato ASSENTE o CORROTTO SHALL dare «niente», non sollevare.

La scrittura SHALL essere ATOMICA: nessun file temporaneo SHALL restare dopo.

Gli SNAPSHOT dello stato dell'interfaccia SHALL seguire le stesse regole —
atomici, leggibili solo dal proprietario, con una RITENZIONE che tiene i più
recenti e toglie gli altri — e l'elenco SHALL essere ordinato dal più recente.

#### Scenario: un identificativo riciclato
- **GIVEN** un lucchetto il cui processo è vivo ma precede l'ultimo avvio
- **THEN** SHALL essere recuperato

#### Scenario: uno stato corrotto
- **GIVEN** un file illeggibile
- **THEN** SHALL valere «niente», senza sollevare

### Requirement: RUNTIME-15 — Una copia di lavoro si ISOLA su casa propria e su TUTTE le proprie porte

Un avvio da una copia di lavoro dedicata SHALL isolarsi su una propria cartella e
su porte proprie. Le variabili già scelte NON SHALL essere toccate.

L'isolamento SHALL coprire TUTTE le porte, non solo la principale: una copia di
lavoro si isolava sulla prima e si prendeva comunque la seconda, lasciando la
produzione in un ciclo di riavvii con la porta occupata.

Un checkout NORMALE e il percorso dell'applicazione impacchettata SHALL restare
sui valori di produzione.

Il riconoscimento NON SHALL essere per SOMIGLIANZA del nome: un progetto che si
chiama come la cartella delle copie di lavoro, ma sta altrove, NON SHALL essere
isolato — e la cartella base NON SHALL riconoscere sé stessa.

Senza una porta secondaria configurata NON SHALL essere inventato niente da
togliere.

#### Scenario: un avvio da una copia di lavoro
- **GIVEN** un checkout dedicato
- **THEN** SHALL spostare casa e TUTTE le porte

#### Scenario: un progetto che si chiama come la cartella delle copie
- **GIVEN** un percorso che somiglia ma sta altrove
- **THEN** NON SHALL essere isolato

### Requirement: BUNDLE-RELOAD-01 — Un pacchetto nuovo si PROPONE, non si impone

Un fotogramma che dichiara una revisione DIVERSA da quella caricata SHALL soltanto
ANNUNCIARE che il pacchetto è vecchio, e NON SHALL MAI ricaricare la pagina sotto
le mani di chi la sta usando.

La ricarica manuale SHALL essere l'UNICO percorso che naviga, SHALL forzare
l'aggiramento della cache e SHALL avere un tetto ai tentativi.

Una revisione UGUALE SHALL restare in silenzio: né annuncio né ricarica. E SHALL
restare in silenzio anche quando la pagina ha caricato pezzi differiti con nomi
diversi — quei nomi non sono una revisione.

Un documento NON marcato SHALL essere fuori da questa regola per intero: è il
pacchetto incorporato nel guscio nativo, che non ha da dove ricaricarsi.

#### Scenario: una revisione diversa
- **GIVEN** un fotogramma con revisione non corrispondente
- **THEN** SHALL essere annunciato, e la pagina NON SHALL essere ricaricata

#### Scenario: un documento non marcato
- **GIVEN** il pacchetto incorporato nel guscio
- **THEN** NON SHALL essere annunciato niente

### Requirement: FDLEAK-01 — I descrittori di file tornano dove stavano, o è una perdita

La sonda SHALL leggere il processo in ascolto dalla colonna giusta, saltando
l'intestazione, e SHALL restituire NIENTE quando nessuno ascolta.

Il conteggio NON SHALL contare la sonda stessa, SHALL separare gli stati che sono
la FORMA della perdita — chiuso e in attesa di chiusura — e SHALL reggere una
riga malformata.

Il giudice SHALL PROMUOVERE la misura quando i descrittori tornano dov'erano, e
SHALL promuovere il respiro naturale di un server vivo: un numero che oscilla non
è una perdita.

SHALL BOCCIARE la crescita misurata il 19/08 — centinaia di descrittori in più —
e SHALL bocciare appena si supera la tolleranza dichiarata.

Un CALO di descrittori NON SHALL essere una perdita.

#### Scenario: il respiro di un server vivo
- **GIVEN** un'oscillazione dentro la tolleranza
- **THEN** SHALL essere promossa

#### Scenario: centinaia di descrittori in più
- **GIVEN** una crescita oltre la tolleranza
- **THEN** SHALL essere bocciata

### Requirement: BACKOFF-01 — Il riavvio in produzione rallenta, invece di provare un giro al secondo

Il 17/08: cinquecentosei avvii falliti in dieci minuti e trentotto secondi, un
tentativo al secondo, senza nessun freno. Un ciclo di caduta senza freno riempie
il registro e rende illeggibile l'errore che lo ha causato.

Un processo che muore PRIMA di una soglia dichiarata SHALL contare come
fallimento di AVVIO, e il ritardo prima del tentativo successivo SHALL CRESCERE
per moltiplicazione — non di un passo fisso — fino a un TETTO.

Il primo fallimento SHALL avere il ritardo minimo. ZERO fallimenti di avvio SHALL
significare NESSUN ritardo: è il caso di un crash in produzione dopo un avvio
riuscito, e lì si riparte subito.

Nessun ritardo SHALL superare il tetto.

Lo script SHALL DICHIARARE la soglia, il ritardo iniziale e il tetto, SHALL
STAMPARE il ritardo che sta applicando, e le costanti dichiarate SHALL coincidere
con quelle su cui la verifica si basa: due copie che divergono rendono la
verifica un'opinione.

#### Scenario: cinque avvii falliti di fila
- **GIVEN** una sequenza di fallimenti di avvio
- **THEN** il ritardo SHALL crescere moltiplicando, fino al tetto

#### Scenario: un crash dopo un avvio riuscito
- **GIVEN** nessun fallimento di avvio
- **THEN** NON SHALL esserci ritardo
