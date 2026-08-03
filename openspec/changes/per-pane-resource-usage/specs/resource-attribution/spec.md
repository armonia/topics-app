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
- **AND** la somma di A e B NON SHALL superare il totale del root `pty-bridge` (il processo bridge stesso non appartiene a nessuna sessione, quindi la somma è minore o uguale, mai uguale per costruzione)

#### Scenario: I totali di flotta non cambiano per effetto dell'attribuzione
- **GIVEN** lo stesso insieme di processi, una volta senza sessioni registrate e una volta con
- **WHEN** l'uso di risorse viene calcolato
- **THEN** `processCount`, `memoryMB`, `cpuPercent` e `roots` SHALL essere identici nei due casi
- **AND** l'attribuzione SHALL essere una lente su processi già contati, non una ripartizione che li sottrae ai root

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

### Requirement: RES-ATTR-05 — Le pane senza processo proprio sono dichiarate tali, non stimate

Le pane che non possiedono un processo separato — topic, kanban, chat, file, editor,
session-viewer: componenti che vivono tutti nell'unico processo renderer — NON SHALL
ricevere un consumo attribuito. Il sistema SHALL dichiararle "senza processo proprio",
distinguendo questo caso sia da "non misurato" (una pane che un processo ce l'ha, ma di
cui manca la misura) sia da uno zero.

Il motivo è strutturale e non aggirabile: nessuna lettura di sistema può separare il
costo di due componenti che girano nello stesso processo. Una stima ripartita
(per numero di nodi DOM, per superficie, per quota parte) SHALL essere considerata un
numero inventato e non SHALL essere mostrata.

#### Scenario: Una pane kanban non riceve un consumo inventato
- **GIVEN** una pane kanban, che vive nel renderer condiviso
- **WHEN** l'utente ne chiede il consumo
- **THEN** il sistema SHALL dichiarare che quella pane non ha un processo proprio
- **AND** NON SHALL mostrare né uno zero né una quota stimata del renderer

#### Scenario: I tre stati restano distinti
- **GIVEN** una pane terminale con misura, una pane browser il cui processo non è ancora associato, e una pane kanban
- **WHEN** l'uso di risorse viene riportato
- **THEN** la prima SHALL avere un valore, la seconda SHALL risultare "non misurata", la terza "senza processo proprio"
- **AND** i tre stati NON SHALL essere collassati in un unico "0" o "—"

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
