# Spec Delta: node-pool

## Purpose

Il pool dei nodi cloud: macchine Linux affittate a ore su cui Topics manda il lavoro
pesante, create da un'immagine preparata quando la coda le chiede e cancellate
quando non servono, con la spesa sotto un tetto in euro e nessun segreto durevole
fuori da questo Mac.

## ADDED Requirements

### Requirement: POOL-01 — Un nodo a richiesta esiste solo finché serve, e si cancella invece di spegnersi

Il pool SHALL creare un nodo quando una card instradata (KANBAN-96) non trova un
posto libero sui nodi pronti, e SHALL cancellarlo quando resta senza corse e l'ora
già pagata sta per finire. Il pool NON SHALL mai spegnere un nodo per risparmiare:
il fornitore fattura un server finché esiste, acceso o spento. Un nodo fisso NON
SHALL essere cancellato dal pool.

#### Scenario: la coda chiede un nodo
- **GIVEN** il pool acceso, una card pesante instradata senza posto libero, la spesa sotto il tetto e i nodi sotto il massimo
- **WHEN** il pool fa il suo giro
- **THEN** SHALL creare UN nodo dall'immagine preparata

#### Scenario: fermo a fine ora
- **GIVEN** un nodo a richiesta senza corse da dieci minuti, a 52 minuti della sua ora fatturata
- **THEN** il pool SHALL cancellarlo

#### Scenario: fermo a inizio ora
- **GIVEN** un nodo a richiesta senza corse, a 15 minuti della sua ora fatturata
- **THEN** il pool NON SHALL cancellarlo prima della fine dell'ora, perché quell'ora è già pagata
- **AND** una card che arriva nel frattempo SHALL poterlo usare

#### Scenario: il nodo fisso
- **GIVEN** il nodo fisso senza corse da un giorno
- **THEN** il pool NON SHALL cancellarlo

### Requirement: POOL-02 — La spesa ha un tetto in euro, e sopra il tetto il lavoro torna al Mac

Il pool SHALL tenere la spesa del mese dei nodi a richiesta come la conta il
fornitore: ore arrotondate per eccesso per il prezzo orario, ferme al tetto mensile
del tipo. NON SHALL creare un nodo se la sua prima ora porterebbe la spesa oltre il
tetto, né oltre il numero massimo di nodi. Sopra il tetto la card SHALL seguire il
ripiego di KANBAN-96, con una nota che nomina spesa e tetto.

#### Scenario: il tetto raggiunto
- **GIVEN** il tetto a 10 €, la spesa del mese a 9,95 € e un tipo da 0,1114 €/h
- **WHEN** la coda chiede un nodo
- **THEN** nessun nodo SHALL essere creato
- **AND** la card SHALL restare nella coda di questa macchina con la nota «tetto di spesa: 9,95 su 10 €»

#### Scenario: il massimo dei nodi
- **GIVEN** il massimo a 3 nodi e 3 nodi vivi (fisso compreso)
- **THEN** nessun nodo SHALL essere creato, qualunque sia la spesa

### Requirement: POOL-03 — Il pool tocca solo ciò che ha creato, e lo ritrova dal fornitore

Ogni risorsa creata dal pool SHALL portare la label `topics-node` e una scadenza
(`expires`). Ogni elenco, raccolta o cancellazione del pool SHALL passare dal
selettore di quella label, in un progetto del fornitore che non contiene altro. Un
server senza la label NON SHALL mai essere cancellato. Al riavvio il pool SHALL
ritrovare i nodi vivi dall'elenco del fornitore, non dalla memoria.

#### Scenario: un server che non è del pool
- **GIVEN** nel progetto un server senza la label `topics-node`
- **THEN** il pool NON SHALL elencarlo, contarlo né cancellarlo

#### Scenario: il Mac riparte con due nodi vivi
- **GIVEN** due nodi con la label vivi presso il fornitore e il server di Topics appena ripartito
- **WHEN** il pool fa il primo giro
- **THEN** SHALL ritrovarli entrambi, contarli nella spesa e nel massimo, e riprenderne le corse

#### Scenario: un nodo dimenticato
- **GIVEN** un nodo con la label e `expires` nel passato, che il DB non conosce
- **WHEN** gira il raccoglitore
- **THEN** il nodo SHALL essere cancellato e la cancellazione SHALL lasciare una riga nel log del pool

### Requirement: POOL-04 — Nessun segreto durevole nell'immagine né nei dati di avvio

