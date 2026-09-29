# Tasks: tab-one-slot

## 1. Precedenza, pura
- [x] 1.1 `client/src/lib/tabSlot.ts`: `tabSlotSignal` (pausa > lavoro > attenzione > niente) e `tabSlotCommand` (Ferma se c'e' un turno fermabile e non e' un progetto, altrimenti Chiudi)
- [x] 1.2 `client/src/lib/tabSlot.test.ts` (bun:test, 8 pass)

## 2. Le tre zone (TABSLOT-01)
- [x] 2.1 Nome `flex-1 min-w-[56px]` in `TabLabel`; niente in fila fra nome e slot
- [x] 2.2 Icona a larghezza fissa anche per il progetto senza favicon (icona di tipo progetto)

## 3. Lo slot (TABSLOT-02, CHROME-12)
- [x] 3.1 `TabSlot` per tipo (chat, progetto, terminale, browser, board) in `components/Layout/TabSlot.tsx`
- [x] 3.2 Anello da 20 attorno al numero quando lavoro e attenzione coincidono (`OrbitLoader size`)
- [x] 3.3 Fiocco solo glifo (`SwapFreezeLabel variant="glyph"`), parola e frase nel tooltip
- [x] 3.4 Comando nello stesso posto: Ferma, poi Chiudi; mai affiancati; progetto mai Ferma
- [x] 3.5 Col dito il comando sulla tab selezionata; conto alla rovescia sempre acceso (`index.css`)
- [x] 3.6 Board: review = numero, in corso = anello, conteggi nel title (`useBoardTabCounts`)

## 4. I segnali di contorno (TABSLOT-03, CHROME-14)
- [x] 4.1 Spillo, globo, cloud nel nome accessibile; tempo nel tooltip del nome
- [x] 4.2 Segno d'angolo: organizzazione > marcatore di progetto; errori console sul favicon del browser
- [x] 4.3 Download sui tre puntini, che li aprono; puntini in `.tab-extras` sopra la coda del nome
- [x] 4.4 Tolti `PaneTabCommands`, `StopTurnButton`, `BrowserTabDownloadsCue`, `SessionElapsed`
- [x] 4.5 Tipo del browser sull'angolo della favicon (`BrowserTabCornerMark`, precedenza in `browserCornerMark`), non piu' in fila
- [x] 4.6 Numeri dello slot dentro i 20 px (`NotificationBadge compact`, «99+» al passo nano senza padding, dentro anche in DejaVu Sans); numero esatto nel nome accessibile

## 5. Prove
- [x] 5.1 `tests/e2e/tab-one-slot.spec.ts` (a, b, c, d) verde su WebKit con video
- [x] 5.2 Aggiornate al contratto: `tab-stop-before-close`, `tab-widget-geometry`, `board` (BOARD-15/16), `browser-ws-streaming` (download), `tab-focus-hierarchy` (CHROME-14), `swapFreezeSurfaces.test.tsx`
- [x] 5.3 Rilanciate verdi su WebKit: `tab-notifications`, `project-tab-shared-org`, `project-folder-loader`
- [ ] 5.4 `tab-close-ring-touch.spec.ts` gira solo su `chromium-touch-wide`: la prova e' della CI
- [x] 5.5 `tab-one-slot.spec.ts` e) tipo del browser che va e viene, f) «99+» dentro lo slot
