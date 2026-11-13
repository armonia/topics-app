//! Menu-bar quota strip, fed straight from the usage service.
//!
//! The tray used to depend on the web client for its data, so it froze while
//! the window was hidden or the app restarted. This module polls the service
//! itself (plain HTTP on a worker thread, no extra dependency) and draws one
//! column per account into an RGBA image, because `TrayIconBuilder` only takes
//! an icon and a text. Pure functions (`parse_overview`, `render_strip`) are
//! separate from the I/O so they are unit tested without a display.
//! Card c675633f.

use crate::tray_agents::{self, AgentStates};
use crate::tray_dials::{draw_mac, draw_pace, parse_mac, parse_pace, Extras, MAC_W};
use serde::Deserialize;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

/// Service address, overridable for tests and for the future single-port service.
pub const HUB_URL_ENV: &str = "TOPICS_HUB_URL";
const DEFAULT_HUB: &str = "http://127.0.0.1:3360";
pub const POLL_SECS: u64 = 60;

/// Rendering scale (retina): every metric below is in logical points.
pub(crate) const SCALE: f32 = 2.0;
pub(crate) const HEIGHT_PT: f32 = 22.0;

#[derive(Debug, Clone, PartialEq)]
pub struct Quota {
    pub key: String,
    /// Service verdict: ok, warning, critical, depleted, stale. Drives the colours.
    pub status: String,
    pub used_pct: u32,
    pub reset_text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Column {
    pub provider: String,
    pub label: String,
    /// The account the agent is using right now: drawn at full strength.
    pub active: bool,
    /// Marked current by the service: ranked like an active one, but not drawn brighter.
    pub current: bool,
    /// Manual resets still available, shown as a small badge after the name.
    pub reset_credits: u32,
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
    #[serde(default, rename = "resetCredits")]
    reset_credits: Option<RawCredits>,
    #[serde(default)]
    quotas: Vec<RawQuota>,
}
#[derive(Deserialize)]
struct RawCredits {
    #[serde(default)]
    available: u32,
}
#[derive(Deserialize)]
struct RawQuota {
    #[serde(default)]
    key: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default, rename = "usedPct")]
    used_pct: f64,
    #[serde(default, rename = "resetText")]
    reset_text: Option<String>,
}

