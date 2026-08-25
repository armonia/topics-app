## Purpose

Come i byte attraversano il filo: dove si tagliano in righe, quando si
comprimono, e a chi arrivano. Quattro decisioni piccole che, sbagliate, si
manifestano come «l'app è lenta» o «la chat si è piantata».

## Background

IL COSTO NASCOSTO È QUADRATICO. Ripiegare uno store da 7 MB tagliando via la
riga appena letta significa ricopiare in media metà del resto per ognuna delle
~14.000 righe: decine di GB di copie per UN aggancio. È metà della firma della
raffica di «attesa scaduta» — chi aspetta non scade perché l'altro tace, scade
perché il processo che deve leggere la risposta è bloccato dentro quel ciclo.

SUL LOOPBACK NESSUNO SI ACCORGE DI NIENTE. Le stesse risposte che partono non
compresse costano zero fra due processi sulla stessa macchina e secondi di
schermo vuoto da un telefono: misurati il 14/08/2026, 5,17 MB → 1,39 MB su una
cronologia, 86 KB → 21 KB sul primo fotogramma del socket. Ed è tutto lì: il
99,5% del traffico del primo secondo sta in quattro messaggi.

E UN DELTA DI STREAMING MANDATO A TUTTI È UN DELTA MANDATO A NESSUNO IN
PARTICOLARE.

## Requirements

### Requirement: WIRE-01 — Le righe si tagliano in tempo LINEARE, e un carattere non si spezza mai a metà

Il ripiegamento di un flusso in righe SHALL essere LINEARE nella dimensione del
flusso. Ricopiare la coda residua a ogni riga SHALL essere considerato un
difetto, non un dettaglio implementativo: su uno store di alcuni megabyte
consegnato in un fotogramma solo, quel costo diventa decine di gigabyte di copie
e blocca il processo che deve rispondere ad altro.

Una riga SHALL essere emessa SOLO quando è completa. Una coda senza terminatore
NON SHALL essere emessa: non è ancora una riga. Una riga VUOTA SHALL essere
emessa come tale e NON SHALL essere saltata in silenzio.

Un carattere multi-byte spezzato fra due frammenti SHALL arrivare INTERO. Un
carattere di sostituzione dentro un carico strutturato lo rende illeggibile, e
la riga intera si perde nella gestione dell'errore senza lasciare traccia.

La frammentazione arbitraria del flusso NON SHALL cambiare il risultato:
consegnare byte per byte SHALL produrre esattamente ciò che produce un
frammento unico.

Il riavvolgimento a un punto dichiarato SHALL scartare i byte incompleti in
sospeso: appartengono a una regione che non si legge più. Senza riavvolgimento,
riagganciarsi rispedisce l'intero store e i turni vecchi ricompaiono dentro
quello nuovo.

L'offset riportato con ogni riga SHALL essere ASSOLUTO rispetto all'inizio
dichiarato, o la riadozione riparte dal punto sbagliato.

#### Scenario: un carattere a cavallo di due frammenti
- **GIVEN** un carattere multi-byte spezzato fra due consegne
- **THEN** SHALL arrivare intero, e la riga SHALL restare interpretabile

#### Scenario: molti megabyte in una consegna sola
- **GIVEN** un flusso di alcuni megabyte in un frammento unico
- **THEN** il tempo SHALL restare lineare, non quadratico

### Requirement: WIRE-02 — Si comprime SOLO quando toglie byte dalla rete, e mai a costo della correttezza

Una risposta SHALL essere compressa solo verso un interlocutore REMOTO. Verso
loopback NON SHALL essere compressa: sarebbe CPU spesa per un trasferimento già
gratuito, e questa regola SHALL vincere su qualunque altra, incluso un corpo che
si comprimerebbe quattro volte.

NON SHALL essere compresso: ciò che non ha corpo (una richiesta di sole
intestazioni, e gli stati che per definizione non portano corpo), ciò che è già
codificato da qualcun altro, e ciò che non è un carico strutturato — in
particolare uno STREAM, che comprimerlo significherebbe bufferizzarlo, cioè
spegnerlo.

La disponibilità dichiarata dal client SHALL essere riconosciuta come TOKEN, mai
come sottostringa: un nome che contiene il nostro non è il nostro, e comprimere
per lui manda byte che non sa leggere.

SHALL esistere una soglia MINIMA pari a un pacchetto di rete: sotto, comprimere
non toglie nemmeno un giro di andata e ritorno. La soglia SHALL essere LA STESSA
per il canale a richieste e per quello a messaggi, e il banco SHALL verificarlo:
due soglie separate divergono col tempo.

Una dimensione ANCORA IGNOTA NON SHALL far decidere «no»: SHALL essere decisa
sul resto e ricontrollata dopo.

