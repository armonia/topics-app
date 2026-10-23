# D4m — B7, terzo pezzo: le letture di `tasks` a ogni giro

**Barra prima:** quattro letture di `tasks` che girano a tempo scorrono la tabella intera, circa
1.400 pagine; `[DB-SLOW]` fra 321 e 946 ms. **Barra dopo:** `bun test server/db-sweep-plans.test.ts`
7/7, con il mutante senza migration rosso su tutti e quattro i casi nuovi.

## Misura (copia del database vivo, 15/10)

| lettura | dove gira | prima | dopo |
|---|---|---|---|
| bacheche con card in coda | tick del dispatcher | 1.410 pagine | 23 |
| card al lavoro, quante | barra di stato | 1.406 | 23 |
| card al lavoro, la più vecchia | barra di stato | 1.406 | 23 |
| card parcheggiate in una serie | sweep delle attese | 1.222 | 23 |

## Fatto

- Migration `20261015200000-tasks-timer-read-indexes.sql`: tre indici parziali, ciascuno con le sole
  righe della sua lettura. In due la colonna d'uguaglianza sta in testa (`parent_task_id`,
  `archived`): senza, il pianificatore sceglie gli indici vecchi su quelle colonne, dove sta quasi
  tutta la tabella, e il nuovo resta inutile. Sul database di prova, che non ha statistiche, è
  successo proprio con la lettura delle attese.
- Le quattro query stanno in `server/lib/task-timer-reads.ts`, usate da `tasks.ts` e
  `profile-stats.ts`; `server/db-sweep-plans.test.ts` ne controlla i piani sullo schema di tutte le
  migration. Requisito `DBSLOW-03`.

## Trovato e non fatto

- L'anteprima dell'ultimo messaggio di ogni topic (`server/routes/topics.ts:1097`, fino a 1.357 ms)
  e `SELECT * FROM topics` (fino a 630 ms) restano lente sotto pressione di memoria: la prima
  scorre all'indietro i messaggi di ogni chat filtrando il contenuto, la seconda legge tutta la
  tabella. Non si risolvono con un indice: la prima vuole l'anteprima salvata sulla topic.
