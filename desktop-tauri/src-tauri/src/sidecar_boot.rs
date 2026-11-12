//! Sidecar and boot: loopback proxy, upstream decision, bundled server spawn,
//! updater commands, dev disk-serve and the asset protocol.
//! Moved out of lib.rs verbatim.

use super::*;

/// Loopback port the WKWebView reaches the data server through (plain HTTP/WS).
/// FIXED — the client hardcodes this (client/src/lib/shell/net.ts DESKTOP_SERVER_HOST),
/// so a SINGLE webview target works whether the upstream is the external launchd
/// server (TLS :3333) or our own bundled sidecar (plain HTTP on an ephemeral port).
pub(crate) const PROXY_PORT: u16 = 13333;
/// The external (launchd / dev) data server. When one is already listening here
/// the shell defers to it and never spawns the sidecar (Attilio's box).
pub(crate) const DEFAULT_UPSTREAM_PORT: u16 = 3333;

/// Where the loopback proxy pipes to, decided ONCE at boot by `decide_upstream`:
/// either the external server on :3333 (TLS) or the sidecar we spawned (plain HTTP
/// on `port`). The proxy reads this after it's set; `tls=false` skips the TLS
/// origination and pipes raw TCP straight through.
#[derive(Clone, Copy)]
pub(crate) struct Upstream {
    /// WHICH loopback address, and it is not decoration: an IPv4 squatter on
    /// `127.0.0.1:3333` coexists with the daemon's `[::]:3333` bind, so piping to
    /// "port 3333" without saying which address is how the window ended up
    /// talking to a stranger's dashboard. This is the address that ANSWERED.
    pub(crate) host: Loopback,
    pub(crate) port: u16,
    pub(crate) tls: bool,
}
pub(crate) static UPSTREAM: std::sync::OnceLock<Upstream> = std::sync::OnceLock::new();

/// Probe 127.0.0.1:port for a live Topics server. Sends a minimal HTTP/1.0 GET to
/// the unauthenticated-shape `/__daemon/healthz` route; ANY HTTP status line back
/// (even 401 — the server is up, just rejecting our tokenless probe) proves a
/// server is listening and speaking HTTP, which is all we need to defer to it.
/// `tls` picks plain vs TLS-originated origination (the external server serves TLS).
/// Returns true on a readable HTTP response within a short timeout.
pub(crate) async fn probe_topics_server(host: Loopback, port: u16, tls: bool) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let connect = TcpStream::connect((host.host(), port));
    let stream = match tokio::time::timeout(std::time::Duration::from_millis(800), connect).await {
        Ok(Ok(s)) => s,
        _ => return false,
    };
    let req = b"GET /__daemon/healthz HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    // Read just enough to see a status line.
    async fn round_trip<S>(mut s: S, req: &[u8]) -> bool
    where
        S: AsyncReadExt + AsyncWriteExt + Unpin,
    {
        if s.write_all(req).await.is_err() {
            return false;
        }
        let mut buf = [0u8; 64];
        match s.read(&mut buf).await {
            Ok(n) if n > 0 => buf.get(..5) == Some(b"HTTP/"),
            _ => false,
        }
    }
    let fut = async {
        if tls {
            let connector = match native_tls::TlsConnector::builder()
                .danger_accept_invalid_certs(true)
                .danger_accept_invalid_hostnames(true)
                .build()
            {
                Ok(c) => tokio_native_tls::TlsConnector::from(c),
                Err(_) => return false,
            };
            match connector.connect(host.host(), stream).await {
                Ok(tls_stream) => round_trip(tls_stream, req).await,
                Err(_) => false,
            }
        } else {
            round_trip(stream, req).await
        }
    };
    tokio::time::timeout(std::time::Duration::from_millis(1500), fut)
        .await
        .unwrap_or(false)
}

/// Ask one address and port who is there, in as few connections as possible.
///
/// First a bare TCP connection, for one reason: if nothing is listening, that
/// single refusal settles both schemes at once. Trying TLS and then plain HTTP
/// against a port with no listener is two refusals for one fact, and on Windows a
/// refusal costs ~0.83s (measured 2026-08-28). Only once something IS listening
/// do we spend a real probe, TLS first because production serves TLS.
pub(crate) async fn probe_port(host: Loopback, port: u16) -> PortAnswer {
    let connect = tokio::net::TcpStream::connect((host.host(), port));
    let listening = tokio::time::timeout(std::time::Duration::from_millis(800), connect).await;
    match listening {
        // CLOSED IMMEDIATELY, and the `drop` is the whole point of writing this
        // as a statement. A server that handles ONE connection at a time (the
        // Python `socketserver.TCPServer` an account switcher is built on) accepts
        // our test connection and then answers nobody while we hold it: the shape
        // probes that follow time out, the stranger reads as silence, and the
        // shell sits for 222s pointed at the wrong address (measured 2026-09-14).
        // We only wanted to know that somebody is listening.
        Ok(Ok(stream)) => drop(stream),
        _ => return PortAnswer { verdict: ShapeVerdict::NoAnswer, tls: false },
    }
    for tls in [true, false] {
        let verdict = probe_topics_shape(host, port, tls).await;
        if verdict != ShapeVerdict::NoAnswer {
            return PortAnswer { verdict, tls };
        }
    }
    PortAnswer { verdict: ShapeVerdict::NoAnswer, tls: false }
}

/// SHAPE-AWARE probe: `Topics` only if `127.0.0.1:<port>/api/system/presence` answers
/// with a Topics daemon's body — the JSON object carrying the numeric
/// `openSessions` AND `workingSessions` fields. This is the exact shape the daemon
/// emits and the shape `port-squatter.ts`/`daemon-state.ts` both key on; an
/// unrelated process squatting the port answers `200 text/html` for that path,
/// which has no such fields and is therefore REJECTED. The old `probe_topics_server`
/// accepted ANY HTTP status line, which is precisely how the shell deferred to the
/// "account-switcher" dashboard on :3333 (2026-09-12) instead of the real daemon.
///
/// The route is unauthenticated on loopback (no Origin header → the origin gate
/// passes) and cheap (three indexed COUNTs), so it is safe to probe repeatedly.
/// `tls` picks TLS-originated origination (the external :3333 server serves TLS).
pub(crate) async fn probe_topics_shape(host: Loopback, port: u16, tls: bool) -> ShapeVerdict {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    const REQ: &str =
        "GET /api/system/presence HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";

    async fn round_trip<S>(mut s: S) -> ShapeVerdict
    where
        S: AsyncReadExt + AsyncWriteExt + Unpin,
    {
        if s.write_all(REQ.as_bytes()).await.is_err() {
            return ShapeVerdict::NoAnswer;
        }
        // Read up to 2 KiB: status line + headers + body. The body is a few dozen
        // bytes of JSON, so this comfortably covers it and the shape check below
        // parses only the part present.
        let mut buf = [0u8; 2048];
        let n = match s.read(&mut buf).await {
            Ok(n) => n,
            _ => return ShapeVerdict::NoAnswer,
        };
        if n < 5 || &buf[..5] != b"HTTP/" {
            return ShapeVerdict::NoAnswer;
        }
        let text = String::from_utf8_lossy(&buf[..n]).to_string();
        let status = text
            .split_whitespace()
            .nth(1)
            .and_then(|c| c.parse::<u16>().ok())
            .unwrap_or(0);
        // Split headers from body at the first blank line, then the body.
        let body = text.split("\r\n\r\n").nth(1).unwrap_or("").trim();
        let ours = match serde_json::from_str::<serde_json::Value>(body) {
            Ok(v) if v.is_object() => {
                v.get("openSessions").and_then(|x| x.as_i64()).is_some()
                    && v.get("workingSessions").and_then(|x| x.as_i64()).is_some()
            }
            _ => false,
        };
        if ours {
            return ShapeVerdict::Topics;
        }
        // ONLY A COMPLETE, SUCCESSFUL, NON-TOPICS ANSWER PROVES A STRANGER. A
        // 401, a 502 or a 503 is an answer we cannot read the owner from, and
        // reading a stranger into it is how a loaded Topics gets replaced by an
        // empty sidecar. Uncertain is not foreign.
        if (200..300).contains(&status) {
            ShapeVerdict::Foreign
        } else {
            ShapeVerdict::NoAnswer
        }
    }

    let connect = TcpStream::connect((host.host(), port));
    let stream = match tokio::time::timeout(std::time::Duration::from_millis(800), connect).await {
        Ok(Ok(s)) => s,
        _ => return ShapeVerdict::NoAnswer,
    };
    let fut = async {
        if tls {
            let connector = match native_tls::TlsConnector::builder()
                .danger_accept_invalid_certs(true)
                .danger_accept_invalid_hostnames(true)
                .build()
            {
                Ok(c) => tokio_native_tls::TlsConnector::from(c),
                Err(_) => return ShapeVerdict::NoAnswer,
            };
            match connector.connect(host.host(), stream).await {
                Ok(tls_stream) => round_trip(tls_stream).await,
                Err(_) => ShapeVerdict::NoAnswer,
            }
        } else {
            round_trip(stream).await
        }
    };
    tokio::time::timeout(std::time::Duration::from_millis(1500), fut)
        .await
        .unwrap_or(ShapeVerdict::NoAnswer)
}

/// How long a NON-document connection (XHR, SSE, WebSocket) waits for the upstream
/// to come back before we give up on it. A `launchctl kickstart -k` of the external
/// server is down for ~2s; holding the connection open across that gap means the
/// running app never sees the outage at all.
pub(crate) const UPSTREAM_GRACE: std::time::Duration = std::time::Duration::from_secs(15);
/// Same, for a DOCUMENT navigation. Much shorter: we have something better than
/// waiting — the reconnect page, which paints immediately and reloads itself.
pub(crate) const UPSTREAM_GRACE_DOC: std::time::Duration = std::time::Duration::from_secs(3);

/// Read an HTTP request head (everything up to the blank line) off `s`, with a cap
/// and a timeout. Returns the bytes actually read — they MUST be replayed to the
/// upstream once we connect, since they're already out of the socket. An empty
/// return means the peer opened a connection and said nothing yet (speculative
/// preconnect): we then pipe blind, exactly like before.
pub(crate) async fn read_request_head(s: &mut tokio::net::TcpStream) -> Vec<u8> {
    use tokio::io::AsyncReadExt;
    let mut head = Vec::with_capacity(1024);
    let mut buf = [0u8; 1024];
    let deadline = std::time::Duration::from_millis(2000);
    let fut = async {
        loop {
            match s.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    head.extend_from_slice(&buf[..n]);
                    // A TLS handshake has no blank line to wait for: without this
                    // the caller would sit here for the whole timeout before it
                    // could hang up on a client that came to the wrong port.
                    if is_tls_client_hello(&head) {
                        break;
                    }
                    if head.windows(4).any(|w| w == b"\r\n\r\n") || head.len() >= 16 * 1024 {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    };
    let _ = tokio::time::timeout(deadline, fut).await;
    head
}

/// Is this a TLS `ClientHello` instead of an HTTP request?
///
/// THE BUG THIS EXISTS FOR (board card cbfd6248, 2026-09-04). The proxy listens
/// in the CLEAR on :13333 and originates the TLS itself. A browser opening a
/// deep link like `http://127.0.0.1:13333/tab/chat/<id>` does not always speak
/// clear HTTP though: with HTTPS-First / HSTS-style upgrading it retries the
/// same authority over TLS, and what lands on this socket is a handshake
/// record, not a request line.
///
/// Piped as if it were a request, those bytes reached the upstream, which
/// answered a plain-HTTP `400` that the browser could not read as TLS: an
/// address of the app that hands back a blob, i.e. the browser offering to SAVE
/// the deep link as a file. Closing instead is what a port that does not speak
/// TLS is supposed to do, and it is what makes the browser fall back to the
/// clear `http://` it was given.
///
/// The shape is fixed by RFC 8446 §5.1: content type `0x16` (handshake) then a
/// legacy record version of `0x03 0x0X`. Cheap, and no HTTP method starts with
/// a control byte, so it can never swallow a real request.
pub(crate) fn is_tls_client_hello(head: &[u8]) -> bool {
    matches!(head, [0x16, 0x03, ..])
}

/// Is this request head a WebSocket upgrade? Those must never be answered with an
/// HTML body — the client would just log a handshake error. We let them fail.
pub(crate) fn is_websocket_head(head: &[u8]) -> bool {
    let s = String::from_utf8_lossy(head).to_ascii_lowercase();
    s.contains("upgrade: websocket")
}

/// Is this request head a top-level DOCUMENT navigation? That's the one case where
/// a dead upstream turns into "the window is empty": a transparent, titlebar-less
/// window whose webview has nothing to paint is INVISIBLE, not white. Detected from
/// `Sec-Fetch-Dest: document` (WebKit always sends it) with an `Accept: text/html`
/// fallback for anything that doesn't.
pub(crate) fn is_document_head(head: &[u8]) -> bool {
    let s = String::from_utf8_lossy(head).to_ascii_lowercase();
    if is_websocket_head(head) {
        return false;
    }
    if s.contains("sec-fetch-dest: document") {
        return true;
    }
    s.lines()
        .find(|l| l.starts_with("accept:"))
        .is_some_and(|l| l.contains("text/html"))
}

/// Connect to the upstream, RETRYING until `grace` runs out. The old code gave up on
/// the first `ECONNREFUSED`, which is exactly what a server restart looks like for
/// the second or two it takes to rebind — one unlucky reload in that window left the
/// window permanently empty.
pub(crate) async fn connect_upstream_retrying(
    host: Loopback,
    port: u16,
    grace: std::time::Duration,
) -> Option<tokio::net::TcpStream> {
    let deadline = std::time::Instant::now() + grace;
    loop {
        match tokio::net::TcpStream::connect((host.host(), port)).await {
            Ok(s) => return Some(s),
            Err(_) if std::time::Instant::now() < deadline => {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            Err(_) => return None,
        }
    }
}

/// Loopback origination proxy: accept plain TCP on 127.0.0.1:PROXY_PORT and pipe it,
/// byte-for-byte, to the chosen upstream. When the upstream is the external server
/// (`tls=true`) we ADD TLS — WKWebView won't trust the server's local-CA cert but
/// happily speaks plain HTTP/WS to loopback, so the shell connects to
/// http://127.0.0.1:PROXY_PORT and this task adds the TLS. When the upstream is our
/// own sidecar (`tls=false`, plain HTTP via NO_TLS) we pipe raw TCP through. Either
/// way it's transparent: HTTP, WebSocket upgrades and SSE streams pass untouched (no
/// L7 parsing), and the client's `Origin: tauri://localhost` is preserved so the
/// server's CORS still matches. Reads the boot-decided `UPSTREAM` (defaults to the
/// external TLS server if `decide_upstream` never ran, e.g. probe race).
pub(crate) async fn run_tls_proxy() {
    use tokio::net::TcpListener;

    let listener = match TcpListener::bind(("127.0.0.1", PROXY_PORT)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[proxy] bind 127.0.0.1:{PROXY_PORT} failed: {e}");
            return;
        }
    };
    proxy_loop(listener, UpstreamSource::Decided).await
}

/// Where a proxied connection should go, and WHEN that is decided.
///
/// THE BUG THIS TYPE EXISTS FOR. `run_tls_proxy` used to read `UPSTREAM` ONCE,
/// at start, falling back to the external server on :3333 when it was still
/// unset. But `decide_upstream_and_spawn` runs CONCURRENTLY and takes as long as
/// probing :3333 takes - up to ~42s on a machine with the marker, and on a
/// virgin machine the sidecar has to be spawned and given a port first. The
/// proxy almost always won that race, latched onto :3333/TLS, and never looked
/// again. Then the sidecar came up on its own free port, `UPSTREAM` was set to
/// it, and nobody read it: every API call and every WebSocket was piped at a
/// port with nothing behind it.
///
/// Measured on a clean install of 2.2.246 (Windows, no external server):
/// `topics-server` alive on :58406, proxy listening on :13333, nothing at all on
/// :3333 - and a raw request to the proxy connects in 4ms and gets NOTHING back,
/// because `connect_upstream_retrying` is dutifully holding for a server that
/// does not exist. What a person sees is `Offline`, then `Connecting` forever,
/// on a build where the sidecar is running perfectly two ports away.
///
/// So the target is resolved PER CONNECTION. `Fixed` keeps the outage test able
/// to name its own upstream without touching the global.
#[derive(Clone, Copy)]
pub(crate) enum UpstreamSource {
    /// A target chosen by the caller (the outage test).
    ///
    /// Only the test constructs it, and the test module is `#[cfg(test)]`, so a
    /// release build sees a variant nobody builds. Silenced HERE and with a
    /// reason rather than left to hum: warning noise is how a real dead branch
    /// hides.
    #[cfg_attr(not(test), allow(dead_code))]
    Fixed(Upstream),
    /// Whatever the boot decision chose - read at connection time, waited for if
    /// the decision has not landed yet.
    Decided,
}

/// How long a connection waits for the boot decision before giving up on it.
///
/// Longer than the decision can take (the `WaitForKnownServer` path probes :3333
/// for ~42s), because the alternative to waiting is guessing, and guessing is
/// exactly what produced a permanent "Connecting". A connection that waits is a
/// page that takes a moment to appear; a connection that guesses wrong is an app
/// that never works until it is relaunched.
pub(crate) const UPSTREAM_DECISION_WAIT: std::time::Duration = std::time::Duration::from_secs(75);

impl UpstreamSource {
    /// The target for one connection.
    ///
    /// Returns `None` only when the decision never landed inside
    /// `UPSTREAM_DECISION_WAIT`, which means the boot task itself is wedged: the
    /// caller then serves the reconnect page rather than piping the connection
    /// into a port nobody chose.
    pub(crate) async fn resolve(self) -> Option<Upstream> {
        match self {
            UpstreamSource::Fixed(u) => Some(u),
            UpstreamSource::Decided => {
                if let Some(u) = UPSTREAM.get() {
                    return Some(*u);
                }
                let deadline = std::time::Instant::now() + UPSTREAM_DECISION_WAIT;
                while std::time::Instant::now() < deadline {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    if let Some(u) = UPSTREAM.get() {
                        return Some(*u);
                    }
                }
                None
            }
        }
    }
}

/// The accept loop, split out from `run_tls_proxy` so the outage behaviour (hold →
/// reconnect page → self-recovery) can be driven end-to-end in a test against a real
/// browser, on an ephemeral port, without touching :13333 or a live server.
pub(crate) async fn proxy_loop(listener: tokio::net::TcpListener, source: UpstreamSource) {
    use tokio::io::copy_bidirectional;

    let tls = match native_tls::TlsConnector::builder()
        // The server presents a local-CA cert for 127.0.0.1; we originate the TLS
        // ourselves to a hard-coded loopback address, so cert/hostname validation
        // adds nothing here — the trust boundary is "is it really loopback".
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
    {
        Ok(c) => tokio_native_tls::TlsConnector::from(c),
        Err(e) => {
            eprintln!("[proxy] TLS connector build failed: {e}");
            return;
        }
    };
    println!(
        "[proxy] loopback proxy {} -> upstream resolved per connection",
        listener
            .local_addr()
            .map(|a| a.to_string())
            .unwrap_or_default(),
    );

    loop {
        let (mut inbound, _) = match listener.accept().await {
            Ok(p) => p,
            Err(_) => continue,
        };
        let tls = tls.clone();
        tauri::async_runtime::spawn(async move {
            use tokio::io::AsyncWriteExt;
            // Read the request head FIRST so we can tell a document navigation from
            // an XHR/WebSocket. Whatever we read is replayed to the upstream below —
            // it's already out of the socket, `copy_bidirectional` can't see it.
            let head = read_request_head(&mut inbound).await;
            // A TLS handshake on a port that speaks clear HTTP is not a request:
            // forwarding it made the upstream answer a plain `400` that the
            // browser read as an opaque body, and offered to download. Hang up,
            // which is the answer a non-TLS port owes a TLS client.
            if is_tls_client_hello(&head) {
                let _ = inbound.shutdown().await;
                return;
            }
            let doc = is_document_head(&head);
            // AND ONLY NOW ASK WHERE TO GO. Reading the boot decision here, rather
            // than once when the loop started, is what keeps a connection that
            // arrives during the decision from being piped at a guess.
            let Some(up) = source.resolve().await else {
                eprintln!("[proxy] no upstream decided after {UPSTREAM_DECISION_WAIT:?}");
                if doc {
                    let _ = inbound.write_all(&reconnect_page_response()).await;
                    let _ = inbound.flush().await;
                }
                return;
            };
            let grace = if doc { UPSTREAM_GRACE_DOC } else { UPSTREAM_GRACE };
            let upstream = match connect_upstream_retrying(up.host, up.port, grace).await {
                Some(s) => s,
                None => {
                    eprintln!(
                        "[proxy] upstream {}:{} unreachable for {:?}",
                        up.host.host(),
                        up.port,
                        grace
                    );
                    if doc {
                        // Paint SOMETHING and keep retrying by itself. Without this the
                        // transparent window has no pixels at all — "sparita" and "vuota"
                        // are the same state, with no way back short of a relaunch.
                        let _ = inbound.write_all(&reconnect_page_response()).await;
                        let _ = inbound.flush().await;
                    }
                    return;
                }
            };
            if up.tls {
                let mut tls_stream = match tls.connect(up.host.host(), upstream).await {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[proxy] upstream TLS handshake failed: {e}");
                        return;
                    }
                };
                if !head.is_empty() && tls_stream.write_all(&head).await.is_err() {
                    return;
                }
                let _ = copy_bidirectional(&mut inbound, &mut tls_stream).await;
            } else {
                let mut plain = upstream;
                if !head.is_empty() && plain.write_all(&head).await.is_err() {
                    return;
                }
                let _ = copy_bidirectional(&mut inbound, &mut plain).await;
            }
        });
    }
}

// ─────────────────────── Bundled server sidecar ───────────────────────
//
// SELF-CONTAINED release path. On Attilio's box an external launchd server owns
// :3333 (TLS) and the shell defers to it — nothing here runs. On a VIRGIN machine
// (the download the "ragazzi" try) nothing is on :3333, so the app would show a
// blank "connecting" screen. To be truly standalone, the shell instead spawns a
// bundled server sidecar (`topics-server`, a `bun build --compile` binary declared
// in tauri.conf bundle.externalBin) on a free loopback port with plain HTTP
// (NO_TLS) and an isolated per-user data dir, then points the loopback proxy at it.
// The sidecar is killed when the app exits (RunEvent::Exit), and survives webview
// reloads (it's a separate process, not tied to the webview).

/// The spawned sidecar's process handle, kept for a clean kill on app exit. `None`
/// when we deferred to an external server (no sidecar spawned).
pub(crate) static SIDECAR_CHILD: std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>> =
    std::sync::Mutex::new(None);

/// Ask the OS for a free loopback TCP port by binding :0 and reading it back, then
/// dropping the listener so the sidecar can bind it. A tiny TOCTOU window exists
/// (another process could grab it between drop and the sidecar's bind) but on a
/// quiet loopback that's negligible, and the health-wait below surfaces a failure
/// rather than hanging. Falls back to a fixed high port if the probe fails.
pub(crate) fn pick_free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(13337)
}