Il carico compresso SHALL essere ESATTAMENTE quello di partenza una volta
riaperto. Misurare il corpo per decidere NON SHALL renderlo irrecuperabile: la
risposta piccola SHALL restare leggibile. La risposta non compressa verso
loopback SHALL tornare INTATTA.

SHALL essere dichiarata la dipendenza dalla disponibilità del client, o una
cache servirà byte compressi a chi non sa aprirli. Stato e altre intestazioni
SHALL essere conservati.

#### Scenario: il client non ha chiesto la compressione
- **GIVEN** un client che non la dichiara
- **THEN** la risposta NON SHALL essere compressa

#### Scenario: uno stream
- **GIVEN** una risposta in streaming
- **THEN** SHALL passare intatta

### Requirement: WIRE-03 — Sul socket si comprime il primo fotogramma, non l'eco di un tasto

La compressione di un singolo messaggio SHALL essere decisa PER MESSAGGIO.
Abilitare la funzione sul canale senza chiederla sul messaggio NON comprime
niente — misurato: 44.667 byte sul filo per un carico da 44.395, contro 5.423
quando è chiesta esplicitamente.

Verso loopback NON SHALL essere compresso NIENTE, qualunque sia la dimensione.

Sotto la soglia di un pacchetto NON SHALL essere compresso: su un carico di
poche decine di byte la compressione AGGIUNGE byte invece di toglierli.

Ciò che è già compresso per natura — in particolare un fotogramma di immagine
già codificato — NON SHALL essere compresso a NESSUNA dimensione: si pagherebbe
tempo di calcolo per ogni fotogramma e per ogni spettatore in cambio di quasi
niente.

L'uscita di un terminale SHALL seguire la regola della dimensione: l'eco di un
tasto o un movimento del cursore restano non compressi, un ridisegno o uno
svuotamento dello scorrimento si comprimono.

Chi chiama con una PROPRIA soglia SHALL vedersela rispettata.

#### Scenario: un fotogramma già compresso
- **GIVEN** un messaggio che porta un'immagine già codificata
- **THEN** NON SHALL essere compresso, a nessuna dimensione

#### Scenario: un messaggio minuscolo
- **GIVEN** un messaggio sotto la soglia di un pacchetto
- **THEN** NON SHALL essere compresso

### Requirement: WIRE-04 — Un delta va a chi ha quel discorso aperto, non a tutti e non solo a chi guarda

Un aggiornamento incrementale di un discorso SHALL raggiungere OGNI connessione
che ha quel discorso APERTO, anche quando sta guardando altrove: una seconda
finestra o una scheda in secondo piano NON SHALL perdere il proprio flusso.

NON SHALL essere spedito a tutte le connessioni indiscriminatamente: un delta
mandato a tutti è traffico che nessuno di quelli ha chiesto.

Una connessione che non ha ancora DICHIARATO quali discorsi tiene aperti SHALL
ricevere TUTTO: l'assenza di dichiarazione non deve poter affamare un client più
vecchio o appena collegato.

Il discorso a FUOCO SHALL essere servito anche se non compare fra quelli aperti:
è il ripiego che copre la corsa fra l'iscrizione e il primo delta.

Una connessione che dichiara di non avere NIENTE aperto e non guarda niente NON
SHALL ricevere niente.

#### Scenario: una scheda in secondo piano
- **GIVEN** una connessione con quel discorso aperto ma il fuoco altrove
- **THEN** SHALL ricevere i delta

#### Scenario: una connessione che non ha dichiarato niente
- **GIVEN** una connessione senza insieme dichiarato
- **THEN** SHALL ricevere tutto

### Requirement: WIRE-05 — Chi ha mandato questo fotogramma sono IO? La risposta non è mai «forse»

Il fotogramma di benvenuto porta l'identificativo del client da sempre, e non lo
leggeva nessuno: ogni messaggio diffuso sembrava venire da un altro, e con lo
stesso discorso aperto in più finestre l'attività propria si mostrava come
altrui.

L'identificativo SHALL essere REGISTRATO all'arrivo, e una RICONNESSIONE SHALL
SOSTITUIRLO, non affiancarlo. Una stringa VUOTA SHALL valere sconosciuto, non
identificativo valido.

Finché l'identificativo NON è noto, un fotogramma SHALL essere considerato
ALTRUI, mai proprio: sopprimere l'attività altrui prima di sapere chi si è
produrrebbe silenzio. Un fotogramma SENZA identificativo SHALL essere altrui.

Due sconosciuti NON SHALL equivalersi: un confronto ingenuo fra due assenze le
dichiara uguali e zittisce il client.

#### Scenario: il benvenuto non è ancora arrivato
- **GIVEN** un fotogramma diffuso prima di conoscere il proprio identificativo
- **THEN** SHALL essere considerato altrui

