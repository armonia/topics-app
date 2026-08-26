// PTY Bridge Daemon — a Rust port of server/pty-bridge.mjs (unix implementation).
//
// The compiled Bun server CANNOT run node-pty (it needs Node, not Bun), so on a
// virgin install shell/claude-code tabs never opened. This standalone binary
// speaks the SAME line-delimited JSON protocol over a Unix socket that the server
// already talks to the Node bridge; the server spawns whichever it's handed via
// TOPICS_PTY_BRIDGE_BIN (set by desktop-tauri lib.rs). Zero Node dependency.
//
// The TRANSPORT lives in `transport.rs`: a Unix socket on macOS/Linux, a named pipe
// on Windows. The protocol and the rest of the daemon are the same everywhere, so
// this file is NO LONGER unix-only: until 2026-08-26 it was, and on Windows terminals
// - the very reason Topics exists - answered 503 "terminals not available in
// standalone mode". Entry point: run().
//
// Protocol (JSON, one object per line):
//   IN : create | write | resize | kill | list | buffer | ping
//   OUT: data | exit | created | killed | list | buffer | pong | error
//
// The hardened semantics of the Node bridge are preserved: realHome() anchoring,
// a 100 KB ring buffer per session, env merge (HOME→...env→TERM, UTF-8 locale fill,
// PATH augmentation), single-instance via pidfile + spawn-probe + degraded-owner
// takeover, a pre-listen self-test, and orphan-grace survival across server restarts.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};

use crate::transport::{self, Listener, Stream};

const MAX_BUFFER_SIZE: usize = 100 * 1024; // 100 KB ring buffer per session
const DEFAULT_ORPHAN_GRACE: Duration = Duration::from_secs(90);
// Backstop for the bridges no parent check can retire: recycled pid, worktree
// reaped from under us, a spawner that never comes back. Their signature is
// always "no clients, no sessions, indefinitely". Much longer than ORPHAN_GRACE
// because it fires on a LIVE parent too, and must never race a server that is
// merely idle between turns.
const DEFAULT_IDLE_EXIT: Duration = Duration::from_secs(30 * 60);
// How long a connection must persist before it counts as "the server came back"
// rather than a single-instance probe. See spawn_orphan_monitor().
const DEFAULT_REAL_CLIENT: Duration = Duration::from_secs(5);
// How long a killed child gets to honour SIGHUP before the process GROUP is
// SIGKILLed. `kill` used to be one SIGHUP and nothing else: a child that traps
// or ignores HUP (a shell script, a CLI with its own handler) simply stayed,
// and since the entry was removed from the map on the spot it was invisible to
// `list`, to reconcile and to shutdown. Two seconds is well past what a healthy
// TUI needs to save and exit, and far under the 5 s ack window the server gives
// a create.
const DEFAULT_KILL_GRACE: Duration = Duration::from_secs(2);

// A trivially-exiting program used by the self-test and single-instance spawn-probe.
// `/bin/sh -c :` is the most portable choice on unix — /bin/sh is guaranteed on
// every unix, whereas /bin/true was dropped on macOS 26 (only /usr/bin/true remains).
#[cfg(unix)]
const TRUE_PROG: &str = "/bin/sh";
#[cfg(unix)]
const TRUE_ARGS: &[&str] = &["-c", ":"];
#[cfg(windows)]
const TRUE_PROG: &str = "cmd.exe";
#[cfg(windows)]
const TRUE_ARGS: &[&str] = &["/c", "exit"];

