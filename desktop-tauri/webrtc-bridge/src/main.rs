// WebRTC bridge daemon — serves the shared server-side headless-Chromium panes as
// H.264 WebRTC tracks. One CDP target → one screencast → one encoder → one shared
// TrackLocalStaticSample → N peers (webrtc-rs fan-out). The Bun server brokers SDP/ICE
// over a Unix socket (NDJSON), relaying between the browser client's /ws/browser WS and
// this process. See server/webrtc-bridge.ts for the server half.
//
// Protocol (NDJSON, one JSON object per line):
//   server → bridge: {"t":"offer","peer":ID,"target":CDP_TARGET_ID,"sdp":OFFER}
//                    {"t":"ice","peer":ID,"candidate":C,"sdpMid":M,"sdpMLineIndex":I}
//                    {"t":"close","peer":ID}
//   bridge → server: {"t":"ready","build":EXE_MTIME_MS}
//                    {"t":"answer","peer":ID,"sdp":ANSWER}
//                    {"t":"ice","peer":ID,...}            (reserved; non-trickle on LAN)
//                    {"t":"error","peer":ID,"message":M}
//
// Usage: webrtc-bridge --socket /tmp/topics-webrtc-<hash>.sock  (needs Chromium CDP :19222)

mod cdp;
mod encode;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use bytes::Bytes;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264};
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::{APIBuilder, API};
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::interceptor::registry::Registry;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

/// Nessuna connessione viva da tanto così = siamo un orfano, si esce.
///
/// Il broker è UNO e ci parla in continuazione: se per cinque minuti non c'è
/// nessuno attaccato al socket, il server che ci ha generato è morto e non
/// tornerà — è reparentato a PID 1 il processo, non il legame. Restare vivi non
/// serve a nessuno e costa: il produttore CDP continua a ritentare, il canale
/// JPEG a girare, e ci si ritrova col caso osservato di un sidecar orfano da sei
/// giorni al 42% di CPU. Uscire è gratis perché `ensure()` (server/webrtc-bridge.ts)
/// rigenera il sidecar al primo offer che serve davvero.
const IDLE_EXIT_SECS: u64 = 300;

