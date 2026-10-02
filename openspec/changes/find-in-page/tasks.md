# Tasks: find-in-page

Prima del codice: `grep -qx 'status: approved' openspec/changes/find-in-page/.openspec.yaml`.
Se esce non-zero, ci si ferma qui.

## 1. Test rossi sul tree di oggi

- [ ] 1.1 `client/src/components/Chat/chatFind.test.ts` (bun:test): testo, ragionamenti, uscita di uno strumento da `detail` e da `result`, maiuscole, parola vuota, ordine dei risultati, messaggio in streaming che cresce (CHAT-FIND-01, CHAT-FIND-03).
- [ ] 1.2 `client/src/state/findRegistry.test.ts`: `openFind` su una pane senza cercatore → `false`; stato per pane che sopravvive al cambio di fuoco (FIND-01, FIND-02).
- [ ] 1.3 `client/src/components/Browser/findInPageModel.test.ts`: il contatore tradotto «3 di 12» / «3 of 12» (FIND-01). Le asserzioni di BROWSER-FIND-01 restano.
- [ ] 1.4 Rust, `cargo test --lib` sul Mac: `mac_chord_dispatch_tests` (`lib.rs`) e `chords.rs` con ⌘F/Ctrl+F e ⌘G/Ctrl+G inoltrati e ingoiati. `page_chords_stay_with_the_page` (`chords.rs:172-180`) perde `'f'`: è il contratto che cambia (BROWSER-FIND-02), non un test indebolito; lo dice il messaggio del commit.
- [ ] 1.5 `tests/e2e/find-in-pane.spec.ts` su `:13334`, WebKit, messaggi seminati con `tests/e2e/helpers/seed-messages.ts`: parola solo nel primo messaggio di una chat oltre `HISTORY_FIRST_PAGE`; parola nell'uscita di uno strumento chiuso; ⌘F dal campo della chat; Esc nella barra con un turno finto in streaming; due pane con barre indipendenti; terminale `seq 1 300`; editor con conteggio e Sostituisci tutti + ⌘Z; anteprima `.md`; board → filtro; dashboard → ricerca nei progetti; telefono 390x844 → «Cerca» nel menu della tab; pane browser condivisa → barra con campo disattivo.
- [ ] 1.6 `tests/e2e/search-shortcuts.spec.ts`: SRC-02…04 passano da ⌘F a ⇧⌘F.

## 2. Barra e tasti (FIND-01…04)

- [ ] 2.1 `client/src/state/findRegistry.ts` e `Shared/FindBar.tsx`, estratta da `RemoteBrowserPanel.tsx:617-660`; contatore via i18n.
- [ ] 2.2 `shared/shortcuts.ts`: ⌘F «Cerca qui» con `native`, ⌘G / ⇧⌘G, ⇧⌘F; `bun run gen:shortcuts`; il commento di `lib.rs:8800-8803` riscritto.
- [ ] 2.3 `useKeyboardShortcuts.ts`: ⌘F senza la guardia dei campi di testo, ripiego board e progetti, ⇧⌘F, ⌘G/⇧⌘G, Esc nella barra prima del ramo che interrompe il turno.
- [ ] 2.4 `Layout/PaneTabBar.tsx`: voce «Cerca» solo con un cercatore.
- [ ] 2.5 `i18n-it.ts`, `i18n-en.ts`: le chiavi nuove; nessuna stringa scritta a mano.

## 3. Chat (CHAT-FIND-01…03)

- [ ] 3.1 `Chat/chatFind.ts` puro.
- [ ] 3.2 Cercatore della chat: store + `staged`, `requestHistoryCompletion(…, 'stage')`, ricerca a 120 ms dall'ultima lettera e dall'ultimo aggiornamento dello streaming.
- [ ] 3.3 Arrivo: `requestScrollToMessage` con centratura, apertura forzata della sezione (`DisclosureBody`) e del corpo tagliato (`clampBody`) sulla riga del risultato corrente.
- [ ] 3.4 Evidenziazione con `CSS.highlights` (`find-hit`, `find-current`) ricalcolata al montaggio delle righe; ripiego sulla riga intera dove la parola non si ritrova a schermo.

## 4. Browser (BROWSER-FIND-02…04)

- [ ] 4.1 `RemoteBrowserPanel.tsx`: il ramo ⌘F esce dal listener di `TauriBrowserPanelInner`; cercatore registrato con il motore di `useTauriBrowser.ts`.
- [ ] 4.2 `RemoteBrowserPanelStreaming`: cercatore che apre la barra con il campo disattivo e la frase.
- [ ] 4.3 Sul PC Windows, app costruita in locale: Ctrl+F nella pagina → la nostra barra e non quella di WebView2; Ctrl+F nell'interfaccia → nessuna barra di WebView2. Se la seconda fallisce, `with_browser_accelerator_keys(false)` sulla sola webview dell'app e verifica che Ctrl+R e lo zoom passino ancora (design §4).

## 5. Terminale (TERM-FIND-01)

- [ ] 5.1 `cd client && bun add @xterm/addon-search@^0.16.0`.
- [ ] 5.2 `SingleTerminalPane.tsx`: addon caricato con `FitAddon`, cercatore con decorazioni e `onDidChangeResults`, fuoco al terminale alla chiusura.

## 6. File (FILE-FIND-01, -02)

- [ ] 6.1 `CodeEditor.tsx`: `Mod-f` fuori dal keymap, cercatore su `@codemirror/search`, Sostituisci solo fuori dalla sola lettura.
- [ ] 6.2 `MarkdownPreview.tsx`, `DiffViewer.tsx`: cercatore generico sul DOM.
- [ ] 6.3 `Board/FilterTokenField.tsx`: il fuoco al filtro chiamato dal gestore.

## 7. Verifica

- [ ] 7.1 I test del §1 verdi; `bunx tsc` di client e server; rails statiche; `cargo test --lib`.
- [ ] 7.2 Video `.webm` dell'E2E 1.5 (chat lunga, strumento chiuso, Esc durante lo streaming).
- [ ] 7.3 Video a mano nell'app Mac costruita: ⌘F col cursore dentro una pagina vera di una pane browser, due pane browser aperte, una sola barra. Stesso giro sul PC Windows (4.3).
