# Linea di partenza nella VM cloud (T0)

Misurata il 07/10/2026, dalle 20:51 alle 21:30 UTC (39 minuti in tutto, setup compreso),
sul ramo `cloud/t0-baseline` = `master` della VM (commit `ca3a1b6`, «seed») senza modifiche al
codice. Nessun file di codice toccato: `git status` pulito dopo ogni passo.

VM: Ubuntu 24.04 x86_64, 4 vCPU, 15 GB. `uptime` accanto a ogni misura: load average 0,1-0,6
all'avvio di ciascun passo (macchina quieta), tranne dove scritto.

## Versioni e origine

| Cosa | Versione | Nota |
|---|---|---|
| Bun | 1.4.2 | già installata, sopra la 1.4.0: nessun `npm i -g bun` necessario |
| Node | v20.20.0 | `/opt/node20/bin` |
| Playwright | 1.59.1 | `@playwright/test` del lockfile |
| Chromium | 147.0.7727.15 (rev. 1217) | **Chrome for Testing da `storage.googleapis.com`**, non da Playwright |
| ffmpeg | rev. 1011 | copiato da `/opt/pw-browsers/ffmpeg-1011` (serve al video) |
| WebKit | assente | `cdn.playwright.dev` risponde 403: il progetto `webkit` non gira |

`PLAYWRIGHT_BROWSERS_PATH` nella VM vale `/opt/pw-browsers` (ci sono solo `chromium-1194` e
ffmpeg, revisione vecchia). Per usare quello scaricato:
`export PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright`. Senza, Playwright cerca
`/opt/pw-browsers/chromium_headless_shell-1217` e non parte.

Il remoto `origin` non esiste in questa VM (snapshot senza remote). `git fetch origin main` dei
passi di setup esce 128. Per i cancelli che leggono `origin/main` è stato creato il ref con
`git update-ref refs/remotes/origin/main HEAD` (lo snapshot è main del 07/10 più i soli documenti
di questa change). Il push non è possibile: la consegna è nel testo del messaggio finale.

## Variabile obbligatoria per gli E2E e i banchi: `SERVER_HOST=127.0.0.1`

