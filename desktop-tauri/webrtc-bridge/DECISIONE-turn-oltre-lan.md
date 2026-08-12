# TURN per la pane browser oltre la LAN: non ora, e comunque non Coturn

Stato: proposta di decisione, in attesa dell'ok umano.
Data: 2026-08-12.

La domanda era: il sidecar WebRTC gira host-only, quindi un NAT stretto lo blocca.
Serve un TURN (Coturn binario, credenziali effimere)? Prima di scrivere il codice,
va deciso se il caso esiste davvero.

La risposta corta e' no, non ora. Sotto il perche', misurato contro il codice di oggi.

## Cosa dice il codice, e non il ricordo

Una premessa del task e' scaduta. Il sidecar non usa piu' `QueryAndGather`: oggi
`daemon.rs:139` mette `MulticastDnsMode::Disabled`, e il commento sopra spiega che
non e' una scelta di raggiungibilita' ma di liveness. Con mDNS acceso webrtc-rs
apre un socket multicast per PeerConnection, il secondo peer non riesce a legarlo
e la sua raccolta di candidati non finisce mai. Era il bug del "una connessione
si', una no". Il `RTCConfiguration::default()` invece e' confermato: nessuno STUN,
nessun TURN, solo candidati host.

## Chi sta davvero oltre la LAN

Sono due figure, e vanno separate perche' una delle due non ha proprio la pane.

**L'ospite di un link condiviso non vede mai un browser remoto.**
`isGuestAllowedPath` (`server/lib/grants.ts`) e' un'allowlist, e dentro c'e' `/ws`,
non `/ws/browser/:ctx`. Per un ospite il canale di signaling non esiste. Puo'
leggere schede, chat, messaggi e media. Meta' del caso oltre-LAN e' fuori
discussione per costruzione, non per configurazione di rete.

**Il proprietario che rientra da fuori passa dal relay.** Il tunnel Tailscale e'
stato rimosso dal prodotto (`docs/PIANO-amicizia-sessioni.md`): oggi il percorso da
fuori e' il Worker piu' Durable Object in `relay/`, che tunnella anche gli upgrade
WebSocket. Chi si installa Tailscale per conto suo resta coperto senza TURN, perche'
il sidecar annuncia come candidato host anche l'IP dell'interfaccia Tailscale e il
peer dall'altra parte lo raggiunge.

## Il vicolo cieco che TURN doveva curare e' gia' curato

Su ICE fallito la pane non resta ferma sull'errore. `RemoteBrowserPanel.tsx:626`
passa da solo a co-browse DOM: il DOM ricostruito con rrweb, che viaggia sopra la
WebSocket e quindi dentro qualunque tubo porti il WebSocket, relay compreso. Il
commento in quel punto nomina per nome il sintomo che TURN avrebbe dovuto togliere,
"esce bianco" e "Sessione video non disponibile", e dice che e' stato tolto in un
altro modo. Il fallback e' one-shot per URL, quindi non entra in loop.

Il video non arriva. La sessione si', ed e' interattiva.

## Il buco che resta, e quanto e' largo

Uno c'e'. Quando rrweb non produce un FullSnapshot la modalita' DOM e' dichiarata
non supportata per quella pagina (`browser-service.ts:1760`) e il server rimanda il
client su 'video'. Il proprietario da fuori LAN, su quella pagina, resta sull'error
box con il tasto Riprova.

Quanto capita, non lo so, e non lo dichiaro. Non c'e' una misura e non c'e' una
segnalazione. E' l'unico argomento onesto a favore di TURN, ed e' un argomento che
prima va pesato.

## Se un giorno serve, la strada non e' Coturn

Coturn binario vuol dire una macchina pubblica con IP statico, un certificato TLS,
una porta UDP aperta e delle operations, dentro un prodotto che si vende come
locale. Topics sta gia' su Cloudflare per il relay, e Cloudflare Realtime TURN
copre lo stesso caso senza nessuna di quelle cose: credenziali effimere generate
via API con TTL e revoca, 0,05 dollari per GB, primi 1000 GB gratis. Il lavoro nel
sidecar sarebbe leggere gli `iceServers` dall'offer invece di
`RTCConfiguration::default()`, piu' un endpoint sul server che chiede le credenziali.

Il costo vero pero' non e' il prezzo. E' che un TURN mette un servizio gestito da
noi dentro il percorso del video. Oggi i pixel della pane non lasciano mai la
macchina dell'utente. Con TURN, quando il path diretto fallisce, ci passano tutti.
Per un'app che dice "Topics stores everything locally" e' una riga da scrivere in
PRIVACY.md, non un dettaglio di trasporto.

## Proposta

Fuori roadmap adesso. Si riapre quando arriva la prima segnalazione concreta di
pane bianca da fuori LAN su una pagina dove il co-browse DOM non regge, e in quel
caso si valuta Cloudflare Realtime TURN, non Coturn.
