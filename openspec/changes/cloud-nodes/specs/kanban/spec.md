# Delta: kanban — una card pesante va da sola a un nodo libero

## ADDED Requirements

### Requirement: KANBAN-96 — Una card pesante senza macchina scelta va a un nodo libero, e senza nodo resta al Mac

Una card senza `machine_id`, con i nodi accesi nelle impostazioni, SHALL essere
instradata a un nodo quando è PESANTE (`dispatch_weight = heavy`) oppure quando
l'ammissione di questa macchina la terrebbe ferma per memoria, e un nodo è pronto,
ha un posto libero e conosce il suo repository. Altrimenti SHALL restare nella coda
di questa macchina con le regole di sempre. Il nodo scelto vale per quel tentativo:
NON SHALL diventare il `machine_id` della card.

#### Scenario: una pesante con un nodo libero
- **GIVEN** i nodi accesi, un nodo pronto con un posto libero che conosce il repository
- **AND** una card in `todo` senza `machine_id` con `dispatch_weight = heavy`
- **WHEN** il dispatcher la prende
- **THEN** la card SHALL partire sul nodo per la corsia di KANBAN-76
- **AND** nessun worktree e nessun discorso SHALL nascere su questa macchina
- **AND** il `machine_id` della card SHALL restare vuoto

#### Scenario: una card leggera ferma per memoria
- **GIVEN** un nodo libero e una card leggera che l'ammissione di questa macchina terrebbe ferma per memoria
- **WHEN** il dispatcher la valuta
- **THEN** SHALL partire sul nodo invece di aspettare

#### Scenario: una card leggera con il Mac libero
- **GIVEN** un nodo libero e una card leggera che questa macchina ammette
- **THEN** SHALL partire su questa macchina

#### Scenario: nessun nodo libero
- **GIVEN** una card pesante e nessun nodo pronto con un posto libero, né la possibilità di crearne uno entro il tetto (POOL-02)
- **THEN** la card SHALL restare nella coda di questa macchina con le regole di oggi (peso, pavimento, tetto)
- **AND** SHALL portare UNA nota che dice perché non è andata al nodo

#### Scenario: il repository che il nodo non conosce
- **GIVEN** un nodo libero che non ha un progetto con l'origine git della card
- **THEN** la card NON SHALL essere instradata a quel nodo

#### Scenario: «solo su questo Mac»
- **GIVEN** una card il cui `machine_id` è questa macchina
- **THEN** NON SHALL mai essere instradata a un nodo

#### Scenario: una chat non va mai al nodo
- **GIVEN** i nodi accesi e un nodo libero
- **WHEN** parte un turno di chat o un sotto-agente (`spawn_agent`)
- **THEN** SHALL partire su questa macchina

#### Scenario: il tentativo dopo una sepoltura
- **GIVEN** una card instradata a un nodo e la sua corsa sepolta (KANBAN-77)
- **WHEN** la card torna in `todo` e il dispatcher la riprende
- **THEN** il nodo SHALL essere scelto da capo, e la corsa vecchia SHALL essere cancellata sul suo nodo prima di crearne una nuova

### Requirement: KANBAN-97 — Il peso conta dove gira il lavoro

Una card in volo su un nodo NON SHALL contare fra gli agenti vivi di questa
macchina, né fra i task pesanti in volo che fermano i claim locali. Una card pesante
sul nodo NON SHALL fermare nessun claim di questa macchina.

#### Scenario: una pesante sul nodo, una leggera in coda qui
- **GIVEN** una card pesante in `working` su un nodo
- **AND** una card leggera in `todo` che questa macchina ammette
- **WHEN** il dispatcher fa il suo giro
- **THEN** la card leggera SHALL partire su questa macchina
- **AND** il conto degli agenti vivi di questa macchina NON SHALL includere la card sul nodo

## MODIFIED Requirements

### Requirement: KANBAN-76 — Una card scelta per un nodo gira LÀ, e torna qui come una card locale

Una card il cui `machine_id` nomina un nodo accoppiato SHALL essere ESEGUITA su
quel nodo e NON su questa macchina. Il dispatch locale SHALL saltare worktree,
discorso e turno, e SHALL invece creare sul nodo un task ordinario (`POST
/api/nodes/runs`) con un commento di servizio che nomina la board di origine.

