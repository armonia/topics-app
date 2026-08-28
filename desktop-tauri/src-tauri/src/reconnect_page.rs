//! The page the shell serves INSTEAD of a dead navigation, and the one fact that
//! turns the wait from a mystery into something a person can act on: the path of
//! the `external-server-seen` marker.
//!
//! It lives in its own file for the reason `lib.rs` keeps growing: this is a
//! self-contained response builder with one caller in the proxy loop and one
//! writer at boot, not a piece of the shell's setup. Everything here is pure and
//! platform-independent on purpose, so `cargo check` and `cargo test` cover it on
//! every OS, not only on the one that can reproduce the bug.

use crate::DEFAULT_UPSTREAM_PORT;

/// Set at boot when the shell DELIBERATELY refused to spawn a sidecar because the
/// `external-server-seen` marker says this machine owns a real server (see
/// `decide_upstream_and_spawn`). Holds the marker's path, which is the one piece of
/// information that turns the wait from a mystery into something a person can act
/// on. Unset means "ordinary outage": the wait is temporary and needs no
/// explanation. One single door, written once at boot and read by the page.
pub(crate) static DEGRADED_MARKER_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Minimal HTML escaping for the one untrusted-ish value the reconnect page prints:
/// a filesystem path. It comes from the OS app-data dir, so it can hold a user name
/// with any character in it; printing it raw would let a `<` break the document.
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// The page the shell serves INSTEAD of a dead navigation. Two jobs, both of which
/// the "nothing" we served before could not do: it PAINTS (opaque background, so
/// the transparent window stops being invisible and the user sees a state instead
/// of a ghost), and it RELOADS ITSELF every second. So the moment the server is
/// back the real app returns with no human in the loop. `no-store` keeps WebKit
/// from ever caching this in place of the app.
pub(crate) fn reconnect_page_response() -> Vec<u8> {
    reconnect_page_response_for(DEGRADED_MARKER_PATH.get().map(|s| s.as_str()))
}

