# Acceptance: worktree-standard

Ogni barra si scrive una volta e si esegue sempre uguale; ciò che è verde resta verde (`worktree-manager`, `worktree-gc*`, `task-automerge*`, `project-path-resolver`, `tasks`, `dispatch-capacity` dalla CI della PR).

## WORKTREE-STD-01 Impostazioni e radice (T1)
`bun test server/services/worktree-root.test.ts server/services/app-settings.test.ts server/routes/app-settings.test.ts server/lib/worktree-root-setting.test.ts server/services/dispatch-capacity.disk-floor.test.ts tests/integration/migration-app-settings-worktrees.test.ts` esce 0: ordine env › impostazione › default, vuoto = default, un valore relativo o in `/tmp` rifiutato dalla rotta e ignorato dal risolutore, le tre manopole portate dentro il loro intervallo, due enum che rifiutano il resto, il pavimento di disco passato al verdetto, la migrazione che aggiunge sei colonne NULL senza toccare la riga.
Mutazione: con l'env che non vince più sull'impostazione il test dell'ordine è rosso; con il pavimento cablato a 12 il test del pavimento è rosso.
Più `bun run typecheck:server` e `bun run typecheck:client` a zero errori nuovi.

## WORKTREE-STD-02 `_scratch` nella radice (T2)
`! git grep -nE "tmpdir\(\)" -- server/services/task-automerge.ts server/services/integration-measure.ts server/services/node-check-worktree.ts && bun test server/services/node-check-worktree.test.ts server/services/worktree-scratch.test.ts` esce 0. La spazzata d'avvio su un repo vero toglie dal disco e da `git worktree list` un checkout lasciato in `_scratch/land` e non tocca né una worktree di progetto né i `node-checks` (che spazza il suo pool); due radici di case diverse non si spazzano a vicenda.
Mutazione: con il land che torna su `tmpdir()` la barra a `git grep` è rossa.

## WORKTREE-STD-03 GC sulla radice, marcatore e lock (T3)
`bun test server/services/worktree-gc.test.ts server/services/worktree-gc-unregistered.test.ts && bun scripts/worktree-orphans.ts --check` esce 0; con `dryRun=1` classe, azione e peso per cartella e nessuna scrittura (disco e DB identici prima e dopo); lockata, sporca, non pushata, con card attiva e sotto le 24 ore non vengono mai rimosse (un test per ognuna); il ref `refs/topics/archive/<task>` esiste prima della rimozione. `--check` esce 1 su un fantasma, un orfano non registrato, una riga senza cartella o una scansione oltre 2 s.
Mutazione: tolto il cancello del lock, il test della lockata è rosso.

## WORKTREE-STD-04 Tetti e cargo condiviso (T4)
`bun test server/services/worktree-gc.test.ts -t "tetto" && bun test server/services/worktree-for-agent.test.ts -t CARGO_TARGET_DIR` esce 0: oltre il tetto prima lo slim poi il reap del più vecchio ammesso; `shared` mette `CARGO_TARGET_DIR={radice}/_cache/cargo/{slug}`, `per-worktree` non mette niente.

## WORKTREE-STD-05 Progetto canonico (T5)
`bun test server/services/project-path-resolver.test.ts && bun scripts/worktree-orphans.ts --check-projects` esce 0: worktree, link simbolico e cartella sparita portano tutti all'id del padre; `--check-projects` esce 1 se un progetto ha `path` dentro una worktree e `parent_id` nullo.
Mutazione: senza `realpath` il test del link simbolico è rosso.

## WORKTREE-STD-06 Accorpa / separa (T6)
`bun test server/services/tasks.project-merge.test.ts && pw-remote -- npx playwright test tests/e2e/project-merge.spec.ts` esce 0, con video: accorpa mostra le card del progetto-worktree nella board del progetto del repo, separa le toglie, e un confronto prima/dopo della tabella `tasks` non vede nessuna riga cambiata. UI guardata a 375, 768, 1440 px.
Mutazione: con il filtro della board che ignora `merge_mode` lo scenario «separa» è rosso.