/// Resolve the sidecar's writable data dir: Tauri's per-user app-data dir with a
/// `data-standalone` subdir (kept SEPARATE from any dev/launchd `~/.topics` state so
/// a self-contained run never collides with a full install on the same machine).
pub(crate) fn sidecar_data_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("io.armonia.topics.tauri"));
    let dir = base.join("data-standalone");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Marker recording that THIS machine has a real external server on :3333.
///
/// Written the first time we successfully defer to it, and never removed. It is
/// what tells a later boot "you have a real universe here" so a slow start can
/// never be mistaken for a virgin machine.
pub(crate) fn external_server_marker(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("io.armonia.topics.tauri"));
    let _ = std::fs::create_dir_all(&base);
    base.join("external-server-seen")
}

/// Resolve the bundled **Rust PTY bridge** sidecar (`binaries/pty-bridge-<triple>` →
/// bundled beside the app binary in `Contents/MacOS/pty-bridge`). It's a ~0.5 MB
/// self-contained, wire-compatible port of pty-bridge.mjs that the compiled Bun
/// sidecar spawns for terminals on a virgin install — Bun itself can't run node-pty.
///
/// Returns `Some` only when the binary exists. On unix the packaged binary can lose
/// its exec bit, so we re-assert it — a non-executable bridge would fail to spawn and
/// silently drop back to "no terminals".
///
/// ON WINDOWS THIS ALWAYS RETURNED `None`, because until 2026-08-26 the sidecar was
/// a no-op: the bridge only spoke Unix sockets. The effect was that on Windows Topics
/// installed, opened, and could not open a SINGLE terminal (503 "terminals not
/// available in standalone mode") — in an app whose whole point is running
/// command-line agents. The bridge now has a named-pipe transport
/// (pty-bridge/src/transport.rs), so Windows advertises one like everywhere else.
/// The CLIENT BUNDLE shipped beside the app (`bundle.resources`), so the sidecar
/// server has something to answer `/` with.
///
/// WHY THIS EXISTS, measured on Windows 2.2.179 on 2026-08-27. The shell loads
/// its UI from the server origin (see the note at the top of this file), and the
/// server resolves the bundle as `TOPICS_PUBLIC_DIR || <baseDir>/public`
/// (`server/utils.ts`). An installed Topics has NO `public/` next to
/// `topics-server.exe`, so `/` answered 503 "Bundle not built yet"
/// (`server.ts:3002`) while `/api/system/status` answered 200 — an app whose API
/// works and whose window paints one flat grey. Measured: 95.9% of the window
/// was a single colour, and 3 of 79 sampled rows had any pixels at all.
///
/// It never showed on macOS because there the shell DEFERS to an already-running
/// server (`probe_topics_server`), which on a developer box runs inside the
/// checkout and therefore has the directory. The standalone path — the only one
/// a Windows user ever takes — was never exercised where anyone was looking.
///
/// `None` when the resource is absent (a build made before this shipped): the
/// caller then leaves `TOPICS_PUBLIC_DIR` unset, which is exactly today's
/// behaviour. This cannot make anything worse than it already is.
pub(crate) fn bundled_public_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    // The same relative string the bundle config uses: tauri maps `..` to `_up_`
    // when it copies, and resolves it back here.
    let dir = app
        .path()
        .resolve("../../public", tauri::path::BaseDirectory::Resource)
        .ok()?;
    if dir.join("index.html").exists() {
        Some(dir)
    } else {
        None
    }
}

pub(crate) fn bundled_pty_bridge_bin() -> Option<std::path::PathBuf> {
    // Tauri places externalBin sidecars beside the app executable.
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    // On Windows the executable carries its extension; without it `exists()` fails.
    let bin = if cfg!(windows) {
        dir.join("pty-bridge.exe")
    } else {
        dir.join("pty-bridge")
    };
    if !bin.exists() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&bin) {
            let mut perm = meta.permissions();
            if perm.mode() & 0o111 == 0 {
                perm.set_mode(perm.mode() | 0o755);
                let _ = std::fs::set_permissions(&bin, perm);
            }
        }
    }
    Some(bin)
}

/// Resolve the bundled **Rust WebRTC bridge** sidecar (`binaries/webrtc-bridge-<triple>`
/// → bundled beside the app binary in `Contents/MacOS/webrtc-bridge`). It streams a
/// server-side headless-Chromium pane as one shared H.264 WebRTC track to N viewers —
/// the transport the browser pane's `<video>` renders (see server/webrtc-bridge.ts +
/// client/src/hooks/useRemoteBrowser.ts). The compiled Bun server can't hold an
/// openh264 encoder / webrtc-rs stack in-process, so it spawns this binary.
///
/// Same shape as `bundled_pty_bridge_bin`: `Some` only when the binary exists (Windows
/// ships a no-op stub, so we don't advertise one there → the server keeps
/// `available() == false` and the pane falls back to DOM rendering instead of hanging
/// on a negotiation nobody answers). On unix the packaged binary can lose its exec bit,
/// so we re-assert it.
pub(crate) fn bundled_webrtc_bridge_bin() -> Option<std::path::PathBuf> {
    // Windows ships only a no-op stub (the wire protocol is a Unix socket).
    if cfg!(windows) {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let bin = dir.join("webrtc-bridge");
    if !bin.exists() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&bin) {
            let mut perm = meta.permissions();
            if perm.mode() & 0o111 == 0 {
                perm.set_mode(perm.mode() | 0o755);
                let _ = std::fs::set_permissions(&bin, perm);
            }
        }
    }
    Some(bin)
}

