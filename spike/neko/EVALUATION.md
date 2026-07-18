# Spike: neko/WebRTC per browser condiviso (co-op)

Spike time-boxed, di VALIDAZIONE del transport model — non una feature di
produzione. Nessun container avviato, nessun commit. Artefatti in
[`spike/neko/`](./) (docker-compose, README, embed-demo).

Contesto: task board **d6baaf5e "sistema amicizia"** — friendship/org +
presence + permessi per-chat/per-progetto/link-pubblico, dove l'owner di una
sessione browser concede a un amico view-only o input. L'utente aveva
citato neko come possibile engine di screen-sharing.

## Cos'è neko e perché entra in gioco nel co-op

[neko](https://github.com/m1k1o/neko) è un browser virtuale self-hosted in
Docker che streamma un vero browser (Chromium/Firefox) via **WebRTC**: video
+ audio fluidi, <300ms di latenza dichiarata — "video, non immagini-su-
WebSocket". Ha built-in esattamente le due cose che il co-op vision richiede:

- **Multi-user control arbitration**: più membri connessi alla stessa
  sessione, l'host concede/nega il controllo; admin può forzare il controllo,
  kickare o lockare la sessione. Non va costruito da zero — è il prodotto.
- **Sessione condivisa embeddable**: UI web, iframabile in un'app terza.
- Automazione compatibile: supporta Playwright/Puppeteer che pilotano il
  browser interno anche mentre neko intercetta l'input umano — quindi in
  teoria un agente potrebbe ancora guidare la pagina mentre un umano guarda/
  controlla via WebRTC.

Il confronto interessante non è "neko sì/no" in astratto, ma **neko-sidecar
vs. costruire lo stesso multi-viewer/multi-input sopra la pipe Playwright/CDP
che Topics ha già** (`server/browser-service.ts` — screencast CDP +
`browserWsClients` fan-out in `server.ts`, consumato da
`client/src/hooks/useRemoteBrowser.ts`). Quella pipe è GIÀ un motore di
co-browsing a bassa fedeltà: N viewer per context, un solo `dispatchInput`
per context. Gli manca solo (a) la fedeltà video/audio WebRTC e (b) l'
arbitrato multi-controllo (chi ha la mano adesso).

## Confronto: Opzione A (neko-sidecar) vs Opzione B (DIY WebRTC sulla pipe esistente)

| Criterio | **A — neko sidecar** (Docker, WebRTC nativo) | **B — DIY WebRTC sulla pipe Playwright/CDP esistente** |
|---|---|---|
| **Fedeltà video/audio** | Alta: WebRTC nativo, audio incluso, <300ms dichiarati. Codec/bitrate adattivi gestiti dal progetto. | Oggi: JPEG-over-WS a ~15fps (`everyNthFrame:2`, q70 in `startScreencast`), niente audio. Per arrivare a fedeltà WebRTC serve aggiungere un vero media path (es. `pion`/`werift`, o piping dei frame CDP in un encoder H.264/VP8) — lavoro sostanziale, non incrementale. |
| **Latenza** | Bassa, WebRTC è pensato per real-time interattivo. | Le screenshot CDP + WS hanno più hop e un frame-rate cap esplicito; accettabile per co-browsing "guarda cosa sto facendo", non per motion fluido/audio sync. |
| **Costo infra/packaging** | Un container Docker aggiuntivo per sessione condivisa, immagine `m1k1o/neko:chromium` (~1 core + ~500MB-1GB RAM/sessione, stima non misurata in questo spike). Serve aprire porte UDP (mux o EPR range) sul firewall dell'host; oltre LAN serve un **TURN server** (Coturn). Topics oggi non ha Docker nel suo runtime di produzione (Bun nativo + Tauri) — introdurlo è un salto architetturale, non un'aggiunta. | Zero nuovo processo/container: si estende `browser-service.ts` (già Bun-nativo, già nel processo server esistente). Il costo è tutto in codice (media path WebRTC) + eventualmente lo stesso TURN per NAT traversal oltre LAN — quella parte di costo di rete non si evita in nessuna delle due opzioni. |
| **Compatibilità "agent guida il browser"** | neko supporta Playwright/Puppeteer che pilotano DENTRO il container mentre neko intercetta — ma è un **secondo browser separato** da quello che Topics già pilota via CDP (`browser-service.ts`, targetId, `dispatchInput`, `browser_observe`/DOM walker). Un agente Topics dovrebbe pilotare DUE browser paralleli (quello nativo Topics per gli agent-tool esistenti, quello dentro neko per il co-browsing) — o migrare TUTTO il pilotaggio agente dentro neko, riscrivendo l'integrazione CDP/targetId/screencast/dispatchInput che esiste oggi. | Stesso browser, stessa `BrowserContextEntry`, stesso targetId: l'agente continua a usare `browser_act`/`browser_observe`/CDP esattamente come oggi. Il video WebRTC sarebbe un output aggiuntivo dello STESSO Playwright Page, non un secondo browser da tenere sincronizzato. |
| **Arbitrato multi-controllo (chi ha la mano)** | Già costruito: grant/deny, view-only vs input, force-control/kick/lock da parte dell'admin. Riuso diretto. | Da costruire: oggi `dispatchInput` in `browser-service.ts` non ha concetto di "proprietario" della sessione — qualunque client che manda un messaggio `input` sul WS viene eseguito. Serve un livello di permessi sopra `browserWsClients` (chi può inviare input in un dato momento) — lavoro nuovo, ma si aggancia naturalmente al sistema di permessi che il co-op epic (d6baaf5e) deve comunque costruire (friendship/org + presence + permessi per-chat/progetto/link).
| **Packaging Bun + Tauri** | Il container Docker vive fuori dal processo Bun; la UI Tauri lo consumerebbe via iframe (path Phase-2, stesso pattern del "localhost iframe" già in `RemoteBrowserPanel.tsx`) puntando a `http://host:8080`. Aggiunge una dipendenza di deploy (Docker daemon) sulla macchina che ospita la sessione condivisa — un salto per un progetto che oggi gira come singolo processo Bun + shell Tauri nativa. | Resta dentro il processo Bun esistente (`server.ts`/`browser-service.ts`); il client consumerebbe un feed WebRTC invece del JPEG-over-WS attuale, ma l'infrastruttura di processo/deploy (launchd, Tauri, niente Docker) non cambia. |
| **Effort stimato** | Basso per il PoC "si vede uno stream WebRTC che funziona" (è esattamente questo spike); ALTO per l'integrazione reale (doppio browser da riconciliare con l'agent-tooling esistente, o migrazione completa del pilotaggio agente dentro neko). | Medio-alto ma incrementale: si parte da una pipe già funzionante (fan-out multi-viewer + input dispatcher esistono), il lavoro nuovo è il media path WebRTC + permessi di controllo — nessuna doppia fonte di verità sul browser pilotato. |

