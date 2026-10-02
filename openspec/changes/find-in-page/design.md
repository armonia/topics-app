# Design: find-in-page

Le scelte che cambiano cosa vedi stanno nel blocco «Da decidere» di
`proposal.md`; qui quelle tecniche, e il perché delle alternative scartate.
Ogni riga di codice citata è letta su `origin/main` del 02/10.

## 1. Una barra, un cercatore per pane

**Il registro.** `client/src/state/findRegistry.ts`, modulo con sottoscrizione
per chiave come `state/historyCompleteness.ts`:

```ts
interface PaneFinder {
  /** Cerca `query` e restituisce il totale; l'indice riparte da fermo. */
  search(query: string, opts: { matchCase: boolean }): Promise<number> | number;
  /** Va al risultato dopo o prima e restituisce l'indice (1-based) e il totale. */
  step(forward: boolean): Promise<{ index: number; total: number }> | { index: number; total: number };
  /** Toglie evidenziazioni e selezione. */
  clear(): void;
  /** Facoltativo: il motore sa sostituire (solo l'editor, FILE-FIND-01). */
  replace?: { one(text: string): void; all(text: string): number };
}
registerFinder(paneId, finder): () => void
openFind(paneId): boolean      // false = la pane non ha un cercatore
isFindOpen(paneId): boolean
```

Lo stato della barra (aperta, parola, maiuscole, indice, totale) vive nel
registro per `paneId`, non nel componente: la barra di una pane resta com'era
quando la pane torna a fuoco (FIND-01), e il gestore globale chiede al registro
senza conoscere i tipi di pane.

