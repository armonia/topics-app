# Delta: resource-attribution — consumo attribuito alla singola pane

## ADDED Requirements

### Requirement: RES-ATTR-01 — Il server attribuisce i processi alla sessione che li ospita

Il server SHALL mantenere, per ogni sessione ospitata dal pty-bridge, il pid del processo
di testa, e SHALL esporre l'uso di risorse aggregato sull'albero di quel pid. Ogni pid
SHALL essere fatturato a **una sola** sessione anche quando è raggiungibile da più radici,
con la stessa regola già in vigore per l'attribuzione per `kind`. I totali di flotta
esistenti (`processCount`, `memoryMB`, `cpuPercent`, `roots[]`) SHALL restare invariati:
l'attribuzione per sessione si affianca, non sostituisce.

#### Scenario: Due sessioni sullo stesso pty-bridge sono distinte
- **GIVEN** il pty-bridge ospita la sessione A e la sessione B, ognuna con il proprio albero di processi
- **WHEN** il client chiede l'uso di risorse
- **THEN** la risposta SHALL riportare A e B separatamente, ognuna con la sua memoria, la sua CPU e il suo numero di processi
- **AND** la somma di A e B SHALL essere uguale al totale del root `pty-bridge`

#### Scenario: Un processo raggiungibile da due sessioni è fatturato una volta sola
- **GIVEN** un pid compare nell'albero sia della sessione A sia della sessione B
- **WHEN** l'uso di risorse viene calcolato
- **THEN** quel pid SHALL contribuire a una sola delle due
- **AND** il totale di flotta SHALL restare invariato rispetto a oggi

#### Scenario: Una sessione appena avviata non inventa uno zero
- **GIVEN** una sessione il cui processo di testa è appena nato e non ha ancora un delta di CPU
- **WHEN** l'uso di risorse viene riportato
- **THEN** la sua CPU SHALL essere dichiarata non misurata, distinta da una CPU misurata pari a zero

### Requirement: RES-ATTR-02 — La shell attribuisce ogni processo webview alla sua pane

La shell SHALL associare ogni processo WKWebView alla pane che lo ospita, e SHALL esporre
per ciascuna pane il footprint e la CPU già misurati per quel processo. La CPU SHALL
essere riportata sulla scala 0-100 dell'intera macchina e la memoria come
`phys_footprint`, cioè le stesse unità dei totali della status bar. La copertura SHALL
essere dichiarata: una pane il cui processo non è (ancora) associabile SHALL risultare
non misurata.

#### Scenario: Due pane browser hanno numeri distinti
- **GIVEN** due pane browser aperte su siti diversi
- **WHEN** il client chiede l'uso di risorse per pane
- **THEN** ciascuna SHALL riportare il proprio footprint e la propria CPU
- **AND** i due valori SHALL essere diversi quando i due processi consumano diversamente

#### Scenario: Una pane non ancora associata lo dichiara
- **GIVEN** una pane appena aperta il cui processo webview non è ancora associato
- **WHEN** l'uso di risorse viene riportato
- **THEN** quella pane SHALL risultare non misurata
- **AND** il totale della status bar SHALL restare invariato

### Requirement: RES-ATTR-03 — Ogni tab mostra il proprio consumo al passaggio del mouse

Ogni tab SHALL mostrare, al passaggio del mouse, il consumo della pane corrispondente:
memoria, CPU e numero di processi. I valori SHALL usare le stesse unità e lo stesso
vocabolario della status bar. Una pane senza misura SHALL dirlo esplicitamente invece di
mostrare uno zero.

#### Scenario: Il tooltip mostra il consumo della pane
- **GIVEN** una tab la cui pane ha una misura disponibile
- **WHEN** l'utente ci passa sopra il mouse
- **THEN** SHALL comparire memoria, CPU e numero di processi di quella pane

#### Scenario: Senza misura il tooltip lo dice
- **GIVEN** una tab la cui pane non ha (ancora) una misura
- **WHEN** l'utente ci passa sopra il mouse
- **THEN** il tooltip SHALL dichiarare che il consumo non è misurato
- **AND** non SHALL mostrare uno zero

### Requirement: RES-ATTR-04 — L'attribuzione non moltiplica il costo del campionamento

L'uso per pane SHALL essere derivato dallo stesso campionamento che già produce i totali
di flotta, entro la stessa finestra di validità. Il numero di pane aperte NON SHALL
aumentare il numero di letture di sistema per ciclo.

#### Scenario: Dieci pane non costano dieci letture
- **GIVEN** dieci pane aperte
- **WHEN** il client chiede l'uso di risorse entro la finestra di validità
- **THEN** il numero di letture di sistema SHALL essere lo stesso che con una pane sola
