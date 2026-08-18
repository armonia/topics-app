//! `kill` deve finire con un figlio MORTO, non con un frame ottimista.
//!
//! Il difetto misurato: `kill` era un solo SIGHUP e la sessione usciva dalla
//! mappa PRIMA che qualcuno avesse confermato la morte. Un figlio che intrappola
//! o ignora HUP sopravviveva, e da quel momento non esisteva piu' per nessuno:
//! non per `list`, non per la riconciliazione, non per `shutdown`. Un PTY vivo e
//! irraggiungibile, finche' non moriva la macchina.
//!
//! Qui si misura la chiusura: SIGHUP, una grazia, poi il GRUPPO di processi (non
//! il solo pid: portable-pty mette il figlio in una sessione sua, quindi `sleep`
//! resta nello stesso gruppo a tenere aperto il tty, e senza EOF il reader loop,
//! unico posto che trasmette `exit`, non gira mai).
//!
//! Il secondo test copre l'altra meta' della corsa: due `create` sullo stesso id
//! (la doppia /revive) devono produrre UN solo PTY.

// Socket unix e segnali: su Windows non c'e' niente da misurare, e il file deve
// comunque compilare perche' il job `tauri` gira anche su windows-latest.
#![cfg(unix)]

use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_pty-bridge");

/// Corto per forza: un socket unix oltre i 104 byte non si lega (EINVAL).
fn socket_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("ptbk-{name}-{}.sock", std::process::id()))
}

struct Bridge {
    child: Child,
    socket: PathBuf,
}

impl Bridge {
    fn spawn(socket: &Path, env: &[(&str, &str)]) -> Self {
        let mut cmd = Command::new(BIN);
        cmd.args(["--socket", socket.to_str().unwrap()])
            .args(["--parent-pid", &std::process::id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for (k, v) in env {
            cmd.env(k, v);
        }
        Bridge { child: cmd.spawn().expect("spawn pty-bridge"), socket: socket.to_path_buf() }
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
        let _ = std::fs::remove_file(self.socket.with_extension("pid"));
    }
}

/// Un client del ponte che sa aspettare un frame.
struct Client {
    write: UnixStream,
    lines: BufReader<UnixStream>,
}

impl Client {
    fn connect(sock: &Path) -> Self {
        let st = UnixStream::connect(sock).expect("connect al ponte");
        // Senza timeout un frame che non arriva mai appende il test invece di
        // fallirlo.
        st.set_read_timeout(Some(Duration::from_millis(250))).unwrap();
        let write = st.try_clone().unwrap();
        Client { write, lines: BufReader::new(st) }
    }

    fn send(&mut self, v: Value) {
        self.write.write_all(format!("{v}\n").as_bytes()).expect("write al ponte");
    }

    /// Il primo frame che soddisfa `pred`, o `None` allo scadere.
    fn wait_for(&mut self, timeout: Duration, mut pred: impl FnMut(&Value) -> bool) -> Option<Value> {
        let deadline = Instant::now() + timeout;
        let mut line = String::new();
        while Instant::now() < deadline {
            line.clear();
            match self.lines.read_line(&mut line) {
                Ok(0) => return None,
                Ok(_) => {
                    if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
                        if pred(&v) {
                            return Some(v);
                        }
                    }
                }
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                Err(_) => return None,
            }
        }
        None
    }

    /// Quanti frame che soddisfano `pred` arrivano entro la finestra. Non si
    /// ferma al primo: serve proprio a provare che il secondo non c'e'.
    fn count_for(&mut self, window: Duration, mut pred: impl FnMut(&Value) -> bool) -> usize {
        let deadline = Instant::now() + window;
        let mut n = 0;
        let mut line = String::new();
        while Instant::now() < deadline {
            line.clear();
            match self.lines.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
                        if pred(&v) {
                            n += 1;
                        }
                    }
                }
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                Err(_) => break,
            }
        }
        n
    }
}

fn wait_for_socket(sock: &Path) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        match UnixStream::connect(sock) {
            Ok(_) => return,
            Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => {}
            Err(_) => return,
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("il ponte non ha mai messo in ascolto {}", sock.display());
}

