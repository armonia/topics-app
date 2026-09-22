# Controllo AI — instradamento sopra, provider e modello sotto

## ADDED Requirements

### Requirement: AICTRL-01 — L'instradamento leggero e' uno switch a se', e non sovrascrive niente

Uno switch **sopra** il selettore abilita o disabilita l'instradamento leggero
Topics. Non e' una voce della lista dei provider, e cambiarlo **non** altera il
provider ne' il modello selezionati.

Il motivo e' che sono due domande diverse: *chi* risponde, e *per quale strada*
passa il turno. Mescolarle in una lista sola fa sembrare un cambio di strada un
cambio di fornitore.

**Cosa significano esattamente le due posizioni** (semantica canonica della
fonte, interpretazione dell'approvazione gia' data e non scope nuovo):

- **ON** — l'esecuzione passa dal routing leggero Topics, e **provider e modello
  selezionati sono il target/vincolo**. Con provider **Automatico**, Topics
  sceglie secondo le proprie regole.
- **OFF** — esecuzione **diretta** sul provider e modello selezionati.

**Un provider esplicito non rende MAI lo switch un no-op silenzioso.** Con un
provider concreto scelto e lo switch su ON, il routing deve instradare davvero
verso quel target: non puo' ignorare la scelta ne' fingere di rispettarla. Un
comando che sembra fare qualcosa e non fa niente e' peggio di un comando
assente, perche' nessuno va a controllare.

Quando un provider **non e' tecnicamente instradabile** le strade oneste sono
due: lo switch resta **visibile e disabilitato** con il motivo, oppure si
**completa il plumbing del contratto**. Nessun supporto finto, e nessuna
restrizione della UX per far entrare il caso nel contratto esistente.

#### Scenario: cambiare instradamento non tocca la scelta sotto
- **GIVEN** un provider e un modello selezionati
- **WHEN** l'utente attiva o disattiva l'instradamento leggero Topics
- **THEN** provider e modello selezionati restano **identici**
- **AND** lo stato dello switch si persiste per conto suo

#### Scenario: ON con un provider esplicito instradabile
- **GIVEN** un provider concreto e instradabile, con il suo modello
- **WHEN** lo switch e' **ON**
- **THEN** il turno passa dal routing leggero Topics
- **AND** il **target** e' quel provider e quel modello, non un altro
- **AND** la scelta resta invariata nell'interfaccia

#### Scenario: ON con provider Automatico
- **GIVEN** il provider impostato su **Automatico**
- **WHEN** lo switch e' **ON**
- **THEN** Topics sceglie secondo le proprie regole
- **AND** il modello concreto scelto resta visibile
- **AND** i turni gia' storici non vengono riscritti

#### Scenario: OFF con un provider esplicito
- **GIVEN** un provider concreto selezionato
- **WHEN** lo switch e' **OFF**
- **THEN** l'esecuzione e' **diretta** su quel provider e modello
- **AND** il turno non passa dal routing leggero

#### Scenario: provider non instradabile
- **GIVEN** un provider che il routing leggero non sa instradare
- **WHEN** l'utente apre il controllo
- **THEN** lo switch e' **visibile e disabilitato**, con il **motivo**
- **AND** non cambia in silenzio provider, modello o strada
- **AND** in nessun caso lo switch resta attivo comportandosi da no-op

#### Scenario: nessun provider Topics visibile
- **WHEN** l'utente apre il selettore
- **THEN** nell'elenco dei provider **non** compare una voce Topics sintetica

### Requirement: AICTRL-02 — Ogni provider dello snapshot e' rappresentato, con il suo stato

Il primo livello elenca **ogni** provider presente nello snapshot corrente: i
`ready` selezionabili, i non-`ready` **visibili con il motivo** ma disabilitati.
Nessuna integrazione inventata: l'elenco e' quello dello snapshot, non un
catalogo scritto a mano.

Mostrare disabilitato invece di nascondere e' deliberato: un provider che sparisce
dal menu si legge come «non esiste», e chi lo ha configurato non sa dove sia
finito.

#### Scenario: pronto e non pronto convivono
- **GIVEN** uno snapshot con un provider `ready` e uno non-`ready` con motivo
- **WHEN** l'utente apre il selettore
- **THEN** entrambi compaiono
- **AND** il primo e' selezionabile, il secondo e' disabilitato e mostra il motivo

#### Scenario: i modelli seguono il provider
- **WHEN** l'utente sceglie un provider
- **THEN** il secondo livello offre solo i modelli compatibili con quel provider

### Requirement: AICTRL-03 — La selezione sopravvive, e il ripiego e' deterministico

La selezione resta valida e persistente dopo un refresh. Quando il provider o il
modello scelto sparisce dallo snapshot o smette di essere `ready`, il ripiego e'
**deterministico** e dichiarato, mai una sostituzione silenziosa.

#### Scenario: il provider scelto non e' piu' pronto
- **GIVEN** una selezione salvata su un provider che diventa non-`ready`
- **WHEN** il selettore si ricarica
- **THEN** il ripiego segue una regola sola e ripetibile
- **AND** l'utente vede che la scelta precedente non e' disponibile, con il motivo

### Requirement: AICTRL-04 — I valori legacy `topics:*` mappano senza corrompere niente

La persistenza dell'instradamento e' **separata** da quella di provider e
modello. Un valore salvato in forma `topics:<model>` continua a risolvere: si
mappa sullo switch dell'instradamento piu' il modello, senza corrompere lo stato
di una chat, di un task o di un turno in volo.

Nessuna migrazione distruttiva: i dati gia' scritti restano leggibili come sono.

#### Scenario: un valore legacy si legge ancora
- **GIVEN** una selezione salvata come `topics:<model>`
- **WHEN** la si rilegge dopo il cambio
- **THEN** il modello resta quello
- **AND** l'instradamento leggero risulta attivo
- **AND** nessun turno in volo cambia provider o modello sotto i piedi

#### Scenario: un turno in volo non viene riscritto
- **GIVEN** un turno in corso con il suo provider e modello storici
- **WHEN** l'utente cambia lo switch o la selezione
- **THEN** il turno in volo conserva i valori con cui e' partito

#### Scenario: un `provider` salvato come "topics" non e' un target, e' gia' instradato
- **GIVEN** un record persistito con `provider: "topics"` (valore storico, mai
  scritto da una selezione nuova: AICTRL-01 lo esclude gia' dall'elenco)
- **WHEN** lo switch e' acceso e il record si rilegge
- **THEN** l'esecuzione passa dal motore nativo senza errore, perche' quel
  valore *e' gia'* "instradato", non un provider a cui instradare
- **AND** questo non riapre "topics" come voce selezionabile: resta un caso di
  lettura di un dato vecchio, non una nuova via di selezione

### Requirement: AICTRL-05 — Una semantica sola su tre superfici

Chat, composer task e impostazioni board usano la **stessa** logica, condivisa o
dimostrabilmente equivalente. Nessuna copia divergente: e' il modo in cui due
superfici cominciano a rispondere in modo diverso alla stessa domanda.

#### Scenario: le tre superfici concordano
- **GIVEN** lo stesso snapshot
- **WHEN** si apre il controllo in chat, nel composer task e nelle impostazioni board
- **THEN** l'insieme dei provider e il loro stato sono gli stessi
- **AND** nessuna delle tre mostra una voce provider Topics
