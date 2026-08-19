# Engine alternativi per la pane browser — misure, non claim

**Domanda:** esiste un motore più leggero di Chromium (tipo Obscura) che regga la pane
browser di Topics senza perdere niente?

**Env:** macOS 26.2, Apple Silicon (M2 Pro, 12 core, 32 GB), Node v25.9.0.
Contendenti: `chrome-headless-shell` 148 (build Playwright 1223, il riferimento — è
l'engine che Topics già usa in modalità web), **Obscura 0.2.0** (Rust, V8, motore di
render proprio), **Lightpanda** 1.0-nightly.8737 (Zig, V8, **nessun render**).
Riproduci con gli script in questa cartella; righe grezze in `results.jsonl` /
`interact.jsonl`. Tutti e tre parlano CDP, quindi il banco è lo stesso codice per tutti.

## Il quadro

| | headless-shell | Obscura 0.2 | Lightpanda |
|---|---|---|---|
| binario su disco | 190 MB | **79 MB** | 73 MB |
| processi | 4-5 | **1** | **1** |
| startup→CDP | 1.9 s | 1.7 s | **1.2 s** |
| RSS idle | 241 MB | **20 MB** | **21 MB** |
| RSS Wikipedia | 444 MB | **176 MB** | **57 MB** |
| RSS react.dev | 419 MB | 246 MB | **101 MB** |
| screenshot | ✅ 16-25 ms | ✅ 18-780 ms | ❌ non supportato |
| screencast fps (app animata) | **92 fps** / 2.7 MB/s | 20 fps / 1.1 MB/s | ❌ `UnknownMethod` |
| click per coordinate | ✅ | ✅ | ✅ |
| digitazione (`char`) | ✅ | ✅ | ❌ (serve `keyDown`+text) |
| `Input.insertText` | ✅ | ❌ | ✅ |
| canvas 2D dipinto | ✅ 1493 px | ❌ **0 px** | ❌ 0 px |
| `getComputedStyle` grid | `grid` | `grid` | **`block`** |

### Il costo marginale, che è la metrica che conta davvero

Topics non lancia un browser per pane: lancia **un** Chromium e apre N context
(`server/browser-service.ts`). Quindi il numero da guardare non è l'idle, è quanto costa
la pane numero N. Misurato con 8 context nello stesso processo (`contexts.mjs`):

| | base | +8 context vuoti | +8 su Wikipedia | **MB per pane** |
|---|---|---|---|---|
| headless-shell | 243 MB | 794 MB | 1576 MB | **166 MB** |
| Obscura | 21 MB | 22 MB | 255 MB | **29 MB** |
| Lightpanda | 23 MB | ❌ `TargetAlreadyLoaded` — **un solo target per processo** | | (n/a) |

Obscura è **5.7× più economico per pane**, e a context vuoti costa *zero* (0.1 MB/pane
contro 69). Lightpanda non ha context multipli: scala solo a processi, 53 MB l'uno.

### Come sta OGGI il browser di Topics — misurato sull'app viva, non stimato

Le righe sopra usano `chrome-headless-shell`, che è il *migliore* dei Chromium. Topics in
esecuzione ne usa un altro: il **full build** di Playwright (`chromium-1217`), perché il
sidecar deve poter caricare le estensioni dell'utente (qui ne trova 42) e headless-shell
non ha un runtime WebExtensions. Misurato aprendo sei pane vere via
`POST /api/browsers/:id/agent/open` sul server live (porta 3333, **https**), tutte su
Wikipedia:

| pane | RAM Chromium totale | processi | apertura |
|---|---|---|---|
| 1 | 685 MB | 8 | (cold start) |
| 2 | 916 MB | 9 | 1515 ms |
| 3 | 1132 MB | 10 | 1574 ms |
| 4 | 1348 MB | 11 | 1252 ms |
| 5 | 1564 MB | 12 | 1349 ms |
| 6 | 1781 MB | 13 | 1414 ms |

**219 MB per pane**, lineare e senza sorprese, più 685 MB di prezzo d'ingresso per il
primo. Sei pane aperte sono 1.8 GB. È il numero da battere, e va confrontato con i 29 MB
per context di Obscura: **7.5×**, non 5.7×, perché il riferimento reale è il full build.

**Due cose funzionano già bene e vanno dette:**
- **Costo a riposo: zero.** Con nessuna pane aperta non c'è nessun processo Chromium.
  Il lifecycle è ref-counted con idle-reap (`browser-chromium-sidecar.ts`): chiuse le sei
  pane di prova, dopo 45 secondi i 13 processi erano **0**. Il costo si paga solo mentre
  guardi qualcosa.