/// Epoch in secondi dell'ultimo momento in cui il socket aveva un padrone.
static LAST_ACTIVITY: AtomicU64 = AtomicU64::new(0);
/// Connessioni broker attualmente aperte (praticamente sempre 0 o 1).
static LIVE_CONNS: AtomicUsize = AtomicUsize::new(0);

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// mtime in ms del nostro stesso eseguibile: l'identità della BUILD che sta
/// girando. Va nel `ready`, così il server può accorgersi di aver adottato un
/// sidecar più vecchio del binario che spedirebbe lui — che è esattamente ciò
/// che succede a un orfano, visto che risponde al socket e quindi supera il
/// `tryConnect()` che avrebbe dovuto innescarne la mietitura.
fn exe_stamp() -> u64 {
    std::env::current_exe()
        .and_then(std::fs::metadata)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// One shared H.264 stream for a CDP target — fanned out to every peer on that target.
struct TargetStream {
    track: Arc<TrackLocalStaticSample>,
    need_keyframe: Arc<AtomicBool>,
    /// Refcount degli spettatori. Si incrementa in `acquire_target` e si
    /// decrementa in `release_target`, entrambi sotto il lock di `targets`: è
    /// quel lock a renderlo un refcount vero e non un contatore ottimistico.
    peers: AtomicUsize,
    cdp_abort: AbortHandle,
    writer_abort: AbortHandle,
}

struct PeerEntry {
    pc: Arc<RTCPeerConnection>,
    target: String,
    /// La connessione broker che ha creato questo peer. Quando quella cade, i
    /// suoi peer non hanno più nessuno che possa chiuderli: li chiude l'EOF.
    conn: u64,
}

struct Hub {
    api: API,
    targets: Mutex<HashMap<String, Arc<TargetStream>>>,
    peers: Mutex<HashMap<String, PeerEntry>>,
}

impl Hub {
    fn new() -> Result<Arc<Self>> {
        let mut m = MediaEngine::default();
        m.register_default_codecs()?;
        let mut registry = Registry::new();
        registry = register_default_interceptors(registry, &mut m)?;
        // mDNS mode = Disabled (server-side sidecar). Two reasons:
        //  1. Correctness/liveness: webrtc-rs binds an mDNS multicast socket (UDP 5353)
        //     per PeerConnection when mDNS is on. The SECOND concurrent/sequential peer
        //     then fails to bind and its `gathering_complete_promise()` never resolves —
        //     negotiate() hangs forever, no answer, and the bridge looks wedged (this was
        //     the "every other connection times out" bug). Disabled binds nothing shared,
        //     so N peers negotiate independently.
        //  2. Reachability: as a server on the LAN/localhost we advertise our REAL host
        //     IP candidates (not obfuscated `.local`). A viewer connects straight to that
        //     routable address; even when the viewer offers only privacy `.local`
        //     candidates we can't resolve, its STUN binding request reaches us and we
        //     learn its address peer-reflexively. No STUN/TURN needed on a LAN.
        let mut se = SettingEngine::default();
        se.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);
        let api = APIBuilder::new()
            .with_media_engine(m)
            .with_interceptor_registry(registry)
            .with_setting_engine(se)
            .build();
        Ok(Arc::new(Self { api, targets: Mutex::new(HashMap::new()), peers: Mutex::new(HashMap::new()) }))
    }

    /// Returns the shared TargetStream for `target_id`, spawning the CDP→encoder→track
    /// pipeline the first time. Never holds the map lock across an await.
    ///
    /// Prende anche UNA quota del refcount: chi chiama DEVE rilasciarla con
    /// `release_target`, sia quando il peer se ne va sia quando la negoziazione
    /// fallisce a metà. Contare qui, e non a negoziazione riuscita, è la
    /// differenza fra un pipeline che muore col suo ultimo spettatore e uno che
    /// resta a codificare per sempre: la vecchia versione incrementava dopo un
    /// paio di `await` fallibili, e ogni offer andato storto lasciava dietro un
    /// target con zero peer e il produttore CDP vivo.
    fn acquire_target(self: &Arc<Self>, target_id: &str) -> Arc<TargetStream> {
        {
            let map = self.targets.lock().unwrap();
            if let Some(ts) = map.get(target_id) {
                ts.peers.fetch_add(1, Ordering::SeqCst);
                return ts.clone();
            }
        }

        let track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability { mime_type: MIME_TYPE_H264.to_owned(), ..Default::default() },
            "video".to_owned(),
            format!("webrtc-cdp-{target_id}"),
        ));
        let need_keyframe = Arc::new(AtomicBool::new(true));

        // JPEG frames (CDP → encoder). sync_channel(2) = drop-on-backpressure.
        let (jpeg_tx, jpeg_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(2);
        // Encoded H.264 samples (encoder → writer).
        let (sample_tx, mut sample_rx) = mpsc::channel::<Vec<u8>>(8);

        {
            let nk = need_keyframe.clone();
            std::thread::spawn(move || encode::encode_thread(jpeg_rx, sample_tx, nk));
        }

        let writer = {
            let track = track.clone();
            tokio::spawn(async move {
                while let Some(data) = sample_rx.recv().await {
                    let sample = Sample { data: Bytes::from(data), duration: Duration::from_millis(33), ..Default::default() };
                    if let Err(e) = track.write_sample(&sample).await {
                        eprintln!("[enc] write_sample: {e}");
                    }
                }
            })
        };

        // CDP producer with a retry loop (Chromium may relaunch; the pane may not exist yet).
        // Backoff esponenziale 1s→30s: il caso normale è una manciata di tentativi mentre
        // Chromium riparte, ma se il target non tornerà MAI (pane chiusa, Chromium spento)
        // ritentare una volta al secondo per ore è solo CPU bruciata per niente. Ogni
        // stream riuscito riazzera l'attesa, così una riconnessione vera resta immediata.
        //
        // …e dopo CDP_GIVE_UP di fallimenti CONSECUTIVI il pipeline si smonta da solo.
        // Senza resa, un target sparito lasciava dietro per sempre un thread encoder,
        // una task writer e una track: misurati 8 pipeline orfane e 676.317 righe di
        // "[cdp] stream ended" — il 92% di un log di errore da 70MB, dentro cui gli
        // errori VERI erano introvabili. Cinque minuti di "Connection refused" di fila
        // vogliono dire che la porta CDP non ascolta più: quel target_id non torna
        // (a Chromium riavviato i target hanno id nuovi). Rimuovendosi dalla mappa il
        // sistema resta auto-riparante — la prossima offer ricrea il pipeline da zero —
        // e lo spettatore rimasto vede il video fermo esattamente come già oggi, ma
        // senza risorse appese dietro.
        let cdp_task = {
            let target_id = target_id.to_string();
            let hub = Arc::downgrade(self);
            tokio::spawn(async move {
                const CDP_GIVE_UP: Duration = Duration::from_secs(300);
                let mut backoff = Duration::from_secs(1);
                let mut dry = Duration::ZERO;
                let mut last_err: Option<String> = None;
                loop {
                    match cdp::attach_and_stream(target_id.clone(), 1, jpeg_tx.clone()).await {
                        Ok(()) => {
                            backoff = Duration::from_secs(1);
                            dry = Duration::ZERO;
                            last_err = None;
                        }
                        Err(e) => {
                            // Logga solo quando l'errore CAMBIA: un target sparito ripete
                            // la stessa riga per settimane e seppellisce tutto il resto.
                            let msg = e.to_string();
                            if last_err.as_deref() != Some(msg.as_str()) {
                                eprintln!("[cdp] stream ended ({target_id}): {msg} — retry in {backoff:?}");
                                last_err = Some(msg);
                            }
                            dry += backoff;
                            if dry >= CDP_GIVE_UP {
                                eprintln!(
                                    "[cdp] target {target_id} irraggiungibile da {CDP_GIVE_UP:?} — smonto il pipeline"
                                );
                                // Fuori dalla mappa: la prossima offer ne costruisce uno nuovo.
                                // `release_target` regge la rimozione anticipata (confronta
                                // per Arc::ptr_eq e non trova più questo target).
                                if let Some(hub) = hub.upgrade() {
                                    hub.targets.lock().unwrap().remove(&target_id);
                                }
                                // Uscendo si droppa `jpeg_tx`: il thread encoder chiude, con
                                // lui `sample_tx`, e la task writer termina da sola.
                                return;
                            }
                        }
                    }
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(30));
                }
            })
        };

        let ts = Arc::new(TargetStream {
            track,
            need_keyframe,
            peers: AtomicUsize::new(0),
            cdp_abort: cdp_task.abort_handle(),
            writer_abort: writer.abort_handle(),
        });

        let mut map = self.targets.lock().unwrap();
        // Double-check: another offer may have created it while we built ours.
        if let Some(existing) = map.get(target_id) {
            ts.cdp_abort.abort();
            ts.writer_abort.abort();
            existing.peers.fetch_add(1, Ordering::SeqCst);
            return existing.clone();
        }
        ts.peers.fetch_add(1, Ordering::SeqCst);
        map.insert(target_id.to_string(), ts.clone());
        ts
    }

    /// Restituisce la quota presa da `acquire_target` e, se era l'ultima, smonta
    /// il pipeline. Il decremento avviene sotto il lock di `targets` — lo stesso
    /// di `acquire_target` — così un peer che entra mentre l'ultimo esce non può
    /// ritrovarsi con un target appena abortito.
    fn release_target(&self, target_id: &str, ts: &Arc<TargetStream>) {
        let mut map = self.targets.lock().unwrap();
        if ts.peers.fetch_sub(1, Ordering::SeqCst) > 1 {
            return;
        }
        // Rimuovi solo se nella mappa c'è ancora QUESTO pipeline: un target con
        // lo stesso id può essere già stato ricreato da un altro spettatore.
        if map.get(target_id).map(|cur| Arc::ptr_eq(cur, ts)).unwrap_or(false) {
            map.remove(target_id);
        }
        drop(map);
        eprintln!("[hub] target {target_id} idle — tearing down");
        ts.cdp_abort.abort();
        ts.writer_abort.abort();
    }

    /// Build a PeerConnection for one viewer, attach the shared track, answer the offer.
    ///
    /// Ogni uscita da qui deve essere bilanciata: presa la quota del target,
    /// o la si consegna al `PeerEntry` (successo) o la si restituisce (errore).
    async fn negotiate(self: &Arc<Self>, peer: &str, target: &str, offer_sdp: String, conn: u64) -> Result<String> {
        let ts = self.acquire_target(target);
        match self.negotiate_inner(&ts, peer, target, offer_sdp, conn).await {
            Ok(sdp) => Ok(sdp),
            Err(e) => {
                self.release_target(target, &ts);
                Err(e)
            }
        }
    }

    async fn negotiate_inner(
        self: &Arc<Self>,
        ts: &Arc<TargetStream>,
        peer: &str,
        target: &str,
        offer_sdp: String,
        conn: u64,
    ) -> Result<String> {
        // Host candidates only — LAN/localhost needs no STUN, and a public STUN just
        // stalls gathering (and can't traverse NAT anyway; that needs TURN).
        let pc = Arc::new(self.api.new_peer_connection(RTCConfiguration::default()).await?);
        pc.add_track(ts.track.clone() as Arc<dyn TrackLocal + Send + Sync>).await?;
        // A new viewer on an existing stream must get a keyframe to start decoding.
        ts.need_keyframe.store(true, Ordering::Relaxed);

        {
            let peer_id = peer.to_string();
            pc.on_peer_connection_state_change(Box::new(move |s| {
                eprintln!("[peer {peer_id}] pc-state {s}");
                Box::pin(async {})
            }));
        }
        {
            let peer_id = peer.to_string();
            pc.on_ice_connection_state_change(Box::new(move |s| {
                eprintln!("[peer {peer_id}] ice-state {s}");
                Box::pin(async {})
            }));
        }

        let offer_cands = offer_sdp.lines().filter(|l| l.starts_with("a=candidate")).count();
        eprintln!("[peer {peer}] offer with {offer_cands} candidate(s)");
        let offer = RTCSessionDescription::offer(offer_sdp)?;
        pc.set_remote_description(offer).await?;
        let answer = pc.create_answer(None).await?;
        let mut gather = pc.gathering_complete_promise().await;
        pc.set_local_description(answer).await?;
        let _ = gather.recv().await; // non-trickle: wait for full ICE gathering
        let local = pc.local_description().await.ok_or_else(|| anyhow!("no local desc"))?;
        let cands = local.sdp.lines().filter(|l| l.starts_with("a=candidate")).count();
        eprintln!("[peer {peer}] answer with {cands} candidate(s)");

        let prev = self
            .peers
            .lock()
            .unwrap()
            .insert(peer.to_string(), PeerEntry { pc, target: target.to_string(), conn });
        // Ri-negoziazione sullo stesso peer id (il client rifà l'offer dopo una
        // caduta ICE): la PeerConnection vecchia va chiusa e la sua quota resa,
        // altrimenti resta appesa a un target che nessuno guarda più.
        if let Some(old) = prev {
            let _ = old.pc.close().await;
            let old_ts = self.targets.lock().unwrap().get(&old.target).cloned();
            if let Some(old_ts) = old_ts {
                self.release_target(&old.target, &old_ts);
            }
        }
        Ok(local.sdp)
    }

    async fn add_ice(&self, peer: &str, cand: RTCIceCandidateInit) {
        let pc = self.peers.lock().unwrap().get(peer).map(|e| e.pc.clone());
        if let Some(pc) = pc {
            if let Err(e) = pc.add_ice_candidate(cand).await {
                eprintln!("[peer {peer}] add_ice: {e}");
            }
        }
    }

    async fn close_peer(self: &Arc<Self>, peer: &str) {
        let entry = self.peers.lock().unwrap().remove(peer);
        if let Some(entry) = entry {
            let _ = entry.pc.close().await;
            // Was this the last peer on its target? Tear the pipeline down if so.
            // IMPORTANT: bind the clone to a `let` so the targets MutexGuard is dropped
            // HERE — `if let Some(ts) = self.targets.lock()...cloned() { … }` would hold
            // the guard for the whole block, and release_target() re-locks targets. A
            // std::sync::Mutex is NOT reentrant, so that self-deadlocks the targets map:
            // the first peer to disconnect would then wedge every subsequent negotiation
            // (acquire_target blocks on lock() forever) until the sidecar is killed.
            let ts = self.targets.lock().unwrap().get(&entry.target).cloned();
            if let Some(ts) = ts {
                self.release_target(&entry.target, &ts);
            }
            eprintln!("[peer {peer}] closed");
        }
    }

    /// Il broker se n'è andato: chiude tutti i peer che aveva aperto.
    ///
    /// Senza questo, un riavvio del server lascia dietro peer registrati per
    /// sempre — nessuno manderà mai il loro `close`, perché chi lo avrebbe
    /// mandato è il processo appena morto. Ogni peer fantasma tiene in vita il
    /// suo target, e il target tiene in vita cattura CDP + encoder: è così che
    /// un sidecar arriva a girare per giorni al 40% di CPU senza uno spettatore.
    async fn close_conn(self: &Arc<Self>, conn: u64) {
        let ids: Vec<String> = self
            .peers
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, e)| e.conn == conn)
            .map(|(id, _)| id.clone())
            .collect();
        if ids.is_empty() {
            return;
        }
        eprintln!("[hub] conn {conn} gone — closing {} orphaned peer(s)", ids.len());
        for id in ids {
            self.close_peer(&id).await;
        }
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    let socket_path = parse_socket_arg().ok_or_else(|| anyhow!("missing --socket <path>"))?;
    let _ = std::fs::remove_file(&socket_path); // clear a stale socket
    let listener = UnixListener::bind(&socket_path)?;
    eprintln!("[webrtc-bridge] listening on {socket_path}");

    LAST_ACTIVITY.store(now_secs(), Ordering::SeqCst);
    spawn_idle_watchdog(socket_path.clone());

    let hub = Hub::new()?;
    let mut next_conn: u64 = 0;
    loop {
        let (stream, _) = listener.accept().await?;
        next_conn += 1;
        let conn = next_conn;
        let hub = hub.clone();
        tokio::spawn(async move {
            LIVE_CONNS.fetch_add(1, Ordering::SeqCst);
            let res = handle_conn(stream, hub.clone(), conn).await;
            // Sempre, anche su errore di lettura: il broker non c'è più, e i peer
            // che aveva aperto non hanno più nessuno che li chiuda.
            hub.close_conn(conn).await;
            LIVE_CONNS.fetch_sub(1, Ordering::SeqCst);
            LAST_ACTIVITY.store(now_secs(), Ordering::SeqCst);
            if let Err(e) = res {
                eprintln!("[webrtc-bridge] conn error: {e}");
            }
        });
    }
}