/// Boot decision: if a Topics server already answers on :3333 (external launchd /
/// dev — try TLS first, then plain), defer to it. Otherwise spawn the bundled
/// sidecar on a free plain-HTTP port with an isolated data dir, wait until it's
/// healthy, and record the child for kill-on-exit. Sets `UPSTREAM` either way so the
/// loopback proxy pipes to the right place. Never blocks the UI beyond the short
/// probe + (cold-start only) health wait; on total failure it leaves UPSTREAM at the
/// default external target so the app degrades to today's "connecting" rather than
/// panicking.
pub(crate) async fn decide_upstream_and_spawn(app: tauri::AppHandle) {
    // 1) Prefer an external server on :3333 (Attilio's launchd, or a dev server).
    // RETRY for a few seconds before falling back: a single instant probe raced a
    // `launchctl kickstart -k` restart once — the external server was down for the
    // ~2s the app booted in, so the shell silently forked an EMPTY standalone
    // sidecar universe and every real topic/terminal "disappeared". A machine that
    // has an external server usually gets it back within seconds; a truly virgin
    // machine only pays this wait ONCE on first launch (then the sidecar spawns).
    // A machine that has ALREADY had a real server here is never a virgin
    // machine, so it gets a much longer wait and, past it, no sidecar at all.
    //
    // The 2026-08-13 incident: a fork bomb in the ai-bridge daemon took the box
    // to load 644 and 36 GB of swap. The launchd server was alive but far too
    // slow to answer inside the 5.6s window, so the shell concluded "virgin
    // machine", forked its own EMPTY universe, and the user lost every task,
    // every pinned tab and even the version number. It then survived a reboot,
    // because at login the real server needs longer than 5.6s to open an 893
    // topic database while the app is already probing. Time alone cannot tell
    // "no server here" from "server busy": only this marker can.
    let marker = external_server_marker(&app);
    let seen_before = marker.exists();
    // SAY IT NOW, NOT IN FIVE MINUTES. Everything the explanation needs is already
    // true here: the marker exists, so the shell is about to wait for :3333 instead
    // of starting its own server. The loop below only decides whether to SPAWN, and
    // on Windows reaching that decision measured 141s and 142s on two runs
    // (2026-08-28) — the whole of which the window spent showing a bare red dot.
    // Retracted below the moment an answer arrives, so a machine whose server is
    // simply slow never keeps the sentence.
    //
    // AND ONLY WHERE THE MARKER IS THE REASON, which is the same condition the
    // `WaitForKnownServer` branch applies at the end (board card c0faad1d). With a
    // daemon pid alive on this machine the shell would wait for that server with or
    // without the marker, so offering to delete it here for the ~42s of the search
    // is offering a way out that leads back to the same wait.
    if seen_before && !daemon_pid_is_alive() {
        set_degraded_marker(Some(marker.display().to_string()));
    }
    // SHAPE-AWARE discovery, not just "some server is here", and the rule that
    // drives it lives in `boot_choice::discover_upstream` with its probes handed
    // in, so it can be tested without a Tauri app around it. All this function
    // still owns is the wiring: real sockets, the real files on disk, a real
    // pause.
    // In TIME, not in rounds, and the short one is no longer shorter than the
    // patience it is supposed to let run (see `SEARCH_WITHOUT_MARKER`).
    let budget = if seen_before { SEARCH_WITH_MARKER } else { SEARCH_WITHOUT_MARKER };
    let facts = discover_upstream(
        seen_before,
        budget,
        ALONE_BEFORE_CONCEDING,
        |host, port| probe_port(host, port),
        || (daemon_state_port(), daemon_pid_is_alive()),
        || tokio::time::sleep(ROUND_PAUSE),
    )
    .await;

    let choice = decide_boot(facts);
    match choice {
        BootChoice::Defer { host, port, tls } => {
            let kind = if tls { "TLS" } else { "plain-HTTP" };
            let addr = host.host();
            eprintln!("[sidecar] external {kind} Topics daemon on {addr}:{port} — deferring, no sidecar");
            // The server answered: there is nothing to explain, and leaving the
            // sentence up would offer to delete a marker that is doing its job.
            set_degraded_marker(None);
            let _ = std::fs::write(&marker, "1");
            let _ = UPSTREAM.set(Upstream { host, port, tls });
            return;
        }
        // Still nothing, but this machine is KNOWN to own a real server: point at
        // it and wait for it to come back. Forking an empty standalone universe
        // here would silently hide every real topic, which is strictly worse.
        //
        // Waiting is right; waiting MUTELY was not. Publish the marker's path so
        // the reconnect page can say why nothing is starting and which file to
        // remove to get a local server instead (`reconnect_page_response_for`):
        // before this, the only symptom was an eternal "Reconnecting".
        BootChoice::WaitForKnownServer { host } => {
            let addr = host.host();
            eprintln!(
                "[sidecar] no answer on {addr}:{DEFAULT_UPSTREAM_PORT} after ~42s, but this machine has a real \
                 server (marker {}, daemon pid alive: {}): NOT spawning a sidecar; degrading to \"connecting\"",
                marker.display(),
                facts.state_pid_alive,
            );
            // ONLY OFFER THE WAY OUT THAT IS ACTUALLY THE WAY OUT. The page tells
            // the person to delete the marker and reopen; that is true when the
            // marker is what makes the shell wait, and false otherwise. A LIVE
            // daemon pid is believed before the marker is even read, so with a
            // recycled pid the button sends somebody to delete a file and land
            // right back on this same wait (reproduced 2026-09-14). Same for a
            // marker that is not there: the path was published regardless.
            //
            // This is a RETRACTION when the pid came alive during the search, and
            // the client has to be able to hear it: it asks again for as long as it
            // is disconnected instead of keeping the first yes (`bootDegraded.ts`).
            let marker_is_the_reason = seen_before && !facts.state_pid_alive;
            set_degraded_marker(
                marker_is_the_reason.then(|| marker.display().to_string()),
            );
            let _ = UPSTREAM.set(Upstream { host, port: DEFAULT_UPSTREAM_PORT, tls: true });
            return;
        }
        // Reached when nothing of ours is here at all: no daemon answered, no
        // daemon pid is alive, and either no marker or a marker a stranger has
        // invalidated. The sentence about waiting would be false from here on.
        BootChoice::SpawnSidecar => set_degraded_marker(None),
    }

    // 2) Nothing external — spawn the bundled sidecar (plain HTTP, isolated data).
    use tauri_plugin_shell::ShellExt;
    let port = pick_free_port();
    let data_dir = sidecar_data_dir(&app);
    eprintln!(
        "[sidecar] no external server; spawning bundled sidecar on :{port} (data: {})",
        data_dir.display()
    );
    // The bundled Rust PTY-bridge sidecar (binaries/pty-bridge → Contents/MacOS/
    // pty-bridge). Present → this "standalone" sidecar can run a REAL PTY bridge, so
    // shell/claude-code tabs work on a virgin install. Absent (Windows stub / older
    // bundle / dev build without the sidecar) → None, keeping today's kill-switch.
    let bridge_bin = bundled_pty_bridge_bin();
    // Same story for the WebRTC bridge: present → the browser pane's shared-session
    // <video> transport works on a virgin install; absent → server/webrtc-bridge.ts
    // reports available()==false and the pane uses the DOM fallback.
    let webrtc_bin = bundled_webrtc_bridge_bin();
    let cmd = match app.shell().sidecar("topics-server") {
        Ok(c) => {
            let mut c = c
                .env("NO_TLS", "1")
                .env("BUN_PORT", port.to_string())
                // Bind IPv4 loopback explicitly: the proxy connects to 127.0.0.1 and a
                // bare "::" bind is IPv6-only on some Bun/macOS combos (see server.ts).
                .env("SERVER_HOST", "127.0.0.1")
                // ── ISOLATION (all partition keys, not just one) ─────────────────
                // The server partitions its mutable state across SEPARATE env vars,
                // and setting only TOPICS_DATA_DIR is NOT enough — this is the
                // 2026-07-02 incident: the PTY-bridge socket path is md5(cwd) when
                // `DATA_DIR` is unset (server/routes/terminal.ts getSocketPath). A
                // sidecar sharing a checkout's cwd hashed to the SAME socket as the
                // live launchd server and, with its own empty DB, reconciled the live
                // PTYs as "orphans" and KILLED them. So isolate EVERY state root:
                //   • DATA_DIR / TOPICS_DATA_DIR / TOPICS_HOME — db + browser state;
                //     daemon lock, ui-state backups, events. DATA_DIR being set ALSO
                //     makes getSocketPath derive a DISTINCT, short `/tmp/topics-pty-
                //     bridge-<hash>.sock` (hash of cwd\0DATA_DIR) that a real server
                //     (DATA_DIR unset) can never collide with — so the sidecar's
                //     bridge is structurally isolated WITHOUT pinning a long,
                //     bind-unfriendly socket path under Application Support (a unix
                //     socket path >104 bytes fails to bind with EINVAL).
                //   • TOPICS_EMBEDDED=1 — self-contained-bundle flag: keeps the
                //     gateway/journal integrations off. It ALSO disables the PTY
                //     bridge UNLESS a bundled bridge re-enables it (see below).
                //
                // NO APP_DATA_DIR here, deliberately (card 211605ee). The root
                // for media/ and workspace/ is resolved server-side by one rule
                // (server/lib/data-dir.ts `resolveAppDataDir`): an explicit
                // variable, else the legacy root in the home when this machine
                // already has one, else TOPICS_HOME — which the line below
                // already sets. A fourth variable saying the same thing is one
                // more place for the two to disagree.
                .env("TOPICS_DATA_DIR", data_dir.to_string_lossy().to_string())
                .env("DATA_DIR", data_dir.join("data").to_string_lossy().to_string())
                .env("TOPICS_HOME", data_dir.join("home").to_string_lossy().to_string())
                .env("TOPICS_EMBEDDED", "1")
                // The version, told by WHOEVER KNOWS IT.
                //
                // The server read it from a `package.json` resolved next to its
                // own source file: inside a compiled binary that file does not
                // exist, so `/api/version` answered `0.0.0` on every installed
                // build, and the little number at the bottom of the sidebar
                // showed that. The shell carries it baked in
                // (`CARGO_PKG_VERSION`, which tauri.conf and Cargo.toml keep in
                // step), so it has nothing to read: it just passes it along.
                .env("TOPICS_APP_VERSION", env!("CARGO_PKG_VERSION"));
            // WHERE THE PAGE LIVES. Without this the sidecar looks for `public/`
            // beside its own executable, finds nothing, and answers 503 on `/` —
            // the grey window (see `bundled_public_dir`). Set only when the
            // resource is really there, so an older bundle behaves as before.
            if let Some(pubdir) = bundled_public_dir(&app) {
                c = c.env("TOPICS_PUBLIC_DIR", pubdir.to_string_lossy().to_string());
            }
            match &bridge_bin {
                // Bundled Rust bridge present: hand the server the binary to spawn.
                // This flips isPtyBridgeDisabled() to false (terminal.ts) so terminals
                // work, while the DATA_DIR-derived socket above keeps them isolated
                // from any real server.
                Some(bin) => {
                    c = c.env("TOPICS_PTY_BRIDGE_BIN", bin.to_string_lossy().to_string());
                }
                // No bundled bridge (older bundle / dev build without the sidecar):
                // keep the hard kill-switch — a virgin machine has no external
                // bridge and Bun can't run one itself, so terminals answer 503.
                None => {
                    c = c.env("TOPICS_DISABLE_PTY_BRIDGE", "1");
                }
            }
            match &webrtc_bin {
                // Bundled WebRTC bridge present: hand the server the binary to spawn
                // lazily on the first SDP offer (resolveBin() in webrtc-bridge.ts).
                Some(bin) => {
                    c = c.env("TOPICS_WEBRTC_BRIDGE_BIN", bin.to_string_lossy().to_string());
                }
                // No bundled bridge (Windows stub / older bundle): say so explicitly
                // rather than letting the server probe a dev-checkout path that only
                // exists on a developer's machine.
                None => {
                    c = c.env("TOPICS_DISABLE_WEBRTC_BRIDGE", "1");
                }
            }
            c
        }
        Err(e) => {
            eprintln!("[sidecar] sidecar() resolve failed: {e} — falling back to external target");
            let _ = UPSTREAM.set(Upstream { host: Loopback::V4, port: DEFAULT_UPSTREAM_PORT, tls: true });
            return;
        }
    };
    match cmd.spawn() {
        Ok((mut rx, child)) => {
            if let Ok(mut slot) = SIDECAR_CHILD.lock() {
                *slot = Some(child);
            }
            // Point the proxy at the sidecar NOW (before the health wait) so it can
            // start piping the moment the server binds; a connection before then just
            // fails and the client retries.
            let _ = UPSTREAM.set(Upstream { host: Loopback::V4, port, tls: false });
            // Drain the sidecar's stdout/stderr so its pipe never fills (which would
            // block the child); log lines to our stderr for field diagnosis.
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(ev) = rx.recv().await {
                    match ev {
                        CommandEvent::Stdout(line) => {
                            eprintln!("[sidecar] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[sidecar!] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[sidecar] terminated: code={:?} signal={:?}", payload.code, payload.signal);
                            break;
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(e) => {
            eprintln!("[sidecar] spawn failed: {e} — falling back to external target");
            let _ = UPSTREAM.set(Upstream { host: Loopback::V4, port: DEFAULT_UPSTREAM_PORT, tls: true });
            return;
        }
    }

    // 3) Wait for the sidecar to become healthy (cold DB init + migrations take a
    // moment), up to ~20s — but FIRE-AND-FORGET so it does NOT delay the caller,
    // which starts run_tls_proxy the instant we return. UPSTREAM is already set
    // (above), so the proxy can bind and start piping immediately; a connection
    // that lands before the server itself binds just fails and the client retries.
    // Previously this wait ran inline before the caller reached run_tls_proxy, so
    // a virgin machine sat on "connecting" for the full cold-start (up to 20s)
    // because the proxy hadn't bound yet. The wait's only jobs are logging health
    // and nudging a reload for a client that connected mid-cold-start — both fine
    // to do off the boot path.
    let app_health = app.clone();
    let health_port = port;
    tauri::async_runtime::spawn(async move {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut healthy = false;
        while std::time::Instant::now() < deadline {
            if probe_topics_server(Loopback::V4, health_port, false).await {
                healthy = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
        eprintln!("[sidecar] health after wait: {healthy} (:{health_port})");
        // Nudge the webview to reload now that the upstream is live, so a client
        // that connected during the cold start (and cached a failed fetch) re-fetches.
        if healthy {
            let h = app_health.clone();
            let _ = app_health.run_on_main_thread(move || {
                eval_in_main_webview(&h, COLD_START_RELOAD_JS);
            });
        }
    });
}

/// L'UNICO reload SILENZIOSO e INCONDIZIONATO della app: parte senza che nessuno
/// abbia premuto niente, non lascia segno, e ricarica quello che c'è sullo schermo
/// qualunque cosa sia. Ha una sola licenza, ed è la finestra in cui viene sparato:
/// il cold start. L'upstream è appena salito, il client si è collegato mentre il
/// server ancora non rispondeva e ha in cache una fetch fallita — non c'è nessuna
/// sessione viva da buttare via e nessun «hai premuto» da confermare.
///
/// Fuori da quella finestra un reload muto è un difetto, non una feature: lo
/// schermo sbatte, il lavoro sparisce e l'utente conclude «è crashato». Gli altri
/// tre reload del guscio sono di categorie diverse e restano legittimi:
/// `RELOAD_WITH_FLASH_JS` è ANNUNCIATO (⌘R lascia il toast), `RELOAD_IF_BLANK_JS` e
/// la pagina di `reconnect_page_response` sono AUTO-LIMITATI (ricaricano solo un
/// documento che non ha niente da perdere). Un secondo membro di QUESTA categoria
/// non si aggiunge: `reloadFlash.test.ts` conta i siti di reload uno per uno e
/// diventa rosso — se ti serve davvero, cambia la guardia spiegando perché, non il
/// numero.
pub(crate) const COLD_START_RELOAD_JS: &str = "window.location.reload()";

/// JS that reloads the main document ONLY IF it has nothing on screen. Sent by the
/// upstream watchdog after the server comes back: a live app (mounted `#root`) is
/// left alone — it reconnects its own WebSocket and a forced reload would throw away
/// a working session — while an empty document (WebKit error page, our reconnect
/// page, a webview that lost its content) is put back on its feet. Wrapped in
/// try/catch that reloads on failure: if we can't even inspect the DOM, the document
/// is not in a state worth preserving.
pub(crate) const RELOAD_IF_BLANK_JS: &str = "(function(){try{\
var r=document.getElementById('root');\
if(r&&r.childElementCount>0)return;\
location.reload()}catch(e){location.reload()}})()";

/// Run `js` in the MAIN webview. Not `get_webview_window` — once native browser panes
/// are mounted the main window is multi-webview and that lookup returns None (see the
/// `TlWindow` note), which is precisely the state a recovery path must survive.
/// Falls back to the webview-window lookup for the single-webview case.
pub(crate) fn eval_in_main_webview(app: &tauri::AppHandle, js: &str) -> bool {
    use tauri::Manager;
    if let Some(wv) = app.get_webview("main") {
        return wv.eval(js).is_ok();
    }
    if let Some(w) = app.get_webview("main") {
        return w.eval(js).is_ok();
    }
    false
}

/// Watch the upstream forever and put the window back when the server returns.
///
/// This is THE recovery path, and it runs in BOTH boot branches — the old
/// `window.location.reload()` lived inside the sidecar branch only, so on a machine
/// with an external launchd server on :3333 (the reported case) production had no
/// recovery at all: the shell `return`ed before ever reaching it.
///
/// Edge-triggered on down→up: we only nudge after having actually SEEN the server
/// down, so a healthy machine never gets a spurious reload. The nudge itself is
/// conservative (see `RELOAD_IF_BLANK_JS`).
pub(crate) async fn watch_upstream(app: tauri::AppHandle) {
    let up = *UPSTREAM
        .get()
        .unwrap_or(&Upstream { host: Loopback::V4, port: DEFAULT_UPSTREAM_PORT, tls: true });
    let mut was_down = false;
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let alive = probe_topics_server(up.host, up.port, up.tls).await;
        if !alive {
            if !was_down {
                eprintln!("[watchdog] upstream :{} is DOWN", up.port);
            }
            was_down = true;
            continue;
        }
        if was_down {
            eprintln!("[watchdog] upstream :{} is back — nudging the webview", up.port);
            was_down = false;
            // Give the server a beat to finish binding its routes before the reload
            // fires, so the nudged navigation doesn't race the very restart it's
            // recovering from.
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                if !eval_in_main_webview(&app2, RELOAD_IF_BLANK_JS) {
                    eprintln!("[watchdog] no main webview to nudge");
                }
            });
        }
    }
}

/// Kill the sidecar if we spawned one. Called on app exit so no orphan server
/// process survives the shell. Idempotent (the slot is taken).
pub(crate) fn kill_sidecar() {
    if let Ok(mut slot) = SIDECAR_CHILD.lock() {
        if let Some(child) = slot.take() {
            eprintln!("[sidecar] killing on exit");
            let _ = child.kill();
        }
    }
}

/// Did every binary this build ships actually land beside the app? The client
/// asks when it shows the version, so a half applied update is visible where the
/// user goes to read "you are on 2.2.176" (see sidecar_integrity.rs).
#[tauri::command]
pub(crate) fn sidecar_integrity() -> sidecar_integrity::SidecarReport {
    sidecar_integrity::report()
}

/// Update metadata handed to the renderer by `updater_check`.
#[derive(Serialize)]
pub(crate) struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

/// Check the configured endpoint for a newer signed release. Returns the update
/// metadata, or `None` when already current. Errors (no manifest / not yet
/// published / network) surface as a string for the client to show. Electron
/// parity: `updater:check-for-updates`. Inert until a signed tauri-v* release is
/// published (see `plugins.updater` in tauri.conf.json).
#[tauri::command]
pub(crate) async fn updater_check(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| e.to_string())?;
    Ok(found.map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    }))
}

/// Download + install the available update, then restart into it. Tauri's update
/// is atomic (download and install are one call), so the client maps its
/// "download" affordance to a no-op transition and drives the real work from here
/// (the "Restart to update" action). Never returns on success — the process is
/// replaced. Electron parity: `updater:quit-and-install`.
#[tauri::command]
pub(crate) async fn updater_install(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart()
}

// ───────────────────────── Dev hot-reload (disk-serve) ─────────────────────────
//
// Electron-prod parity: the packaged Electron shell "auto-reloads all windows when
// /public assets change (500ms debounce)". Tauri EMBEDS /public via include_bytes!
// at cargo-build (frontendDist), served from tauri://localhost — so a `vite build`
// that rewrites /public does nothing for an already-running binary (only a fresh
// `cargo run`/`tauri build` re-embeds). That killed the client dogfood loop.
//
// This opt-in dev mode restores it WITHOUT touching the release default:
//   • A dev marker (env TOPICS_PUBLIC_DIR, or <app_config_dir>/topics-dev.json →
//     {"publicDir":"/abs/path"}) is read ONCE at startup. ABSENT ⇒ byte-identical
//     embedded behavior, no per-request disk probes.
//   • When present, the custom `tauri` URI-scheme handler serves matching files
//     from disk (canonicalized, traversal-guarded) and FALLS BACK to the embedded
//     asset for anything not on disk — so a partial /public still boots.
//   • A polling watcher (dep-free: recursive max-mtime scan, no `notify` crate)
//     reloads every app-shell webview 500ms after the writes go quiet — one reload
//     per `vite build` burst.

/// Resolved dev-mode state, read once at startup. `None` ⇒ pure embedded serving.
#[derive(Clone)]
pub(crate) struct DevServe {
    /// Canonicalized absolute path of the on-disk /public to serve + watch.
    public_dir: std::path::PathBuf,
}

/// App bundle identifier — MUST match tauri.conf.json `identifier`. Used to locate
/// the per-machine dev marker WITHOUT an AppHandle, so resolution can run BEFORE the
/// Tauri Builder. Why that matters: the config-defined main window builds — and fires
/// its first `tauri://` asset request — BEFORE the `setup` closure runs. Resolving the
/// marker lazily inside the protocol handler therefore raced that first request; under
/// a LaunchServices/login-item launch the path plugin wasn't always ready at that
/// instant, so `app_config_dir()` failed, the `OnceLock` latched `None`, and the shell
/// was silently pinned to embedded serving (the "login-item won't hot-reload" bug — a
/// direct `cargo run` / shell exec happened to win the race and worked, masking it).
pub(crate) const BUNDLE_IDENTIFIER: &str = "io.armonia.topics.tauri";

