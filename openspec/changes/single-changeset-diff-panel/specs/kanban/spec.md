# Delta: kanban (single-changeset-diff-panel)

Il prefisso `DIFFPV` e' di questa change: niente numeri `KANBAN-NN`, che fra
change non archiviate si sono gia' scontrati (vedi l'archivio di
`pavimento-check-configurabile`).

## ADDED Requirements

### Requirement: DIFFPV-01 — Il pacchetto del diff nomina le due revisioni che confronta

La risposta di `GET /api/boards/:p/tasks/:t/diff` (con e senza `?attempt=`) e di
`GET /api/boards/:p/publish-diff` SHALL portare `revs: { base, head }`:

- `base`: lo SHA intero del Prima, risolto con `git rev-parse` dalla gamma di
  `resolveTaskDiffRange` (`task-diff-range.ts:252`) o dalla gamma della
  pubblicazione (`tasks.ts:3219`). Mai un nome simbolico (`main`, `sha^1`,
  `origin/x`): un nome si sposta, uno SHA no.
- `head`: lo SHA intero del Dopo, oppure `null` quando la gamma e' `live` e il
  Dopo e' l'albero di lavoro del worktree.

Ogni voce di `stat` SHALL portare `origPath` quando `--name-status` dice `R` o
`C` (oggi `gitDiffBundle`, `tasks.ts:620-624`, tiene solo il path nuovo), e
`rowFromDiffStat` (`changedFiles.ts:80`) SHALL passarlo alla riga.

Il campo `base` di oggi (il selettore di `git diff`) resta com'e': nessuno nel
client lo legge.

#### Scenario: card gia' fusa
- **GIVEN** una card fusa su main e il worktree potato (fonte `landed-merge`)
- **WHEN** il client chiede il diff della card
- **THEN** `revs.base` e' lo SHA di `<merge>^1` e `revs.head` e' lo SHA del merge,
  entrambi di 40 caratteri esadecimali

#### Scenario: worktree vivo
- **GIVEN** una card con il worktree vivo e un file non ancora committato
- **WHEN** il client chiede il diff della card
- **THEN** `revs.head` e' `null` e `revs.base` e' lo SHA della base propria della card

#### Scenario: file rinominato
- **GIVEN** una consegna che rinomina `docs/a.png` in `docs/b.png`
- **THEN** la voce di `stat` per `docs/b.png` porta `origPath: "docs/a.png"`

### Requirement: DIFFPV-02 — Un'immagine cambiata si vede, Prima e Dopo

Un file la cui estensione e' un'immagine (`png jpg jpeg gif webp avif bmp ico`,
dalla mappa condivisa `shared/preview-kind.ts`) SHALL mostrare, quando lo si
apre, una coppia Prima/Dopo al posto di `tr('diff.binary')`
(`UnifiedDiff.tsx:219-220`):

- `data-testid="diff-image-pair"`, con dentro `diff-image-before` e
  `diff-image-after`, ognuno un `<img>` il cui `src` e' la rotta dei byte
  (DIFFPV-05) alla revisione giusta, con l'etichetta «Prima»/«Dopo» e le
  dimensioni in pixel lette da `naturalWidth`/`naturalHeight`.
- Affiancate sopra i 640px di larghezza del pannello, una sotto l'altra sotto.
- File aggiunto: solo il Dopo. Cancellato: solo il Prima. Rinominato: il Prima
  legge da `origPath`.
- Niente si scarica finche' il file resta chiuso nel pannello.
- Un `<img>` che non carica SHALL dire «Anteprima non disponibile» al suo posto,
  mai un riquadro vuoto.
- Un binario che non e' un'immagine (PDF, font, archivio) SHALL restare
  «binario» come oggi.

#### Scenario: coppia Prima/Dopo
- **GIVEN** una card la cui consegna modifica `assets/logo.png`
- **WHEN** chi rivede apre quel file nel pannello «Modifiche»
- **THEN** compaiono due `<img>`, con `src` che punta alla rotta dei byte con
  `blob=<revs.base>` e `blob=<revs.head>`
- **AND** il testo «binario» non c'e'

#### Scenario: immagine nuova sul worktree vivo
- **GIVEN** un PNG creato dall'agente e mai committato
- **WHEN** lo si apre
- **THEN** c'e' solo il Dopo, con `blob=worktree`

#### Scenario: gli altri binari
- **GIVEN** una consegna che aggiunge un `.pdf`
- **WHEN** lo si apre
- **THEN** il pannello dice «binario» come oggi, e nessuna richiesta di byte parte

### Requirement: DIFFPV-03 — Markdown e SVG si aprono sul diff, e si possono vedere resi

