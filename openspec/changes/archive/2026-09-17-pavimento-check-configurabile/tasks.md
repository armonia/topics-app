# Tasks: pavimento-check-configurabile

La barra e' la stessa delle sei tornate di stanotte: ogni test provato ROSSO
senza la correzione, ogni guardia dichiarata portante uccisa dalla sua mutazione,
e la sbarra «Static guard rails» della CI eseguita in locale con ogni exit code
riportato.

## Il numero diventa un'impostazione

- [x] T1 Colonna `checks_mem_floor_gb` su `board_settings` (migration), letta
      dalla riga riservata `'*'` come `machine_budget_share`. Backup di
      `data/topics.db` PRIMA di creare il file: il watcher la applica al DB vivo
      in pochi secondi.
- [x] T2 Clamp condiviso in `shared/`, una funzione sola usata da gate, route e
      UI: `min 0`, `max 16`, default `3`, passo 1. Stessa forma di
      `budgetShare()` in `shared/machine-budget.ts`.
- [x] T3 Lettura/scrittura nel servizio (`readGlobalCap`, `setGlobalCap`) e nella
      rotta globale (GET + PATCH + broadcast), sui binari di
      `machine_budget_share`.
- [x] T4 `MemoryFloor.floorGB` diventa una funzione nel MOUNT, e resta un numero
      dentro `releaseDecision`: il valore si rilegge a ogni attesa, la decisione
      pura non guadagna dipendenze.
- [x] T5 `server.ts` smette di montare la costante e monta il valore
      dell'impostazione. Il test che fissa la forma del mount con una regex
      (`review-checks-brakes.test.ts:199`) va RISCRITTO, non cancellato: deve
      continuare a pretendere che il mount non torni a una costante.
- [x] T6 `0` spegne il freno: `holdReason` non risponde mai `room`.

## La UI

- [x] T7 Campo numerico nella sezione globale (`GlobalCapControl`), accanto alla
      fetta di macchina, con `min`/`max` e adozione ottimistica dallo stesso
      clamp.
- [x] T8 La riga di aiuto nomina il comando piu' caro misurato e il suo costo
      (lint a freddo, 1,9 GB), cosi' chi tocca il numero vede contro cosa lo
      mette.
- [x] T9 A `0` il testo dice «spento», non «0 GB».
- [x] T10 Stringhe `it` + `en`.

## L'intestazione smette di mentire

- [x] T11 Via la giustificazione di dancerooms (`pnpm verify:all` non esiste in
      quel repo: exit 254 in 275 ms, 2 MB) e via il «tsc 460 MB / vite 316 MB»
      che non ha nessuna misura dietro. Al loro posto i prezzi misurati.
- [x] T12 Scritte in intestazione le due strade chiuse dalla verifica avversaria
      (cancellare il pavimento; leggere il picco invece dell'ultimo campione nel
      freno swap), con il numero che le ha chiuse.

## Prove

- [x] T13 Test puro: stesso stato, pavimento 3 contro 6 → decisione diversa.
      Provato rosso senza la modifica.
- [x] T14 Test puro: pavimento `0` → `room` non compare mai su tutta la griglia
      di stati che la suite gia' percorre.
- [x] T15 Test puro sul clamp: fuori intervallo, non numerico, negativo.
- [x] T16 Il mount rilegge: due attese consecutive con il valore cambiato in
      mezzo danno due pavimenti diversi, senza riavvio.
- [x] T17 Round-trip dell'impostazione: PATCH → DB → GET, e il broadcast parte.
- [x] T18 E2E sul campo (DROP-07): si scrive, si salva, sopravvive al reload, e
      a 0 il testo dice «Freno spento». SCRITTO, non eseguito in locale: gli e2e
      girano sul server di test isolato in CI, non sul Mac.
- [x] T19 Sbarra «Static guard rails» in locale, ogni exit code riportato.
