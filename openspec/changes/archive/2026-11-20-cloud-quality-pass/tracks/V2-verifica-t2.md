# V2 · Verifica indipendente di T2 (Task)

Change `cloud-quality-pass`, verifica V2. Ramo di consegna: `cloud/v2-verifica-t2`.
Le regole comuni (setup, barra, recinto, prova, consegna esatta, modelli) sono in
`tracks/_comuni.md`: leggile prima di partire.

Non hai scritto T2: il tuo lavoro è smentirlo. Lo snapshot che hai è il ramo `cloud/t2-task`:
`reports/T2.md` è il REPORT da verificare, `verify/T2-client.patch` è il diff del client di T2
rispetto alla sua base (serve a ricostruire il «prima»).

**GOAL.** Per ogni affermazione di T2 un verdetto: confermata (con la tua misura), smentita (con un
test rosso o un numero), oppure non verificabile (e perché).

**FUORI.** Correggere il codice di T2: scrivi il test rosso e il REPORT, i fix li decide la sessione
madre. Ottimizzazioni nuove.

## Cosa smontare, in ordine di rischio

1. Le card non si ridisegnano più tutte a ogni `task:updated` (`useGlobalBoard.ts`, `Card.tsx`,
   `dndStableProps`, `idsKey`). Cerca un campo visibile sulla card o nella scheda che dopo il fix NON
   si aggiorna più: stato, titolo, chip, coda e motivo, tentativi, parcheggio, conteggi dei
   sottotask, badge, ordine. Per ogni campo un test che lo cambia via evento e guarda il DOM.
2. Indice topic → task (`useTaskTopicIndex.ts`): un ricalcolo saltato quando un topic cambia task,
   nasce o si chiude.
3. Tab liberate su fusione e archiviazione (`server/services/board-actions.ts`,
   `server/routes/tasks-board.ts`, `tests/integration/task-tab-teardown.test.ts`): una tab di un task
   ancora attivo che si chiude; fusione di una card con sottotask aperti; archivia su una card già
   parcheggiata.
4. Scheda al primo frame (`TaskDetail.tsx`, `tests/e2e/board-drawer-first-frame.spec.ts`) e il revert
   della «board di progetto»: il revert è completo o lascia codice morto?

Un difetto vale solo con un test che passa sul «prima» e fallisce sul «dopo».

## Rimisura (macchina diversa da quella di T2)

- «Prima»: una copia del repo con `git apply -R openspec/changes/cloud-quality-pass/verify/T2-client.patch`
  e `bun run build:client`. «Dopo»: questo albero. Stesso checkout di test per entrambi, cambia solo
  il bundle (`TOPICS_E2E_BUNDLE_DIR`), come ha fatto T2.
- `bun run check:ink` (gesto «card») e `tests/e2e/board-update-renders.spec.ts`: due corse per lato,
  alternate prima/dopo/prima/dopo, `uptime` accanto.
- Una volta, alla fine: `E2E_TIER=pr npx playwright test --project=chromium tests/e2e/board-*.spec.ts`.

## Consegna

`openspec/changes/cloud-quality-pass/reports/V2.md`: in testa una riga per affermazione di T2
(verdetto e prova), poi i difetti trovati con il loro test. Un commit per test rosso, il REPORT in
un commit suo, bundle come da «Consegna esatta».
