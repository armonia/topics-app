# T10 · Task: il feed della board pesa meno

Change `cloud-quality-pass`, traccia T10. Ramo di consegna: `cloud/t10-task-feed`.
Parti da `cloud/quality-pass-integrata`: T1 (topic dalla copia locale), T5 (server), T3 (avvio del
server) e T2 (board) sono già fusi lì, i loro REPORT sono in `reports/`. Le regole comuni (setup,
barra, recinto, prova, consegna, modelli) sono in `tracks/_comuni.md`: leggile prima di partire.

**GOAL.** `GET /api/all-boards/tasks` più rapido e più leggero: p50 da ~12 ms a ≤ 6 ms nel banco
in-process con 150 task, e meno byte dove il client non usa i campi (oggi 1,37 MB grezzi, 339 KB
compressi in 13 ms, `server/lib/compress-json.ts`).

**FUORI.** Rompere un client di oggi: togli solo campi che nessun client legge (lo provi con una
ricerca nel client e con l'e2e della board). Cache del feed invalidate a mano da ogni scrittore,
salvo che tu misuri che servono e le copra di test. Migration.

## Dove guardare

- `server/services/tasks.ts`: la SELECT a 79 colonne materializzata in oggetti costa 3,7 ms (con
  `.values()` 1,3 ms), `mapRow` 3,2 ms (decine di spread condizionali), `buildBatch`,
  `withSubtaskCounts` (REPORT di T5, «Trovato e non fatto»).
- Chi chiama la rotta e quante volte: a ogni `task:updated` si rifà tutto il feed?
- `services/tasks.ts` è nell'elenco dei rami aperti (`tracks/T4-dead-code.md`): scrivi nel REPORT
  sotto «Tocca rami aperti».

## Misure (prima e dopo, stessa VM, due corse)

| Numero | Comando | Target |
|---|---|---|
| p50 / p95 della rotta, 150 task | il banco in-process di T5 (`route-bench`) | p50 ≤ 6 ms |
| byte grezzi e compressi del feed | stesso banco | giù, con l'elenco dei campi tolti |
| chiamate al feed in una sessione di board con 20 `task:updated` | e2e o banco | giù o invariato, spiegato |
| campi tenuti | golden prima/dopo | identici |

## Prova

- Mutazione sul punto critico (per esempio un campo tolto che il client legge): un test va rosso.
- E2E di area: `tests/e2e/board-*.spec.ts`; barra intera prima della consegna.
