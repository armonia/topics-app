# Delta: thread — cinque specie, un'ancora, e il taglio per costruzione

## MODIFIED Requirements

### Requirement: THREAD-03 — Cinque specie, e la specie decide chi si sveglia

Ogni riga del filo SHALL portare una SPECIE fra cinque: `comment`, `status`,
`review-note`, `service`, `delivery`. La specie SHALL essere marcata ALLA FONTE,
da chi scrive, e NON SHALL essere dedotta dal testo.

La lettura SHALL whitelistare le specie note e far cadere ogni altra su
`comment`. Il fallback SHALL essere silenzioso e mai una riga nascosta: un
lettore che non conosce una specie deve vedere comunque la riga.

Solo un `comment` scritto da una PERSONA SHALL svegliare l'agente. Una
`review-note` è evidenza scritta dalla macchina e NON SHALL far ripartire un
turno; uno `status` è una transizione e non è parola di nessuno; una `delivery`
è la sintesi della consegna: la scrive `update({status:'review', summary})`
PRIMA che lo stato si muova, oppure la promozione dell'ultimo commento
dell'agent alla porta di sistema (`promoteLastAgentWordToDelivery`,
server/services/tasks.ts:2878-2890, chiamata da `deliverToReviewBySystem` a
4554); nessun altro scrittore.

I conteggi SHALL seguire la specie: «quanti messaggi ho mandato» conta solo i
`comment` di una persona; `status` e `service` NON SHALL mai valere come
l'ultima parola di un turno.

Le righe di servizio consecutive SHALL potersi piegare in una sola nel filo, e
`status`, `review-note` e `delivery` NON SHALL piegarsi mai — sono quelle che si
leggono.

Una riga scritta da una sessione MAY portare l'ancora del messaggio che l'ha
prodotta (`messageId`); l'ancora è NULL quando nessun messaggio era in streaming
al momento della scrittura, e un lettore NON SHALL trattare l'assenza come errore.

> Il fallback silenzioso non è teorico: aggiungere `service` al tipo senza
> aggiungerlo alla whitelist di lettura l'ha fatto tornare `comment` da tredici
> punti di scrittura, e al client non è mai arrivato.

> Prima diceva «quattro specie»: `shared/board.ts:1380` ne ha cinque da quando
> `delivery` è entrata con la consegna con riassunto, e la spec era rimasta
> indietro.

#### Scenario: una specie sconosciuta su disco
- **GIVEN** una riga con una specie che il codice non conosce
- **THEN** SHALL essere letta come `comment`
- **AND** NON SHALL sparire dal filo

#### Scenario: una nota della macchina non fa ripartire niente
- **GIVEN** una `review-note` scritta su una card in review
- **THEN** l'agente NON SHALL essere svegliato

#### Scenario: l'ancora fa round-trip
- **GIVEN** `addComment({messageId: 'm1'})`
- **THEN** `rowToComment` espone `messageId = 'm1'`
- **AND** senza `messageId` espone `null`

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
i gruppi rimessi in fila SHALL ridare il filo di partenza. Il taglio di un gruppo
dove l'agente ha parlato SHALL avvenire PER COSTRUZIONE: nella conversazione
della card i passi della sessione sono righe della stessa lista e non sono mai
`service` né `status`, quindi un passo fra due note di servizio spezza la piega da
solo, senza una regola di taglio dedicata.

Una riga di servizio SOLA NON SHALL essere piegata: «1 riga di servizio»
nasconde un messaggio senza compattare niente.

La bonifica delle righe già scritte SHALL essere provata ESEGUENDO il file di
migrazione, non una sua copia, e SHALL essere giudicata su ciò che LASCIA STARE
prima che su ciò che cambia.

> Prima diceva: «Chi legge SHALL poter TAGLIARE un gruppo dove l'agente ha
> parlato, perché fra un commento e l'altro il filo intercala i passi della
> sessione». Descriveva l'intercalare precedente al commit `1ab9c390d` e la prop
> `breaksRun`, morta da allora; con la proiezione unica il taglio torna vero senza
> quella prop.

MISURA: ThreadRuns.test.tsx — le pieghe non perdono righe (65-131) e una riga di
sessione fra due `service` produce due pieghe; la prop `breaksRun` non esiste più
in ThreadRuns.tsx; `bun run check:deadcode` verde.

#### Scenario: una persona cita il dispatcher
- **GIVEN** una riga con il testo di una nota di contabilità, scritta da una persona
- **THEN** NON SHALL essere piegata

#### Scenario: la stessa riga, letta domani
- **GIVEN** la stessa riga classificata in due momenti diversi
- **THEN** SHALL dare lo stesso esito

#### Scenario: contabilità con le parole dell'agente appese
- **GIVEN** una nota di consegna seguita dalle ultime parole dell'agente
- **THEN** NON SHALL essere piegata

#### Scenario: un passo di sessione spezza la piega
- **GIVEN** tre righe `service` consecutive con un passo di sessione fra la seconda e la terza
- **THEN** il filo mostra due gruppi e il passo fra loro
- **AND** nessuna riga manca rimettendo i gruppi in fila
