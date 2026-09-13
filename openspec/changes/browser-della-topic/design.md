# Design: browser-della-topic

## Un oggetto, tre stati

```
                 «Espandi»                    «Apri come tab»
  minimizzato  ───────────▶  espanso  ──────────────────────▶  tab
      ▲   ◀───────────────      │                              │
      │       «Riduci»          │ «Apri come tab»              │
      └─────────────────────────┴──────── «Riporta nella chat» ┘
```

La finestra della topic è UNA per topic. Minimizzato ed espanso sono lo stesso
componente con due geometrie; «come tab» toglie una scheda dalla finestra e la
mette nel layout. Le altre schede restano nella finestra.

| | Dove vive | Chi la dimensiona | Nel `pane-store-v2`? |
|---|---|---|---|
| minimizzato | `position: fixed` dentro l'area della topic | dimensione predefinita, posizione trascinata | no |
| espanso | agganciato a destra dell'area della topic | larghezza trascinata dal bordo sinistro | no |
| tab | una cella del layout | il layout | **sì**, pane browser normale |

### Stato persistito

```ts
interface TopicBrowserWindow {
  topicId: string;
  mode: 'min' | 'exp' | 'hidden';
  minPos: { right: number; bottom: number } | null; // ancorata all'angolo, sopravvive a un resize
  expWidth: number | null;                           // px, null = predefinita
  tabs: { contextId: string; url: string; title: string; openedBy: 'user' | 'agent' | 'link' }[];
  activeContextId: string | null;
}
```

Chiave ui-state `topic-browser:<topicId>`, con la meccanica già pagata da
`taskBrowserTabs`: LWW con debounce, `X-Client-Id`, e applicazione di
`ui-state:updated` e `ui-state:init` (il bug di uno store che scrive e non
rilegge è `78926d14`). Il reducer è puro e sta in `client/src/state/`, con test
co-locato.

La posizione è ancorata a destra e in basso, non a sinistra e in alto: quando la
finestra dell'app si stringe la finestrella resta nel suo angolo invece di
uscire dallo schermo.

«Come tab» fa `OPEN_PANE` con lo **stesso** `contextId` e toglie la scheda da
`tabs`. «Riporta nella chat» fa l'inverso: `CLOSE_PANE` senza distruggere il
contesto, e la scheda torna in `tabs` come attiva. Una scheda non vive mai in
entrambi i posti: è la lezione della striscia del task, mai due
rappresentazioni vive della stessa cosa.

`hidden` è la finestra chiusa con schede ancora aperte: un pulsante nella barra
della topic la riapre. Chiudere l'ultima scheda porta a `hidden` con `tabs`
vuoto.

## La vista nativa fuori dalla griglia

Oggi niente lega la WKWebView alla griglia: `NativeBrowserPlaceholder` misura il
proprio rettangolo (`:188`) e `useTauriBrowser.applyBounds` lo manda con
`browser_set_bounds` (`:430-476`). Quindi il segnaposto dentro una finestra
`position: fixed` funziona già, con due buchi:

1. **Uno spostamento senza cambio di dimensione non si vede.** Il
   ResizeObserver non scatta; restano MutationObserver, scroll e il poll da
   ~500 ms. La finestra, quando cambia posizione, emette
   `browser:reflow-request`, che il segnaposto ascolta già (`:246-406`).
2. **Il raggio.** Viene solo da `.floating-splits` (`useTauriBrowser.ts:463`).
   La finestra dichiara il suo con un attributo sul segnaposto.

### Trascinare

**Tornata 0: si trascina da fermo, per scelta prudenziale.** Il cancello di
`nativeViewDragGate.ts:52` fa `freeze()` all'inizio del gesto (screenshot come
`<img>`, vista nativa parcheggiata) e la vista riappare a `-end` nella posizione
nuova. Il ridimensionamento del bordo in stato espanso segue la stessa scelta.

