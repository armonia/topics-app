# Design: single-changeset-diff-panel

Solo le scelte tecniche; quelle che si vedono stanno nel blocco di `proposal.md`.

## 1. Le revisioni si risolvono una volta, dove si risolve la gamma

Un helper in `server/services/task-diff-range.ts`:
`revsOfRange(run, cwd, range, live) → { base, head } | null`. Una gamma `a..b`
diventa `rev-parse --verify a^{commit}` e `b^{commit}` (per la base, se
`^{commit}` fallisce, `^{tree}`: e' il caso dell'albero vuoto qui sotto); una revisione sola
(`live`) diventa `{ base: rev-parse(range), head: null }`. La base puo' essere
l'albero vuoto (`emptyTree`, `task-diff-range.ts:75`) quando il commit piu'
vecchio e' la radice: si accetta cosi' com'e', ogni `git cat-file` su un path
dentro l'albero vuoto e' un `404`, cioe' «file aggiunto».

Lo usa la rotta `/diff` sul `TaskDiffRange` gia' risolto e `/publish-diff` sul
suo `upstream..HEAD`. Con la scelta 1 cambiata, lo stesso helper da' `revs` anche a
`/api/topics/:id/changes` (base `HEAD`, head `null`) e la striscia della chat
monta `UnifiedDiff` con sorgente `topic`: e' li' che nasce `DIFFPV-06`.

## 2. Perche' la rotta della card e non `/api/git/show`

- `/api/git/show` legge con `.text()` e risponde `text/plain`
  (`files.ts:1055-1058`): un binario arriva corrotto. Cambiarla vuol dire toccare
  una rotta che usano il pannello Git e `FilePane`.
- Il suo `cwd` arriva dal client e passa `resolveProjectPath`; un worktree di
  card lo risolve il server, e dopo la potatura la card si legge dal checkout del
  progetto. La rotta della card sa gia' tutto questo.
- Il Dopo di un worktree vivo e' l'albero di lavoro, che `git show` non legge.

Il controllo `rev ∈ { revs.base, revs.head, worktree }` costa due `rev-parse` in
piu' per richiesta: la gamma va risolta comunque per sapere il `cwd`.

## 3. Lettura senza fermare il server

- Dimensione prima: `git cat-file -s <rev>:<path>` (o `stat` sul disco) e
  `413` sopra 10 MB, senza leggere.
- Byte in streaming: `new Response(Bun.spawn(["git", "cat-file", "blob",
  `${rev}:${path}`]).stdout)`; sul disco `new Response(Bun.file(real))`.
- `Cache-Control: private, max-age=31536000, immutable` su una revisione SHA
  (e' indirizzata per contenuto), `no-store` su `worktree`.
- Il client non chiede niente finche' il file resta chiuso, e l'`<img>` porta
  `loading="lazy"`.

## 4. Una mappa sola per «cosa si puo' mostrare»

`shared/preview-kind.ts`: estensione → `{ kind: 'image' | 'svg' | 'markdown',
mime }`. La leggono la rotta (cosa servire, con che `Content-Type`) e
`UnifiedDiff` (cosa disegnare). `Editor/fileMedia.tsx` resta com'e': serve
`FilePane`, che guarda il disco, e allinearlo e' fuori da qui.

## 5. Il pannello

- `UnifiedDiff` prende `source: { kind: 'task', projectId, taskId, attemptId? }
  | { kind: 'publish', projectId }` al posto di `projectId`/`taskId`/`attemptId`
  sciolti. Da `source` + `bundle.revs` si costruiscono tre URL: patch di un file,
  patch con `context=full`, byte. `KanbanBoardPane.tsx:325` passa
  `{ kind: 'publish' }` e guadagna il patch pigro.
- `FileDiff` sceglie il corpo dal tipo: immagine → coppia; `svg`/`markdown` →
  diff con interruttore; testo → diff con «File intero»; altro binario →
  «binario».
- `MarkdownPreview` guadagna una prop facoltativa
  `resolveImage?: (src: string) => string | null`. Il renderer delle immagini non
  sta in `MarkdownPreview` ma in `markdownComponents`
  (`client/src/components/MessageContent.tsx:575-602`), che la cartella la legge
  da `MarkdownBaseDirContext` (`:43`): la funzione viaggia quindi in un contesto
  accanto a quello, letto per primo dal renderer. Assente, il comportamento di
  `FilePane` e della chat resta identico.
- «File intero» usa `git diff -U100000` sul solo file: stessi numeri di riga,
  quindi `anchorOf`/`noteKey` (`reviewNotes.ts`) non cambiano. Il tetto
  `DIFF_FILE_PATCH_CAP` (2 MB) resta.
- Stringhe nuove in `i18n-it.ts` e `i18n-en.ts`: `diff.before`, `diff.after`,
  `diff.preview`, `diff.viewDiff`, `diff.fullFile`, `diff.previewUnavailable`.
