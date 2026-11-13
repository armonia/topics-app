//! Puts a rendered strip, and the turning glyph, on the status item (card 066276b6).
//! Shared by the app and by the `tray_tracking` example, so the example exercises the
//! very code the app runs.

use crate::mac::{id, msg_send, nil, NSRect, NSSize};
use crate::{tray_overlay, tray_quota, tray_tracking};

/// Sets the strip as the item image and pins the item to the strip's width.
pub fn apply_strip(tray: tauri::tray::TrayIcon, strip: tray_quota::Strip) {
    tray_tracking::defer("strip", move || {
        let (strip_w, strip_h) = (strip.width, strip.height);
        tray_overlay::set_strip_width_pt(strip_w as f64 / tray_quota::SCALE as f64);
        let img = tauri::image::Image::new_owned(strip.rgba, strip_w, strip_h);
        let _ = tray.set_icon(Some(img));
        let _ = tray.set_icon_as_template(false);
        // The tray library forces every image to 18 pt tall; the strip is drawn for the
        // full 22 pt button, like the original one. Restore the size.
        let (w_pt, h_pt) = (strip_w as f64 / tray_quota::SCALE as f64, strip_h as f64 / tray_quota::SCALE as f64);
        let _ = tray.with_inner_tray_icon(move |inner| {
            if let Some(item) = inner.ns_status_item() {
                unsafe {
                    let item: id = objc2::rc::Retained::as_ptr(&item) as id;
                    let button: id = msg_send![item, button];
                    if button != nil {
                        // Pin the item to the strip's own width: the variable-length item
                        // measured the button on the 18 pt image.
                        let _: () = msg_send![item, setLength: w_pt];
                        let image: id = msg_send![button, image];
                        if image != nil {
                            let _: () = msg_send![image, setSize: NSSize::new(w_pt, h_pt)];
                        }
                        // The library sized its click-catching view before the resize above:
                        // make exactly that view track the button. No other subview is touched.
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
