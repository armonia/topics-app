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
fn main() -> anyhow::Result<()> {
    daemon::run()
}

#[cfg(not(unix))]
fn main() {
    eprintln!("[webrtc-bridge] Unix-socket transport unavailable on this platform; exiting.");
    std::process::exit(0);
}
