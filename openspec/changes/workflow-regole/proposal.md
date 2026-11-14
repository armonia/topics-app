# workflow-regole: fase CI e «chi deve guardare» nel workflow della board

## Deciso da Attilio (14/11)

«Farlo a workflow», consigliata accettata: la fase CI si accende o si spegne dalle regole del workflow
della board, e i percorsi che una persona deve guardare sono in due parti, una generica nel codice e una
di ogni repo nella configurazione della sua board. Vale per chiunque (regola zero).

## Perché

Con la fase CI (14/11) l'elenco dei percorsi «di una persona» era una lista fissa in `auto-land.ts`
con dentro i file di topics-app (`client/src/**`, `server/routes/tasks.ts`…): su un'altra board non
diceva niente di vero, e la fase CI non si poteva spegnere.

## Cosa cambia

- Tabella `board_workflow_rules(scope, ci_phase, person_paths)`, stessi scope di `board_workflows`
  ('*' globale, poi il progetto). L'interruttore del progetto vince sul globale (acceso di default); i
  percorsi si sommano.
- `auto-land.ts`: resta solo l'elenco generico (dipendenze di ogni linguaggio, CI, interfaccia per tipo
  di file, testi pubblici, sicurezza e soldi, ciò che raggiunge persone). I percorsi della board sono
  glob (`Bun.Glob`) letti a ogni decisione; una lista illeggibile ferma il land invece di valere vuota.
- `GET/PUT /api/boards/:id/workflow` portano `rules`, `ownRules`, `ciPhase`, `personPaths`.
- Pannello impostazioni → Workflow: «Fase CI» accesa/spenta e «Da far guardare a te», un percorso per
  riga (`percorso # perché`).
- topics-app: `docs/board-workflow-rules.json`, caricata sulla sua board.

## Barra

`bun test shared/workflow.test.ts server/services/auto-land.test.ts server/routes/tasks.integration.test.ts`
exit 0. Mutazioni: senza i glob della board 29 test rossi; senza l'interruttore 1 rosso.

## Fuori

Un file di test sotto un percorso della board resta un test (prima `scripts/*.test.ts` e
`tests/setup/*.test.ts` andavano a una persona): i preload li prende già `referencedByTheJudge`.
