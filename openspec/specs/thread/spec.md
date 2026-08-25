## Purpose

Il filo di una card: chi ci scrive, con che voce, e cosa succede quando la
stessa cosa va detta di nuovo. È il posto dove il lavoro di un agente diventa
leggibile da una persona — e, per la stessa ragione, il posto dove una riga
ripetuta trecento volte rende illeggibile tutto il resto.

## Background

IL FILO NON È FATTO DI COMMENTI. Al 25/08/2026 le 16.356 righe si dividono in
quattro specie e solo la prima è quello che un lettore chiamerebbe un commento:
`comment` (6.851), `status` (6.831), `service` (2.453), `review-note` (221). Gli
autori dicono la stessa cosa da un'altra angolazione: `system` ne scrive 6.590,
`user` 3.403, `dispatcher` 1.565. Un filo in cui la macchina parla il doppio
delle persone funziona solo se le due voci si distinguono da fuori — e la specie
è ciò che le distingue.

DUE DOMANDE SEPARATE, e confonderle è il difetto che questa capability descrive:
«questa riga va DETTA?» e «questa riga va SCRITTA DI NUOVO?». La prima ha per
risposta un cancello (chi sveglia un agente e a quali condizioni); la seconda ha
per risposta uno SLOT — la riga nuova prende il posto della vecchia invece di
accodarsi. Senza slot, una nota di servizio che si rigenera a ogni passata
diventa centootto copie della stessa frase su dodici card in quattro ore, che è
un numero misurato il 18/08/2026.

UNA COSA CHE SUCCEDE UNA VOLTA SI CONTA UNA VOLTA. Le colonne
`interrupt_claimed_at`, `nudge_claimed_at`, `nudge_fingerprint` e `nudge_repeats`
esistono tutte per la stessa ragione: due strade che osservano lo stesso
avvenimento — l'utente che ferma un turno, il dispatcher che se ne accorge —
devono poterlo RIVENDICARE, così che la seconda trovi il posto occupato invece
di raccontarlo una seconda volta.

## Requirements

### Requirement: THREAD-01 — Un'interruzione si rivendica, e la rivendicazione si legge sul task

Quando un turno viene fermato, la riga che lo racconta SHALL essere scritta UNA
volta sola anche se più processi se ne accorgono. Il sistema SHALL offrire una
RIVENDICAZIONE: chi arriva per primo scrive, chi arriva dentro la finestra trova
il posto occupato e NON scrive.

La rivendicazione SHALL essere letta dalla riga del task e non da uno stato in
memoria. Chi arriva terzo è quasi sempre un processo NUOVO — è appena ripartito,
ed è esattamente il motivo per cui sta scrivendo: la memoria gli direbbe che il
campo è libero.

La NOTA SHALL essere scritta PRIMA del campo. Se la scrittura fallisce il campo
deve restare libero per chi viene dopo, invece di zittirlo su una riga che non è
mai comparsa.

Una nota vuota o fatta di soli spazi NON SHALL rivendicare niente.

#### Scenario: due processi si accorgono della stessa interruzione
- **GIVEN** un turno fermato, e due osservatori che vogliono raccontarlo
- **THEN** SHALL comparire una riga sola
- **AND** il secondo osservatore SHALL ricevere «niente da scrivere», non un errore

#### Scenario: la finestra è scaduta
- **GIVEN** una rivendicazione più vecchia della finestra
- **THEN** una nuova interruzione SHALL poter essere raccontata di nuovo

#### Scenario: niente da dire
- **GIVEN** una nota vuota
- **THEN** NON SHALL essere scritto niente e NON SHALL essere rivendicato niente

### Requirement: THREAD-02 — Il cancello del sollecito accorcia il testo, e non spegne mai il turno

Quando un turno riparte da solo — una continuazione, non una risposta umana — il
sistema SHALL fargli attraversare un cancello che decide COME dirlo, e mai SE
riaccenderlo. Il turno riparte comunque: il cancello governa il testo, non
l'esecuzione. Un cancello che potesse spegnere una ripresa sarebbe un modo nuovo
per perdere un task.

Il testo intero SHALL essere sostituito da una riga corta e NUMERATA quando tre
condizioni valgono insieme: c'è una rivendicazione leggibile, è più giovane della
finestra, e il testo ha la STESSA impronta di quella rivendicata. Un testo
diverso SHALL passare intero e SHALL diventare lui il nuovo rivendicatore.

La finestra SHALL essere ANCORATA alla prima rivendicazione e non scorrevole:
riprese fitte la terrebbero altrimenti aperta per sempre, e un task che riparte
spesso smetterebbe di dire qualunque cosa.

La rivendicazione SHALL vivere sulla riga del task e mai in memoria di processo,
per la stessa ragione dell'interruzione: chi scrive per terzo è quasi sempre un
processo appena riavviato.

Il cancello SHALL essere PER CARD: due task interrotti dallo stesso riavvio non
si zittiscono a vicenda.