Il criterio era «entro un frame dal cursore → dal vivo», da misurare con un
video a 60 fps del bordo della vista contro il cursore. **Quel metodo è stato
sostituito, non eseguito.** Al suo posto `tools/wkzprobe drag` (240 frame, una
`set_bounds` per rAF, spostamento di 8 px logici a frame ≈ 480 px/s) misura il
giro IPC pagina → host → pagina su wry nudo, cioè il pavimento: un
`#[tauri::command]` ci aggiunge serde e un salto per la coda dell'event loop.
Nella sonda non ci sono cursore, video né compositing.

| quattro run, Mac di sviluppo | p50 | p95 | max |
|---|---|---|---|
| giro IPC completo | 1–2 ms | 6–17 ms | 21–34 ms |
| la `set_bounds` in sé, lato host | 0,10–0,13 ms | 0,24–0,29 ms | |
| intervallo fra i frame della pagina | 17 ms | 23–33 ms | 38–132 ms |

Il giro è un **tetto dell'andata**, non l'andata: comprende il ritorno dell'ack
via `evaluate_script` (`tools/wkzprobe/src/main.rs`, subito dopo `set_bounds`) e
l'attesa del main thread della stessa pagina che misura, quella che perde frame.
L'andata da sola non si ricava per sottrazione, perché `performance.now()` della
pagina e `Instant` dell'host sono due orologi; e anche con un orologio comune
resterebbe latenza IPC, non scollamento a schermo. L'intervallo fra i frame non
è un ritardo: nell'app vera `set_bounds` parte dal rAF della pagina host, che
disegna anche il telaio, quindi un frame perso ritarda insieme DOM e vista.

Letti per quello che dicono, a 480 px/s: la mediana (1–2 ms) è lontana da un
frame. A **p95** (6–17 ms) il giro vale **3–8 px, entro circa un frame** (solo la
run peggiore tocca 1,02 frame). È la **coda max** (21–34 ms, cioè 10–16 px e
1–2 frame) a uscire dal criterio. Sopra il pavimento vanno ancora React, il
rettangolo da misurare e il giro di Tauri, che nessuno ha misurato.

La scelta «da fermo» quindi è **dedotta, non dimostrata**: si regge sulla coda
max, su un pavimento che nell'app vera può solo crescere, e su una lezione già
pagata. La slide della sidebar faceva esattamente questo inseguimento a rAF e
«il bordo del pane balbettava», tanto da far nascere `browser_animate_bounds`
(`lib.rs:5308`). Quella via qui non si può riusare: un trascinamento non ha un
punto d'arrivo da dare a Core Animation. Se la scelta va dimostrata, l'unica
misura che risponde al criterio è quella originale: registrare lo schermo a
60 fps mentre telaio DOM e vista nativa si muovono dal rAF della pagina host, e
contare i px di scollamento frame per frame.

### Due viste native una sopra l'altra

**Misurato su WKWebView, tornata 0: l'ordine z è l'ordine di creazione, e
nient'altro.** Chi nasce dopo sta sopra; una `set_bounds` sulla vista sotto non
la rimette davanti. In wry ogni figlia entra con `addSubview:`
(`wkwebview/mod.rs:666`), che accoda, e `set_bounds` chiama solo `setFrame:`
(`:1024`), che non riordina. Che Tauri non aggiunga niente è **letto nel
sorgente, non eseguito**: il suo `SetPosition` finisce sulla stessa
`set_bounds`, ma la sonda è wry nudo e il `browser_raise` del guscio non è
ancora mai stato invocato. Su WebView2 e WebKitGTK vedi §Rischi.

Quindi la finestrella resta sopra finché nessuna pane browser nasce dopo di lei
— e nasce dopo ogni volta che si apre una tab, si cambia topic o si ricrea una
vista. La finestra va **alzata a mano**: all'apertura, a ogni cambio di stato e
alla creazione di una qualunque altra vista nativa nella stessa finestra.

