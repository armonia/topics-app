// Entry point. The daemon speaks the SAME protocol on all three platforms; only the
// pipe underneath differs (`transport`): a Unix socket on macOS and Linux, a named
// pipe on Windows.
//
// Until 2026-08-26 this file compiled to a no-op on Windows, and said so: "Windows
// keeps the pre-existing 503 'no terminals in standalone' path". Which meant Topics
// on Windows installed, opened, and could not open a terminal - in an app whose whole
// point is running command-line agents.

mod bridge;
mod transport;

fn main() {
    bridge::run();
}