## WORKTREE-STD-07 Adotta e sposta (T7)
`bun test server/services/worktree-relocate.test.ts` esce 0: rifiuta se sporco, con sottomoduli o con sessione viva; dopo lo spostamento `git worktree list` combacia con la riga; l'anteprima non sposta niente.

## WORKTREE-STD-15 Il GC sposta solo ciò che Topics ha fatto
`bun test server/services/worktree-root-gc.test.ts server/services/worktree-gc-root.test.ts server/services/worktree-root-ledger.test.ts server/services/worktree-head-status.test.ts server/services/worktree-relocate.test.ts server/lib/worktree-root-setting.test.ts server/routes/app-settings.test.ts server/routes/worktrees.relocate.test.ts server/services/worktree-manager-owner.test.ts server/services/tasks.project-merge.test.ts server/services/external-sessions.test.ts` esce 0, sempre con `HOME` e `TOPICS_HOME` temporanei: una radice con dati dell'utente vecchi di 24 ore resta intatta; un checkout a livello di slug non viene toccato; un fantasma con marcatore va in quarantena e viene cancellato dopo N giorni; uno senza marcatore è solo elencato; una radice rifiutata per classe (home, antenato, contiene un progetto, non vuota senza sentinella); i casi di `headStatusOfCheckout` (124, 128, 1, 0 e HEAD staccato vero); lo spostamento rifiuta un HEAD staccato non unito; un percorso Windows è accettato; un chiamante che passa una radice non scansiona quella predefinita; una riga `reuse` con l'HEAD staccato su commit suoi non è tolta né dallo sweep né da `gc_foreign=merged`; una worktree fatta a mano nella radice senza marcatore non è registrata né tolta (il suo `.env` ignorato resta); una riga già nella radice riceve il marcatore alla prima passata; la quarantena conta dal momento dello spostamento (spostata alle 23:58, con 1 giorno è ancora lì 3 minuti dopo); una sessione da terminale dentro una worktree della radice tiene la cartella; un avanzo senza marcatore si mette in quarantena a mano e si ripristina.
Mutazione: tolto il controllo del `.git` del genitore o quello del marcatore in `quarantineGhostFolder`, un test è rosso.

## WORKTREE-STD-16 Le porte fra macchine e strumenti lasciano la prova di Topics
`sh scripts/claude-hooks/worktree-hook.test.sh && sh scripts/topics-worktree.test.sh && bun test scripts/git-hooks/post-checkout-register.test.ts server/services/worktree-register.test.ts server/routes/worktrees.register.test.ts server/routes/nodes.worktrees.test.ts server/boot/worktree-node-wiring.test.ts` esce 0, con `HOME` e `TOPICS_HOME` temporanei: l'hook e `topics-worktree add` scrivono voce e sentinella sotto la radice, anche con Topics spento; `register` e `post-checkout` le scrivono dentro la radice e mai fuori; la porta le scrive e `unregister` le toglie; `remove` rifiuta un worktree senza prova (il `.env` resta) e toglie la voce di quello che rimuove; il nodo rifiuta la propria home, un suo antenato, la sua cartella temporanea e una cartella non vuota senza sentinella col codice; la pulizia chiesta dal primario non passa niente del corpo alla passata.
Mutazione: tolto il controllo della prova in `wt_remove`, il worktree fatto a mano sparisce e la barra è rossa (dentro `worktree-hook.test.sh`); tolta la chiamata a `markOwned` nella porta, `worktree-register.test.ts` è rosso.

## Ciò che è verde resta verde
`worktree-manager.test.ts`, `worktree-gc*.test.ts`, `task-automerge*.test.ts`, `node-check-worktree.test.ts`, `integration-measure.test.ts`, `dispatch-capacity*.test.ts`, `app-settings*.test.ts` dalla CI della PR; `check:comment-language`, `check:bloat`, `check:untraced-tests` senza nuove violazioni.
