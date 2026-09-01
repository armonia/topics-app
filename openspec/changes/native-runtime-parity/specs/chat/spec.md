# chat — delta

## ADDED Requirements

### Requirement: NATIVE-CTX-01 — il runtime nativo riceve le regole globali dell'utente

Quando un turno è servito dal provider `topics` e `~/.claude/CLAUDE.md` esiste, il
contesto DEVE contenerne il testo, con un livello di import `@percorso` espanso. Con
qualunque altro provider quel blocco NON DEVE essere inviato (la CLI lo carica da sé).

#### Scenario: le regole arrivano al nativo
- **GIVEN** un topic sul provider `topics` e un `~/.claude/CLAUDE.md` che contiene «trash > rm»
- **WHEN** l'utente manda un messaggio
- **THEN** il modello può citare quella regola senza usare tool

#### Scenario: non si paga due volte su claude-code
- **GIVEN** un topic sul provider `claude-code`
- **WHEN** si assembla il payload
- **THEN** il blocco `user:CLAUDE.md` non compare fra gli slot inviati

### Requirement: NATIVE-SKILL-01 — elenco in contesto, corpo a richiesta

Il contesto di un turno nativo DEVE elencare le skill installate (nome + descrizione,
descrizione troncata a 180 caratteri) e NON DEVE contenerne il corpo. Il corpo si ottiene
col tool `skill`, che accetta solo nomi validi e risolti dentro le cartelle note.

#### Scenario: una skill dietro un symlink è installata
- **GIVEN** `~/.claude/skills/x` è un link a una cartella con dentro `SKILL.md`
- **THEN** `x` compare nell'elenco

#### Scenario: il tool rifiuta un nome che esce dalle cartelle note
- **WHEN** si chiama `skill` con `../../../etc/passwd`
- **THEN** torna un errore leggibile, non il contenuto di un file

### Requirement: NATIVE-EFFORT-01 — l'effort del topic diventa thinking

Un turno nativo DEVE tradurre l'effort (topic, altrimenti impostazione globale) in
`thinking.budget_tokens`, e `max_tokens` DEVE restare maggiore del budget. L'effort
`low` NON DEVE abilitare il thinking.

#### Scenario: high
- **GIVEN** effort `high`
- **THEN** la richiesta porta un budget di thinking > 1024 e `max_tokens` > budget
