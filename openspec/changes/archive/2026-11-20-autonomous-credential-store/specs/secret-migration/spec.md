## ADDED Requirements

### Requirement: MIGRATE-01 — Import idempotente dei segreti in chiaro nel vault

Una migrazione SHALL importare nel vault i segreti oggi in chiaro su disco: le ~11 chiavi
API di `~/.claude/jarvis/router/.env` e gli `storageState`/cookie di sessione
(`<DATA_DIR>/browser-state` e la relativa `_handles/*.json`, più gli stati esterni
legacy `browser-states`/`browser-profiles` referenziati da `TOPICS_EXTERNAL_STATES_DIR`/
`JARVIS_STATES_DIR`). La migrazione SHALL essere **idempotente**: rieseguirla non crea
duplicati né sovrascrive un valore già ruotato.

#### Scenario: reimport senza duplicati
- **GIVEN** una `.env` già importata nel vault
- **WHEN** la migrazione viene rieseguita
- **THEN** nessuna voce duplicata è creata e i valori nel vault restano invariati

### Requirement: MIGRATE-02 — Rollback e cestinamento posticipato dei sorgenti

La migrazione SHALL supportare **rollback** (ripristino allo stato pre-migrazione) e
**NON** SHALL cancellare i file sorgente in chiaro finché il sistema non riparte
**verde** leggendo i segreti dal vault. I `.env` e gli `storageState` originali SHALL
essere **cestinati** (trash, non `rm`) **solo dopo** verifica di funzionamento.

#### Scenario: sorgenti cestinati solo dopo verde
- **GIVEN** una migrazione completata
- **WHEN** il sistema riavvia e legge correttamente i segreti dal vault
- **THEN** solo allora i file `.env`/`storageState` originali sono spostati nel cestino;
  se la verifica fallisce, i sorgenti restano e si può fare rollback

### Requirement: MIGRATE-03 — Deprecazione di jbrowser

Il daemon esterno **jbrowser** (`:3344`) SHALL essere deprecato in favore di
`browser-service.ts`: i suoi stati di sessione (`browser-states`/`browser-profiles`)
confluiscono nel vault via MIGRATE-01, e nessun nuovo flusso di auth SHALL dipendere da
jbrowser. La deprecazione SHALL essere documentata (nessun codice di jbrowser vive in
questo repo).

#### Scenario: nessuna dipendenza residua da jbrowser
- **GIVEN** il sistema dopo la migrazione
- **WHEN** l'agente esegue login/registrazione autonomi
- **THEN** usa `browser-service.ts` + vault, senza contattare il daemon `:3344`
