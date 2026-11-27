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
    http_get_bytes(base, path).map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// The same GET for a body that is not text (a project's icon).
pub fn http_get_bytes(base: &str, path: &str) -> Option<Vec<u8>> {
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
    let cut = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&buf[..cut]);
    (head.starts_with("HTTP/1.0 200") || head.starts_with("HTTP/1.1 200")).then(|| buf[cut + 4..].to_vec())
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

const ROW_TOP_BASELINE: f32 = 9.0;
const ROW_BOTTOM_BASELINE: f32 = 1.0;
const ICON_SIZE: f32 = 8.0;
const PCT_PT: f32 = 9.0;
const TIME_PT: f32 = 9.0;
const BAR_W: f32 = 20.0;
const BAR_H: f32 = 6.0;
const BAR_RADIUS: f32 = 2.5;
const GAP: f32 = 2.0;
const ACCOUNT_GAP: f32 = 6.0;
pub(crate) const PAD_X: f32 = 4.0;
const DEFAULT_SCREEN_PT: f32 = 1440.0;
const TRACK_ALPHA: f32 = 0.22;
const SHADOW_ALPHA: f32 = 0.5;

/// Width of the main screen in points, set by the shell once it knows it.
static SCREEN_W_PT: AtomicU32 = AtomicU32::new(0);

pub fn set_screen_width_pt(w: f32) {
    SCREEN_W_PT.store(w.max(0.0).round() as u32, Ordering::Relaxed);
}

pub(crate) fn screen_width_pt() -> f32 {
    match SCREEN_W_PT.load(Ordering::Relaxed) {
        0 => DEFAULT_SCREEN_PT,
        w => w as f32,
    }
}

