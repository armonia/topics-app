//! Reading the Win32 window tree from outside wry: which child webviews exist,
//! in which order they are stacked under the tao window, and which one answers
//! a hit test at a point where two of them overlap.
//!
//! The windows are found by walking the tree instead of being handed over by
//! wry, because wry exposes no HWND accessor for a child webview. Every child
//! webview is an HWND of class `WRY_WEBVIEW` (wry 0.55.1,
//! `webview2/mod.rs:205`), parented to the tao window, and the probe names them
//! by their width, which it chose to be different for each one.

use windows::Win32::Foundation::{COLORREF, HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetFocus, SetFocus};
use windows::Win32::UI::WindowsAndMessaging::{
    ChildWindowFromPointEx, GetClassNameW, GetParent, GetWindow, GetWindowRect, SetWindowPos,
    CWP_SKIPDISABLED, CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT, GW_CHILD, GW_HWNDNEXT, HWND_TOP,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
};

use tao::platform::windows::WindowExtWindows;

/// The colour each probe page paints, so a screen pixel can be read back as a
/// role. The counter proof to the window tree: the tree says who is stacked on
/// top, the pixel says who is actually drawn there.
const COLORS: [(&str, u32, u32, u32); 3] = [
    ("pane", 0x2d, 0x6c, 0xdf),
    ("floater", 0xc0, 0x39, 0x2b),
    ("late", 0x27, 0xae, 0x60),
];

fn parent_hwnd(window: &tao::window::Window) -> HWND {
    HWND(window.hwnd() as *mut _)
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn is_webview(hwnd: HWND) -> bool {
    class_name(hwnd) == "WRY_WEBVIEW"
}

fn rect_of(hwnd: HWND) -> RECT {
    let mut r = RECT::default();
    let _ = unsafe { GetWindowRect(hwnd, &mut r) };
    r
}

/// The role each width stands for in this probe: the host page fills the
/// window, the others are the two overlapping panes and the late arrival.
/// Widths are physical pixels here and logical in the caller, hence the scale.
fn role(hwnd: HWND, scale: f64) -> &'static str {
    let r = rect_of(hwnd);
    match ((r.right - r.left) as f64 / scale).round() as i64 {
        420 => "pane",
        360 => "floater",
        300 => "late",
        _ => "host",
    }
}

/// Every child webview of the window, TOP FIRST. `GW_CHILD` answers with the
/// highest child in the z order and `GW_HWNDNEXT` walks downwards, which is the
/// opposite of the AppKit probe, where the last subview is the top one.
fn webviews(window: &tao::window::Window) -> Vec<HWND> {
    let mut out = Vec::new();
    let mut node = unsafe { GetWindow(parent_hwnd(window), GW_CHILD) }.ok();
    while let Some(hwnd) = node {
        if hwnd.is_invalid() {
            break;
        }
        if is_webview(hwnd) {
            out.push(hwnd);
        }
        node = unsafe { GetWindow(hwnd, GW_HWNDNEXT) }.ok();
    }
    out
}

fn find(window: &tao::window::Window, which: &str) -> Option<HWND> {
    let scale = window.scale_factor();
    webviews(window).into_iter().find(|h| role(*h, scale) == which)
}

/// Print the pile, who answers a hit test at `point` (logical window
/// coordinates, top-left based like the bounds the client sends), and what
/// colour the screen actually shows there.
pub fn report(window: &tao::window::Window, point: (f64, f64)) {
    let scale = window.scale_factor();
    let origin = rect_of(parent_hwnd(window));
    for (i, hwnd) in webviews(window).iter().enumerate() {
        let r = rect_of(*hwnd);
        crate::say(&format!(
            "   [{i}] {:8} frame=({:.0},{:.0} {:.0}x{:.0}) hwnd={:?}",
            role(*hwnd, scale),
            (r.left - origin.left) as f64 / scale,
            (r.top - origin.top) as f64 / scale,
            (r.right - r.left) as f64 / scale,
            (r.bottom - r.top) as f64 / scale,
            hwnd.0
        ));
    }
    crate::say(&format!(
        "   hit test at ({:.0},{:.0}): {}   pixel there: {}",
        point.0,
        point.1,
        top_at(window, point),
        pixel_at(window, point)
    ));
}

