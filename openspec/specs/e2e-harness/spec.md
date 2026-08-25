## Purpose

Le invarianti del banco E2E stesso: isolamento fra run concorrenti, proprietà
della porta di test, e pulizia dei processi. Non descrive una funzionalità del
prodotto — descrive le condizioni senza le quali le misure del prodotto non
valgono niente.

## Background

Su questa macchina girano più agenti insieme, e più di una suite E2E può partire
nello stesso momento. La porta di test (`13334` per default) e il suo server sono
una risorsa condivisa: due run che la usano insieme si cancellano i dati a
vicenda e producono rossi mobili — il tipo di rosso che si insegue per un giorno
e il giorno dopo non c'è più.

## Requirements

### Requirement: E2E-LOCK-01 — Una run non tocca la porta di un'altra run

Il banco E2E SHALL proteggere la porta di test con un lock che nomina il PID e
la working directory di chi la sta usando. Una run che trova il lock tenuto da un
processo VIVO SHALL rifiutarsi di partire, dicendo di chi è la porta.

Lo smontaggio (`global-teardown`) SHALL verificare la proprietà della porta
**prima** di uccidere i processi che vi ascoltano. Il teardown gira sempre,
anche quando il setup ha rifiutato di partire: senza quella verifica, la run
respinta uccide il server della run che il lock stava proteggendo.

Un lock il cui PID è morto, assente o illeggibile NON SHALL bloccare la pulizia:
un lock rimasto per terra dopo un crash congelerebbe la porta per sempre e i
processi orfani si accumulerebbero. Il rimedio non deve essere peggiore del male.

Il lock di chi sta smontando NON SHALL proteggerlo da sé stesso: il caso normale
— la propria run che si chiude — deve pulire esattamente come prima.

> Scritto dal guasto, non dall'ipotesi. Il 25/08/2026 alle 01:37 una run respinta
> dal lock ha comunque stampato `Killed stale processes on port 13334: 45374`,
> facendo morire a metà corsa la suite di un altro agente. Il lock aveva fatto il
> suo lavoro; il teardown l'ha disfatto.

#### Scenario: una run respinta smonta senza uccidere

- **GIVEN** la porta di test è tenuta da un'altra run viva
- **WHEN** il global-teardown di una run respinta gira
- **THEN** non uccide nessun processo su quella porta
- **AND** dice di chi è la porta (PID e cwd)

#### Scenario: un lock morto non congela la porta

- **GIVEN** un lock il cui PID non esiste più
- **WHEN** il teardown gira
- **THEN** la pulizia procede normalmente

#### Scenario: il proprio lock non blocca la propria pulizia

- **GIVEN** il lock appartiene al processo che sta smontando
- **WHEN** il teardown gira
- **THEN** la pulizia procede normalmente

#### Scenario: un lock illeggibile non è un titolare

- **GIVEN** un file di lock scritto a metà
- **WHEN** il teardown lo legge
- **THEN** non lo tratta come una run viva e procede

### Requirement: E2E-GATE-01 — La superficie di test non esiste, fuori dal banco

Le rotte di test — quelle che fotografano e RIPRISTINANO il database riga per
riga, e quelle che seminano stato a cui le API pubbliche non arrivano — SHALL
esistere solo quando una variabile d'ambiente lo dichiara con un valore ESATTO.
Fuori da quel caso SHALL rispondere come rotte che non esistono: un 404, non un
403 e non una rotta disarmata.

Il riconoscimento SHALL essere per valore esatto: nessuna variabile, il valore
spento, una parola che «sembra» accesa, o un ambiente di test dichiarato per
altra via NON SHALL accendere niente. Un default «acceso quando non so»
riaprirebbe il buco senza che nessun test diventi rosso.

> Il difetto era reale e vissuto: una rotta di semina era registrata senza
> condizione, ed è stata l'unica superficie di test raggiungibile anche in
> produzione.

#### Scenario: nessuna variabile
- **GIVEN** un ambiente che non dichiara niente
- **THEN** le rotte di test NON SHALL esistere

#### Scenario: un valore che somiglia a un sì
- **GIVEN** la variabile impostata a una parola diversa dal valore esatto
- **THEN** le rotte di test NON SHALL esistere

### Requirement: E2E-GATE-02 — Il codice che va in produzione sta DENTRO i cancelli, e lo si prova eseguendoli

Ogni cartella il cui contenuto viene DISTRIBUITO SHALL essere compresa nei
programmi dei cancelli — tipi, lint, codice morto. Una suite di test verde su
quella cartella NON SHALL essere scambiata per copertura: i test giravano, e
intanto un errore di tipo, un export morto o una violazione di stile
arrivavano in produzione senza che niente diventasse rosso.

La prova SHALL ESEGUIRE i cancelli e confrontare l'elenco dei file che
dichiarano di aver letto con i file su disco. Verificare la CONFIGURAZIONE non
basta: un'inclusione che non combacia con nessun file, o un comando la cui
configurazione ignora la cartella, sono verdi — ed è esattamente lo stato che
questa regola esiste per rilevare.

Le SCADENZE di questa prova SHALL essere molto sopra il caso a macchina scarica.
È una prova che gira nella barra di review di OGNI card: con dieci agenti che
rivedono insieme, tre misure diventano trenta compilazioni in parallelo, e una
compilazione da tre secondi ne impiega più di sessanta. Un rosso da scadenza qui
non costa una card: costa N card e N agenti che lo rileggono ciascuno per conto
suo.

#### Scenario: una cartella distribuita fuori dai programmi
- **GIVEN** una cartella il cui codice viene distribuito e che nessun cancello legge
- **THEN** la prova SHALL fallire

#### Scenario: configurazione che non combacia
- **GIVEN** un'inclusione che non corrisponde a nessun file
- **THEN** SHALL essere rilevata, perché l'elenco letto è vuoto
