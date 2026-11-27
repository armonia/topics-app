# Tracce

- [x] T1 soglia pura `compactionThresholds` + `compactIfNeeded` col tetto. Barra: `compaction-cap.test.ts`.
- [x] T2 `agent-engine.json` letto a ogni turno, agente dal workspace, tetto nel turno e nel `TurnSpec`. Barra: `compaction-cap-turn.test.ts`, `agent-engine-settings.test.ts`.
- [x] T3 `turn-host` passa il tetto al loop. Barra: `detached-turn.test.ts -t "ceiling"`.
- [x] T3b tetto solo a inizio turno, taglio dei risultati contro la finestra, alleggerimento idempotente. Barra: `compaction-cap-turn.test.ts -t "never mid-turn"`, `compaction-cap.test.ts`.
- [x] T3c niente tetto sulle continuazioni (`continuation` dalla route: ripresa, nudge del goal e degli hook, sveglie): una ripresa tiene la richiesta che continua, il messaggio Discord di Jarvis prende il tetto. Barra: `chat.continuation-turn.test.ts`, `compaction-cap-turn.test.ts -t "continuation"`.
- [x] T4 configurazione `main` e `gtm` a 200.000 in `~/.topics/agent-engine.json`, in produzione dal 27/11 22:50 UTC (merge 11e556c12); il codice di produzione sui file veri risolve main e gtm a 200000. La misura prima/dopo sulle chat vere gira da sola il 28/11 alle 21:00 (job di jarvis-channels `8b40a5a9`): commenta la PR #1779 con le due righe di `token-audit --calls` e dice se la barra regge (oltre 200k sotto il 10%, media sotto 183k, p90 sotto 350k).
