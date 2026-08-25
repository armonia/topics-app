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

### Requirement: THREAD-05 — La contabilità si ripiega, la parola no — comprese le righe già scritte

Le righe di contabilità del dispatcher SHALL potersi riconoscere anche quando
NESSUNA marcatura le accompagna: sono già scritte sul filo, e nessuna
migrazione torna a marcarle tutte. Il riconoscimento SHALL valere per le righe
scritte dalla MACCHINA soltanto — una persona che cita il dispatcher sta
parlando, e la sua riga resta.

Il riconoscimento NON SHALL guardare NESSUN orologio. Una prima versione
recintava la regola dietro «scritta prima che la marcatura esistesse», con
l'istante scritto a mano: ogni nota prodotta fra quell'istante e la messa in
opera — fra cinquecento e ottocento al giorno, misurate — è rimasta né marcata
né riconoscibile, e per quelle non passa nessuna migrazione. La proprietà SHALL
essere STRUTTURALE: il dato che si classifica non porta una data addosso.

Le frasi riconosciute SHALL essere ANCORATE all'inizio o alla fine della riga.
Un riconoscimento a metà frase si porta via il messaggio di una persona che
quella frase la stava citando.

Il confine NON SHALL essere «chi l'ha scritta» ma «cambia cosa fai». Un esito e
una decisione RESTANO parola, anche quando li scrive la macchina e anche quando
cominciano con le stesse parole di una riga di contabilità: un atterraggio non
riuscito, dei controlli rossi, un fan-out da scegliere, e soprattutto la riga
che dice PERCHÉ una card è parcheggiata. Sulla base viva quelle aperture contano
344 e 245 righe, e tre di quelle sono la nota che si vorrebbe piegare.

Una nota di consegna che porta APPESE le ultime parole dell'agente NON SHALL
essere piegata: su centoventotto righe vive è l'unica cosa che l'agente ha detto
su quella card, e piegarla seppellisce esattamente la parola che tutto questo
meccanismo esiste per far emergere.

Una riga NON riconosciuta SHALL restare a schermo. Il modo di sbagliare SHALL
essere una riga in più, MAI una riga nascosta.

Il raggruppamento SHALL essere per righe ADIACENTI e NON SHALL perdere niente:
i gruppi rimessi in fila SHALL ridare il filo di partenza. Chi legge SHALL poter
TAGLIARE un gruppo dove l'agente ha parlato, perché fra un commento e l'altro il
filo intercala i passi della sessione, e un muro che li inghiottisse
nasconderebbe quella parola.

Una riga di servizio SOLA NON SHALL essere piegata: «1 riga di servizio»
nasconde un messaggio senza compattare niente.

La bonifica delle righe già scritte SHALL essere provata ESEGUENDO il file di
migrazione, non una sua copia, e SHALL essere giudicata su ciò che LASCIA STARE
prima che su ciò che cambia.

#### Scenario: una persona cita il dispatcher
- **GIVEN** una riga con il testo di una nota di contabilità, scritta da una persona
- **THEN** NON SHALL essere piegata

#### Scenario: la stessa riga, letta domani
- **GIVEN** la stessa riga classificata in due momenti diversi
- **THEN** SHALL dare lo stesso esito

#### Scenario: contabilità con le parole dell'agente appese
- **GIVEN** una nota di consegna seguita dalle ultime parole dell'agente
- **THEN** NON SHALL essere piegata

### Requirement: THREAD-06 — «Sta ancora scrivendo?» si chiede a CHI TIENE IL PROCESSO, non a una mappa in memoria

Prima di ripulire le righe a metà di un discorso SHALL essere chiesto se il turno
è ancora vivo, e la domanda SHALL poter arrivare a CHI TIENE IL PROCESSO. Farla
solo a una mappa IN MEMORIA significa che dopo un riavvio del server quella mappa
è vuota anche per una sessione il cui processo è vivissimo: un ricaricamento
bastava a buttare via il turno, sostituendo il pannello col cartello di una
risposta mai arrivata.

Uno stream presente in memoria SHALL bastare: è la strada di sempre, e SHALL
evitare la domanda.

Una risposta «fermo» SHALL essere una risposta VERA: il turno è finito e si
pulisce. Una risposta «non lo so» NON SHALL bloccare la pulizia, o col ponte
spento resterebbe bloccata per sempre.

La domanda SHALL essere fatta SOLO quando c'è davvero qualcosa da perdere: senza
righe a metà non c'è niente da pulire, e quindi niente da chiedere.

#### Scenario: dopo un riavvio del server
- **GIVEN** nessuno stream in memoria e un processo vivo
- **THEN** il turno NON SHALL essere ripulito

#### Scenario: nessuna riga a metà
- **GIVEN** un discorso senza righe parziali
- **THEN** NON SHALL essere fatta nessuna domanda
