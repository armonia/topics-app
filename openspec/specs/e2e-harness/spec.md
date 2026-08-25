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
