## ADDED Requirements

### Requirement: SUBAGENT-30 — Un agente al lavoro è al lavoro su ogni superficie, col numero

Attilio, 23/11: «vedo in attesa in task, ma sia il suo sottoagente sia la sua tab
dovrebbero essere in loading essendoci un agente, anche con il numero».

Gli agenti al lavoro per una chat SHALL essere i suoi discendenti, a qualunque
profondità, col turno aperto (`state: working` nelle righe di `GET /api/live-work`),
contati da una funzione sola (`agentsAtWorkUnder`, `shared/live-work.ts`). Un figlio
che ha chiuso il turno e aspetta figli suoi NON SHALL contare se stesso: contano i
suoi figli al lavoro.

- La tab della chat SHALL mostrare quel numero dentro l'anello del loader
  (`pane-tab-agents`, `data-agents`), nell'inchiostro del loader, quando niente le
  chiede la persona; il numero di ciò che chiede la persona SHALL vincere (TABSLOT-02).
- La riga della sidebar della chat che aspetta i figli SHALL dire «N sottoagenti al
  lavoro» (BGVIS-10), e l'intestazione della fisarmonica dei sottoagenti SHALL dire
  quanti lavorano (`subagents-accordion`, `data-agents`).
- La riga della striscia di un figlio `awaiting` SHALL essere disegnata al lavoro,
  col loader e il numero dei suoi agenti al lavoro (`data-state="working"`,
  `data-agents`), finché sotto di lui lavora un agente o gira un suo comando o
  compito (`shownChildState`); con niente che gira SHALL restare l'orologio, senza
  loader (SUBAGENT-16). Il compito `subagent` della sua mappa NON SHALL bastare: resta
  finché un figlio deve solo consegnare un risultato.

#### Scenario: un figlio aspetta un nipote al lavoro
- **GIVEN** una chat con un figlio nativo, e un nipote nato dalla sessione del figlio, tutti e due al lavoro
- **THEN** la tab della chat SHALL avere `pane-tab-agents` con `data-agents="2"`
- **WHEN** il figlio chiude il turno e aspetta il nipote (`waiting-results`)
- **THEN** la sua riga nella striscia SHALL avere `data-state="working"`, `data-agents="1"`, un loader e nessun orologio, e dire «1 sottoagente al lavoro»
- **AND** la tab della chat SHALL mostrare 1, la sua riga in sidebar «1 sottoagente al lavoro», l'intestazione della fisarmonica `data-agents="1"`
- **WHEN** il nipote viene fermato
- **THEN** la riga del figlio SHALL tornare `awaiting` con l'orologio, e la tab SHALL perdere il numero
  (`tests/e2e/subagents-at-work.spec.ts`)
