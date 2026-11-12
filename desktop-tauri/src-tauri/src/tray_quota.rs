//! Menu-bar quota strip, fed straight from the usage service.
//!
//! The tray used to depend on the web client for its data, so it froze while
//! the window was hidden or the app restarted. This module polls the service
//! itself (plain HTTP on a worker thread, no extra dependency) and draws one
//! column per account into an RGBA image, because `TrayIconBuilder` only takes
//! an icon and a text. Pure functions (`parse_overview`, `render_strip`) are
//! separate from the I/O so they are unit tested without a display.
//! Card c675633f.

use serde::Deserialize;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::OnceLock;
use std::time::Duration;

/// Service address, overridable for tests and for the future single-port service.
pub const HUB_URL_ENV: &str = "TOPICS_HUB_URL";
const DEFAULT_HUB: &str = "http://127.0.0.1:3360";
pub const POLL_SECS: u64 = 60;

/// Rendering scale (retina): every metric below is in logical points.
const SCALE: f32 = 2.0;
const HEIGHT_PT: f32 = 22.0;
const MAX_WIDTH_PT: f32 = 760.0;

#[derive(Debug, Clone, PartialEq)]
pub struct Quota {
    pub key: String,
    pub used_pct: u32,
    pub reset_text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Column {
    pub provider: String,
    pub label: String,
    pub active: bool,
    pub quotas: Vec<Quota>,
}

#[derive(Deserialize)]
struct RawOverview {
    #[serde(default)]
    providers: Vec<RawProvider>,
}
#[derive(Deserialize)]
struct RawProvider {
    #[serde(default)]
    id: String,
    #[serde(default, rename = "menuOnly")]
    menu_only: Option<bool>,
    #[serde(default)]
    accounts: Vec<RawAccount>,
}
#[derive(Deserialize)]
struct RawAccount {
    #[serde(default)]
    label: String,
    #[serde(default)]
    active: bool,
    #[serde(default)]
    current: Option<bool>,
    #[serde(default)]
    quotas: Vec<RawQuota>,
}
#[derive(Deserialize)]
struct RawQuota {
    #[serde(default)]
    key: String,
    #[serde(default, rename = "usedPct")]
    used_pct: f64,
    #[serde(default, rename = "resetText")]
    reset_text: Option<String>,
}

/// Overview JSON to columns, in-use accounts first, then by highest quota.
pub fn parse_overview(body: &str) -> Option<Vec<Column>> {
    let raw: RawOverview = serde_json::from_str(body).ok()?;
    let mut cols = Vec::new();
    for p in raw.providers.iter().filter(|p| p.menu_only != Some(true)) {
        for a in &p.accounts {
            cols.push(Column {
                provider: p.id.clone(),
                label: a.label.clone(),
                active: a.active || a.current == Some(true),
                quotas: a
                    .quotas
                    .iter()
                    .take(2)
                    .map(|q| Quota {
                        key: q.key.to_uppercase(),
                        used_pct: q.used_pct.clamp(0.0, 100.0).round() as u32,
                        reset_text: q.reset_text.clone().unwrap_or_default(),
                    })
                    .collect(),
            });
        }
    }
    let peak = |c: &Column| c.quotas.iter().map(|q| q.used_pct).max().unwrap_or(0);
    cols.sort_by(|a, b| b.active.cmp(&a.active).then(peak(b).cmp(&peak(a))));
    Some(cols)
}

/// Minimal blocking GET returning the body of a 200 response.
pub fn http_get(base: &str, path: &str) -> Option<String> {
    let rest = base.strip_prefix("http://")?;
    let hostport = rest.split('/').next()?;
    let addr = hostport.to_socket_addrs().ok()?.next()?;
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    s.set_write_timeout(Some(Duration::from_secs(2))).ok()?;
    // HTTP/1.0 so the service never answers chunked.
    write!(s, "GET {path} HTTP/1.0\r\nHost: {hostport}\r\nConnection: close\r\n\r\n").ok()?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let (head, body) = text.split_once("\r\n\r\n")?;
    head.starts_with("HTTP/1.0 200")
        .then_some(())
        .or_else(|| head.starts_with("HTTP/1.1 200").then_some(()))?;
    Some(body.to_string())
}

pub fn hub_base() -> String {
    std::env::var(HUB_URL_ENV).unwrap_or_else(|_| DEFAULT_HUB.to_string())
}

/// One poll: `None` means the service is down or answered garbage.
pub fn fetch_columns(base: &str) -> Option<Vec<Column>> {
    parse_overview(&http_get(base, "/api/overview")?)
}

// ---------------------------------------------------------------- drawing

pub struct Strip {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

static FONT: OnceLock<Option<fontdue::Font>> = OnceLock::new();

fn font() -> Option<&'static fontdue::Font> {
    FONT.get_or_init(|| {
        const CANDIDATES: &[&str] = &[
            "/System/Library/Fonts/Helvetica.ttc",
            "/System/Library/Fonts/SFNS.ttf",
            "C:\\Windows\\Fonts\\segoeui.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ];
        CANDIDATES.iter().find_map(|p| {
            let bytes = std::fs::read(p).ok()?;
            fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default()).ok()
        })
    })
    .as_ref()
}

struct Canvas {
    w: u32,
    h: u32,
    px: Vec<u8>,
}

impl Canvas {
    fn new(w: u32, h: u32) -> Self {
        Canvas { w, h, px: vec![0; (w * h * 4) as usize] }
    }
    /// Source-over blend of a straight-alpha colour.
    fn blend(&mut self, x: i32, y: i32, c: [u8; 3], a: f32) {
        if x < 0 || y < 0 || x >= self.w as i32 || y >= self.h as i32 || a <= 0.0 {
            return;
        }
        let i = ((y as u32 * self.w + x as u32) * 4) as usize;
        let da = self.px[i + 3] as f32 / 255.0;
        let oa = a + da * (1.0 - a);
        for k in 0..3 {
            let d = self.px[i + k] as f32;
            self.px[i + k] = ((c[k] as f32 * a + d * da * (1.0 - a)) / oa).round() as u8;
        }
        self.px[i + 3] = (oa * 255.0).round() as u8;
    }
    fn rect(&mut self, x: i32, y: i32, w: i32, h: i32, c: [u8; 3], a: f32) {
        for yy in y..y + h {
            for xx in x..x + w {
                self.blend(xx, yy, c, a);
            }
        }
    }
    fn text(&mut self, s: &str, x: f32, baseline: f32, size: f32, c: [u8; 3], a: f32) -> f32 {
        let Some(f) = font() else { return text_width(s, size) };
        let mut pen = x;
        for ch in s.chars() {
            let (m, bm) = f.rasterize(ch, size);
            let gx = pen.round() as i32 + m.xmin;
            let gy = baseline.round() as i32 - m.height as i32 - m.ymin;
            for row in 0..m.height {
                for col in 0..m.width {
                    let cov = bm[row * m.width + col] as f32 / 255.0;
                    self.blend(gx + col as i32, gy + row as i32, c, cov * a);
                }
            }
            pen += m.advance_width;
        }
        pen - x
    }
}

fn text_width(s: &str, size: f32) -> f32 {
    match font() {
        Some(f) => s.chars().map(|c| f.metrics(c, size).advance_width).sum(),
        // No system font found: a fixed advance keeps the layout sane.
        None => s.chars().count() as f32 * size * 0.55,
    }
}

fn status_color(pct: u32) -> [u8; 3] {
    match pct {
        0..=69 => [102, 214, 130],
        70..=89 => [245, 196, 66],
        _ => [255, 98, 90],
    }
}

fn crop(label: &str, max_px: f32, size: f32) -> String {
    if text_width(label, size) <= max_px {
        return label.to_string();
    }
    let mut out: String = label.to_string();
    while out.chars().count() > 3 && text_width(&format!("{out}…"), size) > max_px {
        out.pop();
    }
    format!("{out}…")
}

fn provider_color(id: &str) -> [u8; 3] {
    match id {
        "claude" => [217, 119, 87],
        "codex" => [150, 160, 255],
        "muse" => [190, 130, 235],
        _ => [170, 170, 170],
    }
}

/// Draws the strip. `None` (service down) renders the word "offline", never an empty image.
pub fn render_strip(cols: Option<&[Column]>) -> Strip {
    let s = SCALE;
    let h = (HEIGHT_PT * s) as u32;
    let fs = 7.6 * s;
    let pad = 6.0 * s;
    let white = [255, 255, 255];

    let Some(cols) = cols.filter(|c| !c.is_empty()) else {
        let label = if cols.is_none() { "offline" } else { "nessun account" };
        let w = (text_width(label, 9.0 * s) + pad * 2.0).ceil() as u32;
        let mut cv = Canvas::new(w, h);
        cv.text(label, pad, h as f32 * 0.66, 9.0 * s, white, 0.85);
        return Strip { width: w, height: h, rgba: cv.px };
    };

    let gap = 10.0 * s;
    let bar_w = 34.0 * s;
    let tag_w = text_width("7D", fs) + 3.0 * s;
    let row_w = |q: &Quota| tag_w + bar_w + 3.0 * s + text_width("100%", fs) + 3.0 * s + text_width(&q.reset_text, fs);
    let icon = 7.0 * s;
    let widths: Vec<f32> = cols
        .iter()
        .map(|c| {
            let rows = c.quotas.iter().map(row_w).fold(0.0, f32::max);
            rows.max(icon + 3.0 * s + text_width(&c.label, fs)).min(150.0 * s)
        })
        .collect();

    // Keep what fits; the rest collapses into "+N".
    let cap = MAX_WIDTH_PT * s - pad * 2.0 - 24.0 * s;
    let mut shown = 0;
    let mut used = 0.0;
    for w in &widths {
        let need = w + if shown > 0 { gap } else { 0.0 };
        if used + need > cap && shown > 0 {
            break;
        }
        used += need;
        shown += 1;
    }
    let hidden = cols.len() - shown;
    let more = if hidden > 0 { format!("+{hidden}") } else { String::new() };
    let total = pad * 2.0 + used + if hidden > 0 { gap + text_width(&more, fs) } else { 0.0 };
    let mut cv = Canvas::new(total.ceil() as u32, h);

    let mut x = pad;
    for (c, w) in cols.iter().zip(&widths).take(shown) {
        let dim = if c.active { 1.0 } else { 0.55 };
        let (b0, b1, b2) = (7.4 * s, 14.9 * s, 21.6 * s);
        let pc = provider_color(&c.provider);
        cv.rect(x as i32, (b0 - icon + 1.0 * s) as i32, icon as i32, icon as i32, pc, dim);
        let head = crop(&c.label, w - icon - 3.0 * s, fs);
        cv.text(&head, x + icon + 3.0 * s, b0 + 0.5 * s, fs, white, if c.active { 1.0 } else { 0.8 });
        for (i, q) in c.quotas.iter().enumerate() {
            let base = if i == 0 { b1 } else { b2 };
            cv.text(&q.key, x, base, fs, white, 0.8);
            let bx = x + tag_w;
            let bh = (3.0 * s) as i32;
            let by = (base - 3.5 * s) as i32;
            cv.rect(bx as i32, by, bar_w as i32, bh, white, 0.22 * dim.max(0.6));
            let fill = (bar_w * q.used_pct as f32 / 100.0).round() as i32;
            cv.rect(bx as i32, by, fill, bh, status_color(q.used_pct), dim);
            let px = bx + bar_w + 3.0 * s;
            cv.text(&format!("{}%", q.used_pct), px, base, fs, white, 0.9);
            cv.text(&q.reset_text, px + text_width("100%", fs) + 3.0 * s, base, fs, white, 0.6);
        }
        x += w + gap;
    }
    if hidden > 0 {
        cv.text(&more, x, 14.0 * s, fs, white, 0.8);
    }
    Strip { width: cv.w, height: cv.h, rgba: cv.px }
}

/// Worker: polls every `POLL_SECS`, hands each rendered strip to `apply`.
/// Runs on its own thread so a hidden window or a restarted client changes nothing.
pub fn spawn_poller<F>(apply: F)
where
    F: Fn(Strip) + Send + 'static,
{
    let _ = std::thread::Builder::new().name("tray-quota".into()).spawn(move || {
        let mut ever_answered = false;
        loop {
            let base = hub_base();
            let cols = fetch_columns(&base);
            let answered_now = cols.is_some();
            if strip_due(ever_answered, answered_now) {
                apply(render_strip(cols.as_deref()));
            }
            ever_answered |= answered_now;
            std::thread::sleep(Duration::from_secs(POLL_SECS));
        }
    });
}

/// Whether the strip replaces the tray icon. A machine that has no usage service
/// keeps the plain Topics icon: the strip, and its "offline" state, appear only
/// once the service has answered at least once since launch.
pub fn strip_due(ever_answered: bool, answered_now: bool) -> bool {
    ever_answered || answered_now
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"providers":[
      {"id":"claude","accounts":[
        {"label":"a@example.com","active":false,"quotas":[{"key":"7d","usedPct":100,"resetText":"5d7h"}]},
        {"label":"b@example.com","active":true,"quotas":[{"key":"5h","usedPct":12,"resetText":"2h"},{"key":"7d","usedPct":33,"resetText":"5d6h"}]}]},
      {"id":"hidden","menuOnly":true,"accounts":[{"label":"x","quotas":[]}]}]}"#;

