
## Purpose

Lo schema del database e il codice che lo usa devono dire la STESSA cosa — e
quando divergono, deve accorgersene un banco, non un utente.

## Background

TRE MODI DI DIVERGERE, TUTTI GIÀ SUCCESSI. Una migration scritta sul disco e non
rigenerata nel manifest incorporato: la app impacchettata parte con uno schema
più vecchio del codice. Un vincolo che enumera dei valori e una costante nel
codice che ne enumera altri: il codice offre una scelta che il database rifiuta.
E una definizione di tabella riscritta a mano per i test: il banco verifica un
database che non esiste in produzione, e resta verde su una colonna che là non
c'è.

LA REGOLA È SEMPRE LA STESSA: la fonte è la migration, tutto il resto ne DERIVA,
e la derivazione si verifica parola per parola.

## Requirements

### Requirement: SCHEMA-01 — Il manifest incorporato corrisponde al disco uno a uno

Il manifest delle migration incorporato nel pacchetto SHALL coprire OGNI
migration presente sul disco: una che manca è uno schema più vecchio del codice
che lo usa, e si manifesta solo nella app impacchettata.

La corrispondenza SHALL essere UNO A UNO su versione, nome e CONTENUTO: un
manifest che ha i nomi giusti e il testo vecchio è peggio di uno incompleto,
perché non lo dichiara.

Ogni migration SHALL comparire UNA volta sola, e il numero dichiarato SHALL
essere quello del suo nome: un doppione o un numero fuori posto cambia l'ordine
di applicazione.

Il fallimento SHALL dire di RIGENERARE: è un passo dimenticato, non un difetto
da diagnosticare.

#### Scenario: una migration nuova sul disco
- **GIVEN** una migration non ancora rigenerata nel manifest
- **THEN** il banco SHALL fallire, indicando la rigenerazione

#### Scenario: stesso nome, testo diverso
- **GIVEN** una voce del manifest il cui contenuto non corrisponde al disco
- **THEN** il banco SHALL fallire

### Requirement: SCHEMA-02 — I valori ammessi dal vincolo sono ESATTAMENTE quelli dichiarati dal codice

L'insieme dei valori enumerati da un vincolo del database SHALL coincidere
ESATTAMENTE con l'insieme dichiarato nel codice: né uno in più né uno in meno.
Uno in più nel codice è una scelta che l'utente vede e che l'inserimento
rifiuta; uno in meno è una riga che esiste e che il codice non sa leggere.

OGNI valore dichiarato SHALL essere davvero inseribile — verificato inserendo,
non ispezionando il testo del vincolo.

Un valore FUORI elenco SHALL essere ancora RIFIUTATO dal vincolo: la verifica di
completezza non deve poter passare allargando il vincolo.

L'insieme creabile dall'interfaccia SHALL essere un SOTTOINSIEME di quello
persistibile: si può conservare qualcosa che l'interfaccia non crea, non il
contrario.

Il riconoscitore di quei valori NON SHALL sollevare su un ingresso che non è
nemmeno una stringa: arriva dal filo, e là dentro c'è di tutto.

#### Scenario: un valore in più nel codice
- **GIVEN** una costante che elenca un valore assente dal vincolo
- **THEN** il banco SHALL fallire

#### Scenario: un valore fuori elenco
- **GIVEN** un inserimento con un valore non enumerato
- **THEN** SHALL essere rifiutato dal vincolo

### Requirement: SCHEMA-03 — La definizione usata dai test DERIVA dalla migration, parola per parola

La definizione di tabella usata dai banchi NON SHALL essere riscritta a mano:
SHALL essere la stessa della migration, PAROLA PER PAROLA. Una copia scritta a
mano diverge in silenzio, e da quel momento il banco verifica un database che in
produzione non esiste.

Dove una tabella è stata modificata da più migration successive, la definizione
di test SHALL essere la CATENA di quelle migration, non la prima.

SHALL essere verificato che NESSUNA colonna manchi e NESSUNA sia di troppo, e
che ogni colonna porti TIPO e VINCOLI della migration: una colonna presente ma
senza il suo vincolo lascia passare nel banco esattamente ciò che in produzione
verrebbe rifiutato.

#### Scenario: una colonna aggiunta da una migration successiva
- **GIVEN** una tabella modificata da più migration
- **THEN** la definizione di test SHALL riflettere la catena completa

#### Scenario: un vincolo perso nella copia
- **GIVEN** una colonna con tipo giusto e vincolo mancante
- **THEN** il banco SHALL fallire

### Requirement: SCHEMA-04 — Il database NASCE dal nulla, e la catena si prova dal vuoto

L'intera catena delle migration SHALL essere applicabile, IN ORDINE, a un
database VUOTO. Una migration che riferisce qualcosa che non esiste ferma la
catena, e su un'INSTALLAZIONE NUOVA il server muore prima di mettersi in
ascolto — mentre su una macchina già migrata non succede niente.

L'ordine dichiarato SHALL essere CRESCENTE e le versioni NON SHALL ripetersi.

Il database nato dal nulla SHALL avere le tabelle che il prodotto usa davvero: la
verifica NON SHALL fermarsi al «nessun errore».

Il fallimento SHALL NOMINARE la migration colpevole.

#### Scenario: una migration che riferisce una colonna inesistente
- **GIVEN** la catena applicata a un database vuoto
- **THEN** SHALL fallire, nominando la migration

#### Scenario: due versioni uguali
- **GIVEN** un numero di versione ripetuto
- **THEN** il banco SHALL fallire

### Requirement: SCHEMA-05 — La chiave di una migration è il NOME, e il prefisso è un ISTANTE