// ── Mutex helper — recover a poisoned lock instead of cascading a panic. A single
// panicked message handler must never wedge the whole daemon (it holds live PTYs).
trait LockExt<T> {
    fn lock_ok(&self) -> MutexGuard<'_, T>;
}
impl<T> LockExt<T> for Mutex<T> {
    fn lock_ok(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// The user's REAL home, from the OS account db (getpwuid) not $HOME — the bridge can
// be (re)spawned by a server whose $HOME was clobbered by a sandbox ancestor to a
// throwaway dir. Without anchoring, every spawned `claude`/`codex` re-onboards.
fn real_home() -> String {
    use std::sync::OnceLock;
    static HOME: OnceLock<String> = OnceLock::new();
    HOME.get_or_init(|| {
        #[cfg(unix)]
        unsafe {
            let uid = libc::getuid();
            let pw = libc::getpwuid(uid);
            if !pw.is_null() && !(*pw).pw_dir.is_null() {
                if let Ok(s) = std::ffi::CStr::from_ptr((*pw).pw_dir).to_str() {
                    if !s.is_empty() {
                        return s.to_string();
                    }
                }
            }
        }
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default()
    })
    .clone()
}

struct Shared {
    clients: Mutex<HashMap<u64, Stream>>, // write-capable clones, keyed by client id
    connected_at: Mutex<HashMap<u64, Instant>>, // when each client attached: a probe is not a server
    sessions: Mutex<HashMap<String, Session>>,
    /// Monotonic stamp handed to each new session, so a reader thread can tell
    /// its own entry from a later one that reused the id. See Session.generation.
    next_generation: Mutex<u64>,
    socket_path: PathBuf,
    pid_path: PathBuf,
}

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    buffer: Arc<Mutex<VecDeque<u8>>>,
    pid: Option<u32>,
    /// Which incarnation of this id this entry is. The reader thread outlives
    /// its own session by however long the child takes to reap, and it used to
    /// `remove(&id)` unconditionally: a late exit could therefore evict a
    /// NEWER entry that had taken the same id, leaving a live PTY in no map at
    /// all. Every remove is now guarded on this stamp.
    generation: u64,
    /// A `kill` has been signalled and we are waiting for the reader loop to
    /// confirm the death. The entry deliberately STAYS in the map until then:
    /// removing it on the spot is what made a HUP-ignoring survivor invisible
    /// to `list`, to reconcile and to `shutdown`.
    killing: bool,
}

// ── Wire I/O ────────────────────────────────────────────────────────────────
fn write_line(stream: &Stream, line: &str) {
    let mut w: &Stream = stream;
    let _ = w.write_all(line.as_bytes());
}

fn broadcast(shared: &Shared, v: &Value) {
    let line = format!("{v}\n");
    let clients = shared.clients.lock_ok();
    for st in clients.values() {
        write_line(st, &line);
    }
}

fn send_to(shared: &Shared, cid: u64, v: &Value) {
    let line = format!("{v}\n");
    let clients = shared.clients.lock_ok();
    if let Some(st) = clients.get(&cid) {
        write_line(st, &line);
    }
}

// ── Env merge (faithful to pty-bridge.mjs) ──────────────────────────────────
// Returns the full child environment. `over` is the caller's env: Some(v) sets,
// None unsets. HOME is anchored to real_home() BEFORE the caller's overrides so a
// polluted process HOME is corrected, but an explicit env.HOME (test sandboxes) wins.
fn build_env(over: &[(String, Option<String>)]) -> Vec<(String, String)> {
    let mut m: HashMap<String, String> = std::env::vars().collect();
    m.insert("HOME".into(), real_home());
    for (k, v) in over {
        match v {
            Some(val) => {
                m.insert(k.clone(), val.clone());
            }
            None => {
                m.remove(k);
            }
        }
    }
    m.insert("TERM".into(), "xterm-256color".into());
    m.insert("COLORTERM".into(), "truecolor".into());

    // Ensure a UTF-8 locale so accented output doesn't mojibake (à → √†). Under
    // launchd LANG is unset. Only fill in if the caller didn't pass a UTF-8 locale.
    let has_utf8 = ["LC_ALL", "LC_CTYPE", "LANG"].iter().any(|k| {
        m.get(*k).is_some_and(|v| {
            let l = v.to_lowercase();
            l.contains("utf8") || l.contains("utf-8")
        })
    });
    if !has_utf8 {
        m.insert("LANG".into(), "en_US.UTF-8".into());
        m.insert("LC_CTYPE".into(), "en_US.UTF-8".into());
    }

    // PATH augmentation (unix): a launchd/sidecar minimal PATH still finds user tools.
    #[cfg(unix)]
    {
        let home = m.get("HOME").cloned().unwrap_or_else(real_home);
        let extra = [
            format!("{home}/.local/bin"),
            format!("{home}/.bun/bin"),
            "/opt/homebrew/bin".into(),
            "/opt/homebrew/sbin".into(),
            "/usr/local/bin".into(),
            "/usr/bin".into(),
            "/bin".into(),
            "/usr/sbin".into(),
            "/sbin".into(),
        ];
        let current = m.get("PATH").cloned().unwrap_or_default();
        let mut parts: Vec<String> = extra.to_vec();
        if !current.is_empty() {
            parts.push(current);
        }
        m.insert("PATH".into(), parts.join(":"));
    }

    // Same idea on Windows, with the places per-user agent CLI installs (`claude`,
    // `codex`, `bun`) actually land: the PATH the shell inherits may lack them, and a
    // `claude` that cannot be found becomes a tab that opens and dies at once without
    // saying why.
    //
    // Two things that are NOT the same as on unix, and each one broke a terminal:
    //
    //  • The separator is `;`. On Windows `:` is the drive letter's punctuation, so
    //    splitting a PATH on it cuts EVERY entry in half. Measured on Windows 11 on
    //    2026-08-26 (from the server's own augmentPath, same bug): the child ended up
    //    with `C:\WINDOWS\system32` glued inside a longer nonexistent entry, and
    //    `ping` answered "not recognized" in a Topics terminal.
    //
    //  • Environment variables are CASE-INSENSITIVE. The inherited value is usually
    //    spelled `Path`, and inserting `PATH` beside it leaves two conflicting
    //    entries with the child reading whichever it likes — so the SAME key the
    //    parent used is reused, and any other spelling is dropped first.
    #[cfg(windows)]
    {
        let home = m.get("HOME").cloned().unwrap_or_else(real_home);
        // Keep the key the parent actually used (`Path`, `PATH`, …) and collapse any
        // duplicate spelling into it.
        let mut key = "PATH".to_string();
        let mut current = String::new();
        let spellings: Vec<String> = m
            .keys()
            .filter(|k| k.eq_ignore_ascii_case("PATH"))
            .cloned()
            .collect();
        for (i, k) in spellings.iter().enumerate() {
            if let Some(v) = m.remove(k) {
                if i == 0 {
                    key = k.clone();
                    current = v;
                }
            }
        }
        let extra = [
            format!("{home}\\.local\\bin"),
            format!("{home}\\.bun\\bin"),
            format!("{home}\\.cargo\\bin"),
            format!("{home}\\AppData\\Roaming\\npm"),
            format!("{home}\\AppData\\Local\\Microsoft\\WinGet\\Links"),
        ];
        // De-duplicated, case-insensitively: Windows paths are, and a PATH that
        // repeats an entry in two spellings only makes it longer.
        let mut seen: Vec<String> = Vec::new();
        let mut parts: Vec<String> = Vec::new();
        for p in extra.iter().cloned().chain(current.split(';').map(str::to_string)) {
            let t = p.trim().to_string();
            if t.is_empty() {
                continue;
            }
            let low = t.to_lowercase();
            if seen.contains(&low) {
                continue;
            }
            seen.push(low);
            parts.push(t);
        }
        m.insert(key, parts.join(";"));
    }

    m.into_iter().collect()
}

// Incremental UTF-8 decode: emit the longest valid prefix, carry an incomplete
// trailing multi-byte sequence to the next chunk (node-pty's StringDecoder does the
// same — without this a char split across two reads becomes replacement chars).
fn decode_incremental(carry: &mut Vec<u8>, input: &[u8]) -> String {
    carry.extend_from_slice(input);
    let mut out = String::new();
    loop {
        match std::str::from_utf8(carry) {
            Ok(s) => {
                out.push_str(s);
                carry.clear();
                break;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                if valid > 0 {
                    out.push_str(std::str::from_utf8(&carry[..valid]).unwrap());
                }
                match e.error_len() {
                    // Incomplete sequence at the end — keep the tail for next time.
                    None => {
                        carry.drain(..valid);
                        break;
                    }
                    // Genuinely invalid bytes — emit one replacement char, skip them.
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        carry.drain(..valid + bad);
                    }
                }
            }
        }
    }
    out
}

