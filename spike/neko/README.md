# Spike neko/WebRTC — come lanciarlo (LAN)

Spike di validazione, non produzione. Decisione + confronto con l'alternativa
DIY: [`docs/spikes/neko-webrtc.md`](../../docs/spikes/neko-webrtc.md).

> Questi file sono stati creati SENZA avviare alcun container: `docker compose
> up` va lanciato esplicitamente dall'utente (avviare processi
> sull'ambiente è fuori scope per l'agente di questo spike).

## 1. Trova il tuo IP LAN

```bash
# macOS, Wi-Fi:
ipconfig getifaddr en0
# se sei su cavo, prova en1/en2 finché non torna un IP 192.168.x.x / 10.x.x.x
```

Copia quell'IP in `docker-compose.yaml`, campo `NEKO_WEBRTC_NAT1TO1`. Questo è
l'IP che neko annuncia nei candidate ICE ai peer — se resta sbagliato (o
`127.0.0.1`, o l'IP interno del bridge Docker) il video semplicemente non
parte: il signaling (HTTP/WS su :8080) funziona, ma il canale media no.

## 2. Avvia

```bash
cd spike/neko
docker compose up -d
```

Apri `http://<LAN-IP>:8080` da un altro device della stessa rete (o dalla
stessa macchina). Login: `neko` (utente member) o `admin`/`admin` (utente
admin — vedi sotto). **Cambia le password nel compose prima di qualunque uso
reale**, sono in chiaro nel file.

## 3. Il caveat critico: WebRTC non è HTTP

Un reverse proxy 443/TLS (nginx, Caddy, Cloudflare Tunnel, il local-CA HTTPS
di Topics) **non tunnela il canale media**. Il segnale iniziale (chi è chi,
handshake SDP) passa su HTTP/WS e un proxy va benissimo per quello; ma il
video/audio viaggia su UDP peer-to-peer (o via relay TURN), un livello di
rete che un reverse proxy applicativo non tocca. Serve quindi:

- **In LAN** (questo spike): aprire la porta UDP del mux (`59000/udp` in
  questa config) sul firewall della macchina host. Zero NAT traversal — i
  peer sono sulla stessa subnet.
- **Oltre la LAN** (internet pubblico, Tailscale in strict NAT, doppio-NAT,
  CGNAT): serve un **TURN server** reale (es. Coturn) che faccia da relay
  quando la connessione diretta peer-to-peer fallisce. Vedi il blocco
  ICESERVERS commentato in `docker-compose.yaml` e il caveat esteso in
  `docs/spikes/neko-webrtc.md` (implicazione sul relay Hetzner del task
  co-op).

## 4. Risorse

Un browser Chromium headless in Docker con encoding WebRTC live: aspettati
~1 core CPU e ~500MB-1GB RAM per sessione attiva a 1280x720@30 (varia con il
contenuto — video/canvas pesanti spingono l'encoder). `shm_size: 2gb` nel
compose evita i crash di Chromium legati allo shm di default Docker (64MB).
Non è stato misurato in questo spike (nessun container avviato) — sono cifre
di riferimento dalla documentazione neko/community, da verificare con un run
reale prima di qualsiasi capacity planning.

## 5. Credenziali di default

| Var | Default | Ruolo |
|---|---|---|
| `NEKO_PASSWORD` | `neko` | member — può richiedere il controllo, guardare in view-only |
| `NEKO_PASSWORD_ADMIN` | `admin` | admin/host — force-control, kick, lock della sessione |

Cambiale nel `docker-compose.yaml` (env in chiaro nel file — va bene per uno
spike locale, MAI per un deploy esposto).

## 6. Embed nel browser pane di Topics (path Phase-2 iframe)

`embed-demo.html` in questa cartella mostra l'iframe minimo. Nel contesto
reale di Topics, l'equivalente sarebbe una nuova variante di
`RemoteBrowserPanel.tsx` (accanto al path "localhost iframe" già esistente,
`client/src/components/Browser/RemoteBrowserPanel.tsx:447`) che punta
`src` a `http://<LAN-IP>:8080` invece che alla local dev-URL, con lo stesso
`sandbox` già in uso lì:

```
sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
```

(niente `allow-top-navigation*` — stessa ragione già commentata nel file:
un frame-buster nella pagina ospitata non deve poter nukare l'intera WKWebView
di Tauri). Questo è puro embedding visivo: **non è integrazione**, non dà a
Topics conoscenza di cosa sta facendo l'agente dentro la sessione neko (nessun
CDP, nessun `browser_act`/`browser_observe` — vedi la tabella di confronto nel
decision doc per l'impatto sulla "agent-driving compatibility").