- **La pane che l'utente vede di solito non è questa.** Il default è la `WKWebView`
  nativa dentro Tauri, zero processi extra; il WebContent dell'app misurato ora è 165 MB
  e regge tutta la UI. Chromium entra in scena solo quando serve un motore pilotabile
  server-side o le estensioni.

Il punto quindi non è "Topics è pesante": a riposo non costa nulla e la superficie
normale è nativa. Il punto è che **quando l'agente apre contesti, ognuno costa 219 MB** —
ed è esattamente lo scenario che `agent-inline-browser` moltiplica.

### E se la sessione dovesse stare in 50 MB? — WKWebView misurata (`wkbench.swift`)

L'obiettivo dichiarato ("una sessione browser dovrebbe stare in ~50 MB") non è un sogno,
ma **non lo raggiunge nessun Chromium**. Lo raggiunge WebKit, che è il motore che Topics
già usa per la pane nativa. Misurato con un binario Swift che apre N `WKWebView` vere
nello stesso processo e attribuisce i processi WebKit per diff di pid (i figli XPC sono
reparented a launchd, quindi il ppid non serve): `swiftc -O wkbench.swift -o wkbench`.

| sito | 1 sessione | 8 sessioni | 16 sessioni | **marginale** |
|---|---|---|---|---|
| app dev locale (`app/index.html`) | 99 MB | 318 MB | 590 MB | **37 MB** |
| example.com | 85 MB | 254 MB | — | **32 MB** |
| Wikipedia | 176 MB | 625 MB | — | **78 MB** |
| react.dev (SPA) | 172 MB | 825 MB | 731 MB | **46 MB** |

**Sì, 50 MB è possibile — con WebKit, e su pagine normali.** Il costo marginale reale è
**32-46 MB** su app dev, example.com e react.dev; sale a 78 MB solo su Wikipedia, che è
una pagina enorme. Il primo carico paga ~60 MB di processi condivisi (Networking + GPU)
che poi non si ripagano più: da qui il crollo da 99 MB (una) a 37 MB (marginale).

Confronto diretto, **stesso sito, stesso momento**:

| per sessione | WKWebView | headless-shell | Obscura |
|---|---|---|---|
| react.dev ×8 | **46 MB** | 140 MB | 9 MB |
| app dev locale ×8 | **37 MB** | 95 MB | 2 MB |

Due cose che questo tavolo dice e le tabelle precedenti no:
- **WKWebView è 3× più leggera di headless-shell** sullo stesso contenuto, ed è già
  dentro Topics. Il target 50 MB è raggiunto *oggi* dal motore che l'app usa di default.
- **Obscura scende a 2-9 MB per sessione** perché non ha processi separati né
  compositor: tutto in un processo, un heap V8 per contesto. È un ordine di grandezza
  sotto tutti, e conferma che i 29 MB della tabella Wikipedia erano il *caso peggiore*.
- **`WKProcessPool` è deprecato dal 2012**: il compilatore avvisa che istanze multiple
  "no longer have any effect". La leva §1.4 del catalogo performance
  (`server/browser-pane-performance-catalog.md`) va riscritta: WebKit decide da sé come
  condividere i processi, e lo fa già bene (18 processi per 16 webview, non 16 alberi).
  Anche `dataStore` isolato per sessione costa uguale a condiviso (37 vs 37 MB): l'
  isolamento non è la voce di costo.

### Servo 0.4.0 — l'unico vero candidato Rust, misurato (non dal blog)

Domanda naturale: se non Obscura, c'è qualcosa di serio in Rust/C++? Ho scaricato la
release macOS del 4 agosto 2026 (`servo-aarch64-apple-darwin.dmg`, 110 MB, app 269 MB) e
l'ho passata allo stesso banco. **È il candidato più forte fra tutti gli alternativi**, e
per una ragione che nessuna tabella di RAM cattura: è l'unico che *renderizza davvero*.

Test mirato (`app2/index.html`, artefatti in `feat/`): cinque bande di colore piatto, una
per feature, campionate a quattro punti orizzontali. Se la feature funziona il colore
atteso c'è; se il layout collassa a `block`, le quattro colonne diventano una.