/// Per-OS user config dir (dep-free; mirrors `dirs::config_dir()` for the three
/// desktop targets) — the parent of `<identifier>/topics-dev.json`. AppHandle-free so
/// it can be called before the Builder exists.
pub(crate) fn user_config_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|h| std::path::PathBuf::from(h).join("Library/Application Support"))
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(std::path::PathBuf::from)
    }
}

/// Append a one-line decision record to `<config>/<id>/hot-reload.log`. stderr from a
/// LaunchServices launch goes nowhere reachable, so this file is the ONLY way to see
/// what the login-item launch decided. Best-effort; never fails the caller.
pub(crate) fn log_hot_reload_decision(line: &str) {
    if let Some(dir) = user_config_dir().map(|d| d.join(BUNDLE_IDENTIFIER)) {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("hot-reload.log"))
        {
            use std::io::Write;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "[{ts}] {line}");
        }
    }
}

/// Resolve the dev marker ONCE, AppHandle-free (call before the Builder). Priority:
/// env `TOPICS_PUBLIC_DIR`, then `<config>/<identifier>/topics-dev.json`
/// (`{"publicDir":"/abs"}`). The directory must exist and canonicalize, else dev mode
/// stays OFF (embedded serving unchanged).
pub(crate) fn resolve_dev_serve() -> Option<DevServe> {
    let raw = std::env::var("TOPICS_PUBLIC_DIR").ok().filter(|s| !s.trim().is_empty());
    let raw = raw.or_else(|| {
        let marker = user_config_dir()?.join(BUNDLE_IDENTIFIER).join("topics-dev.json");
        let text = std::fs::read_to_string(&marker).ok()?;
        let v: serde_json::Value = serde_json::from_str(&text).ok()?;
        v.get("publicDir")?.as_str().map(|s| s.to_string())
    });
    let raw = match raw {
        Some(r) => r,
        None => {
            log_hot_reload_decision("embedded (no marker/env)");
            return None;
        }
    };
    // Canonicalize so the traversal guard (below) compares real, symlink-resolved
    // prefixes — the scheme-guard LFI lesson: never trust a joined path's shape.
    let public_dir = match std::fs::canonicalize(&raw) {
        Ok(p) => p,
        Err(e) => {
            log_hot_reload_decision(&format!("embedded (canonicalize {raw:?} failed: {e})"));
            return None;
        }
    };
    if !public_dir.is_dir() {
        eprintln!("[hot-reload] TOPICS publicDir {public_dir:?} is not a directory; embedded serving");
        log_hot_reload_decision(&format!("embedded ({public_dir:?} not a dir)"));
        return None;
    }
    eprintln!("[hot-reload] disk-serving /public from {public_dir:?}");
    log_hot_reload_decision(&format!("disk-serving {public_dir:?}"));
    Some(DevServe { public_dir })
}

/// Local-dev auto-update opt-in, resolved once and AppHandle-free (same per-machine
/// dev marker as `resolve_dev_serve`, so "in locale in sviluppo" is a single source of
/// truth). ON when env `TOPICS_AUTO_UPDATE` is truthy, or `<config>/<identifier>/
/// topics-dev.json` carries `"autoUpdate": true`. A released install with no marker ⇒
/// OFF, so the client's opt-in toast flow (`autoDownload:false`, "no surprise
/// downloads") is byte-for-byte unchanged and this NEVER fires for prod users. It
/// exists so a dev's local shell silently pulls each signed release "da sotto" and
/// relaunches, instead of nagging with a manual toast. An explicit falsy env value
/// force-disables it even when the marker opts in.
pub(crate) fn dev_auto_update_enabled() -> bool {
    if let Ok(v) = std::env::var("TOPICS_AUTO_UPDATE") {
        match v.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => return true,
            "0" | "false" | "no" | "off" => return false,
            _ => {} // unrecognized ⇒ fall through to the marker
        }
    }
    // A debug build is the dev's OWN source compile (`cargo run`) — never silently swap
    // it for a signed release binary: that would nuke an in-progress native-dev session
    // and replace your local build with CI's. The passive marker opt-in only ever arms
    // an INSTALLED release shell; an explicit `TOPICS_AUTO_UPDATE=1` above still wins.
    if cfg!(debug_assertions) {
        return false;
    }
    let Some(marker) =
        user_config_dir().map(|d| d.join(BUNDLE_IDENTIFIER).join("topics-dev.json"))
    else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(&marker) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    v.get("autoUpdate").and_then(|x| x.as_bool()).unwrap_or(false)
}

/// Minimal, dep-free percent-encode for a query-value component: keep the
/// RFC-3986 unreserved set verbatim, escape everything else (notably ',' — the
/// `?topics=` list separator — and non-ASCII bytes) as `%XX`. Enough to carry
/// topic ids through the detached-window URL without a `percent_encoding` dep.
pub(crate) fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Minimal, dep-free percent-decode (`%XX` → byte), UTF-8 lossy. Enough for asset
/// URLs (mirrors what Tauri does with the `percent_encoding` crate) without adding
/// a direct dependency; unknown/short escapes are passed through verbatim.
pub(crate) fn percent_decode_lossy(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The origin Tauri serves the app's assets from, which is NOT the same on every
/// system: on macOS/Linux it is the custom scheme `tauri://localhost`, while on
/// Windows and Android wry cannot register a custom scheme on WebView2 and Tauri
/// falls back to `http://tauri.localhost` / `https://tauri.localhost`
/// (`AppManager::tauri_protocol_url`, `cfg!(windows)`).
///
/// Hardcoding just ONE of them is what left Windows with an empty window: three
/// different spots in this file assumed the macOS scheme, and on Windows all
/// three of them got it wrong together (navigation guard, asset key, CORS
/// header).
pub(crate) const APP_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

/// The origin this system actually uses, for the headers (`Access-Control-Allow-Origin`)
/// where exactly ONE is needed and it must match the document's own.
#[cfg(windows)]
pub(crate) const WINDOW_ORIGIN: &str = "http://tauri.localhost";
#[cfg(not(windows))]
pub(crate) const WINDOW_ORIGIN: &str = "tauri://localhost";

/// True if the URL is the app origin on THIS system (or on another one: taking
/// all three does not widen the perimeter, because none of the three is
/// reachable from outside).
pub(crate) fn is_app_origin(url: &tauri::Url) -> bool {
    let scheme = url.scheme();
    match url.host_str() {
        Some("localhost") => scheme == "tauri",
        Some("tauri.localhost") => scheme == "http" || scheme == "https",
        _ => false,
    }
}

/// Parse a `tauri://localhost/...` request URI into the normalized relative asset
/// path Tauri's own resolver uses: strip query/fragment + the origin prefix,
/// percent-decode, drop a trailing '/', empty ⇒ "index.html", else strip a leading
/// '/'. Mirrors AppManager::get_asset's front half so disk + embedded agree on keys.
///
/// The prefix to strip is the one for THIS system: on Windows the request comes
/// in as `http://tauri.localhost/index.html`, and stripping only the macOS form
/// turned the key into the whole URL — no asset ever matched and the window
/// stayed empty.
pub(crate) fn asset_request_path(uri: &str) -> String {
    let no_qf = uri.split(['?', '#']).next().unwrap_or(uri);
    let stripped = APP_ORIGINS
        .iter()
        .find_map(|origin| no_qf.strip_prefix(origin))
        .unwrap_or(no_qf);
    let mut p = stripped.to_string();
    if p.ends_with('/') {
        p.pop();
    }
    let p = percent_decode_lossy(&p);
    if p.is_empty() {
        "index.html".to_string()
    } else {
        p.strip_prefix('/').unwrap_or(&p).to_string()
    }
}

/// Read `rel` from the on-disk publicDir with a traversal guard: the candidate must
/// canonicalize to a path INSIDE `public_dir` (rejects `../`, symlink escapes — the
/// LFI lesson). Returns the bytes on a real hit; `None` for miss/escape/dir → the
/// caller then falls back to the embedded asset.
pub(crate) fn read_disk_asset(public_dir: &std::path::Path, rel: &str) -> Option<Vec<u8>> {
    let candidate = public_dir.join(rel);
    let real = std::fs::canonicalize(&candidate).ok()?;
    if !real.starts_with(public_dir) {
        eprintln!("[hot-reload] blocked traversal outside publicDir: {rel:?}");
        return None;
    }
    if !real.is_file() {
        return None;
    }
    std::fs::read(&real).ok()
}

/// Try to satisfy a request from disk using the SAME fallback chain the embedded
/// resolver uses: `path`, then `path.html`, then `path/index.html`, then the single-page app
/// `index.html`. Returns `(bytes, mime)` on a disk hit; `None` ⇒ fall back to
/// embedded. MIME comes from `tauri::utils::mime_type::MimeType::parse` — the exact
/// function the embedded resolver calls — so `.js`/`.mjs` get `text/javascript`
/// (module MIME) identically, no divergence.
pub(crate) fn disk_asset_response(public_dir: &std::path::Path, path: &str) -> Option<(Vec<u8>, String)> {
    let candidates = [
        path.to_string(),
        format!("{path}.html"),
        format!("{path}/index.html"),
        "index.html".to_string(),
    ];
    for (i, cand) in candidates.iter().enumerate() {
        if let Some(bytes) = read_disk_asset(public_dir, cand) {
            // Name the served file (not the request) so MIME keys off the real
            // extension — matches how the embedded resolver names its asset_path.
            let mime = tauri::utils::mime_type::MimeType::parse(&bytes, cand);
            if i > 0 {
                eprintln!("[hot-reload] disk fallback {path:?} -> {cand:?}");
            }
            // L'HTML servito da disco va TIMBRATO col suo rev, come fa il server
            // (stampBundleRev): senza il meta il client disattiva del tutto il
            // controllo di freschezza e la "Nuova versione disponibile" non può
            // uscire, mai. Vedi bundle_rev_from_html.
            if cand.ends_with(".html") {
                if let Ok(html) = String::from_utf8(bytes.clone()) {
                    let rev = bundle_rev_from_html(&html);
                    return Some((stamp_bundle_rev(&html, &rev).into_bytes(), mime));
                }
            }
            return Some((bytes, mime));
        }
    }
    None
}

/// Rev del bundle di un index.html: i nomi `/assets/index-*` che referenzia,
/// deduplicati e ordinati (`/assets/index-A.css,/assets/index-B.js`).
///
/// DEVE restare byte-compatibile con `readBundleRev` in
/// `server/lib/dev-bundle-reload.ts` — stessa stringa, stesso ordine. Il client
/// confronta il valore timbrato qui con quello che il SERVER gli annuncia via
/// WS (`ui:bundle-rev` / `ui:bundle-updated`): qualunque divergenza si
/// vedrebbe come una "nuova versione disponibile" perenne, che è esattamente il
/// loop fantasma già pagato una volta (2026-07-26). Solo `index-*` di proposito:
/// l'hash dell'entry copre transitivamente ogni chunk.
///
/// A mano invece che con `regex`: questa crate non ha quella dipendenza e la
/// classe di caratteri è quella del regex JS, `[A-Za-z0-9._-]`.
pub(crate) fn bundle_rev_from_html(html: &str) -> String {
    const PREFIX: &str = "/assets/index-";
    let bytes = html.as_bytes();
    let mut names: Vec<&str> = Vec::new();
    let mut i = 0usize;
    while let Some(off) = html[i..].find(PREFIX) {
        let start = i + off;
        let mut end = start + PREFIX.len();
        while end < bytes.len() {
            let c = bytes[end];
            if c.is_ascii_alphanumeric() || c == b'.' || c == b'_' || c == b'-' {
                end += 1;
            } else {
                break;
            }
        }
        names.push(&html[start..end]);
        i = end;
    }
    names.sort_unstable();
    names.dedup();
    names.join(",")
}

/// Inserisce `<meta name="topics-bundle-rev" content="…">` in testa allo `<head>`
/// (fuori se non c'è): stesso tag, stesso nome e stessa posizione di
/// `stampBundleRev` lato server, così il client legge UN solo numero comunque sia
/// arrivato il documento. Rev vuoto ⇒ HTML invariato.
pub(crate) fn stamp_bundle_rev(html: &str, rev: &str) -> String {
    if rev.is_empty() {
        return html.to_string();
    }
    let tag = format!("<meta name=\"topics-bundle-rev\" content=\"{rev}\">");
    if html.contains("<head>") {
        html.replacen("<head>", &format!("<head>{tag}"), 1)
    } else {
        format!("{tag}{html}")
    }
}

/// Recursively compute the newest mtime under `dir` (as nanos since epoch) and a
/// crude entry count. A tuple change between polls = a write burst landed. Dir
/// disappearance / permission errors collapse to `(0, 0)` — the watcher treats
/// that as "no change" and keeps polling (resilient, never panics).
pub(crate) fn public_dir_signature(dir: &std::path::Path) -> (u128, u64) {
    fn walk(dir: &std::path::Path, newest: &mut u128, count: &mut u64) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                walk(&path, newest, count);
            } else {
                *count += 1;
                if let Ok(modified) = meta.modified() {
                    if let Ok(dur) = modified.duration_since(std::time::UNIX_EPOCH) {
                        let n = dur.as_nanos();
                        if n > *newest {
                            *newest = n;
                        }
                    }
                }
            }
        }
    }
    let (mut newest, mut count) = (0u128, 0u64);
    walk(dir, &mut newest, &mut count);
    (newest, count)
}

/// Segnala a ogni webview APP-SHELL (`main` + eventuali `detach-*`) che su disco
/// c'è un bundle più nuovo, saltando le figlie `browserpane-*` (caricano il web
/// aperto, non l'app).
///
/// AVVISA, non strattona. Prima qui c'era `window.location.reload()`: la finestra
/// veniva ricaricata sotto le mani dell'utente a ogni build — pane vive azzerate,
/// messaggio a metà perso — che è ESATTAMENTE la cosa rimossa dalla metà web il
/// 2026-07-20 ("gestiamo meglio l'hot-reload"). Questo watcher era rimasto
/// indietro. Ora fa quello che fa il server: emette `topics:bundle-stale`, la
/// DevBundleToast mostra "Ricarica" e il momento lo sceglie l'utente. Stesso
/// evento del mismatch di rev via WS e della guardia sui chunk 404 → una sola
/// superficie UI, nessun doppione (il toast è un booleano).
///
/// Gira sul main thread (il registro delle webview è raggiungibile solo lì).
pub(crate) fn notify_app_shell_bundle_stale(app: &tauri::AppHandle) {
    use tauri::Manager;
    for (label, wv) in app.webviews() {
        if label.starts_with("browserpane-") {
            continue;
        }
        let _ = wv.eval("window.dispatchEvent(new CustomEvent('topics:bundle-stale'))");
    }
}

/// Whether the dev auto-updater may swap the binary and restart on its own.
///
/// The claim this replaces was that the check "lands right after a fresh start
/// rather than mid-session", and the timing said otherwise: on 2026-08-21 the
/// shell started at 14:14:11, the updater finished installing at 14:14:16 and
/// restarted the app five seconds into a session the owner of the machine was
/// already looking at. He reported it as the app having disappeared. Eight of
/// those restarts are in one week of hot-reload.log.
///
/// Elapsed time cannot answer this and I tried it first: the decision is taken
/// when the check returns, the disruption happens after a download that takes
/// seconds, so any grace generous enough to be useful is already spent by the
/// time the window comes down. The question is not how young the process is. It
/// is whether there is anything on screen to interrupt, and the window itself
/// knows: hidden means parked in the tray or not shown yet, and nobody loses
/// anything. Unknown counts as visible, because the failure this exists to
/// prevent is restarting an app somebody is using.
///
/// The rest of this file already settled the principle: the public watcher tells
/// the webviews the bundle went stale and pointedly does not reload them itself.
/// An update is the same shape of event and gets the same manners, so a visible
/// window means handing off to the toast the "Check for Updates" menu item
/// drives, and the moment is the user's.
pub(crate) fn may_relaunch_unattended(main_window_visible: Option<bool>) -> bool {
    !main_window_visible.unwrap_or(true)
}

/// Dep-free polling watcher (the `notify` crate was dropped when assets went
/// embed-only; a 1s recursive mtime scan is plenty for a manual dogfood loop and
/// adds no dependency). Blocks off-thread; on a signature change it waits for the
/// writes to go quiet (500ms), then AVVISA le webview app-shell una volta per
/// burst (`topics:bundle-stale` → toast "Ricarica"), senza ricaricarle d'ufficio.
pub(crate) fn spawn_public_watcher(app: tauri::AppHandle, public_dir: std::path::PathBuf) {
    std::thread::spawn(move || {
        let mut last = public_dir_signature(&public_dir);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let now = public_dir_signature(&public_dir);
            if now == last || now == (0, 0) {
                // No change, or the dir momentarily vanished mid-build — keep polling.
                if now != (0, 0) {
                    last = now;
                }
                continue;
            }
            // A burst started. Debounce: keep sampling until the tree stops moving
            // for 500ms, so a vite build (many files) triggers exactly ONE reload.
            let mut settled = now;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let again = public_dir_signature(&public_dir);
                if again == settled {
                    break;
                }
                settled = again;
            }
            last = settled;
            eprintln!("[hot-reload] /public changed — prompting app-shell webviews");
            let app_for_notify = app.clone();
            let _ = app.run_on_main_thread(move || notify_app_shell_bundle_stale(&app_for_notify));
        }
    });
}

