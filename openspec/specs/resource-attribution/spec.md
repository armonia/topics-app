## Purpose

Attribuisce il consumo di risorse — memoria e CPU — alla singola pane invece che
all'applicazione nel suo insieme. La status bar sa dire quanto tiene Topics in tutto;
questa capability sa dire **quale scheda** se lo stia mangiando, così chiuderne una è
una decisione informata invece di un tentativo.

## Background

Preconditions comuni a tutti gli scenari:

- L'app è in esecuzione con il server su :3333.
- Le misure usano due unità fisse, le stesse della status bar e di Monitoraggio Attività:
  memoria come `phys_footprint`, CPU sulla scala 0-100 dell'**intera macchina**
  (normalizzata sui core, non la somma per-core di `ps`).
- Le pane hanno tre nature diverse rispetto ai processi, e la distinzione decide la
  forma di tutta la capability:

  | Pane | Processo proprio | Da dove arriva la misura |
  |---|---|---|
  | terminale / sessione Claude | albero PTY col pid di testa | server (`fleet-usage.ts`) |
  | browser | webview nativa | shell (`_webProcessIdentifier`) |
  | topic, kanban, chat, file, editor, session-viewer | **nessuno** | non misurabile |

  L'ultima riga non è una lacuna implementativa: quelle pane sono componenti React nello
  stesso processo renderer, e nessuna lettura di sistema può separare il costo di due
  componenti che condividono un processo.

- Server e shell sono due mondi separati: il server non vede le webview (vivono nella
  shell), la shell non vede i sidecar (sono figli del server reparentati a launchd).

## Requirements

### Requirement: RES-ATTR-01 — Il server attribuisce i processi alla sessione che li ospita

Il server SHALL mantenere, per ogni sessione ospitata dal pty-bridge, il pid del processo
di testa, e SHALL esporre l'uso di risorse aggregato sull'albero di quel pid. Ogni pid
SHALL essere fatturato a **una sola** sessione anche quando è raggiungibile da più radici.
I totali di flotta esistenti (`processCount`, `memoryMB`, `cpuPercent`, `roots[]`) SHALL
restare invariati: l'attribuzione si affianca, non ripartisce.

#### Scenario: Due sessioni sullo stesso pty-bridge sono distinte
- **GIVEN** il pty-bridge ospita la sessione A e la sessione B, ognuna col proprio albero
- **WHEN** il client chiede l'uso di risorse
- **THEN** la risposta SHALL riportare A e B separatamente, ognuna con la sua memoria, la sua CPU e il suo numero di processi
- **AND** la somma di A e B NON SHALL superare il totale del root `pty-bridge` (il processo bridge non appartiene a nessuna sessione, quindi è minore o uguale, mai uguale per costruzione)

#### Scenario: I totali di flotta non cambiano per effetto dell'attribuzione
- **GIVEN** lo stesso insieme di processi, una volta senza sessioni registrate e una volta con
- **WHEN** l'uso di risorse viene calcolato
- **THEN** `processCount`, `memoryMB`, `cpuPercent` e `roots` SHALL essere identici nei due casi

#### Scenario: Un processo raggiungibile da due sessioni è fatturato una volta sola
- **GIVEN** un pid compare nell'albero sia della sessione A sia della sessione B
- **WHEN** l'uso di risorse viene calcolato
- **THEN** quel pid SHALL contribuire a una sola delle due

#### Scenario: Una sessione appena avviata non inventa uno zero
- **GIVEN** una sessione il cui processo di testa non ha ancora un delta di CPU
- **WHEN** l'uso di risorse viene riportato
- **THEN** la sua CPU SHALL essere dichiarata non misurata, distinta da una CPU misurata pari a zero

### Requirement: RES-ATTR-02 — La shell attribuisce ogni processo webview alla sua pane

La shell SHALL associare ogni processo WebContent alla pane che lo ospita, e SHALL
esporne footprint e CPU. La copertura SHALL essere dichiarata: una pane il cui processo
non è (ancora) associabile SHALL risultare non misurata, mai zero.

L'associazione passa da API privata di WebKit. Se quella API non risponde — versione
futura che la ritira, piattaforma diversa — il degrado SHALL essere la perdita
dell'attribuzione per scheda, MAI la perdita della misura complessiva né un crash.

#### Scenario: Due pane browser hanno numeri distinti
- **GIVEN** due pane browser aperte su siti diversi
- **WHEN** il client chiede l'uso di risorse per pane
- **THEN** ciascuna SHALL riportare il proprio footprint e la propria CPU

#### Scenario: Una pane il cui contenuto non è ancora caricato lo dichiara
- **GIVEN** una pane browser appena aperta, il cui processo WebContent non esiste ancora
- **WHEN** l'uso di risorse viene riportato
- **THEN** quella pane SHALL risultare non misurata
- **AND** il totale dell'app SHALL restare invariato

#### Scenario: Un processo terminato non lascia una misura fantasma
- **GIVEN** una pane il cui WebContent è terminato (scheda chiusa, o ricaricata con un processo nuovo)
- **WHEN** l'uso di risorse viene riportato
- **THEN** quella pane NON SHALL comparire con la sua ultima misura nota
- **AND** il pid liberato NON SHALL essere attribuito a chi lo eredita

