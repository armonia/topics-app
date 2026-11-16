//! Puts a rendered strip, and the turning glyph, on the status item (card 066276b6).
//! Shared by the app and by the `tray_tracking` example, so the example exercises the
//! very code the app runs.

use crate::mac::{class, id, msg_send, nil, NSRect, NSSize};
use crate::{tray_overlay, tray_quota, tray_tracking};

/// Sets the strip as the item image and pins the item to the strip's width.
///
/// The image goes on the button directly, already at its final size. Through the tray
/// library it was first forced to 18 pt tall: the variable-length item shrank by a
/// fifth and grew back once the 22 pt size was restored, so the strip and every item
/// to its left jumped sideways on each redraw.
pub fn apply_strip(tray: tauri::tray::TrayIcon, strip: tray_quota::Strip) {
    let (w_pt, h_pt) = (strip.width as f64 / tray_quota::SCALE as f64, strip.height as f64 / tray_quota::SCALE as f64);
    let Some(png) = strip.to_png() else { return };
    tray_tracking::defer("strip", move || {
        tray_overlay::set_strip_width_pt(w_pt);
        let _ = tray.with_inner_tray_icon(move |inner| {
            if let Some(item) = inner.ns_status_item() {
                unsafe {
                    let item: id = objc2::rc::Retained::as_ptr(&item) as id;
                    let button: id = msg_send![item, button];
                    let image = strip_nsimage(&png, w_pt, h_pt);
                    if button != nil && image != nil {
                        // A fixed length: the item is exactly as wide as the strip, so
                        // neither end is cut and nothing to its left reflows.
                        let _: () = msg_send![item, setLength: w_pt];
                        let _: () = msg_send![button, setImage: image];
                    }
                    if image != nil {
                        let _: () = msg_send![image, release];
                    }
                    if button != nil {
                        // The library's click-catching view was sized on its own 18 pt
                        // image and does not see the one set above: make exactly that view
                        // track the button. No other subview is touched.
                        let bounds: NSRect = msg_send![button, bounds];
                        let subs: id = msg_send![button, subviews];
                        let n: usize = msg_send![subs, count];
                        for i in 0..n {
                            let v: id = msg_send![subs, objectAtIndex: i];
                            if is_click_target(v) {
                                let _: () = msg_send![v, setAutoresizingMask: 18usize];
                                let _: () = msg_send![v, setFrame: bounds];
                            }
                        }
                    }
                }
            }
        });
    });
}

/// The strip as an NSImage of `w_pt` x `h_pt` points, not a template, retained (+1:
/// the caller releases it once the button holds it). nil when the bytes do not decode.
/// SAFETY: AppKit main thread, or a headless test.
unsafe fn strip_nsimage(png: &[u8], w_pt: f64, h_pt: f64) -> id {
    let data: id = msg_send![class!(NSData), dataWithBytes: png.as_ptr() as *const std::ffi::c_void, length: png.len()];
    if data == nil {
        return nil;
    }
    let image: id = msg_send![class!(NSImage), alloc];
    let image: id = msg_send![image, initWithData: data];
    if image != nil {
        let _: () = msg_send![image, setSize: NSSize::new(w_pt, h_pt)];
        let _: () = msg_send![image, setTemplate: false];
    }
    image
}

/// The view the tray library adds to catch mouse events.
unsafe fn is_click_target(v: id) -> bool {
    let cls: *const objc2::runtime::AnyClass = msg_send![v, class];
    !cls.is_null() && (*cls).name().to_bytes() == b"TaoTrayTarget"
}

/// Shows glyph frame `frame` (or hides it): only a layer swap, never during a menu.
pub fn apply_overlay(tray: &tauri::tray::TrayIcon, frame: Option<u32>) {
    if tray_tracking::is_open() {
        return;
    }
    let _ = tray.with_inner_tray_icon(move |inner| {
        if let Some(item) = inner.ns_status_item() {
            unsafe {
                let item: id = objc2::rc::Retained::as_ptr(&item) as id;
                let button: id = msg_send![item, button];
                tray_overlay::show(button, frame);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // The strip reaches the status button already at its final size: if the image came
    // out at the PNG's pixel size (or as a template), the item would reflow or turn
    // monochrome on every redraw.
    #[test]
    fn strip_image_has_the_strip_size_and_its_colours() {
        let strip = tray_quota::Strip { width: 8, height: 4, rgba: vec![200u8; 8 * 4 * 4] };
        let png = strip.to_png().expect("png");
        unsafe {
            let img = strip_nsimage(&png, 4.0, 2.0);
            assert!(img != nil, "the PNG decodes");
            let size: NSSize = msg_send![img, size];
            assert_eq!((size.width, size.height), (4.0, 2.0));
            let template: bool = msg_send![img, isTemplate];
            assert!(!template);
            let _: () = msg_send![img, release];
            assert!(strip_nsimage(b"not a png", 4.0, 2.0) == nil);
        }
    }
}
