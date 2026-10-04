# Tasks: changeset-chat-strip

Barra: il test nuovo di ogni task e' ROSSO sull'albero di oggi e verde dopo (T1 non ne ha
uno suo: il test di CHGSET-01 legge la rotta del topic, quindi sta in T4);
`chat-changed-files.spec.ts`, `chat-changed-files-task-range.spec.ts` e
`board-task-changes-panel.spec.ts` restano verdi (la seconda dopo il cambio della scelta 4).

## Contratto

- [ ] T1 `shared/change-set.ts`; `DiffStatEntry`, `gitDiffBundle`, `DiffFileStat`,
      `DiffBundle` ne derivano (CHGSET-01). `bun run typecheck` verde; il test dello
      scenario «tre rotte, una forma» e' in T4, perche' una delle tre rotte nasce li'.

## Server

- [ ] T2 `paths` in `gitDiffStat` e `gitDiffBundle`, con un caso in `server/routes/tasks.diff-bundle.test.ts`:
      un file sporco fuori da `paths` non compare ne' nello stat ne' nel patch.
- [ ] T3 `resolveTopicChangeTarget` in `topic-changes.ts`; `computeTopicChanges` lo usa e
      aggiunge `revs` (CHGSET-02). Casi in `topic-changes.test.ts`: topic senza task, topic
      di card, fuori da un repository, repository senza commit.
- [ ] T4 `GET /api/topics/:id/changes/diff` con `?file=`, `context=full`, `orig=` e
      `blob=`, piu' il cancello `not_in_changeset` (CHGSET-02, CHGSET-04), in
      `tests/integration/topic-changes-route.test.ts` su un repository vero: `c.ts` sporco
      assente, `revs` uguali fra `/changes` e `/changes/diff`, stesso `stat` del drawer per
      un topic di card, `404` per un PNG non toccato, PNG identico byte per byte.
      In `tests/integration/change-set-contract.test.ts` (@covers CHGSET-01), sullo stesso
      repository con un file modificato sul ramo di una card: le risposte di
      `GET /api/boards/:p/tasks/:t/diff`, `GET /api/boards/:p/publish-diff` e
      `GET /api/topics/:id/changes/diff` passano ognuna da `buildFileRows`
      (`client/src/components/Board/diffFileRows.ts:63`) e danno una riga per quel file, con
      lo stesso `path` e gli stessi `additions`/`deletions`. ROSSO oggi: la rotta del topic
      non esiste.

## Client

- [ ] T5 `DiffPanelSource` `topic`, `diffRoute`, sorgente stabile a tre rami in
      `UnifiedDiff`; caso in `diffPreview.test.ts` per l'URL dei byte di un topic.
- [ ] T6 `useTopicChangeSet` e `ChangedFilesStrip` con `UnifiedDiff`, righe fuori dal
      changeset, collegamento alla card, altezza, stringhe it/en (CHGSET-03).
- [ ] T7 `ChangedFilesStrip.test.tsx`: una riga fuori dal changeset resta riga semplice;
      il collegamento compare solo con `taskId`.

## Prova

- [ ] T8 `tests/e2e/chat-changed-files.spec.ts` (@covers CHGSET-03), su :13334, WebKit: una
      chat che modifica `a.txt` e crea `b.txt` mostra 2 righe; il clic su `a.txt` apre le
      sue righe `-`/`+` nella striscia, nessuna pane editor; un PNG riscritto mostra la
      coppia Prima/Dopo.
- [ ] T9 `tests/e2e/chat-changed-files-task-range.spec.ts`: la riga della gamma apre il diff
      nella striscia con le righe del drawer, e «Apri nella card» apre il drawer su quel file.
- [ ] T10 Video `.webm` del giro di T8 allegato alla consegna.
