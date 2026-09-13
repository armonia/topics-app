# Tasks: browser-della-topic

Ogni tornata chiude con `bun run typecheck`, `bun run lint`, i cancelli statici e
gli E2E del perimetro toccato, enumerato dai testid e dai file cambiati
(`check:e2e-touched`), mai scelto a memoria. Le prove di comportamento sono
video `.webm` degli spec, non resoconti.

## Tornata 0: le due incognite, prima di scrivere componenti
- [x] **Ordine z fra due WKWebView.** Tauri dev: una pane browser nel layout e
      una seconda vista posata sopra con `browser_set_bounds`. Annotare quale
      delle due vince e se l'ordine cambia a un nuovo `set_bounds`. Se la vista
      nuova non sta sopra, aggiungere il comando di innalzamento accanto a
      `browser_set_bounds` (`lib.rs:5196`).
      → Ordine di creazione: chi nasce dopo sta sopra, `set_bounds` non
      riordina. Aggiunto `browser_raise`; prova in `tools/wkzprobe z`.
- [x] **Trascinare dal vivo o da fermo.** Segnaposto in un `div` fisso mosso a
      mano con `browser_set_bounds` in rAF. Misura: ritardo fra cursore e bordo
      della vista in un video a 60 fps. Entro un frame → dal vivo, altrimenti
      fermo immagine col cancello di `nativeViewDragGate.ts`. Scrivere la scelta
      nel design.
      → Da fermo: giro IPC p95 6-17 ms e p50 dei frame 17 ms sul pavimento wry
      (`tools/wkzprobe drag`), cioè un frame o due di ritardo in coda.

## Tornata 1: lo stato della finestra (puro)
- [ ] `client/src/state/topicBrowserWindow.ts`: reducer `open`, `activate`,
      `close`, `setMode`, `move`, `setWidth`, `promoteToTab`, `returnFromTab`;
      invariante «una scheda in un posto solo».
- [ ] Persistenza ui-state `topic-browser:<topicId>` con LWW, debounce e
      `X-Client-Id`, copiando `taskBrowserTabs` (compresa l'applicazione di
      `ui-state:updated` e `ui-state:init`).
- [ ] Test co-locati: ordine delle schede, promozione e ritorno, eco del proprio
      client scartata, sanitize al round-trip, posizione ancorata all'angolo
      dopo un resize dell'app.

## Tornata 2: la finestra, minimizzata ed espansa
- [ ] `TopicBrowserWindow`: barra con le schede della topic, «+», espandi,
      riduci, apri come tab, chiudi. Minimizzata trascinabile, espansa con il
      bordo sinistro trascinabile.
- [ ] Il segnaposto nativo dentro la finestra: `browser:reflow-request` a ogni
      cambio di posizione, raggio dichiarato, contenitore marcato
      `data-native-browser-slot`.
- [ ] `browser_raise` sulla vista della finestra all'apertura, a ogni cambio di
      stato e quando nasce un'altra vista nativa (una tab nuova, un cambio di
      topic): senza, la vista creata dopo la copre.
- [ ] `ChatPanel`: in stato espanso la chat cede lo spazio della finestra.
- [ ] Sotto 768 px la finestra non monta.
- [ ] E2E (`TOPIC-BROWSER-01`): larghezza della chat invariata da minimizzata,
      bordo della chat entro la finestra da espansa, posizione dopo cambio topic
      e dopo ricarica, promozione e ritorno sulla stessa pagina, telefono senza
      finestra. Falsificare il primo scenario facendo cedere spazio anche da
      minimizzata: deve diventare rosso.

## Tornata 3: la tab è la chrome
- [ ] Foglio della tab in `BrowserTabChrome`: indirizzo a fuoco e selezionato,
      navigazione, suggerimenti, poi le sezioni. Si apre da clic sulla tab
      attiva, dai tre puntini e da ⌘L.
- [ ] Fermo immagine della pagina mentre il foglio è aperto (`freeze()` al
      montaggio, `thaw()` alla chiusura). Invio naviga e chiude, Esc e clic
      fuori chiudono.
- [ ] Le voci di `browser-tab-menu-panel` passano al foglio con i loro testid;
      «Apri come tab» in finestra, «Riporta nella chat» in tab.
- [ ] `DownloadsMenu` e console ancorati al foglio, non alla riga.
- [ ] Cancellare `BrowserToolbar.tsx`, i suoi tre render in
      `RemoteBrowserPanel`, `browser-tab-menu`, `browser-address-dropdown`, e
      `showChrome`/`revealed`/`hideChrome`/`revealAddress` da
      `useBrowserChromeBridge`. `check:deadcode` verde senza eccezioni nuove.
- [ ] E2E (`TOPIC-BROWSER-02`): testo selezionato al clic, comandi visibili
      senza secondo menu, nessuna riga dopo console o download sui tre rami, Esc
      che non naviga. Aggiornare `browser-tab-chrome.spec.ts` (INLINE-01 e i
      casi del menu) invece di duplicarlo.

## Tornata 4: niente sopra la pagina
- [ ] Icona di tipo nella tab (connessione persa, condivisa, Chromium), assente
      sul tipo predefinito.
- [ ] Commutatori di motore e resa nella sezione Sessione del foglio; togliere
      `BrowserPaneChip` da `RemoteBrowserPanel`; rinominare «Nativo» nel testo del
      motore Playwright (chiavi i18n, non stringhe a mano).
- [ ] Aggiornare `browser-engine-switch.spec.ts`, `browser-dom-cobrowse.spec.ts`,
      `browser-ws-streaming.spec.ts` (`:393`) e `browser-iframe-mode.spec.ts` al
      nuovo posto dei commutatori.
- [ ] E2E (`TOPIC-BROWSER-03`): scheda condivisa senza pillole nell'area della
      pagina e con l'icona; scheda normale senza icona.

## Tornata 5: dove arrivano le aperture
- [ ] Porta unica dei link: origine chat di topic e viewport ≥ 768 px → scheda
      nella finestra; tab esistente sullo stesso contesto → naviga la tab.
- [ ] `open_browser_pane` dell'agente di topic → stessa regola, niente
      `requestBrowserSolo`.
- [ ] `/browser <url>` → finestra espansa.
- [ ] `openTabTarget.test.ts`, `openLink.test.ts`, `link-opens-in-tab.spec.ts`,
      `blank-anchor-opens-in-tab.spec.ts`: il caso «primo link fa lo split
      accanto alla chat» diventa «arriva nella finestra»; i casi da terminale e
      da pane browser restano com'erano.
- [ ] E2E (`TOPIC-BROWSER-04`): layout con le stesse pane e dimensioni dopo
      un'apertura dell'agente; tab esistente navigata senza finestra.

## Tornata 6: un viewport, un arbitro
- [ ] Server: `driverClientId` per contesto aggiornato dall'input; `resize`
      applicato solo dal driver, o dal primo client se nessuno ha dato input.
- [ ] Client streaming: pagina in scala e centrata su fondo del tema quando il
      contenitore non coincide col viewport.
- [ ] `DomCoBrowse`: applicare rrweb ViewportResize (incrementale, source 4).
- [ ] Test unit del server sull'arbitro; E2E (`TOPIC-BROWSER-05`) con due
      contesti browser di Playwright sullo stesso contesto, uno a 1280×800 e uno
      a 390×700.

## Chiusura
- [ ] Archiviare `tab-is-the-chrome` come assorbita, senza implementarla.
- [ ] In `agent-inline-browser/tasks.md` segnare le fasi 4 e 6 come sostituite
      da questa change.
- [ ] Video `.webm` dei tre stati e del foglio, allegati alla card.
