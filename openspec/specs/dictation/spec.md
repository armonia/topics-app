## Purpose

Dettare invece di scrivere: quali motori si provano, in che ordine, e cosa si
legge quando non ne risponde nessuno.

## Background

TRE PRESUPPOSTI CHE NELLA APP IMPACCHETTATA NON REGGONO. La prima versione
sapeva fare una cosa sola: un convertitore e un motore locale, letti per nome,
con la lingua inchiodata. Ma quei due binari stanno in una cartella che NON è
nel percorso di un processo lanciato dal Finder — il binario c'è, il server non
lo trova, e la dettatura muore con un errore di file assente. Il modello da
alcuni gigabyte andava scaricato a mano in una cartella indovinata. E chi dettava
in un'altra lingua si ritrovava trascritto nella nostra.

QUINDI LA TRASCRIZIONE È UNA CATENA, non un motore. I servizi in cima ai
confronti pubblici per primi, il motore locale come rete di sicurezza offline.
Il primo che risponde vince; chi cade passa la mano e LASCIA IL SUO MOTIVO.

E IL SILENZIO NON È VUOTO: su un audio muto un motore locale non tace, INVENTA —
tipicamente una formula da titoli di coda, con totale sicurezza.

## Requirements

### Requirement: STT-01 — La catena si risolve dalla configurazione, e ogni assenza ha il suo motivo

Un motore SHALL essere considerato disponibile quando la sua configurazione c'è,
e la catena SHALL essere l'elenco dei disponibili nell'ordine predefinito.

Senza nessuna configurazione e senza motore locale la catena SHALL essere VUOTA,
e ogni assenza SHALL portare il PROPRIO motivo: «manca la chiave» e «manca il
binario» mandano a fare due cose diverse.

Una scelta esplicita SHALL fissare i motori indicati e SOLO quelli, nell'ORDINE
scritto: chi la scrive non vuole scoprire a consuntivo di averne usato un altro.

Un nome che non esiste SHALL essere SCARTATO, non SHALL far esplodere la
risoluzione.

Il modello di UN motore SHALL potersi sovrascrivere senza toccare gli altri.

Per il motore locale i binari SHALL essere cercati anche fuori dal percorso
scarno di un processo lanciato dall'interfaccia grafica. Un percorso dichiarato
che punta al VUOTO NON SHALL essere creduto sulla parola. Fra più modelli
presenti SHALL vincere il PIÙ ACCURATO, non il primo trovato.

#### Scenario: una chiave rifiutata dal servizio non è una chiave
- **GIVEN** una chiave cloud presente nell'ambiente
- **WHEN** il servizio la rifiuta (401/403), alla sonda delle capabilities o durante una trascrizione
- **THEN** quel provider SHALL risultare non disponibile con il motivo «chiave rifiutata dal servizio (HTTP n)», la catena SHALL saltarlo, e le capabilities SHALL dichiarare il motore che trascriverà davvero

#### Scenario: niente di configurato
- **GIVEN** nessuna chiave e nessun motore locale
- **THEN** la catena SHALL essere vuota e ogni assenza SHALL avere il proprio motivo

#### Scenario: un percorso dichiarato ma inesistente
- **GIVEN** un percorso di modello che non esiste sul disco
- **THEN** il motore locale NON SHALL essere dichiarato disponibile

### Requirement: STT-02 — Chi cade passa la mano, e «non trascrive» è una frase con dentro il perché di ognuno

Il primo motore che risponde SHALL vincere, e il risultato SHALL dichiarare CHI
ha trascritto.

Una rete caduta NON SHALL essere diversa da un errore del servizio: si scende
comunque al gradino successivo.

Il motore locale SHALL essere l'ULTIMO gradino e SHALL reggere quando tutto il
resto è irraggiungibile — è la ragione per cui esiste.

Caduti tutti, l'errore SHALL portare il motivo di OGNUNO: è l'unico modo perché
«non trascrive» sia diagnosticabile invece di essere un guasto muto. Con la
catena VUOTA l'errore SHALL elencare COSA MANCA, non un fallimento generico.

Un audio oltre il tetto SHALL essere rifiutato PRIMA di spendere una chiamata a
pagamento. Il tetto SHALL essere lo STESSO per tutti i motori: altrimenti lo
stesso vocale passa da uno e viene rifiutato dal successivo a metà catena.

Un motore che non risponde entro un tempo massimo SHALL essere considerato morto
e SHALL passare la mano.

#### Scenario: chi è caduto resta scritto nel risultato
- **GIVEN** un provider che cade e uno che risponde
- **THEN** il risultato SHALL portare `attempts` con provider e motivo di ognuno dei caduti, così chi guarda legge «trascritto in locale perché X ha rifiutato la chiave» e non solo il tempo

#### Scenario: il primo cade
- **GIVEN** il primo motore che risponde con un errore
- **THEN** SHALL essere provato il successivo, e il risultato SHALL dire chi ha trascritto

#### Scenario: caduti tutti
- **GIVEN** ogni motore fallito
- **THEN** l'errore SHALL portare il motivo di ognuno

### Requirement: STT-03 — Ogni motore si chiama come vuole lui, e il rumore sul silenzio non si incolla

Le differenze fra i motori SHALL essere rispettate, non appiattite: un rifiuto
sul modello nuovo SHALL far RITENTARE quello precedente, e il risultato SHALL
dichiarare QUALE ha risposto. Un parametro al plurale su un modello che lo vuole
al singolare è un rifiuto, e mandarli ENTRAMBI lo è ugualmente.

Senza una lingua fissata SHALL essere chiesto il multilingua dove il motore lo
prevede, o una lingua viene trascritta con la fonetica di un'altra.

