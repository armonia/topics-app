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

### Requirement: HAPTIC-01 — La micro-vibrazione ha UNA porta, e non risale mai al gesto

La micro-vibrazione SHALL passare per una porta UNICA. Dove l'interfaccia di
vibrazione esiste, la pulsazione SHALL partire davvero; i tre livelli SHALL essere
tre DURATE diverse, e il livello predefinito SHALL essere il più leggero.

Dove quell'interfaccia NON esiste SHALL essere usato il ripiego nativo. Il
ripiego SHALL creare UN SOLO elemento per quante volte lo si chiami, e NON SHALL
lasciare lo stato sporco: dopo lo scatto SHALL essere spento. Fuori da quella
piattaforma NON SHALL nascere nessun elemento.

**Se la piattaforma SOLLEVA, l'eccezione NON SHALL risalire al gesto**: una
vibrazione mancata non è un motivo per non premere un bottone.

#### Scenario: la piattaforma solleva
- **GIVEN** un'interfaccia di vibrazione che lancia
- **THEN** il gesto SHALL completarsi comunque

#### Scenario: dieci chiamate al ripiego
- **GIVEN** dieci invocazioni consecutive sul ripiego nativo
- **THEN** SHALL esistere un solo elemento

### Requirement: SAFEAREA-01 — Sugli schermi con gli angoli tondi la fila segue l'ARCO, non una regola inventata

Il raggio dello schermo SHALL essere DEDOTTO dalla fascia sicura quando non è
dichiarato, e SHALL essere ZERO dove la fascia non c'è: uno schermo squadrato non
ha un arco da seguire. Un raggio DICHIARATO SHALL battere la stima; uno dichiarato
non valido NO.

L'alzata dovuta all'arco SHALL essere massima sul bordo e nulla alla fine
dell'arco, SHALL essere MONOTONA con la distanza dal bordo, e a metà raggio SHALL
valere la corda del cerchio, non la metà del raggio. Con raggio zero SHALL essere
sempre zero.

Un angolo TONDO SHALL pagare MENO o quanto un angolo appuntito a ogni distanza, e
un angolo tondo quanto l'arco NON SHALL pagare niente — è lo stesso cerchio. Fuori
dall'arco NESSUNO SHALL essere alzato.

Il pavimento della fila SHALL essere un MINIMO, non un addendo: NON SHALL mai
scendere sotto il respiro standard, nemmeno con una fascia sottile, e con una
fascia piena SHALL abitare la banda.

Il raggio esterno SHALL essere CONCENTRICO a quello dello schermo meno il gioco
DENTRO l'arco, standard FUORI dall'arco — è ciò che tiene squadrato quello in
mezzo — con la MEZZA ALTEZZA come tetto, e NON SHALL MAI scendere sotto lo
standard.

Nella fila risultante gli estremi SHALL salire e quello in mezzo SHALL restare sul
pavimento; la curva SHALL stare agli estremi e MAI in mezzo, su qualunque
larghezza; l'alzata SHALL essere misurata sull'angolo ESTERNO e non sul centro; e
NESSUNA scatola SHALL finire sotto il pavimento.

Su uno schermo squadrato la fila SHALL essere DRITTA e tutta standard, senza rami
dedicati.

#### Scenario: uno schermo squadrato
- **GIVEN** nessuna fascia sicura
- **THEN** la fila SHALL essere dritta e tutta standard

#### Scenario: un angolo tondo a filo del bordo
- **GIVEN** una scatola con angolo tondo sul bordo
- **THEN** SHALL pagare meno di una con angolo appuntito

### Requirement: HOVERTOUCH-01 — Un comando dietro il passaggio del mouse, col dito NON esiste

Nove file scrivevano a mano la coppia di classi che nasconde un comando finché il
mouse non ci passa sopra. È una classe che la libreria mette dentro una regola
condizionata alla presenza di un puntatore: su un dispositivo SENZA puntatore non
si accende MAI. Quindi il comando non è «meno visibile»: NON ESISTE.

Il contesto della prova SHALL essere davvero SENZA puntatore, o la prova non
misura niente.

Ogni comando nascosto dietro il passaggio del mouse SHALL essere RAGGIUNGIBILE
col dito — tenendo premuto, o da un menu.

