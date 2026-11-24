# Tracce

Sette tracce, in ordine. Le prime due non dipendono da altro; T3 e T4 usano la radice di T1 e T2; T5 e T6 sono sul progetto e non toccano la radice; T7 usa T3 (il GC conosce le righe adottate). Ogni traccia ha la sua barra: comando che esce non-zero, e ciò che è verde resta verde.

- [ ] 1.1 **Impostazioni e radice** (WORKTREE-STD-01). Migrazione `server/db/migrations/20261124100000-app-settings-worktrees.sql` (`worktree_root`, `worktree_max_per_project`, `worktree_disk_floor_gb`, `cargo_target_mode`, `gc_foreign`, `worktree_abandon_days`) + manifest; `server/services/app-settings.ts`, `worktree-root.ts` (`worktreeRootDir`), `dispatch-capacity.ts` (pavimento disco), `client/src/components/Settings/WorktreesSection.tsx`.
   Barra: `bun test server/services/worktree-root.test.ts server/services/app-settings.test.ts` (casi nuovi: env › impostazione › default, vuoto = default).
- [ ] 2.1 **`_scratch` nella radice** (WORKTREE-STD-02). `task-automerge.ts`, `integration-measure.ts`, `node-check-worktree.ts`, `server/lib/worktree-discard.ts`, `worktree-scratch.ts` con la spazzata d'avvio.
   Barra: `! git grep -nE "tmpdir\(\)" -- server/services/task-automerge.ts server/services/integration-measure.ts server/services/node-check-worktree.ts && bun test server/services/node-check-worktree.test.ts`.
- [x] 3.1 **GC sulla radice, marcatore e lock** (WORKTREE-STD-03). `worktree-gc.ts` (`classifyRootEntry` nuova), `worktree-gc-runner.ts` (via l'esclusione `error`), `worktree-manager.ts` (marcatore `.git/worktrees/<id>/topics-owner` e lock in `create`, unlock alla fine), `scripts/worktree-orphans.ts --check`; la scansione salta `_scratch`.
   Barra: `bun test server/services/worktree-gc.test.ts server/services/worktree-gc-unregistered.test.ts && bun scripts/worktree-orphans.ts --check` (exit 1 con fantasmi, orfani non registrati, righe senza cartella o scansione oltre 2 s).
- [x] 4.1 **Tetti e cargo condiviso** (WORKTREE-STD-04). `worktree-gc-runner.ts`, `worktree-for-agent.ts`, `server/boot/dispatch-prep.ts`.
   Barra: `bun test server/services/worktree-gc.test.ts -t "tetto" && bun test server/services/worktree-for-agent.test.ts -t CARGO_TARGET_DIR`.
- [ ] 5.1 **Progetto canonico** (WORKTREE-STD-05). `project-path-resolver.ts` (`canonicalProjectFor`), `server/boot/dispatcher.ts`, `server/routes/topics.ts`, `routes/topics-projects.ts`, `routes/projects.ts`.
   Barra: `bun test server/services/project-path-resolver.test.ts && bun scripts/worktree-orphans.ts --check-projects` (esce 1 se un progetto ha `path` dentro una worktree e `parent_id` nullo).
- [ ] 6.1 **Accorpa / separa** (WORKTREE-STD-06). Migrazione `…-projects-parent-merge.sql` con backfill, `server/services/tasks.ts`, `project-store.ts`, `client/src/components/Sidebar/TopicTree.tsx`, menu del progetto.
   Barra: `bun test server/services/tasks.project-merge.test.ts && pw-remote -- npx playwright test tests/e2e/project-merge.spec.ts` (con video; nessuna riga di `tasks` cambiata).
- [x] 7.1 **Adotta e sposta fuori radice** (WORKTREE-STD-07). `server/services/worktree-relocate.ts`, rotta in `server/routes/worktrees.ts`, UI in `WorktreesSection`.
   Barra: `bun test server/services/worktree-relocate.test.ts` (rifiuta se sporco, con sottomoduli o con sessione viva; dopo lo spostamento `git worktree list` combacia con la riga).
