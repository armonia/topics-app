# T12 - Pulizia governata

**GOAL.** Niente che cresce senza una politica scritta: worktree, copie del DB,
radice del repo, cancelli.

## Perche' ora

Misurato il 22/10.

1. **25 worktree git**, di cui quattro **dentro il repo** in
   `.claude/worktrees` per 1,6 GB. Gonfiano ogni `find` e ogni `grep`, e la
   memoria del progetto ha gia' una scheda su un cancello che contava i
   conflitti tre volte per questo motivo.
2. **Copie del DB non governate**: `~/.topics/backups` 4,6 GB, `~/.topics/db-backups`
   614 MB con permessi 0644, contro la regola scritta «uno solo, poi trash».
3. **La radice del repo contiene segreti e residui non tracciati** ed e' servita
   da `/preview`: `relay-secret`, `relay-identity.json` (chiave privata del
   relay, scritta il 15/10 e **non ignorata** fino a oggi, perche' `.gitignore`
   copriva solo il nome del vecchio schema), `installation-id`, `error.log` con
   dentro un `ChatGPT-Account-Id`, `mem-samples.json`, `graphify-out` per 744 MB.
   Il repo e' **pubblico**.
4. **13 `check:*` orfani**: esistono in `package.json` e non girano in nessun
   workflow. E almeno cinque cancelli misurano il proprio proxy: `check:bundle`
   chiama «critical path» un insieme che non contiene il primo fotogramma, il
   gate di lingua e' cieco sui file senza `useT`, `knip` conta un import da test
   come uso, due budget perf su cinque si astengono restando verdi.

Il debito di **tipo** invece e' quasi nullo e non va toccato: 1 TODO, 0
`ts-ignore`, any-budget 337/339, 9 cicli in 4.871 file.

## Cosa cambia

1. Le worktree escono dal repo, e `board-doctor` pota quelle senza ramo vivo.
2. Lo stato di produzione esce dalla radice del repo: il server scrive in
   `~/.topics`, non nel checkout. E' la causa radice del punto 3.
3. Politica unica delle copie del DB, scritta in
   `backup-pre-migration-policy.md`, applicata da T2.
4. Ogni `check:*` orfano o entra in un workflow o si dichiara orfano con il
   motivo, in una riga.
5. Ogni cancello che misura un proxy viene corretto o declassato: un cancello
   che si astende restando verde e' peggio di nessun cancello.

## Barra

- `git worktree list` mostra solo worktree con un ramo vivo, nessuna dentro il repo.
- La radice del repo non contiene file non tracciati con dentro un segreto.
- `bun run check:gates-orfani` da' 0, o un elenco dichiarato con il motivo.
- `du -sh ~/.topics/backups ~/.topics/db-backups` dentro la retention scritta.

## Fuori

Rinominare in blocco per il debito di lingua. Il vecchio si rinomina solo se si
sta gia' toccando quel file.
