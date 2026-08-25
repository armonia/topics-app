## Purpose

Le sessioni che vivono FUORI da Topics — Claude Code, Codex, jcode aperti a mano
in un terminale — trovate sul disco, censite, e adottabili dentro una chat senza
che chi le ha aperte debba ricominciare.

## Background

TRE PROVIDER, TRE MODI DI MENTIRE SU «È VIVA». Ognuno tiene le proprie sessioni
in un posto diverso e in un formato diverso, e il segnale di attività di ciascuno
è sbagliato in un modo tutto suo:

- il primo scrive in append su un file per sessione, e lì l'istante di ultima
  modifica del file È l'ultima attività — su ogni sessione recente lo scarto fra
  quell'istante e l'ultimo evento scritto dentro è zero;
- il secondo chiude i turni con un evento esplicito, quindi «il file è fresco»
  non basta: chiudere un turno e restare fermi conterebbe come «al lavoro» per un
  quarto d'ora;
- il terzo non tocca affatto il file mentre lavora. Misurato il 23/08: 1.375
  sessioni su disco, ZERO modificate negli ultimi quindici minuti, mentre sette
  processi erano vivi e uno stava macinando.

Ogni provider ha quindi il proprio criterio, e nessuno dei tre può prendere in
prestito quello di un altro.

## Requirements

### Requirement: EXTSESS-01 — Il censimento costa poco, e non legge quello che non gli serve

Il censimento SHALL rifiutare un file più vecchio della finestra PRIMA di
leggerlo, sulla base del solo istante di modifica. È ciò che tiene il costo basso
su un archivio di centinaia di conversazioni.

Delle sessioni recenti SHALL essere letta la CODA, non tutto il file: i campi che
servono stanno in fondo, e il resto è trascritto.

La testa letta SHALL essere abbastanza grande da contenere il blocco iniziale
INTERO. Con una testa troppo corta quel blocco arriva troncato e **ogni** sessione
di quel provider sparisce dal censimento SENZA nessun errore — un censimento
vuoto e un provider assente si assomigliano troppo.

Una riga corrotta, un file a metà scrittura, un file vuoto o una cartella che non
esiste NON SHALL far cadere lo scanner: il risultato SHALL essere zero sessioni,
mai un'eccezione. Un file parziale NON SHALL portarsi via le altre sessioni.

Un file che non è un trascritto NON SHALL essere letto.

La data della CARTELLA che contiene un file NON SHALL essere usata come data del
file: l'istante di modifica di una cartella non si muove quando un file dentro
viene riscritto, e una sessione aperta giorni fa e scritta oggi resta archiviata
sotto il giorno in cui è nata.

Il numero di sessioni lette SHALL avere un tetto.

#### Scenario: un file oltre la finestra
- **GIVEN** un trascritto più vecchio della finestra
- **THEN** SHALL essere saltato senza essere letto

#### Scenario: una cartella datata giorni prima
- **GIVEN** una sessione scritta oggi ma archiviata sotto una data vecchia
- **THEN** SHALL essere trovata

### Requirement: EXTSESS-02 — «Al lavoro» si decide col criterio di QUEL provider

Lo stato di una sessione SHALL essere deciso col segnale che quel provider
produce davvero, e i criteri NON SHALL essere condivisi fra provider.

Dove il file cresce mentre si lavora, l'istante di modifica SHALL bastare.

Dove esiste un evento di FINE TURNO, quell'evento SHALL avere la precedenza sulla
freschezza del file: un turno chiuso è fermo, anche se il file è appena stato
toccato.

Dove il file NON si muove durante il lavoro, lo stato SHALL richiedere che il
processo risponda ANCORA, che il provider dichiari la sessione attiva, e che ci
sia stato movimento recente — tutte e tre. Il processo da solo NON basta, perché
quel server è CONDIVISO fra sessioni: un identificativo di processo vivo le
farebbe risultare tutte al lavoro.

La verifica che un processo esista SHALL distinguere «non esiste» da «esiste e
non è mio»: il secondo conta come VIVO.

