# Acceptance — hub-tutto-in-topics

Gli strumenti `golden-diff`, `footprint-bar`, `rollback` e `alias-check` si creano nelle tracce indicate; sono nel repo jarvis, `~/.claude/jarvis/tools/usage-hub/rust/bin/`. «Verde» = exit 0. Nessuna barra tocca un servizio vivo se non nelle tracce C1, C2, Z1, dopo il sì del pacchetto.

## Barra eseguibile

1. **Fotografie uguali (R1-R4).** `golden-diff --old live --new <porta di prova>` esce 0: per ogni endpoint dell'elenco (le 75 fotografie di `test/golden/live` più quelle nuove di `:3335` e `:3336`, create in R1) stesso stato HTTP, stesse chiavi, stessi tipi, stessi valori nei campi stabili. Mutazione: cambiato un campo in una risposta del servizio nuovo, `golden-diff` esce 1.
2. **Footprint (R4).** `footprint-bar` avvia il servizio, lo tiene 10 minuti sotto un carico registrato (messaggi `/v1/messages` finti, gate, pace, tray che interroga ogni 60 s) e legge il footprint fisico (`footprint`, non `ps rss`): esce 0 se resta sotto 60 MB. Oggi: hub 204 MB + switchboard 71 MB.
3. **Il proxy regge (R4, C1).** 100 richieste `/v1/messages` in parallelo verso un finto Anthropic arrivano tutte; col servizio spento la sessione cade su Anthropic dritto (fail-open come oggi); un solo processo scrive lo stato degli account (`lsof` su `profiles.json` e prova di scrittura doppia: esce 1 se due).
4. **Chiamanti passati (C1).** `grep -rn "3335\|3360" ~/.claude/settings.json ~/.zshrc ~/.jcode/config.toml ~/.claude/jarvis/scripts ~/bin` elenca solo alias dichiarati nell'elenco; `alias-check` esce 0 se tutti i chiamanti dell'inventario rispondono dal servizio nuovo (hook di sessione, `delegate`, `punto`, `claude-account`, gate, `museagent`, `usage-watch`).
5. **Porte (C2, Z1).** `curl -sI :3360/` risponde 302 verso Topics; `curl -s :3335/` 302 verso Topics; `/api/*` su entrambe rispondono dal processo nuovo (`lsof -iTCP -sTCP:LISTEN` mostra un solo PID per `:3336`, `:3360`, `:3335`); a fine alias (cron a 24 ore di silenzio) `:3360` e `:3335` non ascoltano più e `lsof` mostra una porta sola.
6. **Tray unita (Y1, Y2, Z1).** `launchctl print gui/501/com.jarvis.claude-usage-tray` esce non-zero (plist in `disabled/`); la tray di Topics mostra quote per account, Mac e PC, progetti, automazioni, backup, freno e processi; spento il server Bun di Topics la tray continua a mostrare i dati dal servizio (barra di prova riscritta: `--snapshot` e `tray-perf.sh` verdi sulla tray nuova). Mutazione: servizio fermo, la tray mostra «offline» e non resta vuota.
7. **Pannelli (S1-S4).** Per ogni gruppo un e2e con hub finto, `pw-remote -- npx playwright test tests/e2e/hub-<gruppo>.spec.ts`, verde, con video `.webm`; uno con l'hub spento: nessuna riga dell'hub, nessun errore. Mutazione: tolta la sorgente hub, l'e2e del gruppo diventa rosso.
8. **A vista (S1-S4, Y1, Y2).** Per ogni posto consegnato uno screenshot affiancato (`~/bin/vis affianca HUB TOPICS`) e il tuo ok. Solo qui una card va in review.
9. **Ritorno indietro (Z1).** `rollback` rimette hub, switchboard e tray vecchi in meno di 60 secondi, con `golden-diff` verde contro di loro; provato una volta prima di spegnere e una volta dopo.
10. **Resta verde ciò che era verde.** `typecheck`, `check:spec-coverage`, `check:route-shadowing`, `check:comment-language` e i test del ponte (`server/routes/hub.test.ts`, `server/lib/hub-live.test.ts`) escono 0 a ogni traccia; `sh ~/.claude/setup/shared/push-guard-test.sh` verde e nessun `/Users/` nei file di Topics.

## Scenari (spec-flow, con video)

- **Riavvio senza buchi.** Topics si riavvia (`topics-riavvio-a-zero-turni`): durante il giro `curl :3336/health`, `/api/pace`, `/api/route` e `POST /api/attesa` rispondono sempre; una sessione Claude aperta non perde il turno.
- **Il vecchio torna.** Servizio nuovo fermato di proposito: `rollback`, e la prossima richiesta di una sessione passa dal vecchio senza errori.
- **La tray non conta il vecchio.** Con il plist vecchio tolto, la barra dei menu ha una sola tray (Topics) e mostra le stesse percentuali di quote del servizio.
- **Bookmark vecchi.** Aprire `http://localhost:3360/#automations` porta alla vista Automazioni di Topics.
