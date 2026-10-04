## Da decidere

Tab: il tasto destro apre la tab espansa, lo stesso foglio del clic, con le voci a due livelli. 5 scelte. Mockup: `mockup/mockup-tab-menu.html` (e `.png`).
1. Il foglio è la tab che si allunga verso il basso, stessa superficie e nessun bordo fra le due. Perché: è la «cosa speciale» chiesta, e si legge come la tab aperta, non come un menu in più (o: pannello staccato sotto la tab, come oggi).
2. Dal tasto destro il fuoco va sulla prima voce e i suggerimenti non compaiono; clic e ⌘L restano indirizzo selezionato più suggerimenti. Perché: il tasto destro chiede un comando, non un indirizzo (o: identico al clic).
3. I livelli si aprono di lato col sottomenu del menu utente (freccia destra e sinistra, foglio sul telefono). Perché: esiste già ed è provato (o: il livello prende il posto del foglio, con una riga «Indietro»).
4. Vale per ogni tab della barra (chat, terminale, progetto), per le schede della finestrella del browser della topic e per il titolo sul telefono. Perché: «un'unica cosa», e oggi la finestrella non ha né foglio né tasto destro (o: solo le tab browser).
5. «Chiudi (con conto alla rovescia)» esce dal menu e resta sulla X. Perché: tre voci di chiusura sono troppe, e il tasto destro è già il gesto esplicito (o: resta, dentro Disposizione).

Compreso, senza scelta: «Copia URL della pagina» e «Copia indirizzo» diventano una voce sola; lo zoom della pagina si chiama «Zoom della pagina» e quello della cella resta «Ingrandisci»; le scritte italiane fisse del menu passano dal catalogo; un livello con una sola voce non esiste (la voce sale al primo livello); le tab dell'editor di file restano fuori.
Non verificato: il sottomenu dentro un foglio che non è un `Menu` (registro dei popover e clic fuori). È il primo task, prima di qualunque voce.
Col sì: sparisce il blocco `ContextMenuPortal` di `PaneTabBar.tsx` (righe 1543-2080); 19 spec E2E che fanno tasto destro su una tab e 14 che leggono il foglio vanno aggiornate.
«ok» = tutte le consigliate · «ok ma 2 no» = cambio la 2.

## Dove cambiarla

| # | Scelta | Requisito |
|---|--------|-----------|
| 1 | la tab si allunga, una superficie | `TABSHEET-01` (paragrafo «La forma» e scenario «la tab e il foglio sono una superficie»); design §D1 |
| 2 | tasto destro = fuoco sulla prima voce, niente suggerimenti | `TABSHEET-01` (paragrafo «Da dove si parte», scenari «tasto destro» e «clic sulla tab attiva»); `TOPIC-BROWSER-02` modificato (paragrafo delle porte); design §D2 |
| 3 | livelli di lato con `SubmenuItem` | `TABSHEET-02` (paragrafo dei livelli e scenario «tutto da tastiera»); design §D3 |
| 4 | ogni tab, la finestrella e il titolo sul telefono | `TABSHEET-03` (le tabelle per tipo), `TABSHEET-04`; `CTXMENU-01` e `LAYOUT-02` modificati; design §D4 |
| 5 | niente chiusura col conto alla rovescia nel menu | `TABSHEET-03` (riga «Chiudi»); `LAYOUT-02` (scenario «Close tab via context menu», che ora apre il foglio); design §D5 |

---

# Una tab, una superficie: il tasto destro apre la tab espansa

Approvata il 04/10 (`.openspec.yaml`, `status: approved`, risposta «ok» alle
cinque consigliate).

## Why

Richiesta del 04/10 (testo esatto in `.openspec.yaml`): uniformare il tasto
destro delle tab browser all'apertura, invece del menu a tendina; renderlo
usabile con i livelli; e farlo come una cosa della tab, che si espande dalla
barra, non come un menu nuovo.

Oggi, misurato sul codice (`origin/main` a `bbae359fb`), una tab browser ha **due
superfici di comandi che non si parlano**:

- **Il clic** sulla tab attiva, i tre puntini o ⌘L aprono il **foglio della tab**
  (`BrowserTabSheet.tsx`, corpo in `BrowserTabSheetBody.tsx:268-634`): indirizzo,
  navigazione, fino a 10 suggerimenti, strumenti, zoom, dispositivo, sessione,
  dimentica sito. Fino a **22 righe** in una colonna.
- **Il tasto destro** apre il **menu a tendina** di tutte le tab
  (`PaneTabBar.tsx:1543-2080`, su `ContextMenuPortal`): fissa, cerca, rinomina,
  copia link, copia URL, tre chiusure, zoom della cella, split, gruppi, finestre.
  Fino a **17 righe piatte**, con un sottomenu a fisarmonica («Sposta nel
  gruppo») che allunga la colonna.

Le due liste hanno **un doppione** («Copia URL della pagina» nel menu,
`:1772-1782`, e «Copia indirizzo» nel foglio, `:337-342`: stessa cosa, due nomi,
due conferme diverse) e **due buchi speculari**: dal tasto destro non si arriva a
indietro, console, zoom della pagina o dispositivo; dal foglio non si arriva a
Cerca, Rinomina, Fissa, Copia link, Chiudi o agli split. «Zoom» nel foglio è la
pagina, «Ingrandisci» nel menu è la cella: due ingrandimenti in due posti.