| feature | Chrome | **Servo** (`--enable-experimental-web-platform-features`) | Servo (default) | Obscura |
|---|---|---|---|---|
| canvas 2D | ✅ `#ff0000` | ✅ `#ff0000` | ✅ `#ff0000` | ❌ bianco |
| CSS grid 4 col | ✅ | ✅ | ❌ collassa | ❌ |
| flexbox | ✅ | ✅ | ✅ | ❌ |
| gradient | ✅ | ✅ | ✅ | ❌ |
| SVG | ✅ | ✅ | ✅ | ❌ |

**Servo con il flag sperimentale passa tutto, identico a Chrome.** Obscura fallisce
quattro prove su cinque su un test che è colore piatto, cioè il caso più facile
possibile. Il grid in Servo è dietro flag ma **funziona**: `-Z layout_grid_enabled` non
esiste più (l'help lo elenca ma il parser lo rifiuta), la leva giusta è
`--enable-experimental-web-platform-features`.

Su Wikipedia, Servo produce **11 173 colori distinti contro gli 11 359 di Chrome**
(Obscura: 6 309) — cioè disegna praticamente tutto, font antialiasing compreso.
Screenshot in 2-3 secondi, `-o out.png -x` da riga di comando, senza CDP.

**E allora perché non è la risposta?** Tre motivi misurati:

1. **Costa più di Chromium, non meno.** 8 processi Servo su Wikipedia: 1785 MB, cioè
   **223 MB per sessione** — contro i 219 del Chromium di Topics e i 78 di WKWebView.
   Su app locale: 110 MB per sessione. Servo **non ha context multipli**: un processo per
   sessione, punto. Il risparmio non esiste.
2. **Le SPA moderne crashano.** `react.dev` restituisce una **pagina bianca**: un solo
   colore in tutto il PNG, ink 0.000. La causa è precisa e nei log:
   `ReferenceError: IntersectionObserver is not defined` → Next.js va in
   "client-side exception". Per Topics, che guarda soprattutto dev server React/Vue/Next,
   è il caso d'uso centrale che si rompe.
3. **Non parla CDP.** La porta `--devtools` risponde con l'handshake del **Firefox Remote
   Debugging Protocol** (`{"from":"root","applicationType":"browser"...}`), non con
   `/json/version`. Tutti i `browser_*` di Topics sono scritti su CDP: adottare Servo
   significa riscrivere il transport, non cambiare un endpoint.

## Obscura al microscopio — cosa si rompe DAVVERO (`vs/`)

"9.3% di diff su Hacker News" non dice cosa vedresti. Questa sezione lo isola:
tre pagine costruite apposta, ogni feature una banda di colore piatto, campionata a
coordinate fisse. Pannello unico: **`vs/OBSCURA-vs-CHROME.png`**.

### Il layout è giusto. È il *disegno* che perde pezzi.

Su undici box misurati con `getBoundingClientRect` (`css/index.html`), Chrome e Obscura
danno **numeri identici al pixel** — stesse x, y, larghezze, altezze, incluso
`transform: scale(.5)` che sposta il box a (30, 293) in entrambi. Questo spiega il
paradosso di Hacker News: là il layout sbagliava perché sono tabelle annidate del 1996,
non perché Obscura non sappia fare layout.

| effetto CSS | Chrome | Obscura | |
|---|---|---|---|
| box-shadow (alone 20px) | `#ff0000` | `#ff0000` | ✅ |
| border-radius | angolo tagliato | angolo tagliato | ✅ |
| transform scale | box a (30,293) | box a (30,293) | ✅ |
| gradient lineare | `#7f0081` | `#7e0081` | ✅ (1 su 255) |
| flex gap | spazio corretto | spazio corretto | ✅ |
| z-index / overlay | `#008000` | `#008000` | ✅ |
| opacity .5 | `#7f7fff` | `#8080ff` | ✅ (arrotondamento) |
| **`filter: grayscale(1)`** | `#b6b6b6` | **`#00ff00`** | ❌ **ignorato** |

Un solo vero buco: **le `filter` CSS non vengono applicate**. Il verde resta verde. Ogni
`blur`, `grayscale`, `drop-shadow` viene disegnato come se il filtro non ci fosse.

### Il canvas: metà funziona, e la metà che manca è quella dei grafici

Qui la prima misura ("canvas nero") era **troppo severa**. Il canvas si dipinge; a
mancare sono due primitive precise (`canvas/index.html`, verificato sia con
`getImageData` *dentro* la pagina sia sui pixel dello screenshot — concordano):

| primitiva | Chrome | Obscura | |
|---|---|---|---|
| `fillRect` | `#ff0000` | `#ff0000` | ✅ |
| `strokeRect` | `#00ff00` | `#00ff00` | ✅ |
| `arc` + `fill` | `#ff00ff` | `#ff00ff` | ✅ |
| `fillText` | disegnato | disegnato | ✅ |
| **`beginPath` + `lineTo` + `stroke`** | `#0000ff` | **bianco** | ❌ **perso** |
| **`createLinearGradient`** | `#80ff7e` | **bianco** | ❌ **perso** |

Il grafico della pagina di prova lo mostra bene: le **barre rosse ci sono**
(`fillRect`, 1200 px esatti in entrambi), la **linea azzurra no** (`#38bdf8`: 639 px in
Chrome, **0** in Obscura). Cioè: rettangoli e cerchi sì, **tracciati e sfumature no**.
Tradotto: un grafico a barre passa, una sparkline o un line-chart resta vuoto — ed è
proprio la forma che ha il 90% dei grafici in una dashboard.

### Le abbiamo aggiustate — patch scritta, compilata e misurata

Le due primitive canvas mancanti **non erano un limite architetturale**: erano codice non
ancora scritto, in **JavaScript**, non in Rust. Il canvas 2D di Obscura vive in
`crates/obscura-js/js/bootstrap.js`, e là dentro `stroke()` era letteralmente
`stroke() {}` — un metodo vuoto — mentre `createLinearGradient` restituiva un oggetto il
cui `addColorStop(){}` **buttava via i colori**.

Patch in `obscura-canvas-fix.patch` (143 righe aggiunte, un file, zero Rust toccato):

| | prima | dopo |
|---|---|---|
| `stroke()` | `{}` vuoto | Bresenham per segmento, `lineWidth` rispettato, archi tracciati come cerchi |
| `createLinearGradient` / `Radial` | stop scartati | stop conservati, interpolati per pixel |
| `fill()` su path M/L | solo archi | scanline even-odd: i poligoni si riempiono |
| `closePath()` | `{}` vuoto | registra il segmento di chiusura |
| `fillRect` / `strokeRect` | solo tinta unita | accettano anche un gradiente |

Il tutto passa da un `_resolvePaint(style)` che torna `{ at(x,y) -> [r,g,b,a] }`: una
tinta unita risolve una volta, un gradiente interpola. Così ogni primitiva guadagna il
supporto ai gradienti senza duplicare codice.

**La prova, non il racconto.** Una dashboard con line chart, area, assi, barre con
gradiente e punti (`chart/index.html`), stesso viewport, tre motori:

| | ink (frazione dipinta) | colori distinti | diff vs Chrome |
|---|---|---|---|
| Chrome | 0.327 | 773 | — |
| **Obscura prima** | **0.003** | **2** | **32.35%** |
| **Obscura dopo** | **0.321** | **150** | **1.16%** |

Il grafico era **una pagina bianca con due colori**. Dopo la patch è indistinguibile da
Chrome all'1.16%. Le sonde `getImageData` dentro la pagina lo confermano punto per punto:

| sonda | Chrome | prima | dopo |
|---|---|---|---|
| linea del grafico | `#1e40af` | `#1e40af` | `#1e40af` |
| area sotto la linea | `#c8d8fa` | **bianco** | `#c8d8fa` ✅ |
| asse | `#c9d1db` | **bianco** | `#94a3b8` ✅ |
| barra col gradiente | `#f5465c` | **bianco** | `#f4465b` ✅ |

**Zero regressioni**, verificate su due fronti: le primitive che già andavano
(`fillRect`, `strokeRect`, `arc`, `fillText`) danno gli stessi valori di prima, e
Hacker News / Wikipedia / GitHub caricano con lo stesso identico conteggio di nodi DOM
(818 / 4103 / 1544). `canvas-proof.mjs` prova la logica isolata in 14 asserzioni senza
compilare nulla (~200 ms); `chart-test.mjs` fa il giro completo su un binario vero.

Build: `cargo build --release -p obscura-cli --bins --features render`, ~17 minuti (V8
compila da sorgente la prima volta), binario da 89 MB.

**Cosa resta rotto:** le `filter` CSS. Quelle **non** sono in JavaScript, stanno nel
motore di paint in Rust (`crates/obscura-render/src/paint.rs`, 17k righe) e richiedono
un passo di post-processing sul buffer del layer — lavoro vero, non un metodo vuoto da
riempire. `stroke` e i gradienti erano il frutto basso, ed era davvero basso.

### Perché è così leggero (e perché il prezzo è coerente)

Non è magia né un trucco di misura. Obscura fa tre rinunce strutturali:
- **Un processo solo, zero sandbox.** Chromium ne apre 8-13 (renderer per origine, GPU,
  network, utility): è il prezzo dell'isolamento di sicurezza. Obscura mette tutto in un
  processo, con un heap V8 per contesto — da qui i **2-9 MB per sessione** contro i 219.
- **Nessun compositor GPU.** Niente layer, niente tile, niente texture: disegna a CPU con
  `tiny_skia`. Da qui i **20 fps di screencast** contro 92, e i **780 ms** per uno
  screenshot di Wikipedia contro 25.
- **Un motore di rendering giovane, scritto da zero.** `filter`, `stroke` di path e i
  gradienti canvas semplicemente **non sono ancora implementati**. Non è un bug: è
  superficie non ancora coperta, dichiarata nel loro README ("long-tail CSS, some Web
  APIs... may differ from Chromium").

Il 30x di risparmio e i buchi sono **la stessa scelta vista da due lati**. Il che rende
la valutazione facile: dove quelle tre cose non servono, Obscura è un affare enorme.

## Possiamo usarlo, o serve un progetto nostro?

La domanda naturale dopo una patch che funziona. Risposta breve: **usarlo, contribuendo
upstream. Un motore nostro non ha senso, e nemmeno un fork.**

### Cosa dice la licenza (il vincolo che decide tutto)

**Apache-2.0**, dichiarata sia in `LICENSE` che in `Cargo.toml`. Topics è MIT: sono
compatibili, si può incorporare, ridistribuire, modificare e vendere. Apache-2.0 dà
anche una **concessione esplicita di brevetto**, che MIT non ha — per un motore di
rendering è una tutela in più, non in meno.
**Nessun CLA**: `CONTRIBUTING.md` dice solo "contribuendo accetti Apache-2.0". Non c'è
cessione di copyright a un'azienda, quindi nessuno può ritirare da sotto i piedi il
lavoro già pubblicato. E **zero dipendenze GPL** in `Cargo.lock` (468 crate).

### Come sta il progetto — i numeri, non le stelle

| | |
|---|---|
| stelle / fork | 21 688 / 1 568 |
| contributori | 49 |
| **commit del contributore principale** | **75%** (676 su 902) |
| PR esterne mergiate (ultimi 40 chiusi) | **85%** |
| **mediana tempo di merge** | **4.9 ore** |
| ritmo | 17 commit il giorno stesso di questa analisi |
| **età del progetto** | **4 mesi** (creato 2026-04-13) |

I due numeri buoni sono quelli che contano per noi: **accettano contributi esterni e li
mergiano in ore**, non mesi. Nella lista dei PR chiusi ci sono nomi esterni (`aech`,
`xrip`, `lisa0314`, `marcoripa96`) con fix di sostanza — cioè la strada per cui abbiamo
appena scritto una patch è una strada battuta, non una speranza.

### I tre rischi veri (nominati, non generici)

1. **Bus factor 1.** Una persona firma il 75% dei commit. Se sparisce, il ritmo crolla.
   Mitigazione reale: Apache-2.0 + niente CLA significa che **il fork resta sempre
   possibile**, e il codice che ci serve è già sul nostro disco.
2. **Quattro mesi di vita.** Non ha ancora attraversato un ciclo di manutenzione lungo.
   L'`innerText` da 1.3 MB e le `filter` mancanti sono sintomi di questo, non anomalie.
3. **Obscura Cloud in arrivo.** Il README annuncia una versione hosted a pagamento. È il
   classico bivio open-core: oggi promettono "no feature gating, ever", ma la promessa
   non è nella licenza. **Mitigazione: la Apache-2.0 già concessa è irrevocabile** — al
   massimo cambierebbe il futuro, mai la versione che abbiamo.

### Perché NON scriverne uno nostro

Obscura è **138 000 righe di Rust** (di cui 67 000 solo di motore di rendering) più V8.
Scrivere un motore che disegna CSS moderno è il lavoro di Ladybird, che dopo anni è
ancora pre-alpha e ha appena **chiuso i contributi pubblici** per arrivare a una prima
release. Non è un progetto che si affianca a Topics: è un progetto che *sostituisce*
Topics.

E il fork non conviene per un motivo aritmetico: la patch che ha chiuso due buchi è
**143 righe su un file di JavaScript**. Mantenere un fork di 138k righe per portarsi
dietro 143 righe è il rapporto peggiore possibile. Upstream le stesse 143 righe le fa
mantenere a loro.

### La strategia che regge

**Usare Obscura come dipendenza binaria, non come sorgente.** Concretamente:
- il binario è **un singolo eseguibile** che parla CDP su una porta — la stessa
  interfaccia che Topics già usa per Chromium. Sostituirlo non tocca i `browser_*`;
- le nostre fix vanno **upstream** (85% di PR accettate, 4.9 ore di mediana): zero costo
  di manutenzione per noi, e il resto del mondo le testa al posto nostro;
- **la patch resta in questo repo** (`obscura-canvas-fix.patch`): se upstream sparisse o
  rifiutasse, `git apply` + `cargo build` la riporta in 17 minuti. È l'assicurazione;
- si mantiene Chromium come fallback finché i buchi noti non sono chiusi. Non è un
  ripiego: è la stessa struttura a due motori che Topics ha già (`nativo` + `chromium`),
  con un terzo che si aggiunge senza togliere niente.

Tradotto: **il rischio di adottarlo è basso perché non ci leghiamo al codice, ma a un
protocollo che parlano tutti.** Se Obscura muore, si torna a Chromium cambiando un
endpoint — è esattamente ciò che rende questa scelta reversibile, e quindi facile.

## Il quadro completo — chi vince cosa

| per sessione, react.dev / app dev | RAM | render | CDP | context multipli |
|---|---|---|---|---|
| **WKWebView** (già in Topics) | **46 / 37 MB** | ✅ perfetto | n/a (nativo) | ✅ |
| Chromium full (Topics oggi) | 219 MB | ✅ perfetto | ✅ | ✅ |
| headless-shell | 140 / 95 MB | ✅ perfetto | ✅ | ✅ |
| Obscura | **9 / 2 MB** | ⚠️ no canvas/grid | ✅ | ✅ |
| Servo 0.4 | 223 / 110 MB | ✅ ma SPA crashano | ❌ (RDP Firefox) | ❌ |
| Lightpanda | 53 MB | ❌ nessuno | ✅ | ❌ |

Non c'è un engine da adottare al posto di quello che c'è. Il motore leggero che cerchi
**è già dentro Topics** e si chiama WKWebView: 37-46 MB a sessione, render perfetto,
zero dipendenze nuove. Gli sfidanti si dividono in "leggeri ma ciechi" (Obscura,
Lightpanda) e "vedono ma costano più di Chromium" (Servo). Nessuno è entrambe le cose.

### Ladybird, Ultralight, CEF — perché non li ho nemmeno misurati

- **Ladybird**: dichiarato **pre-alpha**, prima alpha attesa nel 2026 "per sviluppatori e
  early adopter". Ha appena chiuso i contributi pubblici. Nessun binario da provare.
- **Ultralight**: fork WebKit proprietario, gratis solo sotto i 100K$ di fatturato,
  licenza commerciale a pagamento oltre. Un motore closed dentro un prodotto MIT è una
  decisione di licenza, non di performance.
- **CEF**: è Chromium — 200-300 MB di binari e lo stesso modello multi-processo che
  stiamo cercando di evitare. Non risolve niente.
- **litehtml / Blitz**: nessun JavaScript. Per una pane che deve guardare un dev server è
  discriminante.

### Pippo Browser (`~/Downloads/browser-main`) — cos'è e cosa non è

È un browser macOS nativo completo: SwiftUI + AppKit + WebKit, GPL-3.0, spaces, tab
verticali, PiP, session restore, content blocking. Il README dice "not ready for daily
use"; le estensioni sono in roadmap, non fatte.

**Non è un componente da incorporare.** È un'*app*, non una libreria: il valore per
Topics non è il codice ma la conferma architetturale — un browser serio su macOS si fa
con WKWebView, ed è esattamente la scelta che Topics ha già fatto per la pane nativa.
Vale come riferimento di implementazione (gestione tab, dataStore per spazio, content
blocking), non come dipendenza.

## Dove si rompono

Il banco vero non è Wikipedia, è **un'app dev locale** (`app/index.html`: grid, sticky,
gradient, transform, keyframes, canvas 2D, SVG, filtro live) — cioè il caso d'uso di
Topics, che guarda soprattutto dev server e anteprime.

**Lightpanda è fuori discussione per la pane.** Non renderizza per scelta di progetto:
niente screenshot, niente screencast, `getComputedStyle(grid).display` risponde `block`,
e ogni box del layout è **5×5 px alla posizione 100,100** — un placeholder. Sul layout
reale: **0 elementi su 60 entro 20 px** dal riferimento, su tutti e tre i siti. Un agente
che clicca per coordinate qui clicca nel vuoto. Il click del test è passato solo perché
il bottone era l'unico elemento a quelle coordinate finte.

**Obscura renderizza davvero, e il rendering regge** — ma con crepe precise:

- **Layout fedele dove il CSS è moderno**: su react.dev **50 box su 60 entro 2 px**.
  Su Hacker News (tabelle annidate anni '90) crolla a 2 su 60 entro 2 px, 35 oltre 20 px.
  Il DOM diff pixel contro Chrome: react.dev 0.9%, github 8.7%, HN 9.3%, Wikipedia 15.1%
  (il grosso è il font rasterizzato diverso e la sidebar Vector 2022 fuori posto).
- **Canvas 2D: metà primitive mancavano — ora sono implementate.** `fillRect`,
  `strokeRect`, `arc` e `fillText` funzionavano; **`stroke` di un path e
  `createLinearGradient` no**, ed erano proprio le due che disegnano un line chart.
  **Chiuse da `obscura-canvas-fix.patch`** (vedi sotto): la dashboard di prova passa da
  32.35% a **1.16%** di differenza da Chrome. La prima lettura "canvas nero" era troppo
  severa: il canvas dipingeva, mancavano due primitive.
- **`textContent` invece di `innerText`**: su github.com/topics ha restituito **1.3 MB**
  di testo contro i 5.5 KB di Chrome — dentro c'è il sorgente degli `<script>`. Su una
  pagina di prova `document.body.innerText` include `display:none`, `visibility:hidden`
  *e il codice JS inline*. Un `browser_get_text` che finisce nel contesto di un LLM
  passerebbe da 5 KB a 1.3 MB: non è un dettaglio estetico, è la bolletta.
- **Screencast a 20 fps** contro i 92 di Chrome, con frame **1.85× più pesanti**
  (55.8 KB contro 30.1). Per una pane live che segue un dev server è visibilmente meno
  fluido.
- **Screenshot fino a 780 ms** su Wikipedia (Chrome: 25 ms), 31× più lento.
- **`Input.insertText` non esiste** (`Unknown Input method`) — la scorciatoia che
  `browser_act` usa per riempire un campo in un colpo solo. Funziona il `char` per
  carattere, quindi è adattabile, ma è codice da scrivere.
- **Loopback bloccato di default** (fix SSRF #4): con `serve` senza
  `--allow-private-network` ogni `http://127.0.0.1:N` risponde
  `Access to private/internal IP address is not allowed`. Per Topics, che vive sui dev
  server locali, è il default esattamente sbagliato — una riga di flag, ma va saputa.
- **8 navigazioni in parallelo: 30 s** contro i 4.3 s di headless-shell (7×), a processi
  separati. Il thread-per-connessione non regge il fan-out.
- `example.com` non ha mai emesso `load` (timeout 15 s) pur avendo caricato la pagina:
  gli eventi di ciclo di vita non sono affidabili quanto quelli di Chrome.

Nessuno dei due ha estensioni, DRM/Widevine, o codec video — cioè il motivo per cui il
sidecar Chromium di Topics esiste (`server/browser-chromium-sidecar.ts`).

## Cosa se ne ricava per Topics

L'architettura attuale ha già i due poli giusti: **WKWebView nativa** per la pane che
l'umano guarda (zero processi extra, il default) e **Chromium** quando servono le
estensioni. Il terzo motore, il Chromium server-side pilotato via Playwright, è quello
che paga **219 MB a context misurati sull'app viva** — ed è anche l'unico che un engine
alternativo potrebbe rimpiazzare.

**Sostituire la pane visibile: no.** Canvas nero, HN sfasato di 20+ px, screencast a
20 fps e `innerText` che sanguina script sono quattro regressioni visibili su una
superficie che l'utente guarda. La pane nativa costa già zero processi: non c'è niente
da guadagnare.

**Il posto dove Obscura ha senso è un altro**, ed è un posto che esiste già nel repo:
`openspec/changes/agent-inline-browser` introduce contesti browser che **l'umano non
guarda mai** — l'agente legge una pagina di docs, controlla un JSON, verifica che un
endpoint risponda. Lì il render serve solo per l'ultimo fotogramma della card, il layout
preciso non serve, e il costo per contesto passerebbe da 219 MB a 29. Con dieci contesti
inline aperti sono 2.2 GB contro 290 MB.

Il blocco resta **uno solo**: 1.3 MB di `innerText` al posto di 5.5 KB, un bug che
colpisce esattamente il caso d'uso proposto (l'agente che legge). Serve un
`browser_get_text` che non passi da `innerText` — o una patch upstream. È una condizione
verificabile, non un'opinione: `hidden.mjs` la misura in 4 secondi.

E il fatto che le due primitive canvas siano state chiuse in 143 righe di JavaScript dice
qualcosa sul progetto: **i buchi di Obscura sono superficie non ancora scritta, non
scelte architetturali**. Il che cambia il calcolo — non stiamo valutando un motore
limitato, ma un motore giovane su cui si può intervenire.

**Lightpanda ha un uso legittimo e diverso:** 21 MB, un processo, DOM e JS corretti
(`document.title`, `querySelectorAll`, il conteggio dei nodi combaciano con Chrome su
tutti e sei i siti) e **testo più completo di Chrome** su Wikipedia (30 KB contro 20 KB,
perché non taglia il fuori-viewport). Per un `browser_fetch`/`browser_extract` puramente
testuale — nessuna pane, nessun pixel — è 8× più leggero di headless-shell. Ma è un
processo per pagina, quindi va usato come fetcher usa-e-getta, non come sessione viva.

## File

- `wkbench.swift` — **il bench che risponde alla domanda dei 50 MB**: N `WKWebView` vere
  in un processo, attribuzione dei processi WebKit per diff di pid.
  `swiftc -O wkbench.swift -o wkbench && ./wkbench 8 https://react.dev shared`
- `ctx2.mjs` — lo stesso test per gli engine CDP, così il confronto è sullo stesso sito.
- `bench.mjs` — client CDP minimale, launcher per i tre engine, RSS dell'albero processi.
- `run-engine.mjs` — startup, RSS, 6 siti, screenshot, screencast, RTT input.
- `interact.mjs` — il caso Topics: app locale, click, digitazione, DOM API, screenshot.
- `contexts.mjs` — **il test che conta**: costo marginale di N context nello stesso processo.
- `layout.mjs` + `layout-*.json` — box di 60 elementi per sito, per engine.
- `cast.mjs` — screencast su pagina animata. `hidden.mjs` — fedeltà di `innerText`.
- `type2.mjs` — quali varianti CDP di digitazione funzionano dove.
- `app/index.html` — l'app dev sintetica (grid, canvas, animazioni) usata come banco.
- `obscura-canvas-fix.patch` — **la patch**: 143 righe su `bootstrap.js` che
  implementano `stroke`, i gradienti e il fill dei poligoni. `git apply` sul repo
  Obscura, poi `cargo build --release -p obscura-cli --bins --features render`.
- `canvas-proof.mjs` — 14 asserzioni sulla logica patchata, **senza compilare** (~200 ms).
- `chart/index.html` + `chart-test.mjs` + `vs/CHART-prima-dopo.png` — la prova
  end-to-end: la stessa dashboard prima, dopo, e su Chrome.
- `vs/OBSCURA-vs-CHROME.png` — **il pannello da guardare**: tre confronti affiancati.
  `cases/`, `canvas/`, `css/` sono le pagine sorgente; `cases-shot.mjs`,
  `canvas-test.mjs`, `css-test.mjs` le rigenerano.
- `app2/index.html` + `feat/` — **il test feature-per-feature**: cinque bande di colore
  piatto (canvas, grid, flex, gradient, SVG) campionate a quattro punti. Risponde a
  "questo motore disegna davvero?" senza doverlo guardare a occhio.

## Riprodurre Servo

```bash
curl -LO https://github.com/servo/servo/releases/download/v0.4.0/servo-aarch64-apple-darwin.dmg
hdiutil attach servo-aarch64-apple-darwin.dmg -nobrowse
/Volumes/Servo/Servo.app/Contents/MacOS/servoshell --headless --temporary-storage \
  --enable-experimental-web-platform-features --window-size=400x500 \
  -o feat-servo.png -x http://127.0.0.1:4600/
```
Senza `--enable-experimental-web-platform-features` il grid collassa. `-Z
layout_grid_enabled` è elencato nell'help ma **il parser lo rifiuta**: usa il flag lungo.
