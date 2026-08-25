
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
