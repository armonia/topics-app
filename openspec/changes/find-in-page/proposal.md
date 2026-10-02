## Da decidere

Cerca con ⌘F dentro ogni pane: 5 scelte prima del codice.
1. ⌘F cerca dentro la pane su cui stai, ovunque sia il cursore (anche nel campo dove scrivi alla chat o dentro una pagina del browser), con una barra sola uguale dappertutto; la ricerca nei file dei progetti passa a ⇧⌘F e resta su ⌘F solo nelle pane dove non c'è niente da cercare. ⇧⌘F l'abbiamo ritirato il 06/08 perché era un doppione di ⌘P e la stessa lettera portava a due cose diverse (`search-shortcuts.spec.ts:13-18`); qui le due cose sono la stessa ricerca, qui o in tutti i progetti, come in VS Code. Perché: oggi ⌘F in una chat apre la ricerca nei file. Col cursore nel campo, sul Mac non fa niente e su Windows apre la barra di WebView2 sopra l'app (letto dal codice, non misurato sul PC). Dentro una pagina arriva alla pagina (`useKeyboardShortcuts.ts:324-328`, `lib.rs:8820-8848`), ed è quello che hai visto. Sul Mac Ctrl+F resta al terminale e al campo (sposta avanti di un carattere). Su Windows Ctrl+F nel terminale diventa la ricerca (o: ⌘F resta la ricerca nei progetti e la ricerca nella pane va su un altro tasto; oppure la ricerca nei progetti non ha più un tasto suo e si apre da ⌘P col suo interruttore Nome/Contenuto).
2. Nella chat si cerca in tutta la conversazione: anche nei messaggi non ancora caricati, nei ragionamenti, nei comandi lanciati dall'agente e nella loro uscita. Lo fa una rotta nuova sul server per quella chat, che legge anche le uscite tenute a parte (`message_tool_outputs`). Arrivando su un risultato chiuso, la sezione si apre. Perché: un errore o un nome di file spesso sta solo nell'uscita di un comando, e il client quel testo non ce l'ha. La storia lo toglie (`history.ts:136-143,266`, `lean-tool-call.ts:305,433-436,516`) e lo chiede riga per riga solo quando apri la sezione (`ToolCallRow.tsx:274-283`). Decomprimere e cercare 8,2 MB sintetici costa 17-24 ms su questo Mac; la lettura dal DB vero non è misurata (o: alla prima ⌘F il client scarica la chat intera con le uscite, 5,42 MB su quella chat, che su un telefono in LAN sono secondi, e poi cerca da sé in 5-13 ms; oppure solo testo e ragionamenti, senza server).
3. Nel browser la barra è la nostra anche su Windows, e quella di WebView2 non si apre più. Perché: stessi tasti e stesso aspetto su Mac e Windows, e il motore c'è già e gira su tutti e due (`useTauriBrowser.ts:1716-1751`, `lib.rs:7113-7135`). Il costo: su Windows la pagina riceve comunque il tasto, quindi Google Docs apre la sua ricerca insieme alla nostra (`chords_win.rs:17-24`) (o: su Windows resta la barra di WebView2, che conta i risultati da sé, e la nostra solo sul Mac).
4. Nei file la stessa barra guida la ricerca dell'editor, con in più «Sostituisci» quando il file si può modificare. Perché: oggi il pannello dell'editor ha un altro aspetto, non dice quanti risultati ci sono e si apre solo col cursore dentro l'editor (`CodeEditor.tsx:234,249`) (o: l'editor tiene il suo pannello com'è, e la barra comune vale solo fuori dall'editor).
5. Anche il browser condiviso ha la ricerca. È quello che vedi dal telefono o da un altro computer, ed è anche la pane sul Mac quando è fissata su «condivisa», o è in «auto» e un altro dispositivo la guarda (`RemoteBrowserPanel.tsx:211-218,236`). Si cerca nella copia della pagina che la pane già ricostruisce (`useRemoteBrowser.ts:277-282`, `DomCoBrowse.tsx:4-6,36-38`), con il cercatore delle anteprime (design §6). Solo quando la pagina arriva come immagine (il ripiego «video») la barra dice che lì non c'è. Perché: il testo è già nel client, senza server. E oggi sul client web ⌘F lì apre la ricerca del browser (`useKeyboardShortcuts.ts:325`, `BrowserKeyboardCapture.tsx:165`): una barra spenta sarebbe un passo indietro (o: per ora niente cercatore lì, e in quella pane ⌘F col cursore nella pagina resta al browser come oggi).

