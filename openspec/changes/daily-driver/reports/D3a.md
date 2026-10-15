# D3a — report

## Barra

**Prima, misura fornita del 15/10:** 1.890 fork in 15 min (7.560/ora), di cui 1.523 `git`, 193 `lsof`, 85 `vm_stat`, 21 `sysctl`; 19 ricalcoli Git completi in 3 min, con partenze doppie a 0–1 s. **Dopo i giri 1-2, in produzione il 15/10 (15 min, `scripts/measure-server-spawns.py`):** 1.621 fork, di cui 1.378 `git` (5.512/ora) e 238 `lsof` (952/ora): **rossa**, obiettivi `<1.000 git/ora` e `<60 lsof/ora`. Il giro 3 qui sotto cerca le cause sul server vivo e le toglie; la misura dopo il giro 3 è in fondo.

## Fatto

- Route e watcher condividono il ricalcolo della stessa generazione Git; un giro precedente al cambiamento non viene riusato e non può sovrascrivere la cache nuova. `bun test server/lib/git-status.test.ts server/routes/process-detection-backoff.test.ts server/lib/spawn-metrics.test.ts`: exit 0, 24 pass, 69 assert. Mutante in copia che impedisce al watcher di unirsi: stesso test exit 1, una asserzione rossa.
- Il watcher ignora `FETCH_HEAD` e segue `HEAD`, indice, `packed-refs` e ref. `bun test server/git-watcher.test.ts -t "fetching without ref changes|only Git paths"`: exit 0, 2 pass, 13 assert; fetch ripetuto senza ref cambiati: exit 0.
- Il detector delle porte si sveglia alla richiesta del pannello Processi e non lancia `lsof` quando la vista è inattiva: `bun test server/routes/process-runtime-cost.test.ts`, exit 0, 4 pass, 25 assert, `lsofSpawns: 0`. Le verifiche cwd dei ghost script persistenti sono limitate a 30/ora. I contatori recenti per Git e innesco, fetch, `lsof`, `vm_stat` e altri spawn sono esposti da `/api/system/status` e mostrati nel pannello Prestazioni in italiano.
- Rimossa la scansione `ps` dei processi CPU top da `/api/system/status`: il client non leggeva quel campo. Anche gli indirizzi in ascolto sono tolti da questa rotta; i lettori restano nei percorsi Processi che li usano.
- `scripts/measure-server-spawns.py` aggiunto con uso e vincolo macOS. Parsing Python: exit 0. Requisito RUNTIME-24 aggiunto (RUNTIME-23 è di D2a).
- `bun run typecheck`: exit 0, 5 sottocheck verdi. `bun run lint`: exit 0, 0 errori e 4 warning preesistenti in file non toccati.

## Trovato e non fatto

- `bun test server/git-watcher.test.ts`: exit 1, 9 pass e 1 fail. Lo scenario già presente `a git operation INSIDE the worktree actually reaches the broadcast` non riceve eventi. Anche una sonda minima `fs.watch` sulla cartella temporanea non ha consegnato eventi; qui non è verificabile il comportamento live del watcher. Il filtro `FETCH_HEAD` e il refresh restano coperti da test deterministici.
- La misura dopo il merge richiede il server di produzione per 15 minuti. Non l’ho avviato né toccato; il proprietario la esegue con lo script aggiunto e confronta i target `<1.000 git/ora`, `<60 lsof/ora`.

## Rifiutato

- `lsof` del controllo identità anteprima e del sidecar Chromium resta: è invocato su avvio/controllo concreto e il risultato identifica chi possiede la porta. È contato, non periodizzato.
- `vm_stat` ogni 10 s resta perché alimenta il campione di memoria usato da capacità e freno swap; sono conteggiati anche il ripiego sincrono e `sysctl`.

## Giro 2 (rilettura)

