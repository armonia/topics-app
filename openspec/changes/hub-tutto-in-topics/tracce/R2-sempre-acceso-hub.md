# R2 — Ciò che deve restare sempre acceso: ritmo, rotta, «Ti aspetta», gate

**Cosa:** nel servizio: `/api/pace`, `/api/route`, `/api/attesa` (GET e POST; già in `hub-core`), `/api/queue` (GET e POST), `/api/gate`, `/api/gates`, `/api/exhausted`, `/api/override`, `/api/hold`, `/api/heavy`, `/api/overview`, `/api/live`, `/api/feedback` (POST di chiusura).
**Chiamanti critici (devono vivere con Topics giù):** `delegate`, `board-notte`, `jobs-watch.py`, `usage-hub.mjs gate` (se non legge, lascia passare), `cron-route.mjs`, `cron-when.mjs`, `museagent`, `jarvis-channels` (`turn.rs`:452-454), `giro-sorveglianza`, `usage-watch.mjs`, `muse-resume.mjs`, e i circa 12 script che scrivono «Ti aspetta».
**Da fare:** porta gli endpoint con le stesse regole; ciò che calcola e legge file (overview, live) può chiamare gli script esistenti a richiesta, ma il processo resta sotto il tetto.
**Dipendenze:** R1.
**Barra:** `golden-diff` verde su questi endpoint; `POST /api/attesa` e chiusura producono lo stesso stato del vecchio; mutazione: regola del gate alterata, `golden-diff` rosso.
**Fuori:** le pagine di consultazione (restano nel server Bun di Topics).
**Stima:** 3 h.
