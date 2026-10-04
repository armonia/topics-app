# ai-control Specification

## Purpose
TBD - created by archiving change ai-control-hierarchy-topics-switch. Update Purpose after archive.

## Requirements

### Requirement: AICTRL-01 — L'instradamento leggero e' uno switch a se', e non sovrascrive niente

L'interruttore «Esegui in Topics», in una fascia **sopra** il selettore, SHALL
dire se i turni passano dal motore di Topics. Non è una voce della lista dei
provider, e cambiarlo SHALL NOT alterare il provider né il modello selezionati.

**Il valore mai scritto vale acceso per le chat, spento per le card e per il
default della board** (MSEL-06). Nessun dato viene riscritto per questo.

**Cosa significano le due posizioni:**

- **Acceso.** Prima si risolve il bersaglio come a interruttore spento:
  Automatico diventa il default. Poi il turno passa dal motore di Topics
  **quando quel bersaglio è instradabile**, cioè un provider della famiglia
  Claude con un modello che il motore serve. Altrimenti il turno va **diretto**
  sul bersaglio, e la strada è dichiarata sulla riga del modello e nella fascia.
  Non sul singolo turno: la strada è della chat, e conservarla per turno
  vorrebbe una migrazione che questa change esclude (emendamento del 03/10).
- **Spento.** Esecuzione **diretta** sul provider e sul modello selezionati.

**L'interruttore non è mai un no-op silenzioso.** Se è acceso e il turno va
diretto, l'interfaccia lo dice prima dell'invio, con il motivo. L'interruttore
non blocca l'invio e non parcheggia una card perché il suo bersaglio non è
instradabile.

#### Scenario: cambiare instradamento non tocca la scelta sotto
- **GIVEN** un provider e un modello selezionati
- **WHEN** l'utente attiva o disattiva l'interruttore
- **THEN** provider e modello selezionati restano **identici**
- **AND** lo stato dell'interruttore si salva per conto suo

#### Scenario: acceso con un provider instradabile
- **GIVEN** Claude Code con un modello servito dal motore
- **WHEN** l'interruttore è acceso
- **THEN** il turno passa dal motore di Topics, verso quel modello
- **AND** la scelta resta invariata nell'interfaccia

#### Scenario: acceso con Automatico e default Claude
- **GIVEN** il provider su **Automatico**, il default su Claude Code e il motore pronto
- **WHEN** l'interruttore è acceso
- **THEN** il turno passa dal motore di Topics
- **AND** il modello concreto scelto resta visibile

#### Scenario: acceso con Automatico e default Codex
- **GIVEN** il provider su **Automatico** e il default su Codex
- **WHEN** l'interruttore è acceso
- **THEN** il turno va diretto su Codex, come a interruttore spento
- **AND** la fascia dice «diretto» con il motivo

#### Scenario: acceso con un provider non instradabile
- **GIVEN** Codex, o un'API, o Gemini
- **WHEN** l'interruttore è acceso
- **THEN** il turno va diretto su quel provider
- **AND** fascia e riga dicono «diretto» con il motivo
- **AND** l'invio non è bloccato

#### Scenario: spento
- **GIVEN** un provider concreto selezionato
- **WHEN** l'interruttore è spento
- **THEN** l'esecuzione è **diretta** su quel provider e modello

#### Scenario: nessun provider Topics visibile
- **WHEN** l'utente apre il selettore
- **THEN** nell'elenco **non** compare una voce Topics sintetica

### Requirement: AICTRL-02 — Ogni provider dello snapshot e' rappresentato, con il suo stato

Il selettore SHALL rappresentare **ogni** provider presente nello snapshot. I
modelli dei provider `ready` si possono selezionare. Un provider non-`ready`
SHALL essere **visibile col suo stato** e con un'azione a portata: una riga del
riquadro «collega» della sua azienda («Accedi», «Configura ›», «Aggiungi
chiave ›»), oppure la sua scheda nel livello «Provider e chiavi» quando
l'azienda non è nota o il riquadro è stato nascosto con «Non mi serve»
(emendamento del 04/10: prima erano righe di modelli disabilitate). Nessuna
integrazione inventata: l'elenco è quello dello snapshot.

Le righe sono **per modello**, divise per azienda (MSEL-02, MSEL-05). Il
provider che esegue i modelli di una sezione è scritto nel suo titolo, e si
cambia lì sul posto quando ce n'è più d'uno. Una riga lo ripete solo quando per
lei è diverso (emendamento del 04/10: prima lo scriveva ogni riga).

#### Scenario: pronto e non pronto convivono
- **GIVEN** uno snapshot con un provider `ready` e uno non-`ready` con motivo
- **WHEN** l'utente apre il selettore
- **THEN** i modelli del primo compaiono e sono selezionabili
- **AND** il secondo compare col suo stato e la sua azione, nel riquadro «collega» della sua azienda

#### Scenario: i modelli di aziende diverse insieme
- **WHEN** l'utente apre il selettore
- **THEN** i modelli di tutti i provider pronti sono nello stesso pannello, senza scegliere prima un provider

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
