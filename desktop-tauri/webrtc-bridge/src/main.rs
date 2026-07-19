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
//   bridge → server: {"t":"ready"}
//                    {"t":"answer","peer":ID,"sdp":ANSWER}
//                    {"t":"ice","peer":ID,...}            (reserved; non-trickle on LAN)
//                    {"t":"error","peer":ID,"message":M}
//
// Usage: webrtc-bridge --socket /tmp/topics-webrtc-<hash>.sock  (needs Chromium CDP :19222)

mod cdp;
mod encode;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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

/// One shared H.264 stream for a CDP target — fanned out to every peer on that target.
struct TargetStream {
    track: Arc<TrackLocalStaticSample>,
    need_keyframe: Arc<AtomicBool>,
    peers: AtomicUsize,
    cdp_abort: AbortHandle,
    writer_abort: AbortHandle,
}

struct PeerEntry {
    pc: Arc<RTCPeerConnection>,
    target: String,
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
        // Real browser clients (Chrome/Safari, incl. mobile) obfuscate their host
        // candidate as an `.local` mDNS name for privacy. QueryAndGather makes the
        // bridge both resolve the peer's mDNS candidate AND advertise its own, so ICE
        // completes on a LAN without any client-side flag. (Default QueryOnly resolves
        // but doesn't gather, and proved insufficient here.)
        let mut se = SettingEngine::default();
        se.set_ice_multicast_dns_mode(MulticastDnsMode::QueryAndGather);
        let api = APIBuilder::new()
            .with_media_engine(m)
            .with_interceptor_registry(registry)
            .with_setting_engine(se)
            .build();
        Ok(Arc::new(Self { api, targets: Mutex::new(HashMap::new()), peers: Mutex::new(HashMap::new()) }))
    }

    /// Returns the shared TargetStream for `target_id`, spawning the CDP→encoder→track
    /// pipeline the first time. Never holds the map lock across an await.
    fn get_or_create_target(self: &Arc<Self>, target_id: &str) -> Arc<TargetStream> {
        {
            let map = self.targets.lock().unwrap();
            if let Some(ts) = map.get(target_id) {
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
        let cdp_task = {
            let target_id = target_id.to_string();
            tokio::spawn(async move {
                loop {
                    if let Err(e) = cdp::attach_and_stream(target_id.clone(), 1, jpeg_tx.clone()).await {
                        eprintln!("[cdp] stream ended ({target_id}): {e} — retry in 1s");
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
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
            return existing.clone();
        }
        map.insert(target_id.to_string(), ts.clone());
        ts
    }

    /// Tears down a target's pipeline once its last peer left.
    fn drop_target(&self, target_id: &str) {
        if let Some(ts) = self.targets.lock().unwrap().remove(target_id) {
            eprintln!("[hub] target {target_id} idle — tearing down");
            ts.cdp_abort.abort();
            ts.writer_abort.abort();
        }
    }

    /// Build a PeerConnection for one viewer, attach the shared track, answer the offer.
    async fn negotiate(self: &Arc<Self>, peer: &str, target: &str, offer_sdp: String) -> Result<String> {
        let ts = self.get_or_create_target(target);

        // Host candidates only — LAN/localhost needs no STUN, and a public STUN just
        // stalls gathering (and can't traverse NAT anyway; that needs TURN).
        let pc = Arc::new(self.api.new_peer_connection(RTCConfiguration::default()).await?);
        pc.add_track(ts.track.clone() as Arc<dyn TrackLocal + Send + Sync>).await?;
        // A new viewer on an existing stream must get a keyframe to start decoding.
        ts.need_keyframe.store(true, Ordering::Relaxed);
        ts.peers.fetch_add(1, Ordering::SeqCst);

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

        self.peers.lock().unwrap().insert(peer.to_string(), PeerEntry { pc, target: target.to_string() });
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
            if let Some(ts) = self.targets.lock().unwrap().get(&entry.target).cloned() {
                if ts.peers.fetch_sub(1, Ordering::SeqCst) <= 1 {
                    self.drop_target(&entry.target);
                }
            }
            eprintln!("[peer {peer}] closed");
        }
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    let socket_path = parse_socket_arg().ok_or_else(|| anyhow!("missing --socket <path>"))?;
    let _ = std::fs::remove_file(&socket_path); // clear a stale socket
    let listener = UnixListener::bind(&socket_path)?;
    eprintln!("[webrtc-bridge] listening on {socket_path}");

    let hub = Hub::new()?;
    loop {
        let (stream, _) = listener.accept().await?;
        let hub = hub.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(stream, hub).await {
                eprintln!("[webrtc-bridge] conn error: {e}");
            }
        });
    }
}

async fn handle_conn(stream: UnixStream, hub: Arc<Hub>) -> Result<()> {
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

    let _ = out_tx.send(json!({ "t": "ready" }).to_string());

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
        tokio::spawn(async move { dispatch(hub, out_tx, v).await });
    }
    Ok(())
}

async fn dispatch(hub: Arc<Hub>, out_tx: mpsc::UnboundedSender<String>, v: Value) {
    match v["t"].as_str().unwrap_or("") {
        "offer" => {
            let peer = v["peer"].as_str().unwrap_or("").to_string();
            let target = v["target"].as_str().unwrap_or("").to_string();
            let sdp = v["sdp"].as_str().unwrap_or("").to_string();
            if peer.is_empty() || target.is_empty() || sdp.is_empty() {
                let _ = out_tx.send(json!({ "t": "error", "peer": peer, "message": "offer missing peer/target/sdp" }).to_string());
                return;
            }
            match hub.negotiate(&peer, &target, sdp).await {
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
