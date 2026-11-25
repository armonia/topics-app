# Remote browser — la ricerca nella pagina arriva da ovunque, e su una pane sola

## ADDED Requirements

### Requirement: BROWSER-FIND-02 — ⌘F e ⌘G arrivano alla barra anche dall'interno della pagina, e solo sulla pane a fuoco

Con il cursore dentro la pagina di una pane browser nativa, ⌘F, ⌘G e ⇧⌘G
SHALL arrivare al gestore dell'app (accordi inoltrati dalla shell:
`app_chord_dispatch_js` su Mac, `chords.rs` su Windows, tabella generata da
`shared/shortcuts.ts`).

Sul Mac NON SHALL arrivare alla pagina: il monitor NSEvent scarta l'evento
(`lib.rs:9014`). Su Windows il motore non lo permette: `SetHandled(true)` toglie
solo l'azione di WebView2, e la pagina riceve comunque il keydown
(`chords_win.rs:17-24`, `chords.rs:59-62`). Lì una pagina con una sua ricerca su
Ctrl+F (Google Docs) la apre insieme alla nostra barra, e la spec non promette
il contrario.

Aperta così, la barra SHALL prendere la tastiera del sistema (FIND-02,
`releaseNativeFocus`): le lettere scritte dopo ⌘F SHALL finire nel campo della
barra e non nella pagina.

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

#### Scenario: le lettere vanno nella barra (a mano, sull'app costruita, Mac e Windows)
- **GIVEN** una pane browser nativa con il cursore in un campo della pagina
- **WHEN** premo ⌘F (Ctrl+F su Windows) e scrivo «abc»
- **THEN** «abc» è nel campo della barra
- **AND** il campo della pagina non ha ricevuto «abc»

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

### Requirement: BROWSER-FIND-04 — Il browser condiviso si cerca nella copia della pagina; solo l'immagine non si cerca

La pane browser che arriva dal server (`RemoteBrowserPanelStreaming`) SHALL
registrare un cercatore. Vale sul client web, sul telefono e anche sulla pane
del Mac quando è fissata su «condivisa» o è in «auto» con un altro dispositivo
che la guarda (`RemoteBrowserPanel.tsx:211-218,236`).

Nel modo `dom`, che è il default (`hooks/useRemoteBrowser.ts:277-282`), il
cercatore SHALL cercare nel DOM ricostruito da rrweb nell'iframe dello stesso
dominio (`DomCoBrowse.tsx`) con `lib/domFind.ts`, senza chiedere niente al
server. SHALL evidenziare nel registro `CSS.highlights` del documento
dell'iframe e SHALL rifare la ricerca quando rrweb applica mutazioni, al più
ogni 120 ms.

Nel modo `video` ⌘F SHALL aprire la barra con il campo disattivo e la frase
«Qui la pagina è un'immagine: la ricerca non c'è» / «This page is an image
here: find isn't available». In nessuno dei due modi ⌘F SHALL aprire la
ricerca nei progetti.

#### Scenario: client web, modo dom
- **GIVEN** il client web con una pane browser condivisa a fuoco in modo `dom`, su una pagina che contiene «Prezzi» due volte
- **WHEN** premo ⌘F e cerco «prezzi»
- **THEN** il contatore dice «0 di 2», e dopo Invio «1 di 2» con la parola evidenziata nella pane

#### Scenario: modo video
- **GIVEN** una pane browser condivisa in modo `video`
- **WHEN** premo ⌘F
- **THEN** la barra è aperta, il campo è disattivo e dice che lì la ricerca non c'è
