# Tasks — add-menu-hardening

## 1. Gate `enableNewChat` — via

- [x] 1.1 Rimosso da `AppSettings` (`client/src/types/index.ts`) con commento-guardia
- [x] 1.2 Rimosso da `DEFAULT_SETTINGS` (`client/src/lib/settings.ts`)
- [x] 1.3 `loadSettings` filtra sulle chiavi note invece della spread cieca (un
      campo ritirato non torna più su al server a ogni salvataggio)
- [x] 1.4 Cinque ternari in `App.tsx` + l'`if` sul bus `topics:new-chat`
- [x] 1.5 `useKeyboardShortcuts`: ⌘⇧N non è più gated
- [x] 1.6 `GlobalSettings`: via il toggle e la scheda «Features» (conteneva solo lui)
- [x] 1.7 `CommandPalette`: via la prop e il gate sulla pill
- [x] 1.8 Spec E2E che seminavano il flag: commenti e `addInitScript` aggiornati
- [x] 1.9 `layout-edge-cases` H22 pinnava il ramo «silent solo», ora irraggiungibile:
      riscritto sul comportamento vero (la chat di compagnia nasce)

## 2. Registro popover

- [x] 2.1 `lib/popoverRegistry.ts` — regola pura `popoversToClose` + registro
- [x] 2.2 `useDismissable` registra all'apertura, con opt-out `exclusive: false`
- [x] 2.3 `useModalDialog` chiama `closeAllPopovers()` all'apertura
- [x] 2.4 Unit test della regola (fratello / genitore / senza trigger / opt-out)

## 3. Stacking

- [x] 3.1 `Z_MODAL = 10000` in `popoverStyles` + `MODAL_LAYER` in `modalStyles`
- [x] 3.2 Palette ⌘N, ⌘K e pannello scorciatoie tolti da `z-[60]`
- [x] 3.3 `MODAL_OVERLAY` da `z-50` al piano dei modali
- [x] 3.4 Corretto il commento che affermava il contrario del vero

## 4. Primitiva

- [x] 4.1 `Menu`: prop `testId`, `ariaLabel`, `exclusive`
- [x] 4.2 Tastiera estratta in `hooks/useMenuKeyboard` (frecce + mnemonic)
- [x] 4.3 `PaneAddMenu` usa `Menu` per dropdown e foglio mobile (−120 righe)
- [x] 4.4 Palette: `role="menu"`, `tabIndex`, fuoco all'apertura, stessa tastiera
- [x] 4.5 Trigger: `aria-haspopup`, `aria-expanded`, `aria-label`
- [x] 4.6 Righe: `role="menuitem"`; il checkbox yolo non è più un `<input>`
      dentro un `<button>` (HTML non valido, rompeva il nome accessibile)
- [x] 4.7 `POPOVER_ITEM_TOUCH` in `popoverStyles`: la copia locale divergeva
      (py-3 vs py-2 su mobile) senza dichiararlo
- [x] 4.8 Docblock riscritto — elencava voci che il componente non rendeva più

## 5. Una lista sola

- [x] 5.1 `components/Shared/addMenuItems.tsx` — modello condiviso
- [x] 5.2 Agenti terminale da `TERMINAL_AGENT_TYPES` (`Record` esaustivo: aggiungerne
      uno senza dargli un volto non compila)
- [x] 5.3 Pill di ⌘K derivate dallo stesso modello; `onNewClaude/onNewCodex/
      onNewTerminal` sostituite da `onAddPane`
- [x] 5.4 `handleStandaloneAddPane` in `App.tsx`: una callback per due superfici
- [x] 5.5 Via anche il SOTTOINSIEME scritto a mano (`COMMAND_PALETTE_PILL_IDS`):
      ⌘K rende l'intera lista standalone, non una selezione. Finché restava,
      la deriva poteva ripartire — un tipo nuovo sarebbe comparso nel menu e
      non in ⌘K, esattamente com'era già successo
- [x] 5.6 `onNewProject` + `onCreateProject` di `CommandPalette` → UNA prop
      `onProjectPicker` (due nomi che App cablava alla stessa funzione)
- [x] 5.7 Lo scoping della voce Progetto (solo standalone, solo desktop) si
      sposta nel MODELLO: era dell'ospite, e infatti ⌘K la offriva anche sul web
      dove `selectDirectory` ritorna null — un no-op silenzioso. **Trovato dal
      gate ADD-09, non a mano**
- [x] 5.8 Le voci di creazione in ⌘K diventano RIGHE cercabili (sezione «Crea»),
      non pill in fondo: da una pill la tastiera non ci arrivava — in ⌘K il fuoco
      è nel campo di ricerca, quindi la lettera nuda del menu «+» lì scriverebbe
      solo una lettera. Come righe ereditano ↑↓ e ↵, che il footer già annuncia,
      e si cercano («brow» → Browser). La barra in fondo torna a UNA riga: teneva
      otto pill e andava a capo su tre

## 6. Mnemonic

- [x] 6.1 `state/pane/adapters/paneMnemonics.ts` — registro congelato + regola di
      assegnazione + insiemi per scope
- [x] 6.2 Chip `.kbd` a destra, `aria-hidden` (il nome accessibile resta il label)
      + `aria-keyshortcuts` per gli screen reader
- [x] 6.3 Attivazione col tasto nudo in `useMenuKeyboard`
- [x] 6.4 Unit test: unicità per scope, lettera ∈ etichetta, una lettera sola
- [x] 6.5 La riga New Chat mostrava «⌘N» invece della sua lettera: incoerente con
      ogni altra riga e per giunta FALSO — a palette aperta ⌘N la chiude (toggle).
      L'hint ⌘N resta sul solo trigger. Via anche la prop `showGlobalNewChatKbd`.
- [x] 6.6 Via l'intestazione della palette («NEW» + chip ESC): 38px di cromatura
      più alti di una riga, con un 10px accostato a un **16px** in due grigi
      diversi. Il 16 non era una svista di classe: il pannello è portato su
      `document.body`, FUORI dal wrapper dove App scrive `fontSize`, quindi ogni
      testo senza classe di dimensione ricade sul default del browser. Base
      esplicita sul pannello + gate ADD-08 che misura la classe di bug.

## 7. Verifica

- [x] 7.1 `tests/e2e/add-menu.spec.ts` — 9 test, il menu come sistema: 9/9 verdi
      (ADD-09 confronta gli ID offerti da ⌘K e dal menu «+» — divergere è rosso —
      e misura che la barra dei comandi stia su UNA riga: «brutto» è
      un'impressione, due offsetTop diversi sono un numero)
      (incluso ADD-07: la geometria del chip MISURATA sul DOM — uno per riga, a
      destra dell'etichetta, ≤14px dal bordo, nessuno sfora il pannello)
- [x] 7.2 Regressione: browser-add-empty, command-palette, panels, project-tabs,
      grid-split, layout-navigation — 63/63 verdi
- [x] 7.3 Regressione: topic-management, terminal-tab-reload, sidebar,
      spaces-switcher, file-context-menu — 44/44 verdi
- [x] 7.4 Regressione popover/modali: picker-keyboard-nav, escape-modal-guard,
      context-settings, effort-single-surface, pane-undo, drop-zones-v2 — 21/21
- [x] 7.5 `terminal-tab-reload` cercava la riga con `getByRole("button")`: con
      `role="menuitem"` non la trova più → passata al testid, che è il contratto
- [x] 7.6 Unit: 17 test nuovi verdi (registro, mnemonic, matcher)