Il comando c'è: `browser_raise` (`lib.rs`, accanto a `browser_set_bounds`) fa
**solo** `addSubview:positioned:NSWindowAbove relativeTo:nil` sul superview che
la vista ha già. AppKit la riordina sul posto, senza callback
`willMoveToSuperview:`, e la vista resta first responder della sua finestra. Un
`removeFromSuperview` prima (la prima versione del comando) riordina uguale ma
passa il first responder alla NSWindow: chi sta scrivendo nella finestrella
perderebbe la tastiera a ogni innalzamento, mentre il DOM
(`document.activeElement`, il numero della pagina) non se ne accorge. Misurato
in revisione con AppKit (swiftc, NSTextView e WKWebView, finestra nascosta e
visibile, due e tre viste). Si è visto il first responder spostarsi, non un
tasto perso: da quella shell la finestra non è mai diventata key, e la perdita
della tastiera è ciò che ne segue, perché AppKit consegna i tasti al first
responder.

La prova è `tools/wkzprobe z` (exit 0 = tutte le attese rispettate): creata per
seconda vince · `set_bounds` sulla sotto non riordina · l'innalzamento vince ·
**la vista alzata resta first responder** · una vista creata dopo copre di nuovo
la alzata · **la pagina sopravvive all'innalzamento** (il numero casuale che si
è coniata alla nascita è lo stesso dopo: nessun ricaricamento, nessun processo
nuovo). Il verdetto sul first responder è stato aggiunto in revisione insieme
alla correzione del comando, e la sonda con quel verdetto non è ancora stata
ricompilata né lanciata: è il primo passo del task di innalzamento in tornata 2.

### Occlusione

La finestra non è un overlay per le altre viste native: il suo contenitore porta
`data-native-browser-slot`, che `browserOcclusion.ts:142` salta già. I menu e i
popover della chat che finiscono sopra il rettangolo della finestra la
congelano con le regole di `OCCLUSION-01`, senza codice nuovo.

## La tab come chrome

Il foglio della tab sostituisce tre superfici:

| Oggi | Dopo |
|---|---|
| `BrowserToolbar` (tre rami, acceso da console/download) | cancellato |
| `browser-tab-menu-panel` (menu a tendina) | le stesse voci, in chiaro nel foglio |
| `browser-address-dropdown` (portale per l'indirizzo) | la prima riga del foglio |

Ordine delle sezioni, dal prototipo: indirizzo selezionato e navigazione
(indietro, avanti, ricarica, copia, apri fuori) · suggerimenti (cronologia della
pane e frecenza globale, gli stessi due elenchi di oggi) · Strumenti (console,
download, devtools) · Zoom · Dispositivo · Sessione (nativa/condivisa, motore,
resa DOM/Video) · Dimentica sito. In stato tab si aggiunge «Riporta nella
chat»; in finestra «Apri come tab».

I testid di oggi restano sulle voci che si spostano (`browser-tab-back`,
`browser-tab-console`, `browser-tab-zoom`, …): il perimetro degli spec toccati
si enumera da quelli, non a memoria.

**Il foglio sta nella tab, non in un portale.** Si apre sotto la tab e copre la
pagina, che per questo diventa un fermo immagine (`freeze()`). Un popover
portato fuori da un contenitore che si chiude muore al primo clic: trappola già
pagata.

## Le pillole diventano un'icona

| Pillola di oggi (`RemoteBrowserPanel.tsx`) | Dove va |
|---|---|
| `browser-connection-indicator` (`:1237`) | icona nella tab, solo quando non connesso |
| `browser-engine-toggle` «Nativo»/Chromium (`:1253`) | Sessione nel foglio; icona nella tab solo su Chromium |
| `browser-render-toggle` DOM/Video (`:1272`) | Sessione nel foglio |
| stato condiviso | icona nella tab |

L'icona sta tra favicon e titolo e compare solo quando il tipo non è quello
predefinito (vista nativa, non condivisa, connessa): la tab normale non cambia.
L'etichetta «Nativo» per il motore Playwright sparisce; nel foglio si chiama
per quello che è.

`browser-dom-select-mode` (`DomCoBrowse.tsx:521`) resta: è lo stato
temporaneo di una modalità attivata dall'utente, non un'etichetta permanente.

## Un viewport, un arbitro

Oggi ogni client con la pane montata manda `resize` dal suo ResizeObserver e il
server applica l'ultimo. La regola nuova:

- **Guida chi usa la pagina.** Il server tiene un `driverClientId` per
  contesto: il client che ha mandato l'ultimo input (puntatore, tastiera,
  rotella). Solo il suo `resize` cambia il viewport. Un client appena connesso
  che non ha ancora toccato niente non lo cambia, a meno che non ci sia nessun
  driver.
