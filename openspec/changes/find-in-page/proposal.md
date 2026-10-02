## Da decidere

Cerca con ⌘F dentro ogni pane: 5 scelte prima del codice.
1. ⌘F cerca dentro la pane su cui stai, ovunque sia il cursore (anche nel campo dove scrivi alla chat o dentro una pagina del browser), con una barra sola uguale dappertutto; la ricerca nei file dei progetti, che oggi sta su ⌘F, passa a ⇧⌘F (libero) e resta su ⌘F solo nelle pane dove non c'è niente da cercare. Perché: oggi ⌘F in una chat apre la ricerca nei file, e col cursore nel campo o dentro una pagina non fa niente (`useKeyboardShortcuts.ts:324-328`, `lib.rs:8820-8848`), che è quello che hai visto (o: ⌘F resta la ricerca nei progetti e la ricerca nella pane va su un altro tasto).
2. Nella chat si cerca in tutta la conversazione, anche nei messaggi non ancora caricati e nel testo di comandi, risultati degli strumenti e ragionamenti, e quando arrivi su un risultato chiuso la sezione si apre. Perché: un errore o un nome di file che ricordi spesso sta solo nell'uscita di un comando (in una chat misurata, 118 messaggi con 891 chiamate a strumenti), e cercare in 8 MB di testo costa 5-13 ms su questo Mac (o: solo il testo dei messaggi tuoi e dell'agente, meno risultati e niente si apre da solo).
3. Nel browser la barra è la nostra anche su Windows, e quella di Windows non si apre più. Perché: stessi tasti e stesso aspetto su Mac e Windows, e il motore c'è già e gira su tutti e due (`useTauriBrowser.ts:1716-1751`, `lib.rs:7113-7135`) (o: su Windows resta la barra di Windows, che conta i risultati da sé, e la nostra solo sul Mac).
4. Nei file la stessa barra guida la ricerca dell'editor, con in più «Sostituisci» quando il file si può modificare. Perché: oggi il pannello dell'editor ha un altro aspetto, non dice quanti risultati ci sono e si apre solo col cursore dentro l'editor (`CodeEditor.tsx:234,249`) (o: l'editor tiene il suo pannello com'è, e la barra comune vale solo fuori dall'editor).
5. Il browser aperto dal telefono o da un altro computer per ora non ha la ricerca: ⌘F lì apre la barra, che lo dice. Perché: lì la pagina arriva come immagine dal server, e la strada per cercarci dentro (`server/routes/browser.ts:492`) non è provata (o: subito anche lì, con un'azione «cerca» nuova sul server).

Compreso, senza scelta: Invio e ⌘G vanno al risultato dopo, ⇧Invio e ⇧⌘G a quello prima, Esc col cursore nella barra la chiude e non ferma più l'agente (oggi un Esc senza finestre aperte interrompe il turno, `useKeyboardShortcuts.ts:531-560`); il contatore dice «3 di 12» (oggi «3/12»), c'è il tasto maiuscole/minuscole, e il risultato corrente ha un colore diverso dagli altri; ogni pane ha la sua barra, che resta aperta con la sua parola finché non la chiudi; si apre solo sulla pane a fuoco (oggi ⌘F apre la barra in ogni browser montato, perché quel tasto non guarda il fuoco, `RemoteBrowserPanel.tsx:549-575`); col cursore dentro una pagina ⌘F arriva lo stesso alla barra, quindi una pagina che ha una sua ricerca su ⌘F (Google Docs) non la riceve più; nel terminale si cerca anche nelle righe passate, fino alle 5000 che tiene (`SingleTerminalPane.tsx:440`); nell'anteprima Markdown e nelle differenze la barra cerca il testo che vedi; nella board ⌘F porta il cursore nel filtro che c'è già; mentre l'agente scrive il contatore cresce e il risultato su cui sei non si sposta; sul telefono la barra si apre da «Cerca» nel menu della tab; la finestra delle Scorciatoie dice ⌘F, ⌘G, ⇧⌘G e ⇧⌘F; tutte le etichette in italiano e inglese.
Fuori: cercare in tutte le chat insieme (resta ⌘K); sostituire nella chat, nel browser e nel terminale; espressioni regolari e «parola intera»; l'anteprima HTML e i PDF, che sono pagine chiuse in un riquadro che dall'esterno non si legge (`fileMedia.tsx:107-127`); una voce Trova nel menu Modifica; rimappare i tasti (change `remappable-shortcuts`).
Col sì: una dipendenza nuova nel client, `@xterm/addon-search` 0.16 (quella ufficiale per xterm 6, 0,84 MB su disco); i test e2e SRC-02, SRC-03 e SRC-04 (`tests/e2e/search-shortcuts.spec.ts`), che oggi dicono «⌘F è la ricerca nei progetti», passano a ⇧⌘F.
ok / ok ma 2 no

| # | Dove cambiarla |
|---|----------------|
| 1 | `FIND-01`, `FIND-02`; design §1, §2 |
| 2 | `CHAT-FIND-01`, `CHAT-FIND-02`; design §3 |
| 3 | `BROWSER-FIND-03`; design §4 |
| 4 | `FILE-FIND-01`; design §6 |
| 5 | `BROWSER-FIND-04`; design §4 |

---

# ⌘F cerca dentro la pane su cui stai

Richiesta di Attilio del 02/10 (testo in `.openspec.yaml`).

## Why

⌘F oggi non è «cerca qui dentro» da nessuna parte. È la ricerca nel contenuto
dei file dei progetti (`shared/shortcuts.ts:98`, gestore in
`client/src/hooks/useKeyboardShortcuts.ts:324-328`, in capture su window a
`:595`), e cambia a seconda di dove sta il cursore. Letto dal codice, non
misurato nell'app viva:

| Dove sei | Cosa fa ⌘F oggi |
|---|---|
| Chat, cursore sulla conversazione | apre la ricerca nei file dei progetti; in più ogni pane browser montata apre la sua barra (`RemoteBrowserPanel.tsx:549-575`, nessun controllo sul fuoco) |
| Chat, cursore nel campo dove scrivi | niente: il gestore esce per i campi di testo (`useKeyboardShortcuts.ts:325`) e la webview dell'app non ha una sua ricerca |
| Browser, cursore dentro la pagina (Mac) | niente da parte nostra: la shell non inoltra ⌘F (`lib.rs:8820-8848`, la lista viene da `shortcuts_generated.rs`), arriva alla pagina |
| Browser, cursore sulla barra della pane | la barra di ricerca della pane e la ricerca nei file, tutte e due |
| Terminale | niente: il gestore esce per xterm (`client/src/contexts/UndoContext.tsx:61`), xterm intercetta solo ⌘C (`SingleTerminalPane.tsx:532-539`), `@xterm/addon-search` non è installato (`client/package.json:32-33`) |
| File nell'editor | il pannello di CodeMirror (`CodeEditor.tsx:234,249`), solo col cursore nell'editor, senza conteggio |
| Anteprima Markdown, differenze, board, dashboard, git, cron | la ricerca nei file; nessuna di queste ha una ricerca sua (la board ha un filtro, `Board/FilterTokenField.tsx`, che ⌘F non raggiunge) |
| Nessun progetto aperto | niente: `toggleFileSearch` non apre (`useKeyboardShortcuts.ts:206-207`) ma `preventDefault` è già partito |

Su Windows, con il cursore in una pane browser, Ctrl+F arriva a WebView2 e
apre la sua barra (i tasti del browser restano accesi per default,
`wry-0.55.1/src/lib.rs:1687`; il repo non chiama mai
`with_browser_accelerator_keys`). Non misurato sul PC.

### Perché nella chat la ricerca della pagina non basterebbe

- La lista è virtuale: nel DOM ci sono solo le righe a schermo più 400 px sopra
  e sotto (`Chat/MessageList.tsx:2111,2267`).
- All'apertura arrivano gli ultimi 40 messaggi, al massimo 256 KB
  (`shared/history-paging.ts:43,59`); una storia intera pesa da 200 KB a 2,6 MB
  e arriva in 0,7-1,7 s (stesso file, misura del 05/09).
- Un corpo oltre 20.000 caratteri è tagliato (`Chat/clampBody.ts:14`), e una
  sezione chiusa non è montata (`Chat/DisclosureBody.tsx`, commento in cima).

Quello che c'è: `POST /api/search` (`server/routes/topics.ts:2346-2349`,
`server/utils.ts:2643`) cerca con `LIKE` solo in `messages.content` di tutte le
chat insieme, e dice quale messaggio, non dove; la palette ⌘K lo usa
(`Shared/CommandPalette.tsx:196-235`) e salta al messaggio con
`requestScrollToMessage` (`state/scrollToMessage.ts:26`), consumato da
`MessageList.tsx:1384-1460`, che chiede il resto della storia se manca ed
evidenzia la riga (`:2314`). Il client, una volta completata la storia, ha in
memoria `content`, `thinking`, `toolCalls` e `blocks` di ogni messaggio
(`client/src/types/index.ts:67-80`), e il testo degli strumenti non si perde nel
viaggio (`shared/lean-tool-call.ts:23-29`).

