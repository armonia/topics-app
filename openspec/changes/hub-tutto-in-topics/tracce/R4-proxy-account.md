# R4 — Proxy dei messaggi e API degli account (switchboard)

**Cosa:** nel servizio il proxy `POST /v1/messages*`, `count_tokens`, `/health` (anche su `::1`, fail-open: motore giù, le richieste vanno dritte ad Anthropic) e le API di `:3335`: `/api/profiles`, `/api/proxy-status`, `/api/session-start`, `/api/session-stop`, `/api/token-usage` e `/flush`, `/api/switch`, `/api/account-cap`, `/api/account-enabled`, `/api/priority`, `/api/settings`, `/api/refresh`.
**Rischio:** è la traccia che rompe tutto se sbaglia: ogni sessione Claude (Claude Code, figli di `delegate`, workflow, `jcode`, Punto) passa da `:3336`. Refresh dei token OAuth con un solo scrittore dello stato; streaming SSE intero; header e `anthropic-beta` passati uguali.
**Da fare:** soak lungo sul servizio nuovo in parallelo al vecchio (porta di prova), poi confronto delle fotografie; `proxy/sessioni-esterne` (`:3350`, già in Topics) non si tocca: si rebasa dopo che è entrato.
**Dipendenze:** R1.
**Barra:** `golden-diff` verde su `:3335` e `:3336`; 100 richieste in parallelo verso un finto Anthropic arrivano tutte (streaming compreso); servizio spento, la sessione passa dritta; un solo scrittore dello stato (prova di doppia scrittura rossa); `footprint-bar` sotto 60 MB dopo 10 minuti.
**Fuori:** il listener delle sessioni esterne; nuove funzioni di rotazione.
**Stima:** 6 h.
