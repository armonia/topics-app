# Tracce

- [x] T1 soglia pura `compactionThresholds` + `compactIfNeeded` col tetto. Barra: `compaction-cap.test.ts`.
- [x] T2 `agent-engine.json` letto a ogni turno, agente dal workspace, tetto nel turno e nel `TurnSpec`. Barra: `compaction-cap-turn.test.ts`, `agent-engine-settings.test.ts`.
- [x] T3 `turn-host` passa il tetto al loop. Barra: `detached-turn.test.ts -t "ceiling"`.
- [ ] T4 configurazione `main` e `gtm` a 200.000 e misura prima/dopo sulle chat vere. Barra: `token-audit.ts --calls` dopo il riavvio, nessuna chiamata degli agenti oltre ~210k.
