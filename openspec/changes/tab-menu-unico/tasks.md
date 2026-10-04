# Tasks: tab-menu-unico

Barra: `bun run typecheck`, i rail statici, i `bun:test` dei moduli toccati e le
spec E2E elencate qui sotto sul server isolato (progetto `webkit`). Ciò che è
verde resta verde. Prova di comportamento: un video `.webm` per ogni requisito
`TABSHEET-*`.

## 0. Prima di tutto: il rischio di D3

- [ ] 0.1 Prova d'innesto: un `SubmenuItem` dentro il foglio della tab browser di
      oggi, con una voce finta. Verificare (spec E2E usa e getta, poi cancellata)
      che un clic nel livello non chiuda il foglio, che aprire il livello non lo
      chiuda per `popoverRegistry`, che Esc chiuda prima il livello e poi il
      foglio. Se una delle tre cade, estendere `SubmenuItem` (prop dell'ospite),
      non copiarlo.

## 1. Test rossi prima del codice

- [ ] 1.1 `tests/e2e/tab-sheet.spec.ts`: uno scenario per ogni scenario di
      `TABSHEET-01..04`, `@covers` col requisito. Visti ROSSI su `main`.
- [ ] 1.2 Aggiornare gli scenari di `TOPIC-BROWSER-02` in
      `tests/e2e/browser-tab-chrome.spec.ts` (tasto destro = foglio; console e
      zoom nei livelli). Visti ROSSI.
- [ ] 1.3 `lib/contextMenuSurfaces.test.ts`: il caso «una delle tre superfici
      con `<TabSheet` passa, un altro file con `<TabSheet` e nessun
      `ContextMenuPortal` no». Visto ROSSO.

## 2. Il guscio

- [ ] 2.1 Estrarre `components/Shared/TabSheet.tsx` da `BrowserTabSheet.tsx`:
      apertura per porta (indirizzo, download, comandi), posa, saldatura con la
      tab (`data-sheet-open`), regole di chiusura, porta che si richiude anche col
      tasto destro, fuoco di ritorno alla tab.
- [ ] 2.2 Posa: riposarsi quando la tab si sposta o cambia larghezza col foglio
      aperto (oggi solo al cambio di `chrome`).
- [ ] 2.3 La tab aperta: stesso fondo del foglio, niente bordo inferiore (token,
      nessun colore a mano), nelle tre facce di `CHROME-05`.
- [ ] 2.4 `state/browserPaneChrome`: contatore `commandsOpenRequest` e comando
      `openCommands`.

## 3. Il contenuto per tipo (design §2)

- [ ] 3.1 `browserTabEntries`: testata, contestuali, Cerca, livelli Pagina,
      Strumenti, Sessione, Tab, Disposizione, chiusure. Togliere il doppione M7.
- [ ] 3.2 `chatTabEntries`, `terminalTabEntries`, `utilityTabEntries`.
- [ ] 3.2b «Chiudi» con lo stesso cancello della X in ogni tipo: assente sulle
      pane in `nonClosablePaneIds` (oggi `PaneTabBar.tsx:1809` su M9 e M10).
- [ ] 3.3 La regola dei livelli: una voce sola sale, zero voci sparisce. Test
      `bun:test` sulla funzione pura che costruisce l'albero delle voci.
- [ ] 3.4 Code di stato dei livelli (zoom e dispositivo, errori e download,
      condivisione).
- [ ] 3.5 «Sposta nel gruppo» come terzo livello, non fisarmonica.
- [ ] 3.6 «Riprendi il controllo» al primo livello mentre un agente guida.

## 4. Le porte

- [ ] 4.1 `PaneTabBar.tsx`: `handleContextMenu` e la pressione lunga aprono il
      foglio; cancellare il blocco `ContextMenuPortal` (righe 1543-2080) e lo stato
      `ctxMenu`, `spaceSubmenuOpen`, `renameDraft` e gli effetti collegati.
- [ ] 4.2 `TopicBrowserWindow.tsx`: le schede aprono il foglio (clic sull'attiva,
      tasto destro, pressione lunga), con «Apri come tab» e Chiudi.
- [ ] 4.3 `StandaloneChatGroup.tsx`: il titolo sul telefono apre il foglio della
      superficie in primo piano come foglio dal basso.
- [ ] 4.4 Rotaia `CTXMENU-01`: `<TabSheet` accettato per le tre superfici
      (`PaneTabBar.tsx`, `TopicBrowserWindow.tsx`, `StandaloneChatGroup.tsx`);
      `EditorTabs.tsx` resta su `ContextMenuPortal`.

## 5. Parole

- [ ] 5.1 Le scritte fisse (Fissa, Rimuovi dai Fissati, Togli dai Fissati, Fissa il progetto,
      Fissa questa tab, Copia link alla tab, Copia link, Reimposta pannelli,
      Gruppo) nei cataloghi `i18n-it.ts` e `i18n-en.ts`.
- [ ] 5.2 Nomi dei livelli, code di stato, «Zoom della pagina».

## 6. Spec E2E esistenti

- [ ] 6.1 `tests/e2e/helpers/layout.ts` `splitViaContextMenu`: aprire
      Disposizione prima della voce.
- [ ] 6.2 Le 19 spec che fanno tasto destro su una tab (elenco con
      `grep -l "button: 'right'\|button: \"right\"" tests/e2e | xargs grep -l "pane-tab\|tab-menu"`).
- [ ] 6.3 Le 14 spec che leggono `browser-tab-sheet` → `tab-sheet`.
- [ ] 6.4 Girare tutte le spec di 6.2 e 6.3 sul server isolato, verdi.

## 7. Prova

- [ ] 7.1 Video `.webm`: tasto destro su una tab browser → livello Disposizione
      → Dividi a destra; clic sulla stessa tab → indirizzo selezionato; tasto
      destro su una chat → Tab → Rinomina; una scheda della finestrella → Apri
      come tab; telefono 390 px → titolo tenuto premuto.
- [ ] 7.2 Misura della saldatura (bordo inferiore della tab e superiore del
      foglio) nei due temi, nello scenario di `TABSHEET-01`.
- [ ] 7.3 `bunx --bun @fission-ai/openspec validate tab-menu-unico` exit 0.