Compreso, senza scelta:
- Invio e ⌘G portano al risultato dopo, ⇧Invio e ⇧⌘G a quello prima.
- Esc col cursore nella barra la chiude e non ferma più l'agente (oggi un Esc senza finestre aperte interrompe il turno, `useKeyboardShortcuts.ts:531-560`). Il cursore torna dov'era, anche dentro la pagina del browser; per questo la shell ha un comando nuovo, perché oggi quello che lo fa esiste solo in debug (`lib.rs:8082`).
- Aprendo la barra dall'interno di una pagina, la tastiera passa all'app (`releaseNativeFocus`, `tauri.ts:50-56`). Senza, le lettere andrebbero alla pagina (misurato su Windows, `useBrowserChromeBridge.ts:107-118`).
- Il contatore dice «3 di 12» (oggi «3/12»), c'è il tasto maiuscole/minuscole e il risultato corrente ha un colore diverso dagli altri.
- Ogni pane ha la sua barra, che resta aperta con la sua parola finché non la chiudi. Si apre solo sulla pane a fuoco: oggi ⌘F apre la barra in ogni browser montato, perché quel tasto non guarda il fuoco (`RemoteBrowserPanel.tsx:549-575`).
- Sul Mac una pagina che usa ⌘F per una sua ricerca (Google Docs) non lo riceve più.
- Nel terminale si cerca anche nelle righe passate, fino alle 5000 che tiene (`SingleTerminalPane.tsx:440`). Oltre 1000 risultati il contatore dice «oltre 1000» senza la posizione (limite dell'addon).
- Nell'anteprima Markdown la barra cerca il testo che vedi. Nelle differenze cerca in tutti e due i lati, e le parti piegate si aprono quando ci arrivi.
- Nella board ⌘F porta il cursore nel filtro che c'è già.
- Mentre l'agente scrive il contatore cresce, e il risultato su cui sei non si sposta.
- Sul telefono la barra si apre da «Cerca» nel menu della tab.
- La finestra delle Scorciatoie dice ⌘F, ⌘G, ⇧⌘G e ⇧⌘F. Tutte le etichette sono in italiano e inglese.

Fuori:
- Cercare in tutte le chat insieme (resta ⌘K).
- Sostituire nella chat, nel browser e nel terminale.
- Espressioni regolari e «parola intera».
- I comandi che lanci tu dalla chat: sono dati a parte, non messaggi (`CommandRunBlock.tsx:13-19`), e di un comando finito si vedono le ultime 20 righe (`:26`).
- L'anteprima HTML e i PDF, che stanno in un riquadro chiuso che dall'esterno non si legge (`fileMedia.tsx:107-127`).
- Una voce Trova nel menu Modifica.
- Rimappare i tasti (change `remappable-shortcuts`).

Col sì:
- Una dipendenza nuova nel client, `@xterm/addon-search` 0.16, quella ufficiale per xterm 6 (0,84 MB su disco).
- Una rotta nuova sul server, solo per chi ha già accesso alla storia.
- Un comando nuovo nella shell, per ridare la tastiera alla pagina.
- Quattro test e2e di `tests/e2e/search-shortcuts.spec.ts` cambiano contratto: SRC-02 e SRC-04 passano a ⇧⌘F. SRC-03 (⌘F non tocca un campo di testo) si rovescia, e sul Mac resta vero solo per Ctrl+F. SRC-05 (⇧⌘F non apre niente) si rovescia: è la decisione del 06/08 che cambia.

ok / ok ma 2 no

| # | Dove cambiarla |
|---|----------------|
| 1 | `FIND-02`; design §2; SRC-02…05 |
| 2 | `CHAT-FIND-01`, `CHAT-FIND-02`; design §3 |
| 3 | `BROWSER-FIND-03`; design §4 |
| 4 | `FILE-FIND-01`; design §6 |
| 5 | `BROWSER-FIND-04`; design §4 |

---

# ⌘F cerca dentro la pane su cui stai

Richiesta di Attilio del 02/10 (testo in `.openspec.yaml`).

## Why

⌘F oggi non vuol dire «cerca qui dentro» da nessuna parte. È la ricerca nel contenuto
dei file dei progetti (`shared/shortcuts.ts:98`, gestore in
`client/src/hooks/useKeyboardShortcuts.ts:324-328`, in capture su window a
`:595`), e quello che fa cambia a seconda di dove sta il cursore. La tabella è letta dal codice, non
misurata nell'app viva:

| Dove sei | Cosa fa ⌘F oggi |
|---|---|
| Chat, cursore sulla conversazione | apre la ricerca nei file dei progetti; in più ogni pane browser montata apre la sua barra (`RemoteBrowserPanel.tsx:549-575`, nessun controllo sul fuoco) |
| Chat, cursore nel campo dove scrivi | Mac: niente, perché il gestore esce per i campi di testo (`useKeyboardShortcuts.ts:325`) e la webview dell'app non ha una ricerca sua. Windows: il gestore esce senza `preventDefault`, e Ctrl+F apre la barra di WebView2 sopra l'interfaccia (i tasti del browser sono accesi per default, `wry-0.55.1/src/lib.rs:1687`, e `tauri-runtime-wry` non li spegne) |
| Browser, cursore dentro la pagina | Mac: niente da parte nostra, perché la shell non inoltra ⌘F (`lib.rs:8820-8848`, la lista viene da `shortcuts_generated.rs`) e il tasto arriva alla pagina. Windows: si apre la barra di WebView2 nella pane |
| Browser, cursore sulla barra della pane | la barra di ricerca della pane e la ricerca nei file, tutte e due |
| Terminale | niente: il gestore esce per xterm (`client/src/contexts/UndoContext.tsx:61`), xterm intercetta solo ⌘C (`SingleTerminalPane.tsx:532-539`), `@xterm/addon-search` non è installato (`client/package.json:32-33`) |
| File nell'editor | il pannello di CodeMirror (`CodeEditor.tsx:234,249`), solo col cursore nell'editor, senza conteggio |
| Differenze, cursore dentro | niente: `.cm-editor` fa uscire il gestore (`UndoContext.tsx:64`) e la MergeView non ha tasti di ricerca (`DiffViewer.tsx:104-125`) |
| Anteprima Markdown, differenze col cursore fuori, board, dashboard, git, cron | la ricerca nei file; nessuna di queste ha una ricerca sua (la board ha un filtro, `Board/FilterTokenField.tsx`, che ⌘F non raggiunge) |
| Nessun progetto aperto | niente: `toggleFileSearch` non apre (`useKeyboardShortcuts.ts:206-207`) ma `preventDefault` è già partito |
| Browser condiviso, client web, cursore nella pagina | la ricerca del browser che ospita l'app: il gestore esce sul campo di cattura (`:325`) e la cattura lascia passare ⌘ e Ctrl (`BrowserKeyboardCapture.tsx:165`). Dedotto dal codice |

### Perché nella chat la ricerca della pagina non basterebbe

- La lista è virtuale: nel DOM ci sono solo le righe a schermo più 400 px sopra
  e sotto (`Chat/MessageList.tsx:2111,2267`).
- All'apertura arrivano gli ultimi 40 messaggi, al massimo 256 KB
  (`shared/history-paging.ts:43,59`).
- Un corpo oltre 20.000 caratteri è tagliato (`Chat/clampBody.ts:14`), e una
  sezione chiusa non è montata (`Chat/DisclosureBody.tsx`, commento in cima).

### Perché non basta nemmeno cercare nei dati del client

Il client l'uscita degli strumenti non la tiene in memoria, neanche dopo aver
caricato la storia intera. Ogni pagina di storia passa da
`leanMessagesForHistory` (`server/routes/history.ts:266`). Questa svuota
`detail.output`, `content` e `result` delle righe chiuse
(`shared/lean-tool-call.ts:305,433-436`), azzera `args` quando c'è un `detail`
tipizzato (`:516`) e manda ogni altra stringa oltre 512 caratteri solo come
anteprima (`:337`). Il server quelle uscite non le legge nemmeno:
`withToolOutputs: false` (`history.ts:136-143`), e dal 30/09 stanno in una
tabella a parte, `message_tool_outputs`
(`server/db/migrations/20260930200938-message-tool-outputs.sql`). Il testo
intero arriva solo una riga alla volta, quando la apri
(`GET /api/messages/:id/tool/:tcid/detail`, `history.ts:391-457`;
`ToolCallRow.tsx:274-283`).

Quello che c'è: `POST /api/search` (`server/routes/topics.ts:2346-2349`,
`server/utils.ts:2643`) cerca con `LIKE` solo in `messages.content` di tutte le
chat insieme, e dice quale messaggio, non dove; la palette ⌘K lo usa
(`Shared/CommandPalette.tsx:196-235`) e salta al messaggio con
`requestScrollToMessage` (`state/scrollToMessage.ts:26`), consumato da
`MessageList.tsx:1384-1460`. Quel salto chiede il resto della storia se manca ed
evidenzia la riga (`:2314`).