/// Serve a `tauri://localhost/...` request. In dev (disk) mode, try the on-disk
/// /public first (traversal-guarded, same fallback chain as embedded) and fall
/// back to the embedded asset for anything not on disk; otherwise serve embedded —
/// byte-identical to Tauri's own handler. Replicates the non-mobile production path
/// of `crate::protocol::tauri::get_response`: strip origin/query, resolve, set
/// Content-Type (+ CSP when present) and the app-origin CORS header.
pub(crate) fn serve_tauri_asset(
    ctx: &tauri::UriSchemeContext<'_, tauri::Wry>,
    request: &tauri::http::Request<Vec<u8>>,
    dev: Option<&DevServe>,
) -> tauri::http::Response<std::borrow::Cow<'static, [u8]>> {
    use tauri::http::{header::CONTENT_TYPE, StatusCode};
    // The app origin for CORS — `tauri://localhost` on macOS/Linux,
    // `http://tauri.localhost` on Windows (see WINDOW_ORIGIN): it must match the
    // REAL origin of the document, or the browser discards every asset.

    // Panic-free fallback. This handler runs on WKURLSchemeHandler's SYNC callback —
    // the same non-unwind FFI boundary `no_abort` guards (a panic here abort()s the
    // WHOLE app, and this is the highest-traffic path in the file: every page/JS/CSS/
    // image load hits it). The response-builder `.unwrap()`s below must degrade to a
    // 500, never unwind. Built via `Response::new` + `status_mut` so there is no
    // builder `Result` to unwrap — this cannot itself panic.
    fn asset_fallback() -> tauri::http::Response<std::borrow::Cow<'static, [u8]>> {
        let mut resp =
            tauri::http::Response::new(std::borrow::Cow::Borrowed(&b"asset error"[..]));
        *resp.status_mut() = tauri::http::StatusCode::INTERNAL_SERVER_ERROR;
        resp
    }

    let uri = request.uri().to_string();
    let path = asset_request_path(&uri);

    // Dev disk hit (opt-in): serve from /public, MIME via the same parser the
    // embedded resolver uses. Misses fall through to embedded so a partial dist boots.
    if let Some(dev) = dev {
        if let Some((bytes, mime)) = disk_asset_response(&dev.public_dir, &path) {
            return tauri::http::Response::builder()
                .header(CONTENT_TYPE, mime)
                .header("Access-Control-Allow-Origin", WINDOW_ORIGIN)
                // Hot-reload mode: NEVER let WKWebView cache the disk-served shell.
                // Without this it heuristically caches index.html/boot.js (no
                // Cache-Control ⇒ freshness heuristic) and then re-serves the STALE
                // document on the next launch/reload, bypassing this handler — the
                // "still on the old version after a build" bug. Hashed assets change
                // filename per build, so no-store on all disk hits is harmless.
                .header("Cache-Control", "no-store, must-revalidate")
                .body(std::borrow::Cow::Owned(bytes))
                .unwrap_or_else(|_| asset_fallback());
        }
    }

    // Embedded fallback (and the default when dev mode is off). `asset_resolver`
    // runs the full path→.html→/index.html→index.html chain + CSP injection, so this
    // is exactly the built-in behavior.
    match ctx.app_handle().asset_resolver().get(path) {
        Some(asset) => {
            let mut builder = tauri::http::Response::builder()
                .header(CONTENT_TYPE, &asset.mime_type)
                .header("Access-Control-Allow-Origin", WINDOW_ORIGIN);
            if let Some(csp) = &asset.csp_header {
                builder = builder.header("Content-Security-Policy", csp);
            }
            builder
                .body(std::borrow::Cow::Owned(asset.bytes))
                .unwrap_or_else(|_| asset_fallback())
        }
        None => tauri::http::Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(CONTENT_TYPE, "text/plain")
            .header("Access-Control-Allow-Origin", WINDOW_ORIGIN)
            .body(std::borrow::Cow::Borrowed(&b"asset not found"[..]))
            .unwrap_or_else(|_| asset_fallback()),
    }
}

