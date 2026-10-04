# Tasks: tab-menu-unico

Barra: `bun run typecheck`, i rail statici, i `bun:test` dei moduli toccati e le
spec E2E elencate qui sotto sul server isolato (progetto `webkit`). Ciò che è
verde resta verde. Prova di comportamento: un video `.webm` per ogni requisito
`TABSHEET-*`.

## 0. Prima di tutto: il rischio di D3

- [x] 0.1 Prova d'innesto: un `SubmenuItem` dentro il foglio della tab browser di
      oggi, con una voce finta. Verificare (spec E2E usa e getta, poi cancellata)
      che un clic nel livello non chiuda il foglio, che aprire il livello non lo
      chiuda per `popoverRegistry`, che Esc chiuda prima il livello e poi il
      foglio. Se una delle tre cade, estendere `SubmenuItem` (prop dell'ospite),
      non copiarlo.
      Prova: spec usa e getta su webkit ROSSA col `SubmenuItem` di allora («a
      click in the level does not close the sheet»: il foglio si chiudeva), VERDE
      dopo `SubmenuOwnerProvider` (ogni livello porta il `data-popover-owner` del
      foglio). Registro ed Esc reggevano già. Spec cancellata. Esteso poi con
      `hostRefs`: un clic su un'altra riga del foglio, a livello aperto, non
      viene mangiato.

## 1. Test rossi prima del codice

- [x] 1.1 `tests/e2e/tab-sheet.spec.ts`: uno scenario per ogni scenario di
      `TABSHEET-01..04`, `@covers` col requisito. Visti ROSSI su `main`.
      Prova: 8 test; sul bundle di `origin/main` 8/8 rossi su
      `getByTestId('tab-sheet')`, sul ramo 8/8 verdi (webkit, server isolato,
      nessun Chromium avviato: il socket del browser del server va a vuoto).
- [x] 1.2 Aggiornare gli scenari di `TOPIC-BROWSER-02` in
      `tests/e2e/browser-tab-chrome.spec.ts` (tasto destro = foglio; console e
      zoom nei livelli). Visti ROSSI.
      Passo 7 nuovo: tasto destro = stesso foglio, porta dei comandi, nessun
      altro pannello. Spec solo-chromium: la misura la CI. Zoom e dispositivo
      non esistono sul client web, quindi la coda di Pagina e i due «+» di
      fila li prova `tabSheetEntries.test.ts`.
- [x] 1.3 `lib/contextMenuSurfaces.test.ts`: il caso «una delle tre superfici
      con `<TabSheet` passa, un altro file con `<TabSheet` e nessun
      `ContextMenuPortal` no». Visto ROSSO.
      Prova: senza la regola 2 fail (la rotaia vera e il caso piantato), con
      la regola 5/5.

## 2. Il guscio

- [x] 2.1 Estrarre `components/Shared/TabSheet.tsx` da `BrowserTabSheet.tsx`:
      apertura per porta (indirizzo, download, comandi), posa, saldatura con la
      tab (`data-sheet-open`), regole di chiusura, porta che si richiude anche col
      tasto destro, fuoco di ritorno alla tab.
      `Shared/TabSheet.tsx` ascolta, `Shared/TabSheetBody.tsx` disegna (lazy,
      fuori dal chunk eager), `state/tabSheet.ts` tiene un foglio alla volta e
      la porta che si richiude (`tabSheet.test.ts`, 5/5).
- [x] 2.2 Posa: riposarsi quando la tab si sposta o cambia larghezza col foglio
      aperto (oggi solo al cambio di `chrome`). Riposata a ogni frame finché è
      aperto: la tab scivola anche senza resize.
- [x] 2.3 La tab aperta: stesso fondo del foglio, niente bordo inferiore (token,
      nessun colore a mano), nelle tre facce di `CHROME-05`. `[data-sheet-open]`
      sta nelle stesse regole di `.glass-surface` in `index.css`.
- [x] 2.4 ~~`state/browserPaneChrome`: contatore `commandsOpenRequest` e comando
      `openCommands`.~~ Sostituito da `state/tabSheet` (`openTabSheet(key,
      door)`), uno per ogni tipo di tab: il foglio si apre anche su una tab
      browser la cui pane non è montata, e «uno alla volta» ha un proprietario.

## 3. Il contenuto per tipo (design §2)

- [x] 3.1 `browserTabEntries`: testata, contestuali, Cerca, livelli Pagina,
      Strumenti, Sessione, Tab, Disposizione, chiusure. Togliere il doppione M7.
- [x] 3.2 `chatTabEntries`, `terminalTabEntries`, `utilityTabEntries`. Un solo
      costruttore puro, `buildTabSheetEntries` (`Shared/tabSheetEntries.ts`),
      sul modello che il corpo lega alle callback della barra.
- [x] 3.2b «Chiudi» con lo stesso cancello della X in ogni tipo: assente sulle
      pane in `nonClosablePaneIds` (oggi `PaneTabBar.tsx:1809` su M9 e M10).
- [x] 3.3 La regola dei livelli: una voce sola sale, zero voci sparisce. Test
      `bun:test` sulla funzione pura che costruisce l'albero delle voci.
      Prova: `tabSheetEntries.test.ts` 10/10 (ordine, tetto di 11, una voce
      sale, zero sparisce, a ogni profondità, niente si perde, un solo «copia
      indirizzo», niente conto alla rovescia, Chiudi solo se chiudibile,
      Interrompi solo mentre lavora, i due Fissa nominati).
- [x] 3.4 Code di stato dei livelli (zoom e dispositivo, errori e download,
      condivisione).
- [x] 3.5 «Sposta nel gruppo» come terzo livello, non fisarmonica.
- [x] 3.6 «Riprendi il controllo» al primo livello mentre un agente guida.

## 4. Le porte

- [x] 4.1 `PaneTabBar.tsx`: `handleContextMenu` e la pressione lunga aprono il
      foglio; cancellare il blocco `ContextMenuPortal` (righe 1543-2080) e lo stato
      `ctxMenu`, `spaceSubmenuOpen`, `renameDraft` e gli effetti collegati.
      Via anche `TabMenuStopItem`, `copyUrl` di `useCopyTabLink` e le chiavi
      i18n orfane. La tab prende il fuoco dalla tastiera (`tabIndex=-1`, per
      Shift+F10 e per il ritorno del fuoco), non dal puntatore.
- [x] 4.2 `TopicBrowserWindow.tsx`: le schede aprono il foglio (clic sull'attiva,
      tasto destro, pressione lunga), con «Apri come tab» e Chiudi.
- [x] 4.3 `StandaloneChatGroup.tsx`: il titolo sul telefono apre il foglio della
      superficie in primo piano come foglio dal basso.
- [x] 4.4 Rotaia `CTXMENU-01`: `<TabSheet` accettato per le tre superfici
      (`PaneTabBar.tsx`, `TopicBrowserWindow.tsx`, `StandaloneChatGroup.tsx`);
      `EditorTabs.tsx` resta su `ContextMenuPortal`.

## 5. Parole

- [x] 5.1 Le scritte fisse (Fissa, Rimuovi dai Fissati, Togli dai Fissati, Fissa il progetto,
      Fissa questa tab, Copia link alla tab, Copia link, Reimposta pannelli,
      Gruppo) nei cataloghi `i18n-it.ts` e `i18n-en.ts`.
- [x] 5.2 Nomi dei livelli, code di stato, «Zoom della pagina».

## 6. Spec E2E esistenti

- [x] 6.1 `tests/e2e/helpers/layout.ts` `splitViaContextMenu`: aprire
      Disposizione prima della voce.
- [x] 6.2 Le 19 spec che fanno tasto destro su una tab (elenco con
      `grep -l "button: 'right'\|button: \"right\"" tests/e2e | xargs grep -l "pane-tab\|tab-menu"`).
      Più quelle che passavano da «Sposta nel gruppo», «Chiudi ora» e dal menu
      a una voce del titolo sul telefono; aiuti comuni in `helpers/tab-sheet.ts`.
- [x] 6.3 Le 14 spec che leggono `browser-tab-sheet` → `tab-sheet`.
- [ ] 6.4 Girare tutte le spec di 6.2 e 6.3 sul server isolato, verdi.
      In parte, su webkit: 8/8 `tab-sheet`, 53/55 del primo lotto e 201/205 del
      secondo (21 spec aggiornate). I 6 rossi non passano dal foglio: clipboard
      negata a WebKit (TABLINK-08), banda di rete del telefono, due
      trascinamenti HTML5 (GDROP-01/05), due misure di font e animazione delle
      tessere. Le spec con una pane browser viva (pane-zoom,
      topic-browser-window, browser-*) e le solo-chromium le misura la CI: sul
      Mac il server di test le servirebbe con un Chromium.

## 7. Prova

- [x] 7.1 Video `.webm`: tasto destro su una tab browser → livello Disposizione
      → Dividi a destra; clic sulla stessa tab → indirizzo selezionato; tasto
      destro su una chat → Tab → Rinomina; una scheda della finestrella → Apri
      come tab; telefono 390 px → titolo tenuto premuto.
      Su WebKit il titolo e la tab «tenuti premuti» passano dal tasto destro:
      WebKit desktop non costruisce un `Touch`; la pressione lunga vera la
      misura il progetto `chromium` della CI sulla stessa spec.
- [x] 7.2 Misura della saldatura (bordo inferiore della tab e superiore del
      foglio) nei due temi, nello scenario di `TABSHEET-01`. Prova: bordo
      superiore del foglio a ≤ 1 px dal bordo inferiore della tab, bordi
      sinistri coincidenti, fondo identico in chiaro e in scuro, e diverso fra
      i due temi.
- [x] 7.3 `bunx --bun @fission-ai/openspec validate tab-menu-unico` exit 0.
