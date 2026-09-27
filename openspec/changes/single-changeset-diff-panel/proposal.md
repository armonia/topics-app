# Proposal: single-changeset-diff-panel

## Da decidere

Anteprima nel pannello «Modifiche»: 3 scelte prima del codice.

1. Prima fetta: anteprima e file intero nei diff della board (card, tentativo, pubblicazione); ChangeSet unico e striscia della chat in una seconda change (consigliata: il «binario» sta qui, taglia M e non XL) · oppure tutto il ChangeSet adesso.
2. Immagine: Prima e Dopo affiancate con le dimensioni, impilate su telefono (consigliata: si legge a colpo d'occhio) · oppure anche scorri/sovrapponi alla GitHub.
3. `.md` e `.svg`: si apre sul diff, «Anteprima» mostra la resa del Dopo (consigliata: le note si agganciano alle righe del diff) · oppure si apre sulla resa.

Compreso, senza scelta: «File intero» sui testi, con le note ancora agganciate; immagine nuova solo Dopo, cancellata solo Prima; gli altri binari restano «binario».
Col sì: i byte escono dalla rotta del diff della card, solo per i due commit che il pannello nomina; `/api/git/show` non si allarga. Costo: una rotta che serve byte dal worktree di un agente; path fuori e symlink uscenti si rifiutano, con un test ciascuno.
«ok» = tutte le consigliate · «ok ma 2 no» = cambio la 2.

## Dove cambiarla

| Scelta | Requisito e design |
|---|---|
| 1 | «What changes» qui sotto; nella spec un requisito nuovo `DIFFPV-06` (striscia della chat sullo stesso pannello, `/api/topics/:id/changes` con `revs`) e `design.md` §1 |
| 2 | spec `DIFFPV-02`, scenario «coppia Prima/Dopo» |
| 3 | spec `DIFFPV-03`, scenario «si apre sul diff» |

## Why

Un'immagine o un README cambiati da una card non si possono guardare dove si
rivede la card.

- **Il pannello dice solo «binario».** `UnifiedDiff.tsx:219-220` disegna
  `tr('diff.binary')` («File binario: nessun diff testuale.»,
  `i18n-it.ts:378`) per ogni file che `--numstat` conta `-`. Un PNG consegnato
  da un agente si approva senza vederlo. Un `.md` si legge solo come righe
  `+/-`, mai reso.
- **La rotta che c'e' non basta.** `/api/git/show` accetta `?rev`
  (`server/routes/files.ts:1006-1060`), ma legge l'uscita con `.text()` e
  risponde `text/plain`: un PNG arriva corrotto. In piu' il suo `path` viene dal
  client e passa `resolveProjectPath`, mentre il posto giusto da cui leggere una
  card lo sa solo il server (`resolveTaskDiffRange`, `task-diff-range.ts:252`):
  worktree vivo, poi il merge del land, poi il commit di consegna.
- **Le forme sono due, non quattro.** Card, tentativo (`?attempt=` sulla stessa
  rotta, `tasks.ts:3246`) e pubblicazione (`tasks.ts:3210`) passano tutte da
  `gitDiffBundle` (`tasks.ts:610`) e arrivano al client come `DiffBundle`
  (`client/src/lib/board.ts:888`). `/attempts` (`tasks.ts:3337`) elenca i
  tentativi, non e' un diff. Resta diversa solo la chat: `/api/topics/:id/changes`
  (`topics.ts:2276`) da' `TopicChanges`, e una riga apre il diff nell'editor
  (`ChangedFilesStrip.tsx:51-58` → `FilePane.tsx:136-151`), dove un'immagine
  e' gia' mostrata (solo il Dopo, da disco) e il testo e' un confronto con `HEAD`.
  Il difetto visibile sta quindi nella board, ed e' li' che la prima fetta lo
  chiude.
- **Meta' dei pezzi esiste.** La riga condivisa `ChangedFileRow` ha gia'
  `origPath` (`changedFiles.ts:55`); `getMediaType` e `IMAGE_EXTS`
  (`Editor/fileMedia.tsx:5-25`) sanno cos'e' un'immagine; `MarkdownPreview.tsx`
  rende un `.md` ed e' gia' caricato pigro; `gitDiffFilePatch` (`tasks.ts:691`)
  legge il patch di un file solo sulla stessa gamma del pacchetto.

## What changes

1. **Il pacchetto nomina le due revisioni.** `DiffBundle` guadagna
   `revs: { base, head }`, due SHA interi; `head: null` quando il Dopo e'
   l'albero di lavoro di un worktree vivo. Ogni riga dello stat porta `origPath`
   su rinomina e copia. Vale per card, tentativo e pubblicazione.
2. **I byte di un file, a una di quelle revisioni.** La rotta del diff della card
   (e quella della pubblicazione) risponde a `?file=<path>&blob=<sha|worktree>`
   con i byte del file, in streaming, solo per le estensioni che il pannello sa
   mostrare e solo per le due revisioni del pacchetto.
3. **Il pannello mostra.** Un'immagine cambiata e' una coppia Prima/Dopo; un
   `.md` o un `.svg` hanno l'interruttore «Anteprima»; un file di testo ha
   «File intero». Le note di revisione restano sulle righe del diff come oggi.
4. **Un componente solo per i tre punti di montaggio.** `UnifiedDiff` riceve una
   sorgente (`task`, `attempt`, `publish`) invece di `projectId`/`taskId` sciolti,
   e la pubblicazione (`KanbanBoardPane.tsx:325`) guadagna cosi' anche il patch
   pigro dei file oltre il tetto, che oggi non ha.

## Non-goals

- Il contratto `ChangeSet` in `shared/` e la striscia della chat sullo stesso
  pannello: seconda change, che parte da `revs` e da questa rotta dei byte.
- `Project/GitChanges.tsx` (albero di lavoro con lo staging per blocco).
- Anteprima di PDF, video, font o archivi: restano «binario».
- Modi di confronto immagine oltre l'affiancato (scorri, sovrapponi, differenza
  per pixel).
- Note di revisione agganciate a un'immagine o alla resa di un `.md`.

## Impact

- Server: `server/routes/tasks.ts` (`gitDiffBundle`, rotte `/diff` e
  `/publish-diff`), `server/services/task-diff-range.ts` (revisioni della gamma).
- Shared: `shared/preview-kind.ts` (una mappa estensione → tipo di anteprima e
  MIME, letta da server e client).
- Client: `Board/UnifiedDiff.tsx`, `Board/TaskDetail.tsx`,
  `Board/KanbanBoardPane.tsx`, `Git/changedFiles.ts`, `Editor/MarkdownPreview.tsx`,
  `lib/board.ts`, `lib/i18n-it.ts`, `lib/i18n-en.ts`.
- Test: `tests/e2e/board-task-changes-panel.spec.ts` si estende (ha gia' repo,
  worktree e land veri), `server/services/task-diff-range.test.ts`,
  `client/src/components/Board/UnifiedDiff.test.tsx`.
- Nessuna migration, nessun campo nuovo nel DB.