/// Overview JSON to columns, in the service order (provider by provider).
pub fn parse_overview(body: &str) -> Option<Vec<Column>> {
    let raw: RawOverview = serde_json::from_str(body).ok()?;
    let mut cols = Vec::new();
    for p in raw.providers.iter().filter(|p| p.menu_only != Some(true)) {
        for a in &p.accounts {
            cols.push(Column {
                provider: p.id.clone(),
                label: a.label.clone(),
                active: a.active,
                current: a.current == Some(true),
                reset_credits: a.reset_credits.as_ref().map_or(0, |c| c.available),
                quotas: a
                    .quotas
                    .iter()
                    .take(2)
                    .map(|q| Quota {
                        key: q.key.to_uppercase(),
                        status: q.status.clone().unwrap_or_else(|| "ok".into()),
                        used_pct: q.used_pct.clamp(0.0, 100.0).round() as u32,
                        reset_text: q.reset_text.clone().unwrap_or_default(),
                    })
                    .collect(),
            });
        }
    }
    // Provider order is kept: ranking only decides who survives the "+N" collapse.
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
/// The two dials of the strip, from the same service. Either one may be missing.
pub fn fetch_extras(base: &str) -> Extras {
    Extras {
        mac: http_get(base, "/api/mac").and_then(|b| parse_mac(&b)),
        pace: http_get(base, "/api/board").and_then(|b| parse_pace(&b)),
    }
}

pub fn fetch_columns(base: &str) -> Option<Vec<Column>> {
    parse_overview(&http_get(base, "/api/overview")?)
}

// ---------------------------------------------------------------- drawing
//
// Every constant below is taken from the original menu-bar strip (card 83ec60cf):
// same fonts, sizes, baselines, widths, colours and the same "+N" collapse rule.
// Metrics are logical points, bottom-origin like the original; `S` scales to pixels.

/// Vertical metrics of the three rows, measured from the bottom edge.
const HEADER_BASELINE: f32 = 17.0;
const ROW_TOP_BASELINE: f32 = 9.0;
const ROW_BOTTOM_BASELINE: f32 = 1.0;
const TAG_BASELINE_SHIFT: f32 = -0.5;
const ICON_SIZE: f32 = 8.0;
const ICON_Y: f32 = 15.0;
const ICON_INDENT: f32 = 11.0;
const HEADER_PT: f32 = 7.0;
const TAG_PT: f32 = 7.0;
const PCT_PT: f32 = 9.0;
const TIME_PT: f32 = 9.0;
const BAR_W: f32 = 20.0;
const BAR_H: f32 = 6.0;
const BAR_RADIUS: f32 = 2.5;
const PCT_W: f32 = 22.0;
const GAP: f32 = 2.0;
const TIME_GAP: f32 = 3.0;
const ACCOUNT_GAP: f32 = 6.0;
const PAD_X: f32 = 4.0;
/// The strip never takes more than this share of the screen width (and never more than the cap).
const SCREEN_SHARE: f32 = 0.3;
const MAX_STRIP_PT: f32 = 520.0;
const DEFAULT_SCREEN_PT: f32 = 1440.0;
const NOT_ACTIVE_BAR_DIM: f32 = 0.45;
const NOT_ACTIVE_TEXT_DIM: f32 = 0.8;
const TRACK_ALPHA: f32 = 0.22;
const SHADOW_ALPHA: f32 = 0.5;

/// Width of the main screen in points, set by the shell once it knows it.
static SCREEN_W_PT: AtomicU32 = AtomicU32::new(0);

pub fn set_screen_width_pt(w: f32) {
    SCREEN_W_PT.store(w.max(0.0).round() as u32, Ordering::Relaxed);
}

fn screen_width_pt() -> f32 {
    match SCREEN_W_PT.load(Ordering::Relaxed) {
        0 => DEFAULT_SCREEN_PT,
        w => w as f32,
    }
}

pub struct Strip {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Clone, Copy)]
pub(crate) enum Face {
    /// Header and labels: the semibold system sans.
    Sans,
    /// Reset time: monospaced regular.
    Mono,
    /// Window tag and percentage: monospaced bold.
    MonoBold,
    /// Never drawn: the semibold sans used to decide where a name is cropped. The drawn weight
    /// is pushed heavier to match the original's text rasterizer, which would crop a letter early.
    SansMetrics,
}

use ab_glyph::{Font as _, FontVec, ScaleFont as _, VariableFont as _};

type Chain = Vec<FontVec>;
static FONTS: OnceLock<[Chain; 4]> = OnceLock::new();

/// Variable weight axis values and the optical size the system uses for text this small.
const WEIGHT_SEMIBOLD: f32 = 800.0;
const WEIGHT_SEMIBOLD_LAYOUT: f32 = 760.0;
/// Where the original rasterizer puts a glyph relative to its pen position, in pixels.
const GLYPH_DX: f32 = -0.5;
const GLYPH_DY: f32 = -0.2;
const WEIGHT_REGULAR: f32 = 600.0;
const WEIGHT_BOLD: f32 = 900.0;
const OPTICAL_SIZE_TEXT: f32 = 17.0;

fn load_chain(primary: &[&str], weight: f32) -> Chain {
    // Symbols last: the reset badge glyph is missing from most text faces.
    const SYMBOLS: &[&str] = &["/System/Library/Fonts/Apple Symbols.ttf", "/System/Library/Fonts/SFNS.ttf"];
    let load = |p: &&str| {
        let mut font = FontVec::try_from_vec(std::fs::read(p).ok()?).ok()?;
        // Faces without these axes simply ignore the request.
        font.set_variation(b"wght", weight);
        font.set_variation(b"opsz", OPTICAL_SIZE_TEXT);
        Some(font)
    };
    let mut chain: Chain = primary.iter().find_map(load).into_iter().collect();
    chain.extend(SYMBOLS.iter().filter_map(load));
    chain
}