/// Same page, with the boot verdict passed in so it can be built without a running
/// shell (and asserted in tests).
///
/// `marker` is `Some(path)` ONLY in the degraded case: the marker file exists, so
/// this machine is known to own a real server on :3333, nobody answered there, and
/// the shell chose to keep waiting rather than fork an empty universe (the
/// 2026-08-13 incident, documented in `decide_upstream_and_spawn`). That choice is
/// right and it stays; what was wrong is that it was SILENT. A machine that had a
/// server yesterday and has none today sat on "Reconnecting" forever, with no
/// message naming the cause and no way out short of knowing about a file nobody
/// ever mentions. So in that case the page NAMES both: why nothing is starting, and
/// the file to remove to get a local server back. Measured on Windows on 2026-08-28
/// (board card d1f702ab): app up, statistics empty, ~52 MB instead of ~113, and no
/// text on screen but "Reconnecting".
///
/// The page still reloads itself, so the ordinary case (server coming back) still
/// recovers with nobody in the loop.
pub(crate) fn reconnect_page_response_for(marker: Option<&str>) -> Vec<u8> {
    let explain = match marker {
        Some(path) => format!(
            "<div class=\"w\"><p>This machine has already run a Topics server on port \
{DEFAULT_UPSTREAM_PORT}, so the app waits for that one instead of starting its own. \
Nothing is answering there now.</p>\
<p>To start a local server instead: quit Topics, delete this file, and open it again.</p>\
<p class=\"f\">{}</p></div>",
            html_escape(path)
        ),
        None => String::new(),
    };
    // A one-second self-reload is right when the outage is a restart (the app comes
    // back before the user reads anything). With a message on screen it would blink
    // the text away every second while it is being read, so the degraded page waits
    // longer between reloads: there, the server is not expected back in a second.
    let reload_ms = if marker.is_some() { 3000 } else { 1000 };
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
<title>Topics</title>\
<style>html,body{{height:100%;margin:0;background:#1c1c1e;color:#98989d;\
font:13px/1.5 -apple-system,system-ui,sans-serif;-webkit-user-select:none}}\
body{{display:flex;flex-direction:column;align-items:center;justify-content:center;\
padding:24px;box-sizing:border-box}}\
.r{{display:flex;align-items:center}}\
.d{{width:6px;height:6px;border-radius:50%;background:#98989d;margin-right:8px;\
animation:p 1.2s ease-in-out infinite}}\
.w{{max-width:520px;margin-top:18px;text-align:center;color:#8a8a8e}}\
.w p{{margin:8px 0}}\
.f{{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;\
color:#c7c7cc;word-break:break-all;-webkit-user-select:text;user-select:text}}\
@keyframes p{{0%,100%{{opacity:.25}}50%{{opacity:1}}}}</style></head>\
<body><div class=\"r\"><div class=\"d\"></div>Waiting for the server\u{2026}</div>{explain}\
<script>setTimeout(function(){{location.reload()}},{reload_ms})</script></body></html>"
    );
    format!(
        "HTTP/1.1 503 Service Unavailable\r\n\
Content-Type: text/html; charset=utf-8\r\n\
Content-Length: {}\r\n\
Cache-Control: no-store\r\n\
Connection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::{reconnect_page_response, reconnect_page_response_for};

    /// The body the header announces must be the body that follows it: a wrong
    /// `Content-Length` leaves WebKit waiting for bytes that never come.
    fn assert_length_matches(r: &str) {
        let len: usize = r
            .split("Content-Length: ")
            .nth(1)
            .and_then(|s| s.split("\r\n").next())
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(len, r.split("\r\n\r\n").nth(1).unwrap().len());
    }

    /// The whole point of the page is that it PAINTS (opaque background, since the
    /// window is transparent, so "nothing" is invisible, not white) and comes back
    /// BY ITSELF.
    #[test]
    fn reconnect_page_paints_and_self_reloads() {
        let r = String::from_utf8(reconnect_page_response()).unwrap();
        assert!(r.starts_with("HTTP/1.1 503 "));
        assert!(r.contains("Content-Type: text/html"));
        assert!(r.contains("Cache-Control: no-store"), "must never be cached over the app");
        assert!(r.contains("location.reload()"), "must recover with no human in the loop");
        assert!(r.contains("background:#1c1c1e"), "must paint opaque pixels");
        assert_length_matches(&r);
    }

    /// The degraded page must NAME the cause and the file. Without this the user got
    /// an app that does nothing and says nothing, and the only way out was a file
    /// nobody knows exists (board card d1f702ab, measured on Windows 2026-08-28).
    #[test]
    fn degraded_page_names_the_cause_and_the_marker_file() {
        let path = "C:\\Users\\x\\AppData\\Roaming\\io.armonia.topics.tauri\\external-server-seen";
        let r = String::from_utf8(reconnect_page_response_for(Some(path))).unwrap();
        assert!(r.contains(path), "the page must print the marker's full path");
        assert!(r.contains("3333"), "must say WHICH server it is waiting for");
        assert!(r.contains("delete this file"), "must give the way out");
        assert!(r.contains("location.reload()"), "must still recover by itself");
        assert_length_matches(&r);
    }

    /// ...and the ORDINARY outage (a restart) stays a bare dot: naming a file there
    /// would be noise about a wait that ends by itself in two seconds.
    #[test]
    fn ordinary_outage_page_explains_nothing() {
        let r = String::from_utf8(reconnect_page_response_for(None)).unwrap();
        assert!(!r.contains("external-server-seen"));
        assert!(!r.contains("delete this file"));
        assert!(r.contains("Waiting for the server"));
        assert_length_matches(&r);
    }

    /// A path is not HTML: a user directory holding `<` must not be able to break
    /// the document open.
    #[test]
    fn marker_path_is_escaped() {
        let r = String::from_utf8(reconnect_page_response_for(Some("/tmp/<b>/seen"))).unwrap();
        assert!(r.contains("/tmp/&lt;b&gt;/seen"));
        assert!(!r.contains("/tmp/<b>/seen"));
        assert_length_matches(&r);
    }
}
