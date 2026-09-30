# Design: chat-browser-open-marker

## 1. Da dove viene il `contextId`

Il segno deve sapere QUALE pagina focalizzare. Tre strade:

| Strada | Perché no / sì |
|---|---|
| Il client lo ricostruisce (`topic.browserState?.contextId ?? topic.id`, `server/browser-tool-dispatcher.ts:282`) | Vale solo nel ramo chat. Nel ramo task il contesto è `task-<id8>-<seq>`, con un `seq` che il client non conosce. |
| Mappa server `toolCallId → contextId` | La rotta open-pane non vede il `tool_use_id`: la chiamata MCP arriva col solo `sessionKey`. |
| **Il risultato lo dice** ✅ | La rotta lo conosce già in tutti e tre i rami; `openPaneFlow` lo aggiunge alla risposta; il testo del tool lo riporta in coda. Costo: ~10 token per apertura. Utile anche all'agente: `browser_*` e `close_browser_pane` accettano un `contextId`. |

Formato: `Opened browser pane at <url> (title: <t>) [contextId: <id>]` e, per il
ramo non visibile, lo stesso suffisso in coda alla frase esistente. Il prefisso resta
identico (`pane-nav-outcome.ts` e `topics-mcp-server.test.ts` lo leggono). Sul
percorso SDK il risultato di `browser_open` è già un oggetto JSON: si aggiunge la
chiave `contextId` (`server/routes/chat.ts:2690-2704`).

## 2. Il dettaglio `browser`

```ts
// shared/tool-call-detail.ts — variante nuova dello schema Zod
{ type: 'browser', url: string, contextId?: string, title?: string,
  name?: string, visible?: boolean, result?: string }
```

Lo producono `deriveToolDetail` server e client per `open_browser_pane`,
`mcp__topics__open_browser_pane` e `browser_open`, **solo se la chiamata è riuscita**.
Un'apertura in errore (77 su 624 negli ultimi 30 giorni) resta `mcp`: non si è aperto
niente, e il segno direbbe il falso. `url` viene da `args.url`; `title`, `contextId` e
`visible` dal risultato, con un parser puro e tollerante (assenti = assenti).
`resolveToolDetail` rideriva le righe salvate come `mcp` per quei nomi, come fa per gli
step del goal, così il segno compare anche nella storia già scritta.

Il nome e la forma sono quelli che `agent-inline-browser` aveva previsto per la sua
card (`{type:'browser', contextId, url, title}`): se quella change arriverà, estenderà
questa variante (passi, fotogramma) invece di affiancarne una seconda.

## 3. Dove sta nel turno

Il segno è una riga di tool con una resa sua, non un blocco nuovo del timeline: nessun
cambio di persistenza, di `blocks`, di frame WS.

- **Gruppi (`CHAT-TOOL-02`).** `partitionToolGroup` tratta una chiamata con dettaglio
  `browser` come i sub-agent: segmento a sé, mai nella riga «N azioni». Il gruppo si
  spezza attorno al segno; i conteggi del gruppo non lo contano.
- **Turno finito (`turnFold.ts`).** Come un'immagine: il segno esce dal `work` e va
  in `shown`, prima della risposta, nell'ordine in cui è comparso. Un turno che ha
  solo il segno e la risposta non si piega più per quella chiamata, perché i tool
  rimasti sono uno di meno (`FOLD_MIN_TOOLS`).
- **Chat di un task (`CHAT-TOOL-06`).** L'accordion ripiega messaggi interi e non
  deve riordinare. Lì il segno non esce: `summarizeTools` (`taskWorkFold.ts:115`)
  raccoglie i segni del tratto e la riga di riepilogo li mostra come chip (favicon +
  titolo, stesso clic). Dentro l'accordion aperto il segno è la riga normale.
- **Coalescenza (scelta 4).** Dentro UN messaggio, aperture successive con lo stesso
  `contextId` (o, senza `contextId`, lo stesso contesto implicito della topic)
  diventano un segno solo, alla posizione della prima, che mostra l'ultima pagina e
  «N pagine». Aperto, elenca le pagine in ordine (titolo o dominio, ora). Due
  contesti diversi restano due segni. È una funzione pura su `ToolCall[]`
  (`browserOpenMarker.ts`), testata da sola.

## 4. Il clic: `focusBrowserContext`

Un solo risolutore, puro nella decisione e con gli effetti iniettati, perché oggi
«porta a questa pagina» è sparso in `tabLink.openBrowserTab`, nel gestore di
`browser:focus-pane` e nella porta della finestrella, e nessuno dei primi due conosce
la finestrella.

Ordine, primo che risponde vince:

1. **Tab nel layout** (pane-store o layout di progetto): `openTabInApp({kind:'browser', key: contextId})`,
   la strada che `tabLink` fa già.
2. **Tab di un task** (`contextId` presente in `taskBrowserTabs`): apre il task
   (`openTaskInApp`), come `tabLink.ts:873-877`.
3. **Finestrella della topic**: `openInTopicWindow(topicId, {contextId, url, openedBy:'user'})`.
   Su una scheda esistente `open` la attiva e sveglia la finestra (`hidden → min`,
   `topicBrowserWindow.ts:114-131`); su una scheda chiusa la riaggiunge (scelta 3).
4. **Nessuna finestrella possibile** (sotto 768 px, chat dentro una finestra di
   progetto): la porta rifiuta e si ricade su `openLink`, cioè una tab come oggi.

Il gestore di `browser:focus-pane` usa gli stessi passi 1-3 **senza riaprire**: un
`browser_focus_tab` su una pagina chiusa non deve far nascere niente.

Il segno sceglie la topic dalla chat che lo disegna, non dal risultato: una riga di un
fork o di una chat condivisa porta alla finestrella della chat che si sta guardando.

## 5. Stato del segno

Derivato, mai salvato:

| Stato | Quando | Etichetta it / en |
|---|---|---|
| `window` | il `contextId` è una scheda della finestrella di questa topic | «nella finestra» / «in the window» |
| `tab` | è una pane nel layout, o `promoted` della finestrella, o tab di un task | «in una tab» / «in a tab» |
| `closed` | nessuna delle due | «chiuso» / «closed» |
| `offscreen` | il risultato diceva `visible:false` e non è in nessuna superficie | «non a schermo» / «not on screen» |

Lo store della finestrella è un chunk pigro (`check:bundle`): il segno lo legge
attraverso `topicBrowserWindowLazy` (come `useTopicBrowserPresence`), mai con un
import diretto nel chunk della chat.

## 6. Resa

Una riga alta come quella di un tool, allineata alle altre: icona `Globe` al posto
del favicon finché non carica, titolo (nome dato dall'agente › titolo pagina ›
dominio), dominio in grigio, stato come testo piccolo, freccia «vai». Tutta la riga è
il bersaglio del clic (≥ 44 px di altezza su touch). Tooltip e `aria-label` con
l'URL intero. Nessuna immagine della pagina (scelta 2). Testi via i18n (`chat.browserMarker.*`).

## Dove cambiarla

| # | Dove cambiarla |
|---|----------------|
| 1 | `CHAT-BROWSER-01` (scenari «fuori dalla riga N azioni», «fuori dal riepilogo»); design §3 |
| 2 | `CHAT-BROWSER-01` (contenuto della riga); design §6 |
| 3 | `CHAT-BROWSER-02` (scenario «pagina chiusa»); design §4 passo 3 |
| 4 | `CHAT-BROWSER-01` (scenario «tre aperture»); design §3 «Coalescenza» |
