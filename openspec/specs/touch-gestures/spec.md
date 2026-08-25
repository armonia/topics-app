## Purpose

I gesti del dito: quelli che il sistema operativo si prende e noi vogliamo
indietro, quelli che valgono due volte quando dovrebbero valere una, e i comandi
che su un telefono non esistono affatto.

## Background

UN COMANDO CHE SI SCOPRE COL PASSAGGIO DEL MOUSE, SU UN TELEFONO, NON È «MENO
VISIBILE»: È IRRAGGIUNGIBILE. La stessa riga di stile era ricopiata a mano in
nove file, e il caso peggiore era un comando distruttivo da 14×14 pixel
appiccicato al bordo di una riga il cui tocco fa tutt'altro — un bersaglio
fantasma, invisibile e cliccabile.

UN DITO SOLO NON DEVE FARE DUE COSE. Chiudere un pannello toccando fuori non
deve anche cambiare scheda, aprire un discorso, archiviare una riga.

E DUE COSE LE PRENDE IL SISTEMA: lo scorrimento dal bordo, che nella app
installata torna indietro nella cronologia invece di aprire il cassetto, e
l'ingrandimento automatico al fuoco su un campo, che non torna più da solo.

## Requirements

### Requirement: GESTURE-01 — Il gesto dal bordo è nostro, e bloccarlo non deve mangiarsi il comando che c'era sotto

Un tocco che comincia entro una fascia stretta dal bordo SHALL essere trattenuto:
nella app installata quel gesto torna indietro nella cronologia, e contende col
cassetto e con l'apertura di un collegamento.

La fascia SHALL essere abbastanza larga da coprire il gesto e abbastanza stretta
da non mangiarsi mezza colonna.

Trattenere il gesto NON SHALL far sparire il comando che stava sotto il dito: se
sotto c'era un comando, SHALL essere rimesso in scena. Se sotto non c'era niente
di azionabile, NON SHALL essere inventato nessun clic.

Un campo di testo trattenuto SHALL riavere il FUOCO, o resta bloccato senza
tastiera.

I comandi di SISTEMA — quelli che aprono un pannello nativo — SHALL restare
fuori: su di essi un clic sintetico non apre niente, e fingere di rimetterli in
scena è peggio che non farlo.

Nessun elemento sotto il dito SHALL essere comunque bordo: il gesto va trattenuto
lo stesso.

Un tocco che si muove oltre una tolleranza, o che dura oltre un tetto, NON SHALL
essere un tocco: è uno scorrimento o una pressione lunga.

#### Scenario: il bordo, sopra un comando
- **GIVEN** un tocco entro la fascia di bordo sopra un comando
- **THEN** il gesto SHALL essere trattenuto e il comando SHALL essere rimesso in scena

#### Scenario: in mezzo allo schermo
- **GIVEN** un tocco lontano dal bordo
- **THEN** NON SHALL essere trattenuto niente

### Requirement: GESTURE-02 — Il gesto che chiude NON fa anche l'altra cosa

Quando un tocco FUORI da un pannello lo chiude, il clic che quel tocco genera
SHALL essere mangiato: chiudere e agire su ciò che c'era sotto sono due effetti,
e il dito è uno solo.

SHALL essere mangiato IL PROSSIMO clic e SOLO quello: il gesto successivo
dell'utente è un gesto suo.

La guardia SHALL DISARMARSI DA SOLA dopo un tetto di tempo: se il clic atteso non
arriva più, restare armata significa mangiare, prima o poi, un clic che non
c'entra niente.

Consumato il clic, l'attesa SHALL essere annullata: nessun temporizzatore
appeso.

Due armamenti per lo STESSO dito — il gesto arriva da più eventi — SHALL lasciare
UNA guardia sola.

Il disarmo esplicito SHALL essere idempotente.

#### Scenario: chiudo toccando fuori
- **GIVEN** un pannello chiuso da un tocco fuori
- **THEN** il clic sottostante NON SHALL essere eseguito

#### Scenario: il clic non arriva mai
- **GIVEN** una guardia armata e nessun clic
- **THEN** SHALL disarmarsi da sola

### Requirement: GESTURE-03 — Un comando che si scopre col puntatore, senza puntatore, o si vede o non c'è

Il modo di scoprire un comando al passaggio del mouse SHALL essere UNO SOLO e
condiviso: scritto a mano in ogni schermata, diverge, e le divergenze sono
bersagli fantasma.

Dove c'è un puntatore, il comando SHALL comparire al passaggio e NON SHALL MAI
avere gli eventi del puntatore spenti: sarebbe visibile e morto.

