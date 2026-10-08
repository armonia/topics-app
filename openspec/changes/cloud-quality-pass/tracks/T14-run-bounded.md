# T14 — un modo solo di lanciare git e leggerne l'esito: `runBounded` dove la review l'ha chiesto

**GOAL.** La review indipendente sul codice di produzione di #251 (ultrareview, 94 file) ha confermato un solo
rilievo, di grado «nit»: `runBounded` (`server/lib/bounded-spawn.ts:283`, nato in T5) non lo usa nessuno in
produzione, mentre i wrapper di git rifanno a mano `spawnBounded` + lettura di stdout e stderr + `await exited`
+ il proprio codice per il timeout. Adottalo dove la forma coincide, senza cambiare niente di ciò che i
chiamanti vedono.

- **Base:** `cloud/quality-pass-integrata` @ `7a10aad77` più questo brief: ramo `cloud/t14-base`.

## I siti

Nominati dalla review: `server/services/own-commits.ts` (`defaultRunGit`), `server/services/task-automerge.ts`
(`defaultRunGit`, `runRepoScript`), `server/services/worktree-base-ref.ts`, `server/services/worktree-residue.ts`,
`server/services/branch-status.ts`, `server/services/branch-inventory.ts`, `server/routes/tasks.ts` (`runGitCap`).
Altri punti con la STESSA forma dentro questi file: dentro. `server/routes/files.ts` e gli altri `spawnBounded`
del server: fuori (forme diverse, e un diff di sessanta siti non si rivede).

## Vincoli

- **Il contratto di ogni wrapper resta identico** su quattro esiti: successo, uscita non zero, timeout, mancato
  avvio. Le sentinelle sono scelte apposta e commentate (in `own-commits.ts` un timeout è 124 perché
  `commitIsIn` legge 1 come «verificato fuori»): restano quelle di oggi, sito per sito.
- `runBounded` oggi perde il messaggio del mancato avvio (`spawnFailed: true` senza testo), mentre i wrapper
  lo mettono in stderr: aggiungi a `BoundedResult` il campo che serve, nient'altro.
- Prima del refactor scrivi i test che fissano i quattro esiti di ogni wrapper (una tabella va bene); devono
  essere verdi sul codice di oggi e restare verdi dopo.

## Barra

- **B1:** i test dei contratti verdi prima e dopo, anche sulla Bun 1.3.8 (`_comuni.md`, Setup 2).
- **B2:** nei file toccati le letture a mano `new Response(proc.stdout).text()` scendono al numero che dichiari;
  `runBounded` usato in produzione nei wrapper elencati sopra.
- **B3 mutazione** (copia scratch, mai il file vero): cambia la sentinella del timeout in un wrapper e il suo
  test diventa rosso.
- **B4 verde resta verde:** la barra comune di `_comuni.md`.

## Consegna

Ramo `cloud/t14-run-bounded`, REPORT in `openspec/changes/cloud-quality-pass/reports/T14.md`: in testa i siti
toccati con prima/dopo, poi B1-B4.

**FUORI.** `server/routes/files.ts` e gli altri siti, cambiare timeout o sentinelle, helper nuovi oltre al campo
in `BoundedResult`, migrazioni, workflow CI, `.bun-version`.
