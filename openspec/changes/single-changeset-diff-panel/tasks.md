# Tasks: single-changeset-diff-panel

Barra: il test nuovo di ogni task e' ROSSO sull'albero di oggi e verde dopo;
`board-task-changes-panel.spec.ts` e `board-diff-review.spec.ts` restano verdi.

## Server

- [x] T1 `revsOfRange` in `task-diff-range.ts` + casi in
      `task-diff-range.test.ts`: gamma `a..b`, revisione sola `live`, base
      albero vuoto, `rev-parse` fallito → `null`.
- [x] T2 `gitDiffBundle` porta `origPath` su `R`/`C`; `/diff` e `/publish-diff`
      rispondono con `revs` (DIFFPV-01).
- [x] T3 `shared/preview-kind.ts` (mappa estensione → tipo e MIME).
- [x] T4 `?file=&blob=` su `/diff` e `/publish-diff` (DIFFPV-05): controllo della
      revisione, path, symlink, estensione, 10 MB, streaming, intestazioni.
- [x] T5 `?file=&context=full` su `/diff` e `/publish-diff` (DIFFPV-04);
      `/publish-diff` impara anche il `?file=` semplice, che oggi ha solo `/diff`
      (`tasks.ts:3292`): senza, il patch pigro della pubblicazione non esiste.

## Client

- [x] T6 `DiffBundle.revs` e `DiffFileStat.origPath` in `lib/board.ts`;
      `rowFromDiffStat` passa `origPath`.
- [x] T7 `UnifiedDiff` con `source`; i tre punti di montaggio
      (`TaskDetail.tsx:560`, `:757`, `KanbanBoardPane.tsx:325`) aggiornati.
- [x] T8 Coppia Prima/Dopo (DIFFPV-02), interruttore «Anteprima» con
      `resolveImage` in `MarkdownPreview` (DIFFPV-03), «File intero» (DIFFPV-04),
      stringhe it/en.

## Prova

- [x] T9 `tests/e2e/board-task-changes-panel.spec.ts` si estende sullo stesso
      repo vero, su :13334:
      `CHANGES-04` worktree vivo con un PNG modificato, un PNG nuovo non
      committato e un `README.md` che include l'immagine: due `<img>` nella
      coppia con `blob=<sha>` e `blob=worktree`, un solo Dopo per il nuovo,
      «binario» assente, «Anteprima» mostra un titolo reso e l'immagine del
      README alla stessa revisione.
      Poi un `.txt` rinominato e cambiato: «File intero» mostra la riga 1 senza
      colore e la vecchia riga 9, una nota resta sotto la riga 9 andata e
      ritorno, e dopo un bump con il file cambiato «File intero» mostra la riga
      nuova.
      `CHANGES-05` il pannello si apre sul worktree vivo, poi il land a drawer
      aperto: il primo byte chiesto prende `409`, il pacchetto si rilegge e la
      coppia legge dagli SHA del merge.
      `CHANGES-06` la rotta dei byte: symlink uscente `404`, `../` `400`,
      revisione estranea `409`, `.env` `415`, PNG identico byte per byte.
- [x] T10 `UnifiedDiff.test.tsx`: una nota in sospeso resta alla sua riga passando
      a «File intero» e tornando indietro; una nota o la modifica oltre la riga
      600 si disegnano senza «mostra tutto». `diffPreview.test.ts`: `orig=` nel
      patch per file, e il `409` rilegge il pacchetto sia per un'immagine sia per
      un `.md` reso.
- [ ] T11 Video `.webm` del giro E2E di `CHANGES-04` allegato alla consegna.
      Aperto: questo giro non poteva lanciare Playwright. Il video si ottiene con
      `E2E_EVIDENCE=1 E2E_VIDEO=1 bunx playwright test tests/e2e/board-task-changes-panel.spec.ts -g CHANGES-04`.

## Dopo questa change

- [ ] T12 La meta' rimandata della card af8ba9b4 ha una sua card (o change)
      `changeset-chat-strip` prima che il land chiuda af8ba9b4: il contratto
      `ChangeSet` in `shared/`, `/api/topics/:id/changes` con `revs`, e la
      striscia della chat che monta `UnifiedDiff` con sorgente `topic`
      (proposta, Non-goals; `design.md` §1). Senza, la card si chiude e quella
      meta' non la traccia piu' nessuno.
