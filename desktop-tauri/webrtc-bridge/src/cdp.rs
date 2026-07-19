// CDP screencast producer that ATTACHES to an existing pane's target (the same page
// the JPEG-over-WS viewers see) — this is what makes the WebRTC stream the SAME live
// session, not a throwaway. It opens its own flat CDP session on the given targetId,
// starts an ack-gated JPEG screencast, and pushes each frame's bytes to `frame_tx`.
//
// Ack-gating is the crux: the next frame won't arrive until we ACK with the
// screencast-session INTEGER (params.sessionId) — NOT the CDP sessionId string.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

fn cdp_http() -> String {
    let port = std::env::var("TOPICS_CDP_PORT").ok().and_then(|s| s.parse::<u16>().ok()).unwrap_or(19222);
    format!("http://127.0.0.1:{port}")
}

/// Attaches to `target_id` and streams its JPEG screencast bytes to `frame_tx` until
/// the socket closes. Drop-on-backpressure via `try_send` keeps latency low.
pub async fn attach_and_stream(target_id: String, every_nth: u32, frame_tx: SyncSender<Vec<u8>>) -> Result<()> {
    let ver: Value = get_json(&format!("{}/json/version", cdp_http())).await?;
    let browser_ws = ver["webSocketDebuggerUrl"]
        .as_str()
        .ok_or_else(|| anyhow!("no webSocketDebuggerUrl"))?;
    eprintln!("[cdp] attach target={target_id} everyNthFrame={every_nth} via {}", ver["Browser"].as_str().unwrap_or("?"));

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
    let send_rpc = |method: &str, params: Value, session: Option<&str>| {
        let id = next_id.fetch_add(1, Ordering::SeqCst);
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        let _ = tx.send(msg.to_string());
    };

    // Attach to the existing target (flatten = messages ride the browser socket with a sessionId).
    send_rpc("Target.attachToTarget", json!({ "targetId": target_id, "flatten": true }), None);

    let b64 = base64::engine::general_purpose::STANDARD;
    let mut session_id: Option<String> = None;

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

        if session_id.is_none() && v["method"] == "Target.attachedToTarget" {
            if let Some(sid) = v["params"]["sessionId"].as_str() {
                let sid = sid.to_string();
                send_rpc("Page.enable", json!({}), Some(&sid));
                // startScreencast on a timer, decoupled from this read loop (which is
                // busy pumping frames). No navigate / no device-metrics override — we
                // take the pane exactly as Playwright configured it (shared session).
                let tx2 = tx.clone();
                let next_id2 = next_id.clone();
                let sid2 = sid.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    let id = next_id2.fetch_add(1, Ordering::SeqCst);
                    let msg = json!({ "id": id, "method": "Page.startScreencast", "sessionId": sid2,
                        "params": { "format": "jpeg", "quality": 80, "maxWidth": 2560, "maxHeight": 1440, "everyNthFrame": every_nth } });
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
                send_rpc("Page.screencastFrameAck", json!({ "sessionId": scid }), Some(sess));
            }
            if let Some(data) = v["params"]["data"].as_str() {
                if let Ok(bytes) = b64.decode(data) {
                    let _ = frame_tx.try_send(bytes); // drop if the encoder is behind
                }
            }
        }
    }

    Ok(())
}

/// Minimal HTTP GET honoring Content-Length (DevTools keeps the socket keep-alive so
/// a naive read-to-EOF hangs). Runs on a blocking thread.
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
