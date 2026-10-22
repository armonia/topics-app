# Baseline delle performance di Topics (14/10/2026, sera)

Misure in sola lettura sul sistema vivo: log del server (24 ore, dal 13/10 17:00 UTC), socket del
server, bundle pubblicato.

**Condizioni della macchina:**
- load 110;
- swap 25,4 GB su 26,6;
- 22 sessioni Claude vive;
- Beeper 5,1 GB, un WebKit di Playwright 3,4 GB, un node da 3,1 GB.

Le code lunghe sotto sono in parte pressione della macchina, ma i conteggi (quante chiamate, quante
fallite) no.

## Server: latenze per endpoint (24 ore)

| endpoint | n | p50 ms | p95 ms | max ms | nota |
|---|---|---|---|---|---|
| POST /api/git/fetch | 1.597 | 1.397 | 60.051 | 60.305 | 499 falliti (264 con 400, 235 appesi fino al 504): corretto in #317 |
| GET /api/git/status | 6.008 | 80 | 385 | 12.644 | spawn di `git` a ogni lettura non in cache |
| GET /api/scripts | 6.764 | 37 | 173 | 24.918 | |
| GET /api/files | 3.223 | 62 | 349 | 40.094 | |
| GET /api/system/status | 1.664 | 82 | 397 | 8.055 | |
| GET /api/system/presence | 357 | 276 | 784 | 2.235 | |
| GET /api/topics/:id/changes | 101 | 1.016 | 6.064 | 25.617 | |
| GET /api/browser/resource | 1.039 | 91 | 5.108 | 9.089 | risorse del mirror del browser |
| POST /api/sessions/…/browser/act | 7 | 3.006 | 17.778 | 17.778 | azioni dell'agente sul browser |
| POST /api/chat | 23 | 1.328 | 6.174 | 11.044 | dal POST alla risposta HTTP |
| GET /api/all-boards/tasks | 18.526 | 16 | 60 | 981 | il 98% era il contatore SwiftBar, corretto (75122ce) |

Gli endpoint da 25 s (`PATCH …/tasks/:id`, `ask-user`) sono attese volute (long-poll), non lentezza.

## Socket: cosa riceve un client (30 s)

- 206,6 KB in 30 s, cioè **6,9 KB/s** per client, anche a non guardare niente.
- Il grosso:
  - `ui-state:init`, 90 KB, una volta per connessione;
  - `external-sessions`, 37 KB a frame, uno ogni circa 15 s;
  - `stream:*` delle chat degli altri, mandato a tutti i client.
- Con tre dispositivi aperti per persona e un team, il costo cresce con client × sessioni vive.

## Client

- Bundle iniziale:
  - JavaScript 1.706.881 B (544.462 B compresso);
  - CSS 211.717 B (33.476 B compresso);
  - 4 chunk caricati da `index.html`.
- Build intera: 152 file JS, 8,0 MB.
- Webview del desktop: da 0,6 a 1,7 GB in 7,5 minuti, CPU media al 28% con l'app in background
  (15 campioni, misura di oggi pomeriggio).
- Avvio dopo un ricaricamento: circa 17 richieste in 0,9 s, fra cui 4 `git/status` in parallelo da
  146-296 ms.
- Feed della board: le finestre lo rileggono da 0 a 70 volte l'ora, sugli eventi. Le riletture
  senza cambi ora costano un 304 (#315).

## Obiettivi «istantaneo» proposti (barre del piano)

| cosa | obiettivo | oggi |
|---|---|---|
| letture API usate dalla UI, lato server | p95 ≤ 50 ms | git/status 385, files 349, system/status 397 |
| `git status` | da cache di un watcher, nessuno spawn sulla lettura, p95 ≤ 20 ms | spawn, p95 385 ms |
| client a riposo | ≤ 1 KB/s di socket, CPU ≤ 2% | 6,9 KB/s, 28% |
| memoria della webview | stabile ≤ 600 MB | 0,6-1,7 GB |
| avvio a freddo fino all'interattivo | ≤ 1,5 s | da misurare (serve un riavvio dell'app) |
| input → risposta visibile | p95 ≤ 100 ms | `check:ink`: card 23,5 ms, tab 14,6 ms, send 12,4 ms; tetto per campione 250 ms |
| lavoro appeso | 0 processi `git` o fetch oltre 10 s | 235 al giorno da 60 s, prima di #317 |

## Dove Rust ha senso (da confermare con la misura, una traccia alla volta)

- **git**:
  - oggi uno spawn per lettura (6.008 al giorno, p95 385 ms);
  - stato e diff con `gix` dentro il guscio Tauri o in un sidecar, aggiornati da un watcher del
    filesystem, e il server legge la cache.
- **Watcher e ricerca nei file**: crate `notify` e `ignore`, il cuore di ripgrep, al posto degli
  scan in JavaScript, se la traccia mostra che pesano.
- **PTY e terminali**: il bridge in Rust c'è già (`desktop-tauri/pty-bridge`, `portable-pty`) e lo
  usa l'app installata. Il server del Mac, che gira dal checkout, usa ancora quello in Node
  (`server/pty-bridge.mjs`, `node-pty`): chi sviluppa non prova lo stesso binario degli utenti.
  Basta usare quello Rust anche lì; niente da riscrivere.
- **Mirror del co-browse**: il diff del DOM in Rust ha senso solo se è il collo di bottiglia, e va
  misurato prima. Il grosso costo oggi sembra la banda, non il calcolo.
- **Non Rust**:
  - la UI React, dove il costo è di architettura (cosa si rende e cosa arriva dal socket), non di
    linguaggio;
  - la logica del server in Bun, dove una riscrittura costerebbe mesi per guadagni che la misura
    non mostra.

## Misure D0 (14/10/2026)

- `measure:ws-idle -- --budget 1024`, con 100 sessioni esterne tarate sul censimento di produzione (114 sessioni, 46 KB a frame): **2.147,5 B/s, exit 1**, il rosso che D1 deve spegnere. In 60 s: `external-sessions` 100.097 B in 3 frame; `stream:usage` 14.836 B e `stream:content_chunk` 7.860 B, 60 frame ciascuno, di un turno su un topic che il client non ha aperto. Con le prime 20 sessioni il banco dava 815,9, 815,6 e 809,3 B/s su tre giri (escursione 0,81%): ripetibile, ma verde mentre la produzione non lo era.
- `check:route-latency`: exit 2, baseline locale priva di `git_status`, `files`, `scripts`, `system_status`. `--update-baseline --samples=3`: exit 2 per load 195,43 su 12 core (16,29 per core, tetto 0,5). Valori indicativi: topics 0,75 ms; topic_messages 3,16; all_boards_tasks 2,93; dispatch_capacity 0,85; git_status 45,70; files 96,03; scripts 0,52; system_status 1,26. Il confronto supera il controllo cache con 44,85 ms di margine su dispatch.
- Webview e avvio a freddo: nessuna misura valida. Il sistema ha negato la lettura dei processi e del footprint nel sandbox. `app:interactive` è disponibile in `performance` e in `document.documentElement.dataset.appInteractive` dopo che la sidebar ha caricato e mostrato topic reali.
- Input: resta il cancello `check:ink`, budget mediana ≤100 ms e massimo ≤250 ms; baseline 23,5 ms card, 14,6 ms tab, 12,4 ms send (`tests/e2e/ink-budget.json`).
