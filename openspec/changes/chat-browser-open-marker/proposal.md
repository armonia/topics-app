## Da decidere

Segno «browser aperto» nella chat: 4 scelte prima del codice.
1. Il segno resta sempre in vista, fuori dalla riga «N azioni» e dal riepilogo del turno finito, come un'immagine. Perché: negli ultimi 30 giorni 602 aperture su 624 finivano piegate dentro il turno, ed è proprio il «non si capisce che si è aperto» (o: resta dentro la piega, con icona e titolo suoi).
2. Niente fotogramma: favicon, titolo, dominio e stato (nella finestra / in una tab / chiuso). Perché: la finestrella viva è già a schermo accanto, e un'immagine per apertura costa una cattura e un file che la fase 5 di agent-inline-browser fa già (o: fotogramma fermo della pagina all'apertura, cliccabile).
3. Click su un segno la cui pagina è stata chiusa: la riapre nella finestrella della topic, sullo stesso contesto. Perché: il segno resta utile come storia e l'agente ritrova la pagina coi suoi `browser_*` (o: segno chiuso inerte, col solo link da copiare).
4. Più aperture sullo stesso contesto nello stesso turno fanno un segno solo, con l'ultima pagina e «3 pagine» apribile. Perché: 73 turni su 340 aprono 3 o più volte, e 92 aperture su 624 ricaricano l'URL appena aperto (o: un segno per apertura).

