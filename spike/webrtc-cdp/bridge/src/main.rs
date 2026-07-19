// Stage 2 — WebRTC-over-CDP: serve the shared headless browser as an H.264 WebRTC
// video track to N browser peers. One CDP screencast → one encoder → one shared
// TrackLocalStaticSample (webrtc-rs fans it out to every PeerConnection).
//
// Signaling is a tiny hand-rolled HTTP server (GET / = test page, POST /offer = SDP
// exchange) so this stays dependency-light and self-contained for the spike.
//
// Usage: webrtc-cdp-bridge [signalPort] [targetUrl]  (needs Chromium CDP on :19222)

mod cdp;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264};
use webrtc::api::APIBuilder;
use webrtc::interceptor::registry::Registry;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    let port: u16 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(19444);
    let target_url = std::env::args().nth(2);

    // Shared H.264 track — webrtc-rs fans write_sample() out to every bound peer.
    let track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability { mime_type: MIME_TYPE_H264.to_owned(), ..Default::default() },
        "video".to_owned(),
        "webrtc-cdp".to_owned(),
    ));

    // CDP screencast → JPEG frames channel (bounded → drop-on-backpressure).
    let (frame_tx, frame_rx) = mpsc::channel::<Vec<u8>>(4);
    {
        let target_url = target_url.clone();
        tokio::spawn(async move {
            loop {
                if let Err(e) = cdp::stream_frames(target_url.clone(), 1, frame_tx.clone()).await {
                    eprintln!("[cdp] stream ended: {e} — retrying in 1s");
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    }

    // Encoder runs on a dedicated OS thread: openh264's Encoder is !Send, so it
    // must not live on the async runtime (can't be held across an .await). It feeds
    // encoded H.264 samples to an async writer that fans them onto the track.
    let (sample_tx, mut sample_rx) = mpsc::channel::<Vec<u8>>(8);
    std::thread::spawn(move || encode_thread(frame_rx, sample_tx));
    {
        let track = track.clone();
        tokio::spawn(async move {
            while let Some(data) = sample_rx.recv().await {
                let sample = Sample { data: Bytes::from(data), duration: Duration::from_millis(33), ..Default::default() };
                if let Err(e) = track.write_sample(&sample).await {
                    eprintln!("[enc] write_sample: {e}");
                }
            }
        });
    }

    // WebRTC API (built once, reused per peer).
    let api = {
        let mut m = MediaEngine::default();
        m.register_default_codecs()?;
        let mut registry = Registry::new();
        registry = register_default_interceptors(registry, &mut m)?;
        Arc::new(APIBuilder::new().with_media_engine(m).with_interceptor_registry(registry).build())
    };

    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    let lan = local_ip().unwrap_or_else(|| "127.0.0.1".into());
    eprintln!("[sig] http://{lan}:{port}/  (open on Mac AND phone on the same LAN)");

    loop {
        let (sock, _) = listener.accept().await?;
        let api = api.clone();
        let track = track.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_http(sock, api, track, port).await {
                eprintln!("[sig] conn error: {e}");
            }
        });
    }
}

/// Blocking encoder loop (own OS thread): JPEG → RGB → I420 → H.264 → sample_tx.
fn encode_thread(mut rx: mpsc::Receiver<Vec<u8>>, sample_tx: mpsc::Sender<Vec<u8>>) {
    use openh264::encoder::Encoder;
    use openh264::formats::{RgbSliceU8, YUVBuffer};
    use zune_jpeg::JpegDecoder;

    let mut encoder: Option<(Encoder, usize, usize)> = None;
    let mut frame_no: u64 = 0;
    // Periodic IDR so a late-joining viewer can sync within ~1s (no RTCP-PLI wiring
    // in this spike). One shared encoder → every peer benefits from the same keyframe.
    const IDR_EVERY: u64 = 30;

    while let Some(jpeg) = rx.blocking_recv() {
        let mut dec = JpegDecoder::new(&jpeg);
        let rgb = match dec.decode() {
            Ok(px) => px,
            Err(e) => {
                eprintln!("[enc] jpeg decode: {e}");
                continue;
            }
        };
        let (w, h) = match dec.dimensions() {
            Some((w, h)) => (w & !1, h & !1), // even dims for 4:2:0
            None => continue,
        };
        if w == 0 || h == 0 {
            continue;
        }

        let need_new = match &encoder {
            Some((_, ew, eh)) => *ew != w || *eh != h,
            None => true,
        };
        if need_new {
            // openh264 0.6: Encoder::new() auto-derives dims from the first frame.
            match Encoder::new() {
                Ok(enc) => {
                    eprintln!("[enc] encoder {w}x{h}");
                    encoder = Some((enc, w, h));
                    frame_no = 0;
                }
                Err(e) => {
                    eprintln!("[enc] create: {e}");
                    continue;
                }
            }
        }
        let (enc, _, _) = encoder.as_mut().unwrap();

        // Force a keyframe on the first frame and every IDR_EVERY frames after.
        if frame_no % IDR_EVERY == 0 {
            enc.force_intra_frame();
        }
        frame_no += 1;

        let rgb_src = RgbSliceU8::new(&rgb[..w * h * 3], (w, h));
        let yuv = YUVBuffer::from_rgb8_source(rgb_src);
        let data = match enc.encode(&yuv) {
            Ok(bs) => bs.to_vec(),
            Err(e) => {
                eprintln!("[enc] encode: {e}");
                continue;
            }
        };
        if data.is_empty() {
            continue;
        }
        if sample_tx.blocking_send(data).is_err() {
            break; // writer gone
        }
    }
}

/// Minimal HTTP/1.1: GET / → test page, POST /offer → SDP answer.
async fn handle_http(
    mut sock: TcpStream,
    api: Arc<webrtc::api::API>,
    track: Arc<TrackLocalStaticSample>,
    port: u16,
) -> Result<()> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    // Read headers (+ body for POST) — loop until we have the full Content-Length.
    let mut header_end = None;
    let mut content_len = 0usize;
    loop {
        let n = sock.read(&mut tmp).await?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
        if header_end.is_none() {
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                header_end = Some(pos + 4);
                let headers = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                for line in headers.lines() {
                    if let Some(v) = line.strip_prefix("content-length:") {
                        content_len = v.trim().parse().unwrap_or(0);
                    }
                }
            }
        }
        if let Some(he) = header_end {
            if buf.len() >= he + content_len {
                break;
            }
        }
    }
    let he = header_end.unwrap_or(buf.len());
    let head = String::from_utf8_lossy(&buf[..he]).to_string();
    let body = String::from_utf8_lossy(&buf[he..he + content_len.min(buf.len() - he)]).to_string();
    let first = head.lines().next().unwrap_or("");

    if first.starts_with("GET / ") || first.starts_with("GET /index") {
        let page = test_page(port);
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            page.len(),
            page
        );
        sock.write_all(resp.as_bytes()).await?;
        return Ok(());
    }

    if first.starts_with("POST /offer") {
        let answer = negotiate(api, track, body).await?;
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/sdp\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            answer.len(),
            answer
        );
        sock.write_all(resp.as_bytes()).await?;
        return Ok(());
    }

    sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await?;
    Ok(())
}

