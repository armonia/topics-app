//! Reading the X11 window tree from outside wry: which child webviews exist, in
//! which order the server stacks them under the tao window, and which one owns
//! the point where two of them overlap.
//!
//! WHY X11 AND NOT GTK. On Linux wry does NOT put a child webview in the
//! `GtkFixed` of the parent window: with the default `x11` feature,
//! `new_as_child` creates a real X11 window with `XCreateSimpleWindow` as a
//! child of the parent's X window and hangs a GTK toplevel off it
//! (`webkitgtk/mod.rs:159` and `:192`). The pile is therefore an X11 stacking
//! order, and the question "which call reorders it" is an X11 question.
//! `GtkFixed.put` only serves the OTHER shape, `new_gtk` (`:620`), which the
//! shell does not use for panes.
//!
//! The windows are found by walking the tree instead of being handed over by
//! wry, which exposes no accessor for a child's X window, and they are named by
//! their width, which the probe chose to be different for each one.

use std::ffi::c_int;
use std::os::raw::c_ulong;
use std::ptr;

use raw_window_handle::{HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle};
use x11_dl::xlib::{Display, Xlib, ZPixmap};

/// The colour each probe page paints, so a screen pixel can be read back as a
/// role. The counter proof to the window tree: the tree says who is stacked on
/// top, the pixel says who is actually drawn there.
const COLORS: [(&str, u32, u32, u32); 3] = [
    ("pane", 0x2d, 0x6c, 0xdf),
    ("floater", 0xc0, 0x39, 0x2b),
    ("late", 0x27, 0xae, 0x60),
];

/// The X connection and the parent window, taken once from the tao window.
pub struct X {
    lib: Xlib,
    display: *mut Display,
    parent: c_ulong,
}

impl X {
    pub fn open(window: &tao::window::Window) -> Option<X> {
        let lib = Xlib::open().ok()?;
        let display = match window.display_handle().ok()?.as_raw() {
            RawDisplayHandle::Xlib(h) => h.display?.as_ptr() as *mut Display,
            _ => return None,
        };
        let parent = match window.window_handle().ok()?.as_raw() {
            RawWindowHandle::Xlib(h) => h.window,
            _ => return None,
        };
        Some(X {
            lib,
            display,
            parent,
        })
    }

    /// Every child window of the tao window, BOTTOM FIRST: that is the order
    /// `XQueryTree` answers in, and the last one is the top of the pile.
    fn children(&self) -> Vec<c_ulong> {
        let mut root = 0;
        let mut parent = 0;
        let mut list: *mut c_ulong = ptr::null_mut();
        let mut n: u32 = 0;
        let ok = unsafe {
            (self.lib.XQueryTree)(
                self.display,
                self.parent,
                &mut root,
                &mut parent,
                &mut list,
                &mut n,
            )
        };
        if ok == 0 || list.is_null() {
            return Vec::new();
        }
        let out = unsafe { std::slice::from_raw_parts(list, n as usize) }.to_vec();
        unsafe { (self.lib.XFree)(list as *mut _) };
        out
    }

    /// Position and size of a window, in the parent's coordinates and in the
    /// logical pixels the caller thinks in.
    fn geometry(&self, w: c_ulong) -> (f64, f64, f64, f64) {
        let mut root = 0;
        let (mut x, mut y) = (0i32, 0i32);
        let (mut width, mut height, mut border, mut depth) = (0u32, 0u32, 0u32, 0u32);
        unsafe {
            (self.lib.XGetGeometry)(
                self.display,
                w,
                &mut root,
                &mut x,
                &mut y,
                &mut width,
                &mut height,
                &mut border,
                &mut depth,
            )
        };
        // No scale division. Under Xvfb tao reports a fractional scale factor
        // (0.96 on a 1280x800 screen), and wry does NOT apply it to the bounds
        // of a child view: an X window asked for 420 logical pixels comes back
        // 420 pixels wide. Dividing here made every width 4% too large and no
        // view could be recognised by its size.
        (x as f64, y as f64, width as f64, height as f64)
    }