/// First-run wiring of the app: runs once, inside Tauri's `setup` hook.
pub(crate) fn app_setup(
    app: &mut tauri::App,
    dev_serve: Option<DevServe>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Il path del PRIMO lancio: `topics /Users/x/progetto`, o il doppio
    // click su un file quando Topics non era ancora vivo. Qui la webview
    // non esiste, quindi si ACCODA e basta: la sveglia sarebbe un evento
    // dispatchato dentro una pagina che non c'è. Lo ritira il client al
    // mount, che è il primo istante in cui c'è qualcuno che sa aprirlo.
    {
        let argv: Vec<String> = std::env::args().collect();
        os_open::queue_os_open_paths(os_open::open_paths_from_args(&argv));
    }
    if cfg!(debug_assertions) {
        app.handle().plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )?;
    }

    // Was the whole app replaced by the last update, or only the part that
    // was not running? Off-thread: it reads every bundled binary.
    sidecar_integrity::warm_in_background();

    // Local-dev auto-update (opt-in, per-machine): when this shell runs on a
    // dev machine that opted in (see `dev_auto_update_enabled`), pull the newest
    // signed release. Gated on the dev marker so it NEVER fires for prod
    // installs. Runs once per launch, off-thread. Whether it may install and
    // relaunch on its own, or has to hand the update to the opt-in toast, is
    // may_relaunch_unattended: with a window on screen, a restart is somebody's
    // app vanishing, so the update gets offered instead of taken.
    if dev_auto_update_enabled() {
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            use tauri::Manager;
            use tauri_plugin_updater::UpdaterExt;
            let updater = match handle.updater() {
                Ok(u) => u,
                Err(e) => {
                    log_hot_reload_decision(&format!("auto-update: no updater ({e})"));
                    return;
                }
            };
            match updater.check().await {
                Ok(Some(update)) => {
                    let v = update.version.clone();
                    // get_window, not get_webview_window: the latter filters out
                    // any window hosting a browser pane and would answer None
                    // exactly when the user has one open.
                    let visible = handle
                        .get_window("main")
                        .and_then(|w| w.is_visible().ok());
                    if !may_relaunch_unattended(visible) {
                        // Somebody is looking at this window. Offer, do not take.
                        //
                        // THE OFFER IS NOT PUSHED FROM HERE, and for a
                        // while it was: this branch used to eval a
                        // `topics:check-for-updates` event into every
                        // app-shell webview. This check runs once, in
                        // `setup`, about a second after the process
                        // starts - the page is still loading and the
                        // client has not attached that listener yet, so
                        // the event was dispatched into nobody. Read in
                        // hot-reload.log on 2026-09-07: launch 11:42:24,
                        // "2.2.277 offered to the toast" 11:42:25, and
                        // the person in front of the app saw nothing.
                        //
                        // The client runs the same check by itself a few
                        // seconds after it mounts, with the listener in
                        // place and the toast to draw the answer
                        // (`lib/shell/updateCheckSchedule.ts`), so what
                        // is left here is the honest log line.
                        log_hot_reload_decision(&format!(
                            "auto-update: {v} available, left to the app shell (window already up)"
                        ));
                        return;
                    }
                    log_hot_reload_decision(&format!("auto-update: installing {v}"));
                    if let Err(e) =
                        update.download_and_install(|_, _| {}, || {}).await
                    {
                        log_hot_reload_decision(&format!(
                            "auto-update: install {v} failed ({e})"
                        ));
                        return;
                    }
                    log_hot_reload_decision(&format!(
                        "auto-update: installed {v}, relaunching"
                    ));
                    handle.restart();
                }
                Ok(None) => log_hot_reload_decision("auto-update: up to date"),
                Err(e) => {
                    log_hot_reload_decision(&format!("auto-update: check failed ({e})"))
                }
            }
        });
    }

    // Global hotkey (Electron parity): Cmd/Ctrl+Alt+T toggles always-on-top.
    // Only this one shortcut is registered, so the handler needn't match it.
    // The chord registration is NON-fatal: if it's already taken system-wide
    // we log and carry on (Electron does the same) — never block startup on it.
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::{Builder as GlobalShortcutBuilder, GlobalShortcutExt, ShortcutState};
        app.handle().plugin(
            GlobalShortcutBuilder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle_always_on_top(app);
                    }
                })
                .build(),
        )?;
        if let Err(e) = app.handle().global_shortcut().register("CommandOrControl+Alt+T") {
            log::warn!("[topics] Cmd+Alt+T global shortcut not registered: {e}");
        }
    }

    // Forward app keyboard shortcuts (⌘W, ⌘⇧Tab, ⌘1-9…) to the renderer
    // when a child browser pane holds focus and would otherwise swallow
    // the keydown. macOS-only (NSEvent local monitor); see the fn doc.
    #[cfg(target_os = "macos")]
    install_shortcut_forwarder(app.handle());

    // Windows: nothing translates the menu's accelerator table, so
    // Ctrl+Q and the zoom chords reach the app only through the WebView2
    // accelerator hook armed here on the main window's UI webview (the
    // other windows arm it as they are built). See `menu_chords_win`.
    #[cfg(target_os = "windows")]
    menu_chords_win::install(app.handle(), "main");

    // Global right-⌘ TAP → focus the board task composer, even when Topics
    // is in the background (from any other app). Needs Accessibility trust
    // for the global key monitor — request it ONCE (see the fn), then arm the
    // monitor. The monitor is harmless without trust: it simply receives no
    // events, so arming it unconditionally costs nothing.
    #[cfg(target_os = "macos")]
    {
        install_accessibility_prompt(app.handle());
        install_global_cmd_tap(app.handle());
    }

    // UserNotifications delegate + one-time authorization request (first
    // launch shows the system prompt). Bundled-only; see the module doc.
    #[cfg(target_os = "macos")]
    macos_notifications::install(app.handle());

    // Push Focus/DND changes to the webview so the completion notifier can
    // fall silent while a Focus is on (best-effort; see `macos_focus`).
    #[cfg(target_os = "macos")]
    spawn_focus_watcher(app.handle().clone());

    // Dev hot-reload (Electron-prod parity). By default the frontend is
    // EMBEDDED (include_bytes! over frontendDist) and served from
    // tauri://localhost — a `vite build` does nothing for a running binary.
    // The custom `tauri` protocol (see run() head) opts INTO disk-serving
    // /public when a dev marker is set; here we start the watcher that
    // PROMPTS the app-shell webviews when that on-disk /public changes, one
    // prompt per build burst. OFF (no watcher) when the marker is absent, so
    // release behavior is unchanged. Uses the SAME value the protocol handler
    // captured (resolved eagerly before the Builder — no race, no re-read).
    {
        if let Some(dev) = dev_serve.clone() {
            spawn_public_watcher(app.handle().clone(), dev.public_dir);
        }
    }

    // Env-gated sidebar FPS self-test: drive real collapse/expands and sample
    // rAF frame timing, writing the summary to /tmp/topics-fps-selftest.json.
    // OFF unless TOPICS_FPS_SELFTEST is set. The `fps_report` sink command is
    // debug-only (see its #[cfg(debug_assertions)]), so this probe only works
    // in debug builds even when the env var is set in release.
    #[cfg(debug_assertions)]
    if std::env::var("TOPICS_FPS_SELFTEST").is_ok() {
        eprintln!("[fps-selftest] armed");
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(7));
            let h = handle.clone();
            // The window registry is only reliably reachable on the main thread,
            // and this multi-webview app exposes the UI as get_webview("main")
            // (not a unified WebviewWindow — see browser_release_focus).
            let _ = handle.run_on_main_thread(move || {
                use tauri::Manager;
                // Un-occlude the window first: WKWebView throttles requestAnimationFrame
                // when the window's pixels aren't on screen (occluded behind others) —
                // the headless "no frames sampled" failure. rAF pauses on OCCLUSION, not
                // on key-status, so `always_on_top` (float above everything → visible)
                // resumes it even when macOS denies foreground focus to a shell-launched
                // app. This is a disposable debug instance (env-gated, never on in
                // normal use), so always-on-top is left on — toggle it off from the
                // tray, or just quit, when done.
                // Use get_window (the "main" WINDOW exists even in this multi-webview
                // app — browser_open relies on it; get_webview_window may be None).
                if let Some(win) = h.get_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_always_on_top(true);
                    let _ = win.set_focus();
                    let vis = win.is_visible().unwrap_or(false);
                    let minz = win.is_minimized().unwrap_or(false);
                    eprintln!("[fps-selftest] window main: visible={vis} minimized={minz} (always_on_top+focus applied)");
                } else {
                    eprintln!("[fps-selftest] get_window(main) = None");
                }
                if let Some(wv) = h.get_webview("main") {
                    eprintln!("[fps-selftest] injecting via get_webview(main)");
                    match wv.eval(FPS_SELFTEST_JS) {
                        Ok(()) => eprintln!("[fps-selftest] eval ok"),
                        Err(e) => eprintln!("[fps-selftest] eval err: {e}"),
                    }
                } else if let Some(win) = h.get_webview_window("main") {
                    eprintln!("[fps-selftest] injecting via get_webview_window(main)");
                    let _ = win.eval(FPS_SELFTEST_JS);
                } else {
                    eprintln!("[fps-selftest] no main webview/window");
                }
            });
        });
    }

    // Env-gated polish-bug verifier: drives the dropdown/sidebar and dumps
    // DOM findings to /tmp/topics-fps-selftest.json. OFF unless set.
    #[cfg(debug_assertions)]
    if std::env::var("TOPICS_BUGFIX_VERIFY").is_ok() {
        eprintln!("[bugfix-verify] armed");
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(8));
            let h = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                use tauri::Manager;
                if let Some(wv) = h.get_webview("main") {
                    eprintln!("[bugfix-verify] injecting via get_webview(main)");
                    match wv.eval(BUGFIX_VERIFY_JS) {
                        Ok(()) => eprintln!("[bugfix-verify] eval ok"),
                        Err(e) => eprintln!("[bugfix-verify] eval err: {e}"),
                    }
                } else if let Some(win) = h.get_webview_window("main") {
                    let _ = win.eval(BUGFIX_VERIFY_JS);
                } else {
                    eprintln!("[bugfix-verify] no main webview/window");
                }
            });
        });
    }

    // Env-gated SLOW-MOTION sidebar slide: stretch the slide so a capture burst
    // can confirm the native browser pane tracks the sidebar edge. OFF unless set.
    #[cfg(debug_assertions)]
    if std::env::var("TOPICS_SLIDE_DEMO").is_ok() {
        eprintln!("[slide-demo] armed");
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(8));
            let h = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                use tauri::Manager;
                if let Some(wv) = h.get_webview("main") {
                    eprintln!("[slide-demo] injecting via get_webview(main)");
                    let _ = wv.eval(SLIDE_DEMO_JS);
                }
            });
        });
    }

    // Env-gated SPLIT-resize FPS self-test: drive a divider drag and sample rAF.
    #[cfg(debug_assertions)]
    if std::env::var("TOPICS_SPLIT_SELFTEST").is_ok() {
        eprintln!("[split-selftest] armed");
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(8));
            let h = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                use tauri::Manager;
                // Un-occlude (always_on_top) so rAF runs — see the FPS probe note above.
                if let Some(win) = h.get_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_always_on_top(true);
                    let _ = win.set_focus();
                }
                if let Some(wv) = h.get_webview("main") {
                    eprintln!("[split-selftest] injecting via get_webview(main)");
                    match wv.eval(SPLIT_SELFTEST_JS) {
                        Ok(()) => eprintln!("[split-selftest] eval ok"),
                        Err(e) => eprintln!("[split-selftest] eval err: {e}"),
                    }
                } else {
                    eprintln!("[split-selftest] no main webview");
                }
            });
        });
    }

    // Env-gated COST self-test: measure per-frame style+layout cost of a split-drag
    // (+ sidebar toggle reflow) — empirical, works headless (no rAF/visibility needed).
    #[cfg(debug_assertions)]
    if std::env::var("TOPICS_COST_SELFTEST").is_ok() {
        eprintln!("[cost-selftest] armed");
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(8));
            let h = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                use tauri::Manager;
                if let Some(wv) = h.get_webview("main") {
                    eprintln!("[cost-selftest] injecting via get_webview(main)");
                    match wv.eval(COST_SELFTEST_JS) {
                        Ok(()) => eprintln!("[cost-selftest] eval ok"),
                        Err(e) => eprintln!("[cost-selftest] eval err: {e}"),
                    }
                } else {
                    eprintln!("[cost-selftest] no main webview");
                }
            });
        });
    }

    // Env-gated BROWSER self-test: open a native pane, eval into it, close it —
    // confirms the browser open→eval path end-to-end (no window visibility needed).
    #[cfg(debug_assertions)]
    if std::env::var("TOPICS_BROWSER_SELFTEST").is_ok() {
        eprintln!("[browser-selftest] armed");
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(8));
            let h = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                use tauri::Manager;
                if let Some(wv) = h.get_webview("main") {
                    eprintln!("[browser-selftest] injecting via get_webview(main)");
                    match wv.eval(BROWSER_SELFTEST_JS) {
                        Ok(()) => eprintln!("[browser-selftest] eval ok"),
                        Err(e) => eprintln!("[browser-selftest] eval err: {e}"),
                    }
                } else {
                    eprintln!("[browser-selftest] no main webview");
                }
            });
        });
    }

    // Delayed window-size probe: the window-state plugin may apply the RESTORED
    // geometry slightly AFTER this setup closure runs, so the immediate read above
    // can report the config default. Re-read on the main thread after 5s for the
    // TRUE post-restore size. Diagnostic-only (stderr).
    {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let h = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                use tauri::Manager;
                // get_webview_window("main") can be None in this multi-webview app;
                // iterate the WINDOWS and match the label.
                //
                // «(proven reliable)» diceva questa riga di
                // `webview_windows()`, ed è la frase che ha propagato
                // l'errore in mezzo file: quella mappa tiene solo le
                // finestre con UNA sola webview, quindi con una pane
                // browser aperta è vuota proprio dove serve. Qui servono
                // API di FINESTRA (outer_size / outer_position /
                // scale_factor), quindi la collezione giusta è
                // `windows()`. Vedi `reload_all_ui_windows`, dove la
                // stessa confusione teneva muto ⌘R.
                for (label, win) in h.windows() {
                    if label != "main" { continue; }
                    if let (Ok(os), Ok(pos), Ok(sf)) =
                        (win.outer_size(), win.outer_position(), win.scale_factor())
                    {
                        eprintln!(
                            "[window-restore+5s] outer={}x{} pos={},{} scale={} logical={}x{}",
                            os.width, os.height, pos.x, pos.y, sf,
                            (os.width as f64 / sf).round(),
                            (os.height as f64 / sf).round()
                        );
                    }
                }
            });
        });
    }

    // Env-gated tab-focus self-test: drive the AppKit first-responder round-trip
    // (grab to a browser pane → release → assert it returned to the main webview),
    // writing the verdict to /tmp/topics-focus-selftest.json. OFF unless
    // TOPICS_FOCUS_SELFTEST is set. Needs a browser pane in the restored layout.
    #[cfg(debug_assertions)]
    if std::env::var("TOPICS_FOCUS_SELFTEST").is_ok() {
        eprintln!("[focus-selftest] armed");
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(8));
            let h = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                use tauri::Manager;
                if let Some(wv) = h.get_webview("main") {
                    eprintln!("[focus-selftest] injecting via get_webview(main)");
                    match wv.eval(FOCUS_SELFTEST_JS) {
                        Ok(()) => eprintln!("[focus-selftest] eval ok"),
                        Err(e) => eprintln!("[focus-selftest] eval err: {e}"),
                    }
                } else {
                    eprintln!("[focus-selftest] no main webview");
                }
            });
        });
    }

    // Env-gated browser-corner visual demo: open a native browser pane in the
    // BOTTOM-RIGHT quadrant (flush right+bottom, NOT left/top) so a screenshot can
    // confirm only the bottom-right corner is rounded to the window radius while the
    // pane's inner (top-left) corner stays square. OFF unless TOPICS_CORNER_DEMO set.
    #[cfg(target_os = "macos")]
    if std::env::var("TOPICS_CORNER_DEMO").is_ok() {
        eprintln!("[corner-demo] armed");
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(6));
            let h = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                // Park the window on the PRIMARY display (global 30,80 — fits a
                // 1656-wide window inside the 1728pt-wide main display, so the
                // bottom-right corner is on-screen) for a reliable screenshot.
                {
                    use tauri::Manager;
                    if let Some(win) = h.get_window("main") {
                        let _ = win.set_position(tauri::LogicalPosition::new(30.0, 80.0));
                    }
                }
                if let Some((ww, wh)) = main_window_logical_size(&h) {
                    let x = (ww / 2.0).round();
                    let y = (wh / 2.0).round();
                    let w = (ww - x).round();
                    let ht = (wh - y).round();
                    eprintln!("[corner-demo] open at {x},{y} {w}x{ht} (win {ww}x{wh})");
                    match browser_open(
                        h.clone(),
                        "cornerdemo".into(),
                        "https://example.com".into(),
                        x,
                        y,
                        w,
                        ht,
                        None,
                        None, // window_label: demo runs against main
                    ) {
                        Ok(_) => eprintln!("[corner-demo] opened ok"),
                        Err(e) => eprintln!("[corner-demo] open err: {e}"),
                    }
                } else {
                    eprintln!("[corner-demo] no window size");
                }
            });
        });
    }

    // Env-gated sidebar-reclaim visual demo: park on the primary display, then
    // toggle the sidebar so a screenshot pair (before/after) shows the content
    // reclaiming the freed strip. OFF unless TOPICS_SIDEBAR_DEMO set.
    #[cfg(target_os = "macos")]
    if std::env::var("TOPICS_SIDEBAR_DEMO").is_ok() {
        eprintln!("[sidebar-demo] armed");
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(6));
            let h = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                use tauri::Manager;
                if let Some(win) = h.get_window("main") {
                    let _ = win.set_position(tauri::LogicalPosition::new(30.0, 80.0));
                }
            });
            std::thread::sleep(std::time::Duration::from_secs(2));
            let h2 = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                use tauri::Manager;
                if let Some(wv) = h2.get_webview("main") {
                    let _ = wv.eval("window.__topicsToggleSidebar&&window.__topicsToggleSidebar()");
                    eprintln!("[sidebar-demo] toggled");
                }
            });
        });
    }

    // Decide the data-server upstream, THEN start the loopback proxy. On a
    // machine with an external server on :3333 we defer to it (TLS proxy, as
    // before); on a virgin machine we spawn the bundled sidecar (plain HTTP,
    // isolated data dir) and point the proxy there. `decide_upstream_and_spawn`
    // sets `UPSTREAM` then RETURNS (its up-to-20s sidecar health wait is now
    // fire-and-forget), so run_tls_proxy binds :13333 immediately — the virgin
    // machine no longer sits on "connecting" for the whole cold start.
    // Reachable from AppKit notification callbacks, which carry no user data.
    let _ = SHELL_APP.set(app.handle().clone());
    // Display change / wake → re-anchor + bounce (PORTING-PLAN T1.3).
    #[cfg(target_os = "macos")]
    wire_recompose_observers();

    {
        let app_for_boot = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            decide_upstream_and_spawn(app_for_boot.clone()).await;
            // The recovery path, started for BOTH upstreams (external server
            // and bundled sidecar) — see `watch_upstream`. Spawned before the
            // proxy because `run_tls_proxy` never returns.
            tauri::async_runtime::spawn(watch_upstream(app_for_boot));
            run_tls_proxy().await;
        });
    }

    // WINDOWS: no system title bar on the main window either.
    //
    // The main window is declared in `tauri.conf.json`, which has no
    // per-platform branch: `decorations: true` there is right for macOS
    // (the bar holds the traffic lights and `titleBarStyle: Overlay`
    // blends it into the app's own row) and wrong for Windows, where the
    // app draws its own bar (App.tsx, `app-drag-region`) and the native
    // one simply stacks on top. Reported 2026-08-26: "the Windows build
    // has the system bar we had removed".
    //
    // Done HERE and not in the config because the config cannot say
    // "except on Windows". Failing is not fatal: a window with one bar too
    // many is worse-looking, a window that fails to open is worse.
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        for (label, win) in app.webview_windows() {
            if let Err(e) = win.set_decorations(false) {
                eprintln!("[chrome] {label}: set_decorations(false) failed: {e}");
            }
            // Without a native frame Windows also drops the drop shadow and
            // the rounded corners; the shadow is what separates the window
            // from whatever is behind it. `set_shadow` puts it back.
            let _ = win.set_shadow(true);
        }
    }

    // The window comes back from minimised and the webview stops
    // painting. The hook goes HERE, outside the macOS block below, which
    // is exactly where the first attempt put it by mistake: a line
    // guarded for Windows inside a block that on Windows does not exist
    // compiles nowhere, and no `cargo check` can say so.
    #[cfg(target_os = "windows")]
    windows_repaint::wire(app.handle());

    // Focus of the main window, told to its page, on every platform (see
    // `window_focus.rs`). Outside any cfg block on purpose.
    {
        use tauri::Manager;
        if let Some(main) = app.get_window("main") {
            window_focus::wire(&main, "main".to_string());
        }
    }

    // The DWM backdrop behind the window. Unguarded because the entry
    // point is a no-op off Windows, which keeps this call site inside
    // what a Mac `cargo check` reads. It runs AFTER the decorations are
    // dropped above: the backdrop is a property of the window, not of
    // its frame, and re-applying it later is idempotent anyway.
    windows_acrylic::wire(app.handle());

    // Traffic lights hidden by default — revealed on demand when the
    // Topics menu opens (parity with the Electron shell).
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        // Qui `webview_windows()` va bene, ed è l'unico posto in cui lo
        // è: si è dentro `.setup()`, prima che l'event loop parta e
        // quindi prima che il frontend possa aver chiesto una sola pane
        // browser (`browser_open` è un comando: nasce da un click). Con
        // zero pane la mappa filtrata e quella completa coincidono.
        // Altrove no — vedi `reload_all_ui_windows`.
        for (_label, win) in app.webview_windows() {
            apply_traffic_lights(&win, false);
            // NOTE: masking the content view (round_window_content_corners) to
            // round browser-pane corners BROKE main-window auto-resize + sidebar
            // spacing (masksToBounds/wantsLayer on the content view disturbs the
            // transparent-titlebar layout + the vibrancy resize cover). Reverted;
            // round the child browser webview's own layer instead if needed.
            // Live window-edge resize: AppKit posts WillStart/DidEnd live-resize
            // notifications SYNCHRONOUSLY (unlike tao's WindowEvent::Resized, which
            // is only drained at gesture end), so we swap to an autoresizing frost
            // cover for the duration of the drag.
            wire_live_resize_cover(&win);
            // RESTORE the saved geometry ourselves (see win_size_file) — ALL in
            // LOGICAL points, the one coherent global space on macOS. History of
            // this block: the tauri-plugin-window-state plugin mis-handled scale
            // (saved physical-as-logical, restored blindly off-screen); then our
            // own store kept position in tao-"physical" pixels, which are scaled
            // by the CURRENT monitor's backing factor — on a mixed-DPI setup the
            // window is born on the scale-2 primary (`center: true`) while the
            // position was saved from a scale-1 external, so the restore landed
            // at HALF the coordinates and the next throttled save ratcheted the
            // wrong spot into the store ("la finestra perde la posizione" on
            // every relaunch/update). Now: saved logical position → validated
            // against LOGICAL monitor rects → applied as LogicalPosition FIRST
            // (so the size below lands on the destination display), then the
            // logical size; center only when no usable position is stored.
            if _label == "main" {
                let store = win_size_file(app.handle());
                let saved_size = store.as_ref().and_then(|p| read_win_size_logical(p));
                let saved_pos = store.as_ref().and_then(|p| read_win_position_logical(p));
                let placed = if let Some(saved) = saved_pos {
                    // Clamp with the SAVED footprint (what the window is about to
                    // become), not the pre-restore config-default frame.
                    let win_size = saved_size
                        .map(|(w, h)| (w.round() as u32, h.round() as u32))
                        .unwrap_or((1200, 800));
                    let monitors = logical_monitors(&win.as_ref().window());
                    if let Some((nx, ny)) =
                        clamp_position_to_monitors(saved, win_size, &monitors)
                    {
                        let _ = win
                            .set_position(tauri::LogicalPosition::new(nx as f64, ny as f64));
                        eprintln!(
                            "[window-restore] applied logical position {nx},{ny} (saved {},{})",
                            saved.0, saved.1
                        );
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                if let Some((lw, lh)) = saved_size {
                    let _ = win.set_size(tauri::LogicalSize::new(lw, lh));
                    eprintln!("[window-restore] applied logical {lw}x{lh}");
                }
                if !placed {
                    // No usable saved position (fresh install, or a legacy store
                    // whose physical x/y are ambiguous on mixed-DPI — dropped on
                    // purpose, see read_win_position_logical) — set_size grows
                    // from the top-left, so center to keep the window on its
                    // display. The next save writes lx/ly and this never re-runs.
                    let _ = win.center();
                    eprintln!("[window-restore] no saved position — centered");
                }
                if let (Ok(os), Ok(op), Ok(sf)) =
                    (win.outer_size(), win.outer_position(), win.scale_factor())
                {
                    eprintln!(
                        "[window-restore] main now outer={}x{} @ {},{} scale={} logical={}x{}",
                        os.width, os.height, op.x, op.y, sf,
                        (os.width as f64 / sf).round(),
                        (os.height as f64 / sf).round()
                    );
                }
            }
            // Re-assert the desired visibility whenever AppKit might have
            // reset it (focus gained/lost, resize) — otherwise the buttons
            // reappear on the first focus of a transparent-titlebar window.
            let w = win.clone();
            // Persist window SIZE on resize (throttled) so a SIGTERM, crash, or the
            // dev relaunch loop NEVER loses it (the plugin only saved on graceful quit,
            // and CloseRequested hides to tray, so a plain kill saved nothing). Self-
            // managed in LOGICAL units — see win_size_file for why we don't use the plugin.
            let save_gate = std::sync::Arc::new(std::sync::Mutex::new(
                std::time::Instant::now() - std::time::Duration::from_secs(2),
            ));
            let trailing_queued =
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let size_file = win_size_file(app.handle());
            // Persist SIZE + POSITION in LOGICAL points (see the win_size_file
            // note: tao-physical is per-monitor-scaled, wrong across mixed-DPI
            // displays). The leading edge writes at once; the trailing write is
            // the one that survives a kill. See save_timing for why.
            let save_state_throttled = move |w: &tauri::Window| {
                let timing = {
                    let g = match save_gate.lock() { Ok(g) => g, Err(_) => return };
                    save_timing(
                        g.elapsed(),
                        GEOMETRY_SAVE_INTERVAL,
                        trailing_queued.load(Ordering::Relaxed),
                    )
                };
                match timing {
                    SaveTiming::Queued => {}
                    SaveTiming::Now => {
                        if let Ok(mut g) = save_gate.lock() {
                            *g = std::time::Instant::now();
                        }
                        write_geometry_now(size_file.as_ref(), w);
                    }
                    SaveTiming::After(delay) => {
                        trailing_queued.store(true, Ordering::Relaxed);
                        let win = w.clone();
                        let gate = save_gate.clone();
                        let queued = trailing_queued.clone();
                        let path = size_file.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(delay);
                            queued.store(false, Ordering::Relaxed);
                            if let Ok(mut g) = gate.lock() {
                                *g = std::time::Instant::now();
                            }
                            let inner = win.clone();
                            let _ = win.run_on_main_thread(move || {
                                let _ = no_abort("trailing-geometry-save", || {
                                    write_geometry_now(path.as_ref(), &inner);
                                    Ok(())
                                });
                            });
                        });
                    }
                }
            };
            win.on_window_event(move |event| match event {
                tauri::WindowEvent::Resized(_) => {
                    // PROGRAMMATIC resize path (set_size / zoom): these deliver
                    // Resized promptly and post NO live-resize notification, so the
                    // cover is sized here. (Interactive drags are handled by the
                    // notification + autoresizing mask above.)
                    vibrancy_resize_cover(&w);
                    save_state_throttled(&w.as_ref().window());
                    // Same titlebar re-pin as a focus change.
                    let visible = TRAFFIC_LIGHTS_VISIBLE.load(Ordering::Relaxed)
                        || w.is_fullscreen().unwrap_or(false);
                    apply_traffic_lights(&w, visible);
                }
                tauri::WindowEvent::Moved(_) => {
                    save_state_throttled(&w.as_ref().window());
                }
                tauri::WindowEvent::Focused(_) => {
                    // In fullscreen the titlebar is gone, so FORCE the
                    // traffic lights visible — otherwise (hidden-by-default
                    // + hidden green button) the only way out is the View ▸
                    // Full Screen accelerator, which is a trap for anyone
                    // who doesn't know it. Otherwise honor the menu state.
                    let visible = TRAFFIC_LIGHTS_VISIBLE.load(Ordering::Relaxed)
                        || w.is_fullscreen().unwrap_or(false);
                    apply_traffic_lights(&w, visible);
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Hide to the tray instead of closing (the tray's "Esci"
                    // and ⌘Q set QUITTING so a real quit still passes through).
                    if !QUITTING.load(Ordering::Relaxed) {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                }
                _ => {}
            });
        }
    }

    // System tray: keep the app reachable (Show / Quit) when its window is
    // hidden. Electron ships a tray; without one a hidden Tauri window leaves
    // the user no way back in or out. Unread / Claude-phase status wiring
    // stays in the client WS layer (a later step) — this is the baseline.
    {
        use tauri::menu::{MenuBuilder, MenuItem};
        use tauri::tray::TrayIconBuilder;
        let handle = app.handle();
        let show = MenuItem::with_id(handle, "tray-show", "Mostra Topics", true, None::<&str>)?;
        let quit = MenuItem::with_id(handle, "tray-quit", "Esci", true, None::<&str>)?;
        let tray_menu = MenuBuilder::new(handle).items(&[&show, &quit]).build()?;
        let mut builder = TrayIconBuilder::with_id("main")
            .tooltip("Topics")
            .menu(&tray_menu)
            .on_menu_event(|app, event| {
                let id = event.id().0.as_str();
                if id == "tray-show" {
                    reveal_a_window(app);
                } else if id == "tray-quit" {
                    QUITTING.store(true, Ordering::Relaxed);
                    app.exit(0);
                } else if id == "tray-new-chat" {
                    // Stesso bus del composer: la riga della tray non è un
                    // gesto nuovo, è la stessa porta vista da fuori.
                    tray_dispatch(app, "topics:new-chat", None);
                } else if id == "tray-check-updates" {
                    // Identico alla voce del menu nativo (updater_check +
                    // UpdaterToast lato client).
                    tray_dispatch(app, "topics:check-for-updates", None);
                } else if id.starts_with("machine-open:") {
                    // Every machine's detail lives in the Processes view.
                    tray_dispatch(app, "topics:tray-open-processes", None);
                } else if id.starts_with("board:") {
                    // La testa della sezione e il piede di ogni sottomenu:
                    // portano alla board, che è dove il lavoro si guarda per
                    // intero. Lo stato dopo i due punti non seleziona niente
                    // (la board mostra tutte le colonne), serve solo a dare
                    // un id distinto a ogni riga.
                    tray_dispatch(app, "topics:tray-open-board", None);
                } else if let Some(task_id) = id.strip_prefix("task:") {
                    // Una riga di un sottomenu di stato: apre QUEL task, cioè
                    // il deep-link `/task/<id>` che già apre il cassetto dalla
                    // cronologia delle notifiche.
                    tray_dispatch(app, "topics:tray-open-task", Some(("taskId", task_id)));
                } else if let Some(topic_id) = id.strip_prefix("nav:") {
                    // A dynamic attention row (set by `set_app_status`): surface
                    // the window and hand the topic id to the renderer, which
                    // opens/focuses it exactly like a sidebar click. A DOM
                    // CustomEvent (not a Tauri event) keeps the client free of
                    // the @tauri-apps/event dependency — same bridge the native
                    // shortcut forwarder uses.
                    tray_dispatch(app, "topics:tray-navigate", Some(("topicId", topic_id)));
                }
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        let _ = builder.build(app.handle())?;
        // The quota strip polls the service itself (hidden window, restarted
        // client: it keeps updating). Card c675633f.
        let tray_handle = app.handle().clone();
        tray_quota::spawn_poller(move |strip| {
            if let Some(tray) = tray_handle.tray_by_id("main") {
                let img = tauri::image::Image::new_owned(strip.rgba, strip.width, strip.height);
                let _ = tray.set_icon(Some(img));
                #[cfg(target_os = "macos")]
                let _ = tray.set_icon_as_template(false);
            }
        });
    }

    // Restore the persisted always-on-top state (Electron parity — it was
    // an in-memory flag that reset to off every launch).
    {
        use tauri::Manager;
        let on = read_aot(app.handle());
        ALWAYS_ON_TOP.store(on, Ordering::Relaxed);
        if on {
            if let Some(w) = app.get_window("main") {
                let _ = w.set_always_on_top(true);
            }
        }
    }

    Ok(())
}

/// Process-level run events: dock reopen, Finder open, exit-time saves and sidecar kill.
pub(crate) fn on_run_event(app_handle: &tauri::AppHandle, event: tauri::RunEvent) {
    // macOS dock-icon click while the app is hidden-to-tray: bring the
    // window back (Electron parity: app.on('activate')). Without this the
    // dock icon is DEAD once the red button / ⌘W parks the app in the tray
    // — the only way back was the tray menu. RunEvent::Reopen fires on the
    // dock click (and on `open` with no windows). The variant only EXISTS
    // on macOS — an unguarded match arm breaks the Windows/Linux compile
    // (first cross-platform CI build caught it).
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Reopen { .. } = event {
        reveal_a_window(app_handle);
    }
    // Finder «Apri con Topics» e trascinamento sull'icona: su macOS NON
    // passano da argv. Arrivano come Apple Event, e Tauri li rigira qui
    // come `file://…`. È l'unico canale del Finder: senza questo ramo la
    // voce nel menu «Apri con» c'è ma non apre niente, che è peggio di
    // non esserci.
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Opened { ref urls } = event {
        let paths: Vec<String> = urls.iter().map(|u| u.to_string()).collect();
        deliver_os_open_paths(app_handle, paths);
    }
    // Final geometry save on the way out — fires on ⌘Q, tray "Esci", the
    // status-bar relaunch AND the updater restart (AppHandle::restart()
    // triggers ExitRequested before Exit). The throttled Moved/Resized
    // saves are leading-edge and CloseRequested only hides to tray, so
    // without this the last position before an "Aggiorna" could be lost.
    // The windows are still alive at ExitRequested (not yet at Exit).
    if let tauri::RunEvent::ExitRequested { .. } = event {
        let _ = no_abort("exit-save-geometry", || {
            save_main_window_geometry(app_handle);
            Ok(())
        });
    }
    // Kill the bundled server sidecar (if we spawned one) as the app exits,
    // so no orphan server process outlives the shell. Exit fires on the real
    // quit paths (tray "Esci", ⌘Q → app.exit(0)); no-op when we deferred to
    // an external server (SIDECAR_CHILD is None). `_app_handle` unused here.
    if let tauri::RunEvent::Exit = event {
        kill_sidecar();
    }
}

/// The app origin is NOT the same on every system, and these tests run on a
/// single machine: without them the defect only shows up once installed on
/// Windows, where the symptom is a completely empty window — no error, no log,
/// nothing to start from.
///
/// On 2026-08-26, on the 2.2.172 installed on Windows 11, the window opened
/// transparent and stayed that way: wry on WebView2 cannot register a custom
/// scheme, so Tauri serves the app from `http://tauri.localhost`, and three
/// spots in this file assumed `tauri://localhost`.
#[cfg(test)]
mod app_origin_tests {
    use super::{asset_request_path, is_app_origin};

    /// The asset key must be the same whichever of the two origins the request
    /// arrives from. Before, on Windows, the prefix was not stripped and the key
    /// became the whole URL: no asset EVER matched.
    #[test]
    fn asset_path_is_origin_independent() {
        for origin in ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"] {
            assert_eq!(asset_request_path(&format!("{origin}/index.html")), "index.html");
            assert_eq!(asset_request_path(&format!("{origin}/assets/index-Aa.js")), "assets/index-Aa.js");
            // Bare root ⇒ the single-page app.
            assert_eq!(asset_request_path(&format!("{origin}/")), "index.html");
            assert_eq!(asset_request_path(origin), "index.html");
            // Query and fragment are not part of the key (the detached window's
            // ?topics=… goes through here on every startup).
            assert_eq!(asset_request_path(&format!("{origin}/index.html?topics=abc")), "index.html");
            assert_eq!(asset_request_path(&format!("{origin}/index.html#x")), "index.html");
        }
    }

    /// The navigation guard must let the app origin through on EVERY system.
    /// Denying it is what kept the main window from loading its own document on
    /// Windows: the navigation was refused silently and it stayed
    /// `about:blank`.
    #[test]
    fn nav_guard_allows_every_app_origin() {
        for url in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
            "http://tauri.localhost/index.html?topics=abc",
        ] {
            assert!(is_app_origin(&url.parse().unwrap()), "rifiutata l'origine dell'app: {url}");
        }
    }

    /// And it must keep stopping everything else: the point of the guard is that
    /// an external navigation in the main window would leave it blank with no way
    /// back short of a restart.
    #[test]
    fn nav_guard_still_refuses_the_open_web() {
        for url in [
            "https://example.com/",
            "http://localhost:3333/",       // the dev server is NOT the app
            "https://localhost/index.html", // right host, scheme that does not exist here
            "file:///etc/passwd",
            "tauri://evil.example.com/",
        ] {
            assert!(!is_app_origin(&url.parse().unwrap()), "accettata un'origine estranea: {url}");
        }
    }
}

