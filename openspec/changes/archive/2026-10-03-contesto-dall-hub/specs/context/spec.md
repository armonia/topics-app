# Contesto — le fonti condivise vengono dall'hub

## ADDED Requirements

### Requirement: CTX-HUB-01 — Le regole globali sono quelle dell'hub

Sul runtime nativo il blocco delle regole utente SHALL venire da `~/.agents/AGENTS.md`
quando il file esiste, e SHALL NON aggiungere sopra `~/.claude/CLAUDE.md`. Senza hub
SHALL ricadere su `~/.claude/CLAUDE.md` con un livello di `@import` espanso. Il blocco
SHALL portare come fonte il percorso del file letto.

#### Scenario: hub presente
- **GIVEN** una home con `~/.agents/AGENTS.md` e `~/.claude/CLAUDE.md`
- **THEN** il blocco contiene il testo dell'hub e non quello di CLAUDE.md

### Requirement: CTX-HUB-02 — La memoria globale di Topics è ritirata

Il contesto SHALL NON contenere un blocco `memory:global`, anche se `memory/_global.md`
esiste ancora su disco. `GET` e `PUT /api/memory` e `DELETE /api/memory/global` SHALL
rispondere 410 senza scrivere. La memoria del topic resta.

#### Scenario: file residuo
- **GIVEN** un `memory/_global.md` rimasto su disco
- **THEN** nessun blocco del contesto ne contiene il testo

### Requirement: CTX-HUB-03 — Un processo di test non apre lo stato vivo

Con `NODE_ENV=test`, `createAppContext` SHALL rifiutare uno `STATE_DIR` uguale al repo
da cui gira il server.

#### Scenario: test senza DATA_DIR
- **GIVEN** un test che non ha isolato `DATA_DIR`
- **THEN** `createAppContext` lancia un errore invece di aprire lo stato vivo
