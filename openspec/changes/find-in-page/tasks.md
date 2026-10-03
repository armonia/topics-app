# Tasks: find-in-page

Prima del codice: `grep -qx 'status: approved' openspec/changes/find-in-page/.openspec.yaml`.
Se esce non-zero, ci si ferma qui.

## 1. Test rossi sul tree di oggi

- [ ] 1.1 `shared/chat-find.test.ts` (bun:test): testo, ragionamenti, argomenti e uscita di uno strumento da `detail` e da `result`, maiuscole, parola vuota, ordine dei risultati, messaggio in streaming che cresce (CHAT-FIND-01, CHAT-FIND-03).
- [ ] 1.2 `tests/integration/history-find.test.ts` su un DB sintetico: una parola che sta solo in `message_tool_outputs` si trova con il suo `toolCallId`; una parola di un'altra sessione non risponde; un ospite non entra; `total` esatto e `truncated` oltre 5.000 (CHAT-FIND-01).
- [ ] 1.3 `client/src/state/findRegistry.test.ts`: `openFind` su una pane senza cercatore → `false`; stato per pane che sopravvive al cambio di fuoco (FIND-01, FIND-02).
- [ ] 1.4 `client/src/components/Browser/findInPageModel.test.ts`: il contatore tradotto «3 di 12» / «3 of 12» (FIND-01). Le asserzioni di BROWSER-FIND-01 restano.
- [ ] 1.5 `client/src/lib/domFind.test.ts`: conteggio e ordine su un documento fatto a mano, ricalcolo dopo una mutazione (FILE-FIND-02, BROWSER-FIND-04).
- [ ] 1.6 Rust, `cargo test --lib` sul Mac: `mac_chord_dispatch_tests` (`lib.rs`) e `chords.rs` con ⌘F/Ctrl+F e ⌘G/Ctrl+G inoltrati e ingoiati. `page_chords_stay_with_the_page` (`chords.rs:172-180`) perde `'f'`: è il contratto che cambia (BROWSER-FIND-02), non un test indebolito; lo dice il messaggio del commit.
- [ ] 1.7 `tests/e2e/find-in-pane.spec.ts` su `:13334`, WebKit, messaggi seminati con `tests/e2e/helpers/seed-messages.ts`:
  - parola solo nel primo messaggio di una chat oltre `HISTORY_FIRST_PAGE`;
  - parola solo nell'uscita di uno strumento chiuso, seminata in modo che finisca in `message_tool_outputs`: conteggio, poi la sezione si apre;
  - ⌘F dal campo della chat, e Ctrl+F dal campo che non apre niente;
  - Esc nella barra con un turno finto in streaming;
  - due pane con barre indipendenti;
  - terminale `seq 1 300`;
  - editor con conteggio, Sostituisci tutti e ⌘Z;
  - anteprima `.md`;
  - differenze con una parola in una parte piegata;
  - board → filtro;
  - dashboard → ricerca nei progetti;
  - telefono 390x844 → «Cerca» nel menu della tab;
  - pane browser condivisa in modo `dom` con conteggio, e in modo `video` con il campo disattivo.
- [ ] 1.8 `tests/e2e/search-shortcuts.spec.ts`. Sono contratti che cambiano, da dire nel commit:
  - SRC-02 e SRC-04 passano da ⌘F a ⇧⌘F;
  - SRC-03 diventa «⌘F in un campo di testo apre la barra della pane, non la ricerca nei progetti; sul Mac Ctrl+F nel campo resta al campo»;
  - SRC-05 diventa «⇧⌘F apre la ricerca nel contenuto dei progetti», e il commento in cima (righe 10-27) racconta il perché del rovescio.

## 2. Barra e tasti (FIND-01…04)

- [ ] 2.1 `client/src/state/findRegistry.ts` e `Shared/FindBar.tsx`, estratta da `RemoteBrowserPanel.tsx:617-660`; contatore via i18n; `releaseNativeFocus()` prima del fuoco nel campo.
- [ ] 2.2 `shared/shortcuts.ts`: ⌘F «Cerca qui» con `native`, ⌘G / ⇧⌘G, ⇧⌘F; `bun run gen:shortcuts`; il commento di `lib.rs:8800-8803` riscritto.
- [ ] 2.3 `useKeyboardShortcuts.ts`: ⌘F con la condizione `e.metaKey || usesCtrl || !isTextInputFocused(e.target)`, ripiego board e progetti, ⇧⌘F, ⌘G/⇧⌘G, Esc nella barra prima del ramo che interrompe il turno.
- [ ] 2.4 `lib.rs`: comando di release `browser_focus_pane(id)` (Mac: `makeFirstResponder` sulla WKWebView della pane, come `focus_grab_browser_inner` a `:8092-8115`; Windows: `set_focus` sulla webview della pane), esposto in `lib/shell/tauri.ts`, chiamato da Esc quando la barra era stata aperta dalla pagina.
- [ ] 2.5 `Layout/PaneTabBar.tsx`: voce «Cerca» solo con un cercatore.
- [ ] 2.6 `i18n-it.ts`, `i18n-en.ts`: le chiavi nuove; nessuna stringa scritta a mano.

