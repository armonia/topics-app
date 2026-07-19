// Stage 1 — Rust CDP client that measures screencast throughput.
// Mirrors spike/webrtc-cdp/measure-fps.mjs in Rust to prove the async CDP pipeline
// (tokio + tungstenite) before layering webrtc-rs + H.264 encode on top.
//
// Usage: webrtc-cdp-bridge [everyNthFrame] [durationMs]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const CDP_HTTP: &str = "http://127.0.0.1:19222";

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let every_nth: u32 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(1);
    let duration_ms: u64 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(6000);

    // Discover the browser-level CDP websocket.
    let ver: Value = reqwest_get_json(&format!("{CDP_HTTP}/json/version")).await?;
    let browser_ws = ver["webSocketDebuggerUrl"].as_str().ok_or("no webSocketDebuggerUrl")?;
    eprintln!(
        "[bridge] CDP {}  everyNthFrame={every_nth}",
        ver["Browser"].as_str().unwrap_or("?")
    );

    let (ws, _) = connect_async(browser_ws).await?;
    let (mut write, mut read) = ws.split();

    // Outbound RPC channel — one writer task owns the sink.
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(s) = rx.recv().await {
            if write.send(Message::Text(s)).await.is_err() {
                break;
            }
        }
    });

    let next_id = Arc::new(AtomicU64::new(1));
    let send_rpc = {
        let tx = tx.clone();
        let next_id = next_id.clone();
        move |method: &str, params: Value, session: Option<&str>| {
            let id = next_id.fetch_add(1, Ordering::SeqCst);
            let mut msg = json!({ "id": id, "method": method, "params": params });
            if let Some(s) = session {
                msg["sessionId"] = json!(s);
            }
            let _ = tx.send(msg.to_string());
            id
        }
    };

    // Bring up a throwaway target + attach; wait for its sessionId from the stream.
    send_rpc("Target.createTarget", json!({ "url": "about:blank" }), None);

    let frames = Arc::new(AtomicU64::new(0));
    let bytes = Arc::new(AtomicU64::new(0));
    let mut first_frame: Option<Instant> = None;
    let mut last_frame = Instant::now();
    let mut session_id: Option<String> = None;
    let mut target_id: Option<String> = None;

    // Overall safety deadline so we never block forever if frames don't flow.
    let hard_deadline = tokio::time::sleep(std::time::Duration::from_millis(duration_ms + 4000));
    tokio::pin!(hard_deadline);

    loop {
        let msg = tokio::select! {
            _ = &mut hard_deadline => { eprintln!("[bridge] break: hard_deadline"); break; }
            m = read.next() => match m {
                Some(Ok(Message::Text(t))) => t,
                Some(Ok(Message::Close(c))) => { eprintln!("[bridge] break: ws Close {c:?}"); break; }
                Some(Err(e)) => { eprintln!("[bridge] break: ws Err {e}"); break; }
                None => { eprintln!("[bridge] break: stream ended (None)"); break; }
                Some(Ok(_)) => continue,
            },
        };
        let v: Value = match serde_json::from_str(&msg) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if !v["error"].is_null() {
            eprintln!("[bridge] CDP error: {}", v["error"]);
        }

        // Result of Target.createTarget → we have a targetId, now attach.
        if target_id.is_none() {
            if let Some(tid) = v["result"]["targetId"].as_str() {
                target_id = Some(tid.to_string());
                send_rpc(
                    "Target.attachToTarget",
                    json!({ "targetId": tid, "flatten": true }),
                    None,
                );
                continue;
            }
        }

        // attachedToTarget event carries the flattened sessionId.
        if session_id.is_none() {
            if let Some(sid) = v["params"]["sessionId"].as_str() {
                if v["method"] == "Target.attachedToTarget" {
                    let sid = sid.to_string();
                    send_rpc("Page.enable", json!({}), Some(&sid));
                    send_rpc(
                        "Emulation.setDeviceMetricsOverride",
                        json!({ "width": 1280, "height": 720, "deviceScaleFactor": 2, "mobile": false }),
                        Some(&sid),
                    );
                    send_rpc(
                        "Page.navigate",
                        json!({ "url": animated_page() }),
                        Some(&sid),
                    );
                    // Start the screencast on a timer (decoupled from the read loop,
                    // which would otherwise block waiting for a message that never comes).
                    let tx2 = tx.clone();
                    let next_id2 = next_id.clone();
                    let sid2 = sid.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                        let id = next_id2.fetch_add(1, Ordering::SeqCst);
                        let msg = json!({ "id": id, "method": "Page.startScreencast", "sessionId": sid2,
                            "params": { "format": "jpeg", "quality": 60, "maxWidth": 2560, "maxHeight": 1440, "everyNthFrame": every_nth } });
                        let _ = tx2.send(msg.to_string());
                    });
                    session_id = Some(sid);
                    continue;
                }
            }
        }

        // Screencast frames.
        if v["method"] == "Page.screencastFrame" {
            let now = Instant::now();
            if first_frame.is_none() {
                first_frame = Some(now);
            }
            last_frame = now;
            frames.fetch_add(1, Ordering::Relaxed);
            if let Some(data) = v["params"]["data"].as_str() {
                bytes.fetch_add((data.len() as f64 * 0.75) as u64, Ordering::Relaxed);
            }
            // ACK — screencast is ack-gated, so the next frame won't arrive until
            // this fires. `params.sessionId` is the screencast session INTEGER
            // (frame.params.sessionId), mandatory; route via the CDP page session.
            if let Some(sess) = &session_id {
                let scid = v["params"]["sessionId"].clone();
                send_rpc("Page.screencastFrameAck", json!({ "sessionId": scid }), Some(sess));
            }
        }

        if let Some(ff) = first_frame {
            if ff.elapsed().as_millis() as u64 >= duration_ms {
                break;
            }
        }
    }

    // Report.
    let f = frames.load(Ordering::Relaxed);
    let b = bytes.load(Ordering::Relaxed);
    let span = match first_frame {
        Some(ff) => (last_frame - ff).as_secs_f64().max(0.001),
        None => 1.0,
    };
    let fps = (f.saturating_sub(1)) as f64 / span;
    let kb_per_frame = if f > 0 { b as f64 / f as f64 / 1024.0 } else { 0.0 };
    let mbps = (b as f64 * 8.0) / span / 1e6;
    println!("[bridge] frames={f} span={span:.2}s => {fps:.1} fps");
    println!("[bridge] avg {kb_per_frame:.1} KB/frame  bitrate {mbps:.1} Mbps (JPEG, pre-H264)");

    if let Some(tid) = target_id {
        send_rpc("Target.closeTarget", json!({ "targetId": tid }), None);
    }
    drop(tx);
    let _ = writer.await;
    Ok(())
}

