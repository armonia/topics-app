//! Drawing primitives for the graphic rows of the tray menu (cards for machines,
//! quotas and backup). Coordinates are points with a TOP origin; the pixel buffer
//! is `SCALE` times larger and text goes through the same CoreText path as the
//! strip, so a card looks like the rest of the tray. Card 1aba05b4.

use crate::tray_quota::{status_color, width_pt, Canvas, Face, SCALE};

/// Width of the menu in points, shared by every card.
pub const MENU_W: f32 = 540.0;

/// Colours of the surface the menu is drawn on.
#[derive(Clone, Copy)]
pub struct Palette {
    pub fg: [u8; 3],
    /// Opacity of secondary text.
    pub dim: f32,
}

impl Palette {
    pub fn new(dark: bool) -> Self {
        if dark { Palette { fg: [255, 255, 255], dim: 0.58 } } else { Palette { fg: [0, 0, 0], dim: 0.55 } }
    }
}

/// A traffic-light colour for a service level: 0 fine, 1 watch, 2 bad.
pub fn tone(level: u32) -> [u8; 3] {
    status_color(match level {
        0 => "ok",
        1 => "warning",
        _ => "critical",
    })
    .0
}

/// A glyph as coverage only (0..255 per pixel): painted in any colour, like a template image.
#[derive(Clone)]
pub struct Mask {
    pub w: u32,
    pub h: u32,
    pub alpha: Vec<u8>,
}

impl Mask {
    /// The alpha channel of a PNG (the brand glyphs and the rendered system symbols are RGBA).
    pub fn from_png(bytes: &[u8]) -> Option<Mask> {
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes)).read_info().ok()?;
        let mut buf = vec![0; reader.output_buffer_size()?];
        let info = reader.next_frame(&mut buf).ok()?;
        let n = match info.color_type {
            png::ColorType::Rgba => 4,
            png::ColorType::GrayscaleAlpha => 2,
            _ => return None,
        };
        let alpha = buf[..info.buffer_size()].chunks(n).map(|px| px[n - 1]).collect();
        Some(Mask { w: info.width, h: info.height, alpha })
    }

    fn at(&self, x: f32, y: f32) -> f32 {
        let (fx, fy) = ((x * self.w as f32 - 0.5).max(0.0), (y * self.h as f32 - 0.5).max(0.0));
        let (x0, y0) = ((fx as u32).min(self.w - 1), (fy as u32).min(self.h - 1));
        let (x1, y1) = ((x0 + 1).min(self.w - 1), (y0 + 1).min(self.h - 1));
        let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
        let g = |x: u32, y: u32| self.alpha[(y * self.w + x) as usize] as f32 / 255.0;
        (g(x0, y0) * (1.0 - tx) + g(x1, y0) * tx) * (1.0 - ty) + (g(x0, y1) * (1.0 - tx) + g(x1, y1) * tx) * ty
    }
}

pub struct Pic {
    pub cv: Canvas,
    pub w: f32,
    pub h: f32,
    /// The charts of this picture that answer to the mouse (`tray_hover`); empty for a picture with none.
    pub hover: Vec<crate::tray_hover::HoverZone>,
}

impl Pic {
    pub fn new(w: f32, h: f32) -> Self {
        Pic { cv: Canvas::new((w * SCALE).ceil() as u32, (h * SCALE).ceil() as u32), w, h, hover: Vec::new() }
    }

    /// Paints `cov` (0..1 at a point in pt) over the box, in colour `c` at opacity `a`.
    fn paint(&mut self, bx: (f32, f32, f32, f32), cov: impl Fn(f32, f32) -> f32, c: [u8; 3], a: f32) {
        let (x0, y0, x1, y1) = bx;
        let (px0, px1) = (((x0 * SCALE).floor() as i32).max(0), (x1 * SCALE).ceil() as i32);
        let (py0, py1) = (((y0 * SCALE).floor() as i32).max(0), (y1 * SCALE).ceil() as i32);
        for py in py0..py1 {
            for px in px0..px1 {
                let k = cov((px as f32 + 0.5) / SCALE, (py as f32 + 0.5) / SCALE);
                if k > 0.0 {
                    self.cv.blend(px, py, c, a * k);
                }
            }
        }
    }

