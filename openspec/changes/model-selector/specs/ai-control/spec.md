# Controllo AI: delta di model-selector

Modifica requisiti della change `ai-control-hierarchy-topics-switch`, che va
archiviata prima di questa.

## MODIFIED Requirements

### Requirement: AICTRL-01 — L'instradamento leggero e' uno switch a se', e non sovrascrive niente

L'interruttore «Esegui in Topics», in una fascia **sopra** il selettore, dice se
i turni passano dal motore di Topics. Non è una voce della lista dei provider, e
cambiarlo **non** altera il provider né il modello selezionati.

**Il valore mai scritto vale acceso** (MSEL-06). Nessun dato viene riscritto per
questo.

**Cosa significano le due posizioni:**

- **Acceso.** Il turno passa dal motore di Topics **quando il bersaglio è
  instradabile**: un provider della famiglia Claude con un modello che il
  motore serve, oppure Automatico con il motore pronto. Altrimenti il turno va
  **diretto** sul bersaglio, e la strada è dichiarata sulla riga del modello,
  nella fascia e sul turno.
- **Spento.** Esecuzione **diretta** sul provider e sul modello selezionati.

**L'interruttore non è mai un no-op silenzioso.** Se è acceso e il turno va
diretto, l'interfaccia lo dice prima dell'invio, con il motivo. L'interruttore
non blocca l'invio e non parcheggia le card.

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

#### Scenario: acceso con Automatico
- **GIVEN** il provider su **Automatico** e il motore pronto
- **WHEN** l'interruttore è acceso
- **THEN** Topics sceglie secondo le proprie regole
- **AND** il modello concreto scelto resta visibile

#### Scenario: acceso con un provider non instradabile
- **GIVEN** Codex, o un'API, o Gemini
- **WHEN** l'interruttore è acceso
- **THEN** il turno va diretto su quel provider
- **AND** fascia, riga e turno dicono «diretto» con il motivo
- **AND** l'invio non è bloccato

#### Scenario: spento
- **GIVEN** un provider concreto selezionato
- **WHEN** l'interruttore è spento
- **THEN** l'esecuzione è **diretta** su quel provider e modello

#### Scenario: nessun provider Topics visibile
- **WHEN** l'utente apre il selettore
- **THEN** nell'elenco **non** compare una voce Topics sintetica

### Requirement: AICTRL-02 — Ogni provider dello snapshot e' rappresentato, con il suo stato

Il selettore rappresenta **ogni** provider presente nello snapshot. I modelli
dei provider `ready` si possono selezionare. Quelli dei provider non-`ready`
sono **visibili con il motivo** ma disabilitati, e l'azione «Apri impostazioni»
è a portata. Nessuna integrazione inventata: l'elenco è quello dello snapshot.

Le righe sono **per modello**, divise per azienda (MSEL-02, MSEL-05). Il
provider che esegue un modello è scritto sulla sua riga, e si cambia sul posto
quando ce n'è più d'uno.

#### Scenario: pronto e non pronto convivono
- **GIVEN** uno snapshot con un provider `ready` e uno non-`ready` con motivo
- **WHEN** l'utente apre il selettore
- **THEN** i modelli di entrambi compaiono
- **AND** quelli del primo sono selezionabili, quelli del secondo disabilitati con il motivo

#### Scenario: i modelli di aziende diverse insieme
- **WHEN** l'utente apre il selettore
- **THEN** i modelli di tutti i provider pronti sono nello stesso pannello, senza scegliere prima un provider