/// Esce se restiamo senza padrone per `IDLE_EXIT_SECS`. Vedi la costante.
fn spawn_idle_watchdog(socket_path: String) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            if LIVE_CONNS.load(Ordering::SeqCst) > 0 {
                LAST_ACTIVITY.store(now_secs(), Ordering::SeqCst);
                continue;
            }
            let idle = now_secs().saturating_sub(LAST_ACTIVITY.load(Ordering::SeqCst));
            if idle >= IDLE_EXIT_SECS {
                eprintln!("[webrtc-bridge] nessun broker da {idle}s — esco");
                // Via il socket: lasciarlo lì fa fallire il `connect()` del prossimo
                // server con ECONNREFUSED invece che con ENOENT. Stesso esito (si
                // rigenera), ma senza lasciare in giro un file che sembra vivo.
                let _ = std::fs::remove_file(&socket_path);
                std::process::exit(0);
            }
        }
    });
}

async fn handle_conn(stream: UnixStream, hub: Arc<Hub>, conn: u64) -> Result<()> {
    let (rd, mut wr) = stream.into_split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();

    // Writer task: serialize outgoing NDJSON lines.
    tokio::spawn(async move {
        while let Some(line) = out_rx.recv().await {
            if wr.write_all(line.as_bytes()).await.is_err() || wr.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    let _ = out_tx.send(json!({ "t": "ready", "build": exe_stamp() }).to_string());

    let mut lines = BufReader::new(rd).lines();
    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[webrtc-bridge] bad json: {e}");
                continue;
            }
        };
        let hub = hub.clone();
        let out_tx = out_tx.clone();
        // Handle each message concurrently so a slow negotiation can't block the read loop.
        tokio::spawn(async move { dispatch(hub, out_tx, v, conn).await });
    }
    Ok(())
}