Compreso, senza scelta: change a sé e non dentro agent-inline-browser (quella non è approvata e la sua card in chat è già stata sostituita da browser-della-topic il 13/09); vale per `open_browser_pane` e `browser_open`, in chat e nella chat di un task (lì il segno sta nella riga di riepilogo dell'accordion); un'apertura fallita resta una riga di tool normale col suo errore; niente webview nel messaggio; le righe vecchie mostrano dominio e, se il risultato c'è, il titolo.
Col sì: il risultato di `open_browser_pane` porta anche il `contextId` (una decina di token), e `browser_focus_tab` dell'agente raggiunge finalmente la finestrella, dove oggi non fa niente.
Fuori: l'apertura automatica quando l'agente scrive `localhost:PORT` non ha un tool call dove mettere il segno (1 volta nel log dal 27/09).
«ok / ok ma 2 no»

---

# Il browser aperto dall'agente si vede nella chat, nel punto del turno in cui è successo

Richiesta di Attilio (29/09): «al momento esce pure la miniatura del browser, però
non c'è nessuna cosa a livello di interfaccia sulla chat del Topix che faccia capire
che in quel momento è stato aperto il browser.»

## Why

La «miniatura» è la finestrella della topic di `browser-della-topic` (approvata il
13/09): `TopicBrowserWindow` in stato `min`, che si accende da sola quando l'agente
apre un sito. Nel transcript, invece, di quell'apertura non resta quasi niente:

1. **La riga è quella generica di un MCP.** `open_browser_pane` e `browser_open`
   stanno in `TOPICS_BRIDGE_NAMES` / `TOPICS_BROWSER_NAMES`
   (`client/src/components/Chat/toolDetail.ts:42-57`) e diventano
   `{type:'mcp'}` (`toolDetail.ts:401-409`): icona `Sparkles`
   (`toolIcons.ts:23`), nome `topics · open_browser_pane`, sommario
   `url: http://…` (`toolDetail.ts:558-563`). Nessun titolo, nessun favicon, nessun
   modo di andare alla pagina.
2. **E quella riga non si vede.** Misura sul DB di produzione (sola lettura,
   30/08→29/09, colonna `blocks` decompressa): 624 aperture in 340 turni di 91
   sessioni (445 in chat normali, 179 in chat di task). 619 su 624 (99%) sono
   attaccate a un altro tool, quindi finiscono dentro la riga «N azioni» di
   `CHAT-TOOL-02` (`partitionToolGroup`, `toolGrouping.ts:39`); 602 su 624 (96%)
   stanno prima della risposta in un turno con ≥2 tool, quindi a turno finito
   finiscono anche dentro il riepilogo piegato (`foldFinishedTurn`,
   `turnFold.ts:52-83`). In media un turno che apre il browser ha 67,6 tool call.
3. **L'agente ha l'ordine di non dirlo.** Il prompt di sistema chiude con «Do not
   mention the tool to the user» (`server/context/assemble.ts:1161`): la prosa non
   lo racconta, e il tool call sepolto è l'unica traccia.
4. **Non si può tornare alla pagina dalla chat.** Il risultato del tool dice
   `Opened browser pane at <url> (title: <t>)` (`server/mcp/topics-mcp-server.ts:2693-2706`)
   ma non il `contextId`, che la rotta conosce (`server/routes/browser-bridge.ts:441-451`
   in chat, `task-<id8>-<seq>` nel ramo task) e non restituisce
   (`browser-open-pane-flow.ts:165-170`). Senza, il client non sa quale pagina
   focalizzare.
5. **La porta «focalizza questa pagina» non conosce la finestrella.** Né
   `openBrowserTab` (`client/src/lib/tabLink.ts:821-879`) né il gestore di
   `browser:focus-pane` (`client/src/hooks/usePanelLifecycle.ts:1853-1866`) guardano
   `topicBrowserWindow`: una pagina che vive nella finestrella risulta morta
   (`DEAD_TAB_MESSAGE`) e il `browser_focus_tab` dell'agente, che il risultato
   stesso gli consiglia quando la pagina non è a schermo (`topics-mcp-server.ts:2701`),
   lì non fa niente.

### Dove sta: change a sé, non dentro `agent-inline-browser`

`agent-inline-browser` (0/25, senza `.openspec.yaml`, mai approvata) aggiunge un
contesto headless nuovo (`surface:"inline"`, `agent-<topic8>-<seq>`), sospensione,
tetti, fotogrammi su disco, flag. La sua card in chat (fase 4) e le righe in sidebar
(fase 6) sono già marcate «sostituite da `browser-della-topic`» nel suo `tasks.md`.
Il segno chiesto qui serve **oggi**, sul percorso che esiste (pane e finestrella), e
non ha bisogno di niente di quella change. Metterlo lì lo legherebbe a un'approvazione
che non c'è e a un lavoro dieci volte più grande. La convergenza è garantita dalla
forma: il dettaglio tipizzato è lo stesso `{type:'browser', contextId, url, title}`
che `agent-inline-browser` prevedeva (`design.md` §«Superficie in chat»), quindi se
quella change arriva estende questo segno invece di farne un secondo.

### Lo standard

Chi ha un agente col browser fa vedere nel transcript *che* il browser è stato usato,
*dove* e *come tornarci*. Claude.ai / Claude Code con computer use e Claude for Chrome
mettono ogni azione in una riga, con lo screenshot quando c'è. ChatGPT agent (ex
Operator) mostra nella conversazione un riquadro del computer virtuale che si espande
e resta come traccia a fine lavoro. Cursor dice nella documentazione del suo browser
che l'agente «displays browser actions like screenshots and actions in the chat», con
il browser in una pane a parte (verificato su cursor.com/docs/agent/browser il 29/09;
le pagine di OpenAI rispondono 403 al fetch, quella descrizione viene da conoscenza
non riverificata). Gli elementi ricorrenti sono: favicon, titolo, URL, stato vivo o
finito, un clic che porta alla vista viva, e un'immagine solo dove non c'è già una
vista viva. Qui la vista viva c'è sempre (finestrella, tab o drawer del task), da cui
la scelta 2.

## What Changes