## Il caveat WebRTC-non-HTTP e l'implicazione sul relay Hetzner

WebRTC non passa da un reverse proxy 443/TLS: il segnale (SDP/ICE handshake)
è HTTP/WS e un proxy va benissimo, ma il canale media è UDP peer-to-peer con
fallback TURN — un livello di rete diverso. Concretamente:

- **In LAN**: basta aprire la porta UDP giusta (mux singolo o range EPR) sul
  firewall dell'host. Nessun problema di NAT — è quanto valida questo spike.
- **Oltre la LAN** (il caso reale del co-op: due amici su reti diverse, o
  dietro Tailscale in strict NAT/CGNAT): serve un **TURN server** (es.
  Coturn) che faccia da relay quando il path diretto fallisce.

Il task co-op (d6baaf5e) menziona un relay Hetzner: se quel relay è pensato
come **reverse-proxy HTTP/TLS generico** (il pattern che Topics userebbe già
per instradare traffico verso il server :3333), NON copre il caso WebRTC —
serve esplicitamente un servizio TURN separato (Coturn tipicamente su
`:3478`/TCP+UDP, più porte relay dinamiche), da provisionare e mantenere in
aggiunta, con le sue credenziali (short-lived, generate lato server per non
esporre segreti statici al client). Questo vale identico sia per l'opzione A
(neko) sia per l'opzione B (DIY WebRTC) — è un costo di rete della SCELTA
"WebRTC", non di una specifica implementazione. Se invece il co-op resta
sull'attuale JPEG-over-WS (Opzione B senza upgrade a WebRTC), il relay
Hetzner HTTP/TLS esistente basta e questo intero problema non si pone.

## Raccomandazione

**Non introdurre neko/Docker nel transport di produzione ora.** Per il co-op
epic, l'opzione B (estendere la pipe Playwright/CDP esistente) resta la
scelta di default finché non si dimostra che la fedeltà JPEG-over-WS attuale
è realmente insufficiente per l'uso reale (co-browsing "guarda/aiuta", non
streaming video/gaming): riusa `browser-service.ts` + `browserWsClients`,
mantiene l'agente su un SINGOLO browser pilotabile (niente split-brain con un
secondo browser dentro un container), e non aggiunge Docker come dipendenza
di deploy a un progetto che oggi è Bun nativo + Tauri.

Il salto a WebRTC (via A o via B) va riconsiderato SOLO dopo che l'epic co-op
ha le fondamenta che lo giustificano — friendship/org, presence, permessi
per-chat/progetto/link (d6baaf5e) — perché è proprio lì che nasce il bisogno
reale di "arbitrato multi-controllo" che oggi manca in `dispatchInput`. Fino
ad allora, il gap di fedeltà (niente audio, 15fps, nessun TURN) è un costo
accettabile rispetto al costo di introdurre Docker + TURN in produzione per
un caso d'uso non ancora costruito.

**Prossimi passi concreti:**
1. Costruire prima le fondamenta co-op (auth/friendship, presence, permessi
   per-chat/progetto/link) — d6baaf5e — SENZA toccare il transport video.
2. Aggiungere il concetto di "proprietario/controllo" sopra `dispatchInput`
   in `browser-service.ts` (grant/revoke input per client WS), riusando i
   permessi appena costruiti al punto 1 — questo copre l'80% del bisogno
   "co-op browser" con zero nuova infra.
3. Solo se la fedeltà JPEG-over-WS si rivela realmente insufficiente in uso
   reale: rivalutare un media path WebRTC nativo dentro `browser-service.ts`
   (Opzione B con encoder reale) prima di considerare di nuovo un sidecar
   Docker esterno come neko.

## Riferimenti

- Task board: **d6baaf5e** (sistema amicizia / co-op)
- `server/browser-service.ts` — screencast CDP (`startScreencast`/
  `stopScreencast`), fan-out multi-viewer, `dispatchInput`
- `server.ts` — `browserWsClients` (registry WS per-contextId, righe 127,
  740-759, 1151-1154, 1442-1445)
- `client/src/hooks/useRemoteBrowser.ts` — consumer client del feed
  JPEG-over-WS + input WS-first/REST-fallback
- [neko GitHub](https://github.com/m1k1o/neko), [docs v3](https://neko.m1k1o.net/docs/v3/)
- Artefatti di questo spike: [`spike/neko/docker-compose.yaml`](./docker-compose.yaml), [`spike/neko/README.md`](./README.md), [`spike/neko/embed-demo.html`](./embed-demo.html)