**La barra.** `Shared/FindBar.tsx`, estratta da `RemoteBrowserPanel.tsx:617-660`
(campo, contatore, maiuscole, su, giù, chiudi; icone lucide già lì). Il
contatore usa `stepMatchIndex` e `formatMatchCounter` di
`Browser/findInPageModel.ts` (BROWSER-FIND-01 resta com'è); cambia solo la
stringa, da `${i}/${t}` (`findInPageModel.ts:49`) a una chiave i18n «{i} di {t}»
/ «{i} of {t}».

La barra sta **sopra** il contenuto della pane, nel flusso, come oggi nel
browser (`border-b`, dentro la colonna flex): non copre la webview nativa, quindi
non entra nell'occlusione (`lib/shell/browserOcclusion.ts:33`) e non porta né
`.native-occlude` né `role="dialog"`.

## 2. I tasti

**Registro** (`shared/shortcuts.ts`): la riga ⌘F (`:98`) cambia descrizione in
«Cerca qui» e guadagna `native: { chars: ['f'] }`; nuove righe ⌘G / ⇧⌘G
(`native: { chars: ['g'] }`) e ⇧⌘F «Cerca nei progetti aperti». Rigenerato
`shortcuts_generated.rs` (`bun run gen:shortcuts`), quindi:

- **Mac**: `app_chord_dispatch_js` (`lib.rs:8820-8848`) inoltra ⌘F, ⌘G, ⇧⌘G e
  ⇧⌘F dalla pagina alla webview dell'app e li ingoia
  (`install_shortcut_forwarder`, `lib.rs:8862-9028`). Il commento a
  `lib.rs:8800-8803` che li esclude va riscritto.
- **Windows**: la stessa tabella (`chords.rs`, accordi del registro inoltrati con
  `swallow: true`, `:137`), e `chords_win.rs` chiama `SetHandled(true)`: la
  barra di WebView2 nella pane non si apre più (BROWSER-FIND-03). Il test
  `page_chords_stay_with_the_page` (`chords.rs:172-180`) oggi elenca `'f'` fra
  i tasti della pagina: con questa change il contratto cambia, `'f'` esce da
  quell'elenco e entra in quello degli inoltrati. `menu_chords.rs` non cambia.

Costo dichiarato: una pagina che ha una sua ricerca su ⌘F (Google Docs, Figma)
non la riceve più. Un'alternativa che la rispetti (lasciare passare ⌘F alla
pagina e aprire la barra solo se la pagina non l'ha presa) chiede uno script
nella pagina che parli all'app a ogni pressione; scartata per ora, perché
nessuna richiesta la chiede e la shell oggi non ha quel canale.

**Gestore** (`useKeyboardShortcuts.ts:324-328`):

```
⌘F (senza ⇧)  → se openFind(focusedPanelId) → preventDefault, fine
                 altrimenti, se la pane a fuoco è la board → fuoco nel filtro
                 altrimenti → toggleFileSearch('content') come oggi
⇧⌘F           → toggleFileSearch('content')
⌘G / ⇧⌘G      → se la barra della pane a fuoco è aperta → step(avanti/indietro)
```

La guardia `isTextInputFocused` (`:325`) **non** vale più per ⌘F: col cursore
nel campo della chat la webview dell'app non ha una ricerca sua da proteggere
(stessa ragione già scritta per Ctrl, `UndoContext.tsx:43-54`). Resta solo
l'eccezione della ricerca nei progetti già aperta, che con ⇧⌘F commuta modo
come oggi con ⌘F (SRC-02). In CodeMirror ⌘F non esce più (FILE-FIND-01) e in
xterm il tasto ⌘F non va al programma (xterm non lo usa).

Senza nessun progetto e senza cercatore, ⌘F oggi chiama `preventDefault` e non
apre niente (`:206-207`). Con questa change le pane senza testo (dashboard, cron,
profilo) restano su quel ripiego; il caso «nessun progetto» resta muto, come
oggi.

**Esc** (`useKeyboardShortcuts.ts:531-560`, capture su window, quindi prima di
qualsiasi `onKeyDown` della barra): un ramo nuovo, prima di
`hasOpenModalSurface()`: se il bersaglio è dentro una `FindBar`, chiude quella
barra e torna. Esc con il cursore altrove fa quello che fa oggi: in un
terminale va al programma (vim), in una chat in streaming interrompe il turno.
Scartato «Esc chiude la barra ovunque sia il cursore»: in un terminale ruberebbe
l'Esc a vim.

## 3. Chat

**Cosa si cerca** (scelta 2). Per ogni messaggio, nell'ordine in cui la
conversazione li mostra: il testo (`content`, o i blocchi `text` di `blocks`),
i ragionamenti (`thinking` / blocchi `thinking`), il comando o gli argomenti e
l'uscita di ogni strumento (`detail` validato, o `result` quando `detail` non
c'è: `shared/lean-tool-call.ts:23-35`). Funzione pura
`Chat/chatFind.ts`: `(messages, query, matchCase) → Hit[]`, con
`Hit = { messageId, part: 'text' | 'thinking' | { toolCallId }, offset }`.
Con l'alternativa della scelta 2 la funzione guarda solo `part: 'text'`.

**Su quali messaggi.** Quelli dello store più quelli in attesa
(`historyCompleteness`, stato `staged`). Se la storia è `partial` o `unknown`,
la barra chiede `requestHistoryCompletion(sessionKey, 'stage')`
(`state/historyCompleteness.ts:171`): le righe arrivano (0,7-1,7 s su una chat
grossa, `shared/history-paging.ts:5-9`) e restano fuori dalla lista, così la
lista non si riordina sotto gli occhi. Nel frattempo il contatore dice il
parziale con «…» e la ricerca si rifà all'arrivo. Il merge (`'apply'`) avviene
solo quando **arrivi** su un risultato in una riga non ancora nella lista:
è un salto chiesto da chi legge, come quello della palette
(`MessageList.tsx:1421`, «a jump is the reader's request, so the merge it
causes is theirs»).

Costo misurato il 02/10 su questo Mac, bun, testo sintetico di 8,2 MB in 118
messaggi (la taglia di `topic:6b99e9cf`, `shared/lean-tool-call.ts:12-13`):
4,5 ms per una parola assente, 13,3 ms per una con 132.250 risultati. Si cerca
a ogni pressione con 120 ms di attesa dopo l'ultima lettera; nessun indice.

**Scartato: `POST /api/search`.** Guarda solo `messages.content`
(`server/utils.ts:2658-2664`), tutte le chat insieme, `LIMIT`, senza posizioni:
per «dove dentro questa chat» andrebbe riscritto, e il client ha già gli stessi
dati una volta completata la storia. **Scartato: la ricerca della webview** (o
`window.find` sull'app): vede solo le righe montate (`MessageList.tsx:2267`).

**Arrivare su un risultato.** Riusa il salto della palette:
`requestScrollToMessage` (`state/scrollToMessage.ts:26`) consumato da
`MessageList.tsx:1384-1460` (`scrollToIndex`, righe che raggruppano più
strumenti, storia mancante). In più, per il risultato corrente:

- se è nei ragionamenti o in uno strumento, la sezione si apre (stato aperto
  forzato su quella riga finché il risultato è corrente; poi resta come l'ha
  lasciata chi legge);
- se è oltre i 20.000 caratteri di `clampBody` (`Chat/clampBody.ts:14`), il
  corpo si espande;
- la riga si centra nella vista, non in cima.

**Evidenziare.** CSS Custom Highlight API (`CSS.highlights`, due nomi:
`find-hit` e `find-current`): `Range` sui nodi di testo delle righe montate,
ricalcolati quando Virtuoso monta o smonta una riga. Non tocca il DOM della
riga (niente `<mark>` dentro il markdown già reso, niente layout shift), e va via
da sé quando la riga si smonta. Nel repo oggi non è usata (nessun
`CSS.highlights` in `client/src`); WebKit l'ha da Safari 17.2, e questo Mac ha
WebKit 26.2 (`Safari.app` 26.2 su macOS 26.2, letto il 02/10); WebView2 è
Chromium. `tauri.conf.json` non fissa una versione minima di macOS. Dove
`CSS.highlights` manca, resta l'evidenziazione della riga che c'è già
(`chat-msg-jump-highlight`, `MessageList.tsx:2314`), senza ripieghi in più.

Il conteggio viene dai dati, l'evidenziazione dal testo a schermo: dove il
markdown cambia il testo (una parola spezzata da `**`, un link) il risultato
c'è nel conteggio e la riga si evidenzia intera. Accettato, è raro e visibile.

**Mentre l'agente scrive.** Il messaggio in streaming si ricerca a ogni
aggiornamento del suo testo (stesso ritmo di 120 ms); i risultati nuovi si
aggiungono in coda, e l'indice del risultato corrente non cambia (CHAT-FIND-03).

## 4. Browser

**Motore** (scelta 3): quello che c'è, `findInPage`, `stopFind`,
`countMatches` (`hooks/useTauriBrowser.ts:1716-1751`), cioè `window.find` via
`browser_exec_js` e un conteggio su `innerText` via `browser_eval_js`.
`browser_exec_js` (`lib.rs:7528`) e `browser_eval_js` (`lib.rs:7113-7135`)
girano su Mac, Windows e Linux: lo stesso JS dà lo stesso comportamento sui tre.

Scartate le API native, per ora:

| | `window.find` (oggi) | Mac `findString:withConfiguration:` | Windows `ICoreWebView2Find` |
|---|---|---|---|
| Conteggio | nostro, su `innerText` | no (secondo l'SDK Apple, `WKFindResult` dice solo se c'è) | sì, `MatchCount`, `ActiveMatchIndex` |
| Dove | tre sistemi | solo Mac, macOS 11+ (non verificato qui) | solo Windows, versione minima del runtime non verificata |
| Nel repo | usato | binding in `objc2-web-kit-0.3.2/src/generated/WKWebView.rs:818`, non dipendenza diretta | binding in `webview2-com-sys-0.38.2/src/bindings.rs:17889`, non usato |

Due motori nativi vorrebbero dire due comportamenti e un conteggio solo su
Windows. `window.find` non entra negli iframe: accettato, come oggi.

**Solo la pane a fuoco.** Il listener di `TauriBrowserPanelInner`
(`RemoteBrowserPanel.tsx:549-575`) oggi apre la barra in ogni pane browser
montata. Con il registro il ramo ⌘F esce da quel listener: lo apre il gestore
globale, sulla pane a fuoco.

**Windows, da misurare sul PC prima di chiudere BROWSER-FIND-03.** Con il
cursore nell'interfaccia dell'app (non in una pane browser), WebView2 ha i
tasti del browser accesi (`wry-0.55.1/src/lib.rs:1687`, il repo non chiama
`with_browser_accelerator_keys`): va misurato se il nostro `preventDefault` su
Ctrl+F basta a non far aprire la barra di WebView2 sopra l'interfaccia. Se non
basta, la correzione è `with_browser_accelerator_keys(false)` sulla sola webview
dell'app, a patto che Ctrl+R e lo zoom passino già dal nostro gestore
(`menu_chords.rs:41-45`).

**Pane condivisa e client web** (scelta 5, `RemoteBrowserPanelStreaming`,
`RemoteBrowserPanel.tsx:753`): la pagina arriva come immagine o mirror
(`DomCoBrowse`, `useHostedFrame`), il motore è Playwright sul server
(`server/browser-service.ts:729`). Il cercatore registrato lì apre la barra con
il campo spento e la frase «La ricerca nella pagina qui non c'è ancora». La
strada per farla (`POST /api/browsers/:id/interact`, `action: "evaluate"`,
`server/routes/browser.ts:492`) non è provata, e uno script arbitrario da quella
route è da chiudere agli ospiti prima di usarlo per questo: con il sì
all'alternativa, l'azione nuova è `action: "find"` con soli `query`, `forward`,
`matchCase`, e nient'altro passa.

## 5. Terminale

`@xterm/addon-search` 0.16.0 (misurato con `npm view`: è la serie per xterm 6;
0,84 MB su disco non compresso, `dist.unpackedSize` 838.673). Caricato accanto a
`FitAddon` (`SingleTerminalPane.tsx:462-463`), con le decorazioni per il
risultato corrente e gli altri (servono le API proposte, già accese:
`allowProposedApi: true`, `:441`). `findNext` / `findPrevious` con
`{ caseSensitive, decorations }`; conteggio e indice da `onDidChangeResults`.
Cerca nelle righe che xterm tiene, cioè lo schermo più `scrollback: 5000`
(`:440`); ciò che è uscito da lì non c'è più, e la barra non lo promette.

Dopo una pressione in barra il fuoco resta nella barra; Esc la chiude e rimette
il fuoco nel terminale.

## 6. File

**Editor** (scelta 4). CodeMirror ha già il motore (`@codemirror/search`,
`client/package.json:25`; `search()`, `highlightSelectionMatches`,
`searchKeymap` in `CodeEditor.tsx:234-249`). Il cercatore dell'editor usa
`setSearchQuery` + `findNext` / `findPrevious`; il totale e l'indice si contano
con `SearchQuery.getCursor` sullo stato; «Sostituisci» usa `replaceNext` /
`replaceAll`, e compare solo se l'editor non è in sola lettura. Il pannello di
CodeMirror non si apre più: `Mod-f` esce dal keymap dell'editor e va al
gestore globale; `Mod-g` / `Shift-Mod-g` restano a CodeMirror (stesso effetto).
Con l'alternativa della scelta 4 si toglie l'editor dal registro e
`UndoContext.tsx:64` continua a lasciargli ⌘F.

**Anteprima Markdown e differenze** (`Editor/MarkdownPreview.tsx`,
`Editor/DiffViewer.tsx`, nessuna delle due ha una ricerca né una lista
virtuale): un cercatore generico sul DOM della pane, `TreeWalker` sui nodi di
testo + `CSS.highlights` come in §3, `scrollIntoView({ block: 'center' })` sul
corrente. Lo stesso cercatore serve a ogni pane futura fatta di solo testo.

**Fuori**: l'anteprima HTML è un `iframe` con `sandbox` senza
`allow-same-origin` (`fileMedia.tsx:121-127`), quindi dall'esterno non si
legge; i PDF sono un `iframe` con il visore del sistema (`:107-113`).

## 7. Board e telefono

**Board**: nessun cercatore; il gestore globale, con la board a fuoco, mette il
cursore nel campo filtro (`Board/FilterTokenField.tsx`, `inputRef` a `:77`).

**Telefono**: niente ⌘F. Il menu della tab (`Layout/PaneTabBar.tsx`, lo stesso
che oggi ha fissa, apri nel progetto, rimpicciolisci; sul touch si apre con la
pressione lunga) guadagna «Cerca» quando la pane ha un cercatore, e chiama
`openFind(paneId)`.

## 8. Test

- `bun:test`: `chatFind.ts` (parti, maiuscole, risultati in un messaggio in
  streaming che cresce, nessun risultato su una parola vuota); `findRegistry.ts`
  (apri senza cercatore → false, stato per pane); `findInPageModel.ts` con la
  stringa nuova.
- Rust: `chords.rs` e `mac_chord_dispatch_tests` in `lib.rs`: ⌘F e ⌘G
  inoltrati e ingoiati; `cargo test --lib` sul Mac.
- E2E `tests/e2e/find-in-pane.spec.ts` sul server isolato `:13334`, WebKit:
  chat con più di una pagina di storia seminata (`tests/e2e/helpers/seed-messages.ts`)
  e una parola solo nel primo messaggio → «1 di 1», la riga arriva in vista ed è
  evidenziata; una parola dentro l'uscita di uno strumento chiuso → la sezione
  si apre; Esc nella barra con un turno finto in streaming non lo interrompe;
  ⌘F col cursore nel campo della chat apre la barra della chat; terminale con
  `seq 1 300` e ricerca di `150`; file in editor con conteggio e Sostituisci;
  board → fuoco nel filtro; pane senza cercatore → ricerca nei progetti.
  `search-shortcuts.spec.ts` SRC-02…04 riscritti su ⇧⌘F.
- Il browser nativo non gira negli e2e (il finto Tauri parla con la produzione,
  memoria «e2e-tauri-fake-hits-prod»): ⌘F dentro una pagina vera si prova a
  mano nell'app costruita, con un video `.webm`, su Mac e sul PC Windows.
