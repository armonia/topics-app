# Delta: chat (changeset-chat-strip)

Il prefisso `CHGSET` e' di questa change: niente numeri `CHAT-NN` nuovi, che fra
change non archiviate si scontrano.

## MODIFIED Requirements

### Requirement: CHAT-CHANGES-01 - Cosa ha toccato questa conversazione

Il sistema SHALL ricavare dalle tool call di scrittura di un topic (`detail.type` `write`
o `edit`) l'elenco dei file che quella conversazione ha creato, modificato o cancellato, e
SHALL esporlo su `GET /api/topics/:id/changes` come `{ files: [{ path, kind, turns, lastAt,
added?, removed? }], git: { root, branch, dirty } | null }`.

Quando il topic lavora dentro un repository git, il sistema SHALL incrociare quei path con
`git status --porcelain` e `git diff --numstat` LIMITATI a quei path: i conteggi e lo stato
descrivono il lavoro di QUESTA conversazione, non lo sporco dell'intero repository. Fuori da
un repository la risposta SHALL restare utile (i path e il tipo dedotto dalle tool call) con
`git: null`.

SOPRA IL COMPOSER della chat - nel blocco di fondo della pane, sulla colonna della chat,
insieme alle altre strisce che stanno sopra l'input (todo, sotto-agenti, checkpoint) - il
sistema SHALL mostrare un chip con il numero dei file del topic; il chip SHALL essere assente
quando la conversazione non ha scritto nulla, e in quel caso il blocco di fondo SHALL restare
all'altezza che aveva. La striscia non SHALL stare nel chrome sopra la barra delle tab ne'
dentro il transcript. L'elenco SHALL aggiornarsi a fine turno (`stream:end`), non a ogni
token.

Il nome del branch SHALL comparire nella striscia SOLO quando il topic e' legato a un
worktree isolato (`worktreeId` non nullo) e il topic lavora dentro un repository: e' il ramo
del topic, che nessun'altra parte dello schermo dice. Per un topic senza worktree la striscia
SHALL mostrare solo il chip dei file, anche quando git ha risposto: il branch e' quello del
progetto, che la sidebar mostra gia'.

Su un topic a cui e' stato dispatchato un task l'elenco SHALL venire dalla gamma di diff del
task, la stessa che disegna il drawer (worktree vivo, poi merge del land, poi commit di
consegna): path relativi al repository e conteggi di git, compresi i file scritti da un comando
di shell o da un sotto-agente. Una tool call SHALL fondersi con la riga della gamma dello stesso
file solo se ha scritto nel worktree del task: finche' esiste, il suo path; dopo la potatura,
la cartella che il ramo `topics/<nome>` nomina (quello della consegna registrata o, senza
consegna, quello del tentativo lanciato nel topic). Le altre scritture SHALL restare righe
proprie. Una riga della gamma SHALL aprire il suo diff dentro la striscia (`CHGSET-03`), letto
dalla stessa gamma del drawer; il drawer del task SHALL restare raggiungibile dal pannello
della striscia, dove si scrivono le note di revisione. Senza una gamma
leggibile, o con una gamma letta dal commit di consegna che contiene piu' file di quanti la
review ne ha misurati in quella consegna, l'elenco SHALL restare quello delle tool call. Un
topic senza task SHALL restare sulle sue tool call anche dentro un worktree: nulla dice di chi
sia la gamma di un worktree che la sidebar puo' aver aperto a un secondo topic.

#### Scenario: il chip compare dopo un turno che ha scritto
- **GIVEN** un topic la cui conversazione contiene una tool call `write` su un file
- **WHEN** l'utente guarda il blocco sopra il composer della chat
- **THEN** vede un chip con il conteggio dei file toccati, sopra l'input e sulla sua stessa colonna
- **AND** cliccandolo si apre l'elenco con il path relativo e lo stato del file

#### Scenario: una conversazione che non ha scritto niente non mostra il chip
- **GIVEN** un topic le cui tool call sono solo letture, ricerche e comandi
- **WHEN** l'utente guarda il blocco sopra il composer della chat
- **THEN** non c'e' nessun chip dei file modificati

#### Scenario: un topic senza worktree non mostra il branch
- **GIVEN** un topic non legato a un worktree, la cui conversazione ha scritto dei file
- **WHEN** l'utente guarda la striscia sopra il composer
- **THEN** vede il chip con il conteggio dei file
- **AND** non vede nessun nome di branch, nemmeno se il topic lavora dentro un repository

