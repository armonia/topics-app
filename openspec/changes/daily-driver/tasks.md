# Tasks: daily-driver

Ogni traccia ha il suo file in `tracks/` e un ramo `daily/<id>`. Lo stato non sta in una casella:
lo dicono il ramo sul remoto (`git ls-remote origin 'daily/*'`), il REPORT in `reports/<id>.md` e
la barra eseguita.

| Traccia | File | Dipende da | Barra (oltre a `specs/acceptance.md`) |
|---|---|---|---|
| D0 misure | `tracks/D0-misure.md` | niente | `check:route-latency` con 8 rotte, che morde con la mutazione; `measure:ws-idle` ripetibile entro il 10% |
| D1 server | `tracks/D1-server.md` | D0 | `git_status` p95 ≤ 20 ms, le altre ≤ 50 ms; `measure:ws-idle --budget 1024` esce 0; 0 spawn di `git status` a progetto fermo |
| D2 webview | `tracks/D2-webview.md` | D0 | `check:growth` con lo scenario nuovo; entry eager compresso ≤ 400 KB; CPU in background ≤ 2%; memoria ≤ 600 MB; ≤ 5.000 nodi DOM con 2.000 messaggi |
| D3 Rust | `tracks/D3-rust.md` | D1, e il suo cancello d'ingresso | parità 30/30 con `git`; freschezza p95 ≤ 150 ms sotto carico; job `tauri` verde su 3 OS con l'addon |
| D4 browser | `tracks/D4-browser.md` | D0, e per B1 il merge del ramo dell'altra sessione | B1 rosso su main e poi verde, primo frame < 0,7 MB sul filo; B2 30/30; B3 con video; `browser/act` p50 ≤ 500 ms |
| D5 sessioni e board | `tracks/D5-sessioni-e-board.md` | niente | cinque scenari con video; la mutazione sul land fa fallire lo scenario dei controlli |
| D6 per tutti | `tracks/D6-per-tutti.md` | niente | primo avvio e relay con video; `install-smoke` verde su 3 OS; barre di `primo-avvio`, `relay`, `device-auth`, `sharing-orgs` |
| D7 affidabilità | `tracks/D7-affidabilita.md` | niente | card e client sopravvivono al SIGTERM (video); spec instabili 20/20; barre di `pane-store-server-authoritative` |
| D8 sicurezza | `tracks/D8-sicurezza.md` | come D4·B1 | le barre private R1, R2 e R3, viste rosse su main; `check:security` esce 0 |

## Ordine

1. **D0 per prima:** senza le sue misure le barre delle tracce di velocità non esistono.
2. **Poi, in parallelo, perché non toccano gli stessi file:**
   - D1;
   - D5, D6 e D7.
3. **D2, D4 e D8 dopo D0.** D4·B1 e D8·R1 aspettano il merge di `topics/browser-mac-scroll-mirror`,
   che tocca gli stessi file.
   - D2 tocca il client in molti punti: si fonde dopo D5, che ne tocca di meno.
4. **D3 solo se il cancello d'ingresso si apre dopo D1.**

Dopo ogni consegna:
- revisione indipendente;
- fusione in una worktree;
- `qa-gate.sh --veloce` sulla fusione;
- PR, CI verde, merge;
- porto in produzione per file.

## Change che questo piano porta a termine

Il piano non le riscrive: ne esegue le barre dentro la traccia indicata.

| Change | Traccia | Stato al 14/10 (caselle, da verificare con i test) |
|---|---|---|
| `primo-avvio` | D6 | decisioni chiuse, niente nel client |
| `relay` | D6 | 14 su 24 |
| `device-auth` | D6 | 19 su 20 |
| `sharing-orgs` | D6 | 26 su 30 |
| `pane-store-server-authoritative` | D7 | 6 su 36 |
| `browser-native-host-cobrowse`, `native-host-dom-sync`, `browser-own-layout` | D4 | vedi la traccia |
