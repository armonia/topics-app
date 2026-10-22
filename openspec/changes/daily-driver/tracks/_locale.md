# Regole per le tracce scritte in locale sul Mac

Leggi per intero questo file, poi questi tre, e solo dopo parti:
- `openspec/changes/daily-driver/tracks/_comuni.md`;
- `openspec/changes/cloud-quality-pass/tracks/_comuni.md`: valgono «La barra», «Recinto», «Prova» e
  «Commit e consegna» come regole di lavoro; setup della VM, push e bundle qui non valgono;
- il file della tua traccia, indicato nel prompt.

Se non riesci a leggerli per intero, fermati e dillo.

Nessuno risponde alle tue domande: decidi, scrivi il perché nel REPORT, vai avanti.

## Dove sei

- **Una worktree di topics-app**, la cartella da cui parti, sul ramo `daily/<id>` nato da
  `origin/main`. Lavori solo qui dentro.
- **Il Mac di lavoro del proprietario, non una VM.** Il server di produzione gira su :3333 dal
  checkout `~/Projects/topics-app`: non toccare quel checkout, non avviare né fermare server di
  sviluppo, niente codice o test che puntino a :3333. I test e i cancelli avviano da soli i loro
  server isolati (`scripts/start-test-server.sh`, porte derivate dal percorso).
- **Bun 1.4.2**, quello della produzione e della CI (`.bun-version`). La tua shell di login rimette
  Homebrew in testa al PATH e trova un `bun` più vecchio: comincia ogni comando con
  `export PATH="$HOME/.topics/bun/1.4.2:$PATH";` e controlla con `bun --version`. Le dipendenze sono
  già installate: non rifare `bun install`.

## Cosa puoi girare sul Mac

- **Sì:** `bun test <file>` mirati; `bun run typecheck`; `bun run lint`; i comandi della barra
  della tua traccia.
- **Le e2e non girano sul Mac:** `playwright.config.ts` lo vieta, tranne `--project=webkit` per le
  poche spec del progetto `webkit`. Non aggirare il divieto con una config temporanea. Una spec
  nuova la scrivi, passa `bun run typecheck:e2e`, e la gira la CI con il workflow «Clip di consegna».
- **No:** suite e2e intere, `test:unit:shards`, build ripetute (`build:client` al massimo una
  volta, prima della consegna, e solo se la barra la chiede). Le suite intere le fa girare la CI
  dopo il push, che faccio io.
- Un comando che dura più di 2 minuti va in background, con il log su file. Niente `sleep` lunghi.

## Git

- **Niente commit, push, rami nuovi né stash.** Lasci tutto nel working tree: il diff lo rivedo io
  e committo io.
- Le mutazioni si fanno su una copia, oppure si annullano subito con `git checkout -- <file>`.
  Alla fine `git status` non deve mostrare nessun mutante.

## Consegna

- **REPORT** in `openspec/changes/daily-driver/reports/<ID>.md`, in italiano.
  - In testa: la barra prima e dopo, con i numeri.
  - Poi tre sezioni: **Fatto**, con la prova accanto (comando ed exit code, numeri);
    **Trovato e non fatto** (dove, perché, cosa servirebbe); **Rifiutato** (cosa sembrava un
    problema e non lo era).
- **Ultimo messaggio:** l'elenco dei file toccati e i comandi della barra con il loro exit code.
- **Ti fermi** quando la barra è verde e il REPORT è scritto, oppure dopo 2 ore di lavoro: in quel
  caso finisci il pezzo in corso, scrivi il REPORT e consegni quello che c'è.

## Lingua

Identificatori e commenti in inglese. Testi dell'interfaccia in italiano, senza trattino lungo.

I cancelli di lingua (`check:comment-language`, `check:identifier-language` e gli altri `check:*`)
leggono `git ls-files`: i file nuovi non li vedono finché non sono committati, quindi in locale
escono verdi anche quando la CI li vedrà rossi. Nei file nuovi, commenti e identificatori in
inglese li controlli tu, riga per riga.
