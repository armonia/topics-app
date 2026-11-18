//! Prototype: does a custom view inside an open NSMenu receive `mouseMoved:` through an NSTrackingArea?
//! In-process, no real mouse: a timer posts synthetic mouseMoved events at the menu's window while it is
//! open. Exit 0 = the view saw them (prints the x it got), exit 1 = it did not.
//! `cargo run --example tray_hover_probe` (needs a macOS GUI session).
#[cfg(target_os = "macos")]
mod mac {
    pub use objc2::{class, msg_send, sel};
    pub use objc2_foundation::{NSPoint, NSRect, NSSize};
    #[allow(non_camel_case_types)]
    pub type id = *mut objc2::runtime::AnyObject;
    #[allow(non_upper_case_globals)]
    pub const nil: id = std::ptr::null_mut();
}

#[cfg(target_os = "macos")]
#[link(name = "AppKit", kind = "framework")]
extern "C" {}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct CgPoint {
    x: f64,
    y: f64,
}
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn CGEventGetLocation(ev: *mut std::ffi::c_void) -> CgPoint;
    fn CGEventCreateMouseEvent(source: *mut std::ffi::c_void, kind: u32, at: CgPoint, button: u32) -> *mut std::ffi::c_void;
    fn CGEventPost(tap: u32, ev: *mut std::ffi::c_void);
    fn CGWarpMouseCursorPosition(at: CgPoint) -> i32;
}