I numeri della chat più pesante misurata nel repo (`topic:6b99e9cf`, 118
messaggi): 8,20 MB prima dello snellimento, 5,42 MB quello che viaggia
(`history.ts:247-249`). Ha almeno 891 chiamate a strumenti: sono quelle che
portano sia `detail` sia `result` (`lean-tool-call.ts:13-15`), non il totale. I
tempi di 0,7-1,7 s per la storia intera valgono per storie da 200 KB a 2,6 MB
(`history-paging.ts:5-9`), non per quella.

Misurato il 02/10 su questo Mac, con bun su testo sintetico:
- 8,2 MB in chiaro in 118 messaggi: contare le occorrenze costa 4,5 ms per una
  parola assente e 13 ms per una con 132.250 risultati.
- Gli stessi 8,2 MB compressi riga per riga con `encodeCol` (zstd 3, rapporto
  2,7): decomprimere tutto e cercare costa 17-24 ms.
- La lettura da SQLite non è misurata: non si tocca il DB vivo.

## What changes

- **Una barra sola** (`FindBar`), quella che oggi ha il browser
  (`RemoteBrowserPanel.tsx:617-660`) estratta e condivisa, con il contatore di
  `findInPageModel.ts` (BROWSER-FIND-01, invariato) scritto «3 di 12».
  Aprendosi si prende la tastiera anche da una pane browser nativa
  (`releaseNativeFocus`).
