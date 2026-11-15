//! Native layer that turns the working glyph of the tray strip (card 792e3636).
//!
//! The strip image holds everything except that glyph. The glyph lives in a CALayer
//! on top of the status button; each animation tick only swaps the layer's contents
//! to the next pre-built CGImage. No text, no PNG, no NSImage rebuild, no relayout
//! of the button: that is what made WindowServer and ControlCenter busy.

use crate::mac::{class, id, msg_send, nil, NSPoint, NSRect, NSSize};
use crate::tray_agents::{self, OVERLAY_PT};
use crate::tray_quota::{HEIGHT_PT, PAD_X, SCALE};
use std::ffi::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
    fn CGDataProviderCreateWithData(info: *mut c_void, data: *const c_void, size: usize, release: *const c_void) -> *mut c_void;
    fn CGImageCreate(
        w: usize, h: usize, bpc: usize, bpp: usize, bpr: usize, space: *mut c_void, info: u32,
        provider: *mut c_void, decode: *const f64, interpolate: bool, intent: i32,
    ) -> *mut c_void;
}

/// kCGImageAlphaPremultipliedLast: the canvas stores premultiplied RGBA.
const ALPHA_PREMULTIPLIED_LAST: u32 = 1;

/// Width in points of the whole strip image, written by the apply closure.
static STRIP_W_PT_X100: AtomicUsize = AtomicUsize::new(0);
/// The CALayer, created on the first tick (0 = none yet).
static LAYER: AtomicUsize = AtomicUsize::new(0);

pub fn set_strip_width_pt(w: f64) {
    STRIP_W_PT_X100.store((w * 100.0) as usize, Ordering::Relaxed);
}

/// One CGImage per frame, leaked on purpose: they live as long as the process.
fn images() -> &'static Vec<usize> {
    static IMAGES: OnceLock<Vec<usize>> = OnceLock::new();
    IMAGES.get_or_init(|| {
        let g = tray_agents::glyph_frames();
        g.frames
            .iter()
            .map(|px| unsafe {
                let data: &'static [u8] = Box::leak(px.clone().into_boxed_slice());
                let provider = CGDataProviderCreateWithData(std::ptr::null_mut(), data.as_ptr() as *const c_void, data.len(), std::ptr::null());
                let space = CGColorSpaceCreateDeviceRGB();
                let w = g.width as usize;
                CGImageCreate(w, g.height as usize, 8, 32, w * 4, space, ALPHA_PREMULTIPLIED_LAST, provider, std::ptr::null(), false, 0) as usize
            })
            .collect()
    })
}

/// Shows frame `frame` (or hides the layer for `None`). Must run on the main thread.
pub unsafe fn show(button: id, frame: Option<u32>) {
    if button == nil {
        return;
    }
    let _: () = msg_send![button, setWantsLayer: true];
    let host: id = msg_send![button, layer];
    if host == nil {
        return;
    }
    let mut layer = LAYER.load(Ordering::Relaxed) as id;
    if layer == nil {
        layer = msg_send![class!(CALayer), new];
        let _: () = msg_send![layer, setContentsScale: SCALE as f64];
        let _: () = msg_send![host, addSublayer: layer];
        LAYER.store(layer as usize, Ordering::Relaxed);
    }
    let tx = class!(CATransaction);
    let _: () = msg_send![tx, begin];
    let _: () = msg_send![tx, setDisableActions: true];
    match frame {
        Some(i) => {
            let imgs = images();
            let img = imgs[(i as usize) % imgs.len()] as *mut c_void;
            let b: NSRect = msg_send![button, bounds];
            let strip_w = STRIP_W_PT_X100.load(Ordering::Relaxed) as f64 / 100.0;
            let x = (b.size.width - strip_w) / 2.0 + PAD_X as f64;
            let y = (b.size.height - HEIGHT_PT as f64) / 2.0;
            let _: () = msg_send![layer, setFrame: NSRect::new(NSPoint::new(x, y), NSSize::new(OVERLAY_PT as f64, HEIGHT_PT as f64))];
            let _: () = msg_send![layer, setContents: img];
            let _: () = msg_send![layer, setHidden: false];
        }
        None => {
            let _: () = msg_send![layer, setHidden: true];
        }
    }
    let _: () = msg_send![tx, commit];
}