/// Build a PeerConnection for one viewer, attach the shared track, answer the offer.
async fn negotiate(
    api: Arc<webrtc::api::API>,
    track: Arc<TrackLocalStaticSample>,
    offer_sdp: String,
) -> Result<String> {
    // Host candidates only — on a LAN / same machine no STUN is needed, and pulling
    // in a public STUN server just slows gathering (and can't help behind NAT anyway).
    let config = RTCConfiguration::default();
    let pc = Arc::new(api.new_peer_connection(config).await?);
    pc.add_track(track as Arc<dyn TrackLocal + Send + Sync>).await?;

    pc.on_peer_connection_state_change(Box::new(|s| {
        eprintln!("[peer] state {s}");
        Box::pin(async {})
    }));

    let offer = RTCSessionDescription::offer(offer_sdp)?;
    pc.set_remote_description(offer).await?;
    let answer = pc.create_answer(None).await?;
    let mut gather = pc.gathering_complete_promise().await;
    pc.set_local_description(answer).await?;
    let _ = gather.recv().await; // non-trickle: wait for full ICE
    let local = pc.local_description().await.ok_or_else(|| anyhow::anyhow!("no local desc"))?;
    for line in local.sdp.lines().filter(|l| l.starts_with("a=candidate")) {
        eprintln!("[peer] answer {line}");
    }
    Ok(local.sdp)
}

fn test_page(_port: u16) -> String {
    format!(
        r#"<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1">
<style>html,body{{margin:0;background:#0b0f1a;color:#7aa2f7;font-family:system-ui;height:100%}}
#v{{width:100vw;height:100vh;object-fit:contain;background:#000}}
#s{{position:fixed;top:8px;left:8px;background:#0008;padding:4px 8px;border-radius:6px;font-size:12px}}</style></head>
<body><div id=s>connecting…</div><video id=v autoplay playsinline muted></video>
<script>
const s=document.getElementById('s'),v=document.getElementById('v');
(async()=>{{
  const pc=new RTCPeerConnection({{iceServers:[{{urls:'stun:stun.l.google.com:19302'}}]}});
  window.__pc=pc; // exposed for automated validation (getStats)
  pc.addTransceiver('video',{{direction:'recvonly'}});
  pc.ontrack=e=>{{v.srcObject=e.streams[0];s.textContent='track received';}};
  pc.oniceconnectionstatechange=()=>s.textContent='ice: '+pc.iceConnectionState;
  const offer=await pc.createOffer();await pc.setLocalDescription(offer);
  await new Promise(r=>{{if(pc.iceGatheringState==='complete')return r();
    pc.onicegatheringstatechange=()=>pc.iceGatheringState==='complete'&&r();}});
  const resp=await fetch('/offer',{{method:'POST',headers:{{'Content-Type':'application/sdp'}},body:pc.localDescription.sdp}});
  const answer=await resp.text();
  await pc.setRemoteDescription({{type:'answer',sdp:answer}});
}})().catch(e=>s.textContent='err: '+e.message);
</script></body></html>"#
    )
}

/// Best-effort primary LAN IPv4 (for the phone URL) — no external deps.
fn local_ip() -> Option<String> {
    use std::net::UdpSocket;
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip().to_string())
}
