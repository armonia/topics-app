# Acceptance: mobile-chrome-feedback

## Barra eseguibile

```bash
E2E_PORT=13421 bunx playwright test tests/e2e/mobile-chrome-feedback.spec.ts --project=webkit --reporter=line
# atteso: N passed, 0 failed (390x844, hasTouch, isMobile)
bun run check:sleeps && bun run check:spec-coverage && bun run check:untraced-tests
# atteso: tutti verdi, nessuna baseline alzata
```

CI sul branch: gates + e2e + unit tutti verdi (ciò che è verde resta verde).

## Misure (DOM, non occhio)

- A1: scrollato in cima la top bar è compatta; scrollando, header visibile con
  righe da subito dopo `--sat`; menu Topics raggiungibile dal menu utente.
- A2: primo/ultimo tasto con raggio basso-esterno > 12 su 390x844 con banda;
  aria misurabile sotto e fra i tasti; glifo centrato ±1px, label sotto.
- A3: distanza toggle Cerca dai vicini = distanza fra gli altri (PASSO unico).
- A4: fondo Cerca mobile = `bg-app-bg` (computed), nessun pixel grigio fisso;
  contenuto dentro la safe-area (niente sotto il notch).
- A5: con coda vuota il tasto è abilitato e apre Inbox/Now; con coda va al next.
- A6: tap sul pencil = nuova bozza chat aperta; long-press = menu «+».

## Mutazione sul punto critico

Staccare temporaneamente `onNextWaiting` (tasto morto come prima): la spec deve
diventare rossa. Se resta verde, la spec non prova niente.
