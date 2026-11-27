# Tracce

- [x] T1 soglia pura `compactionThresholds` + `compactIfNeeded` col tetto. Barra: `compaction-cap.test.ts`.
- [x] T2 `agent-engine.json` letto a ogni turno, agente dal workspace, tetto nel turno e nel `TurnSpec`. Barra: `compaction-cap-turn.test.ts`, `agent-engine-settings.test.ts`.
- [x] T3 `turn-host` passa il tetto al loop. Barra: `detached-turn.test.ts -t "ceiling"`.
- [x] T3b tetto solo a inizio turno, taglio dei risultati contro la finestra, alleggerimento idempotente. Barra: `compaction-cap-turn.test.ts -t "never mid-turn"`, `compaction-cap.test.ts`.
- [x] T3c tetto solo sui turni aperti da una persona (`openedByPerson` dalla route): una ripresa tiene la richiesta che continua. Barra: `chat.opened-by-person.test.ts`, `compaction-cap-turn.test.ts -t "nobody typed"`.
- [ ] T4 configurazione `main` e `gtm` a 200.000 e misura prima/dopo sulle chat vere. Barra: `token-audit.ts --calls` dopo il riavvio, chiamate oltre 200k sotto il 10% (prima 28%), media sotto 183k e p90 sotto 350k (i turni lunghi di tool e le riprese crescono oltre il tetto per scelta).