fn chains() -> &'static [Chain; 4] {
    FONTS.get_or_init(|| {
        [
            load_chain(
                &["/System/Library/Fonts/SFNS.ttf", "C:\\Windows\\Fonts\\seguisb.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
                WEIGHT_SEMIBOLD,
            ),
            load_chain(
                &["/System/Library/Fonts/SFNSMono.ttf", "C:\\Windows\\Fonts\\consola.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"],
                WEIGHT_REGULAR,
            ),
            load_chain(
                &["/System/Library/Fonts/SFNSMono.ttf", "C:\\Windows\\Fonts\\consolab.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"],
                WEIGHT_BOLD,
            ),
            load_chain(
                &["/System/Library/Fonts/SFNS.ttf", "C:\\Windows\\Fonts\\seguisb.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
                WEIGHT_SEMIBOLD_LAYOUT,
            ),
        ]
    })
}

/// Scale that makes the font's em exactly `px` pixels (ab_glyph scales by line height).
fn em_scale(font: &FontVec, px: f32) -> Option<ab_glyph::PxScale> {
    let em = font.units_per_em()?;
    Some(ab_glyph::PxScale::from(px * font.height_unscaled() / em))
}

fn glyph_font(face: Face, ch: char) -> Option<&'static FontVec> {
    let chain = &chains()[face as usize];
    chain.iter().find(|f| f.glyph_id(ch).0 != 0).or_else(|| chain.first())
}

/// Monospaced advance of the original strip's font, in em.
const MONO_ADVANCE_EM: f32 = 0.6181;


fn advance(face: Face, font: &FontVec, ch: char, px: f32) -> f32 {
    match face {
        Face::Sans | Face::SansMetrics => match em_scale(font, px) {
            Some(scale) => font.as_scaled(scale).h_advance(font.glyph_id(ch)),
            None => px * 0.55,
        },
        Face::Mono | Face::MonoBold => px * MONO_ADVANCE_EM,
    }
}

/// Advance of `s` in pixels at `px` em size.
fn text_width(face: Face, s: &str, px: f32) -> f32 {
    s.chars()
        .map(|c| match glyph_font(face, c) {
            Some(f) => advance(face, f, c, px),
            // No system font found: a fixed advance keeps the layout sane.
            None => px * 0.55,
        })
        .sum()
}

/// Advance of `s` in points at `pt` font size.
pub(crate) fn width_pt(face: Face, s: &str, pt: f32) -> f32 {
    text_width(face, s, pt * SCALE) / SCALE
}

pub(crate) struct Canvas {
    w: u32,
    h: u32,
    px: Vec<u8>,
}

