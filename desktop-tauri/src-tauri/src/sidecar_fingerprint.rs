// Fingerprint of a bundled sidecar binary: the shared vocabulary between the
// BUILD (which knows the bytes it is shipping) and the RUNTIME (which can only
// see the bytes that actually landed on disk).
//
// This file is compiled TWICE on purpose: as a module of the shell, and via
// `include!` from build.rs. Duplicating ten lines of hashing between the two
// sides is how the two sides silently stop agreeing.
//
// A fingerprint is `<len>-<hash>`: the byte length, then FNV-1a 64 over the
// whole file. No cryptography here on purpose. The question this answers is
// "is this the file this build shipped, or the one the previous install left
// behind", not "did an attacker forge a collision": an attacker who can write
// into the install directory has already won.

/// FNV-1a 64 over a byte slice. Kept separate from the file reader so the build
/// side, the runtime side and the tests all hash the same way.
#[allow(dead_code)]
pub fn fingerprint_hash(seed: u64, bytes: &[u8]) -> u64 {
    let mut hash = seed;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The FNV-1a 64 offset basis: the seed of an empty stream.
#[allow(dead_code)]
pub const FINGERPRINT_SEED: u64 = 0xcbf2_9ce4_8422_2325;

/// Fingerprint of a whole file, read in 1 MiB chunks so the ~100 MB server
/// sidecar never sits in memory. `None` when the file cannot be read at all.
#[allow(dead_code)]
pub fn fingerprint_file(path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 1024 * 1024];
    let mut hash = FINGERPRINT_SEED;
    let mut len: u64 = 0;
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        len += n as u64;
        hash = fingerprint_hash(hash, &buf[..n]);
    }
    Some(format!("{len}-{hash:016x}"))
}

/// Render the build-time manifest: `name=fingerprint;name=fingerprint`.
/// Flat text rather than JSON because it travels through a cargo env var.
#[allow(dead_code)]
pub fn render_manifest(entries: &[(String, String)]) -> String {
    entries
        .iter()
        .map(|(name, fp)| format!("{name}={fp}"))
        .collect::<Vec<_>>()
        .join(";")
}

/// Parse the manifest back. Unreadable or empty entries are dropped rather than
/// failing: a build that could not fingerprint its sidecars must degrade to "I
/// do not know", never to "everything is stale".
#[allow(dead_code)]
pub fn parse_manifest(raw: &str) -> Vec<(String, String)> {
    raw.split(';')
        .filter_map(|entry| {
            let (name, fp) = entry.split_once('=')?;
            let (name, fp) = (name.trim(), fp.trim());
            if name.is_empty() || fp.is_empty() {
                return None;
            }
            Some((name.to_string(), fp.to_string()))
        })
        .collect()
}