- **Ogni pane registra il suo cercatore** in un registro per `paneId`: apri,
  cerca, avanti, indietro, chiudi, conteggio. ⌘F apre la barra della pane a
  fuoco; se quella pane non ha un cercatore, apre la ricerca nei progetti come
  oggi. La ricerca nei progetti prende anche ⇧⌘F.
- **I tasti arrivano anche da dentro una pagina**: ⌘F e ⌘G diventano accordi
  inoltrati dalla shell (riga `native` nel registro, tabella generata per Mac e
  Windows).
- **Chat**: una rotta del server cerca nella conversazione intera, uscite degli
  strumenti comprese. Il client aggiunge il messaggio in streaming, arriva sul
  risultato, apre ciò che è chiuso ed evidenzia la parola.
- **Browser nativo**: la ricerca della pagina che c'è già, solo sulla pane a fuoco.
- **Browser condiviso**: il cercatore sul DOM ricostruito nella pane (modo
  `dom`). Nel modo `video` la barra dice che lì non c'è.
- **Terminale**: `@xterm/addon-search`.
- **File**: la barra guida la ricerca di CodeMirror, con Sostituisci; le
  differenze usano lo stesso motore sui due lati; l'anteprima Markdown si cerca
  nel testo a schermo.
- **Board**: ⌘F porta nel filtro.
- **Esc** col cursore nella barra chiude la barra, non interrompe il turno e
  rimette il cursore dove stava, anche dentro una pagina.