async fn dispatch(hub: Arc<Hub>, out_tx: mpsc::UnboundedSender<String>, v: Value, conn: u64) {
    match v["t"].as_str().unwrap_or("") {
        "offer" => {
            let peer = v["peer"].as_str().unwrap_or("").to_string();
            let target = v["target"].as_str().unwrap_or("").to_string();
            let sdp = v["sdp"].as_str().unwrap_or("").to_string();
            if peer.is_empty() || target.is_empty() || sdp.is_empty() {
                let _ = out_tx.send(json!({ "t": "error", "peer": peer, "message": "offer missing peer/target/sdp" }).to_string());
                return;
            }
            match hub.negotiate(&peer, &target, sdp, conn).await {
                Ok(answer) => {
                    let _ = out_tx.send(json!({ "t": "answer", "peer": peer, "sdp": answer }).to_string());
                }
                Err(e) => {
                    eprintln!("[peer {peer}] negotiate failed: {e}");
                    let _ = out_tx.send(json!({ "t": "error", "peer": peer, "message": e.to_string() }).to_string());
                }
            }
        }
        "ice" => {
            let peer = v["peer"].as_str().unwrap_or("").to_string();
            let candidate = v["candidate"].as_str().unwrap_or("").to_string();
            if peer.is_empty() || candidate.is_empty() {
                return;
            }
            let cand = RTCIceCandidateInit {
                candidate,
                sdp_mid: v["sdpMid"].as_str().map(|s| s.to_string()),
                sdp_mline_index: v["sdpMLineIndex"].as_u64().map(|n| n as u16),
                ..Default::default()
            };
            hub.add_ice(&peer, cand).await;
        }
        "close" => {
            if let Some(peer) = v["peer"].as_str() {
                hub.close_peer(peer).await;
            }
        }
        other => eprintln!("[webrtc-bridge] unknown message t={other}"),
    }
}

fn parse_socket_arg() -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--socket" {
            return args.next();
        }
        if let Some(rest) = a.strip_prefix("--socket=") {
            return Some(rest.to_string());
        }
    }
    None
}