Il `machine_id` di una card SHALL essere una scelta UMANA, e NESSUNA regola SHALL
scriverlo: `machine_id` assente vuol dire «qui o dove la manda KANBAN-96». Una card
senza `machine_id` SHALL poter girare su un nodo SOLO per l'instradamento di
KANBAN-96, che sceglie il nodo per un tentativo e non lo scrive sulla card; per
quella corsa valgono la creazione, lo specchio, il bundle e la consegna di questo
requisito, uguali. Un `machine_id` uguale a questa macchina vuol dire «solo qui».

Sul nodo la card SHALL essere un task LOCALE come tutti gli altri: stesso
dispatcher, stesso worktree, stesso tetto e stesso cancello di KANBAN-16. È il
tetto del NODO a decidere quando parte. Su questa board lo slot remoto NON SHALL
consumare posti: con una card remota in `working`, `busyCount()` e il `running`
di `GET /api/system/dispatch-capacity` SHALL restare a zero.

A ogni giro di riconciliazione lo stato e i commenti di servizio del nodo SHALL
essere SPECCHIATI sulla card locale, senza duplicati: la deduplica SHALL passare
dall'ancora di KANBAN-72, cioè dall'id del commento sul nodo. La chat del nodo
NON SHALL essere trasmessa qui.

Quando la card del nodo arriva in `review` il RAMO SHALL arrivare con lei: un
git bundle sul canale già autenticato, verificato (`git bundle verify`) e
piantato in questo checkout come `refs/heads/<branch>`; `delivery_branch` e
`delivery_commit` SHALL essere registrati, e da lì in poi l'atterraggio SHALL
essere quello locale di sempre, invariato. Non SHALL esserci nessun `push` verso
`origin` e nessun remoto condiviso.

Il bundle SHALL presupporre che questo checkout ABBIA il `baseSha`: se non ce
l'ha, il motivo SHALL essere scritto sulla card e NON SHALL esserci un ripiego a
bundle di storia intera. Se il nodo non conosce il repository per la sua origine
git, la risposta SHALL essere un `no_such_repo` dichiarato e NESSUN progetto
SHALL essere creato sul nodo.

Per una card il cui `machine_id` nomina un nodo, un nodo IRRAGGIUNGIBILE al
momento del dispatch SHALL far ASPETTARE la card con un motivo dichiarato
(`node_unreachable`) e un `dispatch_deferred_until`: quella card NON SHALL mai
partire su questa macchina perché il nodo non ha risposto. Il ripiego di una card
instradata senza `machine_id` è quello di KANBAN-96.

MISURA: `bun test server/services/task-dispatcher-remote-node.test.ts
tests/integration/nodes-routes.test.ts server/services/node-client.test.ts` verde,
e `npx playwright test tests/e2e/board-remote-node.spec.ts` verde: la corsia
remota non spende il tetto locale, il giro del bundle pianta il ramo su un repo
git vero, e il chip del nodo sopravvive al reload.

#### Scenario: la card parte sul nodo, non qui
- **GIVEN** una card in `todo` con `machine_id` di un nodo accoppiato
- **WHEN** il dispatcher la prende
- **THEN** nessun worktree e nessun discorso locale SHALL nascere
- **AND** sul nodo SHALL esistere un task in `todo` con un commento che nomina l'origine

#### Scenario: la corsia remota non spende il tetto locale
- **GIVEN** una card remota in lavorazione
- **THEN** `busyCount()` SHALL essere 0
- **AND** il `running` della capacità di dispatch SHALL essere 0

#### Scenario: il ramo torna come bundle
- **GIVEN** la card del nodo passata in `review` con un commit sul suo ramo
- **WHEN** questa board riconcilia
- **THEN** `refs/heads/<branch>` SHALL esistere in questo checkout
- **AND** `delivery_branch` e `delivery_commit` SHALL essere registrati

#### Scenario: il repository che il nodo non ha
- **GIVEN** una origine git che nessun progetto del nodo conosce
- **THEN** la risposta SHALL essere `no_such_repo`
- **AND** nessun progetto SHALL essere creato sul nodo

#### Scenario: nodo muto, nessun ripiego locale
- **GIVEN** una card con `machine_id` di un nodo che non risponde al momento del dispatch
- **THEN** la card SHALL restare in coda col motivo `node_unreachable`
- **AND** nessun turno SHALL partire su questa macchina

#### Scenario: l'instradamento non scrive la macchina
- **GIVEN** una card senza `machine_id` mandata a un nodo da KANBAN-96
- **WHEN** la sua corsa arriva in `review`
- **THEN** il `machine_id` della card SHALL essere ancora vuoto
- **AND** il nodo di quella corsa SHALL restare leggibile nella storia del tentativo
