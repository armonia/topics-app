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

**La tastiera.** Una pane browser nativa è una webview sorella che tiene la
tastiera del sistema finché è lì. Mettere il cursore in un campo della webview
dell'app non la sposta: il campo sembra a fuoco e le lettere vanno alla pagina.
È misurato su Windows 2.2.291 (`Browser/useBrowserChromeBridge.ts:107-118`) e
vale anche per WKWebView, che tiene il first responder. Quindi `FindBar`,
aprendosi, chiama `releaseNativeFocus()` (`lib/shell/tauri.ts:50-56` →
`browser_release_focus`, `lib.rs:7701-7737`: `makeFirstResponder` sul Mac,
`set_focus` della webview dell'app altrove) **prima** di `input.focus()`, come fa
già la barra degli indirizzi. Fuori dalla shell è un no-op.

**La strada inversa.** Con Esc la tastiera torna alla pagina se la barra si era
aperta da lì. Oggi in release non c'è un comando che lo faccia:
`focus_grab_browser` (`lib.rs:8083`) è `#[cfg(debug_assertions)]`. Serve un
comando nuovo, `browser_focus_pane(id)`: sul Mac è il corpo di
`focus_grab_browser_inner` (`lib.rs:8092-8115`, `makeFirstResponder` sulla
WKWebView della pane), su Windows `set_focus` sulla webview della pane (per
wry è `MoveFocus(PROGRAMMATIC)`, `lib.rs:7740-7741`). Il registro ricorda, per
pane, se la barra è stata aperta col fuoco nella pagina. Che `set_focus` su una
WebView2 figlia ridia davvero la tastiera alla pagina non è misurato: lo
controlla il giro a mano sul PC (task 4.3).

## 2. I tasti

**Registro** (`shared/shortcuts.ts`): la riga ⌘F (`:98`) cambia descrizione in
«Cerca qui» e guadagna `native: { chars: ['f'] }`; nuove righe ⌘G / ⇧⌘G
(`native: { chars: ['g'] }`) e ⇧⌘F «Cerca nei progetti aperti». Rigenerato
`shortcuts_generated.rs` (`bun run gen:shortcuts`), quindi:

- **Mac**: `app_chord_dispatch_js` (`lib.rs:8820-8848`) inoltra ⌘F, ⌘G, ⇧⌘G e
  ⇧⌘F dalla pagina alla webview dell'app. Il monitor NSEvent li **scarta**
  (`return nil`, `lib.rs:9014`): la pagina non li vede. Il commento a
  `lib.rs:8800-8803` che li esclude va riscritto.
- **Windows**: la stessa tabella (`chords.rs`, accordi del registro inoltrati con
  `swallow: true`, `:137`), e `chords_win.rs` chiama `SetHandled(true)`. Questo
  toglie solo l'azione di WebView2 (la sua barra), **non** il keydown nel DOM
  della pagina (`chords_win.rs:17-24`, `chords.rs:59-62`): la pagina sa che
  Ctrl+F è stato premuto. Il test `page_chords_stay_with_the_page`
  (`chords.rs:172-180`) oggi elenca `'f'` fra i tasti della pagina: con questa
  change il contratto cambia, `'f'` esce da quell'elenco ed entra in quello
  degli inoltrati. `menu_chords.rs` non cambia.

Costo dichiarato: una pagina che ha una sua ricerca su ⌘F (Google Docs, Figma)
sul Mac non la riceve più; su Windows la riceve **e** si apre anche la nostra
barra, perché il motore non permette di togliere il tasto alla pagina.
Un'alternativa che la rispetti (lasciare passare ⌘F alla pagina e aprire la
barra solo se la pagina non l'ha presa) chiede uno script nella pagina che parli
all'app a ogni pressione. È scartata per ora, perché nessuna richiesta la
chiede e la shell oggi non ha quel canale.

**⇧⌘F e la decisione del 06/08.** ⇧⌘F è stato ritirato apposta: era un doppione
di ⌘P, e «stessa lettera, due bersagli, distinti solo dallo shift»
(`tests/e2e/search-shortcuts.spec.ts:13-18,150-163`, SRC-05). Questa change lo
rimette, con un significato diverso. ⌘F e ⇧⌘F diventano la stessa ricerca con
due ampiezze, qui e in tutti i progetti, come in VS Code. Prima erano due
ricerche diverse, un progetto per nome e il contenuto. SRC-05 si rovescia e lo
dice il commit. `openspec/specs/files/spec.md:75-78` (Cmd+Shift+F apre la
ricerca nei file) oggi è falso e torna vero. Con l'alternativa della scelta 1
(la ricerca nei progetti senza un tasto suo, da ⌘P con l'interruttore
Nome/Contenuto) SRC-05 resta com'è e va riscritto quello scenario.

**Gestore** (`useKeyboardShortcuts.ts:324-328`):

```
⌘F (senza ⇧)  → se openFind(focusedPanelId) → preventDefault, fine
                 altrimenti, se la pane a fuoco è la board → fuoco nel filtro
                 altrimenti → toggleFileSearch('content') come oggi
⇧⌘F           → toggleFileSearch('content')
⌘G / ⇧⌘G      → se la barra della pane a fuoco è aperta → step(avanti/indietro)
```

**Quale modificatore.** Il gestore oggi accetta ⌘ e Ctrl insieme
(`isMod = e.metaKey || e.ctrlKey`, `:220`). Sul Mac Ctrl+F è un tasto vero: nel
terminale sposta avanti di un carattere (readline, emacs) ed è `^F` in less e
vim, e nel campo della chat sposta avanti di un carattere (Cocoa). Quindi la
condizione del ramo è quella degli altri rami che hanno lo stesso problema
(`:361`, `:383`, `:519`), più la piattaforma:

```
e.metaKey || usesCtrl || !isTextInputFocused(e.target)
```

`usesCtrl` è in `lib/shortcutLabel.ts:34` (vero su Windows e Linux, anche fuori
dalla shell). Sul Mac: ⌘F va sempre alla barra, e Ctrl+F resta a chi ha il
cursore (campo, terminale, editor o niente), come oggi e come ⌘G. Su Windows
Ctrl+F è l'unico modo, quindi va sempre alla barra, **anche nel terminale**:
lì readline perde Ctrl+F (avanti di un carattere; resta la freccia destra). È il
costo dichiarato nella scelta 1, ed è lo stesso di VS Code.

Fuori da quella condizione la guardia `isTextInputFocused` (`:325`) **non**
vale più per ⌘F. Col cursore nel campo della chat la webview dell'app sul Mac
non ha una ricerca sua da proteggere (stessa ragione già scritta per Ctrl,
`UndoContext.tsx:43-54`). Su Windows c'è la barra di WebView2, e il nostro
`preventDefault` è proprio quello che la tiene chiusa (da misurare, §4). Resta
solo l'eccezione della ricerca nei progetti già aperta, che con ⇧⌘F commuta
modo come oggi con ⌘F (SRC-02). In CodeMirror ⌘F non esce più
(FILE-FIND-01), e in xterm ⌘F non va al programma (xterm non lo usa).

Senza nessun progetto e senza cercatore, ⌘F oggi chiama `preventDefault` e non
apre niente (`:206-207`). Con questa change le pane senza testo (dashboard, cron,
profilo) restano su quel ripiego; il caso «nessun progetto» resta muto, come
oggi.

**Esc** (`useKeyboardShortcuts.ts:531-560`, capture su window, quindi prima di
qualsiasi `onKeyDown` della barra): un ramo nuovo, prima di
`hasOpenModalSurface()`. Se il bersaglio è dentro una `FindBar`, chiude quella
barra e rimette il cursore dove stava: nel campo o nel terminale della pane,
oppure nella pagina con `browser_focus_pane` (§1). Esc con il cursore altrove fa
quello che fa oggi: in un terminale va al programma (vim), in una chat in
streaming interrompe il turno. Scartato «Esc chiude la barra ovunque sia il
cursore»: in un terminale ruberebbe l'Esc a vim.

## 3. Chat

**Il client non ha il testo da cercare.** Le uscite degli strumenti non
arrivano mai intere nel client, nemmeno con la storia completa. Ogni pagina
passa da `leanMessagesForHistory` (`history.ts:266`): le uscite delle righe
chiuse partono vuote (`lean-tool-call.ts:305,433-436`), gli `args` vengono
azzerati quando c'è un `detail` tipizzato (`:516`) e ogni altra stringa oltre
512 caratteri è un'anteprima (`:337`). Il server non le legge nemmeno
(`withToolOutputs: false`, `history.ts:136-143`). Il testo intero arriva una
riga alla volta, quando la apri (`history.ts:391-457`,
`ToolCallRow.tsx:274-283`). Una ricerca nel client sui dati che ha
troverebbe solo il testo dei messaggi, i ragionamenti e le anteprime.

**Cosa si cerca** (scelta 2). Per ogni messaggio della sessione, nell'ordine in
cui la conversazione li mostra:
- il testo (`content`, o i blocchi `text` di `blocks`);
- i ragionamenti (`thinking` o i blocchi `thinking`);
- il comando o gli argomenti di ogni chiamata a strumento;
- la sua uscita (`detail` validato, o `result` quando `detail` non c'è).

I comandi che lancia chi scrive (`CommandRunBlock`) sono fuori: vivono in
`scriptsApi` / `commandRunStore`, non nei messaggi (`CommandRunBlock.tsx:13-19`).

**Dove si cerca: sul server** (scelta 2). Rotta nuova
`POST /api/history-find`, body `{ sessionKey, query, matchCase }`, in
`server/routes/history.ts`. Fa una lettura piena dei messaggi attivi della
sessione (`loadLocalMessages(sessionKey)` senza `withToolOutputs: false`).
Quella lettura rimette le uscite di `message_tool_outputs` al loro posto (lo dice
la migration `20260930200938-message-tool-outputs.sql`). Prima chiama
`flushTurnBody` come la storia (`history.ts:135`). La ricerca è la stessa
funzione pura del client (`shared/chat-find.ts`, perché la usano tutti e due).
Risponde con:

```ts
{ total: number, hits: Array<{ messageId: string, part: 'text' | 'thinking' | 'tool', toolCallId?: string, offset: number }>, truncated: boolean }
```

`total` è esatto; le posizioni arrivano fino a 5.000, e oltre il contatore dice
«oltre 5000». Il cancello ospiti è quello della storia. `isGuestAllowedPath`
(`server/lib/grants.ts:101`) è un elenco di permessi: `/api/history/` non c'è
(`history.ts:416`), e una rotta nuova ne resta fuori finché qualcuno non la
aggiunge. Chi guarda una chat condivisa da ospite quindi non ha questa
ricerca; la sua barra cerca nel client, solo nel testo e nei ragionamenti.

Costo. Misurato il 02/10 su questo Mac con bun, su 8,2 MB sintetici in 118
righe compresse con `encodeCol` (zstd 3, rapporto 2,7, contro circa 5 del DB
vivo secondo la migration: 848 MB decompressi per 163 MB): decomprimere tutto
e cercare costa 17-24 ms. La lettura delle righe da SQLite non è misurata, perché
il DB vivo non si tocca. La barra chiede al server 250 ms dopo l'ultima lettera,
e annulla la richiesta precedente.

**Il messaggio in streaming** si cerca nel client, sul testo che il client
riceve dal vivo, con la stessa `chatFind`. I suoi risultati sostituiscono quelli
del server per lo stesso `messageId`. A fine turno la barra richiede al server.

**Scartato: un secondo download** (l'alternativa della scelta 2). La rotta degli
agenti `GET /api/topics/:id/messages` non toglie le uscite
(`topics.ts:2283-2307`): 5,42 MB per `topic:6b99e9cf`. Il client poi cerca da sé
(5-13 ms su 8,2 MB in chiaro, stessa misura). Costa 5,42 MB a ogni chat su cui
apri la barra, cioè i secondi di schermo vuoto che lo snellimento ha tolto su un
telefono in LAN (`history.ts:247-249`). **Scartato: `POST /api/search`**: guarda
solo `messages.content` (`server/utils.ts:2658-2664`) di tutte le chat insieme,
con `LIMIT` e senza posizioni. **Scartata la ricerca della webview** (o
`window.find` sull'app): vede solo le righe montate (`MessageList.tsx:2267`).
Con l'alternativa «solo testo e ragionamenti» la rotta non serve, e `chatFind`
gira nel client sui messaggi dello store più quelli `staged` di
`historyCompleteness`.

**Arrivare su un risultato.** Riusa il salto della palette:
`requestScrollToMessage` (`state/scrollToMessage.ts:26`) consumato da
`MessageList.tsx:1384-1460` (`scrollToIndex`, righe che raggruppano più
strumenti, storia mancante: il merge avviene qui, perché un salto è una
richiesta di chi legge, `:1421`). In più, per il risultato corrente:

- se è nei ragionamenti o in uno strumento, la sezione si apre. L'apertura è
  forzata su quella riga finché il risultato è corrente, poi la sezione resta
  come l'ha lasciata chi legge. Una riga di strumento aperta chiede il suo testo
  intero con la richiesta che c'è già (`ToolCallRow.tsx:274-283`), e
  l'evidenziazione aspetta quel testo;
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
markdown cambia il testo (una parola spezzata da `**`, un link) o l'uscita è
disegnata solo in parte, il risultato c'è nel conteggio e la riga si evidenzia
intera. È accettato perché capita di rado e si vede.

**Mentre l'agente scrive.** Il messaggio in streaming si ricerca a ogni
aggiornamento del suo testo, al più ogni 120 ms. I risultati nuovi si
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

**Windows: cosa si può promettere.** Con il cursore nella pagina, Ctrl+F
inoltrato e `SetHandled(true)` tengono chiusa la barra di WebView2, ma la pagina
riceve comunque il keydown (`chords_win.rs:17-24`). Quindi su Windows
BROWSER-FIND-02 promette solo «la barra di WebView2 non si apre», non «la
pagina non lo sa». Con il cursore nell'interfaccia dell'app (non in una pane
browser), WebView2 ha i tasti del browser accesi (`wry-0.55.1/src/lib.rs:1687`;
il repo non chiama `with_browser_accelerator_keys` e `tauri-runtime-wry` non li
spegne). Oggi Ctrl+F nel campo della chat apre la barra di WebView2 sopra
l'interfaccia, perché il gestore esce senza `preventDefault` (`:325`). Va
misurato sul PC se il nostro `preventDefault` su Ctrl+F basta a tenerla chiusa.
Se non basta, la correzione è `with_browser_accelerator_keys(false)` sulla sola
webview dell'app, a patto che Ctrl+R e lo zoom passino già dal nostro gestore
(`menu_chords.rs:41-45`).

**Browser condiviso** (scelta 5, `RemoteBrowserPanelStreaming`,
`RemoteBrowserPanel.tsx:753`). Non è solo il telefono: anche la pane sul Mac
passa a questa vista quando è fissata su «condivisa», o quando è in «auto» e un
altro dispositivo la guarda (`RemoteBrowserPanel.tsx:211-218,236`). Il modo di
default è `dom` (`hooks/useRemoteBrowser.ts:277-282`). La pagina è una copia del
DOM ricostruita da rrweb in un iframe dello stesso dominio, letta dal client
stesso (`DomCoBrowse.tsx:4-6,36-38`: «Il mirror è il DOM vero della pagina: la
risposta è già qui, senza chiedere niente al server»). Il server rimette `video`
solo quando non può fotografare la pagina.

- **Modo `dom`**: il cercatore è `domFind` (§6) su
  `iframe.contentDocument.body`. Le evidenziazioni vanno nel `CSS.highlights`
  del documento dell'iframe, che ha un registro suo, con lo stile
  `::highlight()` iniettato lì. Si ricalcolano quando rrweb applica mutazioni
  (`MutationObserver`, 120 ms). Portare il risultato in vista scorre la copia
  locale: rrweb rimette lo scroll della pagina condivisa al prossimo evento di
  scroll, e questo è da verificare a mano (task 7.3).
- **Modo `video`**: la barra si apre con il campo spento e la frase «Qui la
  pagina è un'immagine: la ricerca non c'è» / «This page is an image here: find
  isn't available».

Senza il cercatore (l'alternativa della scelta 5), oggi sul client web ⌘F col
cursore nel campo di cattura arriva alla ricerca del browser che ospita l'app.
Il gestore esce a `:325`, e `BrowserKeyboardCapture.tsx:165` lascia passare ⌘
e Ctrl. È dedotto dal codice, non misurato. In quel caso il ripiego di FIND-02
deve lasciare passare ⌘F in quella pane, invece di aprire la ricerca nei
progetti.

## 5. Terminale

`@xterm/addon-search` 0.16.0 (misurato con `npm view`: è la serie per xterm 6;
0,84 MB su disco non compresso, `dist.unpackedSize` 838.673). Caricato accanto a
`FitAddon` (`SingleTerminalPane.tsx:462-463`), con le decorazioni per il
risultato corrente e gli altri (servono le API proposte, già accese:
`allowProposedApi: true`, `:441`). `findNext` / `findPrevious` con
`{ caseSensitive, decorations }`; conteggio e indice da `onDidChangeResults`.
Cerca nelle righe che xterm tiene, cioè lo schermo più `scrollback: 5000`
(`:440`); ciò che è uscito da lì non c'è più, e la barra non lo promette.

**Il limite dei 1000.** `highlightLimit` vale 1000 per default, e oltre quella
soglia `resultIndex` vale -1 (`typings/addon-search.d.ts:83-101`, letto dal
tarball 0.16.0 il 02/10). Con 5000 righe una parola frequente lo supera. Lì il
contatore dice «oltre 1000» senza la posizione, e Invio continua a spostarsi. Il
limite non si alza: ogni risultato è una decorazione, e il costo di alzarlo non
è misurato.

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

**Differenze** (`Editor/DiffViewer.tsx`). È una `MergeView` di CodeMirror con
`collapseUnchanged` (`DiffViewer.tsx:2,114-125`), e CodeMirror disegna solo le
righe vicine allo schermo: un `TreeWalker` sul DOM non troverebbe le righe fuori
vista, e il conteggio cambierebbe mentre scorri. Quindi il motore è lo stesso
dell'editor, `SearchQuery` + `setSearchQuery` sui due `EditorView`
(`mergeView.a` e `mergeView.b`), con `search()` aggiunto alle estensioni comuni
(`:104`) senza pannello e senza tasti. L'ordine dei risultati: prima il lato
sinistro, poi il destro. Arrivando su un risultato in una parte piegata, la
parte si apre con l'effetto `uncollapseUnchanged` (`@codemirror/merge` 6.12.2,
`dist/index.d.ts:423`).

**Anteprima Markdown** (`Editor/MarkdownPreview.tsx`, nessuna ricerca né lista
virtuale): `client/src/lib/domFind.ts`, un cercatore generico sul DOM. Usa un
`TreeWalker` sui nodi di testo e `CSS.highlights` come in §3, e porta il
corrente in vista con `scrollIntoView({ block: 'center' })`. Lo stesso
cercatore serve al browser condiviso (§4) e a ogni pane futura fatta di solo
testo senza lista virtuale.

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

- `bun:test`: `shared/chat-find.ts` (parti, maiuscole, risultati in un messaggio in
  streaming che cresce, nessun risultato su una parola vuota); `findRegistry.ts`
  (apri senza cercatore → false, stato per pane); `findInPageModel.ts` con la
  stringa nuova; `domFind.ts` su un documento fatto a mano.
- Integrazione, `tests/integration/history-find.test.ts` su un DB sintetico: una
  parola che sta solo in `message_tool_outputs` si trova, con `toolCallId`; una
  sessione diversa non risponde; un ospite non entra.
- Rust: `chords.rs` e `mac_chord_dispatch_tests` in `lib.rs`: ⌘F e ⌘G
  inoltrati e ingoiati; `cargo test --lib` sul Mac.
- E2E `tests/e2e/find-in-pane.spec.ts` sul server isolato `:13334`, WebKit:
  - una chat con più di una pagina di storia seminata
    (`tests/e2e/helpers/seed-messages.ts`) e una parola solo nel primo
    messaggio: «1 di 1», la riga arriva in vista ed è evidenziata;
  - una parola solo nell'uscita di uno strumento chiuso: il contatore la conta,
    e arrivandoci la sezione si apre;
  - Esc nella barra con un turno finto in streaming non lo interrompe;
  - ⌘F col cursore nel campo della chat apre la barra della chat;
  - Ctrl+F sul Mac col cursore nel campo non apre niente;
  - terminale con `seq 1 300` e ricerca di `150`;
  - file in editor con conteggio e Sostituisci;
  - differenze con una parola in una parte piegata;
  - board: il cursore va nel filtro;
  - pane senza cercatore: si apre la ricerca nei progetti.

  In `search-shortcuts.spec.ts`, SRC-02 e SRC-04 vengono riscritti su ⇧⌘F, mentre
  SRC-03 e SRC-05 si rovesciano (§2).
- Il browser nativo non gira negli e2e (il finto Tauri parla con la produzione,
  memoria «e2e-tauri-fake-hits-prod»). Quindi ⌘F dentro una pagina vera si prova
  a mano nell'app costruita, con un video `.webm`, su Mac e sul PC Windows: le
  lettere vanno nella barra e non nella pagina, ed Esc rimette la tastiera nella
  pagina. Il browser condiviso in modo `dom` si prova anche lui a mano.

## 9. Implementazione (03/10): dove il codice si è scostato da qui sopra

Scritto dopo il sì («vai tutto», ogni scelta sulla prima opzione). Main si era
mosso dal 02/10 (impostazioni nelle loro case, correzioni di comandi e azioni,
il free-audit): nessuno di quei cambi tocca le superfici di questa change,
quindi niente da adattare lì. Gli scostamenti veri sono questi.

- **Quale pane è «a fuoco».** Il gestore globale conosce un `focusedPanelId`
  di primo livello, non la pane interna di un progetto. Il pane si risolve così
  (`resolveFindPane`): prima la pane in cui sta la tastiera
  (`[data-find-pane]` risalendo dal bersaglio, pubblicato da `PaneKeepAlive`
  insieme a `FindPaneContext`); poi, con il fuoco sul niente o nella pagina
  nativa (il keydown sintetico della shell ha `window` come bersaglio), la tab
  `data-focused`; infine il pannello di primo livello. Il keydown sintetico è
  anche ciò che segna `openedFromPage`.
- **Esc rimette il cursore** dove stava prima di ⌘F: il registro ricorda
  `document.activeElement` all'apertura. Nella pagina nativa si passa da
  `browser_focus_pane`.
- **Il terminale ha la barra che galleggia** in alto a destra invece che nel
  flusso: una riga nel flusso ridimensiona la griglia di xterm e il programma
  ridisegna (lo diceva già il commento in `SingleTerminalPane`). È l'unica
  pane dove FIND-01 «nel flusso» non vale; lì non c'è una webview nativa da
  non coprire.
- **Evidenziazione condivisa.** `CSS.highlights` è un registro per documento:
  due chat con la barra aperta si sarebbero sovrascritte `find-hit`. I
  cercatori passano da `lib/findHighlights.ts`, che unisce i range per
  documento.
- **Editor e differenze**: l'evidenziatore di `@codemirror/search` disegna solo
  a pannello aperto, quindi i risultati sono un campo di decorazioni nostro
  (`lib/cmFind.ts`, `.cm-find-hit` / `.cm-find-current`). `Mod-g`,
  `Shift-Mod-g` e F3 escono dal keymap insieme a `Mod-f`: con la barra chiusa
  aprivano il pannello di CodeMirror. Le parti piegate si riaprono ricalcolando
  le pieghe come le costruisce `@codemirror/merge` (non le esporta).
- **Ragionamenti.** Una corsa di messaggi di solo lavoro si disegna come un
  item con l'id del primo (`coalesceToolRun`), quindi una riga di ragionamento
  si apre se è della chat corrente e contiene la parola, non solo per id.
- **Ospite**: la rotta lo rifiuta (403) e il cercatore ripiega da sé sul testo
  e i ragionamenti del client, senza un rilevamento dell'ospite nel client.
- **Seed e2e**: `/api/test/seed-message` accetta `splitToolOutputs: true` per
  scrivere una riga con l'uscita già in `message_tool_outputs`, come la lascia
  il backfill.
- **La finestra delle Scorciatoie** legge le descrizioni del registro come
  stringhe, senza i18n (era così per tutte le righe): le quattro nuove sono in
  italiano come le altre righe italiane.
- **Il telefono non ha più la striscia delle tab** (dal commit «da mobile la
  barra delle tab in alto non serve»): al suo posto c'è il nome della
  superficie. «Cerca» quindi sta in fondo a quella riga (`mobile-pane-find`,
  icona lucide `Search`), solo per una pane con un cercatore; la voce «Cerca»
  nel menu della tab resta per desktop e tablet, dove la striscia c'è.
- **Il cursore su niente dopo un clic sul testo** (anteprima Markdown, una
  trascrizione): ⌘F va alla pane dell'ultimo clic, se è ancora a schermo,
  prima della tab `data-focused`. Non per il ⌘F inoltrato dalla shell da una
  pagina nativa (bersaglio `window`): un clic nella pagina non lascia un
  `pointerdown` nel DOM, quindi l'ultimo clic lì è vecchio e vale la tab a
  fuoco. Il tasto consumato chiama anche `stopPropagation`, altrimenti nel
  terminale arrivava al programma come ^F / ^G.
