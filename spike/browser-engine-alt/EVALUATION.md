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
- **Canvas 2D non viene dipinto**: `getImageData` torna 0 pixel non-neri dove Chrome ne
  conta 1493. Grafici, sparkline, WebGL, ogni anteprima che disegna su canvas resta nera.
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
estensioni. Il terzo motore, l'headless Playwright server-side, è quello che paga
166 MB a context — ed è anche l'unico che un engine alternativo potrebbe rimpiazzare.

**Sostituire la pane visibile: no.** Canvas nero, HN sfasato di 20+ px, screencast a
20 fps e `innerText` che sanguina script sono quattro regressioni visibili su una
superficie che l'utente guarda. La pane nativa costa già zero processi: non c'è niente
da guadagnare.

**Il posto dove Obscura ha senso è un altro**, ed è un posto che esiste già nel repo:
`openspec/changes/agent-inline-browser` introduce contesti browser che **l'umano non
guarda mai** — l'agente legge una pagina di docs, controlla un JSON, verifica che un
endpoint risponda. Lì il render serve solo per l'ultimo fotogramma della card, il layout
preciso non serve, e il costo per contesto passerebbe da 166 MB a 29. Con dieci contesti
inline aperti sono 1.6 GB contro 290 MB.

Ma **non oggi**, e per una ragione sola: 1.3 MB di `innerText` al posto di 5.5 KB è un
bug che colpisce esattamente il caso d'uso proposto (l'agente che legge). Prima serve un
`browser_get_text` che non passi da `innerText` — o una patch upstream. È una condizione
verificabile, non un'opinione: `hidden.mjs` la misura in 4 secondi.

**Lightpanda ha un uso legittimo e diverso:** 21 MB, un processo, DOM e JS corretti
(`document.title`, `querySelectorAll`, il conteggio dei nodi combaciano con Chrome su
tutti e sei i siti) e **testo più completo di Chrome** su Wikipedia (30 KB contro 20 KB,
perché non taglia il fuori-viewport). Per un `browser_fetch`/`browser_extract` puramente
testuale — nessuna pane, nessun pixel — è 8× più leggero di headless-shell. Ma è un
processo per pagina, quindi va usato come fetcher usa-e-getta, non come sessione viva.

## File

- `bench.mjs` — client CDP minimale, launcher per i tre engine, RSS dell'albero processi.
- `run-engine.mjs` — startup, RSS, 6 siti, screenshot, screencast, RTT input.
- `interact.mjs` — il caso Topics: app locale, click, digitazione, DOM API, screenshot.
- `contexts.mjs` — **il test che conta**: costo marginale di N context nello stesso processo.
- `layout.mjs` + `layout-*.json` — box di 60 elementi per sito, per engine.
- `cast.mjs` — screencast su pagina animata. `hidden.mjs` — fedeltà di `innerText`.
- `type2.mjs` — quali varianti CDP di digitazione funzionano dove.
- `app/index.html` — l'app dev sintetica (grid, canvas, animazioni) usata come banco.
