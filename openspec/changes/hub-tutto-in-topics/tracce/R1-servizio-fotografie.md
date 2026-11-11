# R1 — Servizio Rust: scheletro, fotografie, strumenti di confronto

**Cosa:** il crate (repo jarvis, `tools/usage-hub/rust/`, continua `hub-core`) diventa il servizio: un processo, un listener su `:3336` più alias `:3360` e `:3335`, `/health`, stato in `~/.claude/jarvis/state` sotto un solo scrittore, log. Si registrano le fotografie di tutto ciò che oggi risponde.
**Da fare:**
- `golden-diff --old live --new PORTA`: confronta stato, chiavi, tipi e campi stabili; elenco endpoint = `test/golden/live` (75 file) più nuove fotografie di `:3335` (profiles, proxy-status, token-usage, settings, sessions…) e `:3336` (`/health`, `count_tokens`, `/v1/messages` con finto Anthropic).
- `footprint-bar` e `rollback` (scheletro: rimette i plist vecchi).
- Il binario gira solo da banco su porta alta finché non si arriva a C1 (come `hub-core`, che oggi rifiuta 3360 e 3335 apposta).
**Dipendenze:** nessuna.
**Barra:** `golden-diff` contro il vecchio con il servizio che risponde 501 a ciò che non è ancora portato: elenca gli endpoint mancanti ed esce 1; `footprint-bar` esce 0 a vuoto sotto 20 MB; `cargo test` verde.
**Fuori:** portare gli endpoint (R2-R4).
**Stima:** 2 h.