- **Il ricalcolo dopo un fetch vuoto c'era ancora, e non per `FETCH_HEAD`.** Misurato con `fs.watch` sulla `.git` di una clone (git 2.50.1): un `git fetch --all --prune` che non porta niente tocca `FETCH_HEAD`, `refs/remotes/origin/HEAD.lock` e `objects/maintenance.lock`. Il watcher ricorsivo di `refs/` prendeva il `.lock` per un cambiamento. Un ref che si muove davvero arriva anche col suo nome finale (`refs/remotes/origin/main`). Ora sotto `refs/` un `.lock` non conta (`refPathAffectsStatus`). Il test «fetching without ref changes» era rosso sul giro 1 anche sul Mac (fuori dalla sandbox gli eventi arrivano), ora è verde; mutante con i `.lock` che contano: rosso.
- **La rotta del fetch invalidava sempre.** Ora solo se git ha stampato ref aggiornati su stderr (un fetch vuoto non stampa niente: lo fissa un test con una clone vera che spinge un commit).
- **Una raffica di eventi poteva rispondere con un giro di prima.** Il giro 1 avanzava la generazione solo al primo evento della raffica: un lettore partito fra due eventi teneva la stessa generazione e il refresh del watcher si univa al suo giro, che poteva aver letto l'albero prima del secondo. Ora ogni evento avanza la generazione (`gitChangeDebouncer`). Test: due eventi, un refresh, con la generazione dell'ultimo; mutante «solo il primo avanza»: rosso.
- Requisito rinumerato **RUNTIME-24**: RUNTIME-23 è di D2a (PR #342). Stringhe del pannello in i18n, commento in inglese, `@covers` sul test dei contatori.
- `bun test server/git-watcher.test.ts server/lib/git-status.test.ts server/lib/spawn-metrics.test.ts`: 32 pass. `typecheck`, `lint` exit 0; 20 cancelli statici, 0 rossi.

## Giro 3 (15/10): la misura in produzione era rossa

- **Chi lanciava cosa.** I contatori di `/api/system/status` nei 15 minuti misurati: `lsof` 60 dal poll della lista script, 120 e 60 dalla rilevazione processi (cwd e porte); ricalcoli dello stato git 155 per cache scaduta contro 15 dal watcher. Un campione di 3 minuti dei figli del server con la loro riga di comando: 46 `lsof`, 50 `ps`, 27 `git rev-parse --git-common-dir` (che il contatore non vedeva), una dozzina di `git` dello stato.
- **`lsof` col pannello Processi chiuso.** Ogni sidebar di progetto interroga `GET /api/scripts` ogni 15 s per i pallini dei processi. Quella richiesta leggeva le porte (un `lsof`) e svegliava la rilevazione, che restava a 4 s (cwd e porte, un `lsof` ciascuno) finché una finestra era aperta, anche nascosta. Ora porte e risveglio solo con `?ports=1`, che manda solo il pannello Processi, l'unico che disegna le porte (`useScripts({ ports: true })`); il poll dorme a pagina nascosta (`startVisibleInterval`) e riparte con un aggiornamento al ritorno.
- **La radice git della memoria.** `claudeMemoryDir` teneva fresca la radice con un timer: ogni 10 s un `git rev-parse` per ogni cartella letta negli ultimi 10 minuti. Ora una lettura oltre i 5 minuti risponde subito con la radice nota e chiede a git dietro, in asincrono; nessuno legge, nessuno chiede. Solo una cartella mai vista chiede in modo sincrono, come prima.
- **Lo stato git sorvegliato durava quanto il poll.** Con i due watcher vivi una voce valeva 60 s, la cadenza del poll di ogni finestra: ogni poll la trovava scaduta e pagava cinque `git`, una volta al minuto per progetto aperto senza che niente cambiasse. Ora 5 minuti: un cambiamento la invalida da sé, il tetto resta per l'evento che un watcher perde.
- Test: `processes.scripts-ports.test.ts` (rotta vera, un comando che gira, orologio oltre le cache: il poll senza `ports` non lancia `lsof` né sveglia la rilevazione, quello con `ports=1` sì), due casi nuovi in `useScripts.test.ts`, i casi della radice e del tetto aggiornati. Sei mutanti in copia, ciascuno rosso sul suo test: risveglio sempre, porte sempre, client senza `ports`, `setInterval` nudo, radice chiesta in modo sincrono, tetto a 60 s.

## Trovato e non fatto (giro 3)

- `ps -axo pid=,ppid=` circa 1.000/ora (50 in 3 minuti): la tabella dei processi con cache di 2 s, letta da picchi di memoria delle card, governatore del budget e rilevazione. Non è negli obiettivi di D3a; con la rilevazione spenta a pannello chiuso ne resta una parte, da misurare.