thread_local! {
    /// Full strip renders done by this thread; the animation test reads it to prove a
    /// frame never redraws the strip (text, gauges, bars).
    pub(crate) static STRIP_RENDERS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

pub struct Strip {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl Strip {
    /// The strip as PNG bytes, for the macOS status item, which takes an image file
    /// rather than raw pixels.
    pub fn to_png(&self) -> Option<Vec<u8>> {
        let mut out = Vec::new();
        let mut enc = png::Encoder::new(&mut out, self.width, self.height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().ok()?.write_image_data(&self.rgba).ok()?;
        Some(out)
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Face {
    /// Header and labels: the semibold system sans.
    Sans,
    /// Reset time: monospaced regular.
    Mono,
    /// Percentage: monospaced bold.
    MonoBold,
    /// Never drawn: the semibold sans used to decide where a name is cropped. The drawn weight
    /// is pushed heavier to match the original's text rasterizer, which would crop a letter early.
    SansMetrics,
    /// Window tag: monospaced semibold (drawn heavier than the original only by ab_glyph).
    MonoSemibold,
    /// Body text of the menu cards: the regular system sans.
    SansRegular,
}

#[cfg(target_os = "macos")]
use crate::tray_coretext::{FontSpec, SystemWeight};
use ab_glyph::{Font as _, FontVec, ScaleFont as _, VariableFont as _};

type Chain = Vec<FontVec>;
static FONTS: OnceLock<[Chain; 6]> = OnceLock::new();

/// Variable weight axis values and the optical size the system uses for text this small.
const WEIGHT_SEMIBOLD: f32 = 800.0;
const WEIGHT_SEMIBOLD_LAYOUT: f32 = 760.0;
/// Where the original rasterizer puts a glyph relative to its pen position, in pixels.
const GLYPH_DX: f32 = -0.5;
const GLYPH_DY: f32 = -0.2;
const WEIGHT_REGULAR: f32 = 600.0;
const WEIGHT_TEXT: f32 = 400.0;
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

fn chains() -> &'static [Chain; 6] {
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
            load_chain(
                &["/System/Library/Fonts/SFNSMono.ttf", "C:\\Windows\\Fonts\\consolab.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"],
                WEIGHT_BOLD,
            ),
            load_chain(
                &["/System/Library/Fonts/SFNS.ttf", "C:\\Windows\\Fonts\\segoeui.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
                WEIGHT_TEXT,
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
        Face::Sans | Face::SansMetrics | Face::SansRegular => match em_scale(font, px) {
            Some(scale) => font.as_scaled(scale).h_advance(font.glyph_id(ch)),
            None => px * 0.55,
        },
        Face::Mono | Face::MonoBold | Face::MonoSemibold => px * MONO_ADVANCE_EM,
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
    pub(crate) w: u32,
    pub(crate) h: u32,
    pub(crate) px: Vec<u8>,
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
    /// macOS: CoreText with pixel-snapped pens. Elsewhere (and as the fallback when CoreText
    /// cannot load the font) the ab_glyph rasterizer.
    fn glyphs(&mut self, face: Face, s: &str, x: f32, baseline: f32, size: f32, c: [u8; 3], a: f32) -> f32 {
        #[cfg(target_os = "macos")]
        if let Some(w) = self.glyphs_coretext(face, s, x, baseline, size, c, a) {
            return w;
        }
        self.glyphs_ab(face, s, x, baseline, size, c, a)
    }
    #[cfg(target_os = "macos")]
    fn glyphs_coretext(&mut self, face: Face, s: &str, x: f32, baseline: f32, size: f32, c: [u8; 3], a: f32) -> Option<f32> {
        // True system weights (what AppKit draws), not the inflated ab_glyph axis values.
        let spec = match face {
            Face::Sans => FontSpec { mono: false, weight: SystemWeight::Semibold },
            Face::SansRegular => FontSpec { mono: false, weight: SystemWeight::Regular },
            Face::SansMetrics => return None,
            Face::Mono => FontSpec { mono: true, weight: SystemWeight::Regular },
            Face::MonoSemibold => FontSpec { mono: true, weight: SystemWeight::Semibold },
            Face::MonoBold => FontSpec { mono: true, weight: SystemWeight::Bold },
        };
        let chars: Vec<char> = s.chars().collect();
        let mut pens = Vec::with_capacity(chars.len());
        let mut pen = 0.0_f32;
        for &ch in &chars {
            pens.push(pen);
            pen += match glyph_font(face, ch) {
                Some(f) => advance(face, f, ch, size),
                None => size * 0.55,
            };
        }
        let origin = x.round();
        let mask = crate::tray_coretext::rasterize(spec, size, &chars, &pens, pen)?;
        let (left, top) = (origin as i32 - mask.margin, baseline.round() as i32 - mask.base_row);
        for (i, cov) in mask.a.iter().enumerate() {
            if *cov > 0 {
                self.blend(left + (i % mask.w) as i32, top + (i / mask.w) as i32, c, *cov as f32 / 255.0 * a);
            }
        }
        Some(pen)
    }
    #[cfg_attr(not(any(test, not(target_os = "macos"))), allow(dead_code))]
    fn glyphs_ab(&mut self, face: Face, s: &str, x: f32, baseline: f32, size: f32, c: [u8; 3], a: f32) -> f32 {
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

/// Draws the strip. `None` (service down) or an empty list draws the same faint placeholder
/// row, never an empty image and never a word.
pub fn render_strip(cols: Option<&[Column]>, extras: &Extras) -> Strip {
    render_strip_on(cols, extras, screen_width_pt())
}

pub fn render_strip_on(cols: Option<&[Column]>, extras: &Extras, screen_pt: f32) -> Strip {
    render_strip_agents(cols, extras, screen_pt, &AgentStates::default(), 0)
}

/// Ink of the strip: white on a dark menu bar, dark on a light one.
static LIGHT_INK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The poller tells the renderer which menu bar tint the strip sits on.
pub fn set_light_ink(light: bool) {
    LIGHT_INK.store(light, Ordering::Relaxed);
}

const DARK_INK: u8 = 28;

/// True when the system appearance is Light (macOS leaves the key unset then).
pub fn system_is_light() -> bool {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("defaults").args(["read", "-g", "AppleInterfaceStyle"]).output();
        return out.map_or(true, |o| !String::from_utf8_lossy(&o.stdout).contains("Dark"));
    }
    #[cfg(not(target_os = "macos"))]
    false
}

/// Light menu bar: the neutral pixels (white ink, black shadow) swap places; coloured ones stay.
pub(crate) fn tint_for_light(px: &mut [u8]) {
    for p in px.chunks_exact_mut(4) {
        let (r, g, b) = (p[0] as i32, p[1] as i32, p[2] as i32);
        if p[3] > 0 && (r - g).abs() < 14 && (g - b).abs() < 14 {
            let v = (255 - g).max(DARK_INK as i32) as u8;
            p[0] = v;
            p[1] = v;
            p[2] = v;
        }
    }
}

/// The strip: agents by state, then the Mac dial and pace gauge, then one item per provider
/// (logo, bar, cumulated figure, first reset). `frame` turns the working glyph only.
pub fn render_strip_agents(cols: Option<&[Column]>, extras: &Extras, _screen_pt: f32, agents: &AgentStates, frame: u32) -> Strip {
    STRIP_RENDERS.with(|c| c.set(c.get() + 1));
    let s = SCALE;
    let lead = agents.width();
    let head = extras.head_width(ACCOUNT_GAP);
    let sums = match cols.filter(|c| !c.is_empty()) {
        Some(c) => rows::summarize(c),
        None => vec![rows::Summary { provider: String::new(), used: 0, total: 0, first_reset: String::new(), dim: true }],
    };
    let (rows_w, _) = rows::layout(&sums);
    let total_pt = PAD_X + lead + head + rows_w + PAD_X;
    let mut cv = Canvas::new((total_pt * s).ceil() as u32, (HEIGHT_PT * s) as u32);
    tray_agents::draw(&mut cv, PAD_X, agents, frame);
    let mut hx = PAD_X + lead;
    if let Some(m) = &extras.mac {
        draw_mac(&mut cv, hx, m);
        hx += MAC_W + ACCOUNT_GAP;
    }
    if let Some(p) = &extras.pace {
        draw_pace(&mut cv, hx, p);
    }
    rows::draw(&mut cv, PAD_X + lead + head, &sums);
    if LIGHT_INK.load(Ordering::Relaxed) {
        tint_for_light(&mut cv.px);
    }
    Strip { width: cv.w, height: cv.h, rgba: cv.px }
}

/// Whether the strip replaces the tray icon. A machine that has no usage service
/// keeps the plain Topics icon: the strip, and its "offline" state, appear only
/// once the service has answered at least once since launch.
pub fn strip_due(ever_answered: bool, answered_now: bool) -> bool {
    ever_answered || answered_now
}

#[path = "tray_quota_rows.rs"]
mod rows;

#[cfg(test)]
#[path = "tray_quota_tests.rs"]
mod tests;
