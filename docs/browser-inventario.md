# Il browser di Topics: inventario reale

Letto sul codice il 2026-08-19, su `main` alla punta `563c848d8`. Nessun giudizio
qui dentro: solo cosa esiste, dove sta, e su quali piattaforme è vivo. Il
confronto con i browser veri e la scelta di cosa vale la pena sono le due card
successive della serie.

Quattro strati, in ordine di distanza dall'occhio: la pane, la toolbar, il
livello nativo, la superficie che vede l'agente. In fondo: come nasce una scheda
e l'elenco delle cose che, cercate, non ci sono.

## 1. La pane: tre modi di rendere la stessa pagina

Il componente d'ingresso è `client/src/components/Browser/RemoteBrowserPanel.tsx`
(1.303 righe). Sceglie da sé fra tre rese, e la scelta si vede nel menu
`⋯ → Sessione`.

| resa | chi disegna | dove | quando |
|---|---|---|---|
| **nativa** | una `WKWebView` figlia della finestra (WebView2 su Windows, WebKitGTK su Linux), fuori dal DOM di React | `useTauriBrowser.ts` + `NativeBrowserPlaceholder.tsx` | guscio desktop, quando questo device è l'unico che guarda |
| **condivisa** | Chromium headless del server, streaming (WebRTC quando c'è, altrimenti fotogrammi sul socket, con il polling HTTP come pavimento) | `useRemoteBrowser.ts` + `server/browser-service.ts` | client web e telefono, e sul desktop quando un ALTRO device apre la stessa pane |
| **co-browse DOM** | ricostruzione rrweb del DOM remoto, testo vero e selezionabile | `DomCoBrowse.tsx` (caricato pigro) | ramo alternativo del video sulla sessione condivisa |

Il passaggio nativa↔condivisa è automatico e si decide con un solo numero, i
viewer della pane (`lib/sharedAuto.ts`, `GET /api/browsers/:id/viewers`):
`auto` va nativa da soli e condivisa quando arriva un secondo device, e un clic
sul menu FISSA `nativa` o `condivisa`.

Sopra questo c'è un secondo interruttore, il **motore** della sessione condivisa:
`native` (il Chromium del server) oppure `chromium` (un Chrome installato
dall'utente, pilotato via CDP da un sidecar) per avere le **estensioni**
(`server/browser-engine-switch.ts`, `browser-chromium-sidecar.ts`,
`browser-chromium-extensions.ts`).

Dettagli di ciclo di vita che esistono e si vedono solo quando mancano:

- una pane di sfondo viene **nascosta** a livello di sistema (`browser_set_visible`
  → `setHidden:`), così WebKit ferma rAF e timer; se un agente la sta guidando
  resta viva ma parcheggiata a `x = -100000`;
- la webview non si smonta col componente: c'è un registro
  (`nativeBrowserRoster.ts`), un ritardo di grazia alla chiusura, e un
  **heartbeat di reclamo** per finestra (`browserClaimHeartbeat.ts` +
  `browser_claim`) che spazza le viste orfane;
- una scheda persistita verso una porta **locale** non parte alla cieca: prima si
  chiede al server se lì c'è ancora qualcuno in ascolto, e la pane resta
  «parcheggiata» (`ParkedPane.tsx`) invece di mostrare la pagina d'errore muta;
- gli errori di navigazione hanno un testo scritto in casa
  (`navErrorMessage.ts`), non quello del motore.

## 2. La toolbar, funzione per funzione

`BrowserToolbar.tsx` (638 righe) più i suoi satelliti.

| funzione | dove | note |
|---|---|---|
| indietro / avanti | pulsanti + **tieni premuto** = menu della cronologia di navigazione | la lista viene da `browser_nav_entries` |
| ricarica, stop | `RotateCw` | |
| barra indirizzi | `browserNavUrl.ts` | host in evidenza e `https://` nascosto come Chrome; quello che non è un URL diventa una **ricerca Google**; `http://` viene alzato a `https://` |
| favicon | `BrowserFavicon.tsx` + `faviconPlaceholder.ts` | segnaposto con l'iniziale del dominio quando il sito non ne ha una |
| cronologia recente | menu orologio | per topic, in `localStorage`, ultimi 50, mostrati 8/10 |
| **find in page** | `findInPageModel.ts` | contatore `n/m`: la ricerca è `window.find`, il totale lo conta un eval sul testo della pagina |
| **console** | `consoleLogModel.ts` + `ConsoleBadge` | badge con il conteggio errori e tendina con livelli, orario, filtro e copia |
| **download** | `DownloadsMenu.tsx` + `downloadsModel.ts` | menu nell'header, percentuale di avanzamento, destinazione decisa da wry |
| zoom | `ZoomControl` | applicato via CSS con un `exec_js`, non è lo zoom del motore |
| emulazione dispositivo | `DeviceSwitcher` | cambia dimensioni e user-agent (`browser_set_user_agent`) |
| DevTools | `browser_toggle_devtools` | ispettore del motore, `⌥⌘I` |
| apri nel browser di sistema | `openExternal` | la via d'uscita per captcha e login difficili |
| torna alla chat | chip a sinistra | quando la pane è stata aperta da una chat (`browserSpawner`) |
| sessione: automatica / nativa / condivisa | menu `⋯` | vedi sopra |
| **dimentica questo sito…** | `ForgetSiteDialog.tsx` | elenca cosa sparisce PRIMA di cancellare |
| pillola «agente al lavoro» | `AgentActivityPill.tsx` | mentre un agente guida la pane |
| menu contestuale nella pagina | `PaneContextMenu.tsx` | indietro/avanti/ricarica, copia, link, immagine, ispeziona |
| seleziona elemento | `SelectElementOverlay.tsx` | `⌘⇧E`, passa alla chat la descrizione dell'elemento |

Sotto una certa larghezza le voci secondarie si piegano nel menu `⋯`, e la barra
indirizzi tiene il suo spazio.

### Scorciatoie, quando il fuoco è nella pane

`⌘L` barra indirizzi · `⌘R` ricarica · `⌘[` e `⌘]` indietro/avanti · `⌘F` find ·
`⌘+` `⌘-` `⌘0` zoom · `⌥⌘I` DevTools · `⌘⇧E` seleziona elemento.
Sono gestite dentro il pannello, non dal registro globale di `shared/shortcuts.ts`.

## 3. Il livello nativo (Tauri/Rust)

`desktop-tauri/src-tauri/src/lib.rs` espone **30 comandi** `browser_*`; i rami
non-macOS vivono in `browser_win.rs` (726 righe) e `browser_linux.rs` (623).

- **ciclo di vita e geometria**: `browser_open` (idempotente sull'etichetta),
  `browser_navigate`, `browser_set_bounds`, `browser_animate_bounds`,
  `browser_set_visible`, `browser_list`, `browser_close`, `browser_claim`;
- **navigazione**: `browser_back`, `browser_forward`, `browser_reload`,
  `browser_nav_entries`, `browser_go_to_index`;
- **contenuto**: `browser_eval_js` (con risultato), `browser_exec_js` (senza),
  `browser_screenshot`, `browser_toggle_devtools`, `browser_set_user_agent`;
- **sessione**: `browser_pane_get_cookies`, `browser_pane_set_cookies`,
  `browser_purge_cache`, `browser_purge_data_store`, `browser_site_data_records`,
  `browser_forget_site`, `browser_reap_data_stores`;
- **code da svuotare** (il client interroga): `browser_take_nav_state`,
  `browser_take_nav_errors`, `browser_take_download_events`,
  `browser_download_progress`;
- **fuoco**: `browser_release_focus`.

### Parità fra le tre piattaforme

Quasi tutto ha i suoi tre rami. Le eccezioni misurate:

| cosa | macOS | Windows | Linux |
|---|---|---|---|
| cronologia come lista (`nav_entries`) e salto a un indice | sì | **no**: WebView2 non la espone, il comando restituisce una lista vuota dichiarata e il salto è un no-op | sì |
| stato di navigazione **spinto** dal motore (KVO su url/title/loading) | sì | no: resta il poll con eval | no: resta il poll con eval |
| `browser_release_focus` (restituire il primo responder alla UI) | sì | no-op | no-op |
| user-agent: ritorno al default | stringa vuota | il default va memorizzato al primo cambio | stringa vuota |
| download, cookie, cache, dati del sito, eval, screenshot | sì | sì | sì |

## 4. La superficie dell'agente

`server/browser-tool-spec.ts` dichiara **16 tool**. Sulla sessione condivisa li
serve Playwright (`browser-ops-adapter.ts`); sulla pane nativa non c'è CDP, e il
server delega al client, che li esegue con i comandi Tauri
(`server/browser-native-delegate.ts` ↔ `client/src/lib/shell/tauriBrowserOps.ts`).

| tool | condivisa | nativa |
|---|---|---|
| `browser_open`, `browser_observe`, `browser_act`, `browser_extract`, `browser_get_text`, `browser_eval`, `browser_screenshot`, `browser_console`, `browser_status`, `browser_upload`, `browser_save_state`, `browser_load_state`, `browser_import_chrome` | sì | sì (13) |
| `browser_network` (richieste della pagina, con i fallimenti) | sì | **no** |
| `browser_read_screen` (descrizione della schermata da un modello di visione) | sì | **no** |
| `browser_point` (grounding visivo su coordinate) | sì | **no** |

Le tre che mancano ricevono un rimando esplicito alla modalità condivisa, non un
errore muto (`NATIVE_SUPPORTED_OPS`).

Attorno ai tool: `browser_observe` è **incrementale** (torna il diff dallo
snapshot precedente), lo screenshot va su file e non nel contesto, e la rete e i
dialoghi sono registrati per pane (`browser-network-log.ts`, `lastDialog`).
Il ponte MCP sta in `server/routes/browser-bridge.ts`.

## 5. Sessione, cookie, dati del sito

- **isolamento per pane**: ogni `contextId` ha il suo `WKWebsiteDataStore`
  persistente (`isolate: true` in `browser_open`), l'analogo della partizione
  Electron; su Windows e Linux è una `data_directory` per pane;
- **chiudere una pane non cancella il login**: alla chiusura si fa un purge
  SELETTIVO della cache, cookie e `localStorage` restano
  (`browser_purge_cache`), e c'è un reaper a scadenza per gli store non toccati
  da giorni (`browserDataStoreReaper.ts`, `browser_reap_data_stores`);
- **dimentica questo sito**: elenco dei record per dominio registrabile e
  rimozione dei soli silo scelti, sia sulla pane nativa sia sulla condivisa
  (`browser-site-data.ts`, `browserForgetSite.ts`);
- **un solo cassetto**: passando da nativa a condivisa la sessione viene
  travasata (`browser-session-handoff.ts`), così il login non si perde al flip;
- **stato di login trasportabile**: `browser_save_state` / `browser_load_state`
  (handle riusabile, legato anche alle tab di un task) e
  `browser_import_chrome` per prendere i cookie da Chrome.

## 6. Come nasce una scheda

Le vie d'apertura di una pane browser, oggi:

1. il menu **New…** (`⌘N`) e la palette `⌘K`, voce Browser;
2. un **link cliccato in chat** o il comando `/browser`;
3. l'agente con `open_browser_pane` (MCP) o il manifesto di tab di un task;
4. il ripristino di una scheda persistita all'avvio della finestra.

Cosa trova chi apre una scheda: la toolbar, e sotto `about:blank`. Non c'è una
pagina di nuova scheda: niente siti frequenti, niente ricerca al centro, niente
scorciatoie. L'unico ingresso è la barra indirizzi. Il modello dello storico
globale per una pagina simile è già scritto (frecency) ma non è su `main`: vive
sulla card «Browser: pagina nuovo tab premium», in lavorazione.

Due asimmetrie che vale la pena scrivere perché sorprendono:

- `⌘T` apre una **chat**, non una scheda del browser: il browser non ha una sua
  scorciatoia di apertura;
- «Apri il link in una nuova scheda» del menu contestuale passa da
  `window.open`, cioè lo raccoglie il guscio (`on_new_window`) o il browser di
  sistema: **non** nasce una seconda pane di Topics.

## 7. Cercate e non trovate

Fatti, non giudizi. Nel codice non esiste, alla data di questa lettura:

- **segnalibri** (nessuna occorrenza, in nessuno dei tre strati);
- una **cronologia globale** navigabile: c'è solo la lista per topic in
  `localStorage`, mostrata come menu di URL recenti;
- una **pagina di nuova scheda** (vedi sopra);
- **schede dentro la pane**: la molteplicità è quella delle pane del layout, e
  ogni pane è una pagina sola;
- **profili** del browser separati dall'isolamento per pane;
- **estensioni** sulla pane nativa: solo sul motore Chromium della sessione
  condivisa;
- **stampa**, lettore PDF proprio, modalità lettura, traduzione, gestore
  password.

## 8. Le carte del codice, in breve

| strato | file principali |
|---|---|
| pane e UI | `client/src/components/Browser/` (6.759 righe, 30 file) |
| ponte client↔nativo | `client/src/hooks/useTauriBrowser.ts`, `client/src/lib/shell/tauriBrowserOps.ts` |
| ponte client↔server | `client/src/hooks/useRemoteBrowser.ts`, `shared/browser-ws-messages.ts` |
| motore condiviso | `server/browser-service.ts` (2.216 righe) e i 25 moduli `server/browser-*.ts` |
| tool dell'agente | `server/browser-tool-spec.ts`, `browser-tool-dispatcher.ts`, `routes/browser-bridge.ts` |
| nativo | `desktop-tauri/src-tauri/src/lib.rs`, `browser_win.rs`, `browser_linux.rs`, `browser_eval.rs` |
