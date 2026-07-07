// Entry point. The bridge is a Unix-socket daemon (macOS + Linux); on Windows it
// compiles to a no-op so the Tauri externalBin bundle still resolves a binary for
// every target, while lib.rs simply never spawns it there (Windows keeps the
// pre-existing 503 "no terminals in standalone" path).

#[cfg(unix)]
mod bridge;

#[cfg(unix)]
fn main() {
    bridge::run();
}

#[cfg(not(unix))]
fn main() {
    eprintln!("[PTY Bridge] Unix-socket transport unavailable on this platform; exiting.");
    std::process::exit(0);
}
