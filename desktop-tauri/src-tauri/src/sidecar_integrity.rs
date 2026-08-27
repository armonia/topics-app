//! Did the update actually land, all of it?
//!
//! Until now "updated" meant one thing: `app.exe` reports the new version and so
//! does the registry. On 2026-08-27 that was true on a real Windows machine while
//! `pty-bridge.exe` was still the binary of the previous release, because the
//! NSIS installer cannot overwrite a file that is RUNNING, skips it, and exits 0
//! (installer-hooks.nsh explains the mechanism and closes the sidecars before the
//! copy). The consequence is not academic: the next release that fixes the bridge
//! would be announced as delivered precisely to the people who did not get it.
//!
//! So the shell checks the other three quarters of itself. The build records the
//! fingerprint of every binary in `bundle.externalBin` (build.rs), the running
//! app fingerprints the files sitting beside it, and a difference is reported
//! instead of being assumed impossible.
//!
//! Design notes:
//!   · The comparison is a pure function (`evaluate`) so it can be tested on
//!     every OS by `cargo test --lib`, with no bundle and no installer.
//!   · A build with no fingerprints (dev build, or CI's empty stub sidecars)
//!     reports `checked: false` and NOTHING is claimed. An integrity check that
//!     cries wolf in dev would be turned off within the week.
//!   · Debug builds skip the check entirely: `cargo run` has no sidecars beside
//!     the executable, and "missing" there means nothing.
//!   · Only Windows builds carry a manifest at all (see build.rs): elsewhere the
//!     bundled bytes are legitimately not the built bytes (macOS lipo + code
//!     signing), and the whole bundle is replaced in one move anyway.

use crate::sidecar_fingerprint::{fingerprint_file, parse_manifest};
use serde::Serialize;

/// The fingerprints this build shipped, as `name=len-hash;...` (see build.rs).
const BUILD_FINGERPRINTS: &str = env!("TOPICS_SIDECAR_FINGERPRINTS");

/// What one declared sidecar turned out to be on disk.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    /// Base name, as declared in `bundle.externalBin` (no extension).
    pub name: String,
    /// `ok` (the bytes this build shipped), `stale` (different bytes: an install
    /// that skipped this file), or `missing` (not on disk at all).
    pub state: &'static str,
}

/// The verdict on the whole install.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SidecarReport {
    /// False only when something is provably wrong. An unknown state is not a
    /// failure.
    pub ok: bool,
    /// False when this build recorded no fingerprints, so nothing was verified.
    pub checked: bool,
    /// Names of the sidecars that are stale or missing, for the message.
    pub bad: Vec<String>,
    /// Per-sidecar detail, in declaration order.
    pub items: Vec<SidecarStatus>,
}

impl SidecarReport {
    /// The verdict of a build that cannot check itself.
    fn unchecked() -> Self {
        SidecarReport { ok: true, checked: false, bad: Vec::new(), items: Vec::new() }
    }
}

/// Compare what the build shipped with what is on disk. `actual` returns the
/// fingerprint of the installed file, or `None` when there is no such file.
pub fn evaluate<F>(expected: &[(String, String)], actual: F) -> SidecarReport
where
    F: Fn(&str) -> Option<String>,
{
    if expected.is_empty() {
        return SidecarReport::unchecked();
    }
    let mut items = Vec::with_capacity(expected.len());
    let mut bad = Vec::new();
    for (name, want) in expected {
        let state = match actual(name) {
            None => "missing",
            Some(got) if &got == want => "ok",
            Some(_) => "stale",
        };
        if state != "ok" {
            bad.push(name.clone());
        }
        items.push(SidecarStatus { name: name.clone(), state });
    }
    SidecarReport { ok: bad.is_empty(), checked: true, bad, items }
}

/// Fingerprint the sidecars installed beside the running executable and compare
/// them with the build manifest. Reads up to a few hundred MB, so it belongs on a
/// background thread, not on the startup path.
pub fn check_installed() -> SidecarReport {
    // Debug builds have no bundle: there is nothing truthful to say.
    if cfg!(debug_assertions) {
        return SidecarReport::unchecked();
    }
    let expected = parse_manifest(BUILD_FINGERPRINTS);
    let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf()))
    else {
        return SidecarReport::unchecked();
    };
    evaluate(&expected, |name| {
        // Tauri lays externalBin sidecars beside the app executable, keeping the
        // platform extension.
        let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
        fingerprint_file(&dir.join(file))
    })
}

