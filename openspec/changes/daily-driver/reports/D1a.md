# D1a · cache git e albero file

**Barra prima** (main, misure di produzione del 14/10 in `baseline.md`): stato git con TTL di 5 s, cioè un calcolo da cinque spawn a ogni poll; `git/status` p95 385 ms, massimo 12,6 s. `/api/files` rifà la visita dell'albero a ogni richiesta: p95 349 ms, massimo 40,1 s. Il giro 1 di questa traccia aveva reso la finestra di 60 s scorrevole e la concedeva col solo watcher di `.git`: un evento perso o una modifica al worktree potevano restare invisibili senza limite. Il giro 2 lo corregge, e corregge la barra del piano («0 spawn in 10 minuti» vorrebbe dire nessun tetto).

**Barra dopo:** entrambi i watcher vivi: età fissa dalla scrittura, 11 calcoli in 10 minuti inclusa la lettura iniziale, contro 40 col TTL di 5 s. Solo watcher `.git`: 40 calcoli. Un file non segnalato viene visto alla prima lettura dopo 60 s. Albero con watcher: massimo 11 visite in 10 minuti; senza watcher TTL 5 s. Invalidazione watcher: lettura successiva fresca. La mutazione che rinnova la finestra fallisce per entrambe le cache. `bun run typecheck` e `bun run lint:server` exit 0. `bun test` delle due cache exit 0; i test watcher hanno rossi preesistenti (stesso esito contro i file originali).

## Fatto

- `server/lib/git-status-cache.ts`, `server/file-watcher.ts`, `server/git-watcher.ts`: il TTL git non si rinnova leggendo; i 60 s si attivano solo con watcher `.git` e file vivi. La rimozione del watcher file ripristina il TTL di 5 s. `TOPICS_E2E_GIT_STATUS_TTL_MS=0` resta un miss forzato.
- `server/lib/file-tree-cache.ts`: TTL fisso dalla visita, 60 s con watcher file vivo e 5 s altrimenti.
- `tests/e2e/file-explorer-external-git-update.spec.ts`: lo scenario esterno resta pronto; `typecheck:e2e` è incluso nel typecheck verde.
- Barra aggiornata in `tracks/D1-server.md`: 11 calcoli col tetto di 60 s contro 40 col TTL di 5 s; mutazione sulla finestra rinnovata dalle letture.
- `bun run typecheck`: exit 0, client, test client, server (0 errori), e2e e relay. `bun run lint:server`: exit 0.
- `bun test server/lib/git-status.test.ts server/lib/file-tree-cache.test.ts`: exit 0, 19 pass, 0 fail. Le copie mutate in `/private/tmp/d1a-mutation` fanno fallire entrambi gli invarianti, come atteso: «git: test fails after read-renewal mutation», «tree: test fails after read-renewal mutation»; il controllo termina exit 0 perché entrambe le mutazioni sono rilevate.

## Trovato e non fatto

- `bun run check:route-latency`: exit 2 sulla baseline locale priva delle quattro rotte `git_status`, `files`, `scripts`, `system_status`; manca una baseline aggiornata, perciò la misura di latenza non è disponibile.
- `server/file-watcher.test.ts`: exit 1, 2 pass e 1 fail dopo 120 s: il 25° progetto non emette `files:changed`. La copia della spec, importata contro l'originale `git show HEAD:server/file-watcher.ts`, dà lo stesso rosso, exit 1 dopo 120 s; il difetto precede D1a. Il conteggio a 24 watcher e la prova di broadcast richiedono diagnosi separata.
- `server/git-watcher.test.ts`: exit 1, 7 pass e 1 fail sul broadcast dopo `git add`. La stessa spec contro `git show HEAD:server/git-watcher.ts` dà 7 pass e 1 fail, exit 1; il rosso è preesistente e richiede diagnosi separata.
- Scenario browser con video: non eseguito in questo giro; richiede la spec isolata Chromium e il relativo `.webm`.

## Rifiutato

- Il TTL a zero non è una regressione: è attivo solo con `TOPICS_E2E=1` e `TOPICS_E2E_GIT_STATUS_TTL_MS=0`, per forzare il miss del banco.