impl Canvas {
    pub(crate) fn new(w: u32, h: u32) -> Self {
        Canvas { w, h, px: vec![0; (w * h * 4) as usize] }
    }
    /// Source-over blend of a straight-alpha colour.
    pub(crate) fn blend(&mut self, x: i32, y: i32, c: [u8; 3], a: f32) {
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
    fn glyphs(&mut self, face: Face, s: &str, x: f32, baseline: f32, size: f32, c: [u8; 3], a: f32) -> f32 {
        let mut pen = x;
        for ch in s.chars() {
            let Some(f) = glyph_font(face, ch) else {
                pen += size * 0.55;
                continue;
            };
            if let Some(scale) = em_scale(f, size) {
                let glyph = f.glyph_id(ch).with_scale_and_position(scale, ab_glyph::point(pen + GLYPH_DX, baseline.round() + GLYPH_DY));
                if let Some(outline) = f.outline_glyph(glyph) {
                    let bounds = outline.px_bounds();
                    let (bx, by) = (bounds.min.x.floor() as i32, bounds.min.y.floor() as i32);
                    // Coverage is gathered first: overlapping contours must not stack alpha.
                    let (gw, gh) = (bounds.width().ceil() as usize + 1, bounds.height().ceil() as usize + 1);
                    let mut cover = vec![0.0_f32; gw * gh];
                    outline.draw(|gx, gy, cov| {
                        let at = gy as usize * gw + gx as usize;
                        if at < cover.len() {
                            cover[at] = cover[at].max(cov);
                        }
                    });
                    for (i, cov) in cover.iter().enumerate() {
                        self.blend(bx + (i % gw) as i32, by + (i / gw) as i32, c, cov * a);
                    }
                }
            }
            pen += advance(face, f, ch, size);
        }
        pen - x
    }
    /// Text with the soft drop shadow the original draws under every string.
    /// `baseline` is in pixels from the TOP edge; `size` is the em size in pixels.
    pub(crate) fn text(&mut self, face: Face, s: &str, x: f32, baseline: f32, size: f32, c: [u8; 3], a: f32) -> f32 {
        self.glyphs(face, s, x, baseline + 0.5 * SCALE, size, [0, 0, 0], SHADOW_ALPHA * a);
        self.glyphs(face, s, x, baseline, size, c, a)
    }
    /// Rounded bar: a track and a fill clipped to it, anti-aliased on the corners.
    fn bar(&mut self, x: f32, y: f32, w: f32, h: f32, r: f32, fill_w: f32, track: ([u8; 3], f32), fill: ([u8; 3], f32)) {
        let (cx, cy) = (x + w / 2.0, y + h / 2.0);
        for yy in y.floor() as i32..(y + h).ceil() as i32 {
            for xx in x.floor() as i32..(x + w).ceil() as i32 {
                let (px, py) = (xx as f32 + 0.5 - cx, yy as f32 + 0.5 - cy);
                let (qx, qy) = (px.abs() - (w / 2.0 - r), py.abs() - (h / 2.0 - r));
                let d = qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - r;
                let cov = (0.5 - d).clamp(0.0, 1.0);
                self.blend(xx, yy, track.0, track.1 * cov);
                let fx = (x + fill_w - xx as f32).clamp(0.0, 1.0);
                self.blend(xx, yy, fill.0, fill.1 * cov * fx);
            }
        }
    }
    /// Box-filtered copy of an RGBA image into a `size` square.
    fn icon(&mut self, img: &Icon, x: i32, y: i32, size: i32, a: f32) {
        let step = img.w as f32 / size as f32;
        for dy in 0..size {
            for dx in 0..size {
                let (x0, x1) = ((dx as f32 * step) as usize, (((dx + 1) as f32 * step).ceil() as usize).min(img.w));
                let (y0, y1) = ((dy as f32 * step) as usize, (((dy + 1) as f32 * step).ceil() as usize).min(img.h));
                let (mut r, mut g, mut b, mut al, mut n) = (0.0, 0.0, 0.0, 0.0, 0.0);
                for sy in y0..y1 {
                    for sx in x0..x1 {
                        let p = &img.rgba[(sy * img.w + sx) * 4..][..4];
                        let pa = p[3] as f32 / 255.0;
                        r += p[0] as f32 * pa;
                        g += p[1] as f32 * pa;
                        b += p[2] as f32 * pa;
                        al += pa;
                        n += 1.0;
                    }
                }
                if al > 0.0 && n > 0.0 {
                    self.blend(x + dx, y + dy, [(r / al) as u8, (g / al) as u8, (b / al) as u8], al / n * a);
                }
            }
        }
    }
}

struct Icon {
    w: usize,
    h: usize,
    rgba: Vec<u8>,
}

fn decode_icon(bytes: &[u8]) -> Option<Icon> {
    let mut reader = png::Decoder::new(std::io::Cursor::new(bytes)).read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buf).ok()?;
    let (w, h) = (info.width as usize, info.height as usize);
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..w * h * 4].to_vec(),
        png::ColorType::Rgb => buf.chunks(3).take(w * h).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        _ => return None,
    };
    Some(Icon { w, h, rgba })
}

/// Provider logo, or `None` for a provider without one (no placeholder square).
fn provider_icon(id: &str) -> Option<&'static Icon> {
    static ICONS: OnceLock<[Option<Icon>; 3]> = OnceLock::new();
    let icons = ICONS.get_or_init(|| {
        [
            decode_icon(include_bytes!("../assets/tray/bar-anthropic.png")),
            decode_icon(include_bytes!("../assets/tray/bar-openai.png")),
            decode_icon(include_bytes!("../assets/tray/bar-meta.png")),
        ]
    });
    let i = match id {
        "claude" => 0,
        "codex" => 1,
        "muse" => 2,
        _ => return None,
    };
    icons[i].as_ref()
}

pub(crate) const WHITE: [u8; 3] = [255, 255, 255];