#[cfg(target_os = "macos")]
fn main() {
    use mac::*;
    use objc2::runtime::Sel;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
    static MOVES: AtomicUsize = AtomicUsize::new(0);
    static LAST_X: AtomicI64 = AtomicI64::new(-1);
    static ENTERS: AtomicUsize = AtomicUsize::new(0);

    extern "C" fn mouse_moved(this: id, _s: Sel, ev: id) {
        unsafe {
            let p: NSPoint = msg_send![ev, locationInWindow];
            let q: NSPoint = msg_send![this, convertPoint: p, fromView: nil];
            MOVES.fetch_add(1, Ordering::SeqCst);
            LAST_X.store(q.x as i64, Ordering::SeqCst);
        }
    }
    extern "C" fn mouse_entered(_this: id, _s: Sel, _ev: id) {
        ENTERS.fetch_add(1, Ordering::SeqCst);
    }
    extern "C" fn update_areas(this: id, _s: Sel) {
        unsafe {
            let _: () = msg_send![super(this, class!(NSView)), updateTrackingAreas];
            let bounds: NSRect = msg_send![this, bounds];
            // MouseEnteredAndExited | MouseMoved | ActiveAlways | InVisibleRect
            let area: id = msg_send![class!(NSTrackingArea), alloc];
            let area: id = msg_send![area, initWithRect: bounds, options: 0x283usize, owner: this, userInfo: nil];
            let _: () = msg_send![this, addTrackingArea: area];
        }
    }
    extern "C" fn flipped(_this: id, _s: Sel) -> objc2::runtime::Bool { objc2::runtime::Bool::YES }

    unsafe {
        let app: id = msg_send![class!(NSApplication), sharedApplication];
        let _: bool = msg_send![app, setActivationPolicy: 1isize];
        let mut b = objc2::declare::ClassBuilder::new(c"HoverProbeView", class!(NSView)).unwrap();
        b.add_method(sel!(mouseMoved:), mouse_moved as extern "C" fn(id, Sel, id));
        b.add_method(sel!(mouseEntered:), mouse_entered as extern "C" fn(id, Sel, id));
        b.add_method(sel!(updateTrackingAreas), update_areas as extern "C" fn(id, Sel));
        b.add_method(sel!(isFlipped), flipped as extern "C" fn(id, Sel) -> objc2::runtime::Bool);
        let cls = b.register();
        let menu: id = msg_send![class!(NSMenu), new];
        let item: id = msg_send![class!(NSMenuItem), new];
        let view: id = msg_send![cls, alloc];
        let view: id = msg_send![view, initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(300.0, 80.0))];
        let _: () = msg_send![item, setView: view];
        let _: () = msg_send![menu, addItem: item];
        // the steps run on the MAIN run loop in the common modes, so they run while the menu tracks
        static STEP: AtomicUsize = AtomicUsize::new(0);
        static VIEW_P: AtomicUsize = AtomicUsize::new(0);
        static MENU_P: AtomicUsize = AtomicUsize::new(0);
        static ORIG_X: AtomicI64 = AtomicI64::new(0);
        static ORIG_Y: AtomicI64 = AtomicI64::new(0);
        VIEW_P.store(view as usize, Ordering::SeqCst);
        MENU_P.store(menu as usize, Ordering::SeqCst);
        extern "C" fn step(this: id, _s: Sel, _arg: id) {
            unsafe {
                let n = STEP.fetch_add(1, Ordering::SeqCst);
                let xs = [420.0f64, 460.0, 520.0, 600.0, 660.0];
                // the REAL cursor, over the view, only while the Mac is free (the caller checked); the menu was popped
                // at screen (400, 400) from the bottom, so the view's middle is at y = screen height - 400 + 40 from the top
                let main_screen: id = msg_send![class!(NSScreen), mainScreen];
                let screen: NSRect = msg_send![main_screen, frame];
                let y = screen.size.height - 400.0 + 40.0;
                if n == 0 {
                    let ev = CGEventCreate(std::ptr::null_mut());
                    let at = CGEventGetLocation(ev);
                    ORIG_X.store(at.x as i64, Ordering::SeqCst);
                    ORIG_Y.store(at.y as i64, Ordering::SeqCst);
                }
                if n < xs.len() {
                    let at = CgPoint { x: xs[n], y };
                    CGWarpMouseCursorPosition(at);
                    let ev = CGEventCreateMouseEvent(std::ptr::null_mut(), 5, at, 0);
                    CGEventPost(0, ev);
                } else {
                    let back = CgPoint { x: ORIG_X.load(Ordering::SeqCst) as f64, y: ORIG_Y.load(Ordering::SeqCst) as f64 };
                    CGWarpMouseCursorPosition(back);
                    let m = MENU_P.load(Ordering::SeqCst) as id;
                    let _: () = msg_send![m, cancelTracking];
                    return;
                }
                let modes: id = msg_send![class!(NSArray), arrayWithObject: ns_str("kCFRunLoopCommonModes")];
                let _: () = msg_send![this, performSelector: sel!(step:), withObject: nil, afterDelay: 0.15f64, inModes: modes];
            }
        }
        unsafe fn ns_str(s: &str) -> id {
            let a: id = msg_send![class!(NSString), alloc];
            msg_send![a, initWithBytes: s.as_ptr() as *const std::ffi::c_void, length: s.len(), encoding: 4usize]
        }
        let mut tb = objc2::declare::ClassBuilder::new(c"HoverProbeTarget", class!(NSObject)).unwrap();
        tb.add_method(sel!(step:), step as extern "C" fn(id, Sel, id));
        let tcls = tb.register();
        let target: id = msg_send![tcls, new];
        let modes: id = msg_send![class!(NSArray), arrayWithObject: ns_str("kCFRunLoopCommonModes")];
        let _: () = msg_send![target, performSelector: sel!(step:), withObject: nil, afterDelay: 0.7f64, inModes: modes];
        let _: bool = msg_send![menu, popUpMenuPositioningItem: nil, atLocation: NSPoint::new(400.0, 400.0), inView: nil];
    }
    let (m, e, x) = (MOVES.load(Ordering::SeqCst), ENTERS.load(Ordering::SeqCst), LAST_X.load(Ordering::SeqCst));
    println!("mouseMoved={m} mouseEntered={e} last_x={x}");
    std::process::exit(if m > 0 { 0 } else { 1 });
}
#[cfg(not(target_os = "macos"))]
fn main() {}
