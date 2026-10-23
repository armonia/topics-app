# D4h — B9: il componente dell'elemento scelto e `browser_verify`

**Barra prima:** `./scripts/qa-gate.sh --veloce` 22/25, rossi `check:ui-language`,
`check:identifier-language`, `check:untraced-tests`; nessun campo `component`, nessuno strumento
di verifica.
**Barra dopo:** `./scripts/qa-gate.sh --veloce` 25/25; i quattro file di test mirati 61/61, ognuno
verde anche da solo; `bun run typecheck:e2e` exit 0; `bun run check:spec-coverage` 0 scoperti.
Cinque mutanti rossi (sotto). E2E e video in CI.

## Fatto

- Sonda dell'elemento (`shared/element-describe.ts`): campo `component` per React 18
  (`_debugSource`), React 19 (primo frame utile di `_debugStack`, formato V8 e WebKit, query `?t=` di
  Vite tolta), Vue 3 e Svelte (nome dal file quando c'è solo `loc`). File e riga vengono dalla fiber
  dell'elemento scelto, cioè dove è scritto quel markup, non dal punto in cui il componente è usato.
  Al massimo 200 fiber e 5 owner; senza metadati il campo manca.
- In chat: `- componente: PriceCard (src/cards/PriceCard.tsx:42), dentro Pricing › App`.
- `browser_verify`, via MCP e bridge REST: ricarica o naviga, aspetta il `load` (fogli di stile
  esterni compresi) per al massimo 15 s, poi salva lo screenshot su file e riporta errori di console
  e richieste fallite di quel caricamento, più l'esito di ogni check con il valore letto.
- Pane nativa: un segno nel documento prima della ricarica, poi l'attesa di un documento senza il
  segno e `complete`. Lo screenshot lo fa il dispatcher: all'agente arrivano formato, percorso e
  byte, mai base64.
- e2e `tests/e2e/browser-verify.spec.ts`: il colore sta in un `/style.css` esterno; il check sul
  colore nuovo passa, quello sul vecchio fallisce riportando il valore trovato.

## In revisione

- Sulla pane nativa lo screenshot non arrivava mai: il dispatcher leggeva `.result` da un risultato
  che `delegateOp` ha già aperto. Il test simulava una busta in più; ora segue il protocollo vero.
- Con `url`, `navigate()` si ferma a `domcontentloaded`: ora si aspetta anche il `load`, come nella
  ricarica, dentro gli stessi 15 s.
- Il filtro dei frame di React scartava ogni percorso con «react» dentro, per esempio
  `src/providers/ReactQueryProvider.tsx`: ora scarta `node_modules`, `.vite/deps` e i file di React
  stesso (`react.*`, `react-dom.*`, `react_*`).
- `server/browser-verify.test.ts` lasciava `document` fra i globali: rosso da solo per il controllo
  del preload, nascosto quando girava insieme ad altri file.
- Mutanti, in una copia: sorgente letta dalla fiber del componente, `domcontentloaded` nella
  ricarica, `url` senza attesa del `load`, dispatcher che legge `.result`, filtro di React non
  ancorato. Rossi tutti e cinque, ognuno sul suo test.

## Trovato e non fatto

- WKWebView non espone le richieste fallite con i comandi di oggi: sulla pane nativa
  `failedRequests` è vuoto e il risultato lo dice (`requestCapture`). Serve un ponte di eventi nel
  guscio Tauri.
- Un componente avvolto in `forwardRef` ha per tipo un oggetto, non una funzione: resta senza nome e
  il nome passa al primo antenato che ne ha uno.

## Rifiutato

- Dare un nome a un elemento di una pagina che non espone metadati: il campo manca, la sonda non
  inventa.
