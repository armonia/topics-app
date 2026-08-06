## ADDED Requirements

### Requirement: CMD-REBIND-01 — Le scorciatoie sono rimappabili, e l'override è dell'utente

Il sistema SHALL permettere di riassegnare l'accordo di tastiera di ogni comando
rimappabile, persistendo gli override per utente (non per macchina) e lasciando
intatta la keymap di default per chi non tocca niente.

#### Scenario: Il default vale finché non si dissente
- **GIVEN** un utente che non ha mai rimappato niente
- **WHEN** apre il pannello delle scorciatoie
- **THEN** ogni comando mostra l'accordo di default del registro
- **AND** nessun override è persistito

#### Scenario: Un override sostituisce il default e resta
- **GIVEN** il comando «Nuova chat» sull'accordo di default ⌘T
- **WHEN** l'utente lo riassegna a ⌘⌥N
- **AND** ricarica l'applicazione
- **THEN** ⌘⌥N apre una chat nuova
- **AND** ⌘T non apre più una chat nuova

#### Scenario: L'override segue l'utente su un altro dispositivo
- **GIVEN** un override salvato su questo client
- **WHEN** la stessa persona apre Topics da un altro dispositivo
- **THEN** l'override è già attivo lì

#### Scenario: Ripristinare un singolo comando
- **GIVEN** un comando con un override attivo
- **WHEN** l'utente sceglie di ripristinarlo
- **THEN** il comando torna al suo accordo di default
- **AND** gli override degli altri comandi restano invariati

### Requirement: CMD-REBIND-02 — Un conflitto si vede prima di crearlo

Il sistema SHALL rilevare quando un accordo è già assegnato a un altro comando e
SHALL dichiararlo prima di applicarlo, invece di lasciare che vinca in silenzio
chi è dichiarato per primo.

#### Scenario: Assegnare un accordo già preso
- **GIVEN** ⌘K assegnato a «Command palette»
- **WHEN** l'utente prova ad assegnare ⌘K a «Nuova chat»
- **THEN** il sistema mostra che ⌘K appartiene già a «Command palette»
- **AND** l'associazione non è applicata finché l'utente non conferma

#### Scenario: Confermare libera il precedente proprietario
- **GIVEN** il conflitto qui sopra
- **WHEN** l'utente conferma di volere ⌘K su «Nuova chat»
- **THEN** «Nuova chat» risponde a ⌘K
- **AND** «Command palette» resta senza accordo, e il pannello lo dice

#### Scenario: Due comandi non possono condividere lo stesso accordo in silenzio
- **GIVEN** una qualunque configurazione di override
- **WHEN** il sistema risolve un accordo premuto
- **THEN** esiste al più un comando che vi risponde

### Requirement: CMD-REBIND-03 — Non ci si può chiudere fuori

Il sistema SHALL garantire che l'utente possa sempre tornare alla keymap di
default senza usare la tastiera, e SHALL impedire di riassegnare gli accordi la
cui perdita renderebbe irraggiungibile il pannello stesso.

#### Scenario: Il pannello delle scorciatoie non si può disarmare
- **GIVEN** il pannello delle scorciatoie aperto
- **WHEN** l'utente prova a riassegnare l'accordo che lo apre a un altro comando
- **THEN** il sistema lo rifiuta dichiarando il motivo

#### Scenario: Ripristino totale senza tastiera
- **GIVEN** un insieme di override che l'utente non ricorda
- **WHEN** apre le impostazioni col mouse e sceglie il ripristino
- **THEN** tutti gli override spariscono
- **AND** ogni comando risponde di nuovo al suo default

### Requirement: CMD-REBIND-04 — Un accordo che la shell non inoltra non si può assegnare in silenzio

Il sistema SHALL trattare come non assegnabile ogni accordo che la shell nativa
non inoltra alla webview, oppure SHALL estendere l'inoltro a runtime — perché un
accordo inoltrato solo con il fuoco nella webview principale funziona a
intermittenza, che è peggio di non funzionare.

#### Scenario: Un accordo non inoltrabile viene rifiutato con la sua ragione
- **GIVEN** la shell desktop, con un'allowlist di accordi inoltrati
- **WHEN** l'utente assegna un comando a un accordo fuori dall'allowlist e
  l'inoltro a runtime non è disponibile
- **THEN** il sistema lo rifiuta spiegando che quell'accordo non arriverebbe
  quando il fuoco è dentro un terminale o una pane browser

#### Scenario: Con l'inoltro a runtime l'accordo si assegna e funziona ovunque
- **GIVEN** la shell desktop, con l'inoltro a runtime disponibile
- **WHEN** l'utente assegna un comando a un accordo fuori dall'allowlist di base
- **AND** porta il fuoco dentro una pane terminale
- **THEN** l'accordo raggiunge comunque il comando

#### Scenario: Sul web non c'è nessuna allowlist da rispettare
- **GIVEN** Topics aperto in una scheda del browser
- **WHEN** l'utente assegna un comando a un accordo qualunque
- **THEN** il sistema non applica il vincolo dell'inoltro nativo