Misurato il 02/10 su questo Mac (bun, testo sintetico): contare le occorrenze in
8,2 MB divisi in 118 messaggi costa 4,5 ms per una parola assente e 13 ms per una
con 132.250 risultati. 8,20 MB per 118 messaggi è la chat più pesante misurata
nel repo (`shared/lean-tool-call.ts:12-16`). Una ricerca nel client, sui dati e
non sul DOM, non ha bisogno di un endpoint nuovo.

## What changes

- **Una barra sola** (`FindBar`), quella che oggi ha il browser
  (`RemoteBrowserPanel.tsx:617-660`) estratta e condivisa, con il contatore di
  `findInPageModel.ts` (BROWSER-FIND-01, invariato) scritto «3 di 12».
- **Ogni pane registra il suo cercatore** in un registro per `paneId`: apri,
  cerca, avanti, indietro, chiudi, conteggio. ⌘F apre la barra della pane a
  fuoco; se quella pane non ha un cercatore, apre la ricerca nei progetti come
  oggi. La ricerca nei progetti prende anche ⇧⌘F.
- **I tasti arrivano anche da dentro una pagina**: ⌘F e ⌘G diventano accordi
  inoltrati dalla shell (riga `native` nel registro, tabella generata per Mac e
  Windows).
- **Chat**: cerca nei dati della conversazione intera, arriva sul risultato,
  apre ciò che è chiuso, evidenzia la parola.