#### Scenario: un topic legato a un worktree mostra il suo branch
- **GIVEN** un topic con `worktreeId` non nullo, che lavora dentro un repository e ha scritto dei file
- **WHEN** l'utente guarda la striscia sopra il composer
- **THEN** accanto al chip vede il nome del branch del worktree, con la root del repository come titolo

#### Scenario: i conteggi vengono da git e riguardano solo i file del topic
- **GIVEN** un topic dentro un repository con due `write` su file nuovi e un `edit` su un file gia' committato
- **AND** un altro file del repository sporco, che la conversazione non ha mai nominato
- **WHEN** si legge `GET /api/topics/:id/changes`
- **THEN** l'elenco contiene i tre file della conversazione, due come `created` e uno come `modified`
- **AND** ogni riga porta le righe aggiunte e tolte da `git diff --numstat`
- **AND** il file sporco che la conversazione non ha toccato non compare

#### Scenario: dalla riga al diff
- **GIVEN** l'elenco dei file modificati e' aperto
- **WHEN** l'utente clicca su una riga del changeset del topic
- **THEN** il diff di quel file si apre dentro la striscia, senza aprire una pane editor
- **WHEN** l'utente clicca su una riga fuori dal changeset (un file fuori dal repository)
- **THEN** il file si apre nella pane editor, come prima

#### Scenario: il topic di un task atterrato elenca la gamma del land
- **GIVEN** un task atterrato con `merge task <id>` e il suo worktree potato
- **AND** una conversazione che ha scritto `src/a.ts` nel worktree con una tool call, e `gen.sh` con un comando di shell
- **WHEN** si legge `GET /api/topics/:id/changes`
- **THEN** ogni file compare una volta sola, relativo al repository, con i conteggi del merge
- **AND** la riga di `src/a.ts` porta i turni della tool call, quella di `gen.sh` zero turni

#### Scenario: dalla riga della gamma al diff della card
- **GIVEN** l'elenco dei file modificati di un topic di task e' aperto
- **WHEN** l'utente clicca su una riga della gamma del task
- **THEN** il diff di quel file si apre dentro la striscia, con le stesse righe che il drawer
  del task disegna per quel file

#### Scenario: dalla riga della gamma al drawer del task
- **GIVEN** la striscia di un topic di task e' aperta su un file della gamma
- **WHEN** l'utente clicca sul collegamento alla card nel pannello della striscia
- **THEN** si apre il drawer del task sul pannello delle modifiche, con quel file a fuoco

#### Scenario: un topic senza task nel worktree di un altro topic
- **GIVEN** due topic legati allo stesso worktree, nessuno dei due con un task
- **AND** il primo ha scritto e committato dei file, il secondo ha solo letto
- **WHEN** si legge `GET /api/topics/:id/changes` del secondo
- **THEN** l'elenco e' vuoto

Le RIGHE dell'elenco non sono di questa striscia: sono il componente condiviso
descritto da `GIT-FILELIST-01` (lettera di stato, percorso col nome intero,
conteggi o «bin»), lo stesso che monta il chip di consegna di una card e l'intestazione di ogni
file di `UnifiedDiff`. Qui restano il chip, il conteggio, il branch e l'apertura del diff.


## ADDED Requirements

### Requirement: CHGSET-01 — Un insieme di modifiche ha un contratto solo, in `shared/`

Il sistema SHALL dichiarare UNA volta, in `shared/change-set.ts`, la forma di un insieme di
modifiche che il pannello del diff legge:

- `ChangeSetFile`: `path`, `additions` e `deletions` (`-1` per un binario), la lettera di
  `--name-status` in `status`, `origPath` solo su rinomina e copia;
- `ChangeSet`: `stat: ChangeSetFile[]`, `patch` (il diff unificato, tagliato al tetto),
  `truncated`, `revs: DiffRevs | null` (`shared/diff-revs.ts`).

Il server SHALL tipizzare con quella dichiarazione cio' che oggi dichiara per conto suo
(`DiffStatEntry`, `server/lib/git-diff-stat.ts:15`, e il ritorno di `gitDiffBundle`,
`server/routes/tasks.ts:547`); il client SHALL derivarne `DiffFileStat` e `DiffBundle`
(`client/src/lib/board.ts:867`, `:893`), con `DiffBundle` che estende `ChangeSet` dei soli
campi della card (`branch`, `range`, `base`, `code`, `source`). Nessun campo del filo SHALL
cambiare nome: le rotte della card e della pubblicazione rispondono lo stesso JSON di oggi.