#### Scenario: due assenze
- **GIVEN** un fotogramma senza identificativo e nessun identificativo noto
- **THEN** NON SHALL essere considerato proprio

### Requirement: WIRE-06 — Il primo fotogramma non porta ciò che serve a POCHI

Lo snapshot iniziale dello stato dell'interfaccia SHALL ESCLUDERE le chiavi
PER-TASK del navigatore: viaggiavano verso OGNI client a OGNI riconnessione —
misurato sul database vivo, novantuno righe su centosettantadue e circa un terzo
del carico.

L'esclusione SHALL essere per PREFISSO, non per sottostringa: un task che si
CHIAMA come il prefisso senza esserlo SHALL restare nello snapshot.

Il filtro SHALL essere del SOLO snapshot: la lettura di una singola chiave e la
lettura di TUTTE le chiavi SHALL restare COMPLETE.

La regola scritta nella richiesta al database e quella scritta nel codice SHALL
essere GEMELLE, e il banco SHALL verificarlo.

#### Scenario: un database senza chiavi per-task
- **GIVEN** nessuna chiave esclusa presente
- **THEN** lo snapshot SHALL essere invariato

#### Scenario: la lettura di una singola chiave
- **GIVEN** una chiave esclusa dallo snapshot
- **THEN** SHALL essere servita com'era

### Requirement: WIRE-07 — Il protocollo è un REGISTRO, e la sua forma si blocca in modo LEGGIBILE

Ogni messaggio che attraversa il filo SHALL avere uno SCHEMA in un registro
condiviso, e la FORMA di quel registro SHALL essere bloccata da un banco: quali
campi sono obbligatori, quali opzionali, quali insiemi di valori sono chiusi.

Il blocco SHALL essere STRUTTURATO, non un'impronta: un'impronta dice che
qualcosa è cambiato, un confronto strutturato dice ESATTAMENTE cosa. E SHALL
leggere lo schema attraverso i suoi involucri: leggerne uno solo faceva sembrare
«cambiato» uno schema identico.

L'aggiunta di un campo SHALL essere ADDITIVA e OPZIONALE dove il protocollo deve
restare compatibile: un interlocutore più vecchio che non lo manda SHALL
continuare a essere accettato.

Il CLIENT e il SERVER SHALL usare LO STESSO registro, verificato per IDENTITÀ e
non per uguaglianza: due elenchi gemelli scritti a mano divergono, ed è così che
il server mandava sempre un campo che la copia del client non chiedeva — due
contratti, uno più lasco.

Un tipo NON registrato SHALL passare senza validazione; un ingresso che non è un
oggetto, o senza il proprio discriminatore, SHALL essere rifiutato. Gli errori
SHALL conservare il PERCORSO annidato del campo che ha fallito.

Gli insiemi chiusi SHALL essere DAVVERO chiusi, e ogni voce SHALL portare scritta
la ragione per cui è entrata.

#### Scenario: un campo aggiunto
- **GIVEN** un interlocutore più vecchio che non lo manda
- **THEN** SHALL continuare a essere accettato

#### Scenario: due elenchi gemelli
- **GIVEN** un registro ricopiato invece che condiviso
- **THEN** il banco SHALL fallire

### Requirement: WIRE-08 — Ogni tipo EMESSO ha uno schema, ogni tipo DICHIARATO è emesso

OGNI tipo di messaggio che il server EMETTE SHALL avere uno schema nel registro:
un tipo nuovo non fa MAI rumore — nessuno se ne accorge finché un client non
esplode su un carico malformato.

OGNI tipo DICHIARATO nel registro SHALL essere davvero EMESSO, o SHALL essere
elencato come DORMIENTE con una motivazione: un registro che dichiara messaggi
inesistenti fa credere che una via di sincronizzazione ci sia. L'elenco dei
dormienti NON SHALL contenere tipi tornati vivi né tipi usciti dal registro.

OGNI tipo emesso SHALL essere ASCOLTATO dal client, o motivato come non
consumato: un messaggio che nessuno ascolta è stato esattamente il difetto per
cui una connessione restava aperta per sempre e la bacheca mostrava lo stato di
prima del guasto.

Gli schemi SHALL accettare i carichi REALI, copiati dai punti che li emettono:
verificare che gli ELENCHI combacino non basta — uno schema pretendeva un campo
che l'unico emittente non mandava, e il client scartava il messaggio come
malformato. La guardia SHALL essere vista MORDERE su un campo obbligatorio
mancante.

Le scansioni SHALL essere verificate NON VUOTE su entrambi i lati.

#### Scenario: un tipo emesso senza schema
- **GIVEN** un messaggio nuovo dal server
- **THEN** il banco SHALL fallire

#### Scenario: uno schema che nessuno soddisfa
- **GIVEN** un carico reale che lo schema rifiuta
- **THEN** il banco SHALL fallire
