# D3a — report

## Barra

**Prima, misura fornita del 15/10:** 1.890 fork in 15 min (7.560/ora), di cui 1.523 `git`, 193 `lsof`, 85 `vm_stat`, 21 `sysctl`; 19 ricalcoli Git completi in 3 min, con partenze doppie a 0–1 s. **Dopo:** misura di produzione non disponibile; la misura post-merge resta al proprietario. Sul codice locale: 24 test mirati verdi, typecheck 0, lint 0; il test end-to-end del watcher resta rosso per eventi `fs.watch` non consegnati in questa worktree.

## Fatto

- Route e watcher condividono il ricalcolo della stessa generazione Git; un giro precedente al cambiamento non viene riusato e non può sovrascrivere la cache nuova. `bun test server/lib/git-status.test.ts server/routes/process-detection-backoff.test.ts server/lib/spawn-metrics.test.ts`: exit 0, 24 pass, 69 assert. Mutante in copia che impedisce al watcher di unirsi: stesso test exit 1, una asserzione rossa.
- Il watcher ignora `FETCH_HEAD` e segue `HEAD`, indice, `packed-refs` e ref. `bun test server/git-watcher.test.ts -t "fetching without ref changes|only Git paths"`: exit 0, 2 pass, 13 assert; fetch ripetuto senza ref cambiati: exit 0.
- Il detector delle porte si sveglia alla richiesta del pannello Processi e non lancia `lsof` quando la vista è inattiva: `bun test server/routes/process-runtime-cost.test.ts`, exit 0, 4 pass, 25 assert, `lsofSpawns: 0`. Le verifiche cwd dei ghost script persistenti sono limitate a 30/ora. I contatori recenti per Git e innesco, fetch, `lsof`, `vm_stat` e altri spawn sono esposti da `/api/system/status` e mostrati nel pannello Prestazioni in italiano.
- Rimossa la scansione `ps` dei processi CPU top da `/api/system/status`: il client non leggeva quel campo. Anche gli indirizzi in ascolto sono tolti da questa rotta; i lettori restano nei percorsi Processi che li usano.
- `scripts/measure-server-spawns.py` aggiunto con uso e vincolo macOS. Parsing Python: exit 0. Requisito RUNTIME-23 aggiunto.
- `bun run typecheck`: exit 0, 5 sottocheck verdi. `bun run lint`: exit 0, 0 errori e 4 warning preesistenti in file non toccati.

## Trovato e non fatto

- `bun test server/git-watcher.test.ts`: exit 1, 9 pass e 1 fail. Lo scenario già presente `a git operation INSIDE the worktree actually reaches the broadcast` non riceve eventi. Anche una sonda minima `fs.watch` sulla cartella temporanea non ha consegnato eventi; qui non è verificabile il comportamento live del watcher. Il filtro `FETCH_HEAD` e il refresh restano coperti da test deterministici.
- La misura dopo il merge richiede il server di produzione per 15 minuti. Non l’ho avviato né toccato; il proprietario la esegue con lo script aggiunto e confronta i target `<1.000 git/ora`, `<60 lsof/ora`.

## Rifiutato

- `lsof` del controllo identità anteprima e del sidecar Chromium resta: è invocato su avvio/controllo concreto e il risultato identifica chi possiede la porta. È contato, non periodizzato.
- `vm_stat` ogni 10 s resta perché alimenta il campione di memoria usato da capacità e freno swap; sono conteggiati anche il ripiego sincrono e `sysctl`.