- **Chi guarda si adatta.** Un client il cui contenitore ha dimensioni diverse
  dal viewport mostra la pagina in scala, centrata, su fondo neutro del tema,
  non in alto a sinistra su bianco.
- **`DomCoBrowse` legge ViewportResize** (rrweb incrementale, source 4), oltre
  al Meta iniziale: oggi un cambio di viewport a sessione avviata non arriva.

## Dove arriva un sito aperto senza chiedere

| Origine | Oggi | Dopo |
|---|---|---|
| link cliccato in una chat di topic | split accanto alla chat (`LINK-TAB-02`) | scheda nella finestra della topic |
| `open_browser_pane` dell'agente | pane globale accanto alla chat | scheda nella finestra della topic |
| `/browser <url>` nel composer | pane | scheda nella finestra, espansa |
| terminale, pane browser, finestra di progetto, task | invariato | invariato |

Regola unica per le prime due righe: se la scheda con quel contesto è già una
tab, naviga la tab; altrimenti entra nella finestra nello stato in cui la
finestra è (`hidden` diventa `min`). Il layout non cambia mai per un'apertura
che l'utente non ha fatto con le sue mani. `/browser` espande perché è una
richiesta esplicita di guardare.

## Decisioni proposte, in attesa del sì (blocco `## Da decidere` in cima a proposal.md)

| # | Domanda | Consigliata | Alternativa | Dove cambiarla |
|---|---|---|---|---|
| 1 | La finestrella mostra… | la pagina viva della scheda attiva | un fotogramma aggiornato al cambio pagina | `TOPIC-BROWSER-01` |
| 2 | Col foglio aperto la pagina… | resta un fermo immagine | la finestra si allunga e la pagina scende | `TOPIC-BROWSER-02` |
| 3 | Da espanso la larghezza… | si trascina dal bordo, resta per topic | fissa a metà | `TOPIC-BROWSER-01` |
| 4 | Quando l'agente apre un sito… | arriva nella finestrella, layout intatto | si apre espanso se guardi la chat | `LINK-TAB-02`, `TOPIC-BROWSER-04` |
| 5 | La barra della finestra elenca… | le schede della topic; quelle del progetto dal «+» | tutte le schede dell'app | `TOPIC-BROWSER-01` |

## Rischi

- **Memoria.** Una pagina viva in ogni finestrella minimizzata è una WebContent
  in più per topic aperta. Il tetto di residenza delle pane
  (`index_perf-delle-pane`) si applica anche alle schede della finestra: una
  topic non a fuoco parcheggia la sua vista.
- **Trascinamento dal vivo che non regge.** Chiuso in tornata 0 per prudenza: si
  trascina da fermo, col percorso già in uso. La scelta è dedotta dal pavimento
  IPC, non dimostrata dal video del criterio (§Trascinare).
- **Ordine z fra due viste native.** Chiuso **solo su WKWebView**
  (`tools/wkzprobe z`): è l'ordine di creazione, e `browser_raise` lo corregge.
  Su WebView2 il meccanismo è lo stesso, letto nel sorgente di wry 0.55.1: ogni
  HWND figlio nasce con `SetWindowPos(HWND_TOP)` (`webview2/mod.rs:270`) e
  `set_bounds` passa `SWP_NOZORDER` (`:1456`). Il buco quindi c'è, e
  `browser_raise` lì oggi è un no-op che risponde Ok. Su WebKitGTK non è sondato
  (`GtkFixed.put` accoda, `webkitgtk/mod.rs:620`). I due motori sono aperti, con
  il loro task in tornata 2. Resta da non dimenticare di chiamare il comando
  quando nasce una vista nuova mentre la finestra è aperta.