    fn opaque(s: &Strip) -> usize {
        s.rgba.chunks(4).filter(|p| p[3] > 0).count()
    }

    #[test]
    fn parses_orders_and_skips_menu_only() {
        let cols = parse_overview(SAMPLE).unwrap();
        assert_eq!(cols.len(), 2);
        assert_eq!(cols[0].label, "b@example.com", "active account first");
        assert_eq!(cols[0].quotas[1], Quota { key: "7D".into(), used_pct: 33, reset_text: "5d6h".into() });
    }

    #[test]
    fn no_service_keeps_the_plain_icon() {
        assert!(!strip_due(false, false), "never answered: no strip, no offline");
        assert!(strip_due(false, true));
        assert!(strip_due(true, false), "service went down after answering: offline strip");
    }

    #[test]
    fn garbage_is_none() {
        assert!(parse_overview("<html>").is_none());
    }

    #[test]
    fn service_down_draws_offline_not_blank() {
        let s = render_strip(None);
        assert!(s.width > 20 && opaque(&s) > 50, "offline strip must have ink");
    }

    #[test]
    fn strip_has_ink_and_scales_with_accounts() {
        let cols = parse_overview(SAMPLE).unwrap();
        let two = render_strip(Some(&cols));
        let one = render_strip(Some(&cols[..1]));
        assert_eq!(two.height, 44);
        assert!(two.width > one.width && opaque(&two) > opaque(&one));
    }