Diarizzazione e marcatori di eventi NON SHALL essere richiesti: chi detta non
vuole annotazioni di regia dentro al proprio testo.

Il suggerimento di dominio SHALL andare SOLO ai modelli che lo trattano come
tale: su un modello che lo tratta come inizio della trascrizione finirebbe DENTRO
il testo. Un suggerimento vuoto SHALL SPEGNERE la funzione, non mandare una
stringa vuota.

Gli artefatti che un motore locale produce SUL SILENZIO SHALL essere
riconosciuti e SHALL uscire come stringa VUOTA, non come testo da incollare. Il
riconoscimento SHALL essere per UGUAGLIANZA della trascrizione INTERA, MAI per
sottostringa: la stessa frase dentro un discorso vero è un discorso vero.

#### Scenario: silenzio
- **GIVEN** un audio muto che il motore locale riempie con un artefatto noto
- **THEN** SHALL uscire una stringa vuota

#### Scenario: la stessa frase dentro un discorso
- **GIVEN** l'artefatto come sottostringa di una trascrizione più lunga
- **THEN** NON SHALL essere toccato

### Requirement: STT-04 — Il guscio desktop DICHIARA i permessi che il client chiede

Il manifesto del guscio desktop SHALL dichiarare le chiavi d'uso per OGNI
permesso di sistema che il client richiede. La dettatura e la nota vocale non
hanno MAI funzionato nel guscio: misurato sull'applicazione installata, NESSUNA
chiave d'uso — nemmeno una. La richiesta del microfono non poteva riuscire in
nessuna versione.

Ogni chiave SHALL portare una FRASE VERA, non un segnaposto: è il testo che una
persona legge nel momento in cui decide.

Il manifesto SHALL restare VALIDO: una chiave orfana lo rompe in silenzio.

#### Scenario: il permesso del microfono
- **GIVEN** il client che lo richiede
- **THEN** il manifesto SHALL dichiararlo con una frase vera

#### Scenario: una chiave orfana
- **GIVEN** un manifesto sbilanciato
- **THEN** il banco SHALL fallire

### Requirement: STT-05 — La voce entra dove sta il cursore, e il cursore resta DOPO

Il testo trascritto SHALL essere inserito nel punto del cursore, e il cursore
SHALL restare DOPO il pezzo appena inserito: è ciò che rende ripetibile una
dettatura in due riprese, che è il modo normale di dettare una frase lunga.

NIENTE SHALL andare perso: a metà frase SHALL separare da ENTRAMBI i lati senza
mangiare la coda.

Lo spazio che il trascrittore non manda SHALL essere aggiunto in coda a del testo
esistente, e NON SHALL essere inventato in un campo vuoto. Gli spazi già presenti
NON SHALL essere raddoppiati. Un a capo SHALL valere come spazio: la voce non si
incolla alla riga di sopra.

Un cursore FUORI SCALA SHALL essere ristretto, non SHALL tagliare il testo.

#### Scenario: dettatura in due riprese
- **GIVEN** un secondo inserimento dopo il primo
- **THEN** il cursore SHALL restare dopo il pezzo appena inserito

#### Scenario: un cursore fuori scala
- **GIVEN** una posizione oltre la fine del testo
- **THEN** SHALL essere ristretta, senza tagliare niente

### Requirement: STT-06 — Le parole si vedono MENTRE si parla, e quando il filo cade non si perde niente

Lo standard di una app di dettatura è vedere il testo comparire mentre lo si
dice. La trascrizione a lotti resta la rete di sicurezza, non l'esperienza
normale: anche a 650-800 ms per una clip da cinque secondi, chi detta una frase
lunga non ha modo di accorgersi che il microfono ha sentito un'altra parola
finché non ha finito di parlare.

Il motore in diretta SHALL essere offerto SOLO quando chi trascriverebbe davvero
— la testa della catena, con la chiave verificata — sa anche farlo in streaming.
Annunciarlo e poi cadere a microfono aperto è il difetto che le capabilities
verificate esistono per togliere.

LA CHIAVE NON SHALL MAI raggiungere il client. Il socket lo apre il client, che
è il lato con il microfono, ma il permesso di connettersi SHALL essere un token
monouso emesso dal server, che SHALL rifiutare la richiesta PRIMA di spenderla
quando la chiave non è verificata.

Il testo provvisorio SHALL essere mostrato come provvisorio e NON SHALL essere
incollato nel campo: solo un segmento confermato entra nel composer, perché un
parziale è un'ipotesi che il pacchetto successivo può riscrivere.

L'AUDIO SHALL essere registrato in parallelo per tutta la durata: se il socket
non si apre, cade, o la quota è esaurita, la dettatura SHALL finire comunque nel
campo attraverso il flusso a lotti. Quando invece il motore in diretta ha
confermato almeno un segmento, quell'audio NON SHALL essere trascritto una
seconda volta a lotti: incollerebbe l'intera dettatura sotto sé stessa.

#### Scenario: il parziale mentre si parla
- **GIVEN** un motore in diretta disponibile e il microfono aperto
- **THEN** il testo provvisorio SHALL essere visibile senza entrare nel campo
- **AND** il segmento confermato SHALL entrare nel composer

#### Scenario: il socket rifiuta
- **GIVEN** un socket che non si apre (chiave, quota, rete)
- **THEN** la dettatura SHALL essere trascritta dal flusso a lotti
- **AND** l'audio registrato NON SHALL andare perso

#### Scenario: la chiave non verificata
- **GIVEN** una chiave che il servizio ha rifiutato
- **THEN** il token monouso NON SHALL essere richiesto
- **AND** la risposta SHALL dire che il motore in diretta non è in offerta