pub(crate) fn status_color(status: &str) -> ([u8; 3], f32) {
    match status {
        "ok" => ([48, 209, 88], 1.0),
        "warning" => ([255, 145, 46], 1.0),
        "critical" | "depleted" => ([255, 65, 68], 1.0),
        _ => ([235, 235, 245], 0.6),
    }
}

/// A stale reading says only its age on the strip; the full sentence lives in the menu.
fn bar_time(q: &Quota) -> String {
    if q.status == "stale" { q.reset_text.replace("dato di ", "") } else { q.reset_text.clone() }
}

fn quota_width(q: &Quota) -> f32 {
    width_pt(Face::MonoBold, &q.key, TAG_PT) + GAP + BAR_W + GAP + PCT_W + TIME_GAP + width_pt(Face::Mono, &bar_time(q), TIME_PT)
}

/// Upper-cased name, cropped with an ellipsis beyond `cap` points.
fn crop_header(label: &str, cap: f32) -> String {
    let up = label.to_uppercase();
    let wide = |s: &str| width_pt(Face::SansMetrics, s, HEADER_PT);
    if wide(&up) <= cap {
        return up;
    }
    let mut t: Vec<char> = up.chars().collect();
    while t.len() > 6 && wide(&format!("{}…", t.iter().collect::<String>())) > cap {
        t.pop();
    }
    format!("{}…", t.iter().collect::<String>())
}

struct Cell<'a> {
    col: &'a Column,
    header: String,
    badge: String,
    width: f32,
}

/// Draws the strip. `None` (service down) renders the word "offline", never an empty image.
pub fn render_strip(cols: Option<&[Column]>, extras: &Extras) -> Strip {
    render_strip_on(cols, extras, screen_width_pt())
}

/// First pass: the width of every account, no positions yet.
fn measure(cols: &[Column]) -> Vec<Cell<'_>> {
    cols.iter()
        .map(|c| {
            let badge = if c.reset_credits > 0 { format!(" ↻{}", c.reset_credits) } else { String::new() };
            let badge_w = width_pt(Face::Sans, &badge, HEADER_PT);
            let qw = c.quotas.iter().map(quota_width).fold(0.0, f32::max);
            let header = crop_header(&c.label, (qw - ICON_INDENT - badge_w).max(30.0));
            let hw = ICON_INDENT + width_pt(Face::Sans, &header, HEADER_PT) + badge_w;
            Cell { col: c, header, badge, width: hw.max(qw) }
        })
        .collect()
}

/// Who fits: active accounts first, then the most loaded; the rest becomes "+N".
/// The Mac dial and the pace gauge sit at the head and take their room first.
fn kept_cells(cells: &[Cell], extras: &Extras, screen_pt: f32, lead: f32) -> Vec<bool> {
    let plus_w = width_pt(Face::Sans, "+9", HEADER_PT) + ACCOUNT_GAP;
    let room = (MAX_STRIP_PT.min(screen_pt * SCREEN_SHARE)) - PAD_X * 2.0 - lead - extras.head_width(ACCOUNT_GAP) - plus_w;
    let peak = |c: &Column| c.quotas.iter().map(|q| q.used_pct).max().unwrap_or(0);
    let mut ranked: Vec<usize> = (0..cells.len()).collect();
    ranked.sort_by(|&a, &b| {
        let (ca, cb) = (cells[a].col, cells[b].col);
        (cb.active || cb.current).cmp(&(ca.active || ca.current)).then(peak(cb).cmp(&peak(ca)))
    });
    let mut keep = vec![false; cells.len()];
    let mut used = 0.0;
    let mut kept = 0;
    for i in ranked {
        let need = cells[i].width + if kept > 0 { ACCOUNT_GAP } else { 0.0 };
        if used + need <= room || kept == 0 {
            keep[i] = true;
            used += need;
            kept += 1;
        }
    }
    keep
}

/// How many accounts end up in the "+N" for these dials on this screen.
#[cfg(test)]
fn hidden_count(cols: &[Column], extras: &Extras, screen_pt: f32) -> usize {
    cols.len() - kept_cells(&measure(cols), extras, screen_pt, 0.0).iter().filter(|k| **k).count()
}