#[cfg(test)]
mod bundle_rev_tests {
    use super::{bundle_rev_from_html, stamp_bundle_rev};

    /// Il rev DEVE essere identico a quello di `readBundleRev`
    /// (server/lib/dev-bundle-reload.ts): stessi nomi, deduplicati, ordinati,
    /// uniti da virgola. Se le due metà divergono il client vede un mismatch
    /// eterno e mostra per sempre "Nuova versione disponibile".
    #[test]
    fn rev_matches_the_server_shape() {
        let html = r#"<!doctype html><html><head>
            <link rel="stylesheet" href="/assets/index-CbOOmmZR.css">
            <script type="module" src="/assets/index-DR6ye0r0.js"></script>
        </head><body></body></html>"#;
        assert_eq!(
            bundle_rev_from_html(html),
            "/assets/index-CbOOmmZR.css,/assets/index-DR6ye0r0.js"
        );
    }

    /// Ordine di apparizione irrilevante + duplicati collassati: il JS fa
    /// `[...new Set(names)].sort()`, qui `sort` + `dedup`. Stesso risultato.
    #[test]
    fn rev_is_sorted_and_deduped() {
        let html = r#"<head><script src="/assets/index-Zz.js"></script>
            <script src="/assets/index-Aa.css"></script>
            <script src="/assets/index-Zz.js"></script></head>"#;
        assert_eq!(bundle_rev_from_html(html), "/assets/index-Aa.css,/assets/index-Zz.js");
    }

    /// Solo `index-*`: i chunk lazy (hast-util, micromark, CodeMirror…) non
    /// entrano nel rev, altrimenti tornerebbe il loop fantasma del 2026-07-26.
    #[test]
    fn rev_ignores_non_entry_chunks() {
        let html = r#"<head><script src="/assets/index-Aa.js"></script>
            <link rel="modulepreload" href="/assets/mermaid.core-B2tWQShl.js"></head>"#;
        assert_eq!(bundle_rev_from_html(html), "/assets/index-Aa.js");
    }

    /// Nessun asset (index.html non ancora costruito / mid-rsync) ⇒ nessun rev,
    /// nessun timbro: meglio "controllo non applicabile" di un rev sbagliato.
    #[test]
    fn no_assets_means_no_stamp() {
        let html = "<html><head></head><body>ciao</body></html>";
        assert_eq!(bundle_rev_from_html(html), "");
        assert_eq!(stamp_bundle_rev(html, ""), html);
    }

    /// Il meta va SUBITO dopo `<head>`, come `stampBundleRev` lato server.
    #[test]
    fn stamp_goes_first_in_head() {
        let out = stamp_bundle_rev("<html><head><title>x</title></head>", "/assets/index-Aa.js");
        assert_eq!(
            out,
            "<html><head><meta name=\"topics-bundle-rev\" content=\"/assets/index-Aa.js\"><title>x</title></head>"
        );
    }

    /// Documento senza `<head>`: il tag va in testa, non si perde.
    #[test]
    fn stamp_without_head_prepends() {
        let out = stamp_bundle_rev("<body>x</body>", "/assets/index-Aa.js");
        assert!(out.starts_with("<meta name=\"topics-bundle-rev\""));
        assert!(out.ends_with("<body>x</body>"));
    }
}

#[cfg(test)]
mod window_recovery_tests {
    use super::{
        connect_upstream_retrying, is_document_head, is_tls_client_hello, is_websocket_head,
        window_recompose::rect_intersects_any, Loopback, Upstream, UpstreamSource, RELOAD_IF_BLANK_JS,
        UPSTREAM,
    };
    use std::time::Duration;

    /// A current-thread runtime for the two socket tests (the crate's tokio has no
    /// `macros` feature, so there is no `#[tokio::test]`).
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    const DOC: &[u8] = b"GET / HTTP/1.1\r\nHost: 127.0.0.1:13333\r\n\
Accept: text/html,application/xhtml+xml\r\nSec-Fetch-Dest: document\r\n\r\n";
    const XHR: &[u8] = b"GET /api/topics HTTP/1.1\r\nHost: 127.0.0.1:13333\r\n\
Accept: application/json\r\nSec-Fetch-Dest: empty\r\n\r\n";
    const WS: &[u8] = b"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:13333\r\n\
Upgrade: websocket\r\nConnection: Upgrade\r\nAccept: */*\r\n\r\n";

    /// A CONNECTION THAT ARRIVES BEFORE THE BOOT DECISION MUST WAIT FOR IT.
    ///
    /// The proxy used to read `UPSTREAM` ONCE, when its accept loop started, and
    /// fall back to the external server on :3333 while the value was still unset.
    /// `decide_upstream_and_spawn` runs concurrently and is SLOW - it probes
    /// :3333 first, and on a virgin machine it then has to spawn the sidecar and
    /// give it a port - so the proxy won that race essentially always, latched
    /// onto :3333, and never looked again. Measured on a clean install of
    /// 2.2.246: sidecar alive on :58406, proxy listening, NOTHING on :3333, and
    /// every request held until it timed out. What a person saw was `Offline`
    /// and then `Connecting`, for ever, on a build whose server was running two
    /// ports away.
    ///
    /// This is that sequence: ask before anybody decided, and the answer must
    /// not arrive until it does - and then it must be the decided value, not the
    /// default.
    #[test]
    fn una_connessione_prima_della_decisione_aspetta_invece_di_indovinare() {
        rt().block_on(async {
            assert!(
                UPSTREAM.get().is_none(),
                "questo test deve girare prima che qualcuno decida l'upstream",
            );
            let pending = tokio::spawn(UpstreamSource::Decided.resolve());
            tokio::time::sleep(Duration::from_millis(150)).await;
            assert!(
                !pending.is_finished(),
                "ha risposto senza che nessuno avesse deciso: e' il difetto, \
                 il proxy sceglieva una porta per conto suo",
            );
            let _ = UPSTREAM.set(Upstream { host: Loopback::V4, port: 61234, tls: false });
            let got = pending.await.unwrap().expect("la decisione e' arrivata");
            assert_eq!(got.port, 61234, "ha usato il default invece della decisione");
            assert!(!got.tls);
        });
    }

    /// And a caller that names its own target is answered without consulting the
    /// global at all - which is what lets the outage test drive a proxy on an
    /// ephemeral port while a real decision exists in the same process.
    #[test]
    fn un_bersaglio_esplicito_non_guarda_la_decisione() {
        rt().block_on(async {
            let fixed = UpstreamSource::Fixed(Upstream { host: Loopback::V4, port: 4242, tls: true });
            let got = fixed.resolve().await.expect("un bersaglio esplicito e' sempre pronto");
            assert_eq!(got.port, 4242);
            assert!(got.tls);
        });
    }

    /// Only a top-level navigation may be answered with the reconnect page: an XHR
    /// gets HTML where it wanted JSON, and a WebSocket gets a broken handshake.
    #[test]
    fn only_documents_get_the_reconnect_page() {
        assert!(is_document_head(DOC));
        assert!(!is_document_head(XHR));
        assert!(!is_document_head(WS));
        assert!(is_websocket_head(WS));
        assert!(!is_websocket_head(DOC));
    }

    /// A TLS HANDSHAKE IS NOT A REQUEST, and must never be piped upstream.
    ///
    /// The deep-link download (board card cbfd6248): a browser that upgrades
    /// `http://127.0.0.1:13333/tab/chat/<id>` to TLS by itself puts a
    /// `ClientHello` on a port that speaks clear HTTP. Forwarded, it came back
    /// as a plain-HTTP `400` the browser could not read as TLS, so it offered to
    /// SAVE the address as a file. And the recogniser must not go the other way
    /// either: every real request the proxy carries stays a request.
    #[test]
    fn una_stretta_di_mano_tls_non_e_una_richiesta() {
        assert!(is_tls_client_hello(&[0x16, 0x03, 0x01, 0x02, 0x00]));
        assert!(is_tls_client_hello(&[0x16, 0x03, 0x03, 0x00, 0x2a]));
        for head in [DOC, XHR, WS] {
            assert!(!is_tls_client_hello(head), "una richiesta HTTP non e' una stretta di mano");
        }
        // A connection that said nothing yet (speculative preconnect) is not one
        // either: hanging up on it would kill a perfectly good pipe.
        assert!(!is_tls_client_hello(b""));
        assert!(!is_tls_client_hello(&[0x16]));
    }

    /// A browser that sends no `Sec-Fetch-Dest` must still be recognised by Accept.
    #[test]
    fn accept_html_is_enough_without_sec_fetch_dest() {
        let head = b"GET / HTTP/1.1\r\nHost: x\r\nAccept: text/html\r\n\r\n";
        assert!(is_document_head(head));
    }

