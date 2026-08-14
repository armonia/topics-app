//! Anche il ponte in Rust deve sapersi ritirare.
//!
//! Gemello di `server/pty-bridge-orphan.test.ts`: stessa storia, stesso protocollo,
//! stessi due meccanismi. Il 2026-08-14 su questa macchina `ps` mostrava 20 ponti
//! PTY vivi con zero client e zero sessioni, fino a 37 ore di età, nessuno dei quali
//! aveva mai scritto «Parent died»: la guardia era `getppid() == 1 && initial_ppid != 1`
//! e `initial_ppid` veniva letto DOPO il probe di istanza singola e il self-test, così
//! un padre morto in quella finestra la rendeva falsa per sempre. Questo port aveva
//! il buco identico.
//!
//! Qui si misura ciò che lo chiude: `--parent-pid` (chi ci ha lanciato lo dice) e il
//! backstop idle (nessun client e nessuna sessione → ci si ritira comunque), più i
//! due casi opposti — padre vivo e client attaccato — che sono la ragione per cui
//! questo demone è detached e non deve morire da solo.
//!
//! Le due finestre si accorciano via env (`TOPICS_PTY_BRIDGE_ORPHAN_GRACE_MS`,
//! `TOPICS_PTY_BRIDGE_IDLE_EXIT_MS`), gli stessi nomi che legge il ponte Node.

// Socket unix e pid: su Windows non c'è niente da misurare qui, e il file deve
// comunque compilare perché il job `tauri` gira anche su windows-latest.
#![cfg(unix)]

use std::io::ErrorKind;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_pty-bridge");

/// Corto per forza: un socket unix oltre i 104 byte non si lega (EINVAL).
fn socket_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("ptbr-{name}-{}.sock", std::process::id()))
}

struct Bridge {
    child: Child,
    socket: PathBuf,
}

impl Bridge {
    fn spawn(socket: &Path, parent_pid: u32, env: &[(&str, &str)]) -> Self {
        let mut cmd = Command::new(BIN);
        cmd.args(["--socket", socket.to_str().unwrap()])
            .args(["--parent-pid", &parent_pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for (k, v) in env {
            cmd.env(k, v);
        }
        Bridge { child: cmd.spawn().expect("spawn pty-bridge"), socket: socket.to_path_buf() }
    }

    /// `true` appena il processo è uscito da solo. Non blocca.
    fn exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        // Se il test è passato è già morto e questo fallisce: va benissimo.
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.socket);
        let _ = std::fs::remove_file(self.socket.with_extension("pid"));
    }
}

/// Aspetta che `pred` sia vera, o scade.
fn until(timeout: Duration, mut pred: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if pred() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    pred()
}

/// Un pid sicuramente morto: si lancia qualcosa di banale e lo si raccoglie.
fn dead_pid() -> u32 {
    let mut corpse = Command::new("/usr/bin/true")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn /usr/bin/true");
    let pid = corpse.id();
    corpse.wait().expect("reap");
    pid
}

fn wait_for_socket(sock: &Path) {
    assert!(
        until(Duration::from_secs(20), || connectable(sock)),
        "il ponte non ha mai messo in ascolto {}",
        sock.display()
    );
}

/// Il file del socket compare prima del bind, quindi si prova a connettersi davvero.
fn connectable(sock: &Path) -> bool {
    match UnixStream::connect(sock) {
        Ok(_) => true,
        Err(e) => !matches!(e.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused),
    }
}

#[test]
fn ponte_con_padre_morto_si_ritira_e_si_porta_via_il_socket() {
    let sock = socket_path("orphan");
    let _ = std::fs::remove_file(&sock);
    let mut bridge = Bridge::spawn(&sock, dead_pid(), &[("TOPICS_PTY_BRIDGE_ORPHAN_GRACE_MS", "1000")]);

    wait_for_socket(&sock);
    assert!(
        until(Duration::from_secs(30), || bridge.exited()),
        "padre morto e nessun client: il ponte doveva ritirarsi"
    );
    // Uno shutdown pulito scollega il socket; uno sporco lo lascerebbe lì a
    // ingannare il prossimo che prova a connettersi.
    assert!(!sock.exists(), "il socket è rimasto dietro: {}", sock.display());
}

#[test]
fn ponte_con_padre_vivo_resta_su() {
    let sock = socket_path("live");
    let _ = std::fs::remove_file(&sock);
    let mut bridge = Bridge::spawn(
        &sock,
        std::process::id(),
        &[("TOPICS_PTY_BRIDGE_ORPHAN_GRACE_MS", "1000")],
    );

    wait_for_socket(&sock);
    std::thread::sleep(Duration::from_secs(6)); // ben oltre più tick + grazia
    assert!(!bridge.exited(), "il padre è vivo: il ponte non doveva morire");
}

#[test]
fn senza_client_e_sessioni_si_ritira_anche_col_padre_vivo() {
    let sock = socket_path("idle");
    let _ = std::fs::remove_file(&sock);
    let mut bridge = Bridge::spawn(
        &sock,
        std::process::id(),
        &[("TOPICS_PTY_BRIDGE_IDLE_EXIT_MS", "2000")],
    );

    wait_for_socket(&sock);
    assert!(
        until(Duration::from_secs(30), || bridge.exited()),
        "nessun client e nessuna sessione: il backstop idle doveva scattare"
    );
    assert!(!sock.exists(), "il socket è rimasto dietro: {}", sock.display());
}

#[test]
fn con_un_client_attaccato_non_si_ritira() {
    let sock = socket_path("busy");
    let _ = std::fs::remove_file(&sock);
    let mut bridge = Bridge::spawn(
        &sock,
        std::process::id(),
        &[("TOPICS_PTY_BRIDGE_IDLE_EXIT_MS", "2000")],
    );

    wait_for_socket(&sock);
    let client = UnixStream::connect(&sock).expect("il server si attacca al ponte");

    std::thread::sleep(Duration::from_secs(8)); // quattro volte la finestra idle
    assert!(!bridge.exited(), "c'era un client attaccato: il backstop non deve uccidere chi è in uso");
    drop(client);
}
