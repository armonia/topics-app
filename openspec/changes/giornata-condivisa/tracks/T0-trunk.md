# T0 - Un solo ramo di integrazione

**GOAL.** `main` locale non e' piu' un ramo di integrazione: il base ref delle
worktree e il target del land sono `origin/main`, e il checkout primario torna
allineato.

## Perche' ora

Misurato il 22/10: `git rev-list --left-right --count main...origin/main` da
`6 646`. I 6 sono il land del 14/10, mai pubblicato, e `git cherry origin/main
main` li da' tutti `+`. Il checkout primario e' su HEAD distaccato 153 commit
dietro, con 7 commit propri in nessun ramo remoto (salvati su
`salvataggio/7-commit-non-pushati`) e un albero di lavoro che per 268 file su 276
e' identico a `origin/main`: lo sporco e' un falso, il diff reale e' 9 file.

Conseguenze misurate: i rami di card nascono da basi stantie (`prosaic-sage` a
-646, `lithe-gazelle` a -133), `board-doctor` segnala `land-drags-foreign-commits`
per e9226ab7, e ogni strumento che legge git (`ci-evidence`, `worktree-base-ref`,
`task-automerge`) misura un albero che non e' quello che gira.

Sorgenti: `server/services/worktree-base-ref.ts:64-71` risolve `refs/heads/main`
senza fetch; `server/services/task-automerge.ts:21` fonde in locale e dichiara
«NO push»; `server/services/ci-evidence.ts:94` e `:524` usano il main di GitHub.

## Cosa cambia

1. Riconciliazione una tantum: i 6 commit di `main` e i 7 del checkout primario
   diventano PR o si dichiarano superati, uno per uno, con il motivo scritto.
2. `worktree-base-ref` e `task-automerge` passano a `origin/main`, con un fetch
   limitato prima di ogni creazione di worktree e prima di ogni land.
3. Il checkout primario torna su `main` allineato a `origin/main`. Va fatto a
   server fermo o in una finestra pianificata: il server di produzione serve da
   quella cartella.
4. Resta la regola di `docs/board-protocol.md` 6: il land non pusha, Pubblica
   e' sempre un gesto umano.

## Barra

- `git rev-list --left-right --count main...origin/main` stampa `0 0` dopo ogni land.
- `bun scripts/board-doctor.ts` non riporta `land-drags-foreign-commits`.
- Un test su `worktree-base-ref` che fallisce se la base risolta non e' una ref remota.

## Fuori

Cambiare chi pubblica. Chiudere la card solo a PR fusa: contraddice il protocollo.