## 3. Chat (CHAT-FIND-01…03)

- [ ] 3.1 `shared/chat-find.ts` puro.
- [ ] 3.2 `server/routes/history.ts`: `POST /api/history-find`, lettura piena della sessione dopo `flushTurnBody`, 5.000 posizioni al più, fuori da `isGuestAllowedPath`.
- [ ] 3.3 Cercatore della chat: richiesta alla rotta 250 ms dopo l'ultima lettera con annullamento della precedente; messaggio in streaming cercato nel client ogni 120 ms al più, con i suoi risultati al posto di quelli della rotta; nuova richiesta a fine turno; per gli ospiti solo testo e ragionamenti del client.
- [ ] 3.4 Arrivo: `requestScrollToMessage` con centratura, apertura forzata della sezione (`DisclosureBody`, con la richiesta del dettaglio di `ToolCallRow`) e del corpo tagliato (`clampBody`) sulla riga del risultato corrente.
- [ ] 3.5 Evidenziazione con `CSS.highlights` (`find-hit`, `find-current`) ricalcolata al montaggio delle righe; ripiego sulla riga intera dove la parola non si ritrova a schermo.

## 4. Browser (BROWSER-FIND-02…04)

- [ ] 4.1 `RemoteBrowserPanel.tsx`: il ramo ⌘F esce dal listener di `TauriBrowserPanelInner`; cercatore registrato con il motore di `useTauriBrowser.ts`.
- [ ] 4.2 `RemoteBrowserPanelStreaming` e `DomCoBrowse.tsx`: cercatore `domFind` sul documento dell'iframe nel modo `dom`, con lo stile `::highlight()` iniettato lì e il ricalcolo sulle mutazioni; nel modo `video` la barra con il campo disattivo e la frase.
- [ ] 4.3 Sul PC Windows, app costruita in locale:
  - Ctrl+F nella pagina apre la nostra barra e non quella di WebView2, e le lettere vanno nella barra;
  - Esc rimette la tastiera nella pagina;
  - Ctrl+F nell'interfaccia non apre la barra di WebView2. Se questo fallisce: `with_browser_accelerator_keys(false)` sulla sola webview dell'app, poi verifica che Ctrl+R e lo zoom passino ancora (design §4).

## 5. Terminale (TERM-FIND-01)

- [ ] 5.1 `cd client && bun add @xterm/addon-search@^0.16.0`.
- [ ] 5.2 `SingleTerminalPane.tsx`: addon caricato con `FitAddon`, cercatore con decorazioni e `onDidChangeResults`, «oltre 1000» quando `resultIndex` è -1, fuoco al terminale alla chiusura.

## 6. File (FILE-FIND-01, -02)

- [ ] 6.1 `CodeEditor.tsx`: `Mod-f` fuori dal keymap, cercatore su `@codemirror/search`, Sostituisci solo fuori dalla sola lettura.
- [ ] 6.2 `DiffViewer.tsx`: `search()` nelle estensioni comuni, cercatore su `mergeView.a` e `mergeView.b`, `uncollapseUnchanged` all'arrivo.
- [ ] 6.3 `lib/domFind.ts` e `MarkdownPreview.tsx`: cercatore generico sul DOM.
- [ ] 6.4 `Board/FilterTokenField.tsx`: il fuoco al filtro chiamato dal gestore.

## 7. Verifica

- [ ] 7.1 I test del §1 verdi; `bunx tsc` di client e server; rails statiche; `cargo test --lib`.
- [ ] 7.2 Video `.webm` dell'E2E 1.7 (chat lunga, strumento chiuso, Esc durante lo streaming).
- [ ] 7.3 Video a mano nell'app Mac costruita:
  - ⌘F col cursore in un campo di una pagina vera di una pane browser: le lettere vanno nella barra, ed Esc rimette la tastiera nella pagina;
  - due pane browser aperte, una sola barra;
  - una pane condivisa in modo `dom`: dopo Invio il risultato resta in vista anche quando la pagina condivisa scorre.

  Stesso giro sul PC Windows (4.3).
