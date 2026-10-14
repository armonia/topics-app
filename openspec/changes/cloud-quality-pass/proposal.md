# Proposal: cloud-quality-pass

## Why

Il 07/10/2026 Attilio ha chiesto di usare il credito AI per portare topics-app al livello più alto
su ogni asse (pulizia, standard, refactor, prestazioni, idratazione), partendo da Topic e Task,
senza perdere qualità. Il credito è il bonus Max per le sessioni cloud di Claude Code: $250, di cui
$227,50 liberi alle 22:32 del 07/10, scadenza 05/11/2026 alle 08:59. Paga solo le sessioni cloud,
quindi il lavoro gira in VM cloud e il Mac (in produzione, carico 12-13) resta libero.

## What Changes

Sette tracce, ognuna una sessione cloud che parte da questo ramo, legge il suo file in `tracks/` e
consegna un ramo `cloud/<traccia>` con un REPORT in `reports/`:

- **T0** pilota: linea di partenza e costo reale di una sessione, senza correzioni
- **T1** Topic: apertura già idratata, streaming, scroll dei thread lunghi
- **T2** Task: board, scheda, drag, teardown delle tab
- **T3** avvio e bundle
- **T4** codice morto e duplicati, lontano dai file dei rami aperti
- **T5** percorso caldo del server: rotte, processi esterni senza timeout, N+1 su SQLite
- **T6** i 44 cancelli `check:*`: restano quelli che mordono, la barra dura meno

Il comportamento del prodotto non cambia. Ogni ramo arriva su main dopo una revisione
indipendente e la CI verde, fuso in una worktree, mai nel checkout di produzione.

## Barra

La barra per ogni traccia è in `specs/acceptance.md`: `qa-gate.sh --veloce`, `test:unit:shards`,
`build:client` + `check:bundle`, e2e di area con video, più i numeri della traccia misurati prima
e dopo con lo stesso script. Ciò che è verde resta verde. La prova finale è la CI di
`.github/workflows/ci.yml` sul ramo.

## Fuori

Feature nuove, cambi di stack, dipendenze nuove senza un perché scritto, rinomine o
riformattazioni in blocco, migration, il guscio Tauri, le regole del dispatcher della board,
qualunque dato del database vivo in cloud.

## Stop

Ci si ferma quando il credito cloud scende sotto $10 di riserva, oppure quando ogni traccia ha
barra verde, numeri al target e un revisore indipendente (un giro) che non trova difetti
confermati.

## Deciso da me

- Rete «Trusted» dell'ambiente Default, senza toccare la configurazione dell'account: Chromium
  arriva da Chrome for Testing su `storage.googleapis.com` se `cdn.playwright.dev` è chiuso.
  WebKit resta fuori finché la rete non si apre (selettore ambienti su claude.ai/code).
- Bun da npm se quello della VM è sotto la 1.4.0 (il proxy risponde 401).
- T0 su Sonnet (meccanico), T1-T6 su Opus 5.5; budget per traccia = (credito al lancio − $10) /
  tracce rimaste, ricalcolato prima di ogni lancio con `credito-cloud`.
- Le misure che leggono il database vivo (`measure:ui-state-init`, `measure:task-tabs`) restano
  sul Mac, su una copia cestinata subito dopo: `baseline-local.md`.
- Video e trace su rami `-evidenza` separati, mai su main. Il trailer `Claude-Session` resta
  (porta alla sessione che ha prodotto il commit); niente `Co-Authored-By` né «Generated with».
- Nessuna PR durante il pilota. Revisione: una sessione cloud separata o ultrareview finché
  restano le corse gratuite (dopo vorrebbe l'extra usage, che è spento).
