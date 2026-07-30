# Tasks — dispatch-resume-on-restart

Convenzione: chiudere con typecheck verde + test della change verdi.

## Phase 1 — reconcile() v2 (server/services/task-dispatcher.ts)
- [x] Ramo resume-in-place in `reconcile()`: orfano `working` + binding vivo
      (`topicExists`, assente ⇒ fidati del binding come nel heal) + autoDispatch ON →
      commento di sistema + `void resume(id, "", {continuation:true})` (nessun bump).
- [x] Fallback requeue invariato (release + requeue + rollbackAttempt) per: binding
      assente, topic morto, chip `starting`.
- [x] autoDispatch OFF → requeue + chip azzerato (`setDispatchState null`) dopo la
      release, così nessun `queued` stranda su board che non dispatcha.

## Phase 2 — Test (server/services/task-dispatcher.test.ts)
- [x] resume-in-place: stato/binding/attempts invariati, 1 turno lean con nudge su
      `topic:<id8>`, commento di sistema nel thread.
- [x] topic morto → requeue + rollback.
- [x] autoDispatch OFF + binding vivo → requeue + chip null.
- [x] doppio reconcile col turno in volo → 1 solo turno.
- [x] `starting` senza binding → requeue + rollback.
- [x] orfano al retry-cap + topic vivo → resume con nudge last-chance (no park).
- [x] I 3 test reconcile esistenti restano verdi senza modifiche.

## Phase 3 — Verifica
- [x] `bun test server/services/task-dispatcher.test.ts` verde (49 pass, 0 fail).
- [x] `bun test server/` intera suite verde (913 pass, 0 fail — nessuna regressione).
- [x] `bunx tsc --noEmit -p tsconfig.server.json` verde.