    /// The nudge must be a no-op on a LIVE app (a forced reload would throw away a
    /// working session) and must fire on an empty document.
    #[test]
    fn blank_guard_spares_a_mounted_app() {
        assert!(RELOAD_IF_BLANK_JS.contains("childElementCount>0)return"));
        assert!(RELOAD_IF_BLANK_JS.contains("catch(e){location.reload()}"));
    }

    /// A server restart is ~2s of ECONNREFUSED. The old code gave up on the first
    /// one; this must hold on and succeed when the port comes back.
    #[test]
    fn connect_retries_across_a_restart() {
        rt().block_on(async {
        let probe = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe); // port now closed — exactly like a server mid-restart
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(600)).await;
            let _l = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
            tokio::time::sleep(Duration::from_secs(3)).await;
        });
        let got = connect_upstream_retrying(Loopback::V4, port, Duration::from_secs(5)).await;
        assert!(got.is_some(), "must survive a port that comes back after 600ms");
        });
    }

    /// ...but it must still give up, so a document request falls through to the
    /// reconnect page instead of hanging forever on a server that is truly gone.
    #[test]
    fn connect_gives_up_after_the_grace() {
        rt().block_on(async {
        let probe = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let t0 = std::time::Instant::now();
        let got = connect_upstream_retrying(Loopback::V4, port, Duration::from_millis(500)).await;
        assert!(got.is_none());
        assert!(t0.elapsed() < Duration::from_secs(3), "must not hang past the grace");
        });
    }

    /// Re-anchor only when the window is on NO screen. Attilio keeps this window at
    /// -797,-1410 on an ultrawide: negative is not "wrong", it's his choice.
    #[test]
    fn negative_position_on_a_real_monitor_is_left_alone() {
        let ultrawide = (-1720.0, -1440.0, 3440.0, 1440.0);
        let builtin = (0.0, 0.0, 1512.0, 982.0);
        let mons = [builtin, ultrawide];
        assert!(rect_intersects_any((-797.0, -1410.0, 1200.0, 800.0), &mons));
        // Same window after the ultrawide is unplugged: stranded, must be re-anchored.
        assert!(!rect_intersects_any((-797.0, -1410.0, 1200.0, 800.0), &[builtin]));
    }

    /// Touching edges only (x + w == mx) is NOT overlap — a window flush against a
    /// monitor's left edge from outside shows zero pixels.
    #[test]
    fn touching_edges_does_not_count_as_on_screen() {
        let mon = (0.0, 0.0, 1000.0, 800.0);
        assert!(!rect_intersects_any((-500.0, 0.0, 500.0, 400.0), &[mon]));
        assert!(rect_intersects_any((-499.0, 0.0, 500.0, 400.0), &[mon]));
    }
}

#[cfg(test)]
mod contaminated_marker_cold_boot_tests {
    //! The 2026-09-12 contaminated-marker regression, verified by driving the REAL
    //! probe functions against a real local foreign HTTP server (no dependency on
    //! the live account-switcher), plus the companion invariant (a merely-DOWN
    //! server must still wait, not fork empty).

    use super::{
        decide_boot, probe_port, probe_topics_shape, BootChoice, Loopback, PortAnswer, ShapeVerdict,
    };
    use crate::boot_choice::BootFacts;
    use std::io::{Read, Write};
    use std::time::Duration;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    /// Bind one loopback family explicitly. `TcpListener::bind(("::1", p))` and
    /// `("127.0.0.1", p)` are two different sockets on one port, which is exactly
    /// the situation these tests are about.
    fn bind_loopback(host: Loopback, port: u16) -> std::net::TcpListener {
        std::net::TcpListener::bind((host.host(), port)).expect("bind loopback")
    }

    /// A FOREIGN process that answers 200 text/html for every path. The listener
    /// is bound HERE, by the caller, and only then handed to the thread: binding
    /// inside the thread meant two tests racing for the same "free" port, and a
    /// test that fails because of another test proves nothing about the code.
    fn start_foreign_squatter(
        listener: std::net::TcpListener,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            loop {
                match listener.accept() {
                    Ok((mut s, _)) => {
                        let _ = s.set_read_timeout(Some(Duration::from_millis(200)));
                        let mut buf = [0u8; 512];
                        let _ = s.read(&mut buf);
                        let _ = s.write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n\
                             <html><body>foreign dashboard</body></html>",
                        );
                    }
                    Err(_) => return,
                }
            }
        })
    }

    /// A STRANGER THAT SERVES ONE CONNECTION AT A TIME, which is what an account
    /// switcher's dashboard actually is: a Python `socketserver.TCPServer` reads
    /// each connection to the end before it accepts the next. Unlike the squatter
    /// above it does NOT give up on a silent client quickly, so a probe that opens
    /// a connection and holds it blocks every later probe of the same port. That
    /// is the shape the 2026-09-14 review used to make the shell wait 222s.
    fn start_single_connection_stranger(
        listener: std::net::TcpListener,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            loop {
                match listener.accept() {
                    Ok((mut s, _)) => {
                        // Long enough to be "blocked" for any probe that has to
                        // answer in under a second, short enough that the thread
                        // does not outlive the test run.
                        let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
                        let mut buf = [0u8; 512];
                        let _ = s.read(&mut buf);
                        let _ = s.write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n\
                             <html><body>one connection at a time</body></html>",
                        );
                    }
                    Err(_) => return,
                }
            }
        })
    }

    /// A FAKE TOPICS DAEMON: answers the presence shape on any address given.
    /// `bind` is the address literal, so the caller can put it on `::1` while a
    /// stranger holds `127.0.0.1` on the SAME port, which is the whole point.
    fn start_fake_daemon(listener: std::net::TcpListener) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            loop {
                match listener.accept() {
                    Ok((mut s, _)) => {
                        let _ = s.set_read_timeout(Some(Duration::from_millis(200)));
                        let mut buf = [0u8; 512];
                        let _ = s.read(&mut buf);
                        let _ = s.write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n\
                             {\"openSessions\":1,\"workingSessions\":0,\"activeTasks\":2}",
                        );
                    }
                    Err(_) => return,
                }
            }
        })
    }

    #[test]
    fn foreign_squatter_with_stale_marker_spawns_not_hangs() {
        rt().block_on(async {
            let listener = bind_loopback(Loopback::V4, 0);
            let port = listener.local_addr().unwrap().port();
            let _h = start_foreign_squatter(listener);
            for _ in 0..50 {
                if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let verdict = probe_topics_shape(Loopback::V4, port, false).await;
            assert_eq!(
                verdict,
                ShapeVerdict::Foreign,
                "foreign HTML is a stranger, not a Topics daemon"
            );
            // A stale state file (dead pid) is what this case has: no universe to
            // protect, so the sidecar is the right answer.
            let choice = decide_boot(BootFacts {
                state_port: Some(3333),
                seen_before: true,
                primary_foreign: true,
                ..Default::default()
            });
            assert_eq!(
                choice,
                BootChoice::SpawnSidecar,
                "contaminated marker + foreign squatter must SPAWN, not hang"
            );
        });
    }

    /// THE PROBE MUST NOT OCCUPY WHAT IT IS PROBING. Against a stranger that
    /// serves one connection at a time, holding the "is anybody listening?"
    /// connection open starved every probe that followed: no verdict, no stranger,
    /// so IPv6 was never even tried and the shell waited on the wrong address for
    /// 222s (2026-09-14). Closing it immediately, the same stranger is recognised
    /// in milliseconds and the daemon behind it on IPv6 is found.
    #[test]
    fn a_stranger_that_serves_one_connection_at_a_time_is_still_recognised() {
        rt().block_on(async {
            let squatted = bind_loopback(Loopback::V4, 0);
            let port = squatted.local_addr().unwrap().port();
            let _stranger = start_single_connection_stranger(squatted);
            let _daemon = start_fake_daemon(bind_loopback(Loopback::V6, port));
            for _ in 0..50 {
                if std::net::TcpStream::connect(("::1", port)).is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let v4 = probe_port(Loopback::V4, port).await;
            assert_eq!(
                v4.verdict,
                ShapeVerdict::Foreign,
                "the stranger must be recognised even though it serves one connection at a time"
            );
            let v6 = probe_port(Loopback::V6, port).await;
            assert_eq!(
                v6.verdict,
                ShapeVerdict::Topics,
                "and the daemon behind it on IPv6 must still be found"
            );
        });
    }

    /// The cheap path of `probe_port`: nothing listening is settled by ONE
    /// refused connection, and it is `NoAnswer`, never a stranger.
    #[test]
    fn a_port_with_no_listener_is_one_refusal_and_no_answer() {
        rt().block_on(async {
            let dead = bind_loopback(Loopback::V4, 0).local_addr().unwrap().port();
            let answer = probe_port(Loopback::V4, dead).await;
            assert_eq!(
                answer,
                PortAnswer { verdict: ShapeVerdict::NoAnswer, tls: false }
            );
        });
    }

    /// THE 2026-09-14 REPRODUCTION, with real sockets. A stranger binds
    /// `127.0.0.1:p` while the daemon binds `[::1]:p`: both succeed, because the
    /// IPv4-specific bind and the IPv6 one coexist. The IPv4 probe must report a
    /// stranger, the IPv6 probe must find Topics, and the shell must end up
    /// talking to IPv6 instead of starting an empty sidecar.
    #[test]
    fn an_ipv4_squatter_does_not_hide_the_daemon_on_ipv6() {
        rt().block_on(async {
            let squatted = bind_loopback(Loopback::V4, 0);
            let port = squatted.local_addr().unwrap().port();
            let _squatter = start_foreign_squatter(squatted);
            // THE COEXISTENCE ITSELF: the same port, bound a second time on IPv6
            // while IPv4 is held. If this bind failed the reproduction would be
            // impossible, so the test asserts it by unwrapping.
            let _daemon = start_fake_daemon(bind_loopback(Loopback::V6, port));
            for _ in 0..50 {
                if std::net::TcpStream::connect(("::1", port)).is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let v4 = probe_topics_shape(Loopback::V4, port, false).await;
            let v6 = probe_topics_shape(Loopback::V6, port, false).await;
            assert_eq!(v4, ShapeVerdict::Foreign, "IPv4 is held by the stranger");
            assert_eq!(v6, ShapeVerdict::Topics, "the daemon answers on IPv6");
            let choice = decide_boot(BootFacts {
                primary_topics: true,
                primary_host: Loopback::V6,
                state_port: Some(3333),
                seen_before: true,
                primary_foreign: true,
                state_pid_alive: true,
                ..Default::default()
            });
            assert_eq!(
                choice,
                BootChoice::Defer { host: Loopback::V6, port: 3333, tls: false },
                "the live daemon on IPv6 wins over a stranger on IPv4"
            );
        });
    }

    /// A server that is DOWN is not a stranger: nothing answers at all, so the
    /// marker still means wait.
    #[test]
    fn down_server_with_stale_marker_still_waits() {
        rt().block_on(async {
            let dead = bind_loopback(Loopback::V4, 0).local_addr().unwrap().port();
            let verdict = probe_topics_shape(Loopback::V4, dead, false).await;
            assert_eq!(
                verdict,
                ShapeVerdict::NoAnswer,
                "a down server answers nothing, and silence is not a stranger"
            );
            let choice = decide_boot(BootFacts {
                state_port: Some(3333),
                seen_before: true,
                ..Default::default()
            });
            assert_eq!(
                choice,
                BootChoice::WaitForKnownServer { host: Loopback::V4 },
                "a merely-DOWN known server must still be waited on"
            );
        });
    }

    /// A SLOW Topics is not a stranger either, and this is the 2026-08-13
    /// incident in one test: a server that accepts the connection and then takes
    /// too long must come back `NoAnswer`, never `Foreign`. `Foreign` plus a
    /// marker is what used to authorise the empty sidecar.
    #[test]
    fn a_slow_server_is_never_read_as_foreign() {
        rt().block_on(async {
            let listener = bind_loopback(Loopback::V4, 0);
            let port = listener.local_addr().unwrap().port();
            let _h = std::thread::spawn(move || {
                while let Ok((s, _)) = listener.accept() {
                    // Accept and say nothing for longer than the probe waits.
                    std::thread::sleep(Duration::from_millis(2500));
                    drop(s);
                }
            });
            for _ in 0..50 {
                if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let verdict = probe_topics_shape(Loopback::V4, port, false).await;
            assert_eq!(
                verdict,
                ShapeVerdict::NoAnswer,
                "a slow server must not be classified as a stranger"
            );
            let choice = decide_boot(BootFacts {
                state_port: Some(3333),
                seen_before: true,
                primary_foreign: verdict == ShapeVerdict::Foreign,
                ..Default::default()
            });
            assert_eq!(
                choice,
                BootChoice::WaitForKnownServer { host: Loopback::V4 },
                "a slow but live server is waited for, never replaced"
            );
        });
    }
}

/// The end-to-end PROOF for the empty-window bug, kept out of the normal run
/// (`#[ignore]`) because it drives a real browser and takes ~15s:
///
///   cargo test --lib demo_window_recovers -- --ignored --nocapture
///
/// It serves a fake app through the SHIPPED `proxy_loop`, kills the upstream
/// mid-clip, and lets Playwright record what a user would see. The reload that
/// happens while the server is down is exactly the move that used to leave a
/// transparent, titlebar-less window with nothing to paint — i.e. invisible.
#[cfg(test)]
mod window_recovery_demo {
    use super::{proxy_loop, Loopback, Upstream, UpstreamSource};

    /// Minimal HTTP server standing in for the Topics server: one fixed page whose
    /// marker (`TOPICS`) the browser checks for. Killed by aborting its task, which
    /// drops the listener — the same abrupt disappearance as a server restart.
    async fn fake_app_server(port: u16) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(e) => panic!("fake upstream bind :{port}: {e}"),
        };
        loop {
            let Ok((mut s, _)) = listener.accept().await else { continue };
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf).await;
                let body = "<!doctype html><html><body style=\"background:#0b3d2e;color:#eafff5;\
font:24px/1.4 -apple-system,system-ui,sans-serif;display:flex;align-items:center;\
justify-content:center;height:100vh;margin:0\"><div id=\"root\">TOPICS \u{2014} app viva</div></body></html>";
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
                    body.len(), body);
                let _ = s.write_all(resp.as_bytes()).await;
                let _ = s.flush().await;
            });
        }
    }

    #[test]
    #[ignore]
    fn demo_window_recovers_after_server_restart() {
        let out_dir = std::env::var("DEMO_OUT")
            .unwrap_or_else(|_| "/tmp/topics-window-recovery".to_string());
        let _ = std::fs::create_dir_all(&out_dir);
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let up_port = {
                let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
                l.local_addr().unwrap().port()
            };
            let proxy_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let proxy_port = proxy_listener.local_addr().unwrap().port();

            let server = tokio::spawn(fake_app_server(up_port));
            tokio::spawn(proxy_loop(proxy_listener, UpstreamSource::Fixed(Upstream { host: Loopback::V4, port: up_port, tls: false })));
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;

            // The camera + browser, on its own clock (see window-recovery-demo.mjs).
            let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../scripts/window-recovery-demo.mjs");
            let repo_root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
            let mut child = std::process::Command::new("node")
                .arg(script)
                .arg(proxy_port.to_string())
                .arg(&out_dir)
                .current_dir(repo_root)
                .spawn()
                .expect("spawn node (playwright-core must be installed)");

            // t=3s: the server goes down (a `launchctl kickstart -k`, a crash, an update).
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            server.abort();
            eprintln!("[demo] upstream :{up_port} DOWN");
            // t=9s: it comes back. Nothing else happens — no human, no click.
            tokio::time::sleep(std::time::Duration::from_secs(6)).await;
            tokio::spawn(fake_app_server(up_port));
            eprintln!("[demo] upstream :{up_port} BACK");

            let status = tokio::task::spawn_blocking(move || child.wait())
                .await
                .unwrap()
                .expect("node exited");
            assert!(status.success(), "the window did not come back by itself");
            eprintln!("[demo] clip in {out_dir}");
        });
    }
}

#[cfg(test)]
mod unattended_relaunch_tests {
    use super::may_relaunch_unattended;

    /// Nothing on screen: parked in the tray, or the update landed before the
    /// window was ever shown. Restarting costs the user nothing.
    #[test]
    fn a_hidden_window_may_be_restarted() {
        assert!(may_relaunch_unattended(Some(false)));
    }

    /// The measured case. hot-reload.log, 2026-08-21: the shell started at
    /// 14:14:11, the install finished at 14:14:16 and the app restarted itself
    /// with the window up. The report came three minutes later.
    /// allow-italian: "topics non lo vedo", verbatim, is the evidence.
    #[test]
    fn a_visible_window_is_never_restarted_from_under_the_user() {
        assert!(!may_relaunch_unattended(Some(true)));
    }

    /// is_visible() failed, or the window is gone from the map. The safe answer is
    /// the one that does not make an app disappear, so unknown behaves as visible.
    #[test]
    fn unknown_counts_as_visible() {
        assert!(!may_relaunch_unattended(None));
    }
}