- **Browser**: la ricerca della pagina che c'è già, sulla pane a fuoco sola.
- **Terminale**: `@xterm/addon-search`.
- **File**: la barra guida la ricerca di CodeMirror, con Sostituisci;
  anteprima Markdown e differenze cercate nel testo a schermo.
- **Board**: ⌘F porta nel filtro.
- **Esc** col cursore nella barra chiude la barra e non interrompe il turno.

## Non-goals

- Una ricerca nuova sul server: la chat cerca nei dati che il client ha già o
  che già sa chiedere.
- Cambiare ⌘K, ⌘P, ⇧⌘P.
- Cercare nelle pane senza testo (dashboard, cron, profilo, stato del sistema).

## Impact

Client: nuovi `client/src/components/Shared/FindBar.tsx` e
`client/src/state/findRegistry.ts`; `hooks/useKeyboardShortcuts.ts` (⌘F, ⌘G,
⇧⌘G, ⇧⌘F, Esc); `Browser/RemoteBrowserPanel.tsx` (barra estratta, ascolto solo
con `hasFocus`); `Browser/findInPageModel.ts` (contatore tradotto);
`Chat/MessageList.tsx`, `Chat/DisclosureBody.tsx`, `Chat/clampBody.ts` (aprire
il risultato); nuovo `Chat/chatFind.ts` (puro, `bun:test`);
`Terminal/SingleTerminalPane.tsx`; `Editor/CodeEditor.tsx`, `Editor/FilePane.tsx`,
`Editor/MarkdownPreview.tsx`, `Editor/DiffViewer.tsx`;
`Board/FilterTokenField.tsx`; `Layout/PaneTabBar.tsx` (voce Cerca);
`lib/i18n-it.ts`, `lib/i18n-en.ts`; `client/package.json`
(`@xterm/addon-search`).

Shared: `shared/shortcuts.ts` (⌘F, ⌘G con `native`; ⇧⌘F nuova riga) e il
generato `desktop-tauri/src-tauri/src/shortcuts_generated.rs`.

Desktop: nessun codice a mano oltre al generato, salvo quanto esce dalla misura
su Windows (design §4).

Server: nessuno.

Test: `tests/e2e/search-shortcuts.spec.ts` (SRC-02…04 passano a ⇧⌘F), nuovo
`tests/e2e/find-in-pane.spec.ts`.

Specs: `commands` (FIND-01…04), `chat` (CHAT-FIND-01…03), `remote-browser`
(BROWSER-FIND-02…04), `terminal` (TERM-FIND-01), `files` (FILE-FIND-01, -02).
