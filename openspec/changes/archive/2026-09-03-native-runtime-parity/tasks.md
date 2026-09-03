# Tasks

- [x] `resolveClaudeModel()` passato al provider nativo
- [x] `lib/native-parity.ts`: regole utente + elenco skill + mappa effort→thinking
- [x] Blocchi `user:CLAUDE.md` e `synthetic:skills` nell'envelope, saltati nel turno lean
- [x] Slot `user-rules` e `skills`; filtro «solo nativo» in `adaptEnvelope`
- [x] Tool `skill` nel runtime nativo
- [x] `thinking.budget_tokens` dall'effort, con `max_tokens` alzato di conseguenza
- [x] Fix symlink in `listSlashCommandFiles` (12 skill viste su 41)
- [x] Test: `lib/native-parity.test.ts` (12), `providers/native/skill-tool.test.ts` (4)
- [x] Verifica dal vivo su un server isolato: 41 skill, regole citate, modello Opus,
      `effort=high → budget=10000`
- [ ] Verifica in produzione dopo il merge (richiede riavvio del server Topics)
