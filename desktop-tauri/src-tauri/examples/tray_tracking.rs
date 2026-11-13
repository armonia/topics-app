//! In-process check that the tray menu opens and STAYS open while the strip animates
//! and the poll keeps replacing image and menu (card 066276b6). No mouse: it sends the
//! status item's click view a synthetic mouseDown, watches NSMenuDidBegin/EndTracking
//! and closes the menu with cancelTracking. Needs a macOS GUI session.
//! Run by hand: `cargo run --example tray_tracking`. Exit 0 = the menu began tracking
//! and was still open after TRAY_TRACKING_HOLD_MS (default 2500); exit 1 otherwise.
//! `TRAY_TRACKING_NO_DEFER=1` swaps the image and the menu raw, like the old code did
//! while a menu was open: the check must then fail.
#[cfg(target_os = "macos")]
mod mac {
    pub use objc2::runtime::{AnyClass as Class, AnyObject as Object, Sel};
    pub use objc2::{class, msg_send, sel};
    pub use objc2_foundation::{NSPoint, NSRect, NSSize};
    #[allow(non_camel_case_types)]
    pub type id = *mut objc2::runtime::AnyObject;
    #[allow(non_upper_case_globals)]
    pub const nil: id = std::ptr::null_mut();
}
#[cfg(target_os = "macos")]
#[path = "../src/tray_quota.rs"]
#[allow(dead_code)]
mod tray_quota;
#[cfg(target_os = "macos")]
#[path = "../src/tray_agents.rs"]
#[allow(dead_code)]
mod tray_agents;
#[cfg(target_os = "macos")]
#[path = "../src/tray_dials.rs"]
#[allow(dead_code)]
mod tray_dials;
#[cfg(target_os = "macos")]
#[path = "../src/tray_coretext.rs"]
#[allow(dead_code)]
mod tray_coretext;
#[cfg(target_os = "macos")]
#[path = "../src/tray_overlay.rs"]
#[allow(dead_code)]
mod tray_overlay;
#[cfg(target_os = "macos")]
#[path = "../src/tray_tracking.rs"]
#[allow(dead_code)]
mod tray_tracking;
#[cfg(target_os = "macos")]
#[path = "../src/tray_strip_apply.rs"]
#[allow(dead_code)]
mod tray_strip_apply;