/// Cached verdict: the files do not change under a running app, and the client
/// asks for this every time the version popover opens.
static REPORT: std::sync::OnceLock<SidecarReport> = std::sync::OnceLock::new();

/// The verdict, computed once. Safe to call from any thread.
pub fn report() -> SidecarReport {
    REPORT.get_or_init(check_installed).clone()
}

/// Compute the verdict off the startup path and say so in the log. A partial
/// update has to leave a trace even for whoever never opens the version popover.
pub fn warm_in_background() {
    std::thread::spawn(|| {
        let r = report();
        if !r.checked {
            return;
        }
        if r.ok {
            eprintln!("[integrity] all {} bundled sidecars match this build", r.items.len());
        } else {
            eprintln!(
                "[integrity] INCOMPLETE INSTALL: {} does not match this build (an installer \
                 cannot overwrite a running file); quit Topics and reinstall",
                r.bad.join(", ")
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar_fingerprint::{fingerprint_file, parse_manifest, render_manifest};

    fn expected() -> Vec<(String, String)> {
        vec![
            ("topics-server".to_string(), "10-aaaaaaaaaaaaaaaa".to_string()),
            ("pty-bridge".to_string(), "20-bbbbbbbbbbbbbbbb".to_string()),
        ]
    }

    #[test]
    fn everything_matching_is_ok() {
        let exp = expected();
        let r = evaluate(&exp, |name| {
            exp.iter().find(|(n, _)| n == name).map(|(_, f)| f.clone())
        });
        assert!(r.ok && r.checked);
        assert!(r.bad.is_empty());
        assert_eq!(r.items.len(), 2);
    }

    /// The 2026-08-27 case: the app is new, one sidecar is the previous build.
    #[test]
    fn one_stale_sidecar_fails_the_report() {
        let exp = expected();
        let r = evaluate(&exp, |name| {
            Some(if name == "pty-bridge" {
                "20-cccccccccccccccc".to_string()
            } else {
                "10-aaaaaaaaaaaaaaaa".to_string()
            })
        });
        assert!(!r.ok);
        assert_eq!(r.bad, vec!["pty-bridge".to_string()]);
        assert_eq!(r.items[1].state, "stale");
    }

    #[test]
    fn a_missing_sidecar_is_reported_too() {
        let exp = expected();
        let r = evaluate(&exp, |name| {
            if name == "topics-server" { None } else { Some("20-bbbbbbbbbbbbbbbb".to_string()) }
        });
        assert!(!r.ok);
        assert_eq!(r.items[0].state, "missing");
    }

    /// A build that did not record fingerprints claims nothing: no alarm in dev.
    #[test]
    fn no_manifest_means_unchecked_not_broken() {
        let r = evaluate(&[], |_| None);
        assert!(r.ok);
        assert!(!r.checked);
    }

    #[test]
    fn manifest_round_trips_and_survives_garbage() {
        let entries = expected();
        let parsed = parse_manifest(&render_manifest(&entries));
        assert_eq!(parsed, entries);
        assert!(parse_manifest("").is_empty());
        assert!(parse_manifest("nonsense;=;x=").is_empty());
    }

    /// Different bytes have to produce different fingerprints, otherwise the
    /// whole check is decoration.
    #[test]
    fn fingerprint_separates_two_builds_of_the_same_size() {
        let dir = std::env::temp_dir().join(format!("topics-fp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        std::fs::write(&a, b"pty-bridge build 173").unwrap();
        std::fs::write(&b, b"pty-bridge build 176").unwrap();
        let fa = fingerprint_file(&a).unwrap();
        let fb = fingerprint_file(&b).unwrap();
        assert_ne!(fa, fb);
        assert!(fa.starts_with("20-"), "length is part of the fingerprint: {fa}");
        assert_eq!(fingerprint_file(&dir.join("nope.bin")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