pub fn render_strip_on(cols: Option<&[Column]>, extras: &Extras, screen_pt: f32) -> Strip {
    render_strip_agents(cols, extras, screen_pt, &AgentStates::default(), 0)
}

/// The strip with the agents-by-state group on its LEFT, before the Mac dial and the
/// quota columns. `frame` turns the working glyph; it changes nothing else.
pub fn render_strip_agents(cols: Option<&[Column]>, extras: &Extras, screen_pt: f32, agents: &AgentStates, frame: u32) -> Strip {
    let s = SCALE;
    let lead = agents.width();
    let h = (HEIGHT_PT * s) as u32;

    let Some(cols) = cols.filter(|c| !c.is_empty()) else {
        let label = if cols.is_none() { "offline" } else { "nessun account" };
        let w = (text_width(Face::Sans, label, 9.0 * s) + (PAD_X * 3.0 + lead) * s).ceil() as u32;
        let mut cv = Canvas::new(w, h);
        tray_agents::draw(&mut cv, PAD_X, agents, frame);
        cv.text(Face::Sans, label, (PAD_X * 1.5 + lead) * s, h as f32 * 0.66, 9.0 * s, WHITE, 0.85);
        return Strip { width: w, height: h, rgba: cv.px };
    };

    let cells = measure(cols);
    let head = extras.head_width(ACCOUNT_GAP);
    let keep = kept_cells(&cells, extras, screen_pt, lead);
    let hidden = keep.iter().filter(|k| !**k).count();
    let plus_w = width_pt(Face::Sans, "+9", HEADER_PT) + ACCOUNT_GAP;

    // Second pass: positions for the survivors, in service order.
    let mut x = PAD_X + lead + head;
    let mut placed: Vec<(f32, &Cell)> = Vec::new();
    for (i, cell) in cells.iter().enumerate().filter(|(i, _)| keep[*i]) {
        let _ = i;
        placed.push((x, cell));
        x += cell.width + ACCOUNT_GAP;
    }
    x -= ACCOUNT_GAP;
    let plus_x = x + ACCOUNT_GAP;
    if hidden > 0 {
        x = plus_x + plus_w - ACCOUNT_GAP;
    }
    let total_pt = x + PAD_X;
    let mut cv = Canvas::new((total_pt * s).ceil() as u32, h);

    let top = |bottom_origin: f32| (HEIGHT_PT - bottom_origin) * s;
    let mut hx = PAD_X + lead;
    tray_agents::draw(&mut cv, PAD_X, agents, frame);
    if let Some(m) = &extras.mac {
        draw_mac(&mut cv, hx, m);
        hx += MAC_W + ACCOUNT_GAP;
    }
    if let Some(p) = &extras.pace {
        draw_pace(&mut cv, hx, p);
    }
    for (cx, cell) in placed {
        let c = cell.col;
        let text_dim = if c.active { 1.0 } else { NOT_ACTIVE_TEXT_DIM };
        let bar_dim = if c.active { 1.0 } else { NOT_ACTIVE_BAR_DIM };
        if let Some(icon) = provider_icon(&c.provider) {
            let y = top(ICON_Y + ICON_SIZE);
            cv.icon(icon, ((cx - 1.0) * s).round() as i32, y.round() as i32, (ICON_SIZE * s) as i32, 1.0);
        }
        let hx = (cx + ICON_INDENT) * s;
        cv.text(Face::Sans, &cell.header, hx, top(HEADER_BASELINE), HEADER_PT * s, WHITE, text_dim);
        if !cell.badge.is_empty() {
            let hw = text_width(Face::Sans, &cell.header, HEADER_PT * s);
            cv.text(Face::Sans, &cell.badge, hx + hw, top(HEADER_BASELINE), HEADER_PT * s, WHITE, text_dim);
        }
        for (ri, q) in c.quotas.iter().enumerate() {
            let base = if ri == 0 { ROW_TOP_BASELINE } else { ROW_BOTTOM_BASELINE };
            let mut qx = cx;
            let tag_w = width_pt(Face::MonoBold, &q.key, TAG_PT);
            cv.text(Face::MonoBold, &q.key, qx * s, top(base + TAG_BASELINE_SHIFT), TAG_PT * s, WHITE, text_dim);
            qx += tag_w + GAP;
            let (color, calpha) = status_color(&q.status);
            let fill_w = BAR_W * s * q.used_pct.min(100) as f32 / 100.0;
            cv.bar(
                qx * s,
                top(base + BAR_H),
                BAR_W * s,
                BAR_H * s,
                BAR_RADIUS * s,
                if fill_w > 0.5 { fill_w } else { 0.0 },
                (WHITE, TRACK_ALPHA * bar_dim),
                (color, calpha * bar_dim),
            );
            qx += BAR_W + GAP;
            let pct = format!("{}%", q.used_pct);
            let pw = width_pt(Face::MonoBold, &pct, PCT_PT);
            let (pc, pa) = if q.status == "ok" { (WHITE, text_dim) } else { (color, calpha * text_dim) };
            cv.text(Face::MonoBold, &pct, (qx + (PCT_W - pw) / 2.0) * s, top(base), PCT_PT * s, pc, pa);
            qx += PCT_W + TIME_GAP;
            cv.text(Face::Mono, &bar_time(q), qx * s, top(base), TIME_PT * s, WHITE, text_dim);
        }
    }
    if hidden > 0 {
        cv.text(Face::Sans, &format!("+{hidden}"), plus_x * s, top(HEADER_BASELINE), HEADER_PT * s, WHITE, 1.0);
    }
    Strip { width: cv.w, height: cv.h, rgba: cv.px }
}

