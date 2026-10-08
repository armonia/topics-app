# Contesto — la memoria di Claude Code anche sul runtime nativo

## ADDED Requirements

### Requirement: NATIVE-MEM-01 — L'indice della memoria arriva al nativo

Sul runtime nativo il contesto SHALL contenere il `MEMORY.md` di Claude Code per la
cartella del turno: la radice git comune (anche da un worktree) o, senza git, la cartella
stessa; senza progetto `TOPICS_WORKSPACE`. SHALL fermarsi a 200 righe e 25.000 caratteri.
Gli altri provider SHALL NON riceverlo: lo inietta già la CLI.

#### Scenario: chat senza progetto
- **GIVEN** `TOPICS_WORKSPACE=$HOME` e `~/.claude/projects/-Users-x/memory/MEMORY.md`
- **THEN** il preambolo del nativo contiene l'indice e il percorso della sua cartella

### Requirement: NATIVE-MEM-02 — Il richiamo per prompt

Sul runtime nativo il messaggio del turno SHALL portare in coda, in `<memory-recall>`,
l'`additionalContext` restituito da `memrecall --hook` per quel prompt. Senza `memrecall`,
con un errore o oltre 3 s il turno SHALL partire senza richiamo.

#### Scenario: memrecall assente
- **GIVEN** nessun `memrecall` nel PATH, in `~/bin` o in `~/.local/bin`
- **THEN** il messaggio parte invariato

### Requirement: NATIVE-MEM-03 — Lo stesso interruttore della CLI

Con `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` indice e richiamo SHALL essere assenti.