Il server si lega a `::` (`server.ts:3400`) e la VM non ha IPv6: `listen` dà `EAFNOSUPPORT`
(`server/services/daemon-state.ts:454`), il server di prova su :13334 non risponde entro 30 s e
`check:ink` / `check:drag` escono 2 con «Test server did not start within 30000ms». Con
`export SERVER_HOST=127.0.0.1` (l'override esiste già) il server parte. Tutti i numeri sotto,
E2E e banchi, sono misurati con quella variabile. Le prove senza variabile: `check:ink` 34 s
exit 2, `check:drag` 32 s exit 2.

## Setup

| Passo | Durata | Esito |
|---|---|---|
| `bun install --frozen-lockfile --ignore-scripts` (radice) | 5 s | 0 |
| `npm rebuild node-pty` | 7 s | 0 |
| `fix-node-pty-exec-bit.ts` | 0 s | 0 |
| `bun install --frozen-lockfile` (client) | 6 s | 0 |
| `git fetch origin main` | 0 s | 128 (nessun remote), sostituito da `update-ref` |
| `npx playwright install --with-deps chromium` | 41 s | 1 (403 su `cdn.playwright.dev`) |
| Chrome for Testing dalla fonte Google (due zip) | 23 s | 0 |
| `npx playwright install-deps chromium` | 55 s | 0 |
| ffmpeg copiato, `export` delle due variabili | 1 s | 0 |

Setup totale: 2 min 39 s (20:51:39 → 20:54:18). Sessione intera fino al REPORT: 39 minuti.

## La barra, una volta

| Comando | Exit | Numero/i | Durata | Nota |
|---|---|---|---|---|
| `./scripts/qa-gate.sh --veloce` | **1** | 24 cancelli verdi su 25, 1 rosso (`check:security`) | 292 s | vedi sotto: `typecheck` 121 s e `lint` 134 s sono il 87% |
| `bun run test:unit:shards` | **1** | 20.953 passati, 13 rossi, 62 saltati, in 1.829 file; fase 2 (3 file seriali) verde | 701 s | 2 shard (default dello script), 657 s e 499 s; fase 2 44 s. Rilanciati da soli: 12 restano rossi, 1 è flaky (vedi sotto). Il conto dei passati non include la fase 2, che non stampa il suo |
| `bun run build:client` | 0 | `index-DXtTfbVQ.js` | 31 s | build Vite 28 s |
| `bun run check:bundle` | 0 | chunk eager **raw 1.669.264 B (1.630 KB), gzip 532.452 B (520 KB)**; baseline raw 1.647.998, gzip 523.275 | 0 s | sul percorso critico (5 file): raw 2.293.418, gzip 694.130; asset totali raw 8.761.725. Dentro il budget |

Barra intera (qa-gate + unit + build + bundle) = 292 + 701 + 31 + 0 ≈ 1.024 s ≈ **17 minuti**,
quasi tutta serializzata.

### `qa-gate.sh --veloce`, una riga per cancello

| Cancello | Esito | s |
|---|---|---|
| check:any | verde | 0 |
| check:any-budget | verde (339 `any`, esattamente il tetto) | 0 |
| check:ref-callbacks | verde (378 file) | 0 |
| check:nul | verde | 0 |
| check:eslint-disable | verde (3.502 file) | 1 |
| check:test-skips | verde (24 skip/fixme, baseline 24) | 0 |
| check:emdash | verde (1.772 file) | 1 |
| check:bloat | verde (126 file sopra 800 righe, 482 righe duplicate) | 3 |
| check:route-shadowing | verde | 2 |
| check:typography | verde (1.680 file) | 4 |
| check:ui-language | verde | 1 |
| check:comment-language | verde | 2 |
| check:identifier-language | verde (5.424 nomi non inglesi, tutti in baseline) | 1 |
| check:sleeps | verde | 0 |
| check:tmp-canonical | verde | 0 |
| check:module-mock-restore | verde (26 file) | 0 |
| check:api-door | verde | 0 |
| check:untraced-tests | verde (0 file) | 1 |
| check:spec-coverage | verde (0 scoperti) | 0 |
| check:migrations | verde (184 file vs origin/main) | 0 |
| **check:security** | **ROSSO** | 3 |
| check:deadcode | verde | 9 |
| check:deadcode-blindspots | verde | 9 |
| typecheck | verde | 121 |
| lint | verde | 134 |

(La riga di `secrets` e `dependencies` dentro `check:security` sono verdi; il rosso è il pezzo
`home`: 8 avvisi dipendenze, tutti nella baseline del 2026-10-06.)

Il rosso di `check:security` e il rosso di `tests/unit/no-home-paths-tracked.test.ts` (sotto)
sono lo stesso difetto d'ambiente: in questa VM `HOME=/root`, e la stringa `/root` compare in
13 file tracciati (18 occorrenze) come parte di `/pinned/root` e simili. Su un Mac o su `/home/runner` non
accade. Non è un difetto del codice di main.

### I 13 rossi di `test:unit:shards`, rilanciati ciascuno da solo

| Test | Dopo il rilancio | Prima riga dell'errore | Causa |
|---|---|---|---|
| `scripts/reload-gate-migration.test.ts` A, F | rosso (2) | `expect(code).toBe(1)`, ricevuto 0 (`:118`, `:229`) | non indagata; il cancello esce 0 con una migration rotta |
| `server/services/worktree-manager.test.ts` «cartella che non si puo' togliere» | rosso | `toBeInstanceOf(WorktreeOperationError)`, ricevuto `null` | gira come root: `chmod 0555` non impedisce nulla (`:121`) |
| `server/lib/file-tree.test.ts` «cannot be stat-ed» | rosso | `toEqual` fallito | root ignora `chmod 0444` (`:52`) |
| `server/lib/loopback-probe.test.ts` «SOLO su ::1» | rosso | `Failed to listen at ::1` | niente IPv6 (`:50`) |
| `tests/integration/installed-app-home-isolation.test.ts` (2) | rosso (2) | `the server never answered on <porta>` | `EAFNOSUPPORT`, niente IPv6 |
| `tests/integration/leak-ws-registries.test.ts` | rosso | `the spawned server never answered` | idem |
| `tests/integration/topic-read-seen-propagation.test.ts` | rosso | `the spawned server never answered` | idem |
| `server/routes/processes.shell-sweep.test.ts` | rosso | `isAlive(pid)` atteso false, ricevuto true (`:63`) | non indagata; ipotesi: figli zombie non raccolti, nessun init che li raccolga |
| `scripts/check-security.test.ts` «la copia parte verde» | rosso | `Expected to contain: "pubblicabile"` | `HOME=/root`, come sopra |
| `tests/unit/no-home-paths-tracked.test.ts` | rosso | «questi file tracciati contengono il percorso della tua home» | `HOME=/root`, come sopra |
| `server/attention/system-notices.test.ts` «a freeze and its thaw» | **verde da solo (3 pass)** | | flaky sotto carico dei 2 shard |

I test dei server spawnati nei test di integrazione non ereditano `SERVER_HOST`: provato
(stessi 3 file, ancora rossi). Per vederli verdi servirebbe un fix nel codice, non una variabile.

## Le misure

| Comando | Exit | Numero/i | Durata | Nota |
|---|---|---|---|---|
| `check:ink` | 0 | card **44,7 ms** (max 77,3) · tab **26,5 ms** (max 26,6) · invio messaggio **18,9 ms** (max 31,8); mediana di 5, budget mediana ≤ 100 ms | 13 s | senza `SERVER_HOST` exit 2 |
| `check:drag` | **2** | p95 frame 16,7 ms (budget 16,7), peggior frame 33,3 ms (budget 100), long task 0; 137 frame, 986 px, 3 drop | 22 s | non misurato: calibrazione a riposo 16,7 ms ≥ budget (display a 60 Hz, headless) |
| `check:scroll-fluidity` | **2** | frame persi 20,35 % (budget 30), buco peggiore 50,1 ms (budget 30), long task 0 ms | 35 s | non misurato: cadenza 16,7 ms contro gli 8,3 ms della baseline (2,0x) |
| `check:growth` | 0 | 50 cicli, heap 16,39 → 22,27 MB (×1,359, budget ×1,51) · nodi DOM 530 → 604 (×1,14, budget ×1,4) · listener 992 → 1052 (×1,06, budget ×1,2) | 141 s | «la sessione resta piatta» |
| `check:route-latency` | **2** | p50: topics 1,28 ms (base 0,45), topic_messages 9,8 (3,57), all_boards_tasks 10,56 (3,92), dispatch_capacity 1,27 (0,32); 25 campioni × 2 passate, 150 topic / 3000 messaggi | 5 s | non misurabile: «il tubo è fuori scala», `dispatch_capacity` 1,27 ms > 0,8 ms; la baseline è del Mac, la VM è ~3x più lenta |
| `check:deadcode` | 0 | **0 file, 0 export, 0 tipi, 0 dipendenze inutilizzati**; 25 «configuration hints» e 1 «tag hint» | 8 s | nessun problema segnalato: vedi «Per le tracce» |
| `check:any-budget` | 0 | 339 `any`, esattamente il tetto | 1 s | |

`check:route-latency` stampa solo una cifra per rotta (le passate: 1,25/1,28; 9,7/9,8;
10,56/8,18; 1,27/1,24): il p95 non è esposto quando il banco si astiene.

LOC (`git ls-files <dir> | xargs cat | wc -l`): `client/src` 322.025 · `server` 369.104 · `shared` 29.554.

## Non gira qui

| Comando | Motivo |
|---|---|
| `measure:ui-state-init` | vuole una copia del database vivo, che non esce dal Mac (dati di persone vere). Misurato sul Mac: 314,1 KB → 135,1 KB, vedi `baseline-local.md` |
| `measure:task-tabs` | idem. Sul Mac: 381 righe `task-browser-*` (143.246 B, 52,3 %), 0 da rilasciare, vedi `baseline-local.md` |
| `probe:boot-memory` | usa `vmmap` e `phys_footprint`, solo macOS. Nemmeno sul Mac misurato |
| progetto `webkit` | WebKit scende solo da `cdn.playwright.dev`, 403 dalla rete della VM |
| `desktop-tauri/`, job `tauri` | guscio Tauri, non gira qui |
| `check:drag`, `check:scroll-fluidity`, `check:route-latency` | girano ma escono 2 (non misurato), motivo nella tabella sopra; vanno letti come «non misurato», non come verdi |

## E2E con video (progetto `chromium`, `E2E_EVIDENCE=1 E2E_VIDEO=1`, `SERVER_HOST=127.0.0.1`)

Senza `E2E_TIER=pr`: tutte le spec elencate girano (incluse quelle «nightly»), 1 retry.

| Gruppo | Passati | Rossi | Flaky | Saltati | Durata |
|---|---|---|---|---|---|
| Topic (13 file) | 75 | 0 | 0 | 0 | 294 s (4,9 min) |
| Task (12 file) | 19 | 0 | 0 | 1 | 154 s (2,6 min) |

Il saltato: `board-card-stop.spec.ts` «col dito: il long-press apre lo STESSO menu», richiede il
progetto `chromium-touch-wide`. Nessun rosso, quindi nessun rilancio.

Prove (restano nella VM, non committate): 83 video + 75 trace per Topic (44 MB), 21 video per Task
(18 MB) sotto `scratchpad/evidenza/{topic,task}`; il più grande è
`chat-scroll-down-jitter-…-trackpad-chromium/video.webm`, 2,6 MB.

## Visto, non toccato

- `server.ts:3400`: l'host di default è `::` e non c'è ripiego su `127.0.0.1` quando `listen`
  dà `EAFNOSUPPORT` (`server/services/daemon-state.ts:454`). Su una VM senza IPv6 il server non
  parte da solo; oggi lo salva solo `SERVER_HOST`, che i test di integrazione spawnati non
  ereditano. Costa 4 test di integrazione rossi e `loopback-probe.test.ts:50`.
- `tests/unit/no-home-paths-tracked.test.ts:45` e `:147`: `HOME` corto (`/root`) combacia con
  sottostringhe innocue (`/pinned/root`): 18 occorrenze in 13 file tracciati. Falso positivo che rende
  rosso `check:security` e la barra su ogni VM che gira come root.
- `server/lib/file-tree.test.ts:52` e `server/services/worktree-manager.test.ts:121`: i test
  contano su `chmod` che per root non vale. Servono `skipIf(process.getuid() === 0)` o un altro
  modo di rendere la cartella non scrivibile.
- `scripts/reload-gate-migration.test.ts:118` e `:229`: il cancello esce 0 con una migration
  rotta, nella VM. Da indagare, non è chiaro se sia un difetto del cancello o dell'ambiente.
- `server/routes/processes.shell-sweep.test.ts:63`: i pid catturati risultano ancora vivi dopo lo
  sweep (zombie non raccolti?).
- `scripts/ai-review-screenshots.py:23`: scrive `./test-results/ai-review.json` senza creare la
  cartella; `global-teardown` stampa un traceback quando non ci sono screenshot (non cambia
  l'esito).
- `scripts/test-unit-shards.ts:396`: gli shard di default sono 2 (anche la riga 70 lo dice), non
  4 come dice la traccia. `TOPICS_UNIT_SHARDS=4` ne darebbe 4, con più contesa; non provato.
- `playwright.config.ts:132` e nota di setup: ffmpeg di Playwright non scende da
  `cdn.playwright.dev`; con `E2E_VIDEO=1` e senza ffmpeg ogni test fallisce con «Video rendering
  requires ffmpeg binary».
- `scripts/check-repo-pulito.ts`: esce 1 nella VM («2 rami oltre main»: `master` e il ramo di
  consegna, perché il ref `origin/main` è stato creato a mano). Non è nella barra `--veloce`; è un
  effetto dello snapshot senza remote, non del codice.
- `knip.jsonc`: 25 «configuration hints» (voci ridondanti: `axe-core`, `vm_stat`, `server.ts`,
  14 `scripts/*.ts!`, ...) e un tag inutile in
  `client/src/state/pane/adapters/projectLayoutSync.ts` (`__resetProjectSyncForTests → @knipignore`).

## Per le tracce

- **Quanto dura la barra intera qui:** ≈ 17 minuti senza E2E (qa-gate 292 s, unit 701 s, build
  31 s), più 5-8 minuti di E2E per area: ≈ 25 minuti. Una barra a ogni fix non si può: ogni 3-5
  fix, come dicono le regole.
- **In background (log + attesa):** `test:unit:shards` (701 s), tutto `qa-gate.sh --veloce`
  (292 s), `check:growth` (141 s) e i due gruppi E2E (294 s e 154 s). Sotto i 40 s: in primo
  piano.
- **Non lanciare insieme** i banchi di tempo con la suite unit o con `qa-gate`: misurano la
  macchina. Questa baseline li ha lanciati uno alla volta, quieti.
- **Dentro `qa-gate --veloce`:** `typecheck` (121 s) e `lint` (134 s) sono 255 s su 292, e girano
  in serie. Per T6 (−30 %) basta farli parallelizzare (4 vCPU) o saltare i pezzi non toccati.
  Tutti gli altri 23 cancelli insieme: 37 s.
- **Setup da rendere più veloce:** (1) `export PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright`
  e (2) `export SERVER_HOST=127.0.0.1`, senza i quali nulla di E2E parte; (3) saltare
  `playwright install --with-deps chromium` (41 s buttati su un 403) e andare diretti a Chrome
  for Testing (23 s) + `install-deps` (55 s, già «0 newly installed»: si può saltare se i
  pacchetti ci sono); (4) copiare `ffmpeg-1011` da `/opt/pw-browsers`; (5) `update-ref` per
  `origin/main`. Un solo script `setup-cloud.sh` raccoglierebbe tutto (durata stimata, non provata: il grosso sono i 23 s di Chrome for Testing e i 18 s di `bun install`).
- **Rossi che c'erano già (non sono delle tracce):** i 13 test del punto «I 13 rossi» e
  `check:security` (rosso unico della barra veloce). Una traccia che li vede rossi dopo un fix
  confronti con questa lista.
- **Per T1, T2:** `check:drag` e `check:scroll-fluidity` escono 2 qui (60 Hz contro 120 Hz
  della baseline): i target «p95 < 16,7 ms» e «−50 % frame persi» non si possono giudicare in
  questa VM con questi banchi. `check:ink` sì: card 44,7 ms, tab 26,5 ms. La prova dei video e
  `check:ink` sono ciò che T1/T2 possono usare.
- **Per T4:** knip non segnala nulla (0 file, 0 export, 0 tipi, 0 dipendenze). Il target
  «−50 % su file ed export» ha base 0 e non è misurabile con `check:deadcode`. T4 deve partire
  da un'altra fonte (il cancello può essere cieco: `check:deadcode-blindspots` verde, 9 s) o
  ridefinire il numero.
- **Per T5:** `check:route-latency` non è misurabile qui (tubo fuori scala: 1,27 ms contro
  0,8 ms). Il target «p95 −30 % su 2 rotte» non si può giudicare; servono confronti
  prima/dopo nella stessa VM con lo stesso script, non contro la baseline del Mac.
- **Per T3:** chunk eager gzip 532.452 B (520 KB), raw 1.669.264 B; il target −20 % è
  426.000 B gzip. L'avvio del server non è stato misurato qui (nessun comando della barra lo
  stampa).
