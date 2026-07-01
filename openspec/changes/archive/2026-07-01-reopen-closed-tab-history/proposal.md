## Why

La cronologia delle tab chiuse esiste già come substrato solido (`closedStack` nel
pane reducer: FIFO bounded a 50, fedeltà completa — groupIndex, focus, split,
terminal meta, seq —, persistito su `localStorage` + server `pane-store-v2`,
union-merge multi-client con tombstone). Ma:

1. **Manca il chord standard ⇧⌘T.** L'unico binding per riaprire l'ultima tab
   chiusa è ⌘⇧U. ⇧⌘T è la muscle-memory universale (browser, VS Code, JetBrains,
   iTerm, Warp). Il codice lo evitava con la motivazione "lo possiede il browser"
   (`useKeyboardShortcuts.ts`, `ChatInput.tsx`) — vero solo in dev-browser, **non**
   nel prodotto Electron, dove il chord è libero (VS Code, anch'esso Electron, lo
   usa per `reopenLastClosedEditor`).
2. **Riferimento Warp.** Warp tiene due assi separati: reopen = stack undo
   in-memory (`[general.undo_close]`, grace 60s, ⇧⌘T) "istantaneo" perché legge la
   RAM; restore-on-launch = SQLite snapshot-on-quit. topics-app mappa già su questo
   modello (`closedStack` = asse undo; hydrate da `pane-store-v2` = asse restore).
   La lezione è "tieni i due assi separati e fai il reopen dalla RAM" — già così.
3. **Cruft da ripulire.** Il tipo `ClosedTabRecord` è dichiarato due volte
   (identico) in `adapters/closedTabRecord.ts` e `adapters/hooks/useClosedTabs.ts`;
   commenti stale ("the browser owns Cmd+Shift+T"); copertura test sottile sul
   substrato (reopen adapter, PANE_ID_REMAP su closedStack, FIFO, UNDO_CLOSE).

## What Changes

### Reopen chord
- Bindare **⇧⌘T** a "riapri l'ultima tab chiusa" nel renderer
  (`useKeyboardShortcuts.ts`), affiancando ⌘⇧U come alias retro-compatibile.
  `preventDefault` su entrambi. Il reopen risolve dallo stack in RAM
  (`closedTabs[0]`) → istantaneo per le chat; i terminali ricreano la sessione
  (idempotente) com'è già oggi.
- **Electron**: aggiungere la voce menu "Reopen Closed Tab" (accelerator
  `CmdOrCtrl+Shift+T`) in `View`, che fa `webContents.send('reopen-closed-tab')`;
  esporre `onReopenClosedTab` nel preload; il renderer (App) si sottoscrive e
  invoca lo stesso `handleReopenClosedTab(closedTabs[0])`. Garantisce il chord
  anche quando il focus è su un pane nativo (WebContentsView/terminale) dove il
  keydown del renderer non arriverebbe.

### ⌘K = stesso substrato
- ⌘K ("Chiuse di recente") e i chord condividono **un unico** entry point
  `handleReopenClosedTab` (già vero oggi: App.tsx lo passa sia a
  `useKeyboardShortcuts` sia a `CommandPalette`). Formalizzato come requisito.
- Aggiornare l'hint della prima riga "Chiuse di recente" e il modale shortcut da
  ⌘⇧U → ⇧⌘T (primario).

### Pulizia / solidità
- DRY: una sola definizione canonica di `ClosedTabRecord` (in `closedTabRecord.ts`);
  `useClosedTabs.ts` la importa invece di ridichiararla.
- Correggere i commenti stale su ⇧⌘T.
- Test `bun:test` (moduli puri) sul substrato: FIFO bound, UNDO_CLOSE restore a
  groupIndex+focus, PANE_ID_REMAP riscrive `closedStack` + `tabOrderSnapshot`,
  `reopenClosedTab` (path non-terminale verbatim). E2E Playwright: chiusura →
  ⇧⌘T riapre; ⌘K "Chiuse di recente" riapre.

## Capabilities

### Modified Capabilities
- `commands`: aggiungere il requisito "Reopen closed tab" (⇧⌘T + alias ⌘⇧U),
  l'unicità dell'entry point di reopen, e l'allineamento dell'hint nella palette.

## Impact

- Client: `client/src/hooks/useKeyboardShortcuts.ts`,
  `client/src/components/Shared/CommandPalette.tsx`,
  `client/src/components/Shared/KeyboardShortcuts.tsx`, `client/src/App.tsx`,
  `client/src/state/pane/adapters/hooks/useClosedTabs.ts`,
  `client/src/components/Chat/ChatInput.tsx` (commento).
- Electron: `electron-app/main.ts` (menu), `electron-app/preload.ts` (IPC bridge)
  — richiedono restart Electron per attivarsi (nessun hot-reload sul main).
- Tests: `client/src/state/pane/adapters/closedTabRecord.test.ts` (esteso),
  nuovo `client/src/state/pane/reducers/closedStack.test.ts`, nuovo
  `tests/e2e/reopen-closed-tab.spec.ts`.
- Nessuna modifica al server, allo schema DB, o al protocollo di sync.

## Reopen "swap" bug — found and fixed

Durante l'E2E è emerso che riaprire una tab **chat** chiudeva la tab
precedentemente aperta (uno *swap*, non un restore). NON era il sync/LWW (ipotesi
scartata sperimentalmente: disabilitare la purge server-side Shape B non
cambiava nulla). Root cause reale (PRE-ESISTENTE, colpiva già ⌘⇧U e ⌘K):

`client/src/components/Layout/hooks/usePaneOrdering.ts` implementa il protocollo
**preview-replace** stile VS Code: una tab non-pinnata è "preview"; quando se ne
aggiunge UNA sola (`wasAdded && added.length === 1`), la nuova rimpiazza la
preview corrente (`findPreviewInList` → `replaceInList` → `onClosePanel(preview)`).
Il reopen aggiunge una sola tab → veniva interpretato come navigazione-preview →
chiudeva la tab corrente. Diagnosi confermata via stack-trace
(`commitHookEffectListMount` → `handleClosePanelDeferred(preview)`).

Fix (additivo, basso rischio): un marker one-shot `markTabRestored(id)` in
`lib/previewTabs.ts`, settato dal path di reopen (`usePanelLifecycle
.handleReopenClosedTab`) prima di `setOpenPanels`, e consumato da
`usePaneOrdering` (`consumeTabRestored`) per **saltare il preview-replace** solo
per l'add di restore. Le navigazioni normali (preview-replace) restano invariate.

Verificato col flusso UI reale (apertura via ⌘K → `openPanel`): dopo il reopen lo
store è `[t1,t2]`, `closedStack=[]`, 2 tab stabili. I due E2E chat-reopen sono
attivi e verdi (regression guard).
