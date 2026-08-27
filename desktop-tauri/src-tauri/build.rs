// The shell's build script. Besides the usual `tauri_build::build()`, it records
// the fingerprint of every sidecar this build is shipping, so the installed app
// can tell whether the sidecars beside it are the ones that came with it.
//
// WHY: the Windows NSIS installer skips a file it cannot overwrite (a sidecar
// that is still RUNNING) and still exits 0, so `app.exe` and the registry can
// report the new version while a sidecar is from the previous release. Measured
// on 2026-08-27 updating 2.2.173 to 2.2.176 with the app open: pty-bridge.exe
// stayed behind. See installer-hooks.nsh for the cure and src/sidecar_integrity.rs
// for the check. Card b13aa168-cf69-4878-8d32-3bbd6a236cb7.

mod sidecar_fingerprint {
    include!("src/sidecar_fingerprint.rs");
}

/// The sidecars declared in tauri.conf.json `bundle.externalBin`, by base name.
/// `tests/unit/nsis-sidecar-hooks.test.ts` fails when this list, the installer
/// hooks and the Tauri config drift apart.
const SIDECARS: &[&str] = &["topics-server", "pty-bridge", "webrtc-bridge"];

fn main() {
    emit_sidecar_fingerprints();
    tauri_build::build()
}

/// Fingerprint `binaries/<name>-<triple><ext>` for the target being built and
/// hand the result to the crate as `TOPICS_SIDECAR_FINGERPRINTS`.
///
/// A sidecar that is missing or empty is simply left out: CI stubs empty files
/// just to clear tauri-build's existence gate (see ci.yml), and a build that
/// cannot fingerprint has to degrade to "unknown", never to a false alarm.
///
/// WINDOWS ONLY, and not out of laziness. The comparison is byte for byte, so it
/// only means something where the bytes that are bundled are the bytes that were
/// built: on Windows NSIS copies the file verbatim (nothing here is code signed,
/// see the release workflow). On macOS the same sidecar is lipo'd into a
/// universal binary and then possibly re-signed, so its bytes legitimately differ
/// from `binaries/<name>-<triple>` and every launch would cry wolf. The failure
/// this guards against is the NSIS one anyway: a .app or an AppImage is replaced
/// whole, never file by file. Whoever adds Windows code signing has to revisit
/// this, because signing rewrites the file it signs.
fn emit_sidecar_fingerprints() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.contains("windows") {
        println!("cargo:rustc-env=TOPICS_SIDECAR_FINGERPRINTS=");
        return;
    }
    let ext = ".exe";
    let mut entries: Vec<(String, String)> = Vec::new();
    for name in SIDECARS {
        let path = std::path::PathBuf::from(format!("binaries/{name}-{target}{ext}"));
        println!("cargo:rerun-if-changed={}", path.display());
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if meta.len() == 0 {
            continue;
        }
        if let Some(fp) = sidecar_fingerprint::fingerprint_file(&path) {
            entries.push(((*name).to_string(), fp));
        }
    }
    println!(
        "cargo:rustc-env=TOPICS_SIDECAR_FINGERPRINTS={}",
        sidecar_fingerprint::render_manifest(&entries)
    );
}
