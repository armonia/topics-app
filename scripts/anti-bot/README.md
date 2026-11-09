# Pane del browser e controlli anti-bot (Hetzner / Heray)

Misurato il 09/11/2026 su questo Mac, stesso IP, un tentativo ogni 90-150 s.
Caso autorizzato da Attilio: i NOSTRI account (console.hetzner.com), non scraping di terzi.

## Cosa succedeva

Aprendo `https://console.hetzner.com/projects` in una pane, Hetzner manda a
`accounts.hetzner.com/_ray/pow` («Security Check», il prodotto anti-bot Heray).
La pagina fa una prova di lavoro in un Web Worker (SHA-256, ~150 ms), scrive
«Verification successful», invia il modulo; il server **rifiuta** la risposta e
rimanda la stessa pagina, in ciclo. Dopo qualche giro: «Potential unusual
behavior / Request on Hold / Please wait 61s».

## Causa (con la prova)

`window.outerWidth` e `window.outerHeight` valgono **0** in un WKWebView figlio
(la pane non ha una finestra sua). Nessun browser vero risponde così (fuori è
sempre >= dentro). Heray respinge la prova di lavoro per questo solo valore.

Ogni riga è un tentativo vero. L'IP non è mai stato il problema: `curl` e
Playwright passavano nello stesso minuto.

| Prova | Esito |
|---|---|
| Pane nativa di Topics (WKWebView) | ciclo su `_ray/pow`; la pagina legge `outer 0x0`, `inner 1425x628` |
| Pane nativa con data store nuovo (nuova topic) | uguale: non sono cookie vecchi |
| Playwright WebKit, `navigator.webdriver` vero | ciclo |
| Playwright WebKit, `webdriver` falso | login in 3,3 s |
| ... più UA senza `Version/ Safari/` (come la pane) | login in 3,6 s: l'UA non c'entra |
| ... più viewport 199x1336 | login in 4,2 s: il viewport non c'entra |
| ... più `window.safari` assente, `Notification` e globali Tauri (`ipc`, `__TAURI_*`), `hasFocus` falso | login in 3,3 s: non c'entrano |
| `outerWidth/outerHeight = 0` da solo | ciclo (26 s) |
| `outerWidth/outerHeight = 0` + il file di correzione | login in 4,7 s |
| `document.hidden = true` | resta su «Success» senza inviare mai: nel codice della pagina l'invio aspetta `!document.hidden` |
| Sonda `wkzprobe antibot` (WKWebView figlio di wry, la strada della pane), senza correzione | ciclo 60 s, `outer [0,0]` |
| La stessa con `pane_window_metrics.js` | login in 2,7 / 3,7 / 4,0 s |

Seconda causa, nel Chromium headless del server (quello che risponde quando
nessuna finestra mostra la pane): `navigator.webdriver === true`. Con quel solo
valore a falso, stesso browser e stesso UA «HeadlessChrome», il login arriva in
3,7 s; con il valore vero cicla.

Non sono la causa: viewport, UA, cookie vecchi, canvas (11 operazioni, identiche
al WebKit di Playwright). `document.hidden` era falso sulla pane montata, ma è
una seconda trappola: se la pagina nasce nascosta (la pane si crea a `x:-100000`)
l'invio resta fermo finché non diventa visibile.

## Cosa cambia

- `desktop-tauri/src-tauri/src/pane_window_metrics.js`, caricato come
  initialization script di ogni pane nativa (`lib.rs`): `outerWidth/outerHeight`
  non scendono mai sotto la misura interna; il valore vero resta se è già
  plausibile. Provato da `tests/unit/pane-window-metrics.test.ts` (5 casi,
  mutazione verificata: 3 rossi).
- `server/lib/headless-chromium-stealth.ts`: il Chromium del server parte con
  `--disable-blink-features=AutomationControlled` e UA da Chrome vero (versione
  ridotta, niente `HeadlessChrome`). Gli hint `Sec-CH-UA` erano già coerenti.
- `tools/wkzprobe`: arm `antibot`, la sonda sul motore vero (finestra fuori
  schermo, nessuna attivazione).

## Barra

```
scripts/anti-bot/pane-bar.sh [--prima] [--runs N] [--gap S]   # WKWebView (macOS)
bun scripts/anti-bot/chromium-bar.ts [--prima]                 # Chromium del server
```

Hetzner: login in meno di 60 s, 3 su 3 distanziati di 150 s (esce 1 altrimenti).
Più bot.sannysoft.com e una sfida Cloudflare (demo di scrapingcourse.com) come misura.

| | Prima | Dopo |
|---|---|---|
| Pane WKWebView, Hetzner | 60 s su `_ray/pow` (0/1) | login in 2,7 / 3,7 / 4,0 s (3/3) |
| Pane WKWebView, sannysoft | 2 righe fallite (`Chrome (New)`, `PHANTOM_ETSL`) | uguale: sono test specifici di Chrome |
| Pane WKWebView, Cloudflare | sfida passata | sfida passata |
| Chromium del server, Hetzner | 60 s su `_ray/pow` | login in 3,8 s |
| Chromium del server, sannysoft | 4 fallite (UA old, WebDriver, HEADCHR_UA, CHR_MEMORY) | 0 fallite, 31 passate |
| Chromium del server, Cloudflare | sfida non passata («Ci siamo quasi…») | sfida passata |

## Stato dell'arte (consultato il 09/11/2026)

- patchright (5,1k stelle, push 05/11/2026): fork di Playwright per Chromium, patcha
  `Runtime.enable` e altri segnali CDP. Non serve a un WKWebView.
- rebrowser-patches (1,5k, 02/11): patch di Playwright/Puppeteer per il leak CDP. Idem.
- nodriver (4,9k, 26/10): CDP diretto senza chromedriver. Solo Chromium.
- camoufox (13k, 09/11): Firefox modificato. Un altro motore, fuori scopo.
- BotD di FingerprintJS raccoglie `outerWidth/outerHeight/innerWidth/innerHeight`
  (`src/sources/window_size.ts`): la misura che ha fatto cadere la pane è un
  segnale standard dei rilevatori, non una stranezza di Heray.
- WKWebView: `applicationNameForUserAgent` (documentazione Apple) è la leva per
  aggiungere `Version/x Safari/605.1.15` all'UA; su Hetzner non serve (misurato),
  quindi non è stato toccato.

Le patch dei progetti CDP non si applicano a una pane WKWebView: qui conta solo
la coerenza di ciò che la pagina legge di sé, e si corregge con uno script di
inizializzazione.

## Da sapere

- Il blocco «On Hold» cresce con i tentativi: la barra distanzia le prove.
- La correzione della pane vive nel guscio Tauri: arriva con la prossima
  release dell'app. Quella del Chromium del server, con il riavvio del server.