Le **altre tab** hanno solo il menu a tendina, con le stesse 17 righe possibili.
Le **schede della finestrella** del browser della topic
(`TopicBrowserWindow.tsx:540-556`) non hanno né foglio né tasto destro, anche se
`TOPIC-BROWSER-02` dice che la regola del foglio vale anche lì. Sul **telefono** la
pressione lunga sul titolo (`StandaloneChatGroup.tsx:999-1037`) offre una sola
voce, «Impostazioni della chat»: chiudere, rinominare, fissare o copiare il link
di una tab lì non si può.

Nel menu sono scritte a mano, fuori dal catalogo, queste parole: «Fissa», «Rimuovi
dai Fissati», «Fissa il progetto/questa tab» (composte), «Copia link alla tab»,
«Copia link», «Reimposta pannelli», più il ripiego «Gruppo».

## What Changes

**Una tab, una superficie.** Su ogni tab della barra il tasto destro, la
pressione lunga e Shift+F10 aprono il **foglio della tab**, lo stesso che sulla
tab browser apre il clic. Il menu a tendina delle tab sparisce.

**La tab si espande.** Il foglio non è un pannello sotto la tab: è la tab che si
allunga. Mentre è aperto la tab e il foglio sono una sola superficie, senza bordo
fra le due, allineate a sinistra.

**Due modi di entrare, una struttura.** Dalle porte dell'indirizzo (clic sulla
tab browser attiva, tre puntini, ⌘L) il campo è a fuoco e selezionato e sotto
ci sono i suggerimenti, come oggi. Dal tasto destro il fuoco va sulla prima voce
e i suggerimenti non compaiono. Il resto del foglio è identico.

**Due livelli.** Al primo livello stanno le voci che si cercano subito (dove vive
la scheda, Cerca, Chiudi) e cinque righe che aprono un livello di lato:
**Pagina**, **Strumenti**, **Sessione**, **Tab**, **Disposizione**. Ogni riga di
livello dice in coda lo stato (100% · Desktop, 2 errori, Su questo Mac). Il primo
livello di una tab browser ha al massimo 11 righe sotto l'indirizzo, contro le 39
voci delle due superfici di oggi. Struttura voce per voce in `design.md` §2.

**Ogni tab, ogni porta.** Chat, terminale e progetto hanno lo stesso foglio senza
indirizzo, con in testa il nome. Le schede della finestrella aprono il foglio
browser, con «Apri come tab» al posto della Disposizione. Sul telefono la
pressione lunga sul titolo apre il foglio della superficie in primo piano come
foglio dal basso.

## Non-Goals

- **Il tasto destro dentro la pagina** (`PaneContextMenu.tsx`, menu nativo della
  WKWebView): è il menu della pagina, non della tab.
- **Le tab dell'editor di file** (`EditorTabs.tsx:268`, 3 voci: Chiudi, Mantieni
  aperta, Copia percorso). Sono una barra diversa dentro la pane dei file, e con
  tre voci non c'è niente da ordinare.
- **Il menu delle righe in sidebar**, delle card e dei file: restano menu al
  cursore (`CTXMENU-01`).
- **Il bottone «Indietro» del foglio che sembra non funzionare** (segnalato nello
  stesso messaggio): è un difetto, non una forma, e va corretto a parte, prima di
  questa change.
- **Nuovi comandi.** Nessuna voce nuova oltre a «Riprendi il controllo» al primo
  livello, che oggi esiste solo come icona al passaggio del puntatore e quindi
  non si raggiunge col dito.

## Impact

- `client/src/components/Browser/BrowserTabSheet.tsx`,
  `BrowserTabSheetBody.tsx`: il foglio diventa il guscio comune `TabSheet`
  (decide quando, posa, chiude) più un contenuto per tipo; la porta «comandi» si
  aggiunge alle due che ci sono (indirizzo, download).
- `client/src/components/Layout/PaneTabBar.tsx`: si cancella il blocco
  `ContextMenuPortal` delle righe 1543-2080 e lo stato `ctxMenu`,
  `spaceSubmenuOpen`, `renameDraft`; `handleContextMenu` e la pressione lunga
  aprono il foglio della tab.
- `client/src/components/Browser/TopicBrowserWindow.tsx`: le schede della barra
  aprono il foglio (clic sulla attiva, tasto destro, pressione lunga).
- `client/src/components/Layout/StandaloneChatGroup.tsx`: il titolo sul telefono
  apre il foglio invece del menu a una voce.
- `client/src/components/Shared/SubmenuItem.tsx`: usato dentro un ospite che non
  è un `Menu`.
- `client/src/lib/contextMenuSurfaces.test.ts`: la rotaia di `CTXMENU-01`
  riconosce il foglio della tab come superficie condivisa.
- `client/src/lib/i18n-it.ts`, `i18n-en.ts`: le scritte fisse, i nomi dei
  livelli, le code di stato.
- E2E: `tests/e2e/helpers/layout.ts` (`splitViaContextMenu`) e le 19 spec che
  fanno tasto destro su una tab; le 14 che leggono `browser-tab-sheet`.
- Spec: `layout` ADDED `TABSHEET-01..04`, MODIFIED `LAYOUT-02`;
  `remote-browser` MODIFIED `TOPIC-BROWSER-02`; `touch-gestures` MODIFIED
  `CTXMENU-01`.
- Diventa falso, e la change lo cambia: lo scenario di `TOPIC-BROWSER-02` «console,
  zoom e dispositivo sono visibili senza aprire un altro menu». Ora stanno nei
  livelli Strumenti e Pagina dello stesso foglio.
- Nessuna migration, nessun cambio al server.