Dove NON c'è un puntatore, il comando SHALL sparire DAVVERO — invisibile E non
raggiungibile — oppure SHALL essere mostrato stabilmente. Ciò che NON SHALL
esistere è il caso intermedio: trasparente e ancora cliccabile, cioè un comando
distruttivo che si colpisce alla cieca.

NESSUNA combinazione di gruppo, tocco e presenza del puntatore SHALL produrre un
elemento trasparente e sensibile al tocco, e questo SHALL essere verificato su
TUTTA la matrice, non su un caso.

Un comando raggiungibile solo così NON SHALL essere l'unico percorso per
un'azione: dove non esiste un'altra strada, SHALL essere mostrato.

L'area di tocco NON SHALL essere allargata verticalmente su righe contigue
basse: proietterebbe aree sovrapposte, e vincerebbe l'ultima scritta nel
documento — cioè quella sbagliata.

#### Scenario: senza puntatore
- **GIVEN** un dispositivo senza puntatore
- **THEN** il comando SHALL essere invisibile E non colpibile, oppure mostrato

#### Scenario: tutta la matrice
- **GIVEN** ogni combinazione di gruppo, tocco e puntatore
- **THEN** nessuna SHALL lasciare un elemento trasparente e cliccabile

### Requirement: GESTURE-04 — La pagina non resta ingrandita dopo che hai toccato un campo

L'ingrandimento automatico al fuoco su un campo SHALL essere ANNULLATO: non
torna indietro da solo, e la pagina resta scalata.

Riscrivere la direttiva dello zoom SHALL toccare SOLO quella: ogni altra
direttiva SHALL sopravvivere, e l'ORDINE SHALL restare quello di partenza.

Un ciclo di rilascio e ri-blocco SHALL riprodurre ESATTAMENTE la riga iniziale.

Se la direttiva NON C'È, SHALL essere AGGIUNTA: un non-fare silenzioso lascia il
difetto in piedi.

Spaziature storte e separatori finali SHALL essere tollerati senza generare
pezzi vuoti.

Una direttiva il cui nome CONTIENE quello cercato NON SHALL essere scambiata per
esso.

Una scala SHALL essere considerata «uno» entro una tolleranza: i motori
restituiscono valori appena sopra l'unità e confrontarli per uguaglianza esatta
fa ripartire il rimedio all'infinito. Il tetto momentaneo usato per rilasciare
SHALL essere un valore DIVERSO da quello a regime, o il ripristino non ha un
punto di riferimento.

#### Scenario: le altre direttive
- **GIVEN** una riga con più direttive
- **THEN** SHALL cambiare solo quella dello zoom, nell'ordine originale

#### Scenario: andata e ritorno
- **GIVEN** un rilascio seguito da un ri-blocco
- **THEN** la riga SHALL tornare identica

### Requirement: GESTURE-05 — Un menu ancorato sta DENTRO la finestra, e non si riduce a una fessura

La posizione di un pannello ancorato SHALL essere calcolata in UN SOLO posto:
ogni schermata che se la ricava per conto suo produce un blocco leggermente
diverso, e almeno una di quelle varianti non si ribalta affatto.

Il pannello SHALL aprirsi dal lato che LO CONTIENE, e SHALL RIBALTARSI quando
sotto non c'è posto invece di restare tagliato dal bordo.

SHALL essere trattenuto entro i margini della finestra su ENTRAMBI i lati
orizzontali, e un pannello PIÙ LARGO della finestra SHALL appoggiarsi al margine
invece di finire a coordinate negative.

Con allineamento a destra il bordo destro SHALL coincidere con quello
dell'ancora, ma il margine SHALL vincere lo stesso vicino al bordo opposto.

Il tetto dell'altezza SHALL riflettere lo spazio REALE del lato SCELTO — non di
quello scartato dopo il ribaltamento — e NON SHALL superare la finestra meno i
due margini.

SHALL esistere un'altezza MINIMA sotto la quale il pannello SCORRE invece di
rimpicciolirsi: misurato sul difetto vero, lo spazio residuo dava un tetto più
basso della singola intestazione della lista, cioè ZERO righe visibili. Quel
minimo SHALL essere un PAVIMENTO e non un tetto: dove lo spazio è maggiore, vince
lo spazio.

#### Scenario: non c'è posto sotto
- **GIVEN** un'ancora vicina al bordo inferiore
- **THEN** il pannello SHALL ribaltarsi, e il tetto SHALL essere quello del lato scelto

#### Scenario: spazio ridicolo
- **GIVEN** uno spazio residuo inferiore al minimo
- **THEN** il pannello SHALL scorrere, non ridursi a una fessura