Una scrittura della rivendicazione che fallisce NON SHALL zittire il sollecito:
la ripresa vale più del cancello, e al massimo si ripete.

Una risposta UMANA NON SHALL attraversare il cancello.

Un testo vuoto NON SHALL rivendicare niente.

> Scritto dal caso, non dall'ipotesi: il 19/08/2026 su `topic:7d043b7e` sono
> uscite quattro copie identiche dello stesso paragrafo in novanta secondi.

#### Scenario: quattro riprese in un minuto e mezzo
- **GIVEN** un task che riparte quattro volte con lo stesso testo dentro la finestra
- **THEN** SHALL comparire un paragrafo intero e tre righe corte numerate
- **AND** ognuna delle tre SHALL essere più corta dell'intero

#### Scenario: un testo diverso
- **GIVEN** una ripresa dentro la finestra con un testo di impronta diversa
- **THEN** SHALL passare intero, e SHALL diventare la nuova rivendicazione

#### Scenario: finestra a zero
- **GIVEN** una finestra di durata nulla
- **THEN** ogni sollecito SHALL passare intero: il cancello è disarmato, non invertito

#### Scenario: una rivendicazione illeggibile
- **GIVEN** una rivendicazione il cui istante non si legge
- **THEN** il cancello SHALL aprirsi, e il testo intero SHALL passare

### Requirement: THREAD-03 — Quattro specie, e la specie decide chi si sveglia

Ogni riga del filo SHALL portare una SPECIE fra quattro: `comment`, `status`,
`review-note`, `service`. La specie SHALL essere marcata ALLA FONTE, da chi
scrive, e NON SHALL essere dedotta dal testo.

La lettura SHALL whitelistare le specie note e far cadere ogni altra su
`comment`. Il fallback SHALL essere silenzioso e mai una riga nascosta: un
lettore che non conosce una specie deve vedere comunque la riga.

Solo un `comment` scritto da una PERSONA SHALL svegliare l'agente. Una
`review-note` è evidenza scritta dalla macchina e NON SHALL far ripartire un
turno; uno `status` è una transizione e non è parola di nessuno.

I conteggi SHALL seguire la specie: «quanti messaggi ho mandato» conta solo i
`comment` di una persona; `status` e `service` NON SHALL mai valere come
l'ultima parola di un turno.

Le righe di servizio consecutive SHALL potersi piegare in una sola nel filo, e
`status` e `review-note` NON SHALL piegarsi mai — sono le due che si leggono.

> Il fallback silenzioso non è teorico: aggiungere `service` al tipo senza
> aggiungerlo alla whitelist di lettura l'ha fatto tornare `comment` da tredici
> punti di scrittura, e al client non è mai arrivato.

#### Scenario: una specie sconosciuta su disco
- **GIVEN** una riga con una specie che il codice non conosce
- **THEN** SHALL essere letta come `comment`
- **AND** NON SHALL sparire dal filo

#### Scenario: una nota della macchina non fa ripartire niente
- **GIVEN** una `review-note` scritta su una card in review
- **THEN** l'agente NON SHALL essere svegliato

### Requirement: THREAD-04 — Uno slot tiene una riga sola, e il testo può cambiare

Il sistema SHALL permettere a una riga di DICHIARARE quale riga sostituisce, per
prefisso, e la sostituzione SHALL essere una cancellazione — non una riga
nascosta che il filo continua a portarsi dietro.

La chiave di uno slot SHALL essere l'insieme di quattro cose: la card, l'autore,
la SPECIE e il prefisso. Due specie diverse con lo stesso prefisso SHALL
convivere: sono due frasi di due voci.

Lo slot SHALL poter dichiarare PIÙ aperture. Con una sola, la nota nuova non
riconosce quella scritta dal codice di ieri e le due finiscono affiancate — cioè
esattamente il duplicato che lo slot esiste per togliere.

Uno slot NON SHALL toccare una riga scritta da una PERSONA, nemmeno quando
comincia con lo stesso prefisso.

Lo slot SHALL essere distinto dalla deduplica per testo identico: quella non
serve a niente quando il testo cambia a ogni giro — una porta diversa, un
conteggio diverso — ed è proprio il caso in cui le copie si accumulano.

> Nato da un difetto visibile: lo screenshot dell'anteprima sovrascrive sempre
> lo stesso file, quindi le note VECCHIE finivano per mostrare l'immagine NUOVA.

#### Scenario: tre giri, una riga
- **GIVEN** tre scritture con lo stesso slot e tre testi diversi
- **THEN** SHALL restare una riga sola, l'ultima

#### Scenario: nessuno slot dichiarato
- **GIVEN** tre scritture senza slot
- **THEN** SHALL restare tre righe

#### Scenario: la riga di una persona
- **GIVEN** un commento umano che comincia con lo stesso prefisso dello slot
- **THEN** NON SHALL essere toccato

#### Scenario: l'apertura di ieri
- **GIVEN** una nota vecchia scritta con un'apertura diversa, e uno slot che la
  dichiara fra le proprie
- **THEN** SHALL restare una riga sola
