# Remote browser — la ricerca nella pagina arriva da ovunque, e su una pane sola

## ADDED Requirements

### Requirement: BROWSER-FIND-02 — ⌘F e ⌘G arrivano alla barra anche dall'interno della pagina, e solo sulla pane a fuoco

Con il cursore dentro la pagina di una pane browser nativa, ⌘F, ⌘G e ⇧⌘G
SHALL arrivare al gestore dell'app (accordi inoltrati dalla shell:
`app_chord_dispatch_js` su Mac, `chords.rs` su Windows, tabella generata da
`shared/shortcuts.ts`) e NON SHALL arrivare alla pagina.

⌘F SHALL aprire la barra della sola pane a fuoco (FIND-02). Il listener di
tasti di `TauriBrowserPanelInner` NON SHALL più aprire la barra: oggi la apre
in ogni pane browser montata, perché non guarda il fuoco.

Il motore SHALL restare quello di BROWSER-FIND-01: `window.find` via
`browser_exec_js` e il conteggio su `innerText` via `browser_eval_js`
(`useTauriBrowser.ts:1716-1751`).

#### Scenario: due browser aperti
- **GIVEN** due pane browser montate, la seconda a fuoco
- **WHEN** premo ⌘F
- **THEN** solo la seconda ha la barra aperta

#### Scenario: accordo inoltrato (test Rust)
- **WHEN** `app_chord_dispatch_js(cmd=true, ctrl=false, shift=false, alt=false, "f", 3)`
- **THEN** il risultato è `Some(..)` con `key:'f'` e `metaKey:true`
- **AND** `decide` di `chords.rs` su Ctrl+F è `Forward { swallow: true, .. }`

### Requirement: BROWSER-FIND-03 — Su Windows c'è una barra sola, la nostra

Su Windows, con il cursore in una pane browser, Ctrl+F SHALL aprire la nostra
barra e NON SHALL aprire la barra di ricerca di WebView2 (l'accordo inoltrato è
`SetHandled(true)`, `chords_win.rs`). Con il cursore nell'interfaccia dell'app,
Ctrl+F NON SHALL aprire la barra di WebView2 sopra l'interfaccia.

#### Scenario: Ctrl+F nella pagina su Windows (a mano, sull'app costruita)
- **GIVEN** l'app su Windows con una pane browser su una pagina con testo, cursore nella pagina
- **WHEN** premo Ctrl+F
- **THEN** si apre la nostra barra sopra la pane
- **AND** la barra di WebView2 non compare

### Requirement: BROWSER-FIND-04 — Nella pane condivisa la barra dice che lì la ricerca non c'è

Nella pane browser che arriva dal server (`RemoteBrowserPanelStreaming`:
immagine, mirror o riquadro ospitato), ⌘F SHALL aprire la barra con il campo
disattivo e la frase «La ricerca nella pagina qui non c'è ancora» / «Find in
page isn't available here yet». NON SHALL aprire la ricerca nei progetti.

#### Scenario: client web
- **GIVEN** il client web con una pane browser condivisa a fuoco
- **WHEN** premo ⌘F
- **THEN** la barra è aperta, il campo è disattivo e dice che lì la ricerca non c'è ancora
