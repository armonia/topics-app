//! CoreText rasterizer for the quota strip text (macOS only).
//!
//! ab_glyph has no hinting and no system font smoothing, so strip text looked softer than
//! text drawn by AppKit. Here every string is drawn with `CTLineDraw` into an alpha-only
//! bitmap context, one glyph per pen position rounded to a whole pixel, so stems land on
//! the pixel grid. Layout (advances) stays with the caller: only the rasterization moves.
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
    fn CFStringCreateWithCString(alloc: Ref, s: *const c_char, enc: u32) -> Ref;
    fn CFNumberCreate(alloc: Ref, ty: isize, v: *const c_void) -> Ref;
    fn CFDictionaryCreate(alloc: Ref, keys: *const Ref, vals: *const Ref, n: isize, kc: *const c_void, vc: *const c_void) -> Ref;
    fn CFAttributedStringCreate(alloc: Ref, s: Ref, attrs: Ref) -> Ref;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGDataProviderCreateWithFilename(path: *const c_char) -> Ref;
    fn CGFontCreateWithDataProvider(p: Ref) -> Ref;
    fn CGFontCreateCopyWithVariations(f: Ref, vars: Ref) -> Ref;
    fn CGBitmapContextCreate(data: *mut c_void, w: usize, h: usize, bpc: usize, bpr: usize, cs: Ref, info: u32) -> Ref;
    fn CGContextSetGrayFillColor(c: Ref, gray: f64, alpha: f64);
    fn CGContextSetShouldSmoothFonts(c: Ref, on: bool);
    fn CGContextSetShouldAntialias(c: Ref, on: bool);
    fn CGContextSetTextPosition(c: Ref, x: f64, y: f64);
    fn CGContextRelease(c: Ref);
}

#[link(name = "CoreText", kind = "framework")]
extern "C" {
    static kCTFontAttributeName: Ref;
    fn CTFontCreateWithGraphicsFont(f: Ref, size: f64, m: Ref, attrs: Ref) -> Ref;
    fn CTLineCreateWithAttributedString(s: Ref) -> Ref;
    fn CTLineDraw(l: Ref, c: Ref);
}

const UTF8: u32 = 0x0800_0100;
const CF_NUMBER_DOUBLE: isize = 13;
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

struct FontKey {
    path: &'static str,
    wght: u32,
    opsz: u32,
    px: u32,
}

static FONTS: Mutex<Option<HashMap<(String, u32, u32, u32), usize>>> = Mutex::new(None);

fn cf_str(s: &str) -> Ref {
    let c = CString::new(s).unwrap_or_default();
    // SAFETY: valid NUL-terminated string, released by the caller.
    unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8) }
}

fn cf_num(v: f64) -> Ref {
    // SAFETY: `v` outlives the call, CFNumber copies it.
    unsafe { CFNumberCreate(std::ptr::null(), CF_NUMBER_DOUBLE, &v as *const f64 as *const c_void) }
}

/// A CTFont for `path` at the given variable-axis values, cached for the process lifetime.
fn font(path: &'static str, wght: f32, opsz: f32, px: f32) -> Option<Ref> {
    let key = FontKey { path, wght: wght as u32, opsz: opsz as u32, px: (px * 100.0) as u32 };
    let mut guard = FONTS.lock().ok()?;
    let map = guard.get_or_insert_with(HashMap::new);
    let k = (key.path.to_string(), key.wght, key.opsz, key.px);
    if let Some(p) = map.get(&k) {
        return Some(*p as Ref);
    }
    let cpath = CString::new(path).ok()?;
    // SAFETY: plain CoreFoundation/CoreGraphics construction; every temporary is released and
    // the final CTFont is kept alive on purpose (cached).
    unsafe {
        let provider = CGDataProviderCreateWithFilename(cpath.as_ptr());
        if provider.is_null() {
            return None;
        }
        let cg = CGFontCreateWithDataProvider(provider);
        CFRelease(provider);
        if cg.is_null() {
            return None;
        }
        let (kw, ko) = (cf_str("Weight"), cf_str("Optical Size"));
        let (vw, vo) = (cf_num(wght as f64), cf_num(opsz as f64));
        let vars = CFDictionaryCreate(
            std::ptr::null(),
            [kw, ko].as_ptr(),
            [vw, vo].as_ptr(),
            2,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        );
        let varied = CGFontCreateCopyWithVariations(cg, vars);
        for r in [kw, ko, vw, vo, vars] {
            CFRelease(r);
        }
        let base = if varied.is_null() { cg } else { varied };
        let ct = CTFontCreateWithGraphicsFont(base, px as f64, std::ptr::null(), std::ptr::null());
        if !varied.is_null() {
            CFRelease(varied);
        }
        CFRelease(cg);
        if ct.is_null() {
            return None;
        }
        map.insert(k, ct as usize);
        Some(ct)
    }
}

/// Draw `chars` (each at `pens[i]` pixels from the start, rounded to whole pixels) and return
/// the coverage mask. `start_frac` is the fractional part of the string origin, dropped so
/// the whole string snaps to the pixel grid.
pub(crate) fn rasterize(path: &'static str, wght: f32, opsz: f32, px: f32, chars: &[char], pens: &[f32], total: f32) -> Option<Mask> {
    let ct = font(path, wght, opsz, px)?;
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
