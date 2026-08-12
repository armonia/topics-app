// Entry point. The bridge is a Unix-socket daemon (macOS + Linux) that streams a
// server-side headless-Chromium pane as a shared H.264 WebRTC track (see daemon.rs);
// on Windows it compiles to a no-op so the Tauri externalBin bundle still resolves a
// binary for every target, while lib.rs never advertises one there (the server keeps
// TOPICS_DISABLE_WEBRTC_BRIDGE=1 and the pane uses the DOM fallback).
//
// The heavy deps (webrtc-rs, openh264, zune-jpeg, tokio) are cfg(unix)-scoped in
// Cargo.toml, so the Windows stub compiles in seconds instead of minutes.

#[cfg(unix)]
mod cdp;
#[cfg(unix)]
mod daemon;
#[cfg(unix)]
mod encode;
#[cfg(unix)]
mod input;
#[cfg(all(unix, target_os = "macos"))]
mod vt;

#[cfg(unix)]
fn main() -> anyhow::Result<()> {
    // `--bench <frame.jpg> [n]`: misura gli encoder uno contro l'altro sullo stesso
    // fotogramma e stampa ms e CPU. Non è un modo di funzionare del daemon, è il
    // banco che regge il punto 5 del piano — vive qui perché deve girare contro il
    // BINARIO spedito, non contro una copia del codice.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(i) = args.iter().position(|a| a == "--bench") {
        let path = args.get(i + 1).cloned().ok_or_else(|| anyhow::anyhow!("--bench <frame.jpg> [n]"))?;
        let n = args.get(i + 2).and_then(|s| s.parse::<usize>().ok()).unwrap_or(120);
        return encode::bench(&path, n);
    }
    daemon::run()
}

#[cfg(not(unix))]
fn main() {
    eprintln!("[webrtc-bridge] Unix-socket transport unavailable on this platform; exiting.");
    std::process::exit(0);
}