// Tiny GET-JSON without pulling reqwest: use std via a blocking helper on tokio.
async fn reqwest_get_json(url: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let url = url.to_string();
    let body = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let mut resp = ureq_get(&url).map_err(|e| e.to_string())?;
        Ok(std::mem::take(&mut resp))
    })
    .await??;
    Ok(serde_json::from_str(&body)?)
}

// Minimal HTTP GET over std TcpStream (avoids an HTTP client dep for one call).
// DevTools keeps the HTTP connection alive, so we honor Content-Length instead of
// reading to EOF (which would block), with a read timeout as a safety net.
fn ureq_get(url: &str) -> Result<String, std::io::Error> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;
    let rest = url.strip_prefix("http://").unwrap_or(url);
    let (host_port, path) = rest.split_once('/').map(|(h, p)| (h, format!("/{p}"))).unwrap_or((rest, "/".into()));
    let mut stream = TcpStream::connect(host_port)?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n"
    )?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut content_len: Option<usize> = None;
    let mut header_end: Option<usize> = None;
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if header_end.is_none() {
                    if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
                        header_end = Some(pos + 4);
                        let headers = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                        for line in headers.lines() {
                            if let Some(v) = line.strip_prefix("content-length:") {
                                content_len = v.trim().parse().ok();
                            }
                        }
                    }
                }
                if let (Some(he), Some(cl)) = (header_end, content_len) {
                    if buf.len() >= he + cl {
                        break;
                    }
                }
            }
            Err(_) => break, // timeout → whatever we have
        }
    }
    let raw = String::from_utf8_lossy(&buf);
    let body = raw.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("").to_string();
    Ok(body)
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn animated_page() -> String {
    // CSS-driven animation: the compositor keeps producing frames even when
    // requestAnimationFrame is throttled in offscreen/new-headless mode.
    let html = "<style>body{margin:0;background:#111;overflow:hidden}\
.b{position:absolute;top:320px;left:0;width:80px;height:80px;border-radius:50%;\
background:hsl(0,80%,60%);animation:m 1.2s linear infinite,h 3s linear infinite}\
@keyframes m{0%{left:0}50%{left:1160px}100%{left:0}}\
@keyframes h{0%{filter:hue-rotate(0deg)}100%{filter:hue-rotate(360deg)}}</style>\
<div class=b></div>";
    format!("data:text/html,{}", urlencode(html))
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
