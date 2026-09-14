# Tasks: browser-della-topic

Ogni tornata chiude con `bun run typecheck`, `bun run lint`, i cancelli statici e
gli E2E del perimetro toccato, enumerato dai testid e dai file cambiati
(`check:e2e-touched`), mai scelto a memoria. Le prove di comportamento sono
video `.webm` degli spec, non resoconti.

## Tornata 0: le due incognite, prima di scrivere componenti
- [ ] **Ordine z fra due WKWebView.** Tauri dev: una pane browser nel layout e
      una seconda vista posata sopra con `browser_set_bounds`. Annotare quale
      delle due vince e se l'ordine cambia a un nuovo `set_bounds`. Se la vista
      nuova non sta sopra, aggiungere il comando di innalzamento accanto a
      `browser_set_bounds` (`lib.rs:5196`).
- [ ] **Trascinare dal vivo o da fermo.** Segnaposto in un `div` fisso mosso a
      mano con `browser_set_bounds` in rAF. Misura: ritardo fra cursore e bordo
      della vista in un video a 60 fps. Entro un frame → dal vivo, altrimenti
      fermo immagine col cancello di `nativeViewDragGate.ts`. Scrivere la scelta
      nel design.

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
- [ ] `ChatPanel`: in stato espanso la chat cede lo spazio della finestra.
- [ ] Sotto 768 px la finestra non monta.
- [ ] E2E (`TOPIC-BROWSER-01`): larghezza della chat invariata da minimizzata,
      bordo della chat entro la finestra da espansa, posizione dopo cambio topic
      e dopo ricarica, promozione e ritorno sulla stessa pagina, telefono senza
      finestra. Falsificare il primo scenario facendo cedere spazio anche da
      minimizzata: deve diventare rosso.

## Tornata 3: la tab è la chrome
- [x] Foglio della tab (`BrowserTabSheet.tsx`): indirizzo a fuoco e selezionato,
      navigazione, suggerimenti, poi le sezioni. Si apre da clic sulla tab
      attiva, dai tre puntini e da ⌘L. Sta nel sottoalbero React della tab ma è
      portato sul `body`: un antenato trasformato della striscia rende `fixed`
      relativo a lui, e il pannello finiva a y=-3 (vedi la nota nel delta).
- [x] Fermo immagine della pagina mentre il foglio è aperto (`freeze()` al
      montaggio, `thaw()` alla chiusura e allo smontaggio). Invio naviga e
      chiude, Esc e clic fuori chiudono.
- [x] Le voci di `browser-tab-menu-panel` passano al foglio con i loro testid.
      `custom` (viewport W×H) viveva solo nel `DeviceSwitcher` della toolbar:
      è il quinto segmento della riga dispositivo, coi due numeri sotto.
      Manca «Apri come tab» / «Riporta nella chat»: dipendono dalla finestra
      (Tornata 2), che non esiste ancora.
- [x] `DownloadsMenu` e console ancorati al foglio, non alla riga. Un download
      che parte NON apre il foglio (congelerebbe la pagina per una cosa non
      chiesta): accende una spia nella tab, e il clic sulla spia apre il foglio
      sui Download. La spia è disegnata due volte perché corsia dei segnali e
      corsia dei comandi si danno il cambio (`.row-trail` → `pointer-events:
      none` all'hover).
- [x] Cancellati `BrowserToolbar.tsx` e i suoi tre render, `BrowserTabAddress`,
      `AgentActivityPill`, `ZoomControl`, `DeviceSwitcher`, e
      `showChrome`/`revealed`/`hideChrome`/`revealAddress`/`registerFocus`.
      `check:deadcode` verde senza eccezioni nuove.
- [x] E2E (`TOPIC-BROWSER-02`) in `browser-tab-chrome.spec.ts`, aggiornato e non
      duplicato. Zoom, dispositivo e console non si asseriscono: sono capacità
      del ramo nativo, irraggiungibili da Chromium. `check:e2e-touched` 52/52.
- [x] Revisione della Tornata 3 (14/09). La negazione «nessuna riga» ERA ancora
      un testid morto in tredici punti di tre spec (`browser-url-input`,
      `browser-tab-menu-panel`), e il passo della console stava sotto un `if`
      sempre falso in Chromium: ora è geometrica ovunque, da un helper solo
      (`tests/e2e/helpers/browser-geometry.ts`), e il passo cieco è tolto con
      il perché scritto nel test. La metà «parte un download» dello scenario è
      coperta solo dal notturno: `browser-ws-streaming` sta in
      `NIGHTLY_ONLY_SPECS`.
- [x] Esc chiude da qualunque fuoco (ascoltatore in bolla sul documento: il
      primo Esc resta del popover figlio); un clic sulla pagina chiude anche sul
      ramo iframe (i frame non prendono il puntatore mentre il foglio è
      aperto); il secondo clic su tab o puntini chiude invece di riaprire; i
      popover esenti dal clic fuori sono solo quelli aperti dal foglio
      (`data-popover-owner`). Il foglio muore con la tab: provato da un altro
      dispositivo (`CD-CLOSE-03`), perché la X sullo stesso dispositivo lo
      chiude già col suo pointerdown.
- [x] La tab filtra gli eventi che le arrivano dal portale (`fromThisTab`):
      doppio clic, tasto destro, trascinamento e pressione lunga dentro il
      foglio non toccano più la tab.
- [x] Il corpo del foglio è un chunk pigro (`browserTabSheetLazy.ts`), scaldato
      al passaggio del puntatore sulla tab: nell'ingresso eager aveva portato
      console e download, e la CI della PR #34 era fuori budget
      (entry_eager 1.403.155 raw / 439.747 gz contro 1.393.840 / 435.687).
- [x] Rossi della CI della PR #34 (14/09). Il passo «clic sulla pagina» cercava
      un iframe che non poteva esistere: la sonda del server rifiuta ogni
      indirizzo loopback (`isSafePublicUrl`) e una pane aperta su loopback non
      naviga da sola, anche su main; ora il test finge la sola risposta della
      sonda e conferma l'indirizzo dal foglio. E Esc e clic fuori vivevano nel
      corpo pigro: aperto su un chunk freddo il foglio era sordo, poi spuntava
      e si prendeva l'Esc successivo (sotto uno zoom, misurato). Passati nella
      metà eager, +603 raw / +181 gz, dentro il budget.

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