Una sessione vecchia ma dentro la finestra SHALL essere riportata come FERMA, mai
come assente: «vecchia» e «non c'è» sono due risposte diverse.

Le sessioni SHALL essere ordinate dalla più recente.

#### Scenario: turno chiuso, file fresco
- **GIVEN** una sessione il cui ultimo evento dichiara il turno concluso
- **THEN** NON SHALL risultare al lavoro

#### Scenario: processo di un altro utente
- **GIVEN** un processo che esiste ma appartiene a un altro utente
- **THEN** SHALL contare come vivo

### Requirement: EXTSESS-03 — Attribuire un progetto senza inventarlo, e senza rubarsi le sessioni

La cartella di lavoro di una sessione SHALL essere presa dall'ULTIMA riga che la
dichiara, non dalla prima: chi cambia cartella durante la sessione renderebbe
stantia quella iniziale.

L'attribuzione a un progetto SHALL scegliere la radice PIÙ LUNGA che contiene
quella cartella, e SHALL essere un confronto per SEGMENTI di percorso: una
cartella che condivide solo un prefisso di NOME non è dentro l'altra.

Una sessione la cui cartella non sta in nessun progetto noto SHALL essere
comunque RIPORTATA, senza progetto. Sparire è peggio che comparire senza
etichetta.

Una sessione senza cartella di lavoro SHALL essere SALTATA invece che attribuita
a una cartella inventata.

Le sessioni che Topics possiede già NON SHALL comparire fra quelle esterne, e
l'appartenenza SHALL essere riconosciuta per DUE vie: l'elenco delle sessioni
note, e la posizione sotto la radice delle cartelle di lavoro degli agenti — un
elenco perso non deve trasformare un agente in un estraneo. Una sessione di
terminale nuda su un checkout vero NON SHALL essere scambiata per nostra.

Il trascritto di un SOTTO-AGENTE NON SHALL contare come una sessione propria.

Lo stesso identificativo visto da due provider SHALL contare UNA volta sola, e un
provider che fallisce NON SHALL spegnere il censimento degli altri.

#### Scenario: due cartelle con un prefisso di nome in comune
- **GIVEN** una sessione in una cartella che condivide solo l'inizio del nome con un progetto
- **THEN** NON SHALL essere attribuita a quel progetto

#### Scenario: un provider che esplode
- **GIVEN** uno dei provider che solleva un errore
- **THEN** gli altri SHALL essere censiti lo stesso

### Requirement: EXTSESS-04 — Adottare una sessione la lega, ne importa la storia, e la chat resta VIVA

Adottare una sessione esterna SHALL legare il topic al progetto giusto e
IMPORTARNE la storia — messaggi e chiamate di attrezzi. Ripetere l'adozione NON
SHALL produrre doppioni.

Dopo l'adozione la chat NON SHALL essere una fotografia: i turni scritti nel
terminale sulla stessa sessione SHALL comparire in Topics. Il trascritto veniva
letto UNA volta e mai più, e la chat adottata restava ferma per sempre.

Quando il provider RIPARTE su un file NUOVO — ricopiandoci dentro la storia — la
chat adottata SHALL seguire il file nuovo. Il file vecchio non cresce più: chi
resta agganciato a quello smette di ricevere qualunque cosa, e la storia
ricopiata NON SHALL essere consegnata due volte.

Il passaggio che marca fermo un trascritto SHALL guardare solo quelli che NON si
muovono.

#### Scenario: un turno scritto nel terminale
- **GIVEN** una sessione adottata e un turno scritto fuori da Topics
- **THEN** SHALL comparire nella chat

#### Scenario: la sessione riparte su un file nuovo
- **GIVEN** una ripresa che forka il trascritto in un file nuovo
- **THEN** la chat SHALL seguire il file nuovo, senza raddoppiare la storia

### Requirement: EXTSESS-05 — Il censimento degli orfani non uccide nessuno, ed è generoso di proposito