    /// Perf bar: a redraw happens every 60 s on a worker thread, so it must be cheap
    /// and must not grow (same size and bytes every time, no cache that accumulates).
    #[test]
    fn redraw_is_cheap_and_stable() {
        let cols = parse_overview(SAMPLE).unwrap();
        let first = render_strip(Some(&cols));
        let t = std::time::Instant::now();
        for _ in 0..200 {
            let s = render_strip(Some(&cols));
            assert_eq!((s.width, s.rgba.len()), (first.width, first.rgba.len()));
            assert!(s.rgba == first.rgba, "redraw must be deterministic");
        }
        let per = t.elapsed().as_secs_f64() * 1000.0 / 200.0;
        assert!(per < 25.0, "render took {per:.1} ms (debug build budget 25 ms)");
    }

    #[test]
    fn dead_port_is_none_fast() {
        // Port 1 is never open: connect must fail instead of hanging the poller.
        assert!(fetch_columns("http://127.0.0.1:1").is_none());
    }

    /// Writes the strip as PNG for the side-by-side proof:
    /// TRAY_SNAPSHOT_OUT=/tmp/x.png [TRAY_SNAPSHOT_JSON=file] cargo test tray_quota::tests::snapshot
    #[test]
    fn snapshot() {
        let Ok(out) = std::env::var("TRAY_SNAPSHOT_OUT") else { return };
        let cols = match std::env::var("TRAY_SNAPSHOT_JSON") {
            Ok(f) => parse_overview(&std::fs::read_to_string(f).unwrap()),
            Err(_) => fetch_columns(&hub_base()),
        };
        let strip = render_strip(cols.as_deref());
        let file = std::fs::File::create(out).unwrap();
        let mut enc = png::Encoder::new(file, strip.width, strip.height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().unwrap().write_image_data(&strip.rgba).unwrap();
    }
}
