# Windows: mappa delle scorciatoie

Il pannello «Keyboard Shortcuts» elenca 34 voci. Su Windows alcune funzionano,
altre no, e finora nessuno sapeva QUALI perche' non esisteva un inventario.
Questo documento e' l'inventario: una riga per ogni voce dichiarata in
`shared/shortcuts.ts`, con il punto in cui la scorciatoia e' gestita, cosa fa
oggi su Windows e, se non fa niente, a quale causa appartiene.

Non e' una prova sul ferro. La lettura e' fatta sul codice; le prove col tasto
premuto su una macchina Windows vera sono le card figlie.

## Le tre cause note

| Sigla | Causa | Dove | Stato |
| --- | --- | --- | --- |
| **C1** | **Etichetta.** Il registro scriveva il modificatore come glifo Mac (`⌘`, `⇧`, `⌥`), quindi la finestra stampava un tasto che sulla tastiera Windows non esiste. | `shared/shortcuts.ts`, `client/src/lib/shortcutLabel.ts` | Curata in `9467bd2a8` (token `MOD`/`SHIFT`/`ALT`/`CTRL` risolti a render time, piu' i flag `alias` e `macOnly`). Il commit vive su `topics/breezy-lodge`: **non e' ancora su `main`**. |
| **C2** | **Inoltro.** Col fuoco dentro una pane browser la webview figlia si mangia i tasti prima del renderer. Su macOS c'e' un monitor NSEvent locale che li reinoltra; su Windows non c'e' niente. | `desktop-tauri/src-tauri/src/lib.rs` (`app_chord_dispatch_js`, `#[cfg(target_os = "macos")]`) e `shortcuts_generated.rs` (anche lui `#[cfg(target_os = "macos")]`) | Aperta. Sottotask `98870ad9` (controparte `AcceleratorKeyPressed` di WebView2). |
| **C3** | **Acceleratori di menu.** tao costruisce la tabella `HACCEL` ma nessuno chiama `TranslateAcceleratorW`, quindi gli acceleratori dichiarati sulle voci di menu non scattano mai. | `desktop-tauri/src-tauri/src/lib.rs`, blocco `.menu(...)` | Aperta. Sottotask `ca224e88` (verificato su tao 0.35.3 / wry 0.55.1 / tauri-runtime-wry 2.11.3). |

C2 e C3 sono indipendenti: C2 riguarda **dove sta il fuoco**, C3 riguarda **da
quale porta arriva la scorciatoia**. Una riga puo' essere sana nel webview
principale e morta sopra una pane browser (solo C2), oppure morta ovunque
perche' l'unica porta che aveva era il menu (C3).

## Come si legge la colonna «cosa fa oggi su Windows»

Due contesti di fuoco, perche' danno esiti diversi:

- **webview principale**: il fuoco sta nella UI di Topics (sidebar, chat, board);
- **pane browser**: il fuoco sta dentro una webview figlia (una pane del browser
  incorporato).

Quasi tutti gli handler React confrontano `e.metaKey || e.ctrlKey`, quindi il
tasto Ctrl e' gia' accettato da sempre: il problema non e' mai stato il
binding, e' stato l'etichetta (C1) e la consegna dell'evento (C2, C3).

## La tabella

### General

| Chord (nome Windows) | Dove e' gestita | Cosa fa oggi su Windows | Causa |
| --- | --- | --- | --- |
| Ctrl+K | registro (`native: k`) + `useKeyboardShortcuts.ts:210` + inoltro nativo | Apre la palette nel webview principale. Sopra una pane browser: niente. | C1 (etichetta), C2 (solo sopra la pane) |
| Ctrl+F | registro (nessun `native`) + `useKeyboardShortcuts.ts:288` | Apre la ricerca nei progetti nel webview principale. Sopra una pane browser resta alla pagina, **per scelta dichiarata** (find-in-page). | C1 |
| Ctrl+P | registro (`native: p`) + `useKeyboardShortcuts.ts:271` | Apre un file per nome nel webview principale. Sopra una pane: niente. | C1, C2 |
| Ctrl+Shift+P | registro (`native: p`) + `useKeyboardShortcuts.ts:258` | Trova un progetto nel webview principale. Sopra una pane: niente. | C1, C2 |
| Ctrl+T | registro (`native: t`) + `useKeyboardShortcuts.ts:244` | Nuova chat nel webview principale. Sopra una pane: niente. | C1, C2 |
| Ctrl+N | registro (`native: n`) + `useKeyboardShortcuts.ts:223` | Apre il menu «New…» nel webview principale. Sopra una pane: niente. | C1, C2 |
| Ctrl+Shift+N | registro (`native: n`) + `useKeyboardShortcuts.ts:225` | Nuova chat con template nel webview principale. Sopra una pane: niente. | C1, C2 |
| Ctrl+B | registro (`native: b`) + `useKeyboardShortcuts.ts:295` | Commuta la sidebar nel webview principale. Sopra una pane: niente. | C1, C2 |
| Ctrl+Z | registro (nessun `native`) + `useKeyboardShortcuts.ts:195` | Annulla layout/tab, e cede a un campo di testo a fuoco. Funziona. | C1 |
| Ctrl+Shift+Z | registro (nessun `native`) + `useKeyboardShortcuts.ts:198` | Rifa'. Funziona. | C1 |
| Ctrl+, | registro (nessun `native`) + `useKeyboardShortcuts.ts:429` | Apre le impostazioni **solo se il fuoco NON e' in un campo di testo**: la guardia e' `e.metaKey \|\| !isTextInputFocused(...)`, e su Windows `metaKey` e' sempre falso. Scrivendo in chat il tasto e' muto. | **fuori dalle tre** (vedi sotto) |
| Ctrl+/ (e Ctrl+Shift+7 dove `?` lo richiede) | registro (`native: /`, `?`) + `useKeyboardShortcuts.ts:435` | Apre questo stesso pannello nel webview principale. Sopra una pane: niente. La tabella dei char inoltrati e' compilata solo su macOS. | C1, C2 |

### Panels & tabs

| Chord (nome Windows) | Dove e' gestita | Cosa fa oggi su Windows | Causa |
| --- | --- | --- | --- |
| Ctrl+1‥9 | registro (`native: 1..9`, `desktopOnly`) + `useKeyboardShortcuts.ts:393` | Cambia pannello nel webview principale. Sopra una pane: niente. | C1, C2 |
| Ctrl+W | registro (`native: w`, `desktopOnly`) + `useKeyboardShortcuts.ts:355` | Chiude il pannello a fuoco nel webview principale. Sopra una pane: niente. Il menu nativo NON dichiara `close_window`, quindi non c'e' un secondo padrone del tasto. | C1, C2 |
| Ctrl+Shift+T (alias Ctrl+Shift+U) | registro (`native: t,u` con `requireShift`) + `useKeyboardShortcuts.ts:314` | Riapre l'ultima tab chiusa nel webview principale. Sopra una pane: niente. | C1, C2 |
| Ctrl+Tab | registro (nessun `native`) + `useKeyboardShortcuts.ts:379` | Pannello successivo nel webview principale. Sopra una pane: niente. L'inoltro passa dal ramo scritto a mano su `key_code == 48`, che e' `#[cfg(target_os = "macos")]`. | C1, C2 |
| Ctrl+Shift+Tab (alias Ctrl+Shift+Tab) | come sopra | Pannello precedente nel webview principale. Sopra una pane: niente. Su Windows i due chord del Mac (`⌃⇧Tab` e `⌘⇧Tab`) collassano nello stesso: `9467bd2a8` nasconde l'alias quando coincide. | C1, C2 |

### Chat

| Chord (nome Windows) | Dove e' gestita | Cosa fa oggi su Windows | Causa |
| --- | --- | --- | --- |
| Enter | campo di `ChatInput.tsx` | Invia il messaggio. Funziona. | nessuna |
| Shift+Enter | campo di `ChatInput.tsx` | A capo. Funziona. | nessuna (con `9467bd2a8` la riga legge «Shift+Enter» invece di «⇧↵») |
| `/` | campo di `ChatInput.tsx` | Apre i comandi slash. Funziona. | nessuna |
| `@` | campo di `ChatInput.tsx` | Menziona un file di progetto. Funziona. | nessuna |
| Ctrl+U | registro (nessun `native`) + `ChatPane.tsx:1270` | Apre il selettore file nel webview principale. Sopra una pane: niente, **per scelta dichiarata** (solo `Ctrl+Shift+U` e' inoltrato, come alias di «riapri tab»). | C1 |
| Esc | registro + `useKeyboardShortcuts.ts:441` | Chiude il modale in cima, altrimenti interrompe il turno del pane a fuoco. Funziona nel webview principale. Sopra una pane: niente (il ramo su `key_code == 53` e' macOS). | C2 |

### Voice

Tutti e quattro sono ascoltati dentro `ChatInput.tsx` sul pane a fuoco, non
passano mai dal monitor nativo, e confrontano la lettera maiuscola (con Shift
premuto il layout latino la produce, Windows compreso).

| Chord (nome Windows) | Dove e' gestita | Cosa fa oggi su Windows | Causa |
| --- | --- | --- | --- |
| Ctrl+Shift+R | `ChatInput.tsx:646` | Registra una nota vocale. Funziona. | C1 |
| Ctrl+Shift+C | `ChatInput.tsx:651` | Avvia/chiude la chiamata vocale. Funziona. | C1 |
| Ctrl+Shift+D | `ChatInput.tsx:656` | Dettatura. Funziona. | C1 |
| Ctrl+Shift+S | `ChatInput.tsx:664` | Auto TTS. Funziona. | C1 |

### Board

| Chord (nome Windows) | Dove e' gestita | Cosa fa oggi su Windows | Causa |
| --- | --- | --- | --- |
| ⌘ destro, premuto e rilasciato da solo | registro + `useKeyboardShortcuts.ts:186` (`e.code === 'MetaRight'`) + monitor `flagsChanged` in `lib.rs` (macOS) | Niente: su Windows quel tasto non esiste, e il tasto Windows destro lo prende la shell di sistema. Oggi su `main` la riga compare lo stesso e promette un gesto impossibile. | C1 (`9467bd2a8` la marca `macOnly` e la nasconde fuori dal Mac) |

### Window

| Chord (nome Windows) | Dove e' gestita | Cosa fa oggi su Windows | Causa |
| --- | --- | --- | --- |
| Ctrl+R | registro (`desktopOnly`) + `useKeyboardShortcuts.ts:342` (ramo `isTauri`) **e** acceleratore di menu `CmdOrCtrl+R` | Ricarica tutte le finestre. **Funziona**: la porta buona e' l'handler React, non il menu. L'acceleratore di menu e' morto (C3) ma qui non serve a nessuno. | C1 |
| Ctrl+= | registro (`desktopOnly`) + **solo** acceleratore di menu `CmdOrCtrl+=` | **Niente.** Nessun handler React fa zoom dell'app (il ramo `'='` in `RemoteBrowserPanel.tsx:476` e' lo zoom della pagina dentro una pane browser, altra cosa). | **C3** |
| Ctrl+- | registro (`desktopOnly`) + **solo** acceleratore di menu `CmdOrCtrl+-` | **Niente**, per la stessa ragione. | **C3** |
| Ctrl+0 | registro (`desktopOnly`) + **solo** acceleratore di menu `CmdOrCtrl+0` | **Niente**, per la stessa ragione. | **C3** |
| Ctrl+Alt+T | registro (`desktopOnly`) + `tauri_plugin_global_shortcut`, registrato come `CommandOrControl+Alt+T` sotto `#[cfg(desktop)]` | Commuta «sempre in primo piano», **anche a finestra non a fuoco**. Funziona: e' l'unica scorciatoia gia' cross-platform per costruzione, e non passa ne' dal renderer ne' dal menu. | C1 |
| Ctrl+Q | registro (`desktopOnly`) + **solo** acceleratore di menu `CmdOrCtrl+Q` | **Niente.** | **C3** |

## Riepilogo

| Esito su Windows | Righe |
| --- | --- |
| Funzionano ovunque | 10: Enter, Shift+Enter, `/`, `@`, i quattro chord vocali, Ctrl+R, Ctrl+Alt+T |
| Funzionano solo se il fuoco NON e' in una pane browser | 18: Ctrl+K, Ctrl+F, Ctrl+P, Ctrl+Shift+P, Ctrl+T, Ctrl+N, Ctrl+Shift+N, Ctrl+B, Ctrl+Z, Ctrl+Shift+Z, Ctrl+/, Ctrl+1‥9, Ctrl+W, Ctrl+Shift+T, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+U, Esc |
| Morte ovunque | 4: Ctrl+=, Ctrl+-, Ctrl+0, Ctrl+Q (tutte C3) |
| Impossibili per costruzione | 1: il tap del ⌘ destro (nascosta da `9467bd2a8`) |
| Con un guasto proprio | 1: Ctrl+, (sotto) |

34 righe, ognuna una volta sola: 12 in General, 5 in Panels & tabs, 6 in Chat,
4 in Voice, 1 in Board, 6 in Window.

## La riga che non ricade in nessuna delle tre cause

**Ctrl+, (Impostazioni).** Non e' un'etichetta sbagliata, non e' un problema di
inoltro e non passa dal menu. L'handler ha una guardia scritta apposta:

```ts
if (isMod && !e.shiftKey && e.key === ',' && (e.metaKey || !isTextInputFocused(e.target)))
```

La ragione e' documentata nel commento accanto e ha senso sul Mac: `⌘,` e'
assoluto per convenzione di sistema e deve funzionare anche mentre si scrive,
mentre `Ctrl+,` dentro un terminale xterm o un editor CodeMirror e' un tasto
VERO, che l'handler in capture su `window` mangerebbe. Il costo pero' e' che su
Windows la scorciatoia e' muta esattamente dove si sta quasi sempre: dentro il
composer della chat. Da decidere: tenerla cosi', o restringere la resa ai soli
contesti che quel tasto lo usano davvero (terminale, editor) invece che a
qualunque campo di testo.

Card aperta a parte, senza padre, perche' e' una decisione di prodotto e non un
pezzo di questa mappa.

## Cosa NON dice questa mappa

Due cose sono lette dal codice e vanno confermate premendo i tasti su una
macchina Windows, ed e' il compito delle card figlie:

1. Se WebView2 si prende qualche chord prima del renderer anche nel webview
   PRINCIPALE (gli «browser accelerator keys» di Chromium: Ctrl+P stampa,
   Ctrl+F barra di ricerca, Ctrl+N nuova finestra). I nostri handler chiamano
   `preventDefault()`, quindi in teoria la scorciatoia del browser resta zitta,
   ma questa e' una previsione, non una misura.
2. Se qualche chord e' gia' preso dalla shell di Windows o dal layout di
   tastiera in uso (il `?` italiano si fa con Shift, e il registro inoltra sia
   `/` sia `?` proprio per quello).