/// What the strip is drawn from; the poller refreshes it, the animation and the
/// client's agent counts redraw from it without asking the service again.
struct Latest {
    cols: Option<Vec<Column>>,
    extras: Extras,
    ever_answered: bool,
}

static LATEST: std::sync::Mutex<Option<Latest>> = std::sync::Mutex::new(None);
static AGENTS: std::sync::Mutex<AgentStates> = std::sync::Mutex::new(AgentStates { working: 0, review: 0, waiting: 0, stopped: 0 });

/// The client's latest count of agents by state; the next frame draws it.
pub fn set_agents(states: AgentStates) {
    if let Ok(mut g) = AGENTS.lock() {
        *g = states;
    }
}

fn render_latest(frame: u32) -> Option<Strip> {
    let agents = AGENTS.lock().map(|g| *g).unwrap_or_default();
    let guard = LATEST.lock().ok()?;
    let l = guard.as_ref()?;
    if !strip_due(l.ever_answered, l.cols.is_some()) {
        return None;
    }
    Some(render_strip_agents(l.cols.as_deref(), &l.extras, screen_width_pt(), &agents, frame))
}

/// Worker: polls every `POLL_SECS`, hands each rendered strip to `apply`; a second
/// thread turns the working glyph while an agent is at work (and redraws when the
/// counts change). Both run on their own threads, so a hidden window or a restarted
/// client changes nothing.
pub fn spawn_poller<F>(apply: F)
where
    F: Fn(Strip) + Send + Sync + 'static,
{
    let apply = std::sync::Arc::new(apply);
    let poll_apply = apply.clone();
    let _ = std::thread::Builder::new().name("tray-quota".into()).spawn(move || {
        let mut ever_answered = false;
        loop {
            let base = hub_base();
            let cols = fetch_columns(&base);
            ever_answered |= cols.is_some();
            let extras = fetch_extras(&base);
            if let Ok(mut g) = LATEST.lock() {
                *g = Some(Latest { cols, extras, ever_answered });
            }
            if let Some(strip) = render_latest(0) {
                poll_apply(strip);
            }
            std::thread::sleep(Duration::from_secs(POLL_SECS));
        }
    });
    let _ = std::thread::Builder::new().name("tray-agents".into()).spawn(move || {
        let (mut frame, mut last) = (0u32, AgentStates::default());
        loop {
            std::thread::sleep(Duration::from_millis(tray_agents::FRAME_MS));
            let now = AGENTS.lock().map(|g| *g).unwrap_or_default();
            if now.is_animated() {
                frame = (frame + 1) % tray_agents::TURN_FRAMES;
            } else if now == last {
                continue;
            }
            last = now;
            if let Some(strip) = render_latest(frame) {
                apply(strip);
            }
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
#[path = "tray_quota_tests.rs"]
mod tests;
