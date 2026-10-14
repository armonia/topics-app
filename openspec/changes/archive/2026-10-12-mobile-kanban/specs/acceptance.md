# Acceptance — mobile-kanban

## Barra eseguibile

```bash
bun run build:client
E2E_PORT=14701 ANTHROPIC_BASE_URL= TOPICS_E2E_BUNDLE_DIR=$PWD/public \
  npx playwright test tests/e2e/board-mobile-phone.spec.ts --project=webkit --workers=1
bun test client/src/components/Board/columnClearance.test.ts client/src/components/Board/kanbanTopbar.test.ts
```

Esce non-zero se uno qualunque di questi è falso:

| Requisito | Test | Misura |
|-----------|------|--------|
| KANBAN-MOBILE-01 | `KANBAN-MOBILE-01 telefono / orizzontale / ipad` | la barra non è un asse verticale con contenuto che lo eccede |
| KANBAN-MOBILE-02, KANBAN-12 | `KANBAN-MOBILE-02` | campo e `<input>` ≥ 44 px, campo ≥ 75% di 390, ogni controllo della barra ≥ 44 |
| KANBAN-MOBILE-03 | `KANBAN-MOBILE-03` | Todo (2 card) e Backlog (14) alti quanto la riga ±1; Todo non scorre, Backlog sì |
| KANBAN-MOBILE-04 | `KANBAN-MOBILE-04` + `columnClearance.test.ts` | ultima card ≥ 12 px sopra il composer, anche con `--mobile-transport-h: 48px` |
| KANBAN-MOBILE-05 | `KANBAN-MOBILE-05` | nessun testo della colonna Todo sotto 4,5:1 nel tema chiaro |

## Rosso prima

Stessa spec contro il bundle di `origin/main` (`TOPICS_E2E_BUNDLE_DIR` sulla copia
fatta prima delle modifiche): 6 rossi su 7 (01 x3, 02, 04, 05), verde solo 03,
che è il requisito già vero e guardato.

## Mutazione sul punto critico

Rimettere `pb-36` al posto di `pb-[max(var(--board-bottom-clear,…)…)]` nel corpo
colonna (`Card.tsx`): `KANBAN-MOBILE-04` torna rosso (3 px a riposo) e così
l'ultimo test di `columnClearance.test.ts`.

## Video

I `.webm` della spec, uno per test, in
`scratchpad/kanban-videos/` (percorsi nel corpo della PR), registrati con una
config locale temporanea che estende quella del repo con `video: "on"` e
nient'altro. Non con `E2E_EVIDENCE=1 E2E_VIDEO=1`: il 05/10, con lo swap al 93%,
KANBAN-MOBILE-05 passava in 3 s e poi andava in timeout a 30 s dopo l'`afterAll`,
col `trace.zip` troncato (104 KB, senza directory centrale), in 3 giri su 4;
senza trace 7 su 7.

## Ciò che è verde resta verde

`mobile-screens-under-chrome.spec.ts` (MOBILE-SCREEN-02/02b: l'ultima card sopra
il composer, griglia ed elenco) e `usability-audit.spec.ts` senza le due eccezioni
tolte.
