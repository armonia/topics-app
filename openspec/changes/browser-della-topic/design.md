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

Due strade, e la scelta si misura nella tornata 1 invece di indovinarla:

- **Dal vivo:** `browser_set_bounds` a ogni `pointermove` in rAF. Regge se la
  vista resta entro un frame dal cursore sul Mac di sviluppo.
- **Fermo immagine:** all'inizio del trascinamento si emette
  `topics:pane-resize-start`, il cancello di `nativeViewDragGate.ts:52` fa
  `freeze()` (screenshot come `<img>`, vista parcheggiata), e a `-end` la vista
  riappare nella posizione nuova. È il percorso che le pane usano già.

Il criterio è scritto nel task, con la misura come prova. Il ridimensionamento
del bordo in stato espanso segue la stessa scelta.

### Due viste native una sopra l'altra

Una finestrella minimizzata sopra una pane browser nel layout sovrappone due
WKWebView. L'ordine z delle viste figlie non è oggi governato da nessuno.
Tornata 1: verificare cosa succede e, se serve, alzare la vista della finestra
all'apertura e a ogni cambio di stato (lato Rust, accanto a
`browser_set_bounds`, `lib.rs:5196`).

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
| 6 | Un download che parte… (in attesa del sì, aggiunta dopo l'approvazione) | accende una spia nella tab | apre da sé il foglio sui Download, congelando la pagina | `BROWSER-CHAT-02` |

## Rischi

- **Memoria.** Una pagina viva in ogni finestrella minimizzata è una WebContent
  in più per topic aperta. Il tetto di residenza delle pane
  (`index_perf-delle-pane`) si applica anche alle schede della finestra: una
  topic non a fuoco parcheggia la sua vista.
- **Trascinamento dal vivo che non regge.** Coperto dal fermo immagine, che è
  il percorso già in uso.
- **Ordine z fra due WKWebView.** Non verificato: è il primo task.
