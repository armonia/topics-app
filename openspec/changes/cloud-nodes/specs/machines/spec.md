# Delta: machines — un nodo dice cosa è, quanto lavora e quanto costa

## ADDED Requirements

### Requirement: MACHINE-05 — Un nodo dice cosa è, quanto lavora e quanto costa, e ciò che nessuno ha letto si scrive «non dichiarato»

Ogni riga di un nodo SHALL portare la capacità (vCPU e RAM) con la sua fonte
(«dichiarata dal fornitore» o «letta dal nodo»), l'uso (corse in volo sul tetto del
nodo), l'account con cui consuma e la sua quota. Un nodo affittato SHALL portare
anche il prezzo orario e il tetto mensile letti dal listino del fornitore, e la
spesa del mese. Un valore che nessuno ha letto SHALL comparire come «non
dichiarato», mai come zero.

#### Scenario: un nodo affittato
- **GIVEN** un nodo creato su un tipo con 8 vCPU, 16 GB, 0,0256 €/h e tetto 15,99 €/mese
- **WHEN** si apre la vista delle macchine
- **THEN** la sua riga SHALL mostrare 8 vCPU e 16 GB «dichiarati dal fornitore», 0,0256 €/h, 15,99 €/mese e la spesa del mese

#### Scenario: la spesa si conta come la fattura
- **GIVEN** un nodo vissuto 20 minuti e uno vissuto 61 minuti nello stesso mese
- **THEN** la spesa SHALL contare un'ora per il primo e due per il secondo, ciascuno fermo al tetto mensile del suo tipo

#### Scenario: la quota dice di chi è
- **GIVEN** un nodo che consuma con lo stesso account di questa macchina
- **THEN** la riga SHALL mostrare le finestre di quel piano dicendo che comprendono tutto il lavoro dell'account
- **AND** se Topics non legge quella quota SHALL scrivere «non letta», mai 0%

#### Scenario: una macchina propria senza listino
- **GIVEN** un nodo accoppiato a mano che non è affittato
- **THEN** prezzo e spesa SHALL essere «non dichiarati», non zero

#### Scenario: le corse del nodo stanno sulla sua riga
- **GIVEN** due card in volo su un nodo e tre su questa macchina
- **WHEN** si apre il popover del carico della board
- **THEN** la riga di questa macchina SHALL contare tre agenti e quella del nodo due corse sul suo tetto

### Requirement: MACHINE-06 — Lo stato di un nodo viene dai suoi poll e dal pool, non dal battito di questa macchina

La spazzata delle macchine ferme (MACHINE-01) NON SHALL rendere non disponibile un
nodo il cui ultimo poll è riuscito (KANBAN-77). Un nodo del pool SHALL mostrare
anche la sua fase di vita: in creazione, pronto, in cancellazione, posto vuoto. Un
posto vuoto SHALL restare nella vista con la storia delle sue vite.

#### Scenario: un nodo che risponde non è «offline»
- **GIVEN** un nodo senza battito da dieci minuti ma con l'ultimo poll riuscito
- **WHEN** gira la spazzata delle macchine ferme
- **THEN** il nodo NON SHALL passare a non disponibile

#### Scenario: un posto vuoto
- **GIVEN** un posto del pool il cui server è stato cancellato
- **THEN** la riga SHALL restare, con la fase «posto vuoto» e le vite passate con tipo, luogo, ore e costo
