# native-host-dom-sync — il Mac resta nativo, l'iPad riceve gli aggiornamenti del DOM

## Perché
Oggi, quando l'iPad guarda una pane browser, il Mac lascia la sua WKWebView e passa
al mirror del Chromium del server: ogni gesto fa il giro dal server, la pagina gira
due volte, e sul Mac si sente («lentissimo», 13/10). Attilio, 13/10: «non streaming
video, deve essere streaming degli aggiornamenti su browser nativo, performance top e
sincronizzazione cross device». Sostituisce la direzione WebRTC di
`browser-native-host-cobrowse`.

## Cosa cambia
- **Host = la pane nativa del Mac.** Quando un altro device guarda, il Mac NON cambia
  motore: inietta il registratore rrweb nella sua WKWebView (via `browser_eval_js`,
  niente build Tauri) e manda gli eventi DOM al server sul socket del delegato nativo.
- **Server = relay, non renderer.** Bufferizza meta/snapshot/incrementali come fa per
  Chromium, riscrive le risorse irraggiungibili (`dom-resource-rewrite`) e le serve
  anche senza contesto Chromium; inoltra agli spettatori come `dom_event`.
- **Spettatori = mirror nativo** (`DomCoBrowse`, già esistente). L'input
  (tap, testo, scroll) torna all'host e viene eseguito nella WKWebView.
- **Chromium del server = riserva**: solo quando nessun host nativo è vivo.

## Barra
`bun test server/lib/native-dom-host*.test.ts client/src/lib/nativeDomHost*.test.ts`
+ e2e `browser-native-host-sync` (host finto sul socket, spettatore web vero:
snapshot visibile, tap → input all'host una volta) + misura sul Mac vero: tap
sull'iPad → mutazione sul Mac < 150 ms, e il Mac non apre mai il socket condiviso.
Ciò che è verde resta verde (dom-cobrowse, tap-once, shared-auto).

## Fuori
Video/WebRTC; Windows/Linux host (solo macOS WKWebView ora); eventi trusted (l'input
iniettato è JS sintetico: basta per click/testo/scroll, non per drag nativo).

## Deciso da me
- Trasporto host→server in pull (`browser_eval_js` ogni 50 ms mentre la pagina si muove,
  200 ms da ferma, subito dopo un input) invece di un handler WebKit nuovo: zero Rust.
- Il registratore rrweb lo serve il server (`/api/browser/recorder.js`), non il bundle:
  il budget `total_assets` ha il 2% di margine e così host e replayer hanno la stessa versione.
- Host sparito: 8 s di grazia, poi il Chromium del server riparte dalla pagina dell'host.
- Sotto un host lo spettatore è sempre DOM (niente video, niente `<iframe>` proprio).
- Solo macOS: su WebView2/WebKitGTK `browser_eval_js` restituisce la stringa quotata.