Il censimento delle sessioni non più raggiungibili SHALL essere PURO: SHALL dire
chi SAREBBE orfano e NON SHALL agire. «Non referenziata» è un giudizio che
attraversa quattro strutture diverse, e chi agisce su un giudizio sbagliato
chiude una sessione che qualcuno stava usando.

L'ordine dei controlli SHALL mettere per primo ciò che è vero ADESSO — qualcuno
attaccato — e dopo ciò che potrebbe essere stantio. Una sessione appena aperta e
non ancora scritta nello stato dell'interfaccia SHALL essere salvata dal primo
controllo.

Un SOTTO-AGENTE NON SHALL mai essere un orfano: ha un padre, non una scheda.

Il riconoscimento di un identificativo dentro uno stato salvato SHALL essere
GENEROSO. I due errori non si equivalgono: un identificativo trovato per caso fa
risparmiare una sessione che forse era orfana, uno non trovato ne fa chiudere una
viva.

Zero orfani e zero sessioni esaminate SHALL essere distinguibili: «nessuna
orfana» e «non ho guardato» non sono la stessa risposta.

Un valore illeggibile SHALL dare nessun identificativo, mai un'eccezione.

#### Scenario: sessione attaccata ma non nello stato salvato
- **GIVEN** una sessione con qualcuno attaccato e assente dallo stato dell'interfaccia
- **THEN** NON SHALL essere dichiarata orfana

#### Scenario: nessuna sessione viva
- **GIVEN** nessuna sessione da esaminare
- **THEN** il risultato SHALL dire che zero sono state esaminate

### Requirement: EXTSESS-06 — Il livello di autonomia si scrive alla NASCITA, e un livello storto non concede niente

Un topic creato per farci lavorare un agente SHALL nascere con il proprio livello
di autonomia SCRITTO ESPLICITAMENTE, mai lasciato al ripiego della persistenza.
Correggere il livello DOPO non salva una sessione già viva: il processo figlio
nasce col regime che aveva in quel momento e ci resta fino alla propria morte.

La scrittura NON SHALL essere condizionata alla presenza di un'opzione: senza
opzione non scriveva niente e il livello cadeva su quello che ferma gli agenti,
bruciando i turni. Un chiamante SHALL comunque poter imporre un livello diverso.

Una chat UMANA NON SHALL ereditare quell'autonomia: resta il default interattivo.

Un topic creato senza rubare il fuoco NON SHALL annunciare un cambio di sessione,
e quando invece il fuoco si sposta l'ordine degli annunci SHALL essere prima la
creazione e poi lo spostamento — o l'interfaccia mette a fuoco una scheda che non
ha ancora.

Il passaggio a un topic ARCHIVIATO o INESISTENTE SHALL essere rifiutato con un
motivo distinto per i due casi.

Riconoscere una sessione come «libera» SHALL richiedere un livello NOTO: un
livello assente, vuoto o scritto storto NON SHALL mai valere come libero. Un
errore di battitura non deve poter concedere un permesso da solo.

Liberare una sessione SHALL scrivere il livello, salvarlo e ANNUNCIARLO — un
regime cambiato di nascosto lascia il selettore a schermo a dire il falso — e
SHALL toccare SOLO la sessione che l'ha chiesto. Su una sessione già libera SHALL
essere idempotente e NON SHALL fingere un cambio che non c'è stato. Senza topic
SHALL rispondere che non c'è nulla da cambiare: dire «fatto» sarebbe peggio di un
errore.

#### Scenario: un livello scritto storto
- **GIVEN** un livello di autonomia che assomiglia a quello libero ma non lo è
- **THEN** NON SHALL valere come libero

#### Scenario: liberare una sessione già libera
- **GIVEN** una sessione già al livello libero
- **THEN** NON SHALL essere salvata né annunciata di nuovo

### Requirement: EXTSESS-07 — Il trascritto si trova dove il provider lo scrive, e la ripresa può FORKARE

Il trascritto di una sessione SHALL essere localizzato costruendo il percorso
esattamente come lo costruisce il provider: OGNI carattere non alfanumerico della
cartella di lavoro SHALL diventare un separatore, uno per carattere. Non solo la
barra e il punto — anche il trattino basso, che la cartella temporanea di questo
sistema contiene: trascurarlo faceva leggere ZERO sessioni.