## Non-goals

- Cambiare `POST /api/search` o la ricerca fra tutte le chat.
- Cambiare ⌘K, ⌘P, ⇧⌘P.
- Cercare nelle pane senza testo (dashboard, cron, profilo, stato del sistema).

## Impact

Client: nuovi `client/src/components/Shared/FindBar.tsx`,
`client/src/state/findRegistry.ts` e `client/src/lib/domFind.ts` (cercatore sul
DOM, per l'anteprima Markdown e il browser condiviso);
`hooks/useKeyboardShortcuts.ts` (⌘F, ⌘G, ⇧⌘G, ⇧⌘F, Esc);
`Browser/RemoteBrowserPanel.tsx` (barra estratta, ascolto solo con `hasFocus`);
`Browser/DomCoBrowse.tsx` (cercatore sul mirror); `Browser/findInPageModel.ts`
(contatore tradotto); `lib/shell/tauri.ts` (comando per ridare la tastiera
alla pagina); `Chat/MessageList.tsx`, `Chat/DisclosureBody.tsx`,
`Chat/clampBody.ts` (aprire il risultato);
`Terminal/SingleTerminalPane.tsx`; `Editor/CodeEditor.tsx`, `Editor/FilePane.tsx`,
`Editor/MarkdownPreview.tsx`, `Editor/DiffViewer.tsx`;
`Board/FilterTokenField.tsx`; `Layout/PaneTabBar.tsx` (voce Cerca);
`lib/i18n-it.ts`, `lib/i18n-en.ts`; `client/package.json`
(`@xterm/addon-search`).

Shared: `shared/shortcuts.ts` (⌘F, ⌘G con `native`; ⇧⌘F nuova riga) e il
generato `desktop-tauri/src-tauri/src/shortcuts_generated.rs`; nuovo
`shared/chat-find.ts` (puro, `bun:test`), la stessa ricerca per la rotta del
server e per il messaggio in streaming nel client.

Desktop: `lib.rs`, un comando di release `browser_focus_pane` che ridà la
tastiera alla webview di una pane (oggi esiste solo `focus_grab_browser`, ed è
solo in debug, `lib.rs:8082`), più quanto esce dalla misura su Windows
(design §4).

Server: una rotta nuova `POST /api/history-find` in `server/routes/history.ts`,
che cerca nei messaggi di una sessione comprese le uscite di
`message_tool_outputs`. Ha lo stesso cancello ospiti della storia
(`/api/history/` non è in `isGuestAllowedPath`, `history.ts:416`).

Test: `tests/e2e/search-shortcuts.spec.ts` (SRC-02 e SRC-04 passano a ⇧⌘F, e
SRC-03 e SRC-05 si rovesciano); nuovo `tests/e2e/find-in-pane.spec.ts`; nuovo
`tests/integration/history-find.test.ts`.

Specs: `commands` (FIND-01…04), `chat` (CHAT-FIND-01…03), `remote-browser`
(BROWSER-FIND-02…04), `terminal` (TERM-FIND-01), `files` (FILE-FIND-01, -02).
Lo scenario «File search opens with keyboard shortcut» di
`openspec/specs/files/spec.md:75-78` (Cmd+Shift+F) oggi è falso e col sì torna
vero; con l'alternativa della scelta 1 va riscritto.