L'immagine da cui nascono i nodi NON SHALL contenere credenziali: Claude, Codex,
GitHub, gettone di accoppiamento. I dati di avvio, che il fornitore serve alla VM
per tutta la sua vita, SHALL contenere solo una chiave della tailnet monouso,
effimera, con tag e scadenza breve, coniata per quel nodo. Le altre credenziali
SHALL arrivare da questo Mac dopo l'ingresso del nodo nella tailnet.

#### Scenario: i dati di avvio letti più tardi
- **GIVEN** un nodo pronto da un'ora
- **WHEN** qualcuno legge i suoi dati di avvio dall'indirizzo dei metadati
- **THEN** la chiave che trova SHALL essere già usata o scaduta

#### Scenario: l'immagine ispezionata
- **GIVEN** l'immagine preparata
- **THEN** NON SHALL contenere `~/.claude/.credentials.json`, `~/.codex/auth.json`, token GitHub né file in `<stateDir>/nodes/`

### Requirement: POOL-05 — Un nodo si accoppia senza un clic, e la sua porta non risponde in pubblico

Un nodo creato dal pool SHALL accoppiarsi a questa macchina (MACHINE-02) senza
nessuno davanti al nodo, con l'approvazione che passa dalla tailnet. Il server del
nodo SHALL rispondere solo dalla tailnet e in loopback: dall'IP pubblico la sua
porta NON SHALL rispondere. Nessun proxy SHALL stare davanti alla porta del nodo,
perché arriverebbe come loopback, cioè come proprietario.

#### Scenario: accoppiamento automatico
- **GIVEN** un nodo appena entrato nella tailnet
- **WHEN** il pool chiede l'accoppiamento
- **THEN** la riga del nodo SHALL nascere con il suo `base_url` e il gettone a `0600`, senza nessun clic

#### Scenario: la porta vista da fuori
- **GIVEN** un nodo pronto
- **WHEN** si apre una connessione alla sua porta dall'IP pubblico
- **THEN** la connessione SHALL fallire
- **AND** dalla tailnet la stessa porta SHALL rispondere

#### Scenario: il nodo non vede il Mac
- **GIVEN** un nodo nella tailnet
- **WHEN** dal nodo si apre una connessione verso la porta di Topics di questa macchina
- **THEN** la connessione SHALL essere rifiutata dalla policy della tailnet

### Requirement: POOL-06 — Un nodo che rinasce è la stessa macchina

I nodi SHALL avere nomi fissi per posto (`topics-node-1`, `topics-node-2`, …). Un
nodo cancellato e ricreato sullo stesso posto SHALL ritrovare la stessa riga
macchina e lo stesso indirizzo: prima della cancellazione il nodo SHALL uscire
dalla tailnet, così che il nome si liberi. Ogni vita SHALL restare nella storia del
suo posto con tipo, luogo, ore e costo.

#### Scenario: lo stesso posto due volte
- **GIVEN** il posto `topics-node-2` cancellato ieri dopo il logout dalla tailnet
- **WHEN** il pool lo ricrea oggi
- **THEN** il nodo SHALL entrare come `topics-node-2`, non come `topics-node-2-1`
- **AND** SHALL usare la stessa riga `machines` e lo stesso `base_url`
- **AND** la storia del posto SHALL avere due vite

### Requirement: POOL-07 — Creare può fallire, e il fallimento ha un nome e un ripiego

Una creazione rifiutata dal fornitore SHALL avere il suo motivo: tipo esaurito
(`resource_unavailable`), limite del conto (`resource_limit_exceeded`), collocazione
(`placement_error`), troppe richieste (`rate_limit_exceeded`). Il pool SHALL provare
gli altri luoghi e i tipi ammessi in ordine, entro il tetto, poi SHALL ripiegare
(KANBAN-96). Un nodo che non è pronto entro il tempo massimo SHALL essere cancellato.

#### Scenario: il tipo preferito esaurito
- **GIVEN** cx43 esaurito in tutti i luoghi, cpx42 fra i tipi ammessi e la sua prima ora dentro il tetto
- **WHEN** la coda chiede un nodo
- **THEN** il pool SHALL creare un cpx42
- **AND** la vita del nodo SHALL registrare il tipo davvero creato

#### Scenario: niente da comprare
- **GIVEN** tutti i tipi ammessi esauriti
- **THEN** la card SHALL restare nella coda di questa macchina con la nota «nessun tipo disponibile presso il fornitore»
- **AND** il pool NON SHALL ritentare lo stesso tipo nello stesso luogo prima dell'intervallo di attesa

#### Scenario: un nodo che non arriva
- **GIVEN** un nodo creato che non è entrato nella tailnet entro il tempo massimo
- **THEN** il pool SHALL cancellarlo e scrivere il motivo
- **AND** la card SHALL tornare alla scelta di KANBAN-96