#### Scenario: tre rotte, una forma
- **GIVEN** un repository con un file modificato, letto dalla rotta del diff di una card,
  da quella della pubblicazione e da quella del changeset di un topic
- **WHEN** ogni risposta passa da `buildFileRows` (`Board/diffFileRows`)
- **THEN** ognuna da' una riga per quel file, con lo stesso `path` e gli stessi conteggi

#### Scenario: una sola dichiarazione
- **WHEN** si cerca `interface ChangeSetFile` e `interface DiffStatEntry` nel repository
- **THEN** la prima compare una volta, in `shared/change-set.ts`, e la seconda non c'e' piu'
  come interfaccia propria

### Requirement: CHGSET-02 — Il changeset di un topic, letto dove si legge il suo elenco

`GET /api/topics/:id/changes` SHALL portare `revs: DiffRevs | null`, risolte con
`revsOfRange` (`server/services/task-diff-range.ts:345`) sullo stesso bersaglio da cui viene
l'elenco:

- topic di un task con una gamma leggibile: la gamma del task, quella del drawer;
- topic dentro un repository, senza task: `{ base: <SHA di HEAD>, head: null }`, perche' il
  Dopo e' l'albero di lavoro;
- topic fuori da un repository, o senza file: `null`.

`GET /api/topics/:id/changes/diff` SHALL rispondere un `ChangeSet` (CHGSET-01) sullo STESSO
bersaglio, risolto una volta per entrambe le rotte:

- topic di un task: la gamma del task senza filtro di path, quindi lo stesso `stat` di
  `GET /api/boards/:p/tasks/:t/diff`; vale anche la stessa guardia dell'elenco sul commit di
  consegna (piu' file di quanti la review ne ha misurati = niente gamma, si torna alle tool call);
- topic senza task: `HEAD` contro l'albero di lavoro, LIMITATO ai path relativi al repository
  che le tool call di scrittura nominano (al piu' `MAX_GIT_PATHS`), file non tracciati compresi
  solo se sono fra quei path: un file sporco che la conversazione non ha nominato non c'e';
- fuori da un repository: `{ stat: [], patch: "", truncated: false, revs: null }`.

`?file=<path>` (con `context=full` e `orig=<path>`) SHALL dare il patch di un file come la
rotta della card (`gitDiffFilePatch`, `server/services/task-diff-file.ts:77`), e SHALL
rispondere `404` `{ code: "not_in_changeset" }` per un path che lo `stat` del changeset non
contiene.

#### Scenario: un file sporco che la chat non ha nominato
- **GIVEN** un topic senza task che ha scritto `a.ts` e `b.ts` in un repository
- **AND** `c.ts` modificato nello stesso checkout da qualcun altro
- **WHEN** si legge `GET /api/topics/:id/changes/diff`
- **THEN** lo `stat` contiene `a.ts` e `b.ts` e non `c.ts`, e il `patch` non nomina `c.ts`
- **AND** `revs.base` e' lo SHA di `HEAD` (40 caratteri esadecimali) e `revs.head` e' `null`

#### Scenario: il topic di una card legge il changeset del drawer
- **GIVEN** il topic a cui e' stato dispatchato un task, con il worktree vivo
- **WHEN** si legge `GET /api/topics/:id/changes/diff` e `GET /api/boards/:p/tasks/:t/diff`
- **THEN** i due `stat` e le due `revs` sono uguali

#### Scenario: revs anche sull'elenco
- **GIVEN** un topic senza task che ha scritto un file in un repository
- **WHEN** si legge `GET /api/topics/:id/changes`
- **THEN** la risposta porta `revs` uguale a quella di `GET /api/topics/:id/changes/diff`

#### Scenario: un file fuori dal changeset
- **WHEN** si chiede `GET /api/topics/:id/changes/diff?file=c.ts` per un file che la
  conversazione non ha nominato
- **THEN** la risposta e' `404` con `code: "not_in_changeset"`

### Requirement: CHGSET-03 — La striscia della chat apre il diff con il pannello unico

La tendina della striscia dei file modificati (`ChangedFilesStrip`, sopra il composer) SHALL
disegnare `UnifiedDiff` sul changeset del topic (CHGSET-02) al posto dell'elenco semplice, con
una sorgente nuova `{ kind: 'topic', topicId }` in `DiffPanelSource`. Ogni riga resta la riga
condivisa `ChangedFileEntry` e, aperta, mostra quello che mostra in una card: il diff, la
coppia Prima/Dopo di un'immagine, «Anteprima» di un `.md` o `.svg`, «File intero»
(`DIFFPV-02`..`DIFFPV-04`).

- `UnifiedDiff` SHALL tenere stabile anche la sorgente `topic`: oggi
  (`client/src/components/Board/UnifiedDiff.tsx:584-590`) ricostruisce la sorgente con due
  soli rami, e un terzo tipo diventerebbe in silenzio una pubblicazione.
- Il changeset SHALL essere chiesto solo quando la tendina si apre; a tendina aperta SHALL
  rileggersi a fine turno solo se `GET /api/topics/:id/changes` riporta altre `revs` o altri
  conteggi, e una risposta arrivata dopo una piu' recente SHALL essere scartata.
- Un `409 stale_rev` dalla rotta dei byte SHALL rileggere il changeset, come nella card.
- Nella chat il diff SHALL essere in sola lettura: `UnifiedDiff` senza `review`.
- Sul topic di un task il pannello SHALL portare un collegamento che apre il drawer del task
  su quel file (`openTaskInApp` con `diffFocusFor`), dove si scrivono le note.
- Le righe dell'elenco che il changeset non contiene (un file scritto fuori dal repository,
  oltre `MAX_GIT_PATHS`, o una scrittura fuori dalla gamma del task) SHALL restare righe
  dell'elenco semplice sotto il diff, e aprirsi come oggi.
- La tendina SHALL scorrere al suo interno fino al 60% dell'altezza della finestra, invece
  dei 192px di oggi (`max-h-48`, `ChangedFilesStrip.tsx:76`).

#### Scenario: due file, il diff giusto
- **GIVEN** un topic senza task la cui conversazione ha modificato `a.txt` e creato `b.txt`
  in un repository
- **WHEN** l'utente apre la striscia dei file modificati
- **THEN** vede due righe, `a.txt` e `b.txt`, con i conteggi di git
- **WHEN** clicca su `a.txt`
- **THEN** sotto la riga compaiono le righe `-`/`+` del cambiamento di `a.txt`, e nessuna pane
  editor si apre

#### Scenario: un'immagine cambiata dalla chat
- **GIVEN** una conversazione che ha riscritto `docs/shot.png` in un repository
- **WHEN** l'utente apre quel file nella striscia
- **THEN** compare la coppia Prima/Dopo, con `blob=<revs.base>` e `blob=worktree`

#### Scenario: il collegamento compare solo sul topic di una card
- **GIVEN** un topic senza task e il topic di un task, ognuno con la striscia aperta su un file
- **THEN** il collegamento alla card c'e' solo nella striscia del topic del task

### Requirement: CHGSET-04 — I byte del changeset di un topic

`GET /api/topics/:id/changes/diff?file=<path>&blob=<rev>` SHALL seguire le regole di
`DIFFPV-05` (`serveDiffBlob`, `server/services/task-diff-file.ts:117`) sul bersaglio del
topic: solo `revs.base`, `revs.head` o `worktree` della risoluzione di ADESSO, path relativo
senza `..`, symlink che esce `404`, solo le estensioni di `shared/preview-kind.ts`, `413`
oltre 10 MB, byte in streaming. In piu' SHALL rispondere `404` `{ code: "not_in_changeset" }`
per un path che lo `stat` del changeset non contiene: il checkout di un topic senza worktree
e' quello del progetto, e la rotta non e' una finestra su tutto il repository.

#### Scenario: un'immagine che la chat non ha toccato
- **GIVEN** `assets/logo.png` versionato nel repository e mai nominato dalla conversazione
- **WHEN** si chiede `?file=assets/logo.png&blob=<revs.base>`
- **THEN** la risposta e' `404` con `code: "not_in_changeset"` e nessun byte esce

#### Scenario: PNG intatto
- **GIVEN** un PNG scritto dalla conversazione
- **WHEN** si chiede `?file=<path>&blob=worktree`
- **THEN** il `Content-Type` e' `image/png` e i byte sono identici al file su disco