#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
fn main() {
    use mac::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tauri::menu::MenuBuilder;
    use tauri::tray::TrayIconBuilder;
    use tauri::Manager;

    let hold_ms: u64 = std::env::var("TRAY_TRACKING_HOLD_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(2500);
    let raw = std::env::var("TRAY_TRACKING_NO_DEFER").is_ok();
    let began = Arc::new(AtomicBool::new(false));
    let ended = Arc::new(AtomicBool::new(false));
    let menu_ptr = Arc::new(AtomicUsize::new(0));
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let (b2, e2, m2) = (began.clone(), ended.clone(), menu_ptr.clone());
    let app = tauri::Builder::default()
        .setup(move |app| {
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            tray_quota::set_agents(tray_agents::AgentStates { working: 3, review: 1, waiting: 1, stopped: 2 });
            let strip = tray_quota::render_strip(None, &Default::default());
            let icon = tauri::image::Image::new_owned(strip.rgba, strip.width, strip.height);
            let menu = MenuBuilder::new(app).text("a", "One").text("b", "Two").build()?;
            let tray = TrayIconBuilder::with_id("main").icon(icon).icon_as_template(false).menu(&menu).build(app)?;
            tray_tracking::install();
            let handle = app.handle().clone();
            // The animation thread of the app: layer swaps at the real frame rate.
            let h_anim = handle.clone();
            let quiet = std::env::var("TRAY_TRACKING_QUIET").is_ok();
            std::thread::spawn(move || {
                if quiet {
                    return;
                }
                let mut frame = 0u32;
                loop {
                    std::thread::sleep(Duration::from_millis(tray_agents::FRAME_MS));
                    frame = (frame + 1) % tray_agents::TURN_FRAMES;
                    if let Some(t) = h_anim.tray_by_id("main") {
                        tray_strip_apply::apply_overlay(&t, Some(frame));
                    }
                }
            });
            // The poll: a new strip and a new menu every 300 ms (the app does it every minute).
            let h_poll = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(300));
                if quiet {
                    continue;
                }
                let Some(t) = h_poll.tray_by_id("main") else { continue };
                let strip = tray_quota::render_strip(None, &Default::default());
                let Ok(menu) = MenuBuilder::new(&h_poll).text("a", "One").text("b", "Two").build() else { continue };
                if raw {
                    let img = tauri::image::Image::new_owned(strip.rgba, strip.width, strip.height);
                    let _ = t.set_icon(Some(img));
                    let _ = t.set_menu(Some(menu));
                } else {
                    tray_strip_apply::apply_strip(t.clone(), strip);
                    tray_tracking::defer("menu", move || {
                        let _ = t.set_menu(Some(menu));
                    });
                }
            });
            // The driver: click, hold, cancel, verdict.
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1500));
                let h2 = handle.clone();
                let m3 = m2.clone();
                let _ = handle.run_on_main_thread(move || {
                    let Some(t) = h2.tray_by_id("main") else { return };
                    let _ = t.with_inner_tray_icon(move |inner| unsafe {
                        let Some(item) = inner.ns_status_item() else { return };
                        let item: id = objc2::rc::Retained::as_ptr(&item) as id;
                        let button: id = msg_send![item, button];
                        let menu: id = msg_send![item, menu];
                        let win: id = msg_send![button, window];
                        let win_no: isize = msg_send![win, windowNumber];
                        let subs: id = msg_send![button, subviews];
                        let n: usize = msg_send![subs, count];
                        let mut target: id = nil;
                        for i in 0..n {
                            let v: id = msg_send![subs, objectAtIndex: i];
                            let cls: *const objc2::runtime::AnyClass = msg_send![v, class];
                            if (*cls).name().to_bytes() == b"TaoTrayTarget" {
                                target = v;
                            }
                        }
                        assert!(target != nil, "no TaoTrayTarget under the status button");
                        let ev: id = msg_send![class!(NSEvent), mouseEventWithType: 1usize, location: NSPoint::new(5.0, 5.0), modifierFlags: 0usize, timestamp: 0.0f64, windowNumber: win_no, context: nil, eventNumber: 0isize, clickCount: 1isize, pressure: 1.0f32];
                        // The library keeps its own menu in an ivar, not on the item.
                        m3.store(menu as usize, Ordering::SeqCst);
                        let _: () = msg_send![target, mouseDown: ev]; // blocks while the menu is open
                    });
                });
            });
            // Watcher: reads the flags the library notifications set.
            let (b3, e3) = (b2.clone(), e2.clone());
            std::thread::spawn(move || {
                let start = Instant::now();
                while !tray_tracking::is_open() {
                    if start.elapsed() > Duration::from_secs(8) {
                        eprintln!("FAIL: the menu never began tracking after a synthetic click");
                        std::process::exit(1);
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                b3.store(true, Ordering::SeqCst);
                let opened = Instant::now();
                while opened.elapsed() < Duration::from_millis(hold_ms) {
                    if !tray_tracking::is_open() {
                        e3.store(true, Ordering::SeqCst);
                        eprintln!("FAIL: the menu closed by itself after {} ms", opened.elapsed().as_millis());
                        std::process::exit(1);
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                println!("PASS: menu stayed open {hold_ms} ms with animation, strip and menu updates running");
                std::process::exit(0);
            });
            app.manage(tray);
            Ok(())
        })
        .build(context)
        .expect("build");
    let _ = (began, ended, menu_ptr);
    app.run(|_, _| {});
}