/// `kill -0` senza libc: vero anche per uno zombie, che va bene — il frame
/// `exit` arriva DOPO `child.wait()`, quindi a quel punto e' gia' raccolto.
fn pid_alive(pid: u64) -> bool {
    Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn create(client: &mut Client, id: &str, args: &[&str]) {
    client.send(serde_json::json!({
        "type": "create", "id": id, "shell": "/bin/sh",
        "args": args, "cwd": "/tmp", "cols": 80, "rows": 24,
    }));
}

#[test]
fn un_figlio_che_ignora_hup_viene_ucciso_lo_stesso_e_ne_esce_un_exit() {
    let sock = socket_path("kill");
    let _ = std::fs::remove_file(&sock);
    // Grazia corta: il test misura l'escalation, non la sua durata di default.
    let _bridge = Bridge::spawn(&sock, &[("TOPICS_PTY_BRIDGE_KILL_GRACE_MS", "500")]);
    wait_for_socket(&sock);
    let mut c = Client::connect(&sock);

    // `trap "" HUP` e' precisamente il caso che il SIGHUP secco non chiudeva.
    // `echo PRONTO` non e' decorazione: senza aspettare quel byte il kill puo'
    // arrivare mentre la shell sta ancora partendo, con HUP ancora al default —
    // e allora muore per la ragione sbagliata e il test passa anche col difetto
    // dentro (misurato: passava in 0,12s, e con 300ms di attesa falliva).
    create(&mut c, "s1", &["-c", "trap \"\" HUP; echo PRONTO; sleep 300"]);
    let created = c
        .wait_for(Duration::from_secs(10), |v| v["type"] == "created" && v["id"] == "s1")
        .expect("il ponte non ha mai confermato la create");
    let pid = created["pid"].as_u64().expect("created senza pid");
    assert!(
        c.wait_for(Duration::from_secs(10), |v| {
            v["type"] == "data" && v["id"] == "s1" && v["data"].as_str().is_some_and(|d| d.contains("PRONTO"))
        })
        .is_some(),
        "la shell non ha mai annunciato di avere il trap installato"
    );

    c.send(serde_json::json!({ "type": "kill", "id": "s1" }));

    // La barra: un frame `exit` (l'unico posto che toglie la sessione dalla
    // mappa) entro la grazia piu' un margine. Col solo SIGHUP questo frame non
    // arriva MAI — il figlio lo ignora e `sleep`, che sta nello stesso gruppo,
    // tiene aperto il tty, quindi il reader loop non vede mai EOF.
    let exit = c.wait_for(Duration::from_secs(10), |v| v["type"] == "exit" && v["id"] == "s1");
    assert!(exit.is_some(), "nessun frame exit: il figlio e' sopravvissuto al kill");
    assert!(!pid_alive(pid), "il pid {pid} e' ancora vivo dopo il kill");

    // E la sessione non risulta piu' viva a nessuno: `list` e' la porta che la
    // riconciliazione interroga.
    c.send(serde_json::json!({ "type": "list" }));
    let list = c
        .wait_for(Duration::from_secs(5), |v| v["type"] == "list")
        .expect("il ponte non ha risposto a list");
    let sessions = list["sessions"].as_array().cloned().unwrap_or_default();
    assert!(
        !sessions.iter().any(|s| s["id"] == "s1"),
        "la sessione uccisa e' rimasta in list: {sessions:?}"
    );
}

#[test]
fn due_create_sullo_stesso_id_fanno_un_solo_pty() {
    let sock = socket_path("dup");
    let _ = std::fs::remove_file(&sock);
    let _bridge = Bridge::spawn(&sock, &[]);
    wait_for_socket(&sock);
    let mut c = Client::connect(&sock);

    create(&mut c, "dup1", &["-c", "sleep 300"]);
    create(&mut c, "dup1", &["-c", "sleep 300"]);

    // Un solo `created`: il secondo create trova l'id occupato e torna un
    // errore marcato `exists`, che il server sa non contare come guasto di
    // spawn. Prima nascevano DUE PTY sotto una sola voce di mappa, e il primo
    // dei due a morire portava via il superstite.
    let created = c.count_for(Duration::from_secs(3), |v| v["type"] == "created" && v["id"] == "dup1");
    assert_eq!(created, 1, "un id, un PTY");

    c.send(serde_json::json!({ "type": "list" }));
    let list = c
        .wait_for(Duration::from_secs(5), |v| v["type"] == "list")
        .expect("il ponte non ha risposto a list");
    let sessions = list["sessions"].as_array().cloned().unwrap_or_default();
    assert_eq!(
        sessions.iter().filter(|s| s["id"] == "dup1").count(),
        1,
        "una sola voce in list: {sessions:?}"
    );

    c.send(serde_json::json!({ "type": "kill", "id": "dup1" }));
    assert!(
        c.wait_for(Duration::from_secs(10), |v| v["type"] == "exit" && v["id"] == "dup1").is_some(),
        "nessun exit dopo il kill"
    );
}

