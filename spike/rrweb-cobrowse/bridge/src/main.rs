// Co-browse session broker (skeleton). std-only NDJSON-over-Unix-socket multiplexer
// that is reused by BOTH co-op (roles per peer) and multi-session (sessions keyed by
// id). It never parses payloads — it routes opaque lines by (session, role), so the
// same core carries rrweb DOM events now and co-op presence / pixel-island signaling
// later. See ../server.mjs for the JS reference of the same contract, and
// desktop-tauri/webrtc-bridge for the sibling sidecar this mirrors.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Role {
    Source,
    Presenter,
    Controller,
    Viewer,
}

impl Role {
    fn parse(s: &str) -> Role {
        match s {
            "source" => Role::Source,
            "presenter" => Role::Presenter,
            "controller" => Role::Controller,
            _ => Role::Viewer,
        }
    }
    /// May this role drive the source (co-op input gate)?
    fn can_control(self) -> bool {
        matches!(self, Role::Presenter | Role::Controller)
    }
}

struct Peer {
    id: u64,
    role: Role,
    writer: Arc<Mutex<UnixStream>>,
}

impl Peer {
    fn send_line(&self, line: &str) {
        if let Ok(mut w) = self.writer.lock() {
            let _ = w.write_all(line.as_bytes());
            if !line.ends_with('\n') {
                let _ = w.write_all(b"\n");
            }
            let _ = w.flush();
        }
    }
}

#[derive(Default)]
struct Session {
    peers: Vec<Peer>,
}

impl Session {
    fn viewer_count(&self) -> usize {
        self.peers.iter().filter(|p| p.role != Role::Source).count()
    }
    fn broadcast_presence(&self) {
        let msg = format!("PRESENCE {}", self.viewer_count());
        for p in &self.peers {
            if p.role != Role::Source {
                p.send_line(&msg);
            }
        }
    }
    /// Fan a source payload out to every non-source peer.
    fn fan_out(&self, payload: &str) {
        for p in &self.peers {
            if p.role != Role::Source {
                p.send_line(payload);
            }
        }
    }
    /// Relay a controller payload (input) to the session's source(s).
    fn to_source(&self, payload: &str) {
        for p in &self.peers {
            if p.role == Role::Source {
                p.send_line(payload);
            }
        }
    }
}

type Registry = Arc<Mutex<HashMap<String, Session>>>;

fn main() {
    let socket_path = parse_socket_arg().unwrap_or_else(|| {
        eprintln!("usage: cobrowse-bridge --socket <path>");
        std::process::exit(2);
    });

    // The sidecar owns the socket file: remove a stale one before binding (matches
    // webrtc-bridge/main.rs so a crashed predecessor never blocks a respawn).
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path).unwrap_or_else(|e| {
        eprintln!("[cobrowse] bind {socket_path} failed: {e}");
        std::process::exit(1);
    });
    println!("[cobrowse] ready on {socket_path}");

    let registry: Registry = Arc::new(Mutex::new(HashMap::new()));
    let ids = Arc::new(AtomicU64::new(1));

    for stream in listener.incoming() {
        match stream {
            Ok(conn) => {
                let registry = Arc::clone(&registry);
                let ids = Arc::clone(&ids);
                thread::spawn(move || handle_conn(conn, registry, ids));
            }
            Err(e) => eprintln!("[cobrowse] accept error: {e}"),
        }
    }
}

fn parse_socket_arg() -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--socket" {
            return args.next();
        }
    }
    None
}

fn handle_conn(conn: UnixStream, registry: Registry, ids: Arc<AtomicU64>) {
    let read_half = match conn.try_clone() {
        Ok(c) => c,
        Err(_) => return,
    };
    let writer = Arc::new(Mutex::new(conn));
    let mut lines = BufReader::new(read_half).lines();

    // First line = handshake: HELLO <session> <role>
    let hello = match lines.next() {
        Some(Ok(l)) => l,
        _ => return,
    };
    let mut it = hello.split_whitespace();
    if it.next() != Some("HELLO") {
        return;
    }
    let session_id = match it.next() {
        Some(s) => s.to_string(),
        None => return,
    };
    let role = Role::parse(it.next().unwrap_or("viewer"));
    let peer_id = ids.fetch_add(1, Ordering::Relaxed);

    // Register.
    {
        let mut reg = registry.lock().unwrap();
        let s = reg.entry(session_id.clone()).or_default();
        s.peers.push(Peer { id: peer_id, role, writer: Arc::clone(&writer) });
        s.broadcast_presence();
    }
    eprintln!("[cobrowse] + peer {peer_id} session={session_id} role={role:?}");

    // Route every subsequent line by role.
    for line in lines {
        let payload = match line {
            Ok(l) if !l.is_empty() => l,
            Ok(_) => continue,
            Err(_) => break,
        };
        let reg = registry.lock().unwrap();
        if let Some(s) = reg.get(&session_id) {
            match role {
                Role::Source => s.fan_out(&payload),
                r if r.can_control() => s.to_source(&payload),
                _ => { /* viewer input dropped */ }
            }
        }
    }

    // Deregister.
    {
        let mut reg = registry.lock().unwrap();
        if let Some(s) = reg.get_mut(&session_id) {
            s.peers.retain(|p| p.id != peer_id);
            s.broadcast_presence();
            if s.peers.is_empty() {
                reg.remove(&session_id);
            }
        }
    }
    eprintln!("[cobrowse] - peer {peer_id} session={session_id}");
}