- **Server, risultato.** La rotta open-pane restituisce anche `contextId`
  (`browser-open-pane-flow.ts:165`), e il testo del tool lo riporta in coda:
  `Opened browser pane at <url> (title: <t>) [contextId: <id>]`. Il prefisso non
  cambia, quindi chi lo legge oggi (`pane-nav-outcome.ts`, i test) non si rompe.
  Stesso campo nel risultato di `browser_open` sul percorso SDK
  (`server/routes/chat.ts:2690-2704`).
- **Dettaglio tipizzato `browser`.** `deriveToolDetail` (server,
  `server/providers/claude/tool-detail.ts`, e il suo specchio client) trasforma
  `open_browser_pane` e `browser_open` riusciti in
  `{type:'browser', url, contextId?, title?, name?, visible?}`, leggendo `args.url`
  (presente in 624 su 624) e il risultato quando c'è (121 su 134 dal 20/09; prima
  quasi mai). `resolveToolDetail` rideriva le righe vecchie salvate come `mcp`, come
  già fa per gli step del goal (`toolDetail.ts:438-441`).
- **Il segno.** Una riga `BrowserOpenMarker`: favicon (`BrowserFavicon`), titolo (o
  il nome dato dall'agente, o il dominio), dominio, stato. Sta al suo posto nel turno
  e non entra mai nella riga «N azioni» né nel riepilogo del turno finito (come
  un'immagine, `turnFold.ts:81-82`). Aperture consecutive sullo stesso contesto nello
  stesso turno fanno un segno solo (scelta 4).
- **Il clic.** Un risolutore unico `focusBrowserContext` porta alla pagina dove vive:
  tab nel layout → focus; tab del task → apre il task; finestrella → la sveglia e
  attiva la scheda; da nessuna parte → la riapre nella finestrella della topic con lo
  stesso contesto (scelta 3). Lo stesso risolutore serve il `browser:focus-pane`
  dell'agente, per le pagine vive.
- **Chat di un task.** L'accordion di `CHAT-TOOL-06` ripiega messaggi interi e non
  riordina: lì i segni del tratto piegato stanno nella sua riga di riepilogo, come
  chip cliccabili.

## Non-Goals

- Webview, stream o fotogramma nel messaggio (scelta 2; la classe di bug
  `native-webview-occlusion` resta chiusa).
- Un segno per `browser_act` / `browser_observe` / le navigazioni fatte cliccando
  nella pagina: restano righe di tool come oggi.
- L'apertura automatica su `localhost:PORT` scritto in prosa
  (`server/routes/topics.ts:614-632`): non ha un tool call, e un blocco sintetico nel
  turno per 1 evento in tre giorni di log è fuori misura.
- Il contesto headless e la superficie `inline` di `agent-inline-browser`.
- Il terminale: una `open_browser_pane` da terminale non ha un transcript di chat.

## Impact

- Server: `server/routes/browser-open-pane-flow.ts`, `server/routes/browser-bridge.ts`
  (ramo chat e task passano il `contextId`), `server/mcp/topics-mcp-server.ts`
  (testo del risultato), `server/routes/chat.ts` (risultato `browser_open` SDK),
  `server/providers/claude/tool-detail.ts`.
- Shared: `shared/tool-call-detail.ts` (variante `browser` nello schema Zod).
- Client: `client/src/components/Chat/toolDetail.ts`, `toolIcons.ts`, `ToolCards.tsx`,
  `toolCardBody.ts`, `toolGrouping.ts`, `turnFold.ts`, `TaskWorkAccordion.tsx`,
  `client/src/components/MessageContent.tsx`; nuovo `BrowserOpenMarker.tsx` +
  `browserOpenMarker.ts` (puro); nuovo `client/src/lib/focusBrowserContext.ts`,
  usato anche da `usePanelLifecycle.ts:1853`. i18n in `i18n-chat-it.ts` /
  `i18n-chat-en.ts`.
- Spec: `chat` ADDED `CHAT-BROWSER-01..03`; `remote-browser` ADDED `BROWSER-CHAT-05`.
- Nessuna migration, nessun frame WS nuovo, nessun flag.
