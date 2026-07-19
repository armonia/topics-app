// Reusable CDP screencast producer (Stage 1 logic, extracted).
// Connects to the browser-level CDP websocket, creates+attaches a throwaway target
// (or navigates a given URL), starts an ack-gated JPEG screencast, and pushes each
// decoded JPEG frame's bytes to `frame_tx`. Ack-gating is the crux: the next frame
// won't arrive until we ACK with the screencast-session INTEGER (params.sessionId).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const CDP_HTTP: &str = "http://127.0.0.1:19222";

/// Streams JPEG frame bytes from a fresh CDP target to `frame_tx` until the socket
/// closes. `target_url` None → a CSS-animated demo page (continuous frames).
pub async fn stream_frames(
    target_url: Option<String>,
    every_nth: u32,
    frame_tx: mpsc::Sender<Vec<u8>>,
) -> Result<()> {
    let ver: Value = get_json(&format!("{CDP_HTTP}/json/version")).await?;
    let browser_ws = ver["webSocketDebuggerUrl"]
        .as_str()
        .ok_or_else(|| anyhow!("no webSocketDebuggerUrl"))?;
    eprintln!("[cdp] {} everyNthFrame={every_nth}", ver["Browser"].as_str().unwrap_or("?"));

    let (ws, _) = connect_async(browser_ws).await?;
    let (mut write, mut read) = ws.split();

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(s) = rx.recv().await {
            if write.send(Message::Text(s)).await.is_err() {
                break;
            }
        }
    });

    let next_id = Arc::new(AtomicU64::new(1));
    let rpc = {
        let tx = tx.clone();
        let next_id = next_id.clone();
        move |method: &str, params: Value, session: Option<&str>| {
            let id = next_id.fetch_add(1, Ordering::SeqCst);
            let mut msg = json!({ "id": id, "method": method, "params": params });
            if let Some(s) = session {
                msg["sessionId"] = json!(s);
            }
            let _ = tx.send(msg.to_string());
        }
    };

    let url = target_url.unwrap_or_else(animated_page);
    rpc("Target.createTarget", json!({ "url": "about:blank" }), None);

    let b64 = base64::engine::general_purpose::STANDARD;
    let mut session_id: Option<String> = None;
    let mut target_id: Option<String> = None;

    while let Some(msg) = read.next().await {
        let msg = match msg {
            Ok(Message::Text(t)) => t,
            Ok(Message::Close(_)) | Err(_) => break,
            _ => continue,
        };
        let v: Value = match serde_json::from_str(&msg) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if !v["error"].is_null() {
            eprintln!("[cdp] error: {}", v["error"]);
        }

        if target_id.is_none() {
            if let Some(tid) = v["result"]["targetId"].as_str() {
                target_id = Some(tid.to_string());
                rpc("Target.attachToTarget", json!({ "targetId": tid, "flatten": true }), None);
                continue;
            }
        }

        if session_id.is_none() && v["method"] == "Target.attachedToTarget" {
            if let Some(sid) = v["params"]["sessionId"].as_str() {
                let sid = sid.to_string();
                rpc("Page.enable", json!({}), Some(&sid));
                rpc(
                    "Emulation.setDeviceMetricsOverride",
                    json!({ "width": 1280, "height": 720, "deviceScaleFactor": 2, "mobile": false }),
                    Some(&sid),
                );
                rpc("Page.navigate", json!({ "url": url }), Some(&sid));
                // startScreencast on a timer (decoupled from the read loop).
                let tx2 = tx.clone();
                let next_id2 = next_id.clone();
                let sid2 = sid.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                    let id = next_id2.fetch_add(1, Ordering::SeqCst);
                    let msg = json!({ "id": id, "method": "Page.startScreencast", "sessionId": sid2,
                        "params": { "format": "jpeg", "quality": 70, "maxWidth": 1920, "maxHeight": 1080, "everyNthFrame": every_nth } });
                    let _ = tx2.send(msg.to_string());
                });
                session_id = Some(sid);
                continue;
            }
        }

        if v["method"] == "Page.screencastFrame" {
            if let Some(sess) = &session_id {
                // ACK first (screencast-session integer) — gates the next frame.
                let scid = v["params"]["sessionId"].clone();
                rpc("Page.screencastFrameAck", json!({ "sessionId": scid }), Some(sess));
            }
            if let Some(data) = v["params"]["data"].as_str() {
                if let Ok(bytes) = b64.decode(data) {
                    // Drop frames if the encoder is behind (keep latency low).
                    let _ = frame_tx.try_send(bytes);
                }
            }
        }
    }

    if let Some(tid) = target_id {
        rpc("Target.closeTarget", json!({ "targetId": tid }), None);
    }
    Ok(())
}

fn animated_page() -> String {
    let html = "<style>body{margin:0;background:#0b0f1a;overflow:hidden;font-family:system-ui}\
h1{color:#7aa2f7;position:absolute;top:24px;left:24px}\
.b{position:absolute;top:300px;left:0;width:120px;height:120px;border-radius:50%;\
background:hsl(0,80%,60%);animation:m 1.4s ease-in-out infinite alternate,h 3s linear infinite}\
@keyframes m{from{left:40px;top:200px}to{left:1000px;top:520px}}\
@keyframes h{to{filter:hue-rotate(360deg)}}</style>\
<h1>Topics · WebRTC-over-CDP spike</h1><div class=b></div>";
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

/// Minimal HTTP GET honoring Content-Length (DevTools keeps the socket keep-alive).
async fn get_json(url: &str) -> Result<Value> {
    let url = url.to_string();
    let body = tokio::task::spawn_blocking(move || http_get(&url)).await??;
    Ok(serde_json::from_str(&body)?)
}

fn http_get(url: &str) -> Result<String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;
    let rest = url.strip_prefix("http://").unwrap_or(url);
    let (host_port, path) = rest
        .split_once('/')
        .map(|(h, p)| (h, format!("/{p}")))
        .unwrap_or((rest, "/".into()));
    let mut stream = TcpStream::connect(host_port)?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    write!(stream, "GET {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n")?;
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
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
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
            Err(_) => break,
        }
    }
    let raw = String::from_utf8_lossy(&buf);
    Ok(raw.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("").to_string())
}