**Nessun bersaglio INVISIBILE SHALL restare cliccabile**: un elemento a opacità
zero che riceve i gesti è peggio di uno assente, perché ruba il gesto a ciò che
sta sotto.

#### Scenario: un dispositivo senza puntatore
- **GIVEN** il contesto senza puntatore
- **THEN** ogni comando nascosto SHALL essere raggiungibile col dito

#### Scenario: un elemento a opacità zero
- **GIVEN** un comando non visibile
- **THEN** NON SHALL ricevere i gesti

### Requirement: FINGER-01 — Il dito COMANDA: il cassetto sta dove sta il dito

Segnalato dal telefono: il cassetto non seguiva bene lo scorrimento del dito, e
durante lo scorrimento le tessere fissate facevano scatti.

In APERTURA il bordo del cassetto SHALL essere DOVE È IL DITO, per tutta la
corsa. In CHIUSURA la colonna SHALL scorrere col dito e andarsene con lui.

AL RILASCIO SHALL decidere il GESTO, non la posizione: una corsa BREVE e LENTA
NON SHALL aprire niente.

Le tessere fissate NON SHALL scattare mentre la colonna scorre, nemmeno con un
ridisegno a metà corsa.

#### Scenario: una corsa breve e lenta
- **GIVEN** un gesto che non esprime l'intenzione di aprire
- **THEN** il cassetto NON SHALL aprirsi

#### Scenario: un ridisegno durante lo scorrimento
- **GIVEN** un aggiornamento a metà gesto
- **THEN** le tessere SHALL restare dove sono

### Requirement: PINDRAG-01 — Col dito si fissa e si sfissa, perché i gesti del mouse lì non esistono

Segnalato dal telefono: non si riusciva a fissare né a sfissare una tessera col
trascinamento. Non era un difetto solo: su quella piattaforma gli eventi di
trascinamento del mouse NON vengono MAI emessi da un tocco, quindi il gesto non
poteva funzionare per costruzione.

Il confine fra la lista e la griglia dei fissati SHALL essere attraversabile COL
DITO nei due versi: una tessera trascinata sulla lista SHALL perdere il
fissaggio, e una riga trascinata dentro la griglia SHALL prenderlo.

#### Scenario: una tessera trascinata col dito sulla lista
- **GIVEN** un gesto tattile
- **THEN** SHALL perdere il fissaggio

#### Scenario: una riga trascinata col dito nella griglia
- **GIVEN** un gesto tattile
- **THEN** SHALL prendere il fissaggio

### Requirement: SIDETOUCH-01 — La colonna, misurata COL DITO

Tutto il resto della suite gira a schermo largo con un mouse: in ogni altra prova
il contesto NON è tattile, quindi la pressione prolungata, il menu completo, i
bersagli allargati e la seconda riga sotto il nome non avevano UNA riga di
copertura.

La colonna, la fascia e il piano delle pane SHALL essere lo STESSO pixel: tre
superfici che dovrebbero combaciare e non combaciano si vedono come una crepa.

Tutte le righe SHALL avere la STESSA altezza — quella del dito — e lo stesso
bordo sinistro.

A sessione ferma, sotto il nome, SHALL esserci la seconda riga dichiarata.

Tenendo premuto SHALL aprirsi il menu COMPLETO, non un suo sottoinsieme: un menu
ridotto col dito è un comando che sparisce su un dispositivo intero.

Col dito il comando dei tre puntini NON SHALL esserci: la pressione prolungata è
il suo posto.

OGNI bersaglio col dito SHALL colpire SÉ STESSO — un bersaglio allargato che
copre il vicino è peggio di uno piccolo.

Il gesto SHALL chiedere la micro-vibrazione, senza elementi di servizio nascosti
nella pagina.

In alto SHALL esserci SOLO il titolo, e i comandi SHALL stare nella fila in
fondo, dove il pollice arriva.

Tenendo premuto SHALL sollevarsi una tessera, e trascinandola SHALL riordinarsi.

#### Scenario: la pressione prolungata su una riga
- **GIVEN** il contesto tattile
- **THEN** SHALL aprirsi il menu completo

#### Scenario: i bersagli allargati
- **GIVEN** righe adiacenti
- **THEN** ogni bersaglio SHALL colpire sé stesso
