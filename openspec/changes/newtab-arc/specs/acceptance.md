# Acceptance: newtab-arc

## Barra eseguibile

```bash
E2E_PORT=13422 bunx playwright test tests/e2e/newtab-arc.spec.ts --project=webkit --reporter=line
# atteso: N passed, 0 failed
bun run check:sleeps && bun run check:spec-coverage && bun run check:untraced-tests
# atteso: tutti verdi, nessuna baseline alzata
```

CI sul branch: gates + e2e + unit tutti verdi.

## Misure

- B1: all'apertura `document.activeElement` è il campo; digitando compaiono
  suggerimenti filtrati (almeno 1 sezione non vuota con fixture note).
- B2: con 2 tab aperte + storico, le sezioni mostrano tab, recenti, top, comandi.
- B3: `esempio.it` → naviga; `/comando` → voce comando; testo 600ch → voce file;
  invio su voce file crea e apre (editor con stesso contenuto).
- B4: il file nasce sotto la cartella progetto del topic; cancellarlo ripristina.

## Mutazione sul punto critico

Forzare la classifica a «sempre URL»: la spec deve diventare rossa (voce file
e comando sparite). Se resta verde, non prova niente.
