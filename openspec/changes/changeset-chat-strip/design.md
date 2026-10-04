# Design: changeset-chat-strip

Solo le scelte tecniche; quelle che si vedono stanno nel blocco di `proposal.md`.

## 1. Il contratto

`shared/change-set.ts`:

```ts
export interface ChangeSetFile { path: string; additions: number; deletions: number; status: string; origPath?: string }
export interface ChangeSet { stat: ChangeSetFile[]; patch: string; truncated: boolean; revs: DiffRevs | null }
```

- `server/lib/git-diff-stat.ts`: `export type DiffStatEntry = ChangeSetFile` (alias, per non
  toccare i suoi chiamanti in questa change).
- `gitDiffBundle` (`server/routes/tasks.ts:547`) ritorna `Omit<ChangeSet, 'revs'>`; le rotte
  `/diff` e `/publish-diff` gia' aggiungono `revs` accanto (`:3099`, `:3189`).
- `client/src/lib/board.ts`: `DiffFileStat = ChangeSetFile`; `DiffBundle extends
  Omit<ChangeSet, 'revs'>` con `revs?: DiffRevs | null` (la risposta di una card mancata,
  `miss()` in `tasks.ts:3119`, porta `revs: null`, ma i test costruiscono pacchetti senza).
- La prova del contratto e' il typecheck: le due parti importano lo stesso tipo. Il test di
  `CHGSET-01` passa le tre risposte vere da `buildFileRows`, cioe' da quello che il pannello
  disegna davvero.

## 2. Il bersaglio di un topic, risolto una volta

Oggi `computeTopicChanges` (`server/lib/topic-changes.ts:435`) sceglie fra la gamma della
card (`rangeChanges`, `:317`) e le tool call (`toolCallFiles`, `:379`) e butta via la
scelta. La si tira fuori:

```ts
type TopicChangeTarget =
  | { kind: 'range'; cwd: string; range: string; live: boolean; taskId: string; paths: null }
  | { kind: 'head'; cwd: string; range: 'HEAD'; live: true; paths: string[] }   // repo-relative
  | null;
```

`resolveTopicChangeTarget(cwd, messages, anchors)` applica le stesse regole di oggi, guardia
del commit di consegna compresa (`:344`), e la usano tutte e due le rotte:

- `/changes`: `computeTopicChanges` prende il bersaglio gia' risolto e aggiunge
  `revs = revsOfRange(...)` (un `rev-parse` in piu' a fine turno).
- `/changes/diff`: `gitDiffBundle(cwd, range, { includeUntracked: live, paths })` +
  `revsOfRange`.

Un repository senza commit (`hasHead` falso, `:390`) non ha `HEAD`: `revs: null` e il
changeset ha solo i file non tracciati, contro `/dev/null`, come oggi i conteggi.

Con la scelta 2 cambiata il ramo `head` diventerebbe `{ range: <sha salvato> }`, e lo SHA
andrebbe scritto sul topic alla prima tool call di scrittura: una colonna e una migration.

## 3. Path limitati

`gitDiffStat` e `gitDiffBundle` imparano `paths?: string[]`: con `paths`, ogni `git diff`
riceve `--literal-pathspecs ... -- <paths>` e i non tracciati si filtrano a quell'insieme
(`ls-files --others -- <paths>`). Senza `paths` il comportamento resta identico, ed e' quello
di card e pubblicazione.

`?file=` e `?file=&blob=` controllano l'appartenenza al changeset prima di chiamare
`gitDiffFilePatch` / `serveDiffBlob`: lo `stat` si calcola comunque per sapere `revs` e
il bersaglio, e un `Set` dei suoi path (piu' gli `origPath`) e' il cancello. Per un topic di
card la gamma e' quella della card: l'insieme e' lo `stat` della card.

## 4. La striscia

- `DiffPanelSource` guadagna `{ kind: 'topic'; topicId: string }` e `diffRoute` la manda su
  `/topics/:id/changes/diff`. `UnifiedDiff` la tiene stabile per valore con un ramo in piu'
  (`UnifiedDiff.tsx:584-590`).
- `ChangedFilesStrip`: la tendina (`DockedStripPanel`, `:76`) monta `UnifiedDiff` sul
  changeset, sotto ci sono le sole righe che il changeset non contiene, ancora con
  `ChangedFileList` e l'apertura di oggi (`changesStripOpen.ts`, il cui ramo `task` sparisce).
- Il changeset lo chiede un hook accanto a `useTopicChanges` (`useTopicChangeSet`), solo a
  tendina aperta. A `stream:end` `useTopicChanges` rilegge l'elenco come oggi; l'hook del
  changeset rilegge solo se `revs` o i conteggi dell'elenco sono cambiati. Contatore contro il
  sorpasso fra due richieste, come `TaskDetail.tsx:410`.
- `onStale` (un `409` dai byte) rilegge il changeset.
- Sul topic di una card (`changes.taskId`), in testa alla tendina un collegamento «Apri nella
  card» che chiama `openTaskInApp({ taskId }, diffFocusFor(<file aperto>))`.
- Altezza: `max-h-[60vh]` al posto di `max-h-48`, con lo scroll dentro la tendina.
- Stringhe nuove in `i18n-it.ts` e `i18n-en.ts`: `chat.changes.openInCard`,
  `chat.changes.outside` (titolo delle righe fuori dal changeset).