Il registro delle migration applicate SHALL essere indicizzato per NOME del file,
non per numero: con la chiave sul numero, la seconda migration con lo stesso
numero veniva SALTATA in silenzio, per sempre — ed è successo davvero, con due
file allo stesso numero scritti su due rami tagliati prima che l'altro atterrasse.

Due migration con lo stesso numero SHALL applicarsi ENTRAMBE, e a parità di
numero l'ordine SHALL essere deciso dal NOME — deterministico a ogni avvio e su
ogni macchina.

Un secondo avvio NON SHALL riapplicare niente, e un database con la VECCHIA forma
del registro SHALL essere CONVERTITO senza riapplicare nulla. Le migration che si
registrano da sole con una forma abbreviata NON SHALL lasciare doppioni.

Il prefisso di una migration NUOVA SHALL essere un ISTANTE, non un contatore: col
contatore due agenti in parallelo collidono sempre — misurato, tre volte in una
notte dopo due il giorno prima. Un file nuovo col contatore SHALL essere
RIFIUTATO anche quando il numero è LIBERO, o il verde arriva e diventa rosso solo
all'atterraggio.

Lo STESSO istante da due copie di lavoro NON SHALL essere una collisione: l'ordine
resta deciso dal nome. Il generatore SHALL scansare solo i propri duplicati
LOCALI.

Il cancello SHALL essere visto ROSSO su un repository di prova con una collisione
vera, e VERDE appena il file nuovo prende il prefisso a istante. Una base non
risolvibile SHALL uscire con un errore, non con un verde a vuoto.

#### Scenario: due migration con lo stesso numero
- **GIVEN** un numero duplicato
- **THEN** SHALL applicarsi entrambe, in ordine di nome

#### Scenario: un file nuovo col contatore su un numero libero
- **GIVEN** nessuna collisione ma il vecchio schema di nome
- **THEN** SHALL essere rifiutato

### Requirement: SCHEMA-06 — Una migration di DATI porta il valore VIVO dall'altra parte

Una migration che SPOSTA un valore da una parte all'altra SHALL portare il valore
VIVO: se non arriva, ogni installazione che aveva quella funzione ACCESA si
risveglia SPENTA — e non se ne accorge nessuno finché qualcuno non va a vedere
perché il lavoro non parte più.

Lo stato ACCESO SHALL restare acceso e quello SPENTO spento — sono due casi, non
uno.

Ciò che non era oggetto dello spostamento SHALL sopravvivere: si toglie una
colonna, non i dati.

In ASSENZA della riga di partenza NON SHALL essere inventato un valore ACCESO:
l'errore opposto manderebbe lavoro vero su una macchina dove nessuno l'aveva
chiesto.

Una migration che CLASSIFICA delle righe esistenti SHALL essere verificata su
entrambe le classi, e i valori che SEMBRANO scelti da una persona ma sono
predefiniti generati dal prodotto SHALL essere riconosciuti come predefiniti — o
la rinomina automatica non toccherà più niente.

#### Scenario: la funzione era accesa
- **GIVEN** un valore vivo prima della migration
- **THEN** SHALL essere lo stesso dopo

#### Scenario: la riga di partenza non c'è
- **GIVEN** nessun valore da spostare
- **THEN** NON SHALL risultare acceso

### Requirement: SCHEMA-07 — Una migration si prova ESEGUENDO il file, e si verifica anche ciò che NON tocca

Ogni migration di rilievo SHALL essere provata ESEGUENDO il file SQL VERO — mai
una riscrittura — su un database costruito dalle migration precedenti REALI. Una
copia riscritta prova la copia.

Il banco SHALL verificare anche ciò che la migration NON deve toccare: le righe di
un'altra forma, i dati storici, l'ordine, i contenuti. È metà del contratto, e la
metà che si dimentica.

Dove la migration crea un INDICE, SHALL essere verificato che il pianificatore lo
USI davvero: che esista non basta.

Dove la migration può essere rieseguita, SHALL essere verificato che la seconda
esecuzione non duplichi né cambi niente.

Ogni migration di bonifica SHALL portare la propria GUARDIA contro il verde a
vuoto: il conteggio esatto delle righe toccate, o il banco non distingue «ha
funzionato» da «non ha fatto niente».

Dove il criterio è un confronto sul TESTO, SHALL esistere il caso della CODA
BUGIARDA: un contenuto che somiglia al criterio senza esserlo NON SHALL essere
toccato.

#### Scenario: un indice nuovo
- **GIVEN** la migration applicata
- **THEN** il pianificatore SHALL usarlo, non solo trovarlo

#### Scenario: un contenuto che somiglia al criterio
- **GIVEN** una riga che contiene letteralmente il testo cercato senza esserlo
- **THEN** NON SHALL essere toccata

### Requirement: COMPRESS-01 — La compressione dei messaggi NON può perdere un messaggio

La riscrittura compressa dei blocchi e delle chiamate riguarda la tabella che
contiene le CONVERSAZIONI: un difetto qui non si vede subito e non si torna
indietro.

Ogni colonna SHALL essere RILETTA e confrontata con l'originale PRIMA di essere
sostituita. Un blocco tipico SHALL tornare IDENTICO, e pesare meno.

Una stringa SOTTO la soglia NON SHALL essere toccata e SHALL restare sé stessa, e
il CONFINE della soglia NON SHALL perdere niente in nessuno dei due versi.

Dati NON comprimibili NON SHALL essere corrotti, anche quando non ci si guadagna
niente: «non ci guadagno» e «lo rompo» sono due esiti diversi.

#### Scenario: dati incomprimibili
- **GIVEN** una colonna che non si comprime
- **THEN** SHALL restare leggibile e identica

#### Scenario: il confine della soglia
- **GIVEN** una stringa esattamente sulla soglia
- **THEN** NON SHALL perdere niente