#### Scenario: L'ordine delle pane è stabile fra due letture
- **GIVEN** più pane con processo associato
- **WHEN** l'uso di risorse viene letto due volte di seguito senza cambiamenti
- **THEN** l'ordine SHALL essere identico

### Requirement: RES-ATTR-03 — Ogni scheda mostra il proprio consumo al passaggio del mouse

Ogni scheda SHALL mostrare, al passaggio del mouse, il consumo della pane
corrispondente: memoria, CPU e numero di processi, nelle unità già in uso altrove.

#### Scenario: Il tooltip mostra il consumo della pane
- **GIVEN** una scheda la cui pane ha una misura disponibile
- **WHEN** l'utente ci passa sopra il mouse
- **THEN** SHALL comparire memoria, CPU e numero di processi di quella pane

#### Scenario: Il tooltip non ruba il posto a quelli esistenti
- **GIVEN** una scheda il cui contenitore espone già il proprio stato via nome accessibile
- **WHEN** il consumo viene mostrato
- **THEN** SHALL essere ospitato dall'elemento del NOME, non dal contenitore della scheda
- **AND** i tooltip già presenti sugli elementi figli SHALL restare intatti

### Requirement: RES-ATTR-04 — L'attribuzione non moltiplica il costo del campionamento

L'uso per pane SHALL essere derivato dallo stesso campionamento che produce i totali,
entro la stessa finestra di validità. Il numero di pane aperte NON SHALL aumentare il
numero di letture di sistema per ciclo. La misura SHALL essere richiesta quando serve a
qualcuno, non a intervalli fissi.

#### Scenario: Dieci pane non costano dieci letture
- **GIVEN** dieci pane aperte
- **WHEN** il client chiede l'uso di risorse entro la finestra di validità
- **THEN** il numero di letture di sistema SHALL essere lo stesso che con una pane sola

#### Scenario: Una lettura fallita non blocca quelle successive
- **GIVEN** una richiesta di misura che fallisce (server che riparte, rete assente)
- **WHEN** una richiesta successiva viene innescata
- **THEN** quest'ultima SHALL partire regolarmente
- **AND** l'ultimo dato buono SHALL restare visibile invece di essere azzerato

### Requirement: RES-ATTR-05 — Le pane senza processo proprio sono dichiarate tali, non stimate

Le pane che non possiedono un processo separato NON SHALL ricevere un consumo attribuito.
Il sistema SHALL dichiararle "senza processo proprio", distinguendo questo caso sia da
"non misurato" (una pane che un processo ce l'ha, ma di cui manca la misura) sia da zero.

Una stima ripartita — per numero di nodi DOM, per superficie, per quota parte del
renderer — SHALL essere considerata un numero inventato e NON SHALL essere mostrata.

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

### Requirement: RES-ATTR-06 — L'inventario del peso per feature: i conteggi sono ESATTI, i byte sono stime dichiarate

Topics mostra quanto pesa ciascuna feature: quante code, quante tab di task,
quante anteprime, e quanti byte occupano. Le due grandezze NON hanno lo stesso
valore di verità, e il sistema DEVE trattarle come due promesse diverse:

1. **I conteggi DEVONO essere esatti.** Sono l'unica cosa che questo inventario
   può promettere. Una coda vuota non è una coda; un task idratato senza tab non
   è una tab; una tab parcheggiata resta nel totale **proprio perché** non si
   vede da nessun'altra parte — sparire dal conto la renderebbe invisibile due
   volte.
2. **I byte SONO stime, e DEVONO dichiararsi tali.** Misurare l'occupazione
   reale di una struttura in memoria non è possibile dal client; una stima
   presentata come misura è peggio di nessun numero.

Il sistema DEVE nominare la **fonte** di ogni riga dell'inventario, così che un
numero sospetto si possa risalire allo store che lo produce invece di doverlo
indovinare.

> Perché questo requisito esiste, e come è stato ritrovato. Il docblock di
> `client/src/state/featureWeightCounts.test.ts` dice testualmente: «La spec
> (RES-ATTR-06) chiede che i conteggi siano ESATTI proprio perche' sono l'unica
> cosa che questo inventario puo' promettere». **RES-ATTR-06 non esisteva**: la
> capability si fermava a `-05`. È lo stesso caso di `KANBAN-09` — un test che
> ricorda un requisito che il documento non ha — ed è emerso il 25/08/2026 dalla
> passata di tracciabilità.
>
> Il difetto che il punto 1 previene è invisibile per costruzione: un conteggio
> sbagliato non rompe niente. Compare, sembra una misura, e nessuno ha modo di
> accorgersene guardandolo.

#### Scenario: una coda vuota non è una coda

- **GIVEN** una coda di invio senza turni dentro
- **WHEN** l'inventario conta le code
- **THEN** quella non entra nel totale

#### Scenario: un task idratato senza tab non è una tab

- **GIVEN** un task ripreso dallo store senza nessuna tab browser
- **WHEN** l'inventario conta le tab di task
- **THEN** quel task non contribuisce

#### Scenario: una tab parcheggiata resta nel conto

- **GIVEN** una tab browser parcheggiata, non visibile in nessuna pane
- **WHEN** l'inventario conta le tab
- **THEN** è inclusa: è l'unico posto in cui compare

#### Scenario: i byte si dichiarano come stima

- **GIVEN** una riga dell'inventario con un peso in byte
- **WHEN** viene mostrata
- **THEN** il numero è presentato come stima, non come misura