Un `.md`/`.markdown` o un `.svg` SHALL aprirsi sulle righe del diff, come oggi,
con un interruttore «Diff | Anteprima» nell'intestazione del file.
«Anteprima» SHALL mostrare la versione Dopo (Prima se il file e' cancellato):
il `.md` reso da `MarkdownPreview` (caricato pigro come in `FilePane`), lo
`.svg` come `<img>` dalla rotta dei byte.

Le immagini relative dentro un `.md` reso SHALL leggere dalla rotta dei byte alla
STESSA revisione, con il path risolto dalla cartella del `.md`; un path che esce
dalla radice del repository resta testo alternativo. Oggi `MarkdownPreview` le
risolve sul disco (`client/src/components/MessageContent.tsx:589-602`, con la
cartella da `MarkdownBaseDirContext`, `:43`), che per una consegna non ancora
fusa e' la copia sbagliata del file.

Le note di revisione restano sulla vista diff: tornando da «Anteprima» a «Diff»
una nota in sospeso SHALL essere ancora al suo posto.

#### Scenario: si apre sul diff
- **GIVEN** una consegna che modifica `README.md`
- **WHEN** lo si apre
- **THEN** si vedono le righe `+/-` e l'interruttore e' su «Diff»
- **WHEN** si sceglie «Anteprima»
- **THEN** compare un titolo reso (`h1`/`h2`) del README nella versione Dopo

#### Scenario: immagine del README alla stessa revisione
- **GIVEN** un `README.md` che include `![](docs/shot.png)`, e `docs/shot.png`
  cambiato nella stessa consegna
- **WHEN** si apre «Anteprima»
- **THEN** l'`<img>` reso punta alla rotta dei byte con `file=docs/shot.png` e la
  stessa `blob` del README

### Requirement: DIFFPV-04 — «File intero» sui file di testo

Un file di testo (non binario) SHALL avere l'interruttore «File intero», che
richiede il patch di quel solo file con tutto il file come contesto
(`?file=<path>&context=full`, sulla stessa gamma di `gitDiffFilePatch`,
`tasks.ts:691`) e lo disegna con le stesse righe di oggi.

Le ancore delle note (`path`, `line`, `side`) SHALL restare valide fra le due
viste: i numeri di riga sono quelli del file in entrambe.

#### Scenario: una nota sopravvive al cambio di vista
- **GIVEN** una nota in sospeso sulla riga 40 del lato nuovo di `server/x.ts`
- **WHEN** si accende «File intero»
- **THEN** la nota compare sotto la riga 40, e le righe fuori dai blocchi
  cambiati compaiono senza colore

### Requirement: DIFFPV-05 — La rotta dei byte serve solo cio' che il pannello nomina

`?file=<path>&blob=<rev>` sulle rotte `/diff` e `/publish-diff` SHALL:

- accettare come `rev` solo `revs.base`, `revs.head` o `worktree` (e `worktree`
  solo su una gamma `live`) della gamma risolta ADESSO; altrimenti `409`
  `{ code: "stale_rev" }`, e il client rilegge il pacchetto. Cosi' i byte mostrati
  sono sempre quelli dei commit che l'elenco nomina, anche se la card e' stata
  fusa fra l'elenco e il clic.
- tenere `path` alle regole di `gitDiffFilePatch`: relativo, senza `..`, senza
  NUL, letto con `--literal-pathspecs`;
- su `worktree`, leggere dal disco solo se il `realpath` del file sta dentro il
  `realpath` del worktree (`isInsideDir`, `server/lib/path-containment.ts:28`):
  un symlink che esce SHALL essere `404`;
- servire solo le estensioni della mappa condivisa, con il loro MIME; il resto
  `415`;
- oltre 10 MB (`git cat-file -s`, o la dimensione su disco) `413` con
  `{ size }`, senza leggere il file;
- mandare i byte in streaming, mai con `.text()` o un buffer intero;
- mandare `X-Content-Type-Options: nosniff` e, per lo SVG,
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`.

#### Scenario: symlink che esce dal worktree
- **GIVEN** nel worktree vivo `leak.png` e' un symlink a un file fuori dal worktree
- **WHEN** si chiede `?file=leak.png&blob=worktree`
- **THEN** la risposta e' `404` e nessun byte di quel file esce

#### Scenario: path e revisioni fuori dal pacchetto
- **WHEN** si chiede `?file=../x.png`, o un `blob` che non e' `revs.base`/`revs.head`,
  o `?file=.env`
- **THEN** le risposte sono rispettivamente `400`, `409` e `415`

#### Scenario: PNG intatto
- **GIVEN** un PNG consegnato
- **WHEN** si chiede alla rotta con `blob=<revs.head>`
- **THEN** il `Content-Type` e' `image/png` e i byte sono identici a
  `git cat-file blob <revs.head>:<path>`