    fn rrect_sdf(x: f32, y: f32, r: (f32, f32, f32, f32, f32)) -> f32 {
        let (rx, ry, rw, rh, rad) = r;
        let (qx, qy) = ((x - (rx + rw / 2.0)).abs() - (rw / 2.0 - rad), (y - (ry + rh / 2.0)).abs() - (rh / 2.0 - rad));
        qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - rad
    }

    pub fn fill_rrect(&mut self, x: f32, y: f32, w: f32, h: f32, r: f32, c: [u8; 3], a: f32) {
        let r = r.min(w / 2.0).min(h / 2.0);
        self.paint((x - 1.0, y - 1.0, x + w + 1.0, y + h + 1.0), |px, py| (0.5 - Self::rrect_sdf(px, py, (x, y, w, h, r)) * SCALE).clamp(0.0, 1.0), c, a);
    }

    pub fn stroke_rrect(&mut self, x: f32, y: f32, w: f32, h: f32, r: f32, lw: f32, c: [u8; 3], a: f32) {
        let r = r.min(w / 2.0).min(h / 2.0);
        self.paint((x - 1.0, y - 1.0, x + w + 1.0, y + h + 1.0), |px, py| {
            (lw * SCALE / 2.0 + 0.5 - Self::rrect_sdf(px, py, (x, y, w, h, r)).abs() * SCALE).clamp(0.0, 1.0)
        }, c, a);
    }

    /// A glyph fitted in the `side` square at (x, y), centred, in colour `c`.
    pub fn mask(&mut self, x: f32, y: f32, side: f32, m: &Mask, c: [u8; 3], a: f32) {
        let k = side / m.w.max(m.h) as f32;
        let (w, h) = (m.w as f32 * k, m.h as f32 * k);
        let (x0, y0) = (x + (side - w) / 2.0, y + (side - h) / 2.0);
        self.paint((x0, y0, x0 + w, y0 + h), |px, py| m.at((px - x0) / w, (py - y0) / h), c, a);
    }