    /// The role each width stands for in this probe: the two overlapping panes
    /// and the late arrival. The host webview is not an X child of the parent
    /// (it goes in the GTK box of the window itself), so unlike the AppKit and
    /// Win32 probes it never shows up in this list.
    fn role(&self, w: c_ulong) -> &'static str {
        // Matched with a tolerance, because the two ways a child gets its size
        // do not agree under X11: at CREATION wry scales the logical rect by
        // the GDK dpi factor (a view asked for 420 comes back 438 wide, 100/96
        // of it), while `set_bounds` later writes the numbers through as they
        // are (420). An exact match recognised the views only after the first
        // set_bounds, and read every step before it as "other".
        let width = self.geometry(w).2;
        for (name, nominal) in [("pane", 420.0), ("floater", 360.0), ("late", 300.0)] {
            if (width - nominal).abs() <= nominal * 0.06_f64 {
                return name;
            }
        }
        "other"
    }

    fn find(&self, which: &str) -> Option<c_ulong> {
        self.children().into_iter().find(|w| self.role(*w) == which)
    }

    /// Print the pile, who owns `point` (logical window coordinates, top-left
    /// based like the bounds the client sends), and what colour the screen
    /// actually shows there.
    pub fn report(&self, point: (f64, f64)) {
        for (i, w) in self.children().iter().enumerate() {
            let (x, y, width, height) = self.geometry(*w);
            println!(
                "   [{i}] {:8} frame=({x:.0},{y:.0} {width:.0}x{height:.0}) xid=0x{w:x}",
                self.role(*w)
            );
        }
        println!(
            "   top at ({:.0},{:.0}): {}   pixel there: {}",
            point.0,
            point.1,
            self.top_at(point),
            self.pixel_at(point)
        );
    }

    /// Role of the topmost window covering `point`, or "none". X11 has no hit
    /// test call: the answer is the LAST window of the stacking order whose
    /// geometry contains the point, which is the same thing the server uses to
    /// route a click.
    pub fn top_at(&self, point: (f64, f64)) -> String {
        let mut top = "none".to_string();
        for w in self.children() {
            let (x, y, width, height) = self.geometry(w);
            if point.0 >= x && point.0 < x + width && point.1 >= y && point.1 < y + height {
                top = self.role(w).to_string();
            }
        }
        top
    }

    /// Role whose colour the SCREEN shows at `point`, read from the root
    /// window, or "unreadable" when the pixel matches no probe page (nothing
    /// was painted yet, or the window is covered).
    pub fn pixel_at(&self, point: (f64, f64)) -> String {
        let (mut rx, mut ry) = (0i32, 0i32);
        let mut child = 0;
        let ok = unsafe {
            (self.lib.XTranslateCoordinates)(
                self.display,
                self.parent,
                (self.lib.XDefaultRootWindow)(self.display),
                point.0 as c_int,
                point.1 as c_int,
                &mut rx,
                &mut ry,
                &mut child,
            )
        };
        if ok == 0 {
            return "unreadable".to_string();
        }
        let root = unsafe { (self.lib.XDefaultRootWindow)(self.display) };
        let image = unsafe {
            (self.lib.XGetImage)(self.display, root, rx, ry, 1, 1, !0, ZPixmap)
        };
        if image.is_null() {
            return "unreadable".to_string();
        }
        // The XImage function table is a struct of nullable pointers: an X
        // server that hands back an image without a `get_pixel` has nothing to
        // read, and the answer is the same "unreadable" as a missing image.
        let Some(get_pixel) = (unsafe { (*image).funcs.get_pixel }) else {
            return "unreadable".to_string();
        };
        let pixel = unsafe { get_pixel(image, 0, 0) };
        if let Some(destroy) = unsafe { (*image).funcs.destroy_image } {
            unsafe { destroy(image) };
        }
        let (r, g, b) = (
            ((pixel >> 16) & 0xff) as u32,
            ((pixel >> 8) & 0xff) as u32,
            (pixel & 0xff) as u32,
        );
        for (name, cr, cg, cb) in COLORS {
            // A tolerance, not an equality: the visual may hand the colour back
            // after its own rounding, and a miss by one is still that page.
            if r.abs_diff(cr) <= 4 && g.abs_diff(cg) <= 4 && b.abs_diff(cb) <= 4 {
                return name.to_string();
            }
        }
        format!("unreadable(#{r:02x}{g:02x}{b:02x})")
    }

    /// Put the child webview with this role on top of its siblings: the X11
    /// twin of what `browser_raise` does on AppKit. `XRaiseWindow` is a
    /// restack and nothing else, so it moves no pixel of geometry and touches
    /// no input focus.
    pub fn raise_role(&self, which: &str) {
        let Some(w) = self.find(which) else {
            return;
        };
        unsafe {
            (self.lib.XRaiseWindow)(self.display, w);
            (self.lib.XFlush)(self.display);
        }
    }

    /// Give the keyboard to the child webview with this role, as a click in its
    /// page would.
    pub fn focus_role(&self, which: &str) -> bool {
        let Some(w) = self.find(which) else {
            return false;
        };
        unsafe {
            (self.lib.XSetInputFocus)(self.display, w, 1 /* RevertToParent */, 0);
            (self.lib.XSync)(self.display, 0);
        }
        self.focus_is(which)
    }

    /// Does the keyboard focus sit inside the child webview with this role? The
    /// page cannot answer this: `document.activeElement` keeps saying the same
    /// thing while the keys go somewhere else entirely.
    pub fn focus_is(&self, which: &str) -> bool {
        let Some(target) = self.find(which) else {
            return false;
        };
        let mut focus: c_ulong = 0;
        let mut revert: c_int = 0;
        unsafe { (self.lib.XGetInputFocus)(self.display, &mut focus, &mut revert) };
        let mut node = focus;
        // The focus can land on a window nested inside the container, so walk
        // up to the parent chain before answering no.
        for _ in 0..8 {
            if node == 0 {
                return false;
            }
            if node == target {
                return true;
            }
            let mut root = 0;
            let mut parent = 0;
            let mut list: *mut c_ulong = ptr::null_mut();
            let mut n: u32 = 0;
            let ok = unsafe {
                (self.lib.XQueryTree)(
                    self.display,
                    node,
                    &mut root,
                    &mut parent,
                    &mut list,
                    &mut n,
                )
            };
            if !list.is_null() {
                unsafe { (self.lib.XFree)(list as *mut _) };
            }
            if ok == 0 {
                return false;
            }
            node = parent;
        }
        false
    }
}
