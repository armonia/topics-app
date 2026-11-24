## ADDED Requirements

<!-- WORKTREE-STD-01..11 and 13..15 moved to `openspec/specs/worktrees/spec.md` (the gates that read the
specs, among them spec-flow's intersections gate, only see `openspec/specs/`). WORKTREE-STD-12 stays here:
its proof is a Python test the coverage gate does not scan, so as an archived requirement it would be
"uncovered". It moves when that proof is visible to the gate. -->

### Requirement: WORKTREE-STD-12 — Il bundle che porta un repo a un nodo non resta sul primario

`node-pool` (`deploy/cloud-node/node-pool`, `sync_repo`) SHALL togliere il bundle locale in ogni esito, anche quando `scp` fallisce o scade, e il nodo SHALL togliere il suo appena lo script finisce. All'inizio di ogni `giro` e di ogni `hook` SHALL togliere dalla cartella di stato i `*.bundle` il cui processo non c'è più o più vecchi di un'ora, lasciando quelli di un trasferimento vivo.

#### Scenario: scp fallito
- **GIVEN** un `sync_repo` il cui `scp` esce non zero
- **THEN** la cartella di stato SHALL non contenere alcun `.bundle`; un bundle di un processo morto SHALL sparire al giro dopo, uno di un processo vivo e recente SHALL restare
