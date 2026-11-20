# T2b · Task: l'età di una card avanza da sola

Change `cloud-quality-pass`, traccia T2b. Ramo di consegna: `cloud/t2b-eta-card`.
Parti da `cloud/t2b-base`: è `cloud/t2-task` più la verifica V2 (`reports/V2.md`, i suoi test).
Le regole comuni sono in `tracks/_comuni.md`: leggile prima di partire.

**GOAL.** L'etichetta d'età della card («ora», «3m fa», «2h fa», `fmtUpdatedAt` in
`client/src/components/Board/Card.tsx`) avanza col tempo anche quando la card non riceve frame,
su una board quieta come su una board dove arrivano frame per altre card. Difetto D1 di V2: dopo
T2 una card ferma non si ridisegna più, e l'età resta a «ora».

**Come.** Un orologio condiviso: un solo timer per documento, che scatta al cambio di minuto, parte
col primo ascoltatore e si ferma con l'ultimo, e al ritorno della finestra visibile batte subito.
Lo legge la sola etichetta (un componente piccolo con `useSyncExternalStore`), non la card: un tick
non deve ridisegnare la card intera, né aggiungere render ai frame `task:updated`.

**FUORI.** Togliere l'età o cambiarne il formato (è una scelta di prodotto). Altri campi della
card. Il revert di T2: `idsKey` resta.

## Il test

`tests/e2e/board-card-updated-ago.spec.ts` (V2) oggi sposta l'ora con `setSystemTime` (nessun timer
scatta) e conta sul frame di un'altra card, cioè sul rinfresco casuale di prima. Riscrivilo perché
descriva il comportamento giusto: passano 3 minuti CON i timer (`page.clock` installato prima del
caricamento, poi `runFor` o `fastForward`) e la card ferma dice «3m fa», sia senza frame sia con un
frame all'altra card. Deve essere rosso senza il fix (mutazione: togli l'abbonamento all'orologio) e
verde con il fix.

## Misure (prima e dopo, stessa VM)

| Numero | Comando | Target |
|---|---|---|
| età della card ferma | `tests/e2e/board-card-updated-ago.spec.ts` | verde, rosso senza fix |
| render per frame `task:updated` | `tests/e2e/board-update-renders.spec.ts` | invariato (103,3) |
| crescita in sessione lunga | `bun run check:growth` | nessun peggioramento (il timer non resta acceso) |
| area | `E2E_TIER=pr npx playwright test --project=chromium tests/e2e/board-*.spec.ts` | verde |

## Anche

`reports/T2.md` cita hash di commit che sul ramo non esistono: V2 ha scritto la mappa nel suo
«Trovato e non fatto» 1. Correggili con la mappa, in un commit suo.

## Consegna

Fix su `cloud/t2b-eta-card` (push), REPORT in `openspec/changes/cloud-quality-pass/reports/T2b.md`.
