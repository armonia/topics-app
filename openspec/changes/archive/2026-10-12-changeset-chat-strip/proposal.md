# Proposal: changeset-chat-strip

## Da decidere

1. Il diff si apre dentro la striscia che c'e' gia': la sua tendina passa dall'elenco a `UnifiedDiff`, stesse righe che ora si espandono (consigliata: una lista sola, nessun popover nuovo) (alternativa: elenco com'e', il clic apre un popover col pannello).
2. Il Prima di una chat senza card e' l'`HEAD` del checkout quando si legge, come i conteggi di oggi (consigliata: stessi numeri della striscia, zero stato nuovo) (alternativa: l'`HEAD` del primo turno che scrive, salvato sul topic: regge i commit fatti in chat, costa una colonna e una migration).
3. Nella chat il diff e' in sola lettura, senza note di revisione (consigliata: il destinatario di una nota e' la chat stessa, e il composer sta subito sotto) (alternativa: le note finiscono come bozza nel composer).
4. In una chat di card una riga della gamma apre il diff nella striscia, e un collegamento porta al drawer per le note (consigliata: stesso changeset del drawer, un clic in meno) (alternativa: la riga continua ad aprire il drawer, come oggi).
ok / ok ma 2 no

## Dove cambiarla

| Scelta | Requisito e design |
|---|---|
| 1 | spec `CHGSET-03` (primo paragrafo, scenario «due file, il diff giusto»), `CHAT-CHANGES-01` scenario «dalla riga al diff»; `design.md` §4 |
| 2 | spec `CHGSET-02` (secondo punto dell'elenco `revs` e del changeset); `design.md` §2 |
| 3 | spec `CHGSET-03`, punto «sola lettura»; `design.md` §4 |
| 4 | spec `CHAT-CHANGES-01` (riga della gamma, scenario «dalla riga della gamma al diff della card»), `CHGSET-03` punto del collegamento; `design.md` §4 |

## Gia' deciso, senza scelta

- Il changeset di una chat senza card e' limitato ai file che le sue tool call nominano, come
  i conteggi di oggi: lo sporco del checkout condiviso resta fuori, anche nella rotta dei byte.
- Nessun campo del filo cambia nome: card e pubblicazione rispondono lo stesso JSON.
- I file fuori dal changeset (fuori dal repository, oltre 400 path) restano righe semplici
  sotto il diff e si aprono come oggi.
- Nessuna migration, nessun campo nuovo nel DB (con la scelta 2 consigliata).

## Why

La striscia dei file modificati in chat esiste gia' e funziona: e' il punto di partenza, non
un doppione da affiancare. Quello che le manca e' il pannello unico che la board ha avuto
con `single-changeset-diff-panel`.

- **La striscia c'e', il diff no.** `ChangedFilesStrip` (`client/src/components/Chat/ChangedFilesStrip.tsx:45`,
  montata in `ChatPane.tsx:2053`) apre una tendina con l'elenco semplice
  (`ChangedFileList`, `:76-78`, alta al massimo 192px). Una riga apre altro: il diff
  dell'editor (`open-file-diff`, `:66-68`), che confronta `HEAD` con il disco
  (`Editor/FilePane.tsx:216`) e di un'immagine mostra solo il Dopo (`:151`); oppure, per
  una riga della gamma di un task, il drawer della card (`lib/changesStripOpen.ts:25-26`).
  Per vedere cosa ha fatto la chat si esce dalla chat.
- **Il contratto e' scritto due volte.** Il server dichiara `DiffStatEntry`
  (`server/lib/git-diff-stat.ts:15-26`) e il ritorno di `gitDiffBundle` in linea
  (`server/routes/tasks.ts:547-551`); il client ridichiara la stessa riga come
  `DiffFileStat` (`client/src/lib/board.ts:867-874`) e il pacchetto come `DiffBundle`
  (`:893-904`). Nessun tipo li lega: un campo cambiato da una parte passa il typecheck.
  `shared/` ha gia' i due pezzi su cui costruire (`diff-revs.ts`, `preview-kind.ts`).
- **`/api/topics/:id/changes` non nomina revisioni.** La rotta (`server/routes/topics.ts:2374-2396`)
  risponde `TopicChanges` (`shared/topic-changes.ts:48-54`): path, tipo, turni, conteggi.
  Le revisioni le sa gia': per un topic di card la gamma del drawer
  (`server/lib/topic-changes.ts:317`, `resolveTaskDiffRange`), per gli altri `git diff HEAD`
  limitato ai path delle tool call (`:379`, `toolCallFiles`). Non le dice, e senza `revs`
  la rotta dei byte non ha niente da controllare.
- **Il pannello conosce due sorgenti.** `DiffPanelSource` (`client/src/lib/board.ts:907-909`)
  e' `task` o `publish`, e `UnifiedDiff` la ricostruisce con due soli rami
  (`UnifiedDiff.tsx:584-590`): un terzo tipo diventerebbe una pubblicazione in silenzio.

## What changes

1. **`shared/change-set.ts`**: `ChangeSetFile` e `ChangeSet` (`stat`, `patch`, `truncated`,
   `revs`). Server e client li importano; `DiffBundle` della card li estende.
2. **Il bersaglio di un topic si risolve una volta**: la gamma della card o `HEAD` + i path
   della chat. `/changes` ci aggiunge `revs`; la rotta nuova `/changes/diff` ci risponde un
   `ChangeSet`, il patch di un file (`?file=`, `context=full`, `orig=`) e i byte
   (`?file=&blob=`), solo per i path del changeset.
3. **La striscia monta `UnifiedDiff`** con la sorgente `topic`: la riga si apre li', con la
   coppia Prima/Dopo, «Anteprima» e «File intero» della card. Sul topic di una card, un
   collegamento al drawer per le note.

## Non-goals

- Note di revisione in chat (scelta 3).
- Un Prima che regga i commit fatti in chat (scelta 2, alternativa).
- Le scritture di un comando di shell in una chat senza card: restano fuori come oggi, perche'
  nessuna tool call le nomina.
- `Project/GitChanges.tsx` e il diff dell'editor: restano come sono, per chi li apre dal
  pannello Git.

## Impact

- Shared: `shared/change-set.ts` (nuovo), `shared/topic-changes.ts` (`revs`).
- Server: `server/lib/topic-changes.ts` (bersaglio condiviso), `server/routes/topics.ts`
  (`/changes` con `revs`, `/changes/diff`), `server/lib/git-diff-stat.ts` (tipo condiviso e
  path limitati), `server/routes/tasks.ts` (`gitDiffBundle` tipizzato, path limitati),
  `server/services/task-diff-file.ts` (riuso di `gitDiffFilePatch` e `serveDiffBlob`).
- Client: `lib/board.ts` (`DiffFileStat`, `DiffBundle`, `DiffPanelSource` con `topic`,
  `diffRoute`), `Board/UnifiedDiff.tsx` (sorgente stabile a tre rami),
  `Chat/ChangedFilesStrip.tsx`, `hooks/useTopicChanges.ts` (o un hook accanto per il changeset),
  `lib/changesStripOpen.ts`, `lib/i18n-it.ts` e `lib/i18n-en.ts`.
- Test: `server/lib/topic-changes.test.ts`, `tests/integration/topic-changes-route.test.ts` (repository vero),
  `tests/e2e/chat-changed-files.spec.ts` e `chat-changed-files-task-range.spec.ts` si
  estendono (la seconda cambia il suo «la riga apre il drawer», scelta 4).