/// Role of the webview that answers a hit test at `point`, or "none". This is
/// the z order as the user experiences it: the window that takes the click is
/// the window drawn over the others.
pub fn top_at(window: &tao::window::Window, point: (f64, f64)) -> String {
    let scale = window.scale_factor();
    let parent = parent_hwnd(window);
    // Client coordinates of the parent, in physical pixels: the caller thinks
    // logical and top-left based, like the client does when it sends bounds.
    let pt = POINT {
        x: (point.0 * scale) as i32,
        y: (point.1 * scale) as i32,
    };
    let hit = unsafe {
        ChildWindowFromPointEx(
            parent,
            pt,
            CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT,
        )
    };
    if hit.is_invalid() || hit == parent {
        return "none".to_string();
    }
    let mut node = Some(hit);
    while let Some(hwnd) = node {
        if is_webview(hwnd) {
            return role(hwnd, scale).to_string();
        }
        node = unsafe { GetParent(hwnd) }.ok().filter(|h| !h.is_invalid());
    }
    "none".to_string()
}

/// Role whose colour the SCREEN shows at `point`, read from the desktop DC, or
/// "unreadable" when the pixel matches no probe page (the window is covered,
/// the session has no visible desktop, or nothing was painted yet).
pub fn pixel_at(window: &tao::window::Window, point: (f64, f64)) -> String {
    let scale = window.scale_factor();
    let origin = rect_of(parent_hwnd(window));
    let x = origin.left + (point.0 * scale) as i32;
    let y = origin.top + (point.1 * scale) as i32;
    let dc = unsafe { GetDC(None) };
    if dc.is_invalid() {
        return "unreadable".to_string();
    }
    let COLORREF(bgr) = unsafe { GetPixel(dc, x, y) };
    unsafe { ReleaseDC(None, dc) };
    let (r, g, b) = (bgr & 0xff, (bgr >> 8) & 0xff, (bgr >> 16) & 0xff);
    for (name, cr, cg, cb) in COLORS {
        // A tolerance, not an equality: the compositor may hand back the colour
        // after its own rounding, and a miss by one is still that page.
        if r.abs_diff(cr) <= 4 && g.abs_diff(cg) <= 4 && b.abs_diff(cb) <= 4 {
            return name.to_string();
        }
    }
    format!("unreadable(#{r:02x}{g:02x}{b:02x})")
}

/// Put the child webview with this role on top of its siblings: the Win32 twin
/// of what `browser_raise` does on AppKit. `SetWindowPos` with `HWND_TOP` and
/// nothing else moved, which is exactly the flag wry passes at birth
/// (`webview2/mod.rs:268`) and deliberately withholds in `set_bounds`, where it
/// sends `SWP_NOZORDER` (`:1456`).
pub fn raise_role(window: &tao::window::Window, which: &str) {
    let Some(hwnd) = find(window, which) else {
        return;
    };
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        )
    };
}

/// Give the keyboard to the child webview with this role, as a click in its
/// page would. The wry window proc forwards the focus to the WebView2 document
/// window underneath (`webview2/mod.rs:195`), so the focused HWND afterwards is
/// a DESCENDANT of this one, not this one.
pub fn focus_role(window: &tao::window::Window, which: &str) -> bool {
    let Some(hwnd) = find(window, which) else {
        return false;
    };
    let _ = unsafe { SetFocus(Some(hwnd)) };
    focus_is(window, which)
}

/// Does the keyboard focus sit inside the child webview with this role? The
/// page cannot answer this: `document.activeElement` keeps saying the same
/// thing while the keys go somewhere else entirely.
pub fn focus_is(window: &tao::window::Window, which: &str) -> bool {
    let Some(target) = find(window, which) else {
        return false;
    };
    let mut node = unsafe { GetFocus() };
    while !node.is_invalid() {
        if node == target {
            return true;
        }
        match unsafe { GetParent(node) } {
            Ok(parent) if !parent.is_invalid() => node = parent,
            _ => return false,
        }
    }
    false
}

/// Bring the probe window to the front, so the pixel read has something to
/// read. Without it a scheduled task can paint behind whatever the desktop
/// already had open.
pub fn to_front(window: &tao::window::Window) {
    use windows::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, SetWindowPos, HWND_TOP};
    let hwnd = parent_hwnd(window);
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
    };
    let _ = unsafe { SetForegroundWindow(hwnd) };
}