Cifre e maiuscole SHALL sopravvivere intatte.

Il trascritto è il registro DUREVOLE di una sessione: sopravvive al riavvio e
vive più a lungo della riga che la descrive. Quindi «questa sessione dormiente si
può ancora riprendere?» SHALL ridursi a «il suo trascritto esiste?».

Una sessione APPENA nata il cui trascritto non è ancora stato scritto SHALL
essere TENUTA: esiste una finestra di grazia, o si cancella ciò che sta per
nascere. Senza identificativo o senza cartella di lavoro la domanda è
indecidibile e la riga SHALL essere TENUTA.

**La ripresa può FORKARE.** Il provider può aprire un file NUOVO, ricopiarci
dentro la storia del precedente e proseguire lì: il vecchio smette di crescere e
chi lo segue resta fermo per sempre.

Il riaggancio SHALL avvenire sui DATI, non su una convenzione di nomi: il figlio
copia le righe del padre con i loro identificativi, quindi «il file che continua
questa sessione» è un trascritto PIÙ RECENTE, nella stessa cartella, che contiene
gli identificativi già consumati. Il punto in cui la copia finisce è il punto da
cui riprendere.

SHALL essere IGNORATO: un trascritto estraneo anche se è il più recente della
cartella; un file PIÙ VECCHIO anche se condivide gli identificativi; un
trascritto già seguito da un altro topic. Fra due candidati SHALL vincere quello
che ricopia DI PIÙ.

SHALL essere contato solo ciò che sta DENTRO i byte già consumati, e la riga
parziale in coda NON SHALL entrare nel punto di ripresa. Senza byte consumati non
c'è storia nota e NON SHALL essere agganciato niente; con il trascritto corrente
sparito NON SHALL essere indovinato niente.

La lettura SHALL FERMARSI dopo una lunga corsa di righe sconosciute — è
divergenza, non copia — e i candidati troppo grandi da scandire SHALL essere
scartati. Un candidato già rifiutato e non modificato NON SHALL essere
riesaminato.

#### Scenario: il trattino basso nel percorso
- **GIVEN** una cartella di lavoro che contiene un trattino basso
- **THEN** SHALL essere codificato come tutti gli altri caratteri non alfanumerici

#### Scenario: due candidati per la ripresa
- **GIVEN** due trascritti più recenti che ricopiano quantità diverse di storia
- **THEN** SHALL essere scelto quello che ricopia di più

### Requirement: EXTSESS-08 — La storia importata rimette insieme domanda, risposta e attrezzo

L'importazione della storia di una sessione adottata SHALL ricostruire i turni di
entrambe le parti, il ragionamento, e le chiamate di attrezzo CON il loro
risultato riappaiato.

Il riappaiamento SHALL funzionare anche quando chiamata e risultato cadono in
BLOCCHI DI LETTURA DIVERSI: il trascritto si legge a pezzi, e un attrezzo la cui
risposta arriva nel pezzo successivo resterebbe altrimenti senza esito per
sempre. Un risultato in ERRORE SHALL essere marcato tale, anche fra un blocco e
l'altro.

SHALL essere SCARTATO ciò che non è conversazione: le diramazioni dei
sotto-agenti, le righe di servizio, i tipi non riconosciuti e le righe vuote. Un
turno vuoto NON SHALL produrre una riga.

La catena dei messaggi SHALL partire dal punto indicato da chi importa; senza
indicazione il primo messaggio SHALL essere una radice.

La lettura SHALL essere PURA — testo in, righe fuori — così da essere verificabile
senza toccare il disco.

#### Scenario: attrezzo e risultato in blocchi diversi
- **GIVEN** una chiamata di attrezzo in un blocco e il suo risultato in quello dopo
- **THEN** SHALL essere riappaiati

#### Scenario: una diramazione di sotto-agente
- **GIVEN** righe appartenenti a una diramazione
- **THEN** NON SHALL entrare nella storia della chat
