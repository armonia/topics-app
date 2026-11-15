//! CoreText rasterizer for the quota strip text (macOS only).
//!
//! ab_glyph has no hinting and no system font smoothing, so strip text looked softer than
//! text drawn by AppKit. Here every string is drawn with `CTLineDraw` into an alpha-only
//! bitmap context, one glyph per pen position rounded to a whole pixel, so stems land on
//! the pixel grid. Layout (advances) stays with the caller: only the rasterization moves.
use objc2::msg_send;
use objc2::runtime::AnyClass;
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CString};
use std::sync::Mutex;

type Ref = *const c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
    fn CFRelease(r: Ref);
    fn CFRetain(r: Ref) -> Ref;
    fn CFStringCreateWithCString(alloc: Ref, s: *const c_char, enc: u32) -> Ref;
    fn CFDictionaryCreate(alloc: Ref, keys: *const Ref, vals: *const Ref, n: isize, kc: *const c_void, vc: *const c_void) -> Ref;
    fn CFAttributedStringCreate(alloc: Ref, s: Ref, attrs: Ref) -> Ref;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGBitmapContextCreate(data: *mut c_void, w: usize, h: usize, bpc: usize, bpr: usize, cs: Ref, info: u32) -> Ref;
    fn CGContextSetGrayFillColor(c: Ref, gray: f64, alpha: f64);
    fn CGContextSetShouldSmoothFonts(c: Ref, on: bool);
    fn CGContextSetShouldAntialias(c: Ref, on: bool);
    fn CGContextSetTextPosition(c: Ref, x: f64, y: f64);
    fn CGContextRelease(c: Ref);
}

#[link(name = "AppKit", kind = "framework")]
extern "C" {
    static NSFontWeightRegular: f64;
    static NSFontWeightSemibold: f64;
    static NSFontWeightBold: f64;
}

#[link(name = "CoreText", kind = "framework")]
extern "C" {
    static kCTFontAttributeName: Ref;

    fn CTLineCreateWithAttributedString(s: Ref) -> Ref;
    fn CTLineDraw(l: Ref, c: Ref);
}

const UTF8: u32 = 0x0800_0100;
const ALPHA_ONLY: u32 = 7;

/// An 8-bit coverage mask: `rows` of `w` bytes, top row first.
pub(crate) struct Mask {
    pub w: usize,
    pub a: Vec<u8>,
    /// Pixels between the mask's left edge and the first pen position.
    pub margin: i32,
    /// Row of the baseline inside the mask.
    pub base_row: i32,
}

/// Weights as AppKit names them for the system font.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum SystemWeight {
    Regular,
    Semibold,
    Bold,
}

/// Which system face: the proportional UI font or the monospaced one.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) struct FontSpec {
    pub mono: bool,
    pub weight: SystemWeight,
}

static FONTS: Mutex<Option<HashMap<(FontSpec, u32), usize>>> = Mutex::new(None);

fn cf_str(s: &str) -> Ref {
    let c = CString::new(s).unwrap_or_default();
    // SAFETY: valid NUL-terminated string, released by the caller.
    unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8) }
}

/// The system font at `px`, from AppKit itself (`NSFont.systemFont(ofSize:weight:)` and
/// `monospacedSystemFont(ofSize:weight:)`, toll-free bridged to CTFont), so weight, optical
/// size and tracking are the ones the OS picks. Cached for the process lifetime.
fn font(spec: FontSpec, px: f32) -> Option<Ref> {
    let mut guard = FONTS.lock().ok()?;
    let map = guard.get_or_insert_with(HashMap::new);
    let k = (spec, (px * 100.0) as u32);
    if let Some(p) = map.get(&k) {
        return Some(*p as Ref);
    }
    // SAFETY: the NSFont statics are plain CGFloat constants; the class methods return an
    // autoreleased font that is retained once and kept in the cache on purpose.
    let ct: Ref = unsafe {
        let weight = match spec.weight {
            SystemWeight::Regular => NSFontWeightRegular,
            SystemWeight::Semibold => NSFontWeightSemibold,
            SystemWeight::Bold => NSFontWeightBold,
        };
        let class = AnyClass::get(c"NSFont")?;
        let f: Ref = if spec.mono {
            msg_send![class, monospacedSystemFontOfSize: px as f64, weight: weight]
        } else {
            msg_send![class, systemFontOfSize: px as f64, weight: weight]
        };
        if f.is_null() {
            return None;
        }
        CFRetain(f)
    };
    map.insert(k, ct as usize);
    Some(ct)
}

/// Draw `chars` (each at `pens[i]` pixels from the start, rounded to whole pixels) and return
/// the coverage mask. `start_frac` is the fractional part of the string origin, dropped so
/// the whole string snaps to the pixel grid.
pub(crate) fn rasterize(spec: FontSpec, px: f32, chars: &[char], pens: &[f32], total: f32) -> Option<Mask> {
    rasterize_font(font(spec, px)?, px, chars, pens, total)
}

/// Same as [`rasterize`] for an already built CTFont (also lets tests draw a reference font).
pub(crate) fn rasterize_font(ct: *const c_void, px: f32, chars: &[char], pens: &[f32], total: f32) -> Option<Mask> {
    let margin = 3_i32;
    let w = total.ceil() as usize + 2 * margin as usize + 1;
    let base_row = (px * 1.1).ceil() as i32 + 1;
    let h = base_row as usize + (px * 0.5).ceil() as usize + 2;
    let mut a = vec![0_u8; w * h];
    // SAFETY: the context draws into `a`, which outlives it; all CF objects are released.
    unsafe {
        let ctx = CGBitmapContextCreate(a.as_mut_ptr() as *mut c_void, w, h, 8, w, std::ptr::null(), ALPHA_ONLY);
        if ctx.is_null() {
            return None;
        }
        CGContextSetShouldAntialias(ctx, true);
        CGContextSetShouldSmoothFonts(ctx, true);
        CGContextSetGrayFillColor(ctx, 1.0, 1.0);
        for (ch, pen) in chars.iter().zip(pens) {
            let mut buf = [0_u8; 4];
            let s = cf_str(ch.encode_utf8(&mut buf));
            let keys = [kCTFontAttributeName];
            let vals = [ct];
            let attrs = CFDictionaryCreate(std::ptr::null(), keys.as_ptr(), vals.as_ptr(), 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
            let astr = CFAttributedStringCreate(std::ptr::null(), s, attrs);
            let line = CTLineCreateWithAttributedString(astr);
            let pos = CGPoint { x: margin as f64 + pen.round() as f64, y: (h as i32 - base_row) as f64 };
            CGContextSetTextPosition(ctx, pos.x, pos.y);
            CTLineDraw(line, ctx);
            for r in [line, astr, attrs, s] {
                CFRelease(r);
            }
        }
        CGContextRelease(ctx);
    }
    Some(Mask { w, a, margin, base_row })
}
