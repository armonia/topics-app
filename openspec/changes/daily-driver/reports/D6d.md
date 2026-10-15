# D6d · L'installato si prova da una macchina pulita

## Barra

- Locale: parse YAML (Bun) exit 0; `bash -n` sui 7 step Bash exit 0. `actionlint` e `pwsh` non sono
  installati qui: i due step PowerShell li prova il runner Windows.
- CI: `gh workflow run install-smoke.yml --repo armonia/topics-app -f tag=latest`, verde su macOS,
  Windows e Ubuntu.
- Mutante: la rotta di salute `/api/topics` diventa `/api/health` (non esiste); i tre sistemi devono
  fallire al passo «Salute».

## Fatto

- **`.github/workflows/install-smoke.yml`.** Sceglie la release (input `tag`, predefinito `latest`) e
  la precedente pubblicata; scarica l'asset del sistema (`Topics_*_universal.dmg`,
  `Topics_*_x64_en-US.msi`, `Topics_*_amd64.deb`); installa la precedente come una persona (DMG copiato
  in `/Applications`, `msiexec /qn`, `apt-get install`), avvia il server, aspetta la salute, lo ferma;
  installa la nuova sopra e rifà il controllo. Ogni errore dice il passo (Scaricamento, Installazione,
  Avvio, Salute, Aggiornamento) e i log del server sono allegati come artifact.
- **Il server parte come lo fa partire l'app** (`desktop-tauri/src-tauri/src/lib.rs`): con la pagina
  del pacchetto (`TOPICS_PUBLIC_DIR`) e il bridge PTY Rust accanto al server quando c'è
  (`TOPICS_PTY_BRIDGE_BIN`, altrimenti `TOPICS_DISABLE_PTY_BRIDGE` come fa l'app). La prima versione
  lo avviava senza pagina e con il bridge spento, cioè non come lo usa nessuno.
- **Salute:** `GET /api/topics` 200 entro 20 s, poi `GET /` 200. La prima è la rotta pubblica che usa
  anche `scripts/build-server-sidecar.sh smoke` (`/api/health` non esiste, `/__daemon/healthz` vuole un
  token). La seconda prende il pacchetto che ha perso `public/`: la finestra grigia, già successa.
- **Quando parte:** a mano, e dopo ogni giro riuscito di «Auto-bump patch» che ha pubblicato una
  release. Non su `release: published`: la release la pubblica il `GITHUB_TOKEN` dentro auto-bump
  (`workflow_call`), e un evento di quel token non avvia altri workflow. Auto-bump gira ogni 10 minuti
  e pubblica solo quando main si muove: il job prosegue solo se l'ultima release è stata pubblicata
  dopo l'inizio di quel giro.
- **Le differenze** fra server del checkout e installato, col perché di ognuna, stanno in un posto
  solo: `openspec/specs/releasing/spec.md`, «Percorsi del server».

## Fuori

- Il processo di release e la firma dei pacchetti non cambiano.
- Il bridge PTY è avviato ma non interrogato: la sonda del socket arriva con D6c (`/api/system/status`).