// ── Message handling ────────────────────────────────────────────────────────
fn handle_message(shared: &Arc<Shared>, cid: u64, msg: &Value) -> Result<(), String> {
    match msg["type"].as_str().unwrap_or("") {
        "create" => handle_create(shared, msg),
        "write" => {
            if let Some(id) = msg["id"].as_str() {
                let data = msg["data"].as_str().unwrap_or("");
                let mut sessions = shared.sessions.lock_ok();
                if let Some(s) = sessions.get_mut(id) {
                    let _ = s.writer.write_all(data.as_bytes());
                    let _ = s.writer.flush();
                }
            }
            Ok(())
        }
        "resize" => {
            if let Some(id) = msg["id"].as_str() {
                let cols = msg["cols"].as_u64().unwrap_or(0) as u16;
                let rows = msg["rows"].as_u64().unwrap_or(0) as u16;
                let sessions = shared.sessions.lock_ok();
                if let Some(s) = sessions.get(id) {
                    let _ = s.master.resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
            }
            Ok(())
        }
        "kill" => {
            if let Some(id) = msg["id"].as_str() {
                // THE ENTRY STAYS. It used to be removed here, before anything
                // confirmed the child was dead, and the signal was a single
                // SIGHUP: a child that traps or ignores HUP survived a `kill`
                // and was then in no map at all, so `list`, reconcile and
                // `shutdown` could not see it and nothing ever reaped it. Now
                // the reader loop's remove plus its `exit` broadcast are the
                // ONE place a session disappears, and an escalation thread
                // guarantees the child gets there.
                let mut escalate: Option<(Box<dyn ChildKiller + Send + Sync>, Option<u32>, u64)> = None;
                {
                    let mut sessions = shared.sessions.lock_ok();
                    if let Some(s) = sessions.get_mut(id) {
                        let first = !s.killing;
                        s.killing = true;
                        let _ = s.killer.kill();
                        if first {
                            escalate = Some((s.killer.clone_killer(), s.pid, s.generation));
                        }
                    }
                }
                if let Some((killer, pid, generation)) = escalate {
                    spawn_kill_escalation(shared.clone(), id.to_string(), generation, pid, killer);
                }
                // `killed` still goes out immediately: it acks the request, not
                // the death. The death is the `exit` frame.
                broadcast(shared, &json!({ "type": "killed", "id": id }));
            }
            Ok(())
        }
        "list" => {
            let list: Vec<Value> = {
                let sessions = shared.sessions.lock_ok();
                sessions
                    .iter()
                    .map(|(id, s)| json!({ "id": id, "pid": s.pid }))
                    .collect()
            };
            send_to(shared, cid, &json!({ "type": "list", "sessions": list }));
            Ok(())
        }
        "buffer" => {
            if let Some(id) = msg["id"].as_str() {
                let buf_arc = shared.sessions.lock_ok().get(id).map(|s| s.buffer.clone());
                let data = match buf_arc {
                    Some(b) => {
                        let rb = b.lock_ok();
                        if rb.is_empty() {
                            String::new()
                        } else {
                            let bytes: Vec<u8> = rb.iter().copied().collect();
                            base64::engine::general_purpose::STANDARD.encode(bytes)
                        }
                    }
                    None => String::new(),
                };
                send_to(shared, cid, &json!({ "type": "buffer", "id": id, "data": data }));
            }
            Ok(())
        }
        "ping" => {
            send_to(shared, cid, &json!({ "type": "pong" }));
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Is the entry under `id` still the one stamped `generation`?
fn generation_present(shared: &Shared, id: &str, generation: u64) -> bool {
    shared
        .sessions
        .lock_ok()
        .get(id)
        .is_some_and(|s| s.generation == generation)
}

/// SIGKILL a process GROUP, falling back to the single pid.
///
/// The group, not the pid, is what has to go: portable_pty puts the child in
/// its own session (setsid + TIOCSCTTY), so `sh -c 'trap "" HUP; sleep 300'`
/// leaves `sleep` in the same group holding the slave tty. Killing only `sh`
/// leaves that fd open, the master read never sees EOF, and the reader loop
/// (the only place that broadcasts `exit`) never runs.
#[cfg(unix)]
fn kill_group(pid: u32) {
    let pid = pid as i32;
    unsafe {
        if libc::kill(-pid, libc::SIGKILL) != 0 {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}
/// The Windows equivalent: `taskkill /T` ends the process and its WHOLE tree. Same
/// idea (the leader is not enough, whoever holds the tty open has to go too), built
/// on the only mechanism Windows offers without pulling in the job-object APIs.
///
/// A no-op here was not neutral: `kill_group` is the escalation that ends a process
/// which ignored the polite request. Without it a stubborn command would stay alive
/// and invisible, its session stuck in `killing` forever - and that terminal tab
/// would never open again.
#[cfg(not(unix))]
fn kill_group(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// SIGHUP was sent; give the child a grace window, then take the group out —
/// and if even that does not produce an EOF, force the entry out of the map.
///
/// The reader loop is the ONLY place a session leaves the map on the happy
/// path, and that is deliberate. But SIGKILL to the group does not guarantee
/// EOF on the master: anything outside that group still holding the slave fd (a
/// grandchild that called `setsid`) keeps it open, the reader never returns,
/// and the entry would live forever — every later `create` for that id
/// answering `exists`, which the server deliberately does NOT count toward its
/// spawn breaker. The tab became permanently un-recreatable. Two bounded steps,
/// then the entry goes, exactly as the pre-escalation code always did.
fn spawn_kill_escalation(
    shared: Arc<Shared>,
    id: String,
    generation: u64,
    pid: Option<u32>,
    mut killer: Box<dyn ChildKiller + Send + Sync>,
) {
    let grace = window_from_env("TOPICS_PTY_BRIDGE_KILL_GRACE_MS", DEFAULT_KILL_GRACE);
    thread::spawn(move || {
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            if !generation_present(&shared, &id, generation) {
                return; // it honoured the signal; the reader loop already reaped it
            }
            thread::sleep(Duration::from_millis(25));
        }
        if !generation_present(&shared, &id, generation) {
            return;
        }
        eprintln!("[PTY Bridge] {id} ignored SIGHUP for {grace:?}, escalating to SIGKILL");
        match pid {
            Some(p) => kill_group(p),
            // No pid (should not happen on unix): the killer handle is all we
            // have, and a second kill is better than leaving it forever.
            None => {
                let _ = killer.kill();
            }
        }
        // Second and last window. If the reader still has not reaped it, the
        // master is being held by something the group kill could not reach.
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            if !generation_present(&shared, &id, generation) {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        {
            let mut sessions = shared.sessions.lock_ok();
            if !sessions.get(&id).is_some_and(|s| s.generation == generation) {
                return;
            }
            sessions.remove(&id);
        }
        eprintln!("[PTY Bridge] {id} never reached EOF after SIGKILL — forcing it out of the map");
        // The `exit` frame is what the server listens to: without it the id
        // stays busy on its side too.
        broadcast(&shared, &json!({ "type": "exit", "id": id, "exitCode": -1 }));
    });
}

fn handle_create(shared: &Arc<Shared>, msg: &Value) -> Result<(), String> {
    let id = msg["id"].as_str().ok_or("create: missing id")?.to_string();
    // ONE PTY PER ID, always. Two concurrent creates for the same id (the
    // double /revive) used to build two children over one map slot; the first
    // to exit then broadcast an `exit` that tore down the survivor, which after
    // that lived in neither the bridge's map nor the server's. Refusing the
    // second is what makes `create` idempotent. `code: "exists"` matters: the
    // server counts consecutive `error` frames as spawn failures and recycles
    // the whole bridge at three, and this is not a spawn failure.
    // The check needs no extra lock to be atomic against the case that matters:
    // one client is one reader thread, and `handle_create` runs to completion
    // (spawn included) before that thread reads the next line, so two creates
    // from the same server socket can never interleave here.
    if shared.sessions.lock_ok().contains_key(&id) {
        broadcast(
            shared,
            &json!({ "type": "error", "id": id, "code": "exists", "error": format!("session {id} already exists") }),
        );
        return Ok(());
    }
    let shell = msg["shell"].as_str().ok_or("create: missing shell")?.to_string();
    let args: Vec<String> = msg["args"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let cols = msg["cols"].as_u64().filter(|&n| n > 0).unwrap_or(120) as u16;
    let rows = msg["rows"].as_u64().filter(|&n| n > 0).unwrap_or(30) as u16;

    let mut over: Vec<(String, Option<String>)> = Vec::new();
    if let Some(obj) = msg["env"].as_object() {
        for (k, v) in obj {
            if v.is_null() {
                over.push((k.clone(), None));
            } else if let Some(s) = v.as_str() {
                over.push((k.clone(), Some(s.to_string())));
            }
        }
    }
    let merged = build_env(&over);
    let home = merged
        .iter()
        .find(|(k, _)| k == "HOME")
        .map(|(_, v)| v.clone())
        .unwrap_or_else(real_home);
    let cwd = msg["cwd"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or(home);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new(&shell);
    for a in &args {
        cmd.arg(a);
    }
    // Start from a clean slate then set the fully-merged env, so behaviour doesn't
    // depend on CommandBuilder's inherited base env.
    cmd.env_clear();
    for (k, v) in &merged {
        cmd.env(k, v);
    }
    cmd.cwd(&cwd);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn: {e}"))?;
    // Drop the slave so the master read yields EOF once the child (and all tty
    // holders) exit.
    drop(pair.slave);

    let pid = child.process_id();
    let killer = child.clone_killer();
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;

    let buffer = Arc::new(Mutex::new(VecDeque::<u8>::new()));
    let generation = {
        let mut g = shared.next_generation.lock_ok();
        *g += 1;
        *g
    };
    shared.sessions.lock_ok().insert(
        id.clone(),
        Session {
            writer,
            master: pair.master,
            killer,
            buffer: buffer.clone(),
            pid,
            generation,
            killing: false,
        },
    );

    // Reader thread: pumps PTY output → ring buffer + broadcast, then reaps.
    {
        let shared = shared.clone();
        let id = id.clone();
        thread::spawn(move || reader_loop(shared, id, generation, reader, buffer, child));
    }

    broadcast(shared, &json!({ "type": "created", "id": id, "pid": pid }));
    Ok(())
}

fn reader_loop(
    shared: Arc<Shared>,
    id: String,
    generation: u64,
    mut reader: Box<dyn Read + Send>,
    buffer: Arc<Mutex<VecDeque<u8>>>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
) {
    let mut carry: Vec<u8> = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF
            Ok(n) => {
                let bytes = &buf[..n];
                {
                    let mut rb = buffer.lock_ok();
                    rb.extend(bytes.iter().copied());
                    while rb.len() > MAX_BUFFER_SIZE {
                        rb.pop_front();
                    }
                }
                let text = decode_incremental(&mut carry, bytes);
                if !text.is_empty() {
                    broadcast(&shared, &json!({ "type": "data", "id": id, "data": text }));
                }
            }
            Err(_) => break,
        }
    }

    // Reap for the exit code. The `kill` path uses a separate ChildKiller handle, so
    // this blocking wait can never deadlock against it.
    let code: i64 = child.wait().map(|s| s.exit_code() as i64).unwrap_or(0);
    // THE ONLY PLACE A SESSION LEAVES THE MAP, and it removes only its OWN
    // incarnation: an unconditional `remove(&id)` here would let a late exit
    // evict a newer session that had taken the same id.
    {
        let mut sessions = shared.sessions.lock_ok();
        if sessions.get(&id).is_some_and(|s| s.generation == generation) {
            sessions.remove(&id);
        }
    }
    broadcast(&shared, &json!({ "type": "exit", "id": id, "exitCode": code }));
}

// ── Single-instance: pidfile + spawn-probe + degraded-owner takeover ─────────
fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    #[cfg(unix)]
    unsafe {
        if libc::kill(pid, 0) == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    // On Windows this always returned `false`, and that was not a harmless
    // simplification: it is the question the orphan monitor rests on ("is my parent
    // still alive?"). Always answering "dead" would have the daemon believe itself
    // abandoned from the first instant; always answering "alive" would keep it from
    // ever exiting. The real answer is required.
    //
    // A process is opened with SYNCHRONIZE (the weakest right that still allows
    // querying its state) and the object is checked for being signalled: a signalled
    // process is a TERMINATED one. A handle that does not open at all means the pid
    // is gone.
    #[cfg(windows)]
    {
        const SYNCHRONIZE: u32 = 0x0010_0000;
        const WAIT_TIMEOUT: u32 = 258;
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
            fn WaitForSingleObject(h: *mut std::ffi::c_void, ms: u32) -> u32;
            fn CloseHandle(h: *mut std::ffi::c_void) -> i32;
        }
        unsafe {
            let h = OpenProcess(SYNCHRONIZE, 0, pid as u32);
            if h.is_null() {
                return false;
            }
            let state = WaitForSingleObject(h, 0);
            CloseHandle(h);
            state == WAIT_TIMEOUT
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}

enum Probe {
    Ok,
    Dead,
}

// Health-test an existing bridge by asking it to spawn TRUE_PROG. A bridge whose PTY
// layer has died responds {type:"error"} — exactly the case we MUST treat as "take
// over". A bare ping would still pong from such a degraded bridge.
fn probe_bridge(socket: &Path, timeout: Duration) -> Probe {
    // "Is there anything at this name?" is not the same question everywhere: on unix
    // it is a file to look for on disk, while on Windows `Path::exists` on
    // `\\.\pipe\...` always says no and would have declared every healthy bridge dead.
    if !transport::endpoint_exists(socket) {
        return Probe::Dead;
    }
    let mut conn = match Stream::connect(socket) {
        Ok(c) => c,
        Err(_) => return Probe::Dead,
    };
    let _ = conn.set_read_timeout(Some(timeout));
    let probe_id = format!(
        "__probe-{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        std::process::id()
    );
    // The probe's working directory: `/tmp` does not exist on Windows, and a
    // nonexistent cwd makes the spawn fail - i.e. it reads "degraded" on a perfectly
    // healthy bridge, which would then be killed and replaced, on every start.
    let probe_cwd = std::env::temp_dir();
    let create = json!({
        "type": "create", "id": probe_id, "shell": TRUE_PROG,
        "args": TRUE_ARGS, "cwd": probe_cwd.to_string_lossy(), "cols": 80, "rows": 24
    });
    if conn.write_all(format!("{create}\n").as_bytes()).is_err() {
        return Probe::Dead;
    }
    let read_conn = match conn.try_clone() {
        Ok(c) => c,
        Err(_) => return Probe::Dead,
    };
    let reader = BufReader::new(read_conn);
    let start = Instant::now();
    for line in reader.lines() {
        if start.elapsed() > timeout {
            return Probe::Dead;
        }
        let line = match line {
            Ok(l) => l,
            Err(_) => return Probe::Dead,
        };
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            if v["id"].as_str() != Some(&probe_id) {
                continue;
            }
            match v["type"].as_str() {
                Some("created") => {
                    let _ = conn.write_all(
                        format!("{}\n", json!({ "type": "kill", "id": probe_id })).as_bytes(),
                    );
                    return Probe::Ok;
                }
                Some("error") => return Probe::Dead,
                _ => {}
            }
        }
    }
    Probe::Dead
}

// Returns true if a HEALTHY bridge already owns the socket (we should yield/exit).
fn check_existing_bridge(socket: &Path, pid_path: &Path) -> bool {
    let recorded_pid: Option<i32> = std::fs::read_to_string(pid_path)
        .ok()
        .and_then(|s| s.trim().parse().ok());

    if let Probe::Ok = probe_bridge(socket, Duration::from_millis(1500)) {
        return true;
    }

    // Unreachable or degraded — clean up so we can rebind.
    if let Some(pid) = recorded_pid {
        if pid != std::process::id() as i32 && pid_alive(pid) {
            eprintln!("[PTY Bridge] Recorded owner {pid} is degraded — terminating.");
            terminate_degraded_owner(pid);
            thread::sleep(Duration::from_secs(1));
            if pid_alive(pid) {
                kill_group(pid as u32);
            }
        }
    }
    // On unix the socket is a file left on disk; on Windows the pipe leaves nothing
    // behind and there is nothing to remove (see transport::cleanup).
    transport::cleanup(socket);
    let _ = std::fs::remove_file(pid_path);
    false
}

/// The POLITE request to a degraded owner to step aside, before the hard way
/// (`kill_group`). On unix that is SIGTERM; on Windows there is no equivalent signal
/// for a process in another session, so it goes straight to the tree - the owner has
/// already been declared degraded by the probe, so there is no work in flight to
/// respect.
#[cfg(unix)]
fn terminate_degraded_owner(pid: i32) {
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
}
#[cfg(not(unix))]
fn terminate_degraded_owner(pid: i32) {
    kill_group(pid as u32);
}

// Verify we can actually spawn a PTY before advertising the socket. If the platform
// PTY layer is broken, exit so the parent server respawns us with fresh state.
fn self_test() {
    let result = (|| -> Result<(), String> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty: {e}"))?;
        let mut cmd = CommandBuilder::new(TRUE_PROG);
        for a in TRUE_ARGS {
            cmd.arg(a);
        }
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn: {e}"))?;
        drop(pair.slave);
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => {}
                Err(e) => return Err(format!("try_wait: {e}")),
            }
            if start.elapsed() > Duration::from_secs(2) {
                let _ = child.clone_killer().kill();
                return Err("timeout".into());
            }
            thread::sleep(Duration::from_millis(20));
        }
    })();
    if let Err(e) = result {
        eprintln!("[PTY Bridge] Self-test failed ({e}). Exiting.");
        std::process::exit(2);
    }
}

fn shutdown(shared: &Shared) -> ! {
    // Same escalation as `kill`, inline: SIGHUP, a grace, then the process
    // GROUP. Exiting straight after one SIGHUP is how a HUP-ignoring child
    // outlived the daemon that owned it, holding a PTY nobody could reach
    // again. We cannot wait for the reader threads here (we are on the signal
    // path and the process is about to go), so this polls the pids directly.
    let pids: Vec<u32> = {
        let mut sessions = shared.sessions.lock_ok();
        let pids = sessions.values().filter_map(|s| s.pid).collect::<Vec<_>>();
        for s in sessions.values_mut() {
            let _ = s.killer.kill();
        }
        sessions.clear();
        pids
    };
    if !pids.is_empty() {
        let grace = window_from_env("TOPICS_PTY_BRIDGE_KILL_GRACE_MS", DEFAULT_KILL_GRACE);
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline && pids.iter().any(|p| pid_alive(*p as i32)) {
            thread::sleep(Duration::from_millis(25));
        }
        for p in pids.iter().filter(|p| pid_alive(**p as i32)) {
            eprintln!("[PTY Bridge] shutdown: {p} ignored SIGHUP, escalating to SIGKILL");
            kill_group(*p);
        }
    }
    transport::cleanup(&shared.socket_path);
    let _ = std::fs::remove_file(&shared.pid_path);
    std::process::exit(0);
}

#[cfg(unix)]
fn install_signal_handler(shared: Arc<Shared>) {
    use signal_hook::consts::{SIGINT, SIGTERM};
    match signal_hook::iterator::Signals::new([SIGTERM, SIGINT]) {
        Ok(mut signals) => {
            thread::spawn(move || {
                if let Some(sig) = signals.forever().next() {
                    eprintln!("[PTY Bridge] Received signal {sig}, shutting down.");
                    shutdown(&shared);
                }
            });
        }
        Err(e) => eprintln!("[PTY Bridge] Could not install signal handler: {e}"),
    }
}
#[cfg(not(unix))]
fn install_signal_handler(_shared: Arc<Shared>) {}

// Survive server restarts. When our parent (the server) dies we get reparented to
// launchd (PPID=1) — which ALSO happens on a normal reload, after which a fresh
// server reconnects within seconds. So once orphaned we only exit if NO server is
// connected for a grace window (i.e. the app really quit). A connected client == a
// server actively using us, so we stay alive and it reattaches to surviving PTYs.
//
// Orphanhood is decided on `--parent-pid` when the spawner passed one: it needs no
// lucky timing and no cooperation from the runtime. The ppid heuristic below is the
// fallback for a hand-started daemon, and `initial_ppid` is sampled by run() BEFORE
// check_existing_bridge()/self_test() — a spawner that died during those seconds used
// to make it read 1, which left the guard `initial_ppid != 1` false forever and the
// monitor unable to ever arm. That is how the Node bridge accumulated 20 immortal
// daemons (2026-08-14); the port carried the same hole.
fn spawn_orphan_monitor(shared: Arc<Shared>, initial_ppid: i32, parent_pid: Option<i32>) {
    thread::spawn(move || {
        let grace = window_from_env("TOPICS_PTY_BRIDGE_ORPHAN_GRACE_MS", DEFAULT_ORPHAN_GRACE);
        let tick = (grace / 2).clamp(Duration::from_millis(200), Duration::from_secs(5));
        // A PROBE IS NOT A SERVER. check_existing_bridge() of every bridge that tries
        // to be born connects here, waits for a pong and closes: about a second. The
        // monitor used to clear the deadline on ANY connection, so anything that kept
        // trying to spawn kept an orphan immortal. Measured 2026-08-14 on the ai-bridge
        // twin, which alternated "Parent died … exit in 90s" and "Server reconnected"
        // forever with a dead parent and zero peers on the socket. Only a client
        // attached for at least REAL_CLIENT is a reattached server — and it is measured
        // per connection: two different probes on two consecutive ticks are not one
        // server that stayed.
        let real_client = window_from_env("TOPICS_PTY_BRIDGE_REAL_CLIENT_MS", DEFAULT_REAL_CLIENT);
        let mut deadline: Option<Instant> = None;
        let mut extended = false;
        loop {
            thread::sleep(tick);
            let orphaned = match parent_pid {
                Some(pid) => !pid_alive(pid),
                // The fallback for a hand-started daemon: on unix an orphan is
                // recognised by reparenting to init (PPID 1). Windows neither
                // reparents nor offers a cheap PPID query, so there it does NOT
                // guess: without `--parent-pid` the monitor stays disarmed and
                // retiring the daemon falls to the `idle_monitor` (no clients and no
                // sessions). The server always passes `--parent-pid`, so in
                // production this branch is never taken.
                None => orphaned_by_reparenting(initial_ppid),
            };
            if !orphaned {
                deadline = None;
                extended = false;
                continue;
            }
            let now = Instant::now();
            // A reattached server stays connected: someone here for REAL_CLIENT means
            // we are not abandoned, and only that clears the deadline.
            let settled = shared
                .connected_at
                .lock_ok()
                .values()
                .any(|since| now.duration_since(*since) >= real_client);
            if settled {
                if deadline.take().is_some() {
                    eprintln!("[PTY Bridge] Server reconnected after parent death — staying alive, PTYs preserved.");
                    extended = false;
                }
                continue;
            }
            let expired = match deadline {
                None => {
                    deadline = Some(now + grace);
                    let was = parent_pid.unwrap_or(initial_ppid);
                    eprintln!(
                        "[PTY Bridge] Parent died (was {was}) and no server connected — will exit in {}s unless one reconnects.",
                        grace.as_secs()
                    );
                    continue;
                }
                Some(d) => now >= d,
            };
            if !expired {
                continue;
            }
            if !shared.clients.lock_ok().is_empty() && !extended {
                // Expired with someone freshly attached: it may be a server in the
                // middle of reattaching, so grant ONE extension — long enough for it
                // to become `settled`. After that we leave anyway, otherwise
                // overlapping probes would buy an orphan immortality.
                extended = true;
                deadline = Some(now + real_client * 2);
                continue;
            }
            eprintln!("[PTY Bridge] No server reconnected within grace window — app likely quit, shutting down.");
            shutdown(&shared);
        }
    });
}

/// The fallback heuristic when nobody told us who launched us: on unix an orphaned
/// process is reparented to init (PPID 1). Windows has no equivalent, and a fallback
/// that guesses is worse than one that abstains.
#[cfg(unix)]
fn orphaned_by_reparenting(initial_ppid: i32) -> bool {
    (unsafe { libc::getppid() }) == 1 && initial_ppid != 1
}
#[cfg(not(unix))]
fn orphaned_by_reparenting(_initial_ppid: i32) -> bool {
    false
}

// The rope under the parent check: no clients AND no sessions for IDLE_EXIT means
// nobody is coming back for us. A single live PTY holds us up regardless — that is
// the whole reason this daemon is detached.
fn spawn_idle_monitor(shared: Arc<Shared>) {
    thread::spawn(move || {
        let idle_exit = window_from_env("TOPICS_PTY_BRIDGE_IDLE_EXIT_MS", DEFAULT_IDLE_EXIT);
        let tick = (idle_exit / 2).clamp(Duration::from_millis(500), Duration::from_secs(60));
        let mut idle_since = Instant::now();
        loop {
            thread::sleep(tick);
            let busy = !shared.clients.lock_ok().is_empty() || !shared.sessions.lock_ok().is_empty();
            if busy {
                idle_since = Instant::now();
                continue;
            }
            if idle_since.elapsed() >= idle_exit {
                eprintln!(
                    "[PTY Bridge] Idle {}s with no clients and no sessions — shutting down.",
                    idle_exit.as_secs()
                );
                shutdown(&shared);
            }
        }
    });
}

fn socket_from_args() -> PathBuf {
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--socket") {
        if let Some(p) = args.get(i + 1) {
            return PathBuf::from(p);
        }
    }
    // The server always passes --socket; this is only a standalone fallback.
    // On Windows a /tmp path is not a valid pipe name.
    #[cfg(windows)]
    {
        PathBuf::from(r"\\.\pipe\topics-pty-bridge")
    }
    #[cfg(not(windows))]
    {
        PathBuf::from("/tmp/topics-pty-bridge.sock")
    }
}

/// Env seam for the two retirement windows, so they can be exercised without sitting
/// through 90s / 30min. Production never sets these; the same names work on the Node
/// bridge, and a check written against one reads the same on the other.
fn window_from_env(key: &str, default: Duration) -> Duration {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(default)
}

/// Who spawned us, as told by the spawner (server/routes/terminal.ts). Absent for a
/// hand-started daemon, and then the orphan monitor falls back to the ppid heuristic.
fn parent_pid_from_args() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    let i = args.iter().position(|a| a == "--parent-pid")?;
    args.get(i + 1)?.parse::<i32>().ok().filter(|p| *p > 0)
}

pub fn run() {
    // BEFORE check_existing_bridge()/self_test(): both can take seconds, and a
    // spawner that dies inside that window would otherwise make this read 1 and
    // permanently disarm the orphan monitor's fallback heuristic.
    #[cfg(unix)]
    let initial_ppid = unsafe { libc::getppid() };
    #[cfg(not(unix))]
    let initial_ppid = 0;
    let parent_pid = parent_pid_from_args();

    let socket_path = socket_from_args();
    // The pidfile sits BESIDE the socket on unix; on Windows the pipe's name is not
    // a filesystem path, so the file goes elsewhere (see transport).
    let pid_path = transport::pid_path_for(&socket_path);

    if check_existing_bridge(&socket_path, &pid_path) {
        eprintln!(
            "[PTY Bridge] Another healthy bridge is already running on {}",
            socket_path.display()
        );
        std::process::exit(1);
    }

    self_test();

    let listener = match Listener::bind(&socket_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[PTY Bridge] listen error on {}: {e}", socket_path.display());
            std::process::exit(1);
        }
    };
    let _ = std::fs::write(&pid_path, std::process::id().to_string());
    eprintln!(
        "[PTY Bridge] Daemon listening on {} (PID {})",
        socket_path.display(),
        std::process::id()
    );

    let shared = Arc::new(Shared {
        clients: Mutex::new(HashMap::new()),
        connected_at: Mutex::new(HashMap::new()),
        sessions: Mutex::new(HashMap::new()),
        next_generation: Mutex::new(0),
        socket_path,
        pid_path,
    });

    install_signal_handler(shared.clone());
    spawn_orphan_monitor(shared.clone(), initial_ppid, parent_pid);
    spawn_idle_monitor(shared.clone());

    let mut next_cid: u64 = 0;
    loop {
        // `accept()` rather than `incoming()`: on Windows every connection is a
        // pipe instance created on the spot, not a derivation of one listener, so
        // there is no iterator to consume.
        let stream = match listener.accept() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[PTY Bridge] accept error: {e}");
                thread::sleep(Duration::from_millis(50));
                continue;
            }
        };
        let cid = next_cid;
        next_cid += 1;
        let write_half = match stream.try_clone() {
            Ok(c) => c,
            Err(_) => continue,
        };
        // broadcast() holds the clients lock while write_all-ing to every
        // stream: without a write timeout ONE client that stops draining its
        // socket (suspended app, wedged peer) blocks that write forever WITH
        // the lock held — freezing PTY delivery for every terminal, since
        // each session's reader_loop serialises on the same lock. A healthy
        // local consumer drains in microseconds; 2s only trips on a wedged
        // one, which then just loses output instead of taking the app down.
        let _ = write_half.set_write_timeout(Some(Duration::from_secs(2)));
        shared.clients.lock_ok().insert(cid, write_half);
        shared.connected_at.lock_ok().insert(cid, Instant::now());
        eprintln!(
            "[PTY Bridge] Client connected ({} total)",
            shared.clients.lock_ok().len()
        );
        let sh = shared.clone();
        thread::spawn(move || {
            handle_client(cid, stream, &sh);
            sh.clients.lock_ok().remove(&cid);
            sh.connected_at.lock_ok().remove(&cid);
            eprintln!(
                "[PTY Bridge] Client disconnected ({} remaining)",
                sh.clients.lock_ok().len()
            );
        });
    }
}

fn handle_client(cid: u64, stream: Stream, shared: &Arc<Shared>) {
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                send_to(shared, cid, &json!({ "type": "error", "error": e.to_string() }));
                continue;
            }
        };
        // Isolate each message: a panic in one handler must not drop live PTYs.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            handle_message(shared, cid, &v)
        }));
        match result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                // Echo the id so the server fails the right pending create.
                let id = v["id"].as_str();
                send_to(shared, cid, &json!({ "type": "error", "error": err, "id": id }));
            }
            Err(_) => {
                let id = v["id"].as_str();
                send_to(
                    shared,
                    cid,
                    &json!({ "type": "error", "error": "internal panic", "id": id }),
                );
            }
        }
    }
}