    /// The Windows logo as it is: four squares with a thin gap.
    pub fn windows_logo(&mut self, x: f32, y: f32, side: f32, c: [u8; 3], a: f32) {
        let (sq, gap) = (side * 11.377 / 24.0, side * 1.246 / 24.0);
        for (i, j) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
            self.fill_rrect(x + i * (sq + gap), y + j * (sq + gap), sq, sq, 0.0, c, a);
        }
    }

    pub fn dot(&mut self, cx: f32, cy: f32, r: f32, c: [u8; 3], a: f32) {
        self.fill_rrect(cx - r, cy - r, r * 2.0, r * 2.0, r, c, a);
    }

    pub fn hline(&mut self, x: f32, y: f32, w: f32, c: [u8; 3], a: f32) {
        self.fill_rrect(x, y, w, 0.5, 0.0, c, a);
    }

    /// Arc of the upper half circle centred at (cx, cy), `t0..t1` running left (0) to right (1).
    pub fn ring(&mut self, cx: f32, cy: f32, r: f32, w: f32, t0: f32, t1: f32, c: [u8; 3], a: f32) {
        let (lo, hi) = (t0.min(t1) - 0.002, t0.max(t1) + 0.002);
        let ext = r + w;
        self.paint((cx - ext, cy - ext, cx + ext, cy + 0.5), |x, y| {
            let (dx, dy) = (x - cx, cy - y);
            let t = 1.0 - dy.max(0.0).atan2(dx) / std::f32::consts::PI;
            if t < lo || t > hi {
                return 0.0;
            }
            (w * SCALE / 2.0 + 0.5 - ((dx * dx + dy * dy).sqrt() - r).abs() * SCALE).clamp(0.0, 1.0)
        }, c, a);
    }

    /// Filled half disc from the left edge to `t1` (0..1).
    pub fn wedge(&mut self, cx: f32, cy: f32, r: f32, t1: f32, c: [u8; 3], a: f32) {
        self.paint((cx - r - 1.0, cy - r - 1.0, cx + r + 1.0, cy + 0.5), |x, y| {
            let (dx, dy) = (x - cx, cy - y);
            let t = 1.0 - dy.max(0.0).atan2(dx) / std::f32::consts::PI;
            if t > t1 + 0.002 {
                return 0.0;
            }
            ((r - (dx * dx + dy * dy).sqrt()) * SCALE + 0.5).clamp(0.0, 1.0)
        }, c, a);
    }

    pub fn seg(&mut self, p0: (f32, f32), p1: (f32, f32), w: f32, c: [u8; 3], a: f32) {
        let m = w + 1.0;
        self.paint((p0.0.min(p1.0) - m, p0.1.min(p1.1) - m, p0.0.max(p1.0) + m, p0.1.max(p1.1) + m), |x, y| {
            let (vx, vy) = (p1.0 - p0.0, p1.1 - p0.1);
            let l2 = (vx * vx + vy * vy).max(1e-6);
            let t = (((x - p0.0) * vx + (y - p0.1) * vy) / l2).clamp(0.0, 1.0);
            let d = ((x - p0.0 - vx * t).powi(2) + (y - p0.1 - vy * t).powi(2)).sqrt();
            (w * SCALE / 2.0 + 0.5 - d * SCALE).clamp(0.0, 1.0)
        }, c, a);
    }

    /// Draws `s` with its baseline at `y` (pt); returns the advance in pt.
    pub fn text(&mut self, face: Face, s: &str, x: f32, y: f32, pt: f32, c: [u8; 3], a: f32) -> f32 {
        self.cv.text(face, s, x * SCALE, y * SCALE, pt * SCALE, c, a) / SCALE
    }

    /// `s` cut with an ellipsis so it fits `max_w` pt.
    pub fn fit(face: Face, s: &str, pt: f32, max_w: f32) -> String {
        if width_pt(face, s, pt) <= max_w {
            return s.to_string();
        }
        let mut t: String = s.to_string();
        while !t.is_empty() && width_pt(face, &format!("{}…", t.trim_end()), pt) > max_w {
            t.pop();
        }
        format!("{}…", t.trim_end())
    }

    pub fn text_w(face: Face, s: &str, pt: f32) -> f32 {
        width_pt(face, s, pt)
    }

    /// A status pill: tinted capsule, dot and word, right edge at `right`, centred on `cy`.
    pub fn pill(&mut self, right: f32, cy: f32, word: &str, c: [u8; 3]) {
        let tw = Self::text_w(Face::Sans, word, 10.5);
        let (w, h) = (tw + 22.0, 18.0);
        let x = right - w;
        self.fill_rrect(x, cy - h / 2.0, w, h, h / 2.0, c, 0.16);
        self.dot(x + 10.5, cy, 2.5, c, 1.0);
        self.text(Face::Sans, word, x + 16.0, cy + 3.7, 10.5, c, 1.0);
    }

    /// A state pill with no dot, as the original tray draws it: the word on a tinted capsule.
    pub fn pill_plain(&mut self, right: f32, cy: f32, word: &str, c: [u8; 3]) {
        let w = Self::text_w(Face::Sans, word, 10.5) + 14.0;
        self.fill_rrect(right - w, cy - 8.5, w, 17.0, 8.5, c, 0.18);
        self.text(Face::Sans, word, right - w + 7.0, cy + 3.7, 10.5, c, 1.0);
    }

    /// The rounded frame every card sits in.
    pub fn frame(&mut self, x: f32, y: f32, w: f32, h: f32, p: Palette) {
        self.fill_rrect(x, y, w, h, 9.0, p.fg, 0.035);
        self.stroke_rrect(x + 0.5, y + 0.5, w - 1.0, h - 1.0, 9.0, 1.0, p.fg, 0.14);
    }

    /// A capsule bar with an optional tick (0..100) such as the week elapsed.
    pub fn bar(&mut self, x: f32, cy: f32, w: f32, used: f32, mark: Option<f32>, c: [u8; 3], p: Palette) {
        let h = 5.0;
        self.fill_rrect(x, cy - h / 2.0, w, h, h / 2.0, p.fg, 0.14);
        let f = used.clamp(0.0, 100.0) / 100.0;
        if f > 0.0 {
            self.fill_rrect(x, cy - h / 2.0, (w * f).max(h), h, h / 2.0, c, 1.0);
        }
        if let Some(m) = mark.filter(|_| used < 100.0) {
            self.fill_rrect(x + w * m.clamp(0.0, 100.0) / 100.0 - 1.0, cy - 4.5, 2.0, 9.0, 0.5, p.fg, 0.9);
        }
    }

    pub fn to_png(&self) -> Option<Vec<u8>> {
        let mut out = Vec::new();
        let mut enc = png::Encoder::new(&mut out, self.cv.w, self.cv.h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().ok()?.write_image_data(&self.cv.px).ok()?;
        Some(out)
    }
}
